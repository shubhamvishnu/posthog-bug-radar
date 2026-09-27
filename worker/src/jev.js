/*
 * Session analysis with Jev (TypeSafe's System One model), https://docs.typesafe.ai/api.md.
 *
 * Jev makes every judgment about a session (where one task ends and the next begins, each
 * task's outcome, whether it is a real bug, severity, which known goal and tags it matches,
 * the key event, and the outreach gates). It returns typed answers with probabilities, costs
 * $0.042 per million input tokens (output is free) and answers in well under a second.
 *
 * A text model (the tenant's configured provider) only writes prose: titles, narratives,
 * new goal definitions and the outreach message, and only for tasks worth a write-up.
 * Everything here is pure except askJev, so the logic is testable without the network.
 */

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";

const QUESTIONS_PER_REQUEST = 40;

async function askJevOnce(apiKey, state, questions, { fetcher, timeoutMs }) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetcher(JEV_ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: JEV_MODEL, state, questions }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) return await res.json();
    // Rate limits and overload are retried with backoff, as the docs ask; anything else fails at once.
    if ((res.status === 429 || res.status === 529 || res.status >= 500) && attempt < 3) {
      await new Promise(r => setTimeout(r, 500 * 2 ** attempt));
      continue;
    }
    throw new Error(`Jev ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

/**
 * Asks one state a set of questions. Large sets are split into parallel requests over the same
 * state, since the docs do not publish a per-request question cap. Throws on any failure: callers
 * fall back to the full text-model analysis rather than save a half-judged session.
 */
export async function askJev(apiKey, state, questions, { fetcher = fetch, timeoutMs = 30000 } = {}) {
  const keys = Object.keys(questions);
  const chunks = [];
  for (let i = 0; i < keys.length; i += QUESTIONS_PER_REQUEST) chunks.push(keys.slice(i, i + QUESTIONS_PER_REQUEST));
  const results = await Promise.all(
    chunks.map(chunk => askJevOnce(apiKey, state, Object.fromEntries(chunk.map(k => [k, questions[k]])), { fetcher, timeoutMs }))
  );
  const answers = {};
  let inputTokens = 0;
  for (const r of results) {
    Object.assign(answers, r.answers || {});
    inputTokens += r.usage?.input_tokens || 0;
  }
  for (const k of keys) if (!answers[k]) throw new Error(`Jev returned no answer for ${k}`);
  return { answers, inputTokens };
}

export const noulOf = a => (a && a.type === "noul" && typeof a.noul === "number" ? a.noul : null);
export const choiceOf = a => (a && a.type === "choice" && typeof a.choice === "string" ? a : null);
const probOf = (a, option) => (a && a.probabilities && typeof a.probabilities[option] === "number" ? a.probabilities[option] : 0);
const round2 = n => (typeof n === "number" ? Math.round(n * 100) / 100 : null);

/* ---------------- events ---------------- */

const PROBLEM_EVENTS = new Set(["$dead_click", "$rageclick", "$exception"]);

export function timeOf(ts) {
  const s = String(ts || "");
  return s.length >= 19 ? s.slice(11, 19) : s;
}

/** Compact, indexed view of the event stream, which is what Jev and the text model read. */
export function indexEvents(events) {
  return events.map((e, i) => ({
    i,
    event: String(e.event || "").replace(/^\$/, ""),
    text: e.el_text ? String(e.el_text).slice(0, 120) : null,
    page: e.pathname || null,
    time: timeOf(e.timestamp),
  }));
}

/** A page with record ids folded out: /contacts/1056397/notes -> /contacts/:id/notes. */
export function pagePattern(pathname) {
  if (!pathname) return "?";
  return String(pathname).split("/").map(seg => (/^\d+$|^[0-9a-f-]{16,}$/i.test(seg) ? ":id" : seg)).join("/");
}

/** First path segment, the "part of the product" a page belongs to: /deals/123 -> deals. */
export function pageArea(pathname) {
  if (!pathname) return null;
  return String(pathname).split("/").filter(Boolean)[0] || "home";
}

function uniquePages(events, from, to, limit = 4) {
  const pages = [];
  for (let i = from; i <= to; i++) {
    const p = events[i]?.pathname;
    if (p && !pages.includes(p)) pages.push(p);
  }
  return pages.length > limit ? [...pages.slice(0, limit), `+${pages.length - limit} more`] : pages;
}

/* ---------------- step 1: task boundaries ---------------- */

/**
 * Where a new task might start. A long silence (hardGapSec) always splits. A move to a different
 * part of the product, or a shorter pause, is only a candidate: Jev decides whether the goal
 * actually changed there, since stepping into settings to finish the same setup is not a new task.
 */
export function candidateBoundaries(events, { hardGapSec = 1800, softGapSec = 120, maxSoft = 60 } = {}) {
  const hard = [];
  const soft = [];
  let prevPage = events[0]?.pathname || null;
  let prevArea = pageArea(prevPage);
  for (let i = 1; i < events.length; i++) {
    const gap = (Date.parse(events[i].timestamp) - Date.parse(events[i - 1].timestamp)) / 1000 || 0;
    const page = events[i].pathname || prevPage;
    const area = pageArea(page) ?? prevArea;
    if (gap >= hardGapSec) hard.push(i);
    // Any page change or pause is a candidate: goals also change within one area (contact to
    // contact, digest tab to digest tab), and Jev, not the URL, decides whether one did.
    else if (page !== prevPage || gap >= softGapSec) soft.push({ i, gap, areaChange: area !== prevArea });
    prevPage = page;
    prevArea = area;
  }
  // Rapid back-and-forth yields many candidates; keep area changes first, then the longest pauses.
  const kept = soft.length > maxSoft
    ? [...soft].sort((a, b) => (b.areaChange - a.areaChange) || (b.gap - a.gap)).slice(0, maxSoft).sort((a, b) => a.i - b.i)
    : soft;
  return { hard, soft: kept };
}

export function boundaryQuestions(compact, soft) {
  const questions = {};
  for (const s of soft) {
    const page = compact[s.i]?.page || "an unknown page";
    const move = s.areaChange ? "moves to a different part of the product" : s.gap >= 120 ? "comes back after a pause" : "moves to another page";
    questions[`b${s.i}`] = {
      type: "noul",
      instructions: `\`events\` is one user's session in this product (\`product\`), in order. At event ${s.i} (\`events[${s.i}]\`, page ${page}) the user ${move}. Starting at event ${s.i}, does the user begin working toward a different goal than in the events just before it?`,
      criteria: {
        true: "A genuinely new goal starts here: what the user is trying to get done changes, for example from connecting an integration to editing a deal.",
        false: "The same goal continues: the user is still working on what they were doing before, even if they moved between pages, opened settings to finish it, or browsed several records of the same kind.",
      },
    };
  }
  return questions;
}

