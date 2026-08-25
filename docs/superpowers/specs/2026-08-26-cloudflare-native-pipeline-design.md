# Cloudflare-native scheduled pipeline — design

## Context

`bug_radar.py` is a local Python script that must be invoked by hand (or by a
process with a live `claude` CLI login) to pull PostHog sessions, run them
through an LLM, and push a report to the `worker`. Nothing currently invokes
it on a schedule — the "scheduled batch pipeline" label on the dashboard
describes an intent, not a running system. Per-connection cadence
(`sync_freq`, `sync_max_sessions`, `computeDue()`) already exists in the
schema and is already user-editable from Settings > Connections; it has just
never had an executor wired to it.

Decisions already made (this conversation):
- Always call provider APIs directly. Drop the "try local `claude` CLI
  session first, fall back to API" path entirely — automated runs never
  have access to a logged-in CLI session anyway, so the fallback design was
  never reachable from an automated context. Removing it means every LLM
  call is a plain HTTPS request, which removes the only reason this needed
  to run outside Cloudflare.
- Lean on Cloudflare as much as possible: the scheduled pipeline runs
  natively inside the `worker` on a Cron Trigger, not on an external
  scheduler. GitHub Actions stays only for `capture-screenshot.yml`
  (screenshot capture genuinely needs a real browser — Workers can't run
  Playwright).
- Fully remove `bug_radar.py`. No dual-maintenance of a Python and a JS
  version of the same pipeline.

## Architecture

```
Cloudflare Cron Trigger (*/5 * * * *)
        │
        ▼
scheduled(event, env, ctx)  [worker/src/index.js]
        │  query connections, filter by computeDue(sync_freq, last_pipeline_run_at)
        ▼
runPipelineForConnection(env, conn)   — one call per due connection, sequential
        │
        ├─ fetchMacroClusters()/fetchCandidateSessions()/fetchSessionEvents()  → hogqlPost() [existing]
        ├─ callLlm(prompt, aiConfig) → callAnthropicLlm / callOpenaiLlm / callGeminiLlm (fetch, no SDK)
        ├─ saveGeneratedReport()  → shared with the existing POST /api/report handler
        ├─ triggerCaptureViaGithub()  → GitHub REST API (dispatches capture-screenshot.yml)
        └─ on error → logConnectionEvent(..., "sync_failed", ...)   [existing, unchanged]
```

`/api/pipeline/*` HTTP routes (connections, company-knowledge, goals, tags,
ai-config, report/merge, media, touch, sync-failed) stay exactly as they are
— `capture_screenshot.py` still uses `/api/pipeline/media`, and
`/api/pipeline/report/merge` remains available for manual/targeted debugging
via curl (the same shape of test used to verify all three providers live).
One new debug route is added for the same purpose:
`POST /api/admin/connections/:id/run-now` (pipeline-secret authed), which
calls `runPipelineForConnection` directly and returns a summary — the
in-process replacement for what `python bug_radar.py --connection-id N` used
to do by hand.

## Provider calls (raw `fetch`, no SDK)

Workers don't need (and shouldn't add) the `anthropic`/`openai`/`google-genai`
npm SDKs for this — each provider's REST endpoint is a single POST:

- **Anthropic**: `POST https://api.anthropic.com/v1/messages`, headers
  `x-api-key`, `anthropic-version: 2023-06-01`, body
  `{model, max_tokens: 16000, messages: [{role:"user", content: prompt}]}`.
  Response text is `data.content.filter(b => b.type === "text").map(b =>
  b.text).join("")`.
- **OpenAI**: `POST https://api.openai.com/v1/chat/completions`, `Bearer`
  auth, body `{model, messages: [{role:"user", content: prompt}]}`. Response
  text is `data.choices[0].message.content`.
- **Gemini**: `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={apiKey}`,
  body `{contents: [{parts: [{text: prompt}]}]}`. Response text is
  `data.candidates[0].content.parts.map(p => p.text).join("")`.

