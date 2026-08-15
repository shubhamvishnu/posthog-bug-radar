# Connection Audit Log — Design

## Context

The Connections settings card shows live config state (feature groups, sync settings) but nothing about *history* — whether a sync actually ran, whether it succeeded, when settings last changed, or what a failed run's error was. This adds an "AUDIT LOG" collapsible section to each connection's detail card, following the `Signularity.dc.html` Claude Design reference (project `5f710252-b5a0-4483-bbf1-26f26db08f02`), and wires it to every real event that already happens on a connection rather than showing synthetic data.

## Goals

- Every meaningful thing that happens to a connection — established, settings changed, resynced, a real pipeline sync completed or failed — leaves a real, timestamped log entry.
- "Sync completed" entries carry real counts: sessions pulled, tasks found, real bugs flagged, outreach recommended, new goals auto-created, new tags auto-created, and screenshots captured.
- A pipeline run that throws for any reason gets reported as a failure, not silently dropped (today `bug_radar.py` has no top-level error handling — an exception just kills the process with no Worker call at all).
- Log entries are read lazily (only when the section is expanded), matching the "don't show fake empty state" and "don't fetch what isn't visible" conventions already used elsewhere in this app.

## Non-goals

- No log retention/pruning policy beyond what's cheap — entries accumulate in D1 indefinitely for now (the design mockup's "logs retained 90 days" footer text is cosmetic copy, not a real retention job — out of scope).
- No real-time push/websocket updates to the log — it's read on expand, same as every other lazy-loaded tab in this app.
- No cross-connection log view — strictly per-connection, matching the card it lives inside.

## Data model

New table:

```sql
CREATE TABLE IF NOT EXISTS connection_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT,
  trigger_label TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
```

- `kind`: `connection_established` | `settings_changed` | `resync` | `sync_completed` | `sync_failed`
- `status`: `success` | `warning` | `error` | `info` — maps directly to the design's dot colors (green / amber / red / slate)
- `trigger_label`: free text shown next to the title, e.g. `"scheduled"`, `"manual · targeted"`, `"you · shubham@dreamteam.co"` — mirrors the design mockup's `trigger` field exactly

## Write points

Five, all inside routes/code paths that already exist — no new triggers to invent:

1. **`POST /api/connections/save`** → `connection_established`, `status: success`, `trigger_label: "you · " + email`, detail: `"PostHog project \"{projectName}\" linked."`
2. **`POST /api/connections/:id/sync-settings`** → `settings_changed`, `status: info`, `trigger_label: "you · " + email`, detail: `"Sync frequency set to {freq} · max sessions set to {max}."`
3. **`POST /api/connections/:id/resync`** → both branches of the existing try/catch: success → `resync`, `status: success`, detail includes the discovered project name; failure → `resync`, `status: error`, detail = the caught error message. `trigger_label: "you · " + email` either way.
4. **`POST /api/report` and `POST /api/pipeline/report/merge`** (only when `connection_id`/`body.connection_id` is present — both already gate their `last_pipeline_run_at` update the same way) → `sync_completed`, `status: success`, `trigger_label`: `"scheduled"` for `POST /api/report` (the full pipeline run), `"manual · targeted"` for `POST /api/pipeline/report/merge` (a `--session-id` run). Detail is built from real counts:
   `"Pulled {N} sessions · {taskCount} tasks · {realBugCount} real bugs · {outreachCount} outreach · {newGoalCount} new goals · {newTagCount} new tags · {captureCount} moments captured."`
   - `newGoalCount`/`newTagCount` come from `resolveGoals`/`resolveTags`, which need a small return-shape change (see Worker changes below).
   - `captureCount` comes from the push body: `bug_radar.py` already knows `len(pending_captures)` synchronously, right after a successful push and before it actually dispatches them — it passes this as `capture_count` in the push body so the log write (which happens inside the same request) can include the real number without a follow-up call.
