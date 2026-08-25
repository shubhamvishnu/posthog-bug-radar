# Cloudflare-native scheduled pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retire `bug_radar.py`'s local-only execution model. Port its full pipeline (PostHog fetch, prompt building, LLM calls, report save, screenshot-capture dispatch) into `worker/src/index.js`, running natively on a Cloudflare Cron Trigger against the cadence (`sync_freq`/`sync_max_sessions`) that already exists per-connection. All LLM calls become plain HTTPS requests to each provider's REST API — no local `claude` CLI session dependency anywhere.

**Architecture:** A new `scheduled()` export on the Worker fires every 5 minutes, queries D1 for connections that are due (`computeDue`, already exists), and runs each due connection through a new `runPipelineForConnection()` — the JS port of `bug_radar.py`'s `main()`. Report-saving logic is factored out of the existing `POST /api/report` handler into a shared function so both the HTTP route and the new in-process path use identical D1-write logic. Screenshot capture dispatch moves from a local `gh` CLI subprocess call to a direct GitHub REST API call.

**Tech Stack:** Cloudflare Workers (JS), D1, Cloudflare Cron Triggers, raw `fetch` to Anthropic/OpenAI/Gemini/GitHub REST APIs — no new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-08-26-cloudflare-native-pipeline-design.md`

## Global Constraints

- No new npm packages. Every provider call is raw `fetch`, not an SDK.
- `LLM_API_TIMEOUT` = 120000 ms on every provider `fetch` via `AbortSignal.timeout(120000)` — this is the fix for the live Gemini-hang bug found earlier this session; it must carry over unchanged.
- `THEME_PROMPT` / `SESSION_PROMPT` text must be byte-for-byte identical to `bug_radar.py` lines 232-366 (already live-tuned and verified this session) — only the interpolation syntax changes (Python `.format()` → JS template literal).
- Every new D1-touching function takes `env` as its first argument, matching every existing function in this file (`resolveAiConfig(env, ...)`, `logConnectionEvent(env, ...)`, etc.) — do not introduce a different calling convention.
- Sequential execution only for the scheduled handler's per-connection loop — no `Promise.all` across connections (one tenant's failure or slow LLM call must not race another tenant's D1 write).
- `/api/pipeline/*` routes (used by `capture_screenshot.py`) are NOT touched by this plan. Do not modify, rename, or remove any of them.
- `git grep -n bug_radar` must return zero matches in `*.py`/`*.yml`/`*.js` after Task 4 (spec files mentioning it historically are fine).

---

### Task 1: Provider LLM callers + prompt templates

**Files:**
- Modify: `worker/src/index.js` (add new functions near `resolveAiConfig`, i.e. after line 156 `maskKey`)

**Interfaces:**
- Consumes: nothing new (this task is pure addition, no wiring into routes yet)
- Produces: `parseLlmJson(text)`, `callAnthropicLlm(prompt, model, apiKey)`, `callOpenaiLlm(prompt, model, apiKey)`, `callGeminiLlm(prompt, model, apiKey)`, `callLlm(prompt, aiConfig)`, `themePromptFor(companyContext, data)`, `sessionPromptFor(companyContext, goalsContext, tagsContext, data)` — all consumed by Task 3's `runPipelineForConnection`.

- [ ] **Step 1: Add the JSON-fence-stripping helper**

Insert directly after `maskKey` (currently ends at line 156):

```js
function parseLlmJson(text) {
  text = text.trim();
  if (text.startsWith("```")) {
    text = text.split("```")[1];
    if (text.startsWith("json")) text = text.slice(4);
  }
  return JSON.parse(text);
}
```

- [ ] **Step 2: Add the three provider callers**

```js
const LLM_API_TIMEOUT_MS = 120000; // matches bug_radar.py's LLM_API_TIMEOUT=120 -- Gemini hung
                                    // past 90s with no timeout set (confirmed live this session)

async function callAnthropicLlm(prompt, model, apiKey) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 16000,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(LLM_API_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  return parseLlmJson(text);
}

async function callOpenaiLlm(prompt, model, apiKey) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(LLM_API_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`OpenAI API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return parseLlmJson(data.choices[0].message.content);
}

async function callGeminiLlm(prompt, model, apiKey) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      signal: AbortSignal.timeout(LLM_API_TIMEOUT_MS),
    }
  );
  if (!res.ok) throw new Error(`Gemini API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const parts = data.candidates?.[0]?.content?.parts || [];
  const text = parts.map(p => p.text).join("");
  return parseLlmJson(text);
}

async function callLlm(prompt, aiConfig) {
  const { provider, model, api_key: apiKey } = aiConfig;
  if (provider === "anthropic") return callAnthropicLlm(prompt, model, apiKey);
  if (provider === "openai") return callOpenaiLlm(prompt, model, apiKey);
  if (provider === "gemini") return callGeminiLlm(prompt, model, apiKey);
  throw new Error(`unknown AI provider: ${provider}`);
}
```

- [ ] **Step 3: Drop `use_session_first` from `resolveAiConfig`**

In the existing `resolveAiConfig` function, change the final line from:

```js
  return { provider, model, api_key: apiKey, use_session_first: provider === "anthropic" };
```

to:

```js
  return { provider, model, api_key: apiKey };
```

There is no session-first path left anywhere in the codebase after this plan — every call is a direct API call regardless of provider.

- [ ] **Step 4: Add the two prompt-template functions**

Add these as functions returning the exact text from `bug_radar.py` lines 232-366, ported to template literals (place after the `callLlm` function):

```js
function themePromptFor(companyContext, data) {
  return `You are looking at PostHog dead-click/rage-click clusters for this product:
${companyContext}

Each row is (page, clicked-element-text, click count, unique users) over the last few days.

Group these into 3-8 named themes. For each theme give:
- title: short name for the problem
- pages: which page(s) it's on
- likely_cause: one sentence, best guess at what's actually broken
- confidence: high/medium/low
- false_positive_risk: one sentence on whether this might just be users clicking
  read-only content (long text, AI-generated summaries) rather than a real bug

Return ONLY a JSON array of theme objects, no prose.

DATA:
${data}
`;
}

function sessionPromptFor(companyContext, goalsContext, tagsContext, data) {
  return `You are looking at one user's ordered event stream for this product:
${companyContext}

Events are page views, clicks (with element text when captured), dead clicks,
rage clicks, and exceptions, in chronological order.

EXISTING GOALS -- the outcomes users are already known to pursue in this product:
${goalsContext}

For each task, decide whether it matches one of the EXISTING GOALS above (the same
underlying purpose, even if phrased differently) or represents a new one not yet tracked:
- If it clearly matches an existing goal, set "goal_id" to that goal's id and leave
  "new_goal" null.
- If it does not match any existing goal, set "goal_id" to null and fill "new_goal" with
  {"purpose": "short outcome name", "description": "1-2 sentences, what success looks
  like", "tags": ["a few short lowercase tags"]}.
Never invent a goal_id that isn't in the EXISTING GOALS list above. When in doubt between
a loose match and a new goal, prefer creating a new goal, goals should be specific enough
to be useful, not a catch-all.

EXISTING TAGS -- categories already used to classify tasks in this product:
${tagsContext}

For each task, also assign zero or more tags: labels that categorize what kind of task
this is (e.g. "UI Bug", "Integration Bug", "Data Sync"), useful for engineering and
product to group tasks by theme. For each tag that clearly applies, either reuse an
existing tag's id from EXISTING TAGS above, or, if none fits, propose a new one with just
a short label. Never invent a tag_id that isn't in the EXISTING TAGS list above. Prefer
reusing an existing tag over minting a near-duplicate (don't create "UI Bugs" if "UI Bug"
already exists). Most tasks need 0-2 tags; don't force a tag onto every task.

A single session often contains MORE THAN ONE distinct thing the user was trying to do --
e.g. they might try to connect an integration, then separately go create a record, then
separately browse something else. Do not force the whole session into one goal. Instead:

1. Segment the event stream into distinct tasks, based on shifts in what the user appears
   to be trying to accomplish (a genuine change in goal, not just a new page -- browsing
   several records in a row is still "browsing", not several separate tasks).
2. For EACH task, independently judge its outcome and whether it's evidence of a real
   product bug.

For each task's "outcome", judge from the LAST relevant action tied to this goal in the
event window -- not the first apparent success. A task can look successful partway through
and then be undone later in the same window; when that happens, the later action wins.
- "completed": the LAST relevant action is a clear success signal, AND nothing after it
  reverses, undoes, disconnects, removes, or cancels that success. If the user connects an
  integration and then later disconnects it, deletes what they just created, or reverts a
  change -- even minutes later, even after navigating elsewhere in between -- that is NOT
  completed. Scan the full window for this before deciding.
- "abandoned": the user visibly gave up, changed their mind, or undid earlier progress
  (navigated away, cancelled, disconnected/removed something they'd just set up)
- "blocked": an error, dead end, or unresponsive control is the last thing tied to this goal
- "unresolved": the event window ends mid-task with no clear success, abandonment, or block
  (e.g. hit the 150-event cap or 3-day window while still in progress) -- use this rather
  than guessing when the data simply runs out

Most sessions will have 1-3 tasks. Only split into multiple tasks when the underlying goal
genuinely changes, not for every page navigation within the same goal.

CUSTOMER OUTREACH -- be extremely conservative here. Proactively messaging a customer about
something that turns out to be normal use, or something minor, damages trust and reads as
spammy. Getting a genuinely blocked customer help fast is valuable; getting it wrong is
costly. So:

For each task, set "customer_reachable" to true ONLY if ALL of these hold:
- outcome is "blocked" (a clear, unambiguous technical failure -- not "unresolved", where
  we simply don't know what happened next, and not "abandoned", which is often just the
  user changing their mind, not a bug)
- the failure is on a core, consequential action for THIS product (see the description
  above for what that is here) -- e.g. an integration/connection failing, a data
  import/upload failing, an AI assistant returning an error or failure message, a
  payment/billing action failing. NOT a dead click on read-only text, NOT general UI
  friction, NOT anything ambiguous or low-severity.
- severity is "high" (never mark medium/low/none as customer_reachable)
Default to false whenever in doubt. Most tasks, even real bugs, should NOT be customer_reachable.

We can send AT MOST ONE outreach message per session, even if multiple tasks qualify. So:
after judging every task, if one or more tasks are customer_reachable, pick the single
best one (worst/clearest failure) and write "recommended_outreach" for it. If zero tasks
qualify, "recommended_outreach" must be null.

The outreach message itself must be short (1-2 sentences), warm but not apologetic or
robotic, specific about what the customer was doing (not generic), and offer help without
presuming the cause. Example tone: "Hey, looks like your CSV import didn't go through --
want a hand getting your contacts in?" Not: "We're sorry you're experiencing issues with
our platform."

Return ONLY this JSON object, no prose:
{
  "tasks": [
    {
      "goal": "what the user was trying to accomplish in this task, in a few words",
      "goal_id": null OR <id from EXISTING GOALS above>,
      "new_goal": null OR {"purpose": "...", "description": "...", "tags": ["..."]},
      "tags": [] OR [{"tag_id": <id from EXISTING TAGS above> OR null, "new_tag": {"label": "..."} OR null}],
      "outcome": "completed/abandoned/blocked/unresolved",
      "real_bug": true/false,
      "severity": "high/medium/low/none",
      "customer_reachable": true/false,
      "title": "short description of this task",
      "narrative": "2-3 sentences: what happened in this task",
      "evidence": "the specific event(s) that support this task's verdict",
      "key_timestamp": "the exact timestamp value (copy verbatim from the input events)
        of the single most important event backing this task's verdict -- e.g. the dead
        click, error, or blocked action that best represents what happened"
    }
  ],
  "recommended_outreach": null OR {
    "task_index": 0,
    "message": "the exact customer-facing message to send, per the rules above"
  }
}

SESSION EVENTS:
${data}
`;
}
```

- [ ] **Step 5: Verify syntax and commit**

Run: `node --check worker/src/index.js`
Expected: no output, exit code 0.

Also run: `grep -c "use_session_first" worker/src/index.js`
Expected: `0`

```bash
git add worker/src/index.js
git commit -m "feat: add API-only LLM provider callers and ported prompt templates"
```

---

### Task 2: HogQL fetch functions + retry hardening

**Files:**
- Modify: `worker/src/index.js` (extend `hogqlPost` around line 221; add new functions after it)

**Interfaces:**
- Consumes: `hogqlPost(region, apiKey, projectId, query)` (existing, being extended in place — signature unchanged)
- Produces: `hogqlRows(data)`, `fetchMacroClusters(region, apiKey, projectId, window, limit)`, `fetchCandidateSessions(region, apiKey, projectId, window, limit, identity)`, `fetchSessionsById(region, apiKey, projectId, sessionIds, identity, lookbackDays)`, `fetchSessionEvents(region, apiKey, projectId, sessionId, window, customEvents)` — all consumed by Task 3's `runPipelineForConnection`.

- [ ] **Step 1: Add retry-on-5xx to the existing `hogqlPost`**

Replace the existing `hogqlPost` function (currently):

```js
async function hogqlPost(region, apiKey, projectId, query) {
  const res = await fetch(`${PH_REGIONS[region]}/api/projects/${projectId}/query/`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ query: { kind: "HogQLQuery", query } }),
  });
  if (!res.ok) {
    const err = new Error(`PostHog ${res.status} on HogQL query`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}
```

with:

```js
async function hogqlPost(region, apiKey, projectId, query, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    const res = await fetch(`${PH_REGIONS[region]}/api/projects/${projectId}/query/`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ query: { kind: "HogQLQuery", query } }),
    });
    if (res.status >= 500 && attempt < retries - 1) {
      await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }
    if (!res.ok) {
      const err = new Error(`PostHog ${res.status} on HogQL query`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }
}
```

This matches `bug_radar.py`'s `hogql(..., retries=3)` backoff (2s, 4s). Existing callers of `hogqlPost` are unaffected — the new `retries` parameter defaults to 3 and the return shape is identical.

- [ ] **Step 2: Add the row-zipping helper and the four fetch functions**

Add after `hogqlPost`:

```js
function hogqlRows(data) {
  const cols = data.columns;
  return data.results.map(row => Object.fromEntries(cols.map((c, i) => [c, row[i]])));
}

function identityExprs(identity) {
  return {
    email: identity.email ? `any(person.properties.${identity.email})` : "NULL",
    name: identity.name ? `any(person.properties.${identity.name})` : "NULL",
    role: identity.role ? `any(person.properties.${identity.role})` : "NULL",
  };
}

async function fetchMacroClusters(region, apiKey, projectId, window, limit) {
  const data = await hogqlPost(region, apiKey, projectId, `
    SELECT
        properties.$pathname AS pathname,
        properties.$el_text AS el_text,
        count() AS clicks,
        uniq(person_id) AS users
    FROM events
    WHERE event IN ('$dead_click', '$rageclick')
      AND timestamp >= now() - INTERVAL ${window}
    GROUP BY pathname, el_text
    ORDER BY clicks DESC
    LIMIT ${limit}
  `);
  return hogqlRows(data);
}

async function fetchCandidateSessions(region, apiKey, projectId, window, limit, identity) {
  const ex = identityExprs(identity);
  const data = await hogqlPost(region, apiKey, projectId, `
    SELECT
        properties.$session_id AS session_id,
        countIf(event = '$dead_click') AS dead_clicks,
        countIf(event = '$rageclick') AS rage_clicks,
        countIf(event = '$exception') AS exceptions,
        uniq(person_id) AS users,
        min(timestamp) AS started_at,
        any(person_id) AS person_id,
        ${ex.email} AS email,
        ${ex.name} AS name,
        ${ex.role} AS role
    FROM events
    WHERE event IN ('$dead_click', '$rageclick', '$exception')
      AND timestamp >= now() - INTERVAL ${window}
      AND properties.$session_id IS NOT NULL
    GROUP BY session_id
    ORDER BY (dead_clicks + rage_clicks * 3 + exceptions * 5) DESC
    LIMIT ${limit}
  `);
  return hogqlRows(data);
}

async function fetchSessionsById(region, apiKey, projectId, sessionIds, identity, lookbackDays = 30) {
  const ex = identityExprs(identity);
  const idList = sessionIds.map(sid => `'${sid.replace(/'/g, "''")}'`).join(", ");
  const data = await hogqlPost(region, apiKey, projectId, `
    SELECT
        properties.$session_id AS session_id,
        countIf(event = '$dead_click') AS dead_clicks,
        countIf(event = '$rageclick') AS rage_clicks,
        countIf(event = '$exception') AS exceptions,
        uniq(person_id) AS users,
        min(timestamp) AS started_at,
        any(person_id) AS person_id,
        ${ex.email} AS email,
        ${ex.name} AS name,
        ${ex.role} AS role
    FROM events
    WHERE properties.$session_id IN (${idList})
      AND timestamp >= now() - INTERVAL ${lookbackDays} DAY
    GROUP BY session_id
  `);
  return hogqlRows(data);
}

async function fetchSessionEvents(region, apiKey, projectId, sessionId, window, customEvents) {
  const baseline = ["$pageview", "$autocapture", "$dead_click", "$rageclick", "$exception"];
  const eventList = Array.from(new Set([...baseline, ...(customEvents || [])]))
    .map(e => `'${e.replace(/'/g, "''")}'`)
    .join(", ");
  const timeFilter = window ? `AND timestamp >= now() - INTERVAL ${window}` : "";
  const data = await hogqlPost(region, apiKey, projectId, `
    SELECT
        event,
        properties.$el_text AS el_text,
        properties.$pathname AS pathname,
        timestamp
    FROM events
    WHERE properties.$session_id = '${sessionId.replace(/'/g, "''")}'
      ${timeFilter}
      AND event IN (${eventList})
    ORDER BY timestamp
    LIMIT 150
  `);
  return hogqlRows(data);
}
```

Note: `sessionId`/`sessionIds` values come from PostHog's own HogQL results (Task 3's candidate-selection query), not raw user input, but the `.replace(/'/g, "''")` SQL-escaping is included defensively since these strings get interpolated directly into a query string, matching the safety bar of the rest of this file.

- [ ] **Step 3: Verify**

Run: `node --check worker/src/index.js`
Expected: no output, exit code 0.

```bash
git add worker/src/index.js
git commit -m "feat: port HogQL fetch functions from bug_radar.py, add retry to hogqlPost"
```

---

### Task 3: Pipeline runner, scheduled handler, report-save extraction, GitHub dispatch, admin run-now route

**Files:**
- Modify: `worker/src/index.js` (large — see steps below for exact insertion points)
- Modify: `worker/wrangler.jsonc` (add cron trigger)

**Interfaces:**
- Consumes: everything from Task 1 (`callLlm`, `themePromptFor`, `sessionPromptFor`) and Task 2 (`fetchMacroClusters`, `fetchCandidateSessions`, `fetchSessionsById`, `fetchSessionEvents`), plus existing `resolveAiConfig`, `decryptSecret`, `resolveGoals`, `resolveTags`, `postSlackNotifications`, `logConnectionEvent`, `computeDue`, `PH_REGIONS`.
- Produces: `saveGeneratedReport(env, opts)`, `triggerCaptureViaGithub(env, sessionId, keyTimestamp, connectionId, taskIndex)`, `runPipelineForConnection(env, conn)`, the `scheduled()` export, the `POST /api/admin/connections/:id/run-now` route.

- [ ] **Step 1: Extract `saveGeneratedReport` from the existing `POST /api/report` handler**

Find the existing `POST /api/report` handler (starts `if (pathname === "/api/report" && request.method === "POST")`, body currently does goal/tag resolution, a fresh INSERT into `reports`, `last_pipeline_run_at` update, event log, Slack notify). Add this new function directly above that route handler (i.e., before the `if (pathname === "/api/report" && request.method === "GET")` block), and then replace the POST handler's body to call it.

New shared function:

```js
async function saveGeneratedReport(env, { ownerEmail, connectionId, generatedAt, macroThemes, microFindings, themePrompt, sessionPrompt, captureCount, triggerLabel }) {
  const goalsResult = await resolveGoals(env, ownerEmail, microFindings || []);
  const tagsResult = await resolveTags(env, ownerEmail, goalsResult.findings);
  const resolvedFindings = tagsResult.findings;
  await env.DB.prepare(
    `INSERT INTO reports (generated_at, macro_themes, micro_findings, theme_prompt, session_prompt, owner_email, connection_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      generatedAt,
      JSON.stringify(macroThemes || []),
      JSON.stringify(resolvedFindings),
      themePrompt || null,
      sessionPrompt || null,
      ownerEmail,
      connectionId || null
    )
    .run();
  if (connectionId) {
    await env.DB.prepare("UPDATE connections SET last_pipeline_run_at = datetime('now') WHERE id = ?").bind(connectionId).run();
    const taskCount = resolvedFindings.reduce((n, f) => n + (f.tasks || []).length, 0);
    const realBugCount = resolvedFindings.reduce((n, f) => n + (f.tasks || []).filter(t => t.real_bug).length, 0);
    const outreachCount = resolvedFindings.filter(f => f.recommended_outreach).length;
    await logConnectionEvent(
      env, connectionId, "sync_completed", "success", "Sync completed",
      `Pulled ${resolvedFindings.length} sessions · ${taskCount} tasks · ${realBugCount} real bugs · ${outreachCount} outreach · ${goalsResult.count} new goals · ${tagsResult.count} new tags · ${captureCount || 0} moments queued.`,
      triggerLabel || "scheduled"
    );
  }
  await postSlackNotifications(env, ownerEmail, resolvedFindings);
  return { ok: true, findings: resolvedFindings };
}
```

Replace the existing POST handler body with:

```js
    if (pathname === "/api/report" && request.method === "POST") {
      const auth = request.headers.get("authorization") || "";
      if (auth !== `Bearer ${env.BUGRADAR_API_SECRET}`) {
        return json({ error: "unauthorized" }, 401);
      }
      const body = await request.json();
      const ownerEmail = body.owner_email || DEFAULT_OWNER_EMAIL;
      await saveGeneratedReport(env, {
        ownerEmail,
        connectionId: body.connection_id || null,
        generatedAt: body.generated_at,
        macroThemes: body.macro_themes,
        microFindings: body.micro_findings,
        themePrompt: body.theme_prompt,
        sessionPrompt: body.session_prompt,
        captureCount: body.capture_count,
        triggerLabel: "scheduled",
      });
      return json({ ok: true });
    }
```

This must produce byte-identical D1 writes to the current handler — the reviewer should diff the old body against `saveGeneratedReport`'s body line-by-line to confirm nothing was dropped (in particular: the `last_pipeline_run_at` update and the exact `logConnectionEvent` detail string format must match).

- [ ] **Step 2: Add `triggerCaptureViaGithub`**

Add after `saveGeneratedReport`:

```js
const CAPTURE_REPO = "shubhamvishnu/posthog-bug-radar";

async function triggerCaptureViaGithub(env, sessionId, keyTimestamp, connectionId, taskIndex) {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${CAPTURE_REPO}/actions/workflows/capture-screenshot.yml/dispatches`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.GITHUB_TOKEN}`,
          accept: "application/vnd.github+json",
          "content-type": "application/json",
          "user-agent": "bug-radar-worker",
        },
        body: JSON.stringify({
          ref: "main",
          inputs: {
            session_id: sessionId,
            key_timestamp: keyTimestamp,
            connection_id: String(connectionId),
            task_index: String(taskIndex),
          },
        }),
      }
    );
    if (!res.ok) {
      console.error(`[capture] dispatch failed for ${sessionId} task ${taskIndex}: ${res.status} ${await res.text()}`);
      return;
    }
    console.log(`[capture] triggered for ${sessionId} task ${taskIndex}`);
  } catch (e) {
    console.error(`[capture] WARNING: could not trigger for ${sessionId} task ${taskIndex}: ${e.message}`);
  }
}
```

This must never throw — a capture-dispatch failure must not fail the pipeline run, matching `bug_radar.py`'s `trigger_capture` (which also only logs, never raises).

- [ ] **Step 3: Add `runPipelineForConnection`**

Add after `triggerCaptureViaGithub`. This is the JS port of `bug_radar.py`'s `main()` body, minus argparse/keychain (connection comes in as an argument, not fetched over HTTP — this runs in-process now), minus the CLI's `--session-id` targeted-run branch handled separately in Step 3b below:

```js
const PIPELINE_MACRO_WINDOW = "14 DAY";
const PIPELINE_MICRO_WINDOW = "3 DAY";
const PIPELINE_SESSION_WINDOW = "4 DAY"; // micro window + 1 day, matches bug_radar.py's session_window default

async function runPipelineForConnection(env, conn) {
  // Heartbeat: stamp last_pipeline_run_at BEFORE doing any real work, matching
  // bug_radar.py's /touch call. Without this, a run that takes longer than one
  // 5-minute cron tick would still show as "due" to the next tick (computeDue
  // only sees the final post-completion timestamp otherwise), causing the same
  // connection to be picked up and run twice concurrently.
  await env.DB.prepare("UPDATE connections SET last_pipeline_run_at = datetime('now') WHERE id = ?").bind(conn.id).run();

  const region = conn.region;
  const projectId = conn.project_id;
  const apiKey = await decryptSecret(env, conn.encrypted_api_key, conn.iv);
  const identity = {
    email: conn.identity_email_prop,
    name: conn.identity_name_prop,
    role: conn.identity_role_prop,
  };
  const customEvents = (conn.config_json ? JSON.parse(conn.config_json) : {}).customEvents || [];
  const sessionLimit = conn.sync_max_sessions || 8;

  const companyRow = await env.DB.prepare("SELECT description FROM company_knowledge WHERE owner_email = ?").bind(conn.owner_email).first();
  const companyContext = companyRow?.description || "No company description saved yet — treat this as a generic web product.";

  const { results: goalRows } = await env.DB.prepare("SELECT id, purpose, description, tags FROM goals WHERE owner_email = ? ORDER BY id").bind(conn.owner_email).all();
  const goals = goalRows.map(g => ({ ...g, tags: JSON.parse(g.tags || "[]") }));
  const goalsContext = goals.length
    ? JSON.stringify(goals.map(g => ({ id: g.id, purpose: g.purpose, description: g.description, tags: g.tags })))
    : "(none yet — every task in this run should propose a new_goal)";

  const { results: tagRows } = await env.DB.prepare("SELECT id, label FROM tags WHERE owner_email = ? ORDER BY id").bind(conn.owner_email).all();
  const tagsContext = tagRows.length
    ? JSON.stringify(tagRows.map(t => ({ id: t.id, label: t.label })))
    : "(none yet — propose a new_tag for any task that clearly needs one)";

  const aiConfig = await resolveAiConfig(env, conn.owner_email);
  console.log(`[llm] routing through ${aiConfig.provider} / ${aiConfig.model} for ${conn.owner_email}`);
  console.log(`[connection] #${conn.id} ${conn.project_name} (${region}) owner=${conn.owner_email}`);

  const clusters = await fetchMacroClusters(region, apiKey, projectId, PIPELINE_MACRO_WINDOW, 25);
  const themePrompt = themePromptFor(companyContext, JSON.stringify(clusters));
  const themes = await callLlm(themePrompt, aiConfig);

  const candidates = await fetchCandidateSessions(region, apiKey, projectId, PIPELINE_MICRO_WINDOW, sessionLimit, identity);

  const findings = [];
  const pendingCaptures = [];
  for (const c of candidates) {
    const sid = c.session_id;
    const events = await fetchSessionEvents(region, apiKey, projectId, sid, PIPELINE_SESSION_WINDOW, customEvents);
    if (!events.length) continue;
    const sessionPrompt = sessionPromptFor(companyContext, goalsContext, tagsContext, JSON.stringify(events));
    const result = await callLlm(sessionPrompt, aiConfig);
    const finding = {
      session_id: sid,
      replay_url: `${PH_REGIONS[region]}/project/${projectId}/replay/${sid}`,
      started_at: c.started_at,
      person: { person_id: c.person_id, email: c.email, name: c.name, role: c.role },
      triage_counts: { dead_clicks: c.dead_clicks, rage_clicks: c.rage_clicks, exceptions: c.exceptions },
      events,
      tasks: result.tasks || [],
      recommended_outreach: result.recommended_outreach || null,
    };
    (finding.tasks || []).forEach((task, idx) => {
      if (task.outcome === "blocked" || task.severity === "high") {
        pendingCaptures.push([sid, task.key_timestamp || c.started_at, idx]);
      }
    });
    findings.push(finding);
  }

  const generatedAt = new Date().toISOString();
  const sessionPromptSample = sessionPromptFor(companyContext, goalsContext, tagsContext, "<per-session events>");
  await saveGeneratedReport(env, {
    ownerEmail: conn.owner_email,
    connectionId: conn.id,
    generatedAt,
    macroThemes: themes,
    microFindings: findings,
    themePrompt,
    sessionPrompt: sessionPromptSample,
    captureCount: pendingCaptures.length,
    triggerLabel: "scheduled",
  });

  for (const [sid, keyTs, idx] of pendingCaptures) {
    await triggerCaptureViaGithub(env, sid, keyTs, conn.id, idx);
  }

  const totalTasks = findings.reduce((n, f) => n + f.tasks.length, 0);
  const realBugs = findings.reduce((n, f) => n + f.tasks.filter(t => t.real_bug).length, 0);
  console.log(`[done] connection #${conn.id}: ${themes.length} macro themes, ${findings.length} sessions -> ${totalTasks} tasks, ${realBugs} real bugs`);
  return { themes: themes.length, sessions: findings.length, tasks: totalTasks, real_bugs: realBugs };
}
```

- [ ] **Step 3b: Add the targeted-session variant, `runPipelineForConnectionTargeted`**

This is the in-process replacement for `bug_radar.py --session-id ...` (skips macro pass and candidate selection, fetches specific sessions, merges into the existing report rather than replacing it). Add directly after `runPipelineForConnection`:

```js
async function runPipelineForConnectionTargeted(env, conn, sessionIds) {
  const region = conn.region;
  const projectId = conn.project_id;
  const apiKey = await decryptSecret(env, conn.encrypted_api_key, conn.iv);
  const identity = {
    email: conn.identity_email_prop,
    name: conn.identity_name_prop,
    role: conn.identity_role_prop,
  };
  const customEvents = (conn.config_json ? JSON.parse(conn.config_json) : {}).customEvents || [];

  const companyRow = await env.DB.prepare("SELECT description FROM company_knowledge WHERE owner_email = ?").bind(conn.owner_email).first();
  const companyContext = companyRow?.description || "No company description saved yet — treat this as a generic web product.";

  const { results: goalRows } = await env.DB.prepare("SELECT id, purpose, description, tags FROM goals WHERE owner_email = ? ORDER BY id").bind(conn.owner_email).all();
  const goals = goalRows.map(g => ({ ...g, tags: JSON.parse(g.tags || "[]") }));
  const goalsContext = goals.length
    ? JSON.stringify(goals.map(g => ({ id: g.id, purpose: g.purpose, description: g.description, tags: g.tags })))
    : "(none yet — every task in this run should propose a new_goal)";

  const { results: tagRows } = await env.DB.prepare("SELECT id, label FROM tags WHERE owner_email = ? ORDER BY id").bind(conn.owner_email).all();
  const tagsContext = tagRows.length
    ? JSON.stringify(tagRows.map(t => ({ id: t.id, label: t.label })))
    : "(none yet — propose a new_tag for any task that clearly needs one)";

  const aiConfig = await resolveAiConfig(env, conn.owner_email);
  const candidates = await fetchSessionsById(region, apiKey, projectId, sessionIds, identity, 30);

  const findings = [];
  const pendingCaptures = [];
  for (const c of candidates) {
    const sid = c.session_id;
    const events = await fetchSessionEvents(region, apiKey, projectId, sid, "30 DAY", customEvents);
    if (!events.length) continue;
    const sessionPrompt = sessionPromptFor(companyContext, goalsContext, tagsContext, JSON.stringify(events));
    const result = await callLlm(sessionPrompt, aiConfig);
    const finding = {
      session_id: sid,
      replay_url: `${PH_REGIONS[region]}/project/${projectId}/replay/${sid}`,
      started_at: c.started_at,
      person: { person_id: c.person_id, email: c.email, name: c.name, role: c.role },
      triage_counts: { dead_clicks: c.dead_clicks, rage_clicks: c.rage_clicks, exceptions: c.exceptions },
      events,
      tasks: result.tasks || [],
      recommended_outreach: result.recommended_outreach || null,
    };
    (finding.tasks || []).forEach((task, idx) => {
      if (task.outcome === "blocked" || task.severity === "high") {
        pendingCaptures.push([sid, task.key_timestamp || c.started_at, idx]);
      }
    });
    findings.push(finding);
  }

  const sessionPromptSample = sessionPromptFor(companyContext, goalsContext, tagsContext, "<per-session events>");
  const goalsResult = await resolveGoals(env, conn.owner_email, findings);
  const tagsResult = await resolveTags(env, conn.owner_email, goalsResult.findings);
  const resolvedFindings = tagsResult.findings;

  const base = await env.DB.prepare("SELECT * FROM reports WHERE owner_email = ? ORDER BY id DESC LIMIT 1").bind(conn.owner_email).first();
  const baseMicro = base ? JSON.parse(base.micro_findings) : [];
  const baseMacro = base ? JSON.parse(base.macro_themes) : [];
  const bySession = new Map(baseMicro.map(f => [f.session_id, f]));
  for (const f of resolvedFindings) {
    const old = bySession.get(f.session_id);
    if (old) {
      (old.tasks || []).forEach((oldTask, i) => {
        const userTags = (oldTask.tags || []).filter(tg => tg.assign === "user");
        if (userTags.length && f.tasks && f.tasks[i]) {
          const newTask = f.tasks[i];
          newTask.tags = newTask.tags || [];
          for (const ut of userTags) {
            if (!newTask.tags.some(tg => tg.tag_id === ut.tag_id)) newTask.tags.push(ut);
          }
        }
      });
    }
    bySession.set(f.session_id, f);
  }
  const mergedMicro = Array.from(bySession.values());
  await env.DB.prepare(
    `INSERT INTO reports (generated_at, macro_themes, micro_findings, theme_prompt, session_prompt, owner_email, connection_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    new Date().toISOString(), JSON.stringify(baseMacro), JSON.stringify(mergedMicro),
    base ? base.theme_prompt : null, sessionPromptSample, conn.owner_email, conn.id
  ).run();
  await env.DB.prepare("UPDATE connections SET last_pipeline_run_at = datetime('now') WHERE id = ?").bind(conn.id).run();
  const taskCount = resolvedFindings.reduce((n, f) => n + (f.tasks || []).length, 0);
  const realBugCount = resolvedFindings.reduce((n, f) => n + (f.tasks || []).filter(t => t.real_bug).length, 0);
  const outreachCount = resolvedFindings.filter(f => f.recommended_outreach).length;
  await logConnectionEvent(
    env, conn.id, "sync_completed", "success", "Sync completed",
    `Pulled ${resolvedFindings.length} sessions · ${taskCount} tasks · ${realBugCount} real bugs · ${outreachCount} outreach · ${goalsResult.count} new goals · ${tagsResult.count} new tags · ${pendingCaptures.length} moments queued.`,
    "manual · targeted"
  );
  await postSlackNotifications(env, conn.owner_email, resolvedFindings);

  for (const [sid, keyTs, idx] of pendingCaptures) {
    await triggerCaptureViaGithub(env, sid, keyTs, conn.id, idx);
  }
  return { sessions: resolvedFindings.length, tasks: taskCount, real_bugs: realBugCount };
}
```

- [ ] **Step 4: Wrap both runners with the same error handling `bug_radar.py`'s `main()` had**

Add this small wrapper directly after `runPipelineForConnectionTargeted` — both the scheduled handler and the admin route call this, not the raw runners directly, so error logging is in exactly one place:

```js
async function runPipelineSafely(env, conn, sessionIds) {
  try {
    const result = sessionIds
      ? await runPipelineForConnectionTargeted(env, conn, sessionIds)
      : await runPipelineForConnection(env, conn);
    return { ok: true, ...result };
  } catch (e) {
    console.error(`ERROR: pipeline run failed for connection ${conn.id}: ${e.message}`);
    await logConnectionEvent(env, conn.id, "sync_failed", "error", "Sync failed", e.message || "Unknown error", sessionIds ? "manual · targeted" : "scheduled").catch(() => {});
    return { ok: false, error: e.message };
  }
}
```

- [ ] **Step 5: Add the `scheduled()` export**

At the very end of the file, `export default { async fetch(request, env) { ... } }` currently closes the object after the `fetch` method. Change it to export both `fetch` and a new `scheduled` method on the same default-export object:

```js
export default {
  async fetch(request, env) {
    /* ... existing body, unchanged ... */
  },

  async scheduled(event, env, ctx) {
    const { results: rows } = await env.DB.prepare(
      `SELECT c.*, cc.config_json FROM connections c LEFT JOIN connection_config cc ON cc.connection_id = c.id`
    ).all();
    const due = rows.filter(r => computeDue(r.sync_freq, r.last_pipeline_run_at));
    console.log(`[scheduled] ${due.length}/${rows.length} connection(s) due`);
    for (const conn of due) {
      await runPipelineSafely(env, conn, null);
    }
  },
};
```

Do this as a surgical edit: find the line `export default {` and the `async fetch(request, env) {` line, leave the entire existing `fetch` method body untouched, and add the `scheduled` method as a sibling after `fetch`'s closing brace (before the final `};` that closes the default export object).

- [ ] **Step 6: Add the admin run-now debug route**

Inside the existing `fetch` handler, near the other `pipelineAuthed`-gated routes (right after the `/api/pipeline/connections/:id` GET handler is a natural spot), add:

```js
    const runNowMatch = pathname.match(/^\/api\/admin\/connections\/(\d+)\/run-now$/);
    if (runNowMatch && request.method === "POST") {
      if (!pipelineAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      const id = Number(runNowMatch[1]);
      const conn = await env.DB.prepare(
        `SELECT c.*, cc.config_json FROM connections c LEFT JOIN connection_config cc ON cc.connection_id = c.id WHERE c.id = ?`
      ).bind(id).first();
      if (!conn) return json({ error: "not found" }, 404);
      const body = await request.json().catch(() => ({}));
      const sessionIds = Array.isArray(body.session_ids) && body.session_ids.length ? body.session_ids : null;
      const result = await runPipelineSafely(env, conn, sessionIds);
      return json(result, result.ok ? 200 : 500);
    }
```

- [ ] **Step 7: Add the Cron Trigger to `wrangler.jsonc`**

Modify `worker/wrangler.jsonc` — add a `triggers` key as a sibling of `vars` (after the closing `}` of the `"vars"` object, before the file's final closing `}`):

```json
  "triggers": { "crons": ["*/5 * * * *"] },