/** Turns boundary answers into inclusive [from, to] task ranges. */
export function segmentsFromAnswers(n, hard, soft, answers, { threshold = 0.5, minEvents = 3, maxSegments = 8 } = {}) {
  if (n === 0) return [];
  const accepted = soft
    .map(s => ({ i: s.i, p: noulOf(answers[`b${s.i}`]) ?? 0, hard: false }))
    .filter(b => b.p >= threshold);
  const all = [...hard.map(i => ({ i, p: 2, hard: true })), ...accepted].sort((a, b) => a.i - b.i);

  // Drop soft boundaries that would leave a task too short to judge on its own.
  let kept = [];
  let start = 0;
  for (const b of all) {
    if (!b.hard && b.i - start < minEvents) continue;
    kept.push(b);
    start = b.i;
  }
  while (kept.length && !kept[kept.length - 1].hard && n - kept[kept.length - 1].i < minEvents) kept.pop();

  if (kept.length > maxSegments - 1) {
    kept = [...kept].sort((a, b) => b.p - a.p).slice(0, maxSegments - 1).sort((a, b) => a.i - b.i);
  }
  const segments = [];
  let from = 0;
  for (const b of kept) {
    segments.push({ from, to: b.i - 1 });
    from = b.i;
  }
  segments.push({ from, to: n - 1 });
  return segments;
}