5. **New: `POST /api/pipeline/connections/:id/sync-failed`** (pipeline-authed) → `sync_failed`, `status: error`, `trigger_label: "scheduled"`, detail = the caught exception's message. Called from a new top-level `try/except` in `bug_radar.py`'s `main()`, wrapping everything from `conn = fetch_connection(...)` onward — today an unhandled exception there just kills the process with nothing recorded anywhere.

## Worker changes (`worker/src/index.js`)

1. **Migration**: `connection_events` table (same startup pattern as every other table).
2. **`logConnectionEvent(env, connectionId, kind, status, title, detail, triggerLabel)`**: one small helper, a single `INSERT`, called from all five write points above.
3. **`resolveGoals`/`resolveTags` return-shape change**: both currently return just the mutated `findings` array. Change each to return `{ findings, count }` (`count` = the number of genuinely new rows created this call — `resolveGoals`'s `createdThisBatch.size`, `resolveTags`'s equivalent). Update the two call sites (`POST /api/report`, `POST /api/pipeline/report/merge`) to sequence the calls explicitly instead of chaining them inline, so both counts are available for the log write:
   ```js
   const goalsResult = await resolveGoals(env, ownerEmail, body.micro_findings || []);
   const tagsResult = await resolveTags(env, ownerEmail, goalsResult.findings);
   const resolvedFindings = tagsResult.findings;
   ```
4. **New: `GET /api/connections/:id/events?limit=20`** (session-authed, ownership-checked) — returns the connection's most recent events, newest first.
5. **New: `POST /api/pipeline/connections/:id/sync-failed`** (pipeline-authed) — body `{ error }`, logs a `sync_failed` event.

## Pipeline changes (`bug_radar.py`)

- Wrap everything in `main()` from `conn = fetch_connection(...)` to the end in a `try/except`. On any exception: `requests.post(f"{args.worker_url}/api/pipeline/connections/{conn['id']}/sync-failed", ..., json={"error": str(e)})` (best-effort — if even this fails, print a warning, don't raise a second exception), then re-raise so the process still exits non-zero (so `run_all.sh`'s existing `|| echo "WARNING: connection $id failed"` keeps working exactly as it does today).
- Include `"capture_count": len(pending_captures)` in both push bodies (`POST /api/report` and `POST /api/pipeline/report/merge`), computed right before the push (the `pending_captures` list is already fully built by then — capture dispatch itself still happens after the push succeeds, unchanged).

## Frontend changes (`worker/public/index.html`)

Add an "AUDIT LOG" section to `renderConnConfigCard`, after the existing SYNC SETTINGS section, using the same `.conn-group`/`.conn-group-btn` collapsible pattern already used for the feature-groups toggles:

- Collapsed by default. On first expand, `fetch(`/api/connections/${id}/events?limit=20`)` and cache the result in state (don't refetch on every re-render, only on first open or explicit reload).
- Each entry: colored dot (from `status`), title, `trigger_label`, detail text, relative timestamp — matches the design mockup's row layout exactly (dot · title · trigger on one line, detail below, timestamp right-aligned).
- Empty state (no events yet — a brand-new connection before its first log write, which shouldn't be possible in practice since `connection_established` writes immediately on save, but handle it defensively): "No activity yet."

## Verification

No unit test framework in this codebase — verification is real calls, matching every prior feature in this project:

1. Migrate schema on remote D1, confirm via `PRAGMA table_info(connection_events)`.
2. Save a new test connection (or use resync on the existing one), confirm a real event row appears with the right `kind`/`status`/`trigger_label`.
3. Change sync settings via the UI, confirm a `settings_changed` event with the real new values in its detail text.
4. Run `bug_radar.py` for real against the live `dreamteam` connection, confirm a `sync_completed` event appears with real counts matching that run's actual console output (sessions/tasks/bugs/outreach/goals/tags/captures).
5. Force a real failure (e.g. temporarily point `--worker-url` at an invalid host, or use a connection with a deliberately broken API key) and confirm a `sync_failed` event with a real error message, and confirm the process still exits non-zero.
6. Playwright pass: expand the AUDIT LOG section, confirm it lazy-loads (no fetch until expanded), confirm entries render in the right order with correct colors, confirm collapsing and re-expanding doesn't re-fetch.