```

- [ ] **Step 8: Verify**

Run: `node --check worker/src/index.js`
Expected: no output, exit code 0.

Run: `cat worker/wrangler.jsonc` and confirm the `triggers` key is present and the file is still valid JSON (`node -e "require('./worker/wrangler.jsonc')"` will fail on JSONC comments if any exist — instead use `node -e "JSON.parse(require('fs').readFileSync('worker/wrangler.jsonc','utf8').replace(/\/\/.*$/gm,''))"` to confirm it parses once comments are stripped, or just visually confirm brace balance since this file has none of its own comments today).

Do NOT run `wrangler deploy` or `wrangler secret put` in this task — deployment and the `GITHUB_TOKEN` secret are handled by the plan owner directly after this task's review, not by the implementer (this avoids any subagent needing production credentials).

```bash
git add worker/src/index.js worker/wrangler.jsonc
git commit -m "feat: pipeline runner, scheduled handler, GitHub dispatch, admin run-now route"
```

---

### Task 4: Remove bug_radar.py and update stale references

**Files:**
- Delete: `bug_radar.py`
- Modify: `requirements.txt`
- Modify: `worker/public/index.html` (PIPELINE info table copy)

**Interfaces:**
- Consumes: nothing (cleanup-only task, no new interfaces)
- Produces: nothing consumed by later tasks (this is the last task)

- [ ] **Step 1: Delete the Python pipeline script**

```bash
git rm bug_radar.py
```

- [ ] **Step 2: Trim `requirements.txt`**

Replace the full file contents with:

```
requests>=2.31
playwright>=1.45
```

(Drops `anthropic`, `openai`, `google-genai` — only `capture_screenshot.py` uses this file now, and it needs just `requests` + `playwright`.)

- [ ] **Step 3: Update the dashboard's static PIPELINE info table**

In `worker/public/index.html`, find the `PIPELINE` array (currently around line 483):

```js
const PIPELINE = [
  ["Status", "scheduled batch pipeline"],
  ["Data source", "PostHog · project 253183 (dreamteam)"],
  ["Signals", "$dead_click · $rageclick · $exception (events only, no session video)"],
  ["Macro lookback", "14 days"],
  ["Micro lookback", "3 days"],
  ["Sessions per run", "8 (worst dead + rage×3 + exceptions×5)"],
  ["LLM", "claude CLI · subscription login, not metered API credits"],
  ["Store", "Cloudflare Worker + D1"],
];
```

Change the `"Status"` and `"LLM"` rows (leave the rest untouched):

```js
const PIPELINE = [
  ["Status", "runs automatically on a Cloudflare Cron Trigger, per-connection cadence"],
  ["Data source", "PostHog · project 253183 (dreamteam)"],
  ["Signals", "$dead_click · $rageclick · $exception (events only, no session video)"],
  ["Macro lookback", "14 days"],
  ["Micro lookback", "3 days"],
  ["Sessions per run", "8 (worst dead + rage×3 + exceptions×5)"],
  ["LLM", "provider API (Anthropic / OpenAI / Gemini, per-tenant, set in Admin > AI Providers)"],
  ["Store", "Cloudflare Worker + D1"],
];
```

- [ ] **Step 4: Verify full removal**

```bash
git grep -n "bug_radar" -- '*.py' '*.yml' '*.js' '*.html'
```
Expected: no matches (a hit anywhere means a stale reference was missed).

```bash
cat requirements.txt
```
Expected: exactly `requests>=2.31` and `playwright>=1.45`, nothing else.

```bash
git add -A
git commit -m "chore: remove bug_radar.py, its deps, and stale dashboard copy — superseded by the in-worker scheduled pipeline"
```

---

## Post-plan steps (done by the plan owner, not a subagent — production secrets)

These are NOT implementer tasks. After Task 4's review is clean:

1. Set the new Worker secret from the already-authenticated `gh` CLI token (no new PAT needs to be created):
   `gh auth token | wrangler secret put GITHUB_TOKEN` (run from `worker/`).
2. `wrangler deploy` from `worker/`.
3. Retrieve `BUGRADAR_API_SECRET` from Keychain and curl `POST /api/admin/connections/:id/run-now` against the real `dreamteam` connection to verify a live end-to-end run (report saved, `last_pipeline_run_at` updated, any blocked/high-severity task triggers a real `capture-screenshot.yml` dispatch — confirm via `gh run list`).
4. Wait for one real Cron Trigger tick (≤5 min) against a connection whose `last_pipeline_run_at` is old enough to be due, and confirm it ran with zero manual intervention.
5. Force one deliberate failure (e.g. temporarily point a test connection at an invalid project_id) and confirm a `sync_failed` event appears with a real error message, matching the old Python `except` block's behavior.