/* ---------------- step 2: per-task judgments ---------------- */

const OUTCOME_CRITERIA = {
  completed: "The last action tied to this goal is a clear success, and nothing later in the session reverses, undoes, disconnects, removes or cancels it.",
  abandoned: "The user visibly gave up, changed their mind, or undid earlier progress: navigated away, cancelled, or disconnected or removed something they had just set up.",
  blocked: "An error, a dead end, or a control that did nothing is the last thing tied to this goal.",
  unresolved: "The whole session ends while the user is still in the middle of this task, with no clear success, abandonment or block. Only the last task in the session can end this way; a task the user left to work on something else ended in one of the other outcomes.",
};

const SEVERITY_CRITERIA = {
  high: "A clear failure on something the user needed to get done: an error, a failed save, send, import or connect, or a control that plainly does nothing when the user depends on it. The user could not finish.",
  medium: "A real problem that slowed or confused the user, but they found a way around it or it was not central to what they were doing.",
  low: "Minor friction or a cosmetic issue; the user carried on without much trouble.",
  none: "No problem: normal use of the product.",
};

function keyEventCandidates(compact, events, seg, max = 40) {
  const idx = [];
  for (let i = seg.from; i <= seg.to; i++) if (PROBLEM_EVENTS.has(events[i]?.event)) idx.push(i);
  if (!idx.includes(seg.to)) idx.push(seg.to);
  if (idx.length <= max) return idx;
  const step = idx.length / max;
  return Array.from({ length: max }, (_, j) => idx[Math.floor(j * step)]);
}

function describeEvent(c) {
  return `${c.event}${c.text ? ` "${c.text}"` : ""} on ${c.page || "unknown page"} at ${c.time}`;
}

/**
 * Facts code can count exactly, handed to Jev alongside the raw events so it judges instead of
 * counts: how many dead clicks, rage clicks and exceptions a task has, and which elements the
 * user clicked again and again without a response.
 */
export function taskFacts(compact, seg, isLast) {
  const counts = { dead_clicks: 0, rage_clicks: 0, exceptions: 0 };
  const repeated = new Map();
  for (let i = seg.from; i <= seg.to; i++) {
    const c = compact[i];
    if (!c) continue;
    if (c.event === "dead_click") counts.dead_clicks++;
    else if (c.event === "rageclick") counts.rage_clicks++;
    else if (c.event === "exception") counts.exceptions++;
    if ((c.event === "dead_click" || c.event === "rageclick") && c.text) {
      // Record ids are folded (/contacts/123 -> /contacts/:id) so the same dead control
      // clicked once on each of several records still counts as one repeated failure.
      const key = `${c.text.slice(0, 80)} @ ${pagePattern(c.page)}`;
      repeated.set(key, (repeated.get(key) || 0) + 1);
    }
  }
  return {
    ...counts,
    repeated_unresponsive_clicks: [...repeated].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([target, n]) => ({ target, times: n })),
    last_task_in_session: isLast,
  };
}

export function verdictState(product, compact, segments, events) {
  return {
    product,
    events: compact,
    tasks: segments.map((s, k) => ({
      task: k,
      from: s.from,
      to: s.to,
      pages: uniquePages(events, s.from, s.to),
      facts: taskFacts(compact, s, k === segments.length - 1),
    })),
  };
}

