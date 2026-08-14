# Per-Connection Sync Schedule Configuration — Design

## Context

Today every customer (connection) is analyzed the same way: `bug_radar.py --connection-id N` pulls the 8 worst sessions from the last 3 days and generates verdicts, whenever a human (or the spare-laptop `run_all.sh` wrapper) chooses to run it. There is no per-customer control over *how often* their data gets analyzed or *how many* sessions get pulled per run.

This adds that control: each connection gets its own sync frequency and max-sessions-per-sync, configurable from the Connections settings tab, following the "SYNC SETTINGS" UI pattern from the `Signularity.dc.html` Claude Design reference (project `5f710252-b5a0-4483-bbf1-26f26db08f02`).

## Goals

- A customer (or the operator, on their behalf) can pick how often their PostHog sessions get pulled and analyzed, and how many sessions per run.
- The runner (`run_all.sh`, on the spare-laptop launchd job) only actually runs the expensive pipeline for connections that are currently due — not every connection, every tick.
- The "next sync" and "due" computation lives in one place (the Worker), not duplicated between the frontend display and the Python runner.

## Non-goals

- Changing the macro/micro lookback windows (14 days / 3 days) — out of scope, not requested.
- Supporting schedules finer than 5 minutes or coarser than weekly.
- Multi-machine / horizontally-scaled runners — this design supports it naturally (any runner can poll "what's due"), but only one runner (the spare laptop) exists today.

## Value ranges (confirmed with user)