All three use `fetch(url, {..., signal: AbortSignal.timeout(120000)})` — the
120s timeout that fixed the live Gemini-hang bug carries over unchanged (it
was never CLI-specific). All three responses go through the same
`parseLlmJson(text)` fence-stripping helper `bug_radar.py` already used
(```json fence stripped before `JSON.parse`).

`resolveAiConfig()` drops `use_session_first` from its return value —
there is no session path left to flag. `call_llm`'s provider dispatch
collapses to a straight three-way `switch` with no branch inside the
`anthropic` case.

## Prompt content

`THEME_PROMPT` and `SESSION_PROMPT` (the full goal-matching, tag-matching,
task-segmentation, outreach-conservatism prompt text in `bug_radar.py`
lines 232-366) port verbatim into JS template literals. No wording changes
— this prompt was tuned and live-verified this session; the port must be
byte-for-byte the same instructions, only the interpolation syntax changes
(Python `.format()` → JS template literal `${}`).

## HogQL fetch functions

`fetchMacroClusters`, `fetchCandidateSessions`, `fetchSessionEvents` port
directly from `bug_radar.py`'s `fetch_macro_clusters` /
`fetch_candidate_sessions` / `fetch_session_events` — same HogQL query
strings, same column shapes — calling the existing `hogqlPost(region,
apiKey, projectId, query)` helper instead of a bespoke `requests.post` +
manual retry loop. `hogqlPost` doesn't currently retry on 5xx the way
Python's `hogql(..., retries=3)` did; add that retry loop to
`hogqlPost` itself (2s/4s/6s backoff, matching the Python version) since
every caller benefits, not just the new pipeline path.

## Report save path

Factor the D1-write body of the existing `POST /api/report` handler (goal
resolution, tag resolution, report insert, `last_pipeline_run_at` update,
event log, Slack notification — lines ~688-724 of `worker/src/index.js`)
into a shared `saveGeneratedReport(env, { ownerEmail, connectionId, report,
themePrompt, sessionPromptSample, captureCount })` function. Both the
existing HTTP handler and the new scheduled path call it — no duplicated
D1-write logic between "report pushed over HTTP" and "report generated
in-process."

## Screenshot capture dispatch

`trigger_capture()` in Python shelled out to `gh workflow run`. The Worker
can't spawn a subprocess, so this becomes a direct GitHub REST API call:

```
POST https://api.github.com/repos/shubhamvishnu/posthog-bug-radar/actions/workflows/capture-screenshot.yml/dispatches
Authorization: Bearer ${env.GITHUB_TOKEN}
Accept: application/vnd.github+json
body: { ref: "main", inputs: { session_id, key_timestamp, connection_id: String(connectionId), task_index: String(taskIndex) } }
```

Fire-and-forget, wrapped in try/catch that only logs — a failed dispatch
must never fail the pipeline run, exactly matching the Python version's
behavior. `GITHUB_TOKEN` is a new Worker secret: the existing `gh` CLI on
this machine is already authenticated with a fine-grained PAT scoped to
this repo (confirmed via `gh auth status`), so the secret is set by piping
`gh auth token` into `wrangler secret put GITHUB_TOKEN` — no new PAT needs
to be created by hand.

## Scheduling

`worker/wrangler.jsonc` gains:
```json
"triggers": { "crons": ["*/5 * * * *"] }
```
Five minutes matches the finest existing `sync_freq` option ("5m") — a
connection set to the shortest cadence should actually be checked that
often, not silently rounded up to whatever the cron happens to be. The
`scheduled()` handler queries all connections, keeps the ones where
`computeDue(sync_freq, last_pipeline_run_at)` is true (the exact same
function already used by the connections list routes), and runs them
**sequentially** (not `Promise.all`) — this pipeline already makes several
LLM calls per connection; overlapping multiple tenants' D1 writes and LLM
calls in one 5-minute tick is unnecessary risk for a tool with a small
number of tenants, and sequential execution means one tenant's failure
can't corrupt another's report write. A single Cron Trigger invocation has
its own wall-clock budget; if the due-connection count ever grows large
enough to matter, that's a future problem, not one to design around now.

## Removed

- `bug_radar.py` — deleted entirely.
- `requirements.txt` — drop `anthropic`, `openai`, `google-genai` (only
  `capture_screenshot.py` uses this file now, which needs `requests` and
  `playwright` only).
- The "claude CLI · subscription login" line in the dashboard's static
  `PIPELINE` info table (`worker/public/index.html`) — no longer true,
  update the "LLM" row to describe the API-only, Cloudflare-native design.

## Verification plan

1. `wrangler deploy` the worker with the new code; confirm the cron trigger
   is registered (`wrangler triggers` / deploy output lists it).
2. Curl `POST /api/admin/connections/:id/run-now` against the real
   `dreamteam` connection (pipeline-secret authed) and confirm a real
   report is produced and pushed — same live-verification bar as the
   3-provider test from earlier tonight, but through the new code path
   instead of `bug_radar.py`.
3. Confirm `last_pipeline_run_at` updates in D1 after that run.
4. Confirm a `sync_failed` event is logged correctly if a deliberately
   broken run is forced (e.g. temporarily-invalid HogQL) — error handling
   parity with the Python version's `except` block.
5. Confirm the GitHub dispatch actually fires for a task with
   `outcome: "blocked"` or `severity: "high"` — check `gh run list` for a
   new `capture-screenshot.yml` run right after the manual trigger.
6. Wait for one real Cron Trigger tick (≤5 min) and confirm it runs
   automatically with no manual trigger, end to end, against a connection
   whose `last_pipeline_run_at` is old enough to be due.
7. Confirm `git grep -n bug_radar` and `git grep -n "google-genai\|anthropic\|openai" requirements.txt` come back empty (full removal, no stale references).