export function verdictQuestions({ compact, events, segments, goals, tags }) {
  const q = {};
  segments.forEach((seg, k) => {
    const scope = `Task ${k} is the user's work in \`events\` from index ${seg.from} to ${seg.to} (\`tasks[${k}]\`, with counted facts in \`tasks[${k}].facts\`), in this product (\`product\`).`;

    q[`out_${k}`] = {
      type: "choice",
      instructions: `${scope} Judge the outcome of task ${k} from the LAST action tied to its goal anywhere in \`events\`, including later events that may undo or reverse an earlier success. A task that looks done and is undone later is not completed.`,
      criteria: OUTCOME_CRITERIA,
    };
    q[`bug_${k}`] = {
      type: "noul",
      instructions: `${scope} Is task ${k} evidence of a real product bug?`,
      criteria: {
        true: "Something in the product failed the user: an error or exception, a button, tab or control that does nothing, a failed save, send, import or connect, or an element the user clicked again and again expecting a response (see \`tasks[].facts.repeated_unresponsive_clicks\`), including AI-written text they plainly tried to open or drill into.",
        false: "Normal use, the user hesitating or exploring, or a single stray click on a label or plain text that nothing suggests they expected to respond.",
      },
    };
    q[`sev_${k}`] = {
      type: "choice",
      instructions: `${scope} How severe is the problem the user hit in task ${k}?`,
      criteria: SEVERITY_CRITERIA,
    };
    q[`core_${k}`] = {
      type: "noul",
      instructions: `${scope} Was the user trying to do something core and consequential for this product in task ${k}?`,
      criteria: {
        true: "A core action with real consequence: connecting an integration, importing or uploading data, getting an answer from an AI assistant, sending something, or a payment or billing action.",
        false: "Browsing, reading, navigating, adjusting a view, or anything minor.",
      },
    };
    if (goals.length) {
      const criteria = {};
      for (const g of goals) {
        const text = g.description ? `${g.purpose}: ${g.description}` : g.purpose;
        criteria[`g${g.id}`] = String(text).slice(0, 200);
      }
      criteria.none = "None of these goals is what the user was trying to accomplish in this task.";
      q[`goal_${k}`] = {
        type: "choice",
        instructions: `${scope} Which of these known goals is the purpose behind task ${k}? Pick one only if it is the same underlying purpose, even if phrased differently; a loose or partial match is "none".`,
        criteria,
      };
    }
    for (const t of tags) {
      q[`tag_${k}_${t.id}`] = {
        type: "noul",
        instructions: `${scope} Does the label "${t.label}" describe the kind of problem in task ${k}?`,
        criteria: {
          true: `"${t.label}" clearly names what went wrong in this task.`,
          false: `"${t.label}" does not fit, or the task had no problem.`,
        },
      };
    }
    const cands = keyEventCandidates(compact, events, seg);
    if (cands.length > 1) {
      const criteria = {};
      for (const i of cands) criteria[`e${i}`] = `Event ${i}: ${describeEvent(compact[i])}`;
      q[`key_${k}`] = {
        type: "choice",
        instructions: `${scope} Which single event best represents what happened in task ${k}: the dead click, error or blocked action behind its outcome, or its final step if nothing went wrong?`,
        criteria,
      };
    }
  });
  return q;
}

const OUTCOME_LABEL = { completed: "Completed", abandoned: "Abandoned", blocked: "Blocked", unresolved: "In progress" };

/**
 * Turns Jev's answers into task objects in the shape the rest of the pipeline stores, plus
 * per-task notes (not stored) that say which write-ups the text model is asked for.
 * Thresholds are starting points, tuned against the stored Opus verdicts.
 */
