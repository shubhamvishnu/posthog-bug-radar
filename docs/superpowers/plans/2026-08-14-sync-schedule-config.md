# Per-Connection Sync Schedule Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each PostHog connection configure its own sync frequency and max-sessions-per-sync, and make the runner only actually run the pipeline for connections that are currently due.

**Architecture:** Two new columns on `connections` (`sync_freq`, `sync_max_sessions`) plus a new `last_pipeline_run_at` heartbeat column, distinct from the existing `last_synced_at` health-check column. The Worker computes "due" server-side (single source of truth, reused by both the UI's "next sync" label and the runner's filter) and exposes it on `GET /api/pipeline/connections`. A new session-authed save route lets the UI persist changes immediately on click, matching this codebase's existing identity-edit pattern (no separate staged "Save" button for this section). The runner (`run_all.sh`, newly committed to this repo) polls that endpoint and only invokes `bug_radar.py` for due connections, passing `--sessions` per-connection.

**Tech Stack:** Cloudflare Workers + D1 (backend), vanilla JS (frontend, `worker/public/index.html`), Python (`bug_radar.py`, unchanged; `run_all.sh`, new), macOS launchd (scheduling doc only, no code).

**Spec:** [docs/superpowers/specs/2026-08-14-sync-schedule-config-design.md](../specs/2026-08-14-sync-schedule-config-design.md)

## Global Constraints
- Sync frequency values, exactly these seven, no others: `5m`, `30m`, `1h`, `6h`, `12h`, `1d`, `7d`. Default `1d`.
- Max sessions values, exactly these four: `8`, `20`, `50`, `100`. Default `8` — matches today's hardcoded default so existing connections behave identically until someone changes them.
- `last_pipeline_run_at` is a new, separate column. Never read or write the existing `last_synced_at` column as part of this feature — that column is a manual-resync health-check timestamp (updated by the existing `/api/connections/:id/resync` route) and mixing the two would let clicking "Re-sync" silently reset a customer's due-clock without a real pipeline run happening.
- This codebase has no unit test framework anywhere (confirmed: no test files, no pytest/vitest config). Its established verification pattern is real calls against the live system: curl, `wrangler d1 execute --remote`, and Playwright-driven browser checks. This plan follows that existing pattern rather than introducing a new one.
- Follow existing code style exactly: routes are `if (pathname === ... && request.method === ...)` blocks or `pathname.match(/regex/)` blocks inside the single `fetch(request, env)` handler in `worker/src/index.js`, not a router library. Frontend uses `data-act` attributes dispatched from one global click listener, not per-element handlers.

---

## Task 1: Schema migration + server-side "due" computation

**Files:**
- Modify: `worker/schema.sql` (the `connections` table definition, lines 51-67)
- Modify: `worker/src/index.js` (add a helper near `sqliteTimeToMs`, lines 24-27; modify `GET /api/pipeline/connections`, lines 454-463; modify `GET /api/connections`, lines 663-673)

