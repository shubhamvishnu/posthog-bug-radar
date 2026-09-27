// Run with: node --test worker/test/*.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  askJev, pageArea, pagePattern, indexEvents, candidateBoundaries, segmentsFromAnswers,
  taskFacts, verdictQuestions, tasksFromVerdicts, applyText, textPromptFor,
} from "../src/jev.js";

const t0 = Date.parse("2026-09-08T10:00:00.000Z");
function ev(sec, event, pathname, el_text = null) {
  return { event, pathname, el_text, timestamp: new Date(t0 + sec * 1000).toISOString() };
}
const noul = p => ({ type: "noul", noul: p });
const choice = (c, probabilities) => ({ type: "choice", choice: c, probabilities: probabilities || { [c]: 1 }, confidence: 1 });

test("pageArea and pagePattern", () => {
  assert.equal(pageArea("/deals/123/contacts"), "deals");
  assert.equal(pageArea("/"), "home");
  assert.equal(pageArea(null), null);
  assert.equal(pagePattern("/contacts/1056397/notes"), "/contacts/:id/notes");
  assert.equal(pagePattern("/deals/digest/top-commit"), "/deals/digest/top-commit");
});

test("candidateBoundaries: long silence always splits, page changes and pauses are candidates", () => {
  const events = [
    ev(0, "$pageview", "/deals"),
    ev(5, "$autocapture", "/deals"),
    ev(10, "$autocapture", "/deals/1"),        // page change
    ev(15, "$autocapture", "/deals/1"),
    ev(200, "$autocapture", "/deals/1"),       // 185s pause
    ev(210, "$autocapture", "/settings"),      // area change
    ev(210 + 3600, "$autocapture", "/settings"), // an hour later
  ];
  const { hard, soft } = candidateBoundaries(events);
  assert.deepEqual(hard, [6]);
  assert.deepEqual(soft.map(s => s.i), [2, 4, 5]);
  assert.equal(soft.find(s => s.i === 5).areaChange, true);
  assert.equal(soft.find(s => s.i === 2).areaChange, false);
});

test("candidateBoundaries caps candidates, keeping area changes and long pauses", () => {
  const events = [];
  for (let i = 0; i < 100; i++) events.push(ev(i * 2, "$autocapture", i % 2 ? `/contacts/${i}` : `/deals/${i}`));
  const { soft } = candidateBoundaries(events, { maxSoft: 10 });
  assert.equal(soft.length, 10);
  assert.ok(soft.every(s => s.areaChange));
  assert.deepEqual([...soft].sort((a, b) => a.i - b.i), soft);
});

test("segmentsFromAnswers: threshold, minimum task size, hard splits", () => {
  const soft = [{ i: 2 }, { i: 5 }, { i: 6 }, { i: 12 }];
  const answers = { b2: noul(0.9), b5: noul(0.9), b6: noul(0.9), b12: noul(0.2) };
  // b2 leaves a 2-event task (dropped), b5 accepted, b6 too close to b5 (dropped), b12 below threshold.
  assert.deepEqual(segmentsFromAnswers(15, [], soft, answers), [{ from: 0, to: 4 }, { from: 5, to: 14 }]);
  // A hard boundary splits even when it leaves a short task.
  assert.deepEqual(segmentsFromAnswers(15, [14], [], {}), [{ from: 0, to: 13 }, { from: 14, to: 14 }]);
  assert.deepEqual(segmentsFromAnswers(0, [], [], {}), []);
});

test("segmentsFromAnswers keeps the most confident boundaries when over the cap", () => {
  const soft = [10, 20, 30, 40].map(i => ({ i }));
  const answers = { b10: noul(0.6), b20: noul(0.95), b30: noul(0.7), b40: noul(0.9) };
  const segs = segmentsFromAnswers(50, [], soft, answers, { maxSegments: 3 });
  assert.deepEqual(segs, [{ from: 0, to: 19 }, { from: 20, to: 39 }, { from: 40, to: 49 }]);
});

test("taskFacts counts problems and folds record ids for repeated clicks", () => {
  const events = [
    ev(0, "$dead_click", "/contacts/1", "Notes"),
    ev(5, "$dead_click", "/contacts/2", "Notes"),
    ev(9, "$rageclick", "/contacts/3", "Notes"),
    ev(12, "$exception", "/contacts/3"),
    ev(15, "$dead_click", "/deals", "Stage"),
  ];
  const f = taskFacts(indexEvents(events), { from: 0, to: 4 }, true);
  assert.equal(f.dead_clicks, 3);
  assert.equal(f.rage_clicks, 1);
  assert.equal(f.exceptions, 1);
  assert.deepEqual(f.repeated_unresponsive_clicks, [{ target: "Notes @ /contacts/:id", times: 3 }]);
  assert.equal(f.last_task_in_session, true);
});