export function tasksFromVerdicts({ compact, events, segments, goals, tags, answers }) {
  const goalById = new Map(goals.map(g => [g.id, g]));
  const tasks = [];
  const notes = [];
  segments.forEach((seg, k) => {
    const out = choiceOf(answers[`out_${k}`]);
    let outcome = out && OUTCOME_CRITERIA[out.choice] ? out.choice : "unresolved";
    // Only the session's last task can run out of data mid-way; any earlier task ended when the
    // user moved on, so it takes its most likely real outcome instead.
    if (outcome === "unresolved" && k < segments.length - 1 && out) {
      outcome = ["completed", "abandoned", "blocked"].sort((a, b) => probOf(out, b) - probOf(out, a))[0];
    }
    const bugP = noulOf(answers[`bug_${k}`]) ?? 0;
    const sevA = choiceOf(answers[`sev_${k}`]);
    let severity = sevA && SEVERITY_CRITERIA[sevA.choice] ? sevA.choice : "none";
    const coreP = noulOf(answers[`core_${k}`]) ?? 0;
    const realBug = bugP >= 0.4; // recall-first: tuned on 30 sessions (catches 51/54 of the blocked bugs Opus found)
    // A task is only a bug if Jev says so; a non-bug keeps at most "low" friction.
    if (!realBug && (severity === "high" || severity === "medium")) severity = "low";

    const goalA = choiceOf(answers[`goal_${k}`]);
    let goalId = null;
    if (goalA && goalA.choice !== "none" && probOf(goalA, goalA.choice) >= 0.5) {
      const id = Number(goalA.choice.slice(1));
      if (goalById.has(id)) goalId = id;
    }

    const hasProblem = realBug || severity !== "none" || outcome === "blocked";
    const tagHits = tags
      .map(t => ({ id: t.id, p: noulOf(answers[`tag_${k}_${t.id}`]) ?? 0 }))
      .filter(t => t.p >= 0.6)
      .sort((a, b) => b.p - a.p)
      .slice(0, 2);
    const taskTags = hasProblem ? tagHits.map(t => ({ tag_id: t.id, new_tag: null })) : [];

    const keyA = choiceOf(answers[`key_${k}`]);
    let keyIdx = keyA ? Number(keyA.choice.slice(1)) : NaN;
    if (!(keyIdx >= seg.from && keyIdx <= seg.to)) keyIdx = keyEventCandidates(compact, events, seg)[0] ?? seg.to;

    const reachable = outcome === "blocked" && severity === "high" && bugP >= 0.7 && coreP >= 0.7 && probOf(out, "blocked") >= 0.6;
    const reachScore = probOf(out, "blocked") * probOf(sevA, "high") * bugP * coreP;

    tasks.push({
      goal: goalId ? goalById.get(goalId).purpose : null,
      goal_id: goalId,
      new_goal: null,
      tags: taskTags,
      outcome,
      real_bug: realBug,
      severity,
      customer_reachable: reachable,
      title: null,
      narrative: null,
      evidence: null,
      key_timestamp: events[keyIdx]?.timestamp || null,
      jev: {
        outcome_p: round2(probOf(out, outcome)),
        bug_p: round2(bugP),
        severity_p: round2(probOf(sevA, sevA?.choice)),
        goal_p: goalA ? round2(probOf(goalA, goalA.choice)) : null,
        core_p: round2(coreP),
      },
    });
    const needsNewGoal = !goalId;
    notes.push({
      seg,
      keyIdx,
      needsNewGoal,
      allowNewTag: realBug && taskTags.length === 0,
      needsText: realBug || outcome === "blocked" || outcome === "abandoned" || severity === "high" || severity === "medium" || needsNewGoal,
      reachScore: reachable ? reachScore : 0,
    });
  });

  // At most one outreach per session: the clearest qualifying failure.
  let outreachIndex = null;
  notes.forEach((n, k) => {
    if (n.reachScore > 0 && (outreachIndex === null || n.reachScore > notes[outreachIndex].reachScore)) outreachIndex = k;
  });
  if (outreachIndex !== null) notes[outreachIndex].needsText = true;
  return { tasks, notes, outreachIndex };
}

/* ---------------- step 3: write-ups ---------------- */