**Interfaces:**
- Produces: `computeDue(syncFreq, lastPipelineRunAt)` — returns `true`/`false`. Consumed by Task 2 (no, Task 2 doesn't need it) and by the frontend via the `due` field now present on connection objects returned by both `GET /api/pipeline/connections` and `GET /api/connections`.
- Produces: `SYNC_FREQ_MS`, `SYNC_FREQ_VALUES`, `SYNC_MAX_SESSIONS_VALUES` top-level consts in `worker/src/index.js`. Task 2's save route consumes `SYNC_FREQ_VALUES` and `SYNC_MAX_SESSIONS_VALUES` for validation.

- [ ] **Step 1: Add the three new columns to `worker/schema.sql`**

In `worker/schema.sql`, find the `connections` table (lines 51-67):

```sql
CREATE TABLE IF NOT EXISTS connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_email TEXT NOT NULL,
  region TEXT NOT NULL,
  project_id TEXT NOT NULL,
  project_name TEXT,
  timezone TEXT,
  encrypted_api_key TEXT NOT NULL,
  iv TEXT NOT NULL,
  identity_email_prop TEXT,
  identity_name_prop TEXT,
  identity_role_prop TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  last_error TEXT,
  last_synced_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
```

Replace with:

```sql
CREATE TABLE IF NOT EXISTS connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_email TEXT NOT NULL,
  region TEXT NOT NULL,
  project_id TEXT NOT NULL,
  project_name TEXT,
  timezone TEXT,
  encrypted_api_key TEXT NOT NULL,
  iv TEXT NOT NULL,
  identity_email_prop TEXT,
  identity_name_prop TEXT,
  identity_role_prop TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  last_error TEXT,
  last_synced_at TEXT,
  sync_freq TEXT NOT NULL DEFAULT '1d',
  sync_max_sessions INTEGER NOT NULL DEFAULT 8,
  last_pipeline_run_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
```

This is for fresh installs. The live production database already has this table with rows in it, so it needs a real migration too (next step).

- [ ] **Step 2: Migrate the live remote database**

```bash
cd /Users/shubhamkhandelwal/posthog-bug-radar/worker
npx wrangler d1 execute bug-radar-db --remote --command "ALTER TABLE connections ADD COLUMN sync_freq TEXT NOT NULL DEFAULT '1d'"
npx wrangler d1 execute bug-radar-db --remote --command "ALTER TABLE connections ADD COLUMN sync_max_sessions INTEGER NOT NULL DEFAULT 8"
npx wrangler d1 execute bug-radar-db --remote --command "ALTER TABLE connections ADD COLUMN last_pipeline_run_at TEXT"
npx wrangler d1 execute bug-radar-db --remote --command "PRAGMA table_info(connections)"
```

Expected: the last command's output lists all three new columns (`sync_freq`, `sync_max_sessions`, `last_pipeline_run_at`) alongside the existing ones.

- [ ] **Step 3: Add the due-computation helper and value-list consts**

In `worker/src/index.js`, right after the existing `sqliteTimeToMs` function (lines 24-27):

```javascript
function sqliteTimeToMs(sqliteText) {
  // D1's datetime('now') default returns "YYYY-MM-DD HH:MM:SS" in UTC, no timezone suffix.
  return Date.parse(sqliteText.replace(" ", "T") + "Z");
}

const SYNC_FREQ_VALUES = ["5m", "30m", "1h", "6h", "12h", "1d", "7d"];
const SYNC_MAX_SESSIONS_VALUES = [8, 20, 50, 100];
const SYNC_FREQ_MS = {
  "5m": 5 * 60 * 1000,
  "30m": 30 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "12h": 12 * 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

function computeDue(syncFreq, lastPipelineRunAt) {
  if (!lastPipelineRunAt) return true; // never run yet — always due, don't make a new customer wait a full cycle
  const freqMs = SYNC_FREQ_MS[syncFreq] || SYNC_FREQ_MS["1d"];
  return Date.now() >= sqliteTimeToMs(lastPipelineRunAt) + freqMs;
}
```

- [ ] **Step 4: Expose `due` on `GET /api/pipeline/connections`**

Find (lines 454-463):

```javascript
    if (pathname === "/api/pipeline/connections" && request.method === "GET") {
      if (!pipelineAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      const { results } = await env.DB.prepare(
        `SELECT c.id, c.owner_email, c.region, c.project_id, c.project_name, c.timezone, c.status,
                c.identity_email_prop, c.identity_name_prop, c.identity_role_prop, cc.config_json
         FROM connections c LEFT JOIN connection_config cc ON cc.connection_id = c.id
         ORDER BY c.id`
      ).all();
      return json(results.map(r => ({ ...r, config: r.config_json ? JSON.parse(r.config_json) : null, config_json: undefined })));
    }
```

Replace with:

```javascript
    if (pathname === "/api/pipeline/connections" && request.method === "GET") {
      if (!pipelineAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      const { results } = await env.DB.prepare(
        `SELECT c.id, c.owner_email, c.region, c.project_id, c.project_name, c.timezone, c.status,
                c.identity_email_prop, c.identity_name_prop, c.identity_role_prop,
                c.sync_freq, c.sync_max_sessions, c.last_pipeline_run_at, cc.config_json
         FROM connections c LEFT JOIN connection_config cc ON cc.connection_id = c.id
         ORDER BY c.id`
      ).all();
      return json(results.map(r => ({
        ...r,
        config: r.config_json ? JSON.parse(r.config_json) : null,
        config_json: undefined,
        due: computeDue(r.sync_freq, r.last_pipeline_run_at),
      })));
    }
```

- [ ] **Step 5: Expose `due` on `GET /api/connections` (session-authed, used by the frontend)**

Find (lines 663-673):

```javascript
    if (pathname === "/api/connections" && request.method === "GET") {
      const email = await getSessionEmail(request, env);
      if (!email) return json({ error: "not authenticated" }, 401);
      const { results } = await env.DB.prepare(
        `SELECT c.id, c.region, c.project_id, c.project_name, c.timezone, c.status, c.last_error, c.last_synced_at,
                c.identity_email_prop, c.identity_name_prop, c.identity_role_prop, cc.config_json
         FROM connections c LEFT JOIN connection_config cc ON cc.connection_id = c.id
         WHERE c.owner_email = ? ORDER BY c.id DESC`
      ).bind(email).all();
      return json(results.map(r => ({ ...r, config_json: undefined, config: r.config_json ? JSON.parse(r.config_json) : null })));
    }
```

Replace with:

```javascript
    if (pathname === "/api/connections" && request.method === "GET") {
      const email = await getSessionEmail(request, env);
      if (!email) return json({ error: "not authenticated" }, 401);
      const { results } = await env.DB.prepare(
        `SELECT c.id, c.region, c.project_id, c.project_name, c.timezone, c.status, c.last_error, c.last_synced_at,
                c.identity_email_prop, c.identity_name_prop, c.identity_role_prop,
                c.sync_freq, c.sync_max_sessions, c.last_pipeline_run_at, cc.config_json
         FROM connections c LEFT JOIN connection_config cc ON cc.connection_id = c.id
         WHERE c.owner_email = ? ORDER BY c.id DESC`
      ).bind(email).all();
      return json(results.map(r => ({
        ...r,
        config_json: undefined,
        config: r.config_json ? JSON.parse(r.config_json) : null,
        due: computeDue(r.sync_freq, r.last_pipeline_run_at),
      })));
    }
```

- [ ] **Step 6: Deploy and verify with real calls**

```bash
cd /Users/shubhamkhandelwal/posthog-bug-radar/worker
npx wrangler deploy
SECRET=$(security find-generic-password -s "BUGRADAR_API_SECRET" -w)
curl -s "https://bug-radar.shubhamvishnu.workers.dev/api/pipeline/connections" -H "Authorization: Bearer $SECRET" | python3 -m json.tool
```

Expected: each connection object now has `sync_freq: "1d"`, `sync_max_sessions: 8`, `last_pipeline_run_at: null`, and `due: true` (since `last_pipeline_run_at` is null for every existing connection right after the migration — everyone starts "due", which is correct: nothing has ever set this new column yet).

- [ ] **Step 7: Commit**

```bash
cd /Users/shubhamkhandelwal/posthog-bug-radar
git add worker/schema.sql worker/src/index.js
git commit -m "Add sync schedule columns and server-side due computation"
git push
```

---

## Task 2: Save route + fix the last_pipeline_run_at heartbeat

**Files:**
- Modify: `worker/src/index.js` (add a new route after the existing identity route, lines 699-710; modify `POST /api/report`, lines 424-447; modify `POST /api/pipeline/report/merge`, lines 500-527)

**Interfaces:**
- Consumes: `SYNC_FREQ_VALUES`, `SYNC_MAX_SESSIONS_VALUES` from Task 1.
- Produces: `POST /api/connections/:id/sync-settings` (session-authed, body `{ sync_freq, sync_max_sessions }`, returns `{ ok: true }` or `{ error }`). Consumed by Task 3's frontend click handlers.

- [ ] **Step 1: Add the save route**

In `worker/src/index.js`, right after the existing identity route (ends at line 710):

```javascript
    const identityMatch = pathname.match(/^\/api\/connections\/(\d+)\/identity$/);
    if (identityMatch && request.method === "POST") {
      const email = await getSessionEmail(request, env);
      if (!email) return json({ error: "not authenticated" }, 401);
      const id = Number(identityMatch[1]);
      const body = await request.json().catch(() => ({}));
      const conn = await env.DB.prepare("SELECT id FROM connections WHERE id = ? AND owner_email = ?").bind(id, email).first();
      if (!conn) return json({ error: "not found" }, 404);
      await env.DB.prepare("UPDATE connections SET identity_email_prop = ?, identity_name_prop = ?, identity_role_prop = ? WHERE id = ?")
        .bind(body.email || null, body.name || null, body.role || null, id).run();
      return json({ ok: true });
    }
```

Insert immediately after this block (same style, same ownership-check pattern):

```javascript
    const syncSettingsMatch = pathname.match(/^\/api\/connections\/(\d+)\/sync-settings$/);
    if (syncSettingsMatch && request.method === "POST") {
      const email = await getSessionEmail(request, env);
      if (!email) return json({ error: "not authenticated" }, 401);
      const id = Number(syncSettingsMatch[1]);
      const body = await request.json().catch(() => ({}));
      const syncFreq = body.sync_freq;
      const syncMaxSessions = Number(body.sync_max_sessions);
      if (!SYNC_FREQ_VALUES.includes(syncFreq) || !SYNC_MAX_SESSIONS_VALUES.includes(syncMaxSessions)) {
        return json({ error: "invalid sync_freq or sync_max_sessions" }, 400);
      }
      const conn = await env.DB.prepare("SELECT id FROM connections WHERE id = ? AND owner_email = ?").bind(id, email).first();
      if (!conn) return json({ error: "not found" }, 404);
      await env.DB.prepare("UPDATE connections SET sync_freq = ?, sync_max_sessions = ? WHERE id = ?")
        .bind(syncFreq, syncMaxSessions, id).run();
      return json({ ok: true });
    }
```

- [ ] **Step 2: Fix `POST /api/report` to update the heartbeat**

Find (lines 424-447):

```javascript
    if (pathname === "/api/report" && request.method === "POST") {
      const auth = request.headers.get("authorization") || "";
      if (auth !== `Bearer ${env.BUGRADAR_API_SECRET}`) {
        return json({ error: "unauthorized" }, 401);
      }
      const body = await request.json();
      const ownerEmail = body.owner_email || DEFAULT_OWNER_EMAIL;
      const resolvedFindings = await resolveGoals(env, ownerEmail, body.micro_findings || []);
      await env.DB.prepare(
        `INSERT INTO reports (generated_at, macro_themes, micro_findings, theme_prompt, session_prompt, owner_email, connection_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          body.generated_at,
          JSON.stringify(body.macro_themes || []),
          JSON.stringify(resolvedFindings),
          body.theme_prompt || null,
          body.session_prompt || null,
          ownerEmail,
          body.connection_id || null
        )
        .run();
      return json({ ok: true });
    }