function fixture() {
  const events = [
    ev(0, "$pageview", "/deals"),
    ev(5, "$dead_click", "/deals", "Save"),
    ev(6, "$dead_click", "/deals", "Save"),
    ev(9, "$autocapture", "/deals"),
    ev(20, "$pageview", "/contacts"),
    ev(25, "$autocapture", "/contacts", "Open"),
    ev(30, "$autocapture", "/contacts"),
  ];
  const compact = indexEvents(events);
  const segments = [{ from: 0, to: 3 }, { from: 4, to: 6 }];
  const goals = [{ id: 7, purpose: "save a deal", description: null }];
  const tags = [{ id: 4, label: "unresponsive-button" }];
  return { events, compact, segments, goals, tags };
}

test("verdictQuestions asks every judgment per task, with key events from the task's own problems", () => {
  const { events, compact, segments, goals, tags } = fixture();
  const q = verdictQuestions({ compact, events, segments, goals, tags });
  for (const k of [0, 1]) for (const p of ["out", "bug", "sev", "core", "goal"]) assert.ok(q[`${p}_${k}`], `${p}_${k}`);
  assert.ok(q.tag_0_4);
  assert.deepEqual(Object.keys(q.key_0.criteria), ["e1", "e2", "e3"]);
  assert.ok(!q.key_1, "a task with no problem events has only one candidate, its last event");
  assert.ok(q.goal_0.criteria.g7 && q.goal_0.criteria.none);
});

test("tasksFromVerdicts applies the rules", () => {
  const { events, compact, segments, goals, tags } = fixture();
  const answers = {
    out_0: choice("blocked", { blocked: 0.8, completed: 0.1, abandoned: 0.05, unresolved: 0.05 }),
    bug_0: noul(0.85), sev_0: choice("high", { high: 0.7 }), core_0: noul(0.9),
    goal_0: choice("g7", { g7: 0.8, none: 0.2 }), tag_0_4: noul(0.9), key_0: choice("e2"),
    // A non-last task can't be "unresolved": it takes its next most likely outcome.
    out_1: choice("unresolved", { unresolved: 0.5, completed: 0.3, abandoned: 0.15, blocked: 0.05 }),
    bug_1: noul(0.1), sev_1: choice("medium"), core_1: noul(0.2), goal_1: choice("g7", { g7: 0.4, none: 0.6 }), tag_1_4: noul(0.9),
  };
  // Make task 1 not last by adding a third segment.
  const segs = [...segments.slice(0, 1), { from: 4, to: 5 }, { from: 6, to: 6 }];
  answers.out_2 = choice("completed"); answers.bug_2 = noul(0); answers.sev_2 = choice("none"); answers.core_2 = noul(0); answers.goal_2 = choice("none"); answers.tag_2_4 = noul(0);
  const { tasks, notes, outreachIndex } = tasksFromVerdicts({ compact, events, segments: segs, goals, tags, answers });

  assert.equal(tasks[0].outcome, "blocked");
  assert.equal(tasks[0].real_bug, true);
  assert.equal(tasks[0].severity, "high");
  assert.equal(tasks[0].goal_id, 7);
  assert.equal(tasks[0].goal, "save a deal");
  assert.deepEqual(tasks[0].tags, [{ tag_id: 4, new_tag: null }]);
  assert.equal(tasks[0].key_timestamp, events[2].timestamp);
  assert.equal(tasks[0].customer_reachable, true);
  assert.equal(outreachIndex, 0);

  assert.equal(tasks[1].outcome, "completed");
  assert.equal(tasks[1].real_bug, false);
  assert.equal(tasks[1].severity, "low", "a non-bug keeps at most low severity");
  assert.equal(tasks[1].goal_id, null, "a goal pick under 0.5 is not a match");
  assert.equal(notes[1].needsNewGoal, true);
  assert.equal(tasks[1].customer_reachable, false);

  assert.deepEqual(tasks[2].tags, [], "tags only on tasks with a problem");
  assert.equal(notes[0].allowNewTag, false, "an existing tag matched");
});