/** Plain text for a task when no write-up is needed or the text model is unavailable. */
export function templateText(task, note, compact, events) {
  const { seg } = note;
  const areas = [...new Set(uniquePages(events, seg.from, seg.to).map(p => (p.startsWith("+") ? null : pageArea(p))).filter(Boolean))];
  const label = task.goal || `use ${areas.join(", ") || "the product"}`;
  const counts = { dead_click: 0, rageclick: 0, exception: 0 };
  for (let i = seg.from; i <= seg.to; i++) if (compact[i] && compact[i].event in counts) counts[compact[i].event]++;
  const problems = [
    counts.dead_click && `${counts.dead_click} dead click${counts.dead_click > 1 ? "s" : ""}`,
    counts.rageclick && `${counts.rageclick} rage click${counts.rageclick > 1 ? "s" : ""}`,
    counts.exception && `${counts.exception} exception${counts.exception > 1 ? "s" : ""}`,
  ].filter(Boolean);
  const pages = uniquePages(events, seg.from, seg.to).join(", ");
  return {
    goal: label,
    title: `${OUTCOME_LABEL[task.outcome] || "Task"}: ${label}`,
    narrative: `${seg.to - seg.from + 1} events on ${pages || "unknown pages"}, ${compact[seg.from]?.time}–${compact[seg.to]?.time} UTC.${problems.length ? ` ${problems.join(", ")}.` : ""}`,
    evidence: `Key event: ${describeEvent(compact[note.keyIdx] || compact[seg.to])}`,
  };
}

function taskEventLines(compact, seg) {
  let idx = [];
  for (let i = seg.from; i <= seg.to; i++) idx.push(i);
  if (idx.length > 60) {
    const problem = idx.filter(i => ["dead_click", "rageclick", "exception"].includes(compact[i].event)).slice(0, 30);
    idx = [...new Set([...idx.slice(0, 15), ...problem, ...idx.slice(-15)])].sort((a, b) => a - b);
  }
  const lines = [];
  let prev = null;
  for (const i of idx) {
    if (prev !== null && i > prev + 1) lines.push(`  ... (${i - prev - 1} events omitted)`);
    const c = compact[i];
    lines.push(`  [${i}] ${c.time} ${c.event}${c.text ? ` "${c.text}"` : ""} on ${c.page || "?"}`);
    prev = i;
  }
  return lines.join("\n");
}

const VERDICT_WORDS = { true: "yes", false: "no" };

export function textPromptFor({ companyContext, tasks, notes, outreachIndex, compact, tags }) {
  const wanted = tasks.map((t, k) => ({ t, k, n: notes[k] })).filter(x => x.n.needsText);
  const blocks = wanted.map(({ t, k, n }) => {
    const flags = [
      `outcome=${t.outcome}`,
      `real bug=${VERDICT_WORDS[String(t.real_bug)]}`,
      `severity=${t.severity}`,
      `goal=${t.goal ? `"${t.goal}"` : "NEEDS NEW GOAL"}`,
      `key event=[${n.keyIdx}] ${describeEvent(compact[n.keyIdx])}`,
    ];
    if (n.allowNewTag) flags.push("MAY PROPOSE TAG");
    if (k === outreachIndex) flags.push("CHOSEN FOR OUTREACH");
    return `Task ${k}: ${flags.join(", ")}\nEvents:\n${taskEventLines(compact, n.seg)}`;
  });
  const tagList = tags.length ? tags.map(t => `"${t.label}"`).join(", ") : "(none yet)";
  return `You write short, plain write-ups for tasks in one user's session of this product:
${companyContext}

Each task has already been judged. Do not change or second-guess the judgments; write text that agrees with them.

For every task below, write:
- "goal": what the user was trying to accomplish, in a few words
- "title": a short description of the task
- "narrative": 2-3 sentences on what happened
- "evidence": the specific event(s) behind the judgment, with their times
- "new_goal": only for tasks marked NEEDS NEW GOAL, {"purpose": "short outcome name", "description": "1-2 sentences, what success looks like", "tags": ["a few short lowercase tags"]}; otherwise null
- "new_tag": only for tasks marked MAY PROPOSE TAG, a short lowercase label for the kind of problem (for example "unresponsive-button"), or null if nothing fits well. Existing tags: ${tagList}. Never propose a near-duplicate of one.

${outreachIndex !== null ? `One task is marked CHOSEN FOR OUTREACH. Write "outreach_message": the exact message to send that customer. It must be short (1-2 sentences), warm but not apologetic or robotic, specific about what they were doing, and offer help without presuming the cause. Good tone: "Hey, looks like your CSV import didn't go through, want a hand getting your contacts in?" Not: "We're sorry you're experiencing issues with our platform."` : `Set "outreach_message" to null.`}

Return ONLY this JSON, no prose:
{"tasks": [{"task": <number>, "goal": "...", "title": "...", "narrative": "...", "evidence": "...", "new_goal": null, "new_tag": null}], "outreach_message": null}

TASKS:
${blocks.join("\n\n")}
`;
}