```

Replace with (adds the `if (body.connection_id)` block right before the final `return`):

```javascript
    if (pathname === "/api/report" && request.method === "POST") {
      const auth = request.headers.get("authorization") || "";
      if (auth !== `Bearer ${env.BUGRADAR_API_SECRET}`) {
        return json({ error: "unauthorized" }, 401);
      }
      const body = await request.json();
      const ownerEmail = body.owner_email || DEFAULT_OWNER_EMAIL;
      const resolvedFindings = await resolveGoals(env, ownerEmail, body.micro_findings || []);
      await env.DB.prepare(
        `INSERT INTO reports (generated_at, macro_themes, micro_findings, theme_prompt, session_prompt, owner_email, connection_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          body.generated_at,
          JSON.stringify(body.macro_themes || []),
          JSON.stringify(resolvedFindings),
          body.theme_prompt || null,
          body.session_prompt || null,
          ownerEmail,
          body.connection_id || null
        )
        .run();
      if (body.connection_id) {
        await env.DB.prepare("UPDATE connections SET last_pipeline_run_at = datetime('now') WHERE id = ?").bind(body.connection_id).run();
      }
      return json({ ok: true });
    }
```

- [ ] **Step 3: Fix `POST /api/pipeline/report/merge` to update the heartbeat**

Find (lines 500-527):

```javascript
    if (pathname === "/api/pipeline/report/merge" && request.method === "POST") {
      if (!pipelineAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      const body = await request.json().catch(() => ({}));
      const { owner_email: ownerEmail, connection_id: connectionId, findings: newFindings, session_prompt: sessionPrompt } = body;
      if (!ownerEmail || !Array.isArray(newFindings) || !newFindings.length) {
        return json({ error: "owner_email and a non-empty findings array are required" }, 400);
      }
      const base = await env.DB.prepare("SELECT * FROM reports WHERE owner_email = ? ORDER BY id DESC LIMIT 1").bind(ownerEmail).first();
      const baseMicro = base ? JSON.parse(base.micro_findings) : [];
      const baseMacro = base ? JSON.parse(base.macro_themes) : [];
      const resolvedNewFindings = await resolveGoals(env, ownerEmail, newFindings);
      const bySession = new Map(baseMicro.map(f => [f.session_id, f]));
      for (const f of resolvedNewFindings) bySession.set(f.session_id, f);
      const mergedMicro = Array.from(bySession.values());
      await env.DB.prepare(
        `INSERT INTO reports (generated_at, macro_themes, micro_findings, theme_prompt, session_prompt, owner_email, connection_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        new Date().toISOString(),
        JSON.stringify(baseMacro),
        JSON.stringify(mergedMicro),
        base ? base.theme_prompt : null,
        sessionPrompt || (base ? base.session_prompt : null),
        ownerEmail,
        connectionId || (base ? base.connection_id : null)
      ).run();
      return json({ ok: true, merged_session_ids: newFindings.map(f => f.session_id), total_findings: mergedMicro.length });
    }
```

Replace with (introduces `resolvedConnectionId` so both the INSERT and the new UPDATE use the same resolved value):

```javascript
    if (pathname === "/api/pipeline/report/merge" && request.method === "POST") {
      if (!pipelineAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      const body = await request.json().catch(() => ({}));
      const { owner_email: ownerEmail, connection_id: connectionId, findings: newFindings, session_prompt: sessionPrompt } = body;
      if (!ownerEmail || !Array.isArray(newFindings) || !newFindings.length) {
        return json({ error: "owner_email and a non-empty findings array are required" }, 400);
      }
      const base = await env.DB.prepare("SELECT * FROM reports WHERE owner_email = ? ORDER BY id DESC LIMIT 1").bind(ownerEmail).first();
      const baseMicro = base ? JSON.parse(base.micro_findings) : [];
      const baseMacro = base ? JSON.parse(base.macro_themes) : [];
      const resolvedNewFindings = await resolveGoals(env, ownerEmail, newFindings);
      const bySession = new Map(baseMicro.map(f => [f.session_id, f]));
      for (const f of resolvedNewFindings) bySession.set(f.session_id, f);
      const mergedMicro = Array.from(bySession.values());
      const resolvedConnectionId = connectionId || (base ? base.connection_id : null);
      await env.DB.prepare(
        `INSERT INTO reports (generated_at, macro_themes, micro_findings, theme_prompt, session_prompt, owner_email, connection_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        new Date().toISOString(),
        JSON.stringify(baseMacro),
        JSON.stringify(mergedMicro),
        base ? base.theme_prompt : null,
        sessionPrompt || (base ? base.session_prompt : null),
        ownerEmail,
        resolvedConnectionId
      ).run();
      if (resolvedConnectionId) {
        await env.DB.prepare("UPDATE connections SET last_pipeline_run_at = datetime('now') WHERE id = ?").bind(resolvedConnectionId).run();
      }
      return json({ ok: true, merged_session_ids: newFindings.map(f => f.session_id), total_findings: mergedMicro.length });
    }
```

- [ ] **Step 4: Deploy and verify with real calls**

```bash
cd /Users/shubhamkhandelwal/posthog-bug-radar/worker
npx wrangler deploy
```

Verify the save route rejects an invalid value (no valid session cookie needed to prove the 401/400 path, but a real save needs one — use a browser session or skip to Task 5's Playwright check for the authenticated case; this check only proves the route exists and validates):

```bash
curl -s -w '\nHTTP_STATUS:%{http_code}\n' -X POST "https://bug-radar.shubhamvishnu.workers.dev/api/connections/1/sync-settings" \
  -H "content-type: application/json" -d '{"sync_freq":"2h","sync_max_sessions":8}'
```

Expected: `{"error":"not authenticated"}` with `HTTP_STATUS:401` (no session cookie was sent) — proves the route exists and auth-gates before validation runs. Full validation + persistence gets exercised for real in Task 5 via the browser.

Verify the heartbeat fix using the real pipeline, against the known-good connection already used throughout this project:

```bash
cd /Users/shubhamkhandelwal/posthog-bug-radar
source venv/bin/activate
SECRET=$(security find-generic-password -s "BUGRADAR_API_SECRET" -w)
BUGRADAR_API_SECRET="$SECRET" python3 bug_radar.py --connection-id 1 --session-id "019feaae-aeed-7cab-b0b7-b05e40655331"
curl -s "https://bug-radar.shubhamvishnu.workers.dev/api/pipeline/connections" -H "Authorization: Bearer $SECRET" | python3 -c "
import json, sys
for c in json.load(sys.stdin):
    if c['id'] == 1:
        print('last_pipeline_run_at:', c['last_pipeline_run_at'], '| due:', c['due'])
"
```

Expected: `last_pipeline_run_at` is now a real recent timestamp (was `null` before this run), and `due` is `false` (since `sync_freq` defaults to `1d` and the run just happened).

- [ ] **Step 5: Commit**

```bash
cd /Users/shubhamkhandelwal/posthog-bug-radar
git add worker/src/index.js
git commit -m "Add sync-settings save route, fix last_pipeline_run_at heartbeat"
git push
```

---

## Task 3: Frontend UI — Sync Settings section

**Files:**
- Modify: `worker/public/index.html` (CSS near lines 365-380; `renderConnConfigCard` and its call site near lines 1424-1554; click dispatcher near lines 1858-1911)

**Interfaces:**
- Consumes: `conn.sync_freq`, `conn.sync_max_sessions`, `conn.due` fields from Task 1's `GET /api/connections` response (already loaded into the existing `CONNECTIONS` array by `loadData()`). Consumes `POST /api/connections/:id/sync-settings` from Task 2.

- [ ] **Step 1: Add CSS for the segmented-pill controls**

In `worker/public/index.html`, right after the existing `.conn-savebar` rule (line 379):

```css
.conn-savebar{padding:16px 22px;display:flex;align-items:center;gap:12px}
```

Add immediately after:

```css
.conn-sync-settings{padding:20px 22px;border-top:1px solid var(--border-soft)}
.sync-row{display:flex;align-items:flex-start;gap:14px;margin-bottom:18px}
.sync-row:last-of-type{margin-bottom:0}
.sync-row-label{min-width:0;flex:1}
.sync-pill-group{display:inline-flex;flex-wrap:wrap;gap:4px;background:var(--bg-sub);border:1px solid var(--border);border-radius:10px;padding:3px;flex:none}
.sync-pill{padding:6px 12px;border-radius:8px;font-size:12.5px;font-weight:500;color:var(--muted);white-space:nowrap}
.sync-pill.active{font-weight:600;color:var(--text);background:var(--bg-elev);box-shadow:0 1px 2px rgba(0,0,0,.08)}
```

- [ ] **Step 2: Add the `renderSyncSettings` function**

Directly above the existing `function renderConnConfigCard(configMap, identity, opts) {` (line 1424), add:

```javascript
const SYNC_FREQ_OPTS = [["5m", "Every 5 min"], ["30m", "Every 30 min"], ["1h", "Hourly"], ["6h", "Every 6 hrs"], ["12h", "Every 12 hrs"], ["1d", "Daily"], ["7d", "Weekly"]];
const SYNC_MAX_OPTS = [8, 20, 50, 100];
const NEXT_SYNC_LABEL = { "5m": "in ~5 min", "30m": "in ~30 min", "1h": "within the hour", "6h": "in a few hours", "12h": "in up to 12 hours", "1d": "tomorrow", "7d": "next week" };

function renderSyncSettings(conn) {
  const freq = conn.sync_freq || "1d";
  const maxSessions = conn.sync_max_sessions || 8;
  const freqPills = SYNC_FREQ_OPTS.map(([v, label]) => `<button class="sync-pill${v === freq ? " active" : ""}" data-act="sync-freq-pick" data-id="${conn.id}" data-val="${v}">${label}</button>`).join("");
  const maxPills = SYNC_MAX_OPTS.map(v => `<button class="sync-pill${v === maxSessions ? " active" : ""}" data-act="sync-max-pick" data-id="${conn.id}" data-val="${v}">${v}</button>`).join("");
  const nextLabel = conn.due ? "now" : (NEXT_SYNC_LABEL[freq] || "soon");
  return `
    <div class="conn-sync-settings">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:16px">
        ${ICON_REFRESH}
        <span style="font-size:11px;font-weight:600;letter-spacing:.03em;color:var(--faint)">SYNC SETTINGS</span>
      </div>
      <div class="sync-row">
        <div class="sync-row-label">
          <div style="font-size:13.5px;font-weight:600">Sync frequency</div>
          <div style="font-size:12px;color:var(--muted);margin-top:2px;line-height:1.45">How often Bug Radar pulls new sessions from PostHog.</div>
        </div>
        <div class="sync-pill-group">${freqPills}</div>
      </div>
      <div class="sync-row">
        <div class="sync-row-label">
          <div style="font-size:13.5px;font-weight:600">Max sessions per sync</div>
          <div style="font-size:12px;color:var(--muted);margin-top:2px;line-height:1.45">Caps how many of the newest sessions are pulled each run.</div>
        </div>
        <div class="sync-pill-group">${maxPills}</div>
      </div>
      <div style="font-size:12.5px;color:var(--muted);margin-top:14px;padding-top:14px;border-top:1px solid var(--border-soft)">Next sync ${escapeHtml(nextLabel)} · up to ${maxSessions} sessions</div>
    </div>`;
}
```

`NEXT_SYNC_LABEL` is a friendly approximation keyed by frequency, not a real countdown — matching how the Signularity design mockup itself did this (a static lookup table, not live date math). The `due`/`false` boolean itself IS the real, server-computed signal; this label is just cosmetic framing around it.

- [ ] **Step 3: Wire `renderSyncSettings` into `renderConnConfigCard`**

Find the function signature and destructure (start of `renderConnConfigCard`, line 1424-1425):

```javascript
function renderConnConfigCard(configMap, identity, opts) {
  const { showSaveBar, identityEditable, onIdentityOpt } = opts;
```

Replace with:

```javascript
function renderConnConfigCard(configMap, identity, opts) {
  const { showSaveBar, identityEditable, onIdentityOpt, conn } = opts;
```

Find where `groupsHtml` is used in the returned template (search for `${groupsHtml}` — it appears once, followed by the save-bar conditional). Add `renderSyncSettings(conn)` right after it, only when `conn` was passed:

```javascript
    ${groupsHtml}
    ${conn ? renderSyncSettings(conn) : ""}
    ${showSaveBar ? `<div class="conn-savebar">
```

(This is a one-line insertion between the existing `${groupsHtml}` line and the existing `${showSaveBar ? ...}` line — don't change anything else in that template.)

- [ ] **Step 4: Pass `conn` from the one call site that should show it**

Find, in `renderConnectionsTab` (search for `renderConnConfigCard(active.config`):

```javascript
    ${active && active.config ? renderConnConfigCard(active.config, identity, { showSaveBar: false, identityEditable: true }) : ""}
```

Replace with:

```javascript
    ${active && active.config ? renderConnConfigCard(active.config, identity, { showSaveBar: false, identityEditable: true, conn: active }) : ""}
```

Do not touch the other call site (`state.connFlow === "summary"` branch, which calls `renderConnConfigCard(state.connDraft.configMap, ...)` without a `conn`) — that's the first-time connect flow, before the connection has an `id` yet; sync settings default silently to `1d`/`8` there and can be changed afterward from the connected view, per the spec's non-goals.

- [ ] **Step 5: Add the two click handlers**

In the global click dispatcher (search for `else if (act === "identity-pick") {`), find the end of that block:

```javascript
  else if (act === "identity-pick") {
    const prop = el.dataset.prop;
    if (state.connDraft) state.connDraft.identity.email = prop;
    else { const c = CONNECTIONS.find(x => x.id === state.activeConnId) || CONNECTIONS[0]; if (c) { c.identity_email_prop = prop; fetch(`/api/connections/${c.id}/identity`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: prop, name: c.identity_name_prop, role: c.identity_role_prop }) }); } }
    state.identityEditing = false;
    render();
  }
```

Add immediately after (same immediate-save-on-click pattern, no separate staged "Save" step, matching how identity editing already works in this same card):

```javascript
  else if (act === "sync-freq-pick") {
    const id = Number(el.dataset.id);
    const val = el.dataset.val;
    const c = CONNECTIONS.find(x => x.id === id);
    if (c) {
      c.sync_freq = val;
      fetch(`/api/connections/${id}/sync-settings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sync_freq: val, sync_max_sessions: c.sync_max_sessions || 8 }) });
      render();
    }
  }
  else if (act === "sync-max-pick") {
    const id = Number(el.dataset.id);
    const val = Number(el.dataset.val);
    const c = CONNECTIONS.find(x => x.id === id);
    if (c) {
      c.sync_max_sessions = val;
      fetch(`/api/connections/${id}/sync-settings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sync_freq: c.sync_freq || "1d", sync_max_sessions: val }) });
      render();
    }
  }
```

- [ ] **Step 6: Syntax check and deploy**

```bash
cd /Users/shubhamkhandelwal/posthog-bug-radar/worker
node -e "
const fs = require('fs');
const html = fs.readFileSync('public/index.html', 'utf8');
const m = html.match(/<script>([\s\S]*)<\/script>/);
fs.writeFileSync('/tmp/_check_sync.js', m[1]);
"
node --check /tmp/_check_sync.js && echo OK
npx wrangler deploy
```

- [ ] **Step 7: Commit**

```bash
cd /Users/shubhamkhandelwal/posthog-bug-radar
git add worker/public/index.html
git commit -m "Add Sync Settings UI to the connection detail card"
git push
```

---

## Task 4: Commit the runner script, document the launchd change

**Files:**
- Create: `run_all.sh`

**Interfaces:**
- Consumes: `GET /api/pipeline/connections` (Task 1's `due` and `sync_max_sessions` fields), `bug_radar.py --connection-id N --sessions M` (existing, unchanged flags).

- [ ] **Step 1: Write `run_all.sh`**

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

This replaces the version that exists only locally on the spare laptop today (created by hand during setup, never committed) — same core loop, but now filters on `due` and passes `--sessions` per-connection instead of running every connection unconditionally with the hardcoded default.

- [ ] **Step 2: Make it executable, commit, push**

```bash
cd /Users/shubhamkhandelwal/posthog-bug-radar
chmod +x run_all.sh
git add run_all.sh
git commit -m "Commit run_all.sh: poll due connections, pass per-connection session count"
git push
```

- [ ] **Step 3: Document the launchd interval change (manual step, on the spare laptop, not this repo)**

The spare laptop's existing launchd job (`~/Library/LaunchAgents/co.dreamteam.bugradar.plist`) uses `StartCalendarInterval` (once a day). Since a connection can now be scheduled as tight as every 5 minutes, that plist needs `StartInterval` instead, so `run_all.sh` gets a chance to notice a due connection within 5 minutes rather than once every 24 hours. On the spare laptop's terminal:

```bash
launchctl unload ~/Library/LaunchAgents/co.dreamteam.bugradar.plist
```

Then edit `~/Library/LaunchAgents/co.dreamteam.bugradar.plist`, replacing the `StartCalendarInterval` block:

```xml
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>7</integer>
    <key>Minute</key><integer>0</integer>
  </dict>
```

with:

```xml
  <key>StartInterval</key>
  <integer>300</integer>
```

Then re-pull the newly-committed `run_all.sh` and reload:

```bash
cd ~/posthog-bug-radar
git pull
chmod +x run_all.sh
launchctl load ~/Library/LaunchAgents/co.dreamteam.bugradar.plist
launchctl list | grep bugradar
```

This step has no automated verification here — it's a manual step on a machine outside this repo. Task 5 verifies the end-to-end behavior this enables.

---

## Task 5: End-to-end verification

**Files:** none (verification only).

- [ ] **Step 1: Verify the due filter for real, on this machine (not the spare laptop, to keep the test fast and controlled)**

```bash
cd /Users/shubhamkhandelwal/posthog-bug-radar
SECRET=$(security find-generic-password -s "BUGRADAR_API_SECRET" -w)

# Set connection 1 to the tightest frequency for a fast test cycle — do this via
# a real authenticated browser session (Playwright, see Step 3), not curl, since
# the save route requires a session cookie. This step just re-confirms the
# `due` flag's current state before that UI change.
curl -s "https://bug-radar.shubhamvishnu.workers.dev/api/pipeline/connections" -H "Authorization: Bearer $SECRET" | python3 -m json.tool
```

- [ ] **Step 2: Run `run_all.sh` locally against the live Worker, confirm it skips a non-due connection**

Right after Task 2's Step 4 already set connection 1's `last_pipeline_run_at` to "just now" (with the default `1d` frequency), it should not be due:

```bash
cd /Users/shubhamkhandelwal/posthog-bug-radar
./run_all.sh
```

Expected: prints `nothing due, skipping.` and exits 0 — proves the filter genuinely prevents a full pipeline run when nothing is due, not just that the script runs.

- [ ] **Step 3: Playwright pass on the real UI — change settings, confirm persistence and due-flip**

Use the Playwright MCP tools (same pattern used throughout this project) against `https://bug-radar.shubhamvishnu.workers.dev`:

1. Log in (session likely already valid from prior testing this project).
2. Navigate to Settings > Connections, expand the connected source.
3. Confirm the new "SYNC SETTINGS" section renders with "Daily" and "8" highlighted as active (matching the default).
4. Click "Every 5 min", confirm it visually becomes the active pill immediately (no page reload).
5. Reload the page. Confirm "Every 5 min" is still shown as active — proves the save round-tripped through `POST /api/connections/:id/sync-settings` and persisted, not just a client-side state change.
6. Click "20" under "Max sessions per sync", reload again, confirm it persisted too.

- [ ] **Step 4: Confirm `run_all.sh` now picks up the connection after the frequency change**

The connection's `last_pipeline_run_at` is still recent (from Task 2's Step 4 run), but the frequency is now `5m` — wait a few minutes for that window to pass, then:

```bash
cd /Users/shubhamkhandelwal/posthog-bug-radar
SECRET=$(security find-generic-password -s "BUGRADAR_API_SECRET" -w)
curl -s "https://bug-radar.shubhamvishnu.workers.dev/api/pipeline/connections" -H "Authorization: Bearer $SECRET" | python3 -c "
import json, sys
for c in json.load(sys.stdin):
    if c['id'] == 1:
        print('due:', c['due'], '| sync_freq:', c['sync_freq'], '| sync_max_sessions:', c['sync_max_sessions'])
"
./run_all.sh
```

Expected: `due: True`, and `run_all.sh` this time prints `=== connection 1 (sessions=20): ...` and actually invokes `bug_radar.py --connection-id 1 --sessions 20` — confirms the whole chain end-to-end: UI change → persisted → Worker's due computation → runner's filter → correct per-connection session count passed through.

- [ ] **Step 5: Reset connection 1 back to the default via the UI**

Since connection 1 is the real `dreamteam` connection used for actual daily analysis, not a throwaway test row — after verification, use the same Playwright flow to click "Daily" and "8" again, confirming it doesn't get left on the aggressive 5-minute test setting.