test("applyText uses the write-up where given, plain text otherwise, and never a template outreach", () => {
  const { events, compact, segments, goals, tags } = fixture();
  const answers = {
    out_0: choice("blocked", { blocked: 0.9 }), bug_0: noul(0.9), sev_0: choice("high", { high: 0.9 }), core_0: noul(0.9), goal_0: choice("none"), tag_0_4: noul(0.1), key_0: choice("e1"),
    out_1: choice("completed"), bug_1: noul(0.05), sev_1: choice("none"), core_1: noul(0.1), goal_1: choice("g7", { g7: 0.9 }), tag_1_4: noul(0),
  };
  const run = () => tasksFromVerdicts({ compact, events, segments, goals, tags, answers });

  const a = run();
  const outreach = applyText({ ...a, compact, events, written: {
    tasks: [{ task: 0, goal: "save the deal", title: "Save button dead", narrative: "N", evidence: "E", new_goal: { purpose: "save a deal record", description: "d", tags: ["deals", 5] }, new_tag: "Dead-Save" }],
    outreach_message: "Hey, looks like saving that deal didn't work, want a hand?",
  } });
  assert.equal(a.tasks[0].title, "Save button dead");
  assert.deepEqual(a.tasks[0].new_goal, { purpose: "save a deal record", description: "d", tags: ["deals"] });
  assert.deepEqual(a.tasks[0].tags, [{ tag_id: null, new_tag: { label: "dead-save" } }]);
  assert.deepEqual(outreach, { task_index: 0, message: "Hey, looks like saving that deal didn't work, want a hand?" });
  assert.equal(a.tasks[1].title, "Completed: save a deal", "routine tasks get plain text");
  assert.equal(a.tasks[1].new_goal, null);

  const b = run();
  const none = applyText({ ...b, compact, events, written: null });
  assert.equal(none, null, "no write-up means no outreach");
  assert.equal(b.tasks[0].new_goal, null);
  assert.match(b.tasks[0].title, /^Blocked: /);
  assert.match(b.tasks[0].narrative, /2 dead clicks/);
  assert.match(b.tasks[0].evidence, /dead_click "Save"/);
  assert.ok(!/—/.test(JSON.stringify(b.tasks)), "no em dashes in generated copy");
});

test("textPromptFor only includes tasks that need a write-up", () => {
  const { events, compact, segments, goals, tags } = fixture();
  const answers = {
    out_0: choice("blocked"), bug_0: noul(0.9), sev_0: choice("high"), core_0: noul(0.2), goal_0: choice("g7", { g7: 0.9 }), tag_0_4: noul(0.9), key_0: choice("e1"),
    out_1: choice("completed"), bug_1: noul(0), sev_1: choice("none"), core_1: noul(0), goal_1: choice("g7", { g7: 0.9 }), tag_1_4: noul(0),
  };
  const r = tasksFromVerdicts({ compact, events, segments, goals, tags, answers });
  const prompt = textPromptFor({ companyContext: "A CRM", ...r, compact, tags });
  assert.match(prompt, /Task 0: outcome=blocked/);
  assert.doesNotMatch(prompt, /Task 1:/);
  assert.match(prompt, /Set "outreach_message" to null/);
});

test("askJev splits large question sets, retries overload, and fails on a missing answer", async () => {
  const questions = {};
  for (let i = 0; i < 45; i++) questions[`q${i}`] = { type: "noul", instructions: "x" };
  const calls = [];
  let overloadOnce = true;
  const fetcher = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(Object.keys(body.questions).length);
    if (overloadOnce) { overloadOnce = false; return new Response("busy", { status: 529 }); }
    const answers = Object.fromEntries(Object.keys(body.questions).map(k => [k, noul(0.5)]));
    return new Response(JSON.stringify({ answers, usage: { input_tokens: 100 } }), { status: 200 });
  };
  const r = await askJev("k", {}, questions, { fetcher });
  assert.equal(Object.keys(r.answers).length, 45);
  assert.equal(r.inputTokens, 200);
  assert.deepEqual(calls.sort(), [40, 40, 5].sort());

  const partial = async () => new Response(JSON.stringify({ answers: {} }), { status: 200 });
  await assert.rejects(askJev("k", {}, { a: { type: "noul", instructions: "x" } }, { fetcher: partial }), /no answer for a/);
  const bad = async () => new Response("nope", { status: 401 });
  await assert.rejects(askJev("k", {}, { a: { type: "noul", instructions: "x" } }, { fetcher: bad }), /Jev 401/);
});