const str = v => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * Fills task text: the text model's write-up where it gave one, a plain template everywhere
 * else. Without a write-up there is no new goal or new tag (nothing names them) and no outreach
 * (a template message would be exactly the generic outreach the product must never send).
 */
export function applyText({ tasks, notes, outreachIndex, compact, events, written }) {
  const byTask = new Map();
  for (const item of Array.isArray(written?.tasks) ? written.tasks : []) {
    const k = Number(item?.task);
    if (Number.isInteger(k)) byTask.set(k, item);
  }
  tasks.forEach((task, k) => {
    const note = notes[k];
    const tpl = templateText(task, note, compact, events);
    const item = note.needsText ? byTask.get(k) : null;
    task.goal = str(item?.goal) || task.goal || tpl.goal;
    task.title = str(item?.title) || tpl.title;
    task.narrative = str(item?.narrative) || tpl.narrative;
    task.evidence = str(item?.evidence) || tpl.evidence;
    if (note.needsNewGoal && item?.new_goal && str(item.new_goal.purpose)) {
      task.new_goal = {
        purpose: str(item.new_goal.purpose),
        description: str(item.new_goal.description),
        tags: Array.isArray(item.new_goal.tags) ? item.new_goal.tags.filter(x => typeof x === "string").slice(0, 5) : [],
      };
    }
    if (note.allowNewTag && str(item?.new_tag)) task.tags = [{ tag_id: null, new_tag: { label: str(item.new_tag).toLowerCase() } }];
  });
  const message = outreachIndex !== null ? str(written?.outreach_message) : null;
  return message ? { task_index: outreachIndex, message } : null;
}

/** What the dashboard's Pipeline tab shows for the per-session pass, in place of a prompt. */
export function describeJevAnalysis() {
  return `Every session is judged by Jev (TypeSafe System One), not a text model.

1. Task boundaries. At each page change or pause, Jev answers one yes/no question: does a new goal start here? A silence over 30 minutes always splits.

2. For every task, in one parallel call:
   - outcome: completed, abandoned, blocked or unresolved (only the last task can be unresolved)
   - is it a real bug (flagged at probability 0.4, recall-first)
   - severity: high, medium, low or none
   - which known goal it serves, or none
   - which existing tags fit
   - the key event, picked from the task's own dead clicks, rage clicks and errors, so its timestamp is exact
   - whether it was a core, consequential action (an outreach gate)
   Code hands Jev the counted facts (dead clicks, rage clicks, errors, and elements clicked again and again with no response) alongside the raw events.

3. Code applies the rules. Outreach needs blocked + high severity + likely bug + a core action, and at most one per session.

4. The provider set in Admin > AI Providers only writes prose: titles, narratives, new goal names, new tag labels and the outreach message, and only for tasks worth a write-up. If it is unavailable, tasks get plain text and every judgment is still saved.

Sessions are judged once, after they go quiet (30 minutes without events), and again only if new problem events appear.`;
}