- **Sync frequency**: `5m` (Every 5 min), `30m` (Every 30 min), `1h` (Hourly), `6h` (Every 6 hrs), `12h` (Every 12 hrs), `1d` (Daily), `7d` (Weekly). Default: `1d`.
- **Max sessions per sync**: `8`, `20`, `50`, `100`. Default: `8` (matches today's hardcoded default, so existing connections behave identically until someone changes it).

## Data model

Two new columns on `connections`:

```sql
ALTER TABLE connections ADD COLUMN sync_freq TEXT NOT NULL DEFAULT '1d';
ALTER TABLE connections ADD COLUMN sync_max_sessions INTEGER NOT NULL DEFAULT 8;
ALTER TABLE connections ADD COLUMN last_pipeline_run_at TEXT;
```

**Why a new `last_pipeline_run_at`, not reusing `last_synced_at`:** `last_synced_at` already exists and is updated by the `/resync` route (line 690 in `worker/src/index.js`) — a manual "test this connection's credentials still work" health check, unrelated to whether `bug_radar.py` actually ran a pipeline pass. Reusing it for the "due" clock would mean clicking "Re-sync" resets a customer's schedule without a real pipeline run ever happening — a real bug, not a style preference. `last_pipeline_run_at` is a separate, purpose-built column, `NULL` until the first successful pipeline push, distinct from the health-check timestamp.

A connection is **due** when `last_pipeline_run_at IS NULL` (never run yet — always due, don't make a new customer wait a full cycle for their first analysis) OR `now >= last_pipeline_run_at + sync_freq`.

## Worker changes (`worker/src/index.js`)

1. **`GET /api/pipeline/connections`** (used by the runner): add a `due` boolean and `sync_max_sessions` to each row in the response, computed server-side from `last_pipeline_run_at` + `sync_freq`. The runner filters on `due === true` and reads `sync_max_sessions` to build its `bug_radar.py` invocation.
2. **New: `PATCH /api/connections/:id/sync-settings`** (session-authed, same `getSessionEmail` + ownership-check pattern as the existing `/api/connections/:id/identity` route): body `{ sync_freq, sync_max_sessions }`, validates against the fixed value lists above, updates the two columns.
3. **Fix: `POST /api/report` and `POST /api/pipeline/report/merge`** (the two report-push routes) now also set `last_pipeline_run_at = datetime('now')` on the connection row after a successful push — this is the "due" clock's actual heartbeat, and today nothing sets it.
4. A small shared helper, `computeDue(syncFreq, lastPipelineRunAt)`, used by both the `/api/pipeline/connections` response and (for display) the session-authed `/api/connections` response, so the UI's "next sync" label and the runner's `due` flag are never computed by two different formulas.

## Frontend changes (`worker/public/index.html`)

Add a "SYNC SETTINGS" section to `renderConnConfigCard`, placed after the existing feature-groups section (matching the mockup's placement), only shown for the connected/detail view (not the `summary`/first-save flow, where sync settings default to `1d`/`8` and can be changed afterward — keeps the initial connect flow unchanged):

- Two segmented-pill controls (matching the app's existing `conn-event-chip`/button styling, not the mockup's literal CSS), one for frequency, one for max sessions, using the value lists above.
- A "Next sync in ~X · up to Y sessions" summary line below both, computed from the same `due`/`sync_freq` fields the Worker already returns — no separate client-side date-math duplicate of the Worker's `computeDue`.
- A "Save" action wired to the new `PATCH /api/connections/:id/sync-settings` route, reusing the existing save-bar visual pattern (`conn-savebar`) already used elsewhere on this card.

## Runner changes

**`run_all.sh`** (lives on the spare laptop today, not yet committed to this repo — this is a good point to commit it, so it's versioned and the schedule logic isn't hand-maintained only on one machine):

```bash
#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
source venv/bin/activate

SECRET=$(security find-generic-password -s "BUGRADAR_API_SECRET" -w)
DUE=$(curl -s "https://bug-radar.shubhamvishnu.workers.dev/api/pipeline/connections" \
  -H "Authorization: Bearer $SECRET" | python3 -c "
import json, sys
for c in json.load(sys.stdin):
    if c.get('due'):
        print(c['id'], c.get('sync_max_sessions', 8))
")

if [ -z "$DUE" ]; then
  echo "$(date): nothing due, skipping."
  exit 0
fi

while read -r id sessions; do
  echo "=== connection $id (sessions=$sessions): $(date) ==="
  python3 bug_radar.py --connection-id "$id" --sessions "$sessions" || echo "WARNING: connection $id failed"
done <<< "$DUE"
```

**launchd**: since the finest allowed frequency is 5 minutes, the plist needs `StartInterval` (run every N seconds, not a single daily `StartCalendarInterval`) so a connection on a 5-minute schedule is actually caught promptly:

```xml
<key>StartInterval</key>
<integer>300</integer>
```

Each tick is cheap (one `GET /api/pipeline/connections` call) regardless of how many connections are actually due — the expensive `bug_radar.py` run only happens for connections the Worker says are due right now.

**`bug_radar.py`**: no changes needed — `--sessions` already exists as a flag (line 358, default 8); `run_all.sh` just starts passing the per-connection value instead of relying on the default.

## Verification

No unit test framework exists in this codebase (established project-wide convention) — verification is via real calls, same as every prior task in this project:

1. Migrate schema on the remote D1 database, confirm via `wrangler d1 execute ... --command "PRAGMA table_info(connections)"`.
2. Curl `PATCH /api/connections/:id/sync-settings` with a real session cookie, confirm the row updates and rejects an out-of-range value (e.g. `sync_freq: "2h"` should 400).
3. Curl `GET /api/pipeline/connections`, confirm `due` is `true` for a connection whose `last_pipeline_run_at` is NULL, and confirm it flips to `false` immediately after a real `bug_radar.py` run pushes a report (proving the report-push routes' new `last_pipeline_run_at` update actually fires).
4. Set a connection to `5m`, wait past that window, confirm `due` flips back to `true`.
5. Run `run_all.sh` for real (updated version) against the live Worker, confirm it only invokes `bug_radar.py` for due connections and passes the right `--sessions` value.
6. Playwright pass on the new Sync Settings UI: change frequency and session count, save, reload, confirm it persisted and the "next sync" label matches what the Worker computed.
