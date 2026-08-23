# Slack Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a real Slack integration — OAuth-connect one workspace per account, build routing rules across six condition dimensions (outcome, severity, real_bug, customer_reachable, goals, tags), and post confirmed bug tasks to the matching channel(s) in real time — as a new "Slack" tab in Settings, pixel-faithful to the already-completed Claude Design mockup.

**Architecture:** Three new D1 tables (`slack_connections`, `slack_oauth_state`, `slack_rules`), reusing this codebase's existing `encryptSecret`/`decryptSecret` AES-GCM helpers for the bot token (same pattern as PostHog connection API keys). A real Slack OAuth v2 flow (browser redirect out to Slack, callback exchanges the code, state row proves the callback belongs to a real session). Rule matching is a pure function shared between a live dry-run route and the real-time posting hook, which is inserted into the two existing report-push routes (`POST /api/report`, `POST /api/pipeline/report/merge`) right after `resolveGoals`/`resolveTags` resolve each task's real `goal_id`/`tag_id`. The frontend ports the design's exact markup/copy into this app's existing vanilla-JS `render()`/`state` architecture (no framework, manual `innerHTML` rebuild), reusing the established `tagChipHtml`/`TAG_PALETTE`/`escapeHtml` conventions.

**Tech Stack:** Cloudflare Workers + D1 (`worker/src/index.js`), vanilla-JS frontend (`worker/public/index.html`), Slack Web API (`oauth.v2.access`, `conversations.list`, `chat.postMessage`), no build step, no framework, no unit test framework — verification is real curl / `wrangler d1 execute --remote` / Playwright.

**Spec:** `docs/superpowers/specs/2026-08-23-slack-integration-design.md`

**Design reference (UI source of truth, already complete):** Claude Design project `5f710252-b5a0-4483-bbf1-26f26db08f02`, file `Signularity.dc.html`. A plain-text copy for reference during implementation is at `.superpowers/design-ref/Signularity.dc.html` (2257 lines) — the `SLACK` render block is roughly lines 1048-1254 (markup) and lines 1890-2100 (interaction logic, `slMatch`/`slChips`/`slackVals`).

## Global Constraints

- No unit test framework anywhere in this codebase — verification is real calls: curl, `wrangler d1 execute --remote --command "..."` (needs `CLOUDFLARE_ACCOUNT_ID=ad1a4dda1125569690132b861f95a63a` set in the environment), and Playwright.
- D1 database name: `bug-radar-db`, `database_id: 65292c22-00df-42a0-ad9b-b5bb97dee409` (confirmed against `worker/wrangler.jsonc`). No `package.json`/local `wrangler` binary in `worker/` — deploy via `npx wrangler deploy`.
- Cloudflare `account_id`: `ad1a4dda1125569690132b861f95a63a`.
- Deployed Worker URL: `https://bug-radar.shubhamvishnu.workers.dev`.
- This project works directly on `main`, no feature branches — commit each task directly, push after each commit.
- Secrets via `wrangler secret put <NAME>` inside `worker/`. Never echo a secret value into command output or into this plan.
- **`SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` are a user-provided external blocker.** The user must create a real Slack App (steps are in the spec's "Required user action" section) and store these in macOS Keychain before a live OAuth round-trip can be verified end-to-end. Every task below still gets fully built and deployed regardless — error-path verification (401s, 400s, missing-config behavior) does not need real credentials. Only the true "click Add to Slack, land back connected to a real workspace" checks are deferred; each task's Verify section says explicitly which checks are deferred and why.
- Reuse existing helpers, do not reinvent: `getSessionEmail` (session auth), `encryptSecret`/`decryptSecret`/`getAesKey` (`worker/src/index.js:94-115`, AES-GCM, used verbatim for the Slack bot token), `escapeHtml` (`worker/public/index.html:574`), `tagChipHtml`/`TAG_PALETTE` (`worker/public/index.html:1177-1181,1797`), `flash()` (`worker/public/index.html:2046`), the `data-act` click-delegation dispatch pattern (`worker/public/index.html:2111` and the paired handlers further down), and the `settings-tab` pattern (`worker/public/index.html:1982-1992,2148`).
- Every place a color or label is interpolated into a `style="..."` attribute must go through `escapeHtml` — this codebase has a real prior XSS-hardening lesson here (see `tagChipHtml`'s `escapeHtml(color)` calls), the Slack tag/goal chips in the rule builder must follow the same discipline.
- Copy is taken verbatim from the design file wherever the spec doesn't override it — do not paraphrase.

---

### Task 1: Schema migration — `slack_connections`, `slack_oauth_state`, `slack_rules`

**Files:**
- Modify: `worker/schema.sql` (append after the `connection_events` table, matching the file's existing `CREATE TABLE IF NOT EXISTS` style)

**Interfaces:**
- Produces: three tables other tasks read/write directly by name — no ORM, no ceremony.

- [ ] **Step 1: Append the three table definitions to `worker/schema.sql`**

```sql

CREATE TABLE IF NOT EXISTS slack_connections (
  owner_email TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  team_name TEXT NOT NULL,
  encrypted_bot_token TEXT,
  iv TEXT,
  connected_by_email TEXT,
  status TEXT NOT NULL DEFAULT 'connected',
  connected_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS slack_oauth_state (
  state TEXT PRIMARY KEY,
  owner_email TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS slack_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_email TEXT NOT NULL,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  cond_outcome TEXT NOT NULL DEFAULT '[]',
  cond_severity TEXT NOT NULL DEFAULT '[]',
  cond_real_bug TEXT NOT NULL DEFAULT 'either',
  cond_reachable TEXT NOT NULL DEFAULT 'either',
  cond_goal_ids TEXT NOT NULL DEFAULT '[]',
  cond_tag_ids TEXT NOT NULL DEFAULT '[]',
  channel_id TEXT NOT NULL,
  channel_name TEXT NOT NULL,
  dm_owner INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
```

- [ ] **Step 2: Migrate on remote D1 (three separate commands, this project's established pattern for adding new tables)**

```bash
CLOUDFLARE_ACCOUNT_ID=ad1a4dda1125569690132b861f95a63a npx wrangler d1 execute bug-radar-db --remote --command "CREATE TABLE IF NOT EXISTS slack_connections (owner_email TEXT PRIMARY KEY, team_id TEXT NOT NULL, team_name TEXT NOT NULL, encrypted_bot_token TEXT, iv TEXT, connected_by_email TEXT, status TEXT NOT NULL DEFAULT 'connected', connected_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')))"

CLOUDFLARE_ACCOUNT_ID=ad1a4dda1125569690132b861f95a63a npx wrangler d1 execute bug-radar-db --remote --command "CREATE TABLE IF NOT EXISTS slack_oauth_state (state TEXT PRIMARY KEY, owner_email TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))"

CLOUDFLARE_ACCOUNT_ID=ad1a4dda1125569690132b861f95a63a npx wrangler d1 execute bug-radar-db --remote --command "CREATE TABLE IF NOT EXISTS slack_rules (id INTEGER PRIMARY KEY AUTOINCREMENT, owner_email TEXT NOT NULL, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, cond_outcome TEXT NOT NULL DEFAULT '[]', cond_severity TEXT NOT NULL DEFAULT '[]', cond_real_bug TEXT NOT NULL DEFAULT 'either', cond_reachable TEXT NOT NULL DEFAULT 'either', cond_goal_ids TEXT NOT NULL DEFAULT '[]', cond_tag_ids TEXT NOT NULL DEFAULT '[]', channel_id TEXT NOT NULL, channel_name TEXT NOT NULL, dm_owner INTEGER NOT NULL DEFAULT 0, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')))"
```

- [ ] **Step 3: Verify**

```bash
CLOUDFLARE_ACCOUNT_ID=ad1a4dda1125569690132b861f95a63a npx wrangler d1 execute bug-radar-db --remote --command "PRAGMA table_info(slack_connections)"
CLOUDFLARE_ACCOUNT_ID=ad1a4dda1125569690132b861f95a63a npx wrangler d1 execute bug-radar-db --remote --command "PRAGMA table_info(slack_oauth_state)"
CLOUDFLARE_ACCOUNT_ID=ad1a4dda1125569690132b861f95a63a npx wrangler d1 execute bug-radar-db --remote --command "PRAGMA table_info(slack_rules)"
```

Expected: all three show the exact columns above.

- [ ] **Step 4: Commit**

```bash
git add worker/schema.sql
git commit -m "Add slack_connections, slack_oauth_state, slack_rules tables"
git push
```

---

### Task 2: OAuth flow — status, start, callback

**Files:**
- Modify: `worker/src/index.js` (add new routes; insert near the other `/api/connections/*` or `/api/tags`-style session-authed routes, keeping the file's existing route-ordering convention of grouping related routes together)

**Interfaces:**
- Consumes: `getSessionEmail`, `encryptSecret`/`decryptSecret` (`worker/src/index.js:49,101-115`), `env.SLACK_CLIENT_ID`/`env.SLACK_CLIENT_SECRET` (new secrets, may be unset — routes must not crash if so, they should fail with a clear 500 `{error:"Slack app not configured"}` rather than an unhandled exception).
- Produces: `GET /api/slack/status` → `{connected:false}` or `{connected:true, team_name, connected_by_email, connected_at}`. `GET /api/slack/oauth/start` → 302 redirect to Slack. `GET /api/slack/oauth/callback` → 302 redirect back to the app on success, human-readable error text (not JSON, this is a browser navigation) on failure. Task 7 (frontend) calls `status` on load and navigates the browser to `oauth/start` when "Add to Slack" is clicked.

- [ ] **Step 1: Add `GET /api/slack/status`**

Insert this route (find a natural spot near other session-authed GETs, e.g. right after the `/api/tags` GET route):

```javascript
    if (pathname === "/api/slack/status" && request.method === "GET") {
      const email = await getSessionEmail(request, env);
      if (!email) return json({ error: "not authenticated" }, 401);
      const row = await env.DB.prepare(
        "SELECT team_name, status, connected_by_email, connected_at FROM slack_connections WHERE owner_email = ?"
      ).bind(email).first();
      if (!row) return json({ connected: false });
      return json({
        connected: row.status === "connected",
        status: row.status,
        team_name: row.team_name,
        connected_by_email: row.connected_by_email,
        connected_at: row.connected_at,
      });
    }
```

- [ ] **Step 2: Add `GET /api/slack/oauth/start`**

```javascript
    if (pathname === "/api/slack/oauth/start" && request.method === "GET") {
      const email = await getSessionEmail(request, env);
      if (!email) return json({ error: "not authenticated" }, 401);
      if (!env.SLACK_CLIENT_ID) return json({ error: "Slack app not configured" }, 500);
      const state = crypto.randomUUID();
      await env.DB.prepare("INSERT INTO slack_oauth_state (state, owner_email) VALUES (?, ?)").bind(state, email).run();
      const redirectUri = `${url.origin}/api/slack/oauth/callback`;
      const scopes = "chat:write,chat:write.public,channels:read,users:read";
      const authUrl = `https://slack.com/oauth/v2/authorize?client_id=${encodeURIComponent(env.SLACK_CLIENT_ID)}&scope=${encodeURIComponent(scopes)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}`;
      return Response.redirect(authUrl, 302);
    }
```

- [ ] **Step 3: Add `GET /api/slack/oauth/callback`**

```javascript
    if (pathname === "/api/slack/oauth/callback" && request.method === "GET") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const appOrigin = url.origin;
      if (!code || !state) {
        return new Response("Missing code or state.", { status: 400 });
      }
      const stateRow = await env.DB.prepare("SELECT owner_email, created_at FROM slack_oauth_state WHERE state = ?").bind(state).first();
      await env.DB.prepare("DELETE FROM slack_oauth_state WHERE state = ?").bind(state).run();
      if (!stateRow) {
        return new Response("This connection link has expired or was already used. Go back and click Add to Slack again.", { status: 400 });
      }
      const ageMs = Date.now() - sqliteTimeToMs(stateRow.created_at);
      if (Number.isNaN(ageMs) || ageMs > 10 * 60 * 1000) {
        return new Response("This connection link has expired. Go back and click Add to Slack again.", { status: 400 });
      }
      const ownerEmail = stateRow.owner_email;
      if (!env.SLACK_CLIENT_ID || !env.SLACK_CLIENT_SECRET) {
        return new Response("Slack app not configured.", { status: 500 });
      }
      const redirectUri = `${appOrigin}/api/slack/oauth/callback`;
      const tokenRes = await fetch("https://slack.com/api/oauth.v2.access", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: env.SLACK_CLIENT_ID,
          client_secret: env.SLACK_CLIENT_SECRET,
          code,
          redirect_uri: redirectUri,
        }),
      });
      const tokenData = await tokenRes.json();
      if (!tokenData.ok) {
        return new Response(`Slack couldn't complete the connection: ${tokenData.error || "unknown error"}.`, { status: 400 });
      }
      const { ciphertext, iv } = await encryptSecret(env, tokenData.access_token);
      await env.DB.prepare(
        `INSERT INTO slack_connections (owner_email, team_id, team_name, encrypted_bot_token, iv, connected_by_email, status, connected_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'connected', datetime('now'), datetime('now'))
         ON CONFLICT(owner_email) DO UPDATE SET
           team_id=excluded.team_id, team_name=excluded.team_name, encrypted_bot_token=excluded.encrypted_bot_token,
           iv=excluded.iv, connected_by_email=excluded.connected_by_email, status='connected', updated_at=datetime('now')`
      ).bind(ownerEmail, tokenData.team.id, tokenData.team.name, ciphertext, iv, ownerEmail).run();
      return Response.redirect(`${appOrigin}/?slack=connected`, 302);
    }
```

Note: `connected_by_email` is set to `ownerEmail` (the session owner who initiated the OAuth flow via `oauth/start`) rather than parsed from Slack's `authed_user.id`, since resolving that Slack user id to an email would need an extra `users.info` call for no real benefit — the owner of this Bug Radar account IS the person who clicked "Add to Slack," recorded via the `state` row, which is simpler and exactly as accurate.

- [ ] **Step 4: Deploy**

```bash
cd worker && npx wrangler deploy && cd ..
```

- [ ] **Step 5: Verify the parts that don't need real Slack credentials**

```bash
curl -s -o /dev/null -w "%{http_code}\n" "https://bug-radar.shubhamvishnu.workers.dev/api/slack/status"
curl -s -o /dev/null -w "%{http_code}\n" "https://bug-radar.shubhamvishnu.workers.dev/api/slack/oauth/start"
curl -s -o /dev/null -w "%{http_code}\n" "https://bug-radar.shubhamvishnu.workers.dev/api/slack/oauth/callback"
curl -s "https://bug-radar.shubhamvishnu.workers.dev/api/slack/oauth/callback?state=bogus&code=bogus"
```

Expected: first two 401 (no session cookie); third 400 (missing code/state — no cookie needed, this route doesn't check session); fourth returns the "expired or already used" message with a 400 status (verify with `-w "\nHTTP:%{http_code}\n"`).

Get a real session cookie (OTP flow, matching every other verification in this project: `POST /api/auth/request-otp`, read code from D1, `POST /api/auth/verify-otp`) and confirm `GET /api/slack/status` returns `{"connected":false}` for the real `shubhamvishnu@gmail.com` account (no Slack connected yet).

**Deferred pending real `SLACK_CLIENT_ID`/`SLACK_CLIENT_SECRET`:** the actual `oauth/start` → Slack authorize page → `oauth/callback` → real workspace connected round trip. Note this explicitly in your report; it gets verified in Task 11 or whenever the user supplies the credentials, whichever comes first.

- [ ] **Step 6: Commit**

```bash
git add worker/src/index.js
git commit -m "Add Slack OAuth status/start/callback routes"
git push
```

---

### Task 3: Channel listing + disconnect

**Files:**
- Modify: `worker/src/index.js` (add routes near the Task 2 routes)

**Interfaces:**
- Consumes: `decryptSecret`, `slack_connections` table (Task 1/2).
- Produces: `GET /api/slack/channels` → `[{id, name, num_members}]`. `POST /api/slack/disconnect` → `{ok:true}`. Task 9/10 (frontend rule builder) call `channels`; Task 8 (frontend connected card) calls `disconnect`.

- [ ] **Step 1: Add a small shared helper to load a connection's decrypted bot token**

Insert above the Task 2 routes (or anywhere before first use — this file doesn't enforce strict helper-ordering, follow the existing style of other top-level helper functions like `decryptSecret` itself):

```javascript
async function getSlackBotToken(env, ownerEmail) {
  const row = await env.DB.prepare(
    "SELECT encrypted_bot_token, iv FROM slack_connections WHERE owner_email = ? AND status = 'connected'"
  ).bind(ownerEmail).first();
  if (!row || !row.encrypted_bot_token) return null;
  return decryptSecret(env, row.encrypted_bot_token, row.iv);
}
```

- [ ] **Step 2: Add `GET /api/slack/channels`**

```javascript
    if (pathname === "/api/slack/channels" && request.method === "GET") {
      const email = await getSessionEmail(request, env);
      if (!email) return json({ error: "not authenticated" }, 401);
      const token = await getSlackBotToken(env, email);
      if (!token) return json({ error: "Slack not connected" }, 400);
      const channels = [];
      let cursor = "";
      for (let page = 0; page < 10; page++) {
        const qs = new URLSearchParams({ types: "public_channel", exclude_archived: "true", limit: "200" });
        if (cursor) qs.set("cursor", cursor);
        const res = await fetch(`https://slack.com/api/conversations.list?${qs}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        const data = await res.json();
        if (!data.ok) return json({ error: `Slack error: ${data.error || "unknown"}` }, 502);
        for (const c of data.channels || []) {
          channels.push({ id: c.id, name: `#${c.name}`, num_members: c.num_members || 0 });
        }
        cursor = data.response_metadata && data.response_metadata.next_cursor;
        if (!cursor) break;
        if (channels.length >= 500) break;
      }
      return json(channels);
    }
```

- [ ] **Step 3: Add `POST /api/slack/disconnect`**

```javascript
    if (pathname === "/api/slack/disconnect" && request.method === "POST") {
      const email = await getSessionEmail(request, env);
      if (!email) return json({ error: "not authenticated" }, 401);
      await env.DB.prepare(
        "UPDATE slack_connections SET status = 'disconnected', encrypted_bot_token = NULL, iv = NULL, updated_at = datetime('now') WHERE owner_email = ?"
      ).bind(email).run();
      return json({ ok: true });
    }
```

- [ ] **Step 4: Deploy**

```bash
cd worker && npx wrangler deploy && cd ..
```

- [ ] **Step 5: Verify**

```bash
curl -s -o /dev/null -w "%{http_code}\n" "https://bug-radar.shubhamvishnu.workers.dev/api/slack/channels"
curl -s -o /dev/null -w "%{http_code}\n" -X POST "https://bug-radar.shubhamvishnu.workers.dev/api/slack/disconnect"
```

Expected: both 401 with no cookie. With a real session cookie but no Slack connection yet, `GET /api/slack/channels` → 400 `{"error":"Slack not connected"}`; `POST /api/slack/disconnect` → 200 `{"ok":true}` (idempotent — disconnecting when nothing's connected is harmless, confirm with a D1 check that no row was created: `SELECT COUNT(*) FROM slack_connections WHERE owner_email='shubhamvishnu@gmail.com'` should still be 0).

**Deferred pending real Slack credentials:** the actual `conversations.list` call returning real channels once a real connection exists.

- [ ] **Step 6: Commit**

```bash
git add worker/src/index.js
git commit -m "Add Slack channel listing and disconnect routes"
git push
```

---

### Task 4: Slack rules CRUD + orphan detection

**Files:**
- Modify: `worker/src/index.js`

**Interfaces:**
- Consumes: `getSessionEmail`, `goals`/`tags` tables (existing, for orphan cross-check).
- Produces: `GET /api/slack/rules` → array of rules each with an `orphaned`/`orphan_reason` field. `POST /api/slack/rules` (create). `PATCH /api/slack/rules/:id` (update). `DELETE /api/slack/rules/:id`. `POST /api/slack/rules/:id/toggle`. Task 8/9/10 (frontend rules list + builder) consume all five.

- [ ] **Step 1: Add `GET /api/slack/rules`**

```javascript
    if (pathname === "/api/slack/rules" && request.method === "GET") {
      const email = await getSessionEmail(request, env);
      if (!email) return json({ error: "not authenticated" }, 401);
      const { results: rows } = await env.DB.prepare(
        "SELECT * FROM slack_rules WHERE owner_email = ? ORDER BY id DESC"
      ).bind(email).all();
      const { results: goalRows } = await env.DB.prepare("SELECT id FROM goals WHERE owner_email = ?").bind(email).all();
      const { results: tagRows } = await env.DB.prepare("SELECT id FROM tags WHERE owner_email = ?").bind(email).all();
      const validGoalIds = new Set(goalRows.map(g => g.id));
      const validTagIds = new Set(tagRows.map(t => t.id));
      const rules = rows.map(r => {
        const goalIds = JSON.parse(r.cond_goal_ids);
        const tagIds = JSON.parse(r.cond_tag_ids);
        const missingGoal = goalIds.some(id => !validGoalIds.has(id));
        const missingTag = tagIds.some(id => !validTagIds.has(id));
        const orphaned = missingGoal || missingTag;
        return {
          id: r.id, name: r.name, enabled: !!r.enabled,
          cond: {
            outcome: JSON.parse(r.cond_outcome), severity: JSON.parse(r.cond_severity),
            realBug: r.cond_real_bug, reachable: r.cond_reachable,
            goalIds, tagIds,
          },
          channelId: r.channel_id, channelName: r.channel_name, dmOwner: !!r.dm_owner,
          orphaned,
          orphanReason: orphaned ? (missingGoal && missingTag ? "References a deleted goal and tag" : missingGoal ? "References a deleted goal" : "References a deleted tag") : null,
        };
      });
      return json(rules);
    }
```

- [ ] **Step 2: Add `POST /api/slack/rules`**

```javascript
    if (pathname === "/api/slack/rules" && request.method === "POST") {
      const email = await getSessionEmail(request, env);
      if (!email) return json({ error: "not authenticated" }, 401);
      const body = await request.json().catch(() => ({}));
      if (!body.name || !String(body.name).trim() || !body.channelId || !body.channelName) {
        return json({ error: "name and channel are required" }, 400);
      }
      const cond = body.cond || {};
      const result = await env.DB.prepare(
        `INSERT INTO slack_rules (owner_email, name, enabled, cond_outcome, cond_severity, cond_real_bug, cond_reachable, cond_goal_ids, cond_tag_ids, channel_id, channel_name, dm_owner)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        email, String(body.name).trim(),
        JSON.stringify(cond.outcome || []), JSON.stringify(cond.severity || []),
        cond.realBug || "either", cond.reachable || "either",
        JSON.stringify(cond.goalIds || []), JSON.stringify(cond.tagIds || []),
        body.channelId, body.channelName, body.dmOwner ? 1 : 0
      ).run();
      return json({ ok: true, id: result.meta.last_row_id });
    }
```

- [ ] **Step 3: Add `PATCH /api/slack/rules/:id`, `DELETE /api/slack/rules/:id`, `POST /api/slack/rules/:id/toggle`**

```javascript
    const ruleMatch = pathname.match(/^\/api\/slack\/rules\/(\d+)$/);
    if (ruleMatch && request.method === "PATCH") {
      const email = await getSessionEmail(request, env);
      if (!email) return json({ error: "not authenticated" }, 401);
      const id = Number(ruleMatch[1]);
      const owns = await env.DB.prepare("SELECT id FROM slack_rules WHERE id = ? AND owner_email = ?").bind(id, email).first();
      if (!owns) return json({ error: "not found" }, 404);
      const body = await request.json().catch(() => ({}));
      if (!body.name || !String(body.name).trim() || !body.channelId || !body.channelName) {
        return json({ error: "name and channel are required" }, 400);
      }
      const cond = body.cond || {};
      await env.DB.prepare(
        `UPDATE slack_rules SET name=?, cond_outcome=?, cond_severity=?, cond_real_bug=?, cond_reachable=?, cond_goal_ids=?, cond_tag_ids=?, channel_id=?, channel_name=?, dm_owner=?, updated_at=datetime('now')
         WHERE id = ?`
      ).bind(
        String(body.name).trim(),
        JSON.stringify(cond.outcome || []), JSON.stringify(cond.severity || []),
        cond.realBug || "either", cond.reachable || "either",
        JSON.stringify(cond.goalIds || []), JSON.stringify(cond.tagIds || []),
        body.channelId, body.channelName, body.dmOwner ? 1 : 0,
        id
      ).run();
      return json({ ok: true });
    }

    if (ruleMatch && request.method === "DELETE") {
      const email = await getSessionEmail(request, env);
      if (!email) return json({ error: "not authenticated" }, 401);
      const id = Number(ruleMatch[1]);
      await env.DB.prepare("DELETE FROM slack_rules WHERE id = ? AND owner_email = ?").bind(id, email).run();
      return json({ ok: true });
    }

    const ruleToggleMatch = pathname.match(/^\/api\/slack\/rules\/(\d+)\/toggle$/);
    if (ruleToggleMatch && request.method === "POST") {
      const email = await getSessionEmail(request, env);
      if (!email) return json({ error: "not authenticated" }, 401);
      const id = Number(ruleToggleMatch[1]);
      const row = await env.DB.prepare("SELECT enabled FROM slack_rules WHERE id = ? AND owner_email = ?").bind(id, email).first();
      if (!row) return json({ error: "not found" }, 404);
      await env.DB.prepare("UPDATE slack_rules SET enabled = ?, updated_at = datetime('now') WHERE id = ?").bind(row.enabled ? 0 : 1, id).run();
      return json({ ok: true, enabled: !row.enabled });
    }
```

- [ ] **Step 4: Deploy**

```bash
cd worker && npx wrangler deploy && cd ..
```

- [ ] **Step 5: Verify with a real session cookie**

```bash
COOKIE="bugradar_session=<real token>"
curl -s "https://bug-radar.shubhamvishnu.workers.dev/api/slack/rules" -H "Cookie: $COOKIE"
curl -s -X POST "https://bug-radar.shubhamvishnu.workers.dev/api/slack/rules" -H "Cookie: $COOKIE" -H "content-type: application/json" \
  -d '{"name":"Test rule","channelId":"C0TEST123","channelName":"#test","cond":{"severity":["High"],"realBug":"yes","reachable":"either","outcome":[],"goalIds":[],"tagIds":[]},"dmOwner":false}'
curl -s "https://bug-radar.shubhamvishnu.workers.dev/api/slack/rules" -H "Cookie: $COOKIE"
```

Expected: first call → `[]`. Create call → `{"ok":true,"id":<n>}`. Second list call → one rule with `name:"Test rule"`, `orphaned:false` (no goals/tags referenced), `channelName:"#test"`. Then toggle it (`POST .../rules/<id>/toggle`), confirm `enabled` flips; PATCH it with a changed name, confirm the list reflects it; DELETE it, confirm the list is empty again.

- [ ] **Step 6: Commit**

```bash
git add worker/src/index.js
git commit -m "Add Slack rules CRUD and orphan detection"
git push
```

---

### Task 5: Rule matching engine + dry-run route

**Files:**
- Modify: `worker/src/index.js`

**Interfaces:**
- Consumes: `reports` table (`micro_findings` JSON), the rule shape from Task 4.
- Produces: `function slackRuleMatches(task, rule)` (pure, exported implicitly as a top-level function — Task 6 imports/calls it directly since it's in the same file). `function getRecentTasksForOwner(env, ownerEmail, limit)` → flattened, sorted task list. `POST /api/slack/dry-run` → `{total, matches:[{title, severity, when}]}`. Task 10 (frontend dry-run panel) consumes the route; Task 6 (real-time posting) consumes `slackRuleMatches` directly.

- [ ] **Step 1: Add the shared matching function and the recent-tasks helper**

Insert as top-level functions, near `resolveGoals`/`resolveTags`:

```javascript
function slackRuleMatches(task, rule) {
  const outcome = JSON.parse(rule.cond_outcome);
  const severity = JSON.parse(rule.cond_severity);
  const goalIds = JSON.parse(rule.cond_goal_ids);
  const tagIds = JSON.parse(rule.cond_tag_ids);
  if (outcome.length && !outcome.includes(task.outcome)) return false;
  if (severity.length && !severity.includes(task.severity)) return false;
  if (rule.cond_real_bug !== "either" && (rule.cond_real_bug === "yes") !== !!task.real_bug) return false;
  if (rule.cond_reachable !== "either" && (rule.cond_reachable === "yes") !== !!task.customer_reachable) return false;
  if (goalIds.length && !goalIds.includes(task.goal_id)) return false;
  if (tagIds.length) {
    const taskTagIds = (task.tags || []).map(t => t.tag_id);
    if (!tagIds.some(id => taskTagIds.includes(id))) return false;
  }
  return true;
}

async function getRecentTasksForOwner(env, ownerEmail, limit) {
  const { results: reportRows } = await env.DB.prepare(
    "SELECT micro_findings, generated_at FROM reports WHERE owner_email = ? ORDER BY id DESC LIMIT 10"
  ).bind(ownerEmail).all();
  const flat = [];
  for (const row of reportRows) {
    const findings = JSON.parse(row.micro_findings);
    for (const f of findings) {
      for (const t of f.tasks || []) {
        flat.push({ ...t, _sessionId: f.session_id, _generatedAt: row.generated_at });
      }
    }
  }
  flat.sort((a, b) => {
    const ta = a.key_timestamp || a._generatedAt || "";
    const tb = b.key_timestamp || b._generatedAt || "";
    return tb.localeCompare(ta);
  });
  return flat.slice(0, limit);
}

function relativeAgeLabel(iso) {
  if (!iso) return "";
  const ms = Date.now() - Date.parse(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z");
  if (Number.isNaN(ms) || ms < 0) return "";
  const hrs = Math.round(ms / 3600000);
  return hrs < 24 ? `${hrs}h` : `${Math.round(hrs / 24)}d`;
}
```

- [ ] **Step 2: Add `POST /api/slack/dry-run`**

```javascript
    if (pathname === "/api/slack/dry-run" && request.method === "POST") {
      const email = await getSessionEmail(request, env);
      if (!email) return json({ error: "not authenticated" }, 401);
      const body = await request.json().catch(() => ({}));
      const cond = body.cond || {};
      const pseudoRule = {
        cond_outcome: JSON.stringify(cond.outcome || []),
        cond_severity: JSON.stringify(cond.severity || []),
        cond_real_bug: cond.realBug || "either",
        cond_reachable: cond.reachable || "either",
        cond_goal_ids: JSON.stringify(cond.goalIds || []),
        cond_tag_ids: JSON.stringify(cond.tagIds || []),
      };
      const tasks = await getRecentTasksForOwner(env, email, 50);
      const matches = tasks.filter(t => slackRuleMatches(t, pseudoRule));
      return json({
        total: matches.length,
        matches: matches.slice(0, 4).map(t => ({ title: t.title, severity: t.severity || "none", when: relativeAgeLabel(t.key_timestamp || t._generatedAt) })),
      });
    }
```

- [ ] **Step 3: Deploy**

```bash
cd worker && npx wrangler deploy && cd ..
```

- [ ] **Step 4: Verify against real task data**

```bash
COOKIE="bugradar_session=<real token>"
curl -s -X POST "https://bug-radar.shubhamvishnu.workers.dev/api/slack/dry-run" -H "Cookie: $COOKIE" -H "content-type: application/json" -d '{"cond":{"outcome":[],"severity":[],"realBug":"either","reachable":"either","goalIds":[],"tagIds":[]}}'
```

Expected: `total` matches a hand-count of tasks in `shubhamvishnu@gmail.com`'s most recent reports (an empty condition object matches everything, so `total` should equal min(50, total real tasks across their last 10 reports) — cross-check against `SELECT micro_findings FROM reports WHERE owner_email='shubhamvishnu@gmail.com' ORDER BY id DESC LIMIT 10` and manually summing `tasks.length`). Then try a real severity filter (`"severity":["High"]`) and confirm `total` drops to only the real high-severity tasks.

- [ ] **Step 5: Commit**

```bash
git add worker/src/index.js
git commit -m "Add Slack rule matching engine and dry-run route"
git push
```

---

### Task 6: Real-time posting on report push

**Files:**
- Modify: `worker/src/index.js:512-549` (`POST /api/report`) and `worker/src/index.js:618-677` (`POST /api/pipeline/report/merge`)

**Interfaces:**
- Consumes: `slackRuleMatches`, `getSlackBotToken` (Task 3/5), `resolvedFindings`/`resolvedNewFindings` (already computed in both routes).
- Produces: a shared `postSlackNotifications(env, ownerEmail, findings)` function both routes call after the report insert succeeds.

- [ ] **Step 1: Add the shared posting function**

Insert near `slackRuleMatches`:

```javascript
async function postSlackNotifications(env, ownerEmail, findings) {
  try {
    const conn = await env.DB.prepare("SELECT status FROM slack_connections WHERE owner_email = ?").bind(ownerEmail).first();
    if (!conn || conn.status !== "connected") return;
    const { results: rules } = await env.DB.prepare("SELECT * FROM slack_rules WHERE owner_email = ? AND enabled = 1").bind(ownerEmail).all();
    if (!rules.length) return;
    const token = await getSlackBotToken(env, ownerEmail);
    if (!token) return;
    for (const f of findings) {
      for (const t of f.tasks || []) {
        for (const rule of rules) {
          if (!slackRuleMatches(t, rule)) continue;
          const sevEmoji = t.severity === "high" ? "🔴" : t.severity === "medium" ? "🟠" : "⚪";
          const fields = [
            { type: "mrkdwn", text: `*Outcome*\n${t.outcome || "unresolved"}` },
            { type: "mrkdwn", text: `*Real bug*\n${t.real_bug ? "Yes" : "No"}` },
          ];
          const blocks = [
            { type: "section", text: { type: "mrkdwn", text: `${sevEmoji} *${t.title || "Untitled task"}*` } },
            { type: "section", fields },
            { type: "context", elements: [{ type: "mrkdwn", text: `Routed here: ${rule.name}` }] },
          ];
          try {
            await fetch("https://slack.com/api/chat.postMessage", {
              method: "POST",
              headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
              body: JSON.stringify({ channel: rule.channel_id, text: t.title || "A confirmed bug was detected", blocks }),
            });
          } catch (e) {
            // best-effort: a Slack post failure must never fail the report push
          }
        }
      }
    }
  } catch (e) {
    // best-effort at the outer level too — this function must never throw into its caller
  }
}
```

- [ ] **Step 2: Call it from `POST /api/report`**

In `worker/src/index.js`, find (inside the `POST /api/report` handler, right after the `logConnectionEvent` call block and its closing `}`, still inside the `if (body.connection_id)` block's scope — actually call it unconditionally after that whole `if` block, since posting should happen even if there's no `connection_id`):

```javascript
      if (body.connection_id) {
        await env.DB.prepare("UPDATE connections SET last_pipeline_run_at = datetime('now') WHERE id = ?").bind(body.connection_id).run();
        const taskCount = resolvedFindings.reduce((n, f) => n + (f.tasks || []).length, 0);
        const realBugCount = resolvedFindings.reduce((n, f) => n + (f.tasks || []).filter(t => t.real_bug).length, 0);
        const outreachCount = resolvedFindings.filter(f => f.recommended_outreach).length;
        const captureCount = Number(body.capture_count) || 0;
        await logConnectionEvent(
          env, body.connection_id, "sync_completed", "success", "Sync completed",
          `Pulled ${resolvedFindings.length} sessions · ${taskCount} tasks · ${realBugCount} real bugs · ${outreachCount} outreach · ${goalsResult.count} new goals · ${tagsResult.count} new tags · ${captureCount} moments queued.`,
          "scheduled"
        );
      }
      return json({ ok: true });
```

Replace with:

```javascript
      if (body.connection_id) {
        await env.DB.prepare("UPDATE connections SET last_pipeline_run_at = datetime('now') WHERE id = ?").bind(body.connection_id).run();
        const taskCount = resolvedFindings.reduce((n, f) => n + (f.tasks || []).length, 0);
        const realBugCount = resolvedFindings.reduce((n, f) => n + (f.tasks || []).filter(t => t.real_bug).length, 0);
        const outreachCount = resolvedFindings.filter(f => f.recommended_outreach).length;
        const captureCount = Number(body.capture_count) || 0;
        await logConnectionEvent(
          env, body.connection_id, "sync_completed", "success", "Sync completed",
          `Pulled ${resolvedFindings.length} sessions · ${taskCount} tasks · ${realBugCount} real bugs · ${outreachCount} outreach · ${goalsResult.count} new goals · ${tagsResult.count} new tags · ${captureCount} moments queued.`,
          "scheduled"
        );
      }
      await postSlackNotifications(env, ownerEmail, resolvedFindings);
      return json({ ok: true });
```

- [ ] **Step 3: Call it from `POST /api/pipeline/report/merge`**

Find (right after that route's own `logConnectionEvent` block):

```javascript
      if (resolvedConnectionId) {
        await env.DB.prepare("UPDATE connections SET last_pipeline_run_at = datetime('now') WHERE id = ?").bind(resolvedConnectionId).run();
        const taskCount = resolvedNewFindings.reduce((n, f) => n + (f.tasks || []).length, 0);
        const realBugCount = resolvedNewFindings.reduce((n, f) => n + (f.tasks || []).filter(t => t.real_bug).length, 0);
        const outreachCount = resolvedNewFindings.filter(f => f.recommended_outreach).length;
        const captureCount = Number(body.capture_count) || 0;
        await logConnectionEvent(
          env, resolvedConnectionId, "sync_completed", "success", "Sync completed",
          `Pulled ${resolvedNewFindings.length} sessions · ${taskCount} tasks · ${realBugCount} real bugs · ${outreachCount} outreach · ${goalsResult.count} new goals · ${tagsResult.count} new tags · ${captureCount} moments queued.`,
          "manual · targeted"
        );
      }
      return json({ ok: true, merged_session_ids: newFindings.map(f => f.session_id), total_findings: mergedMicro.length });
```

Replace with:

```javascript
      if (resolvedConnectionId) {
        await env.DB.prepare("UPDATE connections SET last_pipeline_run_at = datetime('now') WHERE id = ?").bind(resolvedConnectionId).run();
        const taskCount = resolvedNewFindings.reduce((n, f) => n + (f.tasks || []).length, 0);
        const realBugCount = resolvedNewFindings.reduce((n, f) => n + (f.tasks || []).filter(t => t.real_bug).length, 0);
        const outreachCount = resolvedNewFindings.filter(f => f.recommended_outreach).length;
        const captureCount = Number(body.capture_count) || 0;
        await logConnectionEvent(
          env, resolvedConnectionId, "sync_completed", "success", "Sync completed",
          `Pulled ${resolvedNewFindings.length} sessions · ${taskCount} tasks · ${realBugCount} real bugs · ${outreachCount} outreach · ${goalsResult.count} new goals · ${tagsResult.count} new tags · ${captureCount} moments queued.`,
          "manual · targeted"
        );
      }
      await postSlackNotifications(env, ownerEmail, resolvedNewFindings);
      return json({ ok: true, merged_session_ids: newFindings.map(f => f.session_id), total_findings: mergedMicro.length });
```

Note: `resolvedNewFindings` (the newly-pushed findings only, not the full merged history) is intentional — re-posting every historical task on every merge would spam the channel; only genuinely new/updated findings from this push should notify.

- [ ] **Step 4: Deploy**

```bash
cd worker && npx wrangler deploy && cd ..
```

- [ ] **Step 5: Verify the failure-isolation guarantee first (most important check in this task)**

Confirm a Slack posting failure cannot break a report push: with no Slack connection at all for a synthetic owner, push a real report and confirm it still succeeds normally (this exercises the `if (!conn || conn.status !== "connected") return;` early-exit path):

```bash
curl -s -X POST "https://bug-radar.shubhamvishnu.workers.dev/api/report" \
  -H "Authorization: Bearer $BUGRADAR_API_SECRET" -H "content-type: application/json" \
  -d '{"owner_email":"slack-test@example.com","generated_at":"2026-08-23T00:00:00Z","macro_themes":[],"micro_findings":[{"session_id":"slack-test-1","tasks":[{"title":"Test task","severity":"high","outcome":"blocked","real_bug":true,"customer_reachable":true,"tags":[]}]}]}'
```

Expected: `{"ok":true}`, unaffected by the absence of a Slack connection. Retrieve `$BUGRADAR_API_SECRET` the same way prior plans in this project have (`security find-generic-password -s "BUGRADAR_API_SECRET" -w` if it's in Keychain, otherwise ask for it — never echo the value itself).

**Deferred pending real Slack credentials AND a real connected workspace with a saved rule:** an actual message landing in a real Slack channel. Once the user has completed Slack App setup and connected via the UI (Task 7-10), create one real rule matching `severity: High`, then push the same kind of synthetic report above for the real `shubhamvishnu@gmail.com` owner and confirm a real message appears in the real channel. Note this as an explicit follow-up check once credentials exist, don't block this task's completion on it.

- [ ] **Step 6: Commit**

```bash
git add worker/src/index.js
git commit -m "Wire real-time Slack posting into report push routes"
git push
```

---

### Task 7: Frontend — Slack tab scaffold, not-connected screen, connecting screen

**Files:**
- Modify: `worker/public/index.html`

**Interfaces:**
- Consumes: `escapeHtml`, `flash()`, the `settings-tab` pattern (`worker/public/index.html:1982-1992,2148`), `GET /api/slack/status` (Task 2).
- Produces: `let SLACK_STATUS = {connected:false}`; `state.slackConnecting` (bool); `renderSlackTab()`; wires `"slack"` into the settings tab bar and `renderSettings()`'s dispatch. Tasks 8-10 extend `renderSlackTab()`'s connected-state body.

- [ ] **Step 1: Add `SLACK_STATUS` global and load it in `loadData()`**

Find (`worker/public/index.html:492-493`):

```javascript
let GOALS = [];
let TAGS = [];
```

Replace with:

```javascript
let GOALS = [];
let TAGS = [];
let SLACK_STATUS = { connected: false };
let SLACK_RULES = [];
```

Find (`worker/public/index.html:495-519`, the `loadData` function):

```javascript
async function loadData() {
  const [reportRes, promptsRes, correctionsRes, connRes, knowRes, goalsRes, tagsRes] = await Promise.all([
    fetch("/api/report"),
    fetch("/api/prompts"),
    fetch("/api/corrections"),
    fetch("/api/connections"),
    fetch("/api/company-knowledge"),
    fetch("/api/goals"),
    fetch("/api/tags"),
  ]);
  if (reportRes.ok) REPORT = await reportRes.json();
  if (promptsRes.ok) PROMPTS = await promptsRes.json();
  if (correctionsRes.ok) {
    const raw = await correctionsRes.json();
    CORRECTIONS = raw.map(c => ({
      session_id: c.session_id, task_index: c.task_index, task_title: c.task_title,
      task_goal: c.task_goal, field: c.field, from: c.from_value, to: c.to_value,
      reason: c.reason, timestamp: c.created_at,
    }));
  }
  if (connRes.ok) CONNECTIONS = await connRes.json();
  if (knowRes.ok) { KNOWLEDGE = await knowRes.json(); state.knowledgeUrl = KNOWLEDGE.domain || ""; state.knowledgeDesc = KNOWLEDGE.description || ""; }
  if (goalsRes.ok) GOALS = await goalsRes.json();
  if (tagsRes.ok) TAGS = await tagsRes.json();
}
```

Replace with (adds two more parallel fetches, same pattern):

```javascript
async function loadData() {
  const [reportRes, promptsRes, correctionsRes, connRes, knowRes, goalsRes, tagsRes, slackStatusRes, slackRulesRes] = await Promise.all([
    fetch("/api/report"),
    fetch("/api/prompts"),
    fetch("/api/corrections"),
    fetch("/api/connections"),
    fetch("/api/company-knowledge"),
    fetch("/api/goals"),
    fetch("/api/tags"),
    fetch("/api/slack/status"),
    fetch("/api/slack/rules"),
  ]);
  if (reportRes.ok) REPORT = await reportRes.json();
  if (promptsRes.ok) PROMPTS = await promptsRes.json();
  if (correctionsRes.ok) {
    const raw = await correctionsRes.json();
    CORRECTIONS = raw.map(c => ({
      session_id: c.session_id, task_index: c.task_index, task_title: c.task_title,
      task_goal: c.task_goal, field: c.field, from: c.from_value, to: c.to_value,
      reason: c.reason, timestamp: c.created_at,
    }));
  }
  if (connRes.ok) CONNECTIONS = await connRes.json();
  if (knowRes.ok) { KNOWLEDGE = await knowRes.json(); state.knowledgeUrl = KNOWLEDGE.domain || ""; state.knowledgeDesc = KNOWLEDGE.description || ""; }
  if (goalsRes.ok) GOALS = await goalsRes.json();
  if (tagsRes.ok) TAGS = await tagsRes.json();
  if (slackStatusRes.ok) SLACK_STATUS = await slackStatusRes.json();
  if (slackRulesRes.ok) SLACK_RULES = await slackRulesRes.json();
}
```

- [ ] **Step 2: Wire the tab into `renderSettings()`**

Find (`worker/public/index.html:1982-1992`):

```javascript
function renderSettings() {
  const tab = state.settingsTab;
  const tabBtn = (key, label) => `<button class="settings-tab-btn${tab === key ? " active" : ""}" data-act="settings-tab" data-tab="${key}">${label}</button>`;
  const body = tab === "connections" ? renderConnectionsTab() : tab === "knowledge" ? renderKnowledgeTab() : tab === "goals" ? renderGoalsTab() : renderPipelineTab();
  return `
  <div class="pageheader"><span class="title">Settings</span></div>
  <div class="content"><div class="contentpad" style="max-width:900px">
    <div class="settings-tabs">${tabBtn("connections", "Connections")}${tabBtn("knowledge", "Company knowledge")}${tabBtn("pipeline", "Pipeline &amp; model")}${tabBtn("goals", "Goals &amp; tags")}</div>
    ${body}
  </div></div>`;
}
```

Replace with:

```javascript
function renderSettings() {
  const tab = state.settingsTab;
  const tabBtn = (key, label) => `<button class="settings-tab-btn${tab === key ? " active" : ""}" data-act="settings-tab" data-tab="${key}">${label}</button>`;
  const body = tab === "connections" ? renderConnectionsTab() : tab === "knowledge" ? renderKnowledgeTab() : tab === "goals" ? renderGoalsTab() : tab === "slack" ? renderSlackTab() : renderPipelineTab();
  return `
  <div class="pageheader"><span class="title">Settings</span></div>
  <div class="content"><div class="contentpad" style="max-width:900px">
    <div class="settings-tabs">${tabBtn("connections", "Connections")}${tabBtn("knowledge", "Company knowledge")}${tabBtn("pipeline", "Pipeline &amp; model")}${tabBtn("goals", "Goals &amp; tags")}${tabBtn("slack", "Slack")}</div>
    ${body}
  </div></div>`;
}
```

- [ ] **Step 3: Add the Slack tab renderer with the not-connected and connecting screens**

Insert as a new top-level function, near `renderGoalsTab`/`renderTagsSection`:

```javascript
const SLACK_MARK_SVG = (px) => `<svg width="${px}" height="${px}" viewBox="0 0 122 122" fill="none"><path d="M25.8 77c0 7.1-5.8 12.9-12.9 12.9S0 84.1 0 77s5.8-12.9 12.9-12.9h12.9V77z" fill="#E01E5A"/><path d="M32.3 77c0-7.1 5.8-12.9 12.9-12.9S58.1 69.9 58.1 77v32.3c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V77z" fill="#E01E5A"/><path d="M45.2 25.8c-7.1 0-12.9-5.8-12.9-12.9S38.1 0 45.2 0s12.9 5.8 12.9 12.9v12.9H45.2z" fill="#36C5F0"/><path d="M45.2 32.3c7.1 0 12.9 5.8 12.9 12.9S52.3 58.1 45.2 58.1H12.9C5.8 58.1 0 52.3 0 45.2s5.8-12.9 12.9-12.9h32.3z" fill="#36C5F0"/><path d="M96.2 45.2c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9-5.8 12.9-12.9 12.9H96.2V45.2z" fill="#2EB67D"/><path d="M89.7 45.2c0 7.1-5.8 12.9-12.9 12.9S63.9 52.3 63.9 45.2V12.9C63.9 5.8 69.7 0 76.8 0s12.9 5.8 12.9 12.9v32.3z" fill="#2EB67D"/><path d="M76.8 96.2c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9-12.9-5.8-12.9-12.9V96.2h12.9z" fill="#ECB22E"/><path d="M76.8 89.7c-7.1 0-12.9-5.8-12.9-12.9s5.8-12.9 12.9-12.9h32.3c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H76.8z" fill="#ECB22E"/></svg>`;

function renderSlackNotConnected() {
  const scopes = [
    { title: "Post messages as Singularity", detail: "So a confirmed bug can show up in the channel you pick, formatted and ready to act on." },
    { title: "See your channel list", detail: "So you can search and choose which channel each rule posts to." },
    { title: "Look up who’s in a channel", detail: "So we can DM the right person when a rule turns on “also DM the code owner.”" },
  ];
  return `
  <div style="max-width:600px">
    <div style="display:flex;flex-direction:column;align-items:center;text-align:center;margin-bottom:24px">
      <span style="width:58px;height:58px;border-radius:16px;background:var(--bg-sub);border:1px solid var(--border);display:grid;place-items:center;margin-bottom:15px;box-shadow:var(--shadow)">${SLACK_MARK_SVG(30)}</span>
      <h2 style="font-size:20px;font-weight:700;letter-spacing:-.02em;margin:0 0 8px">Route confirmed bugs straight into Slack</h2>
      <p style="font-size:13.5px;line-height:1.6;color:var(--muted);margin:0;max-width:46ch">Connect a workspace and confirmed bugs get posted to the Slack channels you choose &mdash; the moment they're confirmed, instead of sitting in a dashboard waiting to be checked.</p>
    </div>
    <div style="border:1px solid var(--border);border-radius:16px;overflow:hidden;box-shadow:var(--shadow)">
      <div style="padding:15px 20px;border-bottom:1px solid var(--border-soft)"><div style="font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--faint);text-transform:uppercase">What you're granting</div></div>
      ${scopes.map(s => `<div style="display:flex;align-items:flex-start;gap:12px;padding:14px 20px;border-bottom:1px solid var(--border-soft)">
        <span style="width:30px;height:30px;flex:none;border-radius:9px;background:color-mix(in srgb,var(--accent) 11%,transparent);color:var(--accent);display:grid;place-items:center;margin-top:1px">${ICON_SHIELD}</span>
        <div style="min-width:0"><div style="font-size:13.5px;font-weight:600">${escapeHtml(s.title)}</div><div style="font-size:12.5px;color:var(--muted);line-height:1.5;margin-top:2px">${escapeHtml(s.detail)}</div></div>
      </div>`).join("")}
      <div style="display:flex;align-items:center;gap:11px;padding:14px 20px;background:color-mix(in srgb,var(--oc-done) 7%,transparent)">
        ${ICON_CHECK_CIRCLE}
        <span style="font-size:12.5px;color:var(--text);line-height:1.45"><b style="font-weight:600">Singularity only ever posts.</b> <span style="color:var(--muted)">It never reads your messages or channel history &mdash; not now, not ever.</span></span>
      </div>
    </div>
    <div style="display:flex;flex-direction:column;align-items:center;gap:10px;margin-top:22px">
      <button data-act="slack-connect" style="display:inline-flex;align-items:center;gap:11px;height:48px;padding:0 22px 0 18px;border-radius:11px;background:#0a0a0a;color:#fff;font-size:16px;font-weight:600;box-shadow:0 2px 8px rgba(0,0,0,.28)">${SLACK_MARK_SVG(22)}Add to Slack</button>
      <span style="font-size:11.5px;color:var(--faint)">One Slack workspace per account &middot; takes about 20 seconds</span>
    </div>
  </div>`;
}

function renderSlackConnecting() {
  return `
  <div style="max-width:440px;border:1px solid var(--border);border-radius:16px;padding:30px 28px;box-shadow:var(--shadow);text-align:center">
    <span style="width:52px;height:52px;border-radius:14px;background:var(--bg-sub);border:1px solid var(--border);display:inline-grid;place-items:center;margin-bottom:16px">${SLACK_MARK_SVG(26)}</span>
    <div style="font-size:16px;font-weight:600;margin-bottom:4px">Connecting to Slack&hellip;</div>
    <div style="font-size:12.5px;color:var(--muted)">Authorizing in your Slack workspace &mdash; hang tight.</div>
  </div>`;
}

function renderSlackTab() {
  if (state.slackConnecting) return renderSlackConnecting();
  if (!SLACK_STATUS.connected && SLACK_STATUS.status !== "disconnected") return renderSlackNotConnected();
  return renderSlackConnectedShell();
}
```

Note: `renderSlackConnectedShell()` is a stub returning an empty string for this task, replaced with real content in Task 8. Add this stub right after `renderSlackTab()`:

```javascript
function renderSlackConnectedShell() {
  return `<div>Connected view lands in Task 8.</div>`;
}
```

- [ ] **Step 4: Wire the `slack-connect` click and the return-from-OAuth handling**

Find the `document.addEventListener("click", e => {` block that handles `data-act` dispatch (`worker/public/index.html:2111` onward) and its `settings-tab` case (`worker/public/index.html:2148`):

```javascript
  else if (act === "settings-tab") { state.settingsTab = el.dataset.tab; render(); }
```

Insert a new `else if` branch immediately after it:

```javascript
  else if (act === "settings-tab") { state.settingsTab = el.dataset.tab; render(); }
  else if (act === "slack-connect") { window.location.href = "/api/slack/oauth/start"; }
```

Find `async function init()` (search for it, this app's page-load entry point) and add a one-time check for the `?slack=connected` query param OAuth leaves behind, so a fresh return from Slack shows the connecting state briefly then flips to connected without a jarring flash. Add near the top of `init()`, before the main render:

```javascript
  if (new URLSearchParams(window.location.search).get("slack") === "connected") {
    state.settingsTab = "slack";
    window.history.replaceState({}, "", window.location.pathname);
  }
```

- [ ] **Step 5: Deploy**

```bash
cd worker && npx wrangler deploy && cd ..
```

- [ ] **Step 6: Playwright-verify**

Log in (real OTP flow), go to Settings, click the new "Slack" tab, confirm the not-connected screen renders: heading "Route confirmed bugs straight into Slack", the three scope explanations, the trust line about never reading messages, and the black "Add to Slack" button with the real four-color Slack mark rendering (not a broken image, it's inline SVG). Confirm no console errors.

**Deferred:** actually clicking "Add to Slack" and completing OAuth (needs real `SLACK_CLIENT_ID`/`SLACK_CLIENT_SECRET`).

- [ ] **Step 7: Commit**

```bash
git add worker/public/index.html
git commit -m "Add Slack settings tab: scaffold, not-connected screen, connecting screen"
git push
```

---

### Task 8: Frontend — connected/disconnected card, disconnect-confirm modal, rules list

**Files:**
- Modify: `worker/public/index.html`

**Interfaces:**
- Consumes: `SLACK_STATUS`, `SLACK_RULES`, `TAG_PALETTE`/`tagChipHtml`-style escaping discipline, `GOALS`/`TAGS` (for rendering a rule's condition chips by id lookup).
- Produces: real `renderSlackConnectedShell()` (replaces Task 7's stub), `state.slackConfirmDisconnect` (bool), a shared modal-overlay CSS pattern (new to this app, introduced here since none exists yet) reused by Task 9's rule builder.

- [ ] **Step 1: Add the shared modal-overlay CSS**

This app has no existing full-screen modal pattern (confirmed by inspecting the file — no `position:fixed;inset:0` overlay exists anywhere). Add one, matching the design file's exact styling. Find the `<style>` block's end (search for the closing `</style>` tag) and insert before it:

```css
.modal-overlay{position:fixed;inset:0;z-index:60;background:rgba(10,8,6,.44);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;padding:24px}
.modal-overlay.top{align-items:flex-start;padding-top:4vh;overflow-y:auto}
.modal-card{background:var(--bg-elev);border:1px solid var(--border);border-radius:16px;box-shadow:0 24px 70px rgba(0,0,0,.4)}
```

- [ ] **Step 2: Replace the Task 7 stub with the real connected/disconnected view**

Find:

```javascript
function renderSlackConnectedShell() {
  return `<div>Connected view lands in Task 8.</div>`;
}
```

Replace with:

```javascript
function slackRuleChips(rule) {
  const neutral = `display:inline-flex;align-items:center;font-size:11.5px;font-weight:500;padding:3px 9px;border-radius:7px;background:var(--bg-sub);border:1px solid var(--border);color:var(--muted)`;
  const chips = [];
  if (rule.cond.severity.length) chips.push(`<span style="${neutral}">Severity: ${escapeHtml(rule.cond.severity.join(" or "))}</span>`);
  if (rule.cond.outcome.length) chips.push(`<span style="${neutral}">Outcome: ${escapeHtml(rule.cond.outcome.join(" or "))}</span>`);
  if (rule.cond.realBug !== "either") chips.push(`<span style="${neutral}">Real bug: ${rule.cond.realBug === "yes" ? "Yes" : "No"}</span>`);
  if (rule.cond.reachable !== "either") chips.push(`<span style="${neutral}">Reachable: ${rule.cond.reachable === "yes" ? "Yes" : "No"}</span>`);
  rule.cond.goalIds.forEach(id => {
    const g = GOALS.find(x => x.id === id);
    chips.push(`<span style="${neutral}">Goal: ${escapeHtml(g ? g.purpose : "deleted goal")}</span>`);
  });
  rule.cond.tagIds.forEach(id => {
    const t = TAGS.find(x => x.id === id);
    const color = t ? t.color : "#64748b";
    const label = t ? t.label : "deleted tag";
    chips.push(`<span style="display:inline-flex;align-items:center;font-size:11.5px;font-weight:600;padding:3px 9px;border-radius:7px;color:${escapeHtml(color)};background:color-mix(in srgb,${escapeHtml(color)} 13%,transparent);border:1px solid color-mix(in srgb,${escapeHtml(color)} 28%,transparent)">${escapeHtml(label)}</span>`);
  });
  return chips.join("");
}

function renderSlackRuleCard(rule) {
  const disc = SLACK_STATUS.status === "disconnected";
  const inactive = disc || !rule.enabled;
  const on = rule.enabled && !disc;
  const chips = slackRuleChips(rule);
  return `
  <div style="border:1px solid ${rule.orphaned ? "color-mix(in srgb,var(--sev-high) 34%,transparent)" : "var(--border)"};border-radius:13px;padding:15px 17px;background:var(--bg-elev);box-shadow:var(--shadow);${inactive ? "opacity:.66" : ""}">
    <div style="display:flex;align-items:flex-start;gap:12px">
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin-bottom:9px">
          <span style="font-weight:600;font-size:14.5px;${inactive ? "color:var(--muted)" : ""}">${escapeHtml(rule.name)}</span>
          ${!rule.enabled && !disc ? `<span style="font-size:10.5px;font-weight:600;color:var(--faint);background:var(--bg-sub);border:1px solid var(--border);padding:2px 8px;border-radius:20px">Paused</span>` : ""}
          ${rule.orphaned ? `<span style="display:inline-flex;align-items:center;gap:4px;font-size:10.5px;font-weight:600;color:var(--sev-high);background:color-mix(in srgb,var(--sev-high) 13%,transparent);padding:2px 8px;border-radius:20px">${ICON_ALERT}${escapeHtml(rule.orphanReason || "")}</span>` : ""}
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:11px">
          ${chips || `<span style="font-size:12px;color:var(--faint);font-style:italic;align-self:center">Every confirmed task</span>`}
        </div>
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          <span style="display:inline-flex;align-items:center;gap:6px;font-size:12.5px;font-weight:500;color:${inactive ? "var(--faint)" : "var(--muted)"}">${escapeHtml(rule.channelName)}</span>
          ${rule.dmOwner ? `<span style="display:inline-flex;align-items:center;gap:5px;font-size:11.5px;color:var(--muted)">Also DMs the code owner</span>` : ""}
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:4px;flex:none">
        <button data-act="slack-rule-toggle" data-id="${rule.id}" title="${on ? "Pause rule" : "Enable rule"}" style="position:relative;width:34px;height:20px;border-radius:20px;flex:none;background:${on ? "var(--oc-done)" : "var(--border-str)"};${disc ? "opacity:.5;pointer-events:none" : ""}"><span style="position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.3);transform:translateX(${on ? 14 : 0}px)"></span></button>
        <button data-act="slack-rule-edit" data-id="${rule.id}" title="Edit rule" style="width:30px;height:30px;border-radius:8px;display:grid;place-items:center;color:var(--faint)">${ICON_EDIT}</button>
        <button data-act="slack-rule-delete" data-id="${rule.id}" title="Delete rule" style="width:30px;height:30px;border-radius:8px;display:grid;place-items:center;color:var(--faint)">${ICON_TRASH}</button>
      </div>
    </div>
  </div>`;
}

function renderSlackConnectedShell() {
  const disc = SLACK_STATUS.status === "disconnected";
  const ruleCountLabel = SLACK_RULES.length === 1 ? "1 rule" : `${SLACK_RULES.length} rules`;
  return `
  <div>
    ${disc ? `
    <div style="display:flex;align-items:center;gap:11px;padding:12px 16px;border-radius:12px;background:color-mix(in srgb,var(--sev-med) 13%,transparent);border:1px solid color-mix(in srgb,var(--sev-med) 34%,transparent);margin-bottom:16px">
      ${ICON_WARN}
      <span style="font-size:12.5px;line-height:1.45;color:var(--text)"><b style="font-weight:600">Slack disconnected.</b> <span style="color:var(--muted)">Your rules are saved but paused. Reconnect to reactivate them &mdash; nothing was deleted.</span></span>
    </div>` : ""}

    <div style="display:flex;align-items:center;gap:14px;padding:16px 18px;border:1px solid var(--border);border-radius:14px;background:var(--bg-elev);box-shadow:var(--shadow);${disc ? "opacity:.72" : ""}">
      <span style="width:42px;height:42px;flex:none;border-radius:11px;background:${disc ? "var(--faint)" : "#4A154B"};display:grid;place-items:center;color:#fff;font-weight:700;font-size:17px">${escapeHtml((SLACK_STATUS.team_name || "?")[0] || "?")}</span>
      <div style="min-width:0;flex:1">
        <div style="display:flex;align-items:center;gap:9px;flex-wrap:wrap">
          <span style="font-weight:700;font-size:15.5px;letter-spacing:-.01em">${escapeHtml(SLACK_STATUS.team_name || "")}</span>
          ${!disc ? `<span style="display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:600;color:var(--oc-done);background:color-mix(in srgb,var(--oc-done) 13%,transparent);padding:2px 8px;border-radius:20px"><span style="width:6px;height:6px;border-radius:50%;background:var(--oc-done)"></span>Connected</span>` : `<span style="display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:600;color:var(--faint);background:var(--bg-sub);border:1px solid var(--border);padding:2px 8px;border-radius:20px"><span style="width:6px;height:6px;border-radius:50%;background:var(--faint)"></span>Disconnected</span>`}
        </div>
        <div style="font-size:12px;color:var(--muted);margin-top:3px">Connected by <b style="color:var(--text);font-weight:500">${escapeHtml(SLACK_STATUS.connected_by_email || "")}</b></div>
      </div>
      <div style="display:flex;gap:8px;flex:none">
        ${!disc ? `<button data-act="slack-connect" style="display:flex;align-items:center;gap:6px;padding:8px 13px;border:1px solid var(--border-str);border-radius:9px;font-size:12.5px;font-weight:500;color:var(--text)">${ICON_REFRESH}Reconnect</button>` : ""}
        <button data-act="${disc ? "slack-connect" : "slack-ask-disconnect"}" style="${disc ? "display:flex;align-items:center;gap:6px;padding:8px 13px;border-radius:9px;font-size:12.5px;font-weight:600;background:var(--accent);color:var(--accent-fg)" : "display:flex;align-items:center;gap:6px;padding:8px 13px;border:1px solid color-mix(in srgb,var(--sev-high) 40%,transparent);border-radius:9px;font-size:12.5px;font-weight:500;color:var(--sev-high)"}">${disc ? "Reconnect" : "Disconnect"}</button>
      </div>
    </div>

    <div style="display:flex;align-items:flex-start;gap:16px;margin:28px 0 14px">
      <div style="flex:1;min-width:0">
        <div style="font-size:11.5px;color:var(--faint);font-weight:600;letter-spacing:.02em;margin-bottom:4px">ROUTING RULES</div>
        <div style="display:flex;align-items:center;gap:7px;font-size:12.5px;color:var(--muted);line-height:1.5">${ICON_INFO}If a task matches more than one rule, it's sent to <b style="color:var(--text);font-weight:500">every</b> matching channel.</div>
      </div>
      <button data-act="slack-new-rule" style="flex:none;display:flex;align-items:center;gap:6px;padding:8px 13px;border-radius:9px;font-size:12.5px;font-weight:600;background:var(--accent);color:var(--accent-fg)">${ICON_PLUS}New rule</button>
    </div>

    ${SLACK_RULES.length === 0 ? `
    <div style="border:1px dashed var(--border-str);border-radius:14px;padding:38px 22px;text-align:center">
      <div style="font-size:14px;font-weight:600;color:var(--text);margin-bottom:5px">No rules yet</div>
      <div style="font-size:12.5px;color:var(--muted);max-width:38ch;margin:0 auto 16px;line-height:1.5">Nothing is being sent to Slack until you add one. A rule decides which confirmed tasks land in which channel.</div>
      <button data-act="slack-new-rule" style="display:inline-flex;align-items:center;gap:7px;padding:9px 15px;border-radius:9px;background:var(--accent);color:var(--accent-fg);font-size:13px;font-weight:600">${ICON_PLUS}New rule</button>
    </div>` : `
    <div style="display:flex;flex-direction:column;gap:11px">${SLACK_RULES.map(renderSlackRuleCard).join("")}</div>`}
  </div>
  ${state.slackConfirmDisconnect ? `
  <div class="modal-overlay" data-act="slack-cancel-disconnect">
    <div class="modal-card" data-act="slack-stop" style="width:420px;max-width:100%;padding:24px">
      <div style="display:flex;align-items:center;gap:11px;margin-bottom:13px">
        <span style="width:38px;height:38px;flex:none;border-radius:10px;background:color-mix(in srgb,var(--sev-high) 13%,transparent);color:var(--sev-high);display:grid;place-items:center">${ICON_WARN}</span>
        <div style="font-size:16px;font-weight:700;letter-spacing:-.01em">Disconnect Slack?</div>
      </div>
      <p style="font-size:13px;line-height:1.6;color:var(--muted);margin:0 0 20px">This stops all routing immediately &mdash; no confirmed bugs will reach Slack until you reconnect. <b style="color:var(--text);font-weight:500">Your ${ruleCountLabel} are kept, not deleted</b>, and reactivate when you reconnect.</p>
      <div style="display:flex;justify-content:flex-end;gap:9px">
        <button data-act="slack-cancel-disconnect" style="padding:9px 15px;border-radius:9px;font-size:13px;font-weight:500;color:var(--text);border:1px solid var(--border-str)">Keep connected</button>
        <button data-act="slack-do-disconnect" style="padding:9px 16px;border-radius:9px;font-size:13px;font-weight:600;color:#fff;background:var(--sev-high)">Disconnect</button>
      </div>
    </div>
  </div>` : ""}`;
}
```

Note: `ICON_ALERT`, `ICON_WARN`, `ICON_INFO`, `ICON_REFRESH`, `ICON_PLUS`, `ICON_EDIT`, `ICON_TRASH`, `ICON_CHECK_CIRCLE`, `ICON_SHIELD` — check which of these already exist as top-level `const ICON_X = "<svg...>"` constants in this file (several do, per this file's existing icon-constant convention). For any that don't already exist, add them as new `const ICON_NAME = ...` SVG string constants near the file's other `ICON_*` definitions, using simple standard outline-style icons consistent with the file's existing icon set (stroke="currentColor", 15-17px viewboxes, matching the existing icons' visual weight).

- [ ] **Step 3: Wire the new click handlers**

Find the `settings-tab`/`slack-connect` handlers added in Task 7 and extend the same `else if` chain:

`data-act="slack-stop"` (on both modal cards, see the modal markup above) needs a genuine no-op handler — `document.addEventListener("click", ...)` dispatches via `e.target.closest("[data-act]")`, which walks up to the *nearest* `data-act` ancestor: giving the card itself a `data-act` means a click anywhere inside it resolves to the card, never bubbling out to the overlay's `slack-close-builder`/`slack-cancel-disconnect`, while a click on a real interactive element inside the card (a button, an input) still resolves to *that* element's own closer `data-act` first, so nothing inside the modal is blocked. This is this codebase's existing pattern for "click outside to close, click inside to do nothing by default" (the file has zero uses of `stopPropagation`/inline `onclick` anywhere, don't introduce either here):

```javascript
  else if (act === "slack-stop") { /* no-op: absorbs clicks inside a modal card so they don't bubble to the overlay's close handler */ }
  else if (act === "slack-connect") { window.location.href = "/api/slack/oauth/start"; }
  else if (act === "slack-ask-disconnect") { state.slackConfirmDisconnect = true; render(); }
  else if (act === "slack-cancel-disconnect") { state.slackConfirmDisconnect = false; render(); }
  else if (act === "slack-do-disconnect") {
    state.slackConfirmDisconnect = false;
    fetch("/api/slack/disconnect", { method: "POST" }).then(async res => {
      if (res.ok) { SLACK_STATUS = await (await fetch("/api/slack/status")).json(); flash("Slack disconnected — rules kept"); render(); }
    });
  }
  else if (act === "slack-rule-toggle") {
    const id = el.dataset.id;
    fetch(`/api/slack/rules/${id}/toggle`, { method: "POST" }).then(async res => {
      if (res.ok) { SLACK_RULES = await (await fetch("/api/slack/rules")).json(); render(); }
    });
  }
  else if (act === "slack-rule-delete") {
    const id = el.dataset.id;
    fetch(`/api/slack/rules/${id}`, { method: "DELETE" }).then(async res => {
      if (res.ok) { SLACK_RULES = await (await fetch("/api/slack/rules")).json(); flash("Rule deleted"); render(); }
    });
  }
```

(`slack-new-rule` and `slack-rule-edit` are wired in Task 9, they open the rule builder which doesn't exist yet — leave those two `data-act` values unhandled for now, clicking them silently no-ops until Task 9 lands, which is fine mid-plan.)

- [ ] **Step 4: Deploy**

```bash
cd worker && npx wrangler deploy && cd ..
```

- [ ] **Step 5: Playwright-verify**

Log in, go to Settings → Slack. Since there's no real Slack connection yet (deferred pending credentials), this task's connected-state UI can't be exercised against real "connected" data through the normal flow. Instead, verify it directly: temporarily insert a fake `slack_connections` row for the test account via D1 (`status='connected'`, a fake `team_name` like "Test Workspace", no real token needed since no live Slack call happens just from viewing the page), reload, confirm the connected card renders with the right team name, the "Connected" badge, Reconnect/Disconnect buttons, the routing-rules explainer line, and the empty-rules state. Click Disconnect, confirm the confirm-modal appears with the exact copy above, confirm Keep Connected closes it, confirm Disconnect actually flips status (`GET /api/slack/status` returns `disconnected`) and the banner + paused-looking rules render. Clean up the fake row afterward (`DELETE FROM slack_connections WHERE owner_email=...`) so it doesn't linger as fake production data.

- [ ] **Step 6: Commit**

```bash
git add worker/public/index.html
git commit -m "Add Slack connected/disconnected card, disconnect modal, rules list"
git push
```

---

### Task 9: Frontend — rule builder modal, conditions half

**Files:**
- Modify: `worker/public/index.html`

**Interfaces:**
- Consumes: `GOALS`, `TAGS`, `escapeHtml`, the `.modal-overlay`/`.modal-card` CSS (Task 8).
- Produces: `state.slackBuilder` (object or null — the open/closed rule-builder state, shape: `{id, name, cond:{outcome:[], severity:[], realBug:'either', reachable:'either', goalIds:[], tagIds:[]}, channelId:null, channelName:null, dmOwner:false, mode:'new'|'edit'}`), `state.slackGoalQuery`/`slackTagQuery` (search-box text), `renderSlackBuilderModal()` (conditions section only in this task, destination+dry-run appended in Task 10 — the function returns valid HTML on its own after this task so the modal is fully functional for its conditions half even before Task 10 lands, just with a placeholder where destination/dry-run go).

- [ ] **Step 1: Add builder-open/close and condition-patch handlers**

Extend the click-handler chain from Task 8:

```javascript
  else if (act === "slack-new-rule") {
    state.slackBuilder = { id: null, name: "", cond: { outcome: [], severity: [], realBug: "either", reachable: "either", goalIds: [], tagIds: [] }, channelId: null, channelName: null, dmOwner: false, mode: "new" };
    state.slackGoalQuery = ""; state.slackTagQuery = ""; state.slackChannelQuery = ""; state.slackChannels = null; state.slackDryRun = null;
    render();
    loadSlackChannelsForBuilder();
  }
  else if (act === "slack-rule-edit") {
    const rule = SLACK_RULES.find(r => r.id === Number(el.dataset.id));
    if (!rule) return;
    state.slackBuilder = { id: rule.id, name: rule.name, cond: JSON.parse(JSON.stringify(rule.cond)), channelId: rule.channelId, channelName: rule.channelName, dmOwner: rule.dmOwner, mode: "edit" };
    state.slackGoalQuery = ""; state.slackTagQuery = ""; state.slackChannelQuery = ""; state.slackChannels = null; state.slackDryRun = null;
    render();
    loadSlackChannelsForBuilder();
    runSlackDryRun();
  }
  else if (act === "slack-close-builder") { state.slackBuilder = null; render(); }
  else if (act === "slack-toggle-outcome") { slackTogglePillCond("outcome", el.dataset.val); }
  else if (act === "slack-toggle-severity") { slackTogglePillCond("severity", el.dataset.val); }
  else if (act === "slack-set-realbug") { state.slackBuilder.cond.realBug = el.dataset.val; render(); runSlackDryRun(); }
  else if (act === "slack-set-reachable") { state.slackBuilder.cond.reachable = el.dataset.val; render(); runSlackDryRun(); }
  else if (act === "slack-remove-goal") { state.slackBuilder.cond.goalIds = state.slackBuilder.cond.goalIds.filter(id => id !== Number(el.dataset.id)); render(); runSlackDryRun(); }
  else if (act === "slack-remove-tag") { state.slackBuilder.cond.tagIds = state.slackBuilder.cond.tagIds.filter(id => id !== Number(el.dataset.id)); render(); runSlackDryRun(); }
  else if (act === "slack-add-goal") { state.slackBuilder.cond.goalIds = [...state.slackBuilder.cond.goalIds, Number(el.dataset.id)]; state.slackGoalQuery = ""; render(); runSlackDryRun(); }
  else if (act === "slack-add-tag") { state.slackBuilder.cond.tagIds = [...state.slackBuilder.cond.tagIds, Number(el.dataset.id)]; state.slackTagQuery = ""; render(); runSlackDryRun(); }
```

Add these as new top-level functions (near the other Slack functions):

```javascript
function slackTogglePillCond(key, val) {
  const arr = state.slackBuilder.cond[key];
  state.slackBuilder.cond[key] = arr.includes(val) ? arr.filter(x => x !== val) : [...arr, val];
  render();
  runSlackDryRun();
}
```

- [ ] **Step 2: Wire the search-input listeners**

This file's `input` listener (`worker/public/index.html:2204`) dispatches by `e.target.id`, NOT by `data-act` — `data-act` is exclusively the *click*-dispatch convention. Typed fields must use a stable `id` on the `<input>` (wired in Step 3 of `renderSlackConditionsSection` below) and be read inside the existing `withFocusPreserved(...)` wrapper (`worker/public/index.html:2027-2042`), which re-renders and then restores focus + cursor position by looking the same `id` up again post-render. Skipping this wrapper means every keystroke rebuilds the DOM and drops keyboard focus — a real regression this codebase has already hit and fixed once (see the OTP-entry focus bug from the admin-portal build), do not reintroduce it here.

Find the `withFocusPreserved(inner => { ... })(e);` block inside `document.addEventListener("input", ...)` (`worker/public/index.html:2214-2228`):

```javascript
  withFocusPreserved(inner => {
    if (inner.target.id === "sessSearch") { state.search = inner.target.value; }
    else if (inner.target.dataset.noteField && state.correction) {
      state.correction.notes = state.correction.notes || {};
      state.correction.notes[inner.target.dataset.noteField] = inner.target.value;
    }
    else if (inner.target.id === "draftBox") { state.draftText = inner.target.value; }
    else if (inner.target.id === "connApiKeyInput") { state.connApiKey = inner.target.value; state.connError = null; }
    else if (inner.target.id === "knowledgeUrlInput") { state.knowledgeUrl = inner.target.value; }
    else if (inner.target.id === "knowledgeDescInput") { state.knowledgeDesc = inner.target.value; }
    else if (inner.target.id === "goalPurposeInput") { state.goalPurpose = inner.target.value; }
    else if (inner.target.id === "goalDescInput") { state.goalDesc = inner.target.value; }
    else if (inner.target.id === "goalTagsInput") { state.goalTags = inner.target.value; }
    else if (inner.target.id === "tagLabelInput") { state.tagLabel = inner.target.value; }
  })(e);
```

Add four more branches inside that same `withFocusPreserved` callback, immediately before its closing `}`:

```javascript
    else if (inner.target.id === "tagLabelInput") { state.tagLabel = inner.target.value; }
    else if (inner.target.id === "slackNameInput" && state.slackBuilder) { state.slackBuilder.name = inner.target.value; }
    else if (inner.target.id === "slackGoalQueryInput") { state.slackGoalQuery = inner.target.value; }
    else if (inner.target.id === "slackTagQueryInput") { state.slackTagQuery = inner.target.value; }
    else if (inner.target.id === "slackChannelQueryInput") { state.slackChannelQuery = inner.target.value; }
  })(e);
```

Do not add separate `render()` calls after these — `withFocusPreserved` already calls `render()` once for the whole batch after `fn(...args)` runs.

- [ ] **Step 3: Add `renderSlackBuilderModal()` with the name field and 6 condition groups**

```javascript
const SLACK_OUTCOMES = ["completed", "abandoned", "blocked", "unresolved"];
const SLACK_SEVERITIES = ["high", "medium", "low", "none"];
const SLACK_OUTCOME_LABEL = { completed: "Completed", abandoned: "Abandoned", blocked: "Blocked", unresolved: "Unresolved" };
const SLACK_SEVERITY_LABEL = { high: "High", medium: "Medium", low: "Low", none: "None" };

function slackPillStyle(active) {
  return `font-size:12.5px;font-weight:500;padding:6px 12px;border-radius:8px;border:1px solid ${active ? "var(--accent)" : "var(--border-str)"};color:${active ? "var(--accent)" : "var(--text)"};background:${active ? "color-mix(in srgb,var(--accent) 10%,transparent)" : "var(--bg)"}`;
}
function slackSegStyle(active) {
  return `padding:6px 14px;border-radius:7px;font-size:12.5px;font-weight:${active ? 600 : 500};color:${active ? "var(--text)" : "var(--muted)"};background:${active ? "var(--bg-elev)" : "transparent"};box-shadow:${active ? "0 1px 2px rgba(0,0,0,.1)" : "none"}`;
}
function slackGoalChipStyle() {
  return `display:inline-flex;align-items:center;gap:4px;font-size:12px;font-weight:600;line-height:1;padding:5px 9px;border-radius:20px;color:var(--accent);background:color-mix(in srgb,var(--accent) 12%,transparent);border:1px solid color-mix(in srgb,var(--accent) 26%,transparent)`;
}

function renderSlackConditionsSection() {
  const b = state.slackBuilder;
  const outcomeRow = SLACK_OUTCOMES.map(o => `<button data-act="slack-toggle-outcome" data-val="${o}" style="${slackPillStyle(b.cond.outcome.includes(o))}">${SLACK_OUTCOME_LABEL[o]}</button>`).join("");
  const severityRow = SLACK_SEVERITIES.map(s => `<button data-act="slack-toggle-severity" data-val="${s}" style="${slackPillStyle(b.cond.severity.includes(s))}">${SLACK_SEVERITY_LABEL[s]}</button>`).join("");
  const realBugRow = [["Yes", "yes"], ["No", "no"], ["Either", "either"]].map(([l, v]) => `<button data-act="slack-set-realbug" data-val="${v}" style="${slackSegStyle(b.cond.realBug === v)}">${l}</button>`).join("");
  const reachRow = [["Yes", "yes"], ["No", "no"], ["Either", "either"]].map(([l, v]) => `<button data-act="slack-set-reachable" data-val="${v}" style="${slackSegStyle(b.cond.reachable === v)}">${l}</button>`).join("");

  const goalChips = b.cond.goalIds.map(id => {
    const g = GOALS.find(x => x.id === id);
    return `<span style="${slackGoalChipStyle()}">${escapeHtml(g ? g.purpose : "deleted goal")}<button data-act="slack-remove-goal" data-id="${id}" style="display:grid;place-items:center;width:14px;height:14px;margin-left:1px;border-radius:50%;color:currentColor;opacity:.55">${ICON_X_TINY}</button></span>`;
  }).join("");
  const gq = (state.slackGoalQuery || "").toLowerCase();
  const goalMatches = GOALS.filter(g => !b.cond.goalIds.includes(g.id) && (gq === "" || g.purpose.toLowerCase().includes(gq)));

  const tagChips = b.cond.tagIds.map(id => {
    const t = TAGS.find(x => x.id === id);
    const color = t ? t.color : "var(--accent)";
    const label = t ? t.label : "deleted tag";
    return `<span style="display:inline-flex;align-items:center;gap:4px;font-size:12px;font-weight:600;line-height:1;padding:5px 9px;border-radius:20px;color:${escapeHtml(color)};background:color-mix(in srgb,${escapeHtml(color)} 13%,transparent);border:1px solid color-mix(in srgb,${escapeHtml(color)} 28%,transparent)">${escapeHtml(label)}<button data-act="slack-remove-tag" data-id="${id}" style="display:grid;place-items:center;width:14px;height:14px;margin-left:1px;border-radius:50%;color:currentColor;opacity:.55">${ICON_X_TINY}</button></span>`;
  }).join("");
  const tq = (state.slackTagQuery || "").toLowerCase();
  const tagMatches = TAGS.filter(t => !b.cond.tagIds.includes(t.id) && (tq === "" || t.label.toLowerCase().includes(tq)));

  const pickerBox = `display:flex;flex-wrap:wrap;align-items:center;gap:6px;min-height:42px;padding:7px 10px;border-radius:10px;border:1px solid var(--border-str);background:var(--bg)`;

  return `
  <div>
    <label style="display:block;font-size:12px;font-weight:600;color:var(--muted);margin-bottom:7px">Rule name</label>
    <input id="slackNameInput" value="${escapeHtml(b.name)}" placeholder="e.g. Payments escalations" spellcheck="false" style="width:100%;height:42px;padding:0 13px;border-radius:10px;border:1px solid var(--border-str);background:var(--bg);color:var(--text);font-size:14px;outline:none"/>
  </div>
  <div style="margin-top:22px">
    <div style="font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--faint);text-transform:uppercase;margin-bottom:3px">Conditions</div>
    <div style="font-size:12px;color:var(--muted);margin-bottom:15px;line-height:1.5">Leave a group untouched to match <b style="color:var(--text);font-weight:500">any</b> value. Within a group, matches are OR'd; across groups, all must hold.</div>
    <div style="display:flex;flex-direction:column;gap:16px">
      <div style="display:grid;grid-template-columns:130px 1fr;gap:14px;align-items:start"><label style="font-size:13px;font-weight:500;padding-top:6px">Outcome</label><div style="display:flex;flex-wrap:wrap;gap:7px">${outcomeRow}</div></div>
      <div style="display:grid;grid-template-columns:130px 1fr;gap:14px;align-items:start"><label style="font-size:13px;font-weight:500;padding-top:6px">Severity</label><div style="display:flex;flex-wrap:wrap;gap:7px">${severityRow}</div></div>
      <div style="display:grid;grid-template-columns:130px 1fr;gap:14px;align-items:center"><label style="font-size:13px;font-weight:500">Real bug</label><div style="display:inline-flex;gap:2px;background:var(--bg-sub);border:1px solid var(--border);border-radius:9px;padding:3px;width:fit-content">${realBugRow}</div></div>
      <div style="display:grid;grid-template-columns:130px 1fr;gap:14px;align-items:center"><label style="font-size:13px;font-weight:500">Customer reachable</label><div style="display:inline-flex;gap:2px;background:var(--bg-sub);border:1px solid var(--border);border-radius:9px;padding:3px;width:fit-content">${reachRow}</div></div>
      <div style="display:grid;grid-template-columns:130px 1fr;gap:14px;align-items:start"><label style="font-size:13px;font-weight:500;padding-top:6px">Goals</label><div>
        <div style="${pickerBox}">${goalChips}<input id="slackGoalQueryInput" value="${escapeHtml(state.slackGoalQuery || "")}" placeholder="${b.cond.goalIds.length ? "Add another…" : "Search goals…"}" spellcheck="false" style="flex:1;min-width:120px;height:26px;background:none;border:none;outline:none;color:var(--text);font-size:13px"/></div>
        ${gq ? `<div style="margin-top:6px;border:1px solid var(--border);border-radius:10px;background:var(--bg-elev);box-shadow:var(--shadow);overflow:hidden;max-height:172px;overflow-y:auto">${goalMatches.length ? goalMatches.map(g => `<button data-act="slack-add-goal" data-id="${g.id}" style="display:flex;align-items:center;gap:9px;width:100%;padding:9px 13px;text-align:left;font-size:13px;border-bottom:1px solid var(--border-soft)">${escapeHtml(g.purpose)}</button>`).join("") : `<div style="padding:10px 13px;font-size:12.5px;color:var(--faint)">No goals match "${escapeHtml(state.slackGoalQuery)}".</div>`}</div>` : ""}
      </div></div>
      <div style="display:grid;grid-template-columns:130px 1fr;gap:14px;align-items:start"><label style="font-size:13px;font-weight:500;padding-top:6px">Tags</label><div>
        <div style="${pickerBox}">${tagChips}<input id="slackTagQueryInput" value="${escapeHtml(state.slackTagQuery || "")}" placeholder="${b.cond.tagIds.length ? "Add another…" : "Search tags…"}" spellcheck="false" style="flex:1;min-width:120px;height:26px;background:none;border:none;outline:none;color:var(--text);font-size:13px"/></div>
        ${tq ? `<div style="margin-top:6px;border:1px solid var(--border);border-radius:10px;background:var(--bg-elev);box-shadow:var(--shadow);overflow:hidden;max-height:172px;overflow-y:auto">${tagMatches.length ? tagMatches.map(t => `<button data-act="slack-add-tag" data-id="${t.id}" style="display:flex;align-items:center;gap:9px;width:100%;padding:9px 13px;text-align:left;font-size:13px;border-bottom:1px solid var(--border-soft)"><span style="width:9px;height:9px;border-radius:3px;flex:none;background:${escapeHtml(t.color)}"></span>${escapeHtml(t.label)}</button>`).join("") : `<div style="padding:10px 13px;font-size:12.5px;color:var(--faint)">No tags match "${escapeHtml(state.slackTagQuery)}".</div>`}</div>` : ""}
      </div></div>
    </div>
  </div>`;
}

function renderSlackBuilderModal() {
  const b = state.slackBuilder;
  if (!b) return "";
  return `
  <div class="modal-overlay top" data-act="slack-close-builder">
    <div class="modal-card" data-act="slack-stop" style="width:640px;max-width:100%;margin:auto;overflow:hidden">
      <div style="display:flex;align-items:center;gap:12px;padding:18px 22px;border-bottom:1px solid var(--border)">
        <span style="width:32px;height:32px;flex:none;border-radius:9px;background:var(--bg-sub);border:1px solid var(--border);display:grid;place-items:center">${SLACK_MARK_SVG(17)}</span>
        <div style="font-size:15.5px;font-weight:700;letter-spacing:-.01em">${b.mode === "edit" ? "Edit rule" : "New rule"}</div>
        <button data-act="slack-close-builder" title="Close" style="margin-left:auto;width:30px;height:30px;border-radius:8px;display:grid;place-items:center;color:var(--faint)">${ICON_X_TINY}</button>
      </div>
      <div style="padding:22px;display:flex;flex-direction:column;gap:22px;max-height:70vh;overflow-y:auto">
        ${renderSlackConditionsSection()}
        <div style="height:1px;background:var(--border)"></div>
        <div id="slack-destination-slot">${typeof renderSlackDestinationSection === "function" ? renderSlackDestinationSection() : ""}</div>
      </div>
      <div style="display:flex;align-items:center;gap:10px;padding:16px 22px;border-top:1px solid var(--border);background:var(--bg-sub)">
        <span style="font-size:12px;color:var(--faint)">Saving activates this rule right away.</span>
        <div style="margin-left:auto;display:flex;gap:9px">
          <button data-act="slack-close-builder" style="padding:9px 15px;border-radius:9px;font-size:13px;font-weight:500;color:var(--text);border:1px solid var(--border-str)">Cancel</button>
          ${typeof slackSaveButtonHtml === "function" ? slackSaveButtonHtml() : ""}
        </div>
      </div>
    </div>
  </div>`;
}
```

Note the `typeof renderSlackDestinationSection === "function"` guard: this task ships before Task 10 adds that function, so the modal degrades gracefully (destination section and save button simply don't render yet) rather than throwing a `ReferenceError` if these two tasks are ever deployed independently. Once Task 10 lands, both guards resolve true and the modal is complete.

- [ ] **Step 4: Render the modal from the main render tree**

Find where `renderSlackTab()` is called from `renderSettings()` (Task 7) and find this app's top-level `render()` function (`worker/public/index.html:2007` area) where other modals/toasts are appended to `app.innerHTML`. Add the builder modal there so it overlays the whole app, not just the settings panel:

Find (`worker/public/index.html`, inside `render()`):

```javascript
    ${state.toast ? `<div class="toast">${ICON_CHECKMARK}${escapeHtml(state.toast)}</div>` : ""}
```

Replace with:

```javascript
    ${state.toast ? `<div class="toast">${ICON_CHECKMARK}${escapeHtml(state.toast)}</div>` : ""}
    ${state.slackBuilder ? renderSlackBuilderModal() : ""}
```

(There will likely be two occurrences of the toast line in `render()` — one for the logged-out shell, one for the logged-in app. Only add the builder-modal line after the logged-in occurrence, the builder can only ever be open while authenticated.)

- [ ] **Step 5: Deploy**

```bash
cd worker && npx wrangler deploy && cd ..
```

- [ ] **Step 6: Playwright-verify**

With the same temporary fake `slack_connections` row approach as Task 8 (or reuse one if still present from that task's verification and not yet cleaned up), open the rules list, click "New rule", confirm the modal opens with the name field and all 6 condition groups rendering correctly: click a few outcome/severity pills and confirm they toggle visually (border/background change), click the Real bug and Customer reachable segmented controls and confirm the active segment highlights, type into the Goals search box and confirm real goals from `GOALS` filter live and clicking one adds a chip, do the same for Tags and confirm the tag chip renders with the tag's real color. Confirm closing the modal (X button or clicking the overlay) clears `state.slackBuilder` and the modal disappears. Confirm no console errors even though the destination section is still a no-op at this point in the plan.

- [ ] **Step 7: Commit**

```bash
git add worker/public/index.html
git commit -m "Add Slack rule builder modal: name and condition groups"
git push
```

---

### Task 10: Frontend — rule builder destination, dry-run, save

**Files:**
- Modify: `worker/public/index.html`

**Interfaces:**
- Consumes: `GET /api/slack/channels` (Task 3), `POST /api/slack/dry-run` (Task 5), `POST /api/slack/rules` / `PATCH /api/slack/rules/:id` (Task 4), `state.slackBuilder` (Task 9).
- Produces: `state.slackChannels` (array or null, fetched once per builder-open), `state.slackDryRun` (`{total, matches}` or null), `loadSlackChannelsForBuilder()`, `runSlackDryRun()` (both referenced as forward calls from Task 9's click handlers), `renderSlackDestinationSection()`, `slackSaveButtonHtml()` (both referenced via the `typeof` guards in Task 9's modal).

- [ ] **Step 1: Add the channel-loading and dry-run functions**

```javascript
async function loadSlackChannelsForBuilder() {
  const res = await fetch("/api/slack/channels");
  if (res.ok) { state.slackChannels = await res.json(); render(); }
  else { state.slackChannels = []; render(); }
}

let _slackDryRunTimer = null;
function runSlackDryRun() {
  clearTimeout(_slackDryRunTimer);
  _slackDryRunTimer = setTimeout(async () => {
    if (!state.slackBuilder) return;
    const res = await fetch("/api/slack/dry-run", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ cond: state.slackBuilder.cond }),
    });
    if (res.ok) { state.slackDryRun = await res.json(); render(); }
  }, 300);
}
```

Call `runSlackDryRun()` once immediately when the builder first opens too — find the `slack-new-rule` handler added in Task 9 and add a call at the end (after the existing `loadSlackChannelsForBuilder()` call):

```javascript
  else if (act === "slack-new-rule") {
    state.slackBuilder = { id: null, name: "", cond: { outcome: [], severity: [], realBug: "either", reachable: "either", goalIds: [], tagIds: [] }, channelId: null, channelName: null, dmOwner: false, mode: "new" };
    state.slackGoalQuery = ""; state.slackTagQuery = ""; state.slackChannelQuery = ""; state.slackChannels = null; state.slackDryRun = null;
    render();
    loadSlackChannelsForBuilder();
    runSlackDryRun();
  }
```

- [ ] **Step 2: Add the destination section, DM toggle, and dry-run panel**

```javascript
function renderSlackDestinationSection() {
  const b = state.slackBuilder;
  const cq = (state.slackChannelQuery || "").toLowerCase();
  const channels = state.slackChannels || [];
  const channelMatches = channels.filter(c => cq === "" || c.name.toLowerCase().includes(cq));

  let channelHtml;
  if (b.channelId) {
    const meta = channels.find(c => c.id === b.channelId);
    channelHtml = `<div style="display:flex;align-items:center;gap:10px;padding:11px 14px;border:1px solid var(--border-str);border-radius:10px;background:var(--bg-sub)">
      <span style="font-weight:600;font-size:13.5px">${escapeHtml(b.channelName)}</span>
      <span style="font-size:11.5px;color:var(--faint)">${meta ? meta.num_members + " members" : ""}</span>
      <button data-act="slack-clear-channel" style="margin-left:auto;font-size:12px;color:var(--accent);font-weight:500">Change</button>
    </div>`;
  } else {
    channelHtml = `<div>
      <div style="display:flex;align-items:center;gap:9px;height:42px;padding:0 13px;border-radius:10px;border:1px solid var(--border-str);background:var(--bg)">
        <input id="slackChannelQueryInput" value="${escapeHtml(state.slackChannelQuery || "")}" placeholder="Search channels…" spellcheck="false" style="flex:1;min-width:0;background:none;border:none;outline:none;color:var(--text);font-size:13.5px"/>
      </div>
      <div style="margin-top:6px;border:1px solid var(--border);border-radius:10px;background:var(--bg-elev);box-shadow:var(--shadow);overflow:hidden;max-height:190px;overflow-y:auto">
        ${channels === null ? `<div style="padding:11px 13px;font-size:12.5px;color:var(--faint)">Loading channels…</div>`
          : channelMatches.length ? channelMatches.map(c => `<button data-act="slack-pick-channel" data-id="${escapeHtml(c.id)}" data-name="${escapeHtml(c.name)}" style="display:flex;align-items:center;gap:10px;width:100%;padding:10px 13px;text-align:left;border-bottom:1px solid var(--border-soft)"><span style="font-weight:500;font-size:13.5px">${escapeHtml(c.name)}</span><span style="margin-left:auto;font-size:11.5px;color:var(--faint)">${c.num_members} members</span></button>`).join("")
          : `<div style="padding:11px 13px;font-size:12.5px;color:var(--faint)">No channels match "${escapeHtml(state.slackChannelQuery)}".</div>`}
      </div>
    </div>`;
  }

  const dm = !!b.dmOwner;
  const dryRun = state.slackDryRun;
  const zero = dryRun && dryRun.total === 0;

  return `
  <div>
    <div style="font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--faint);text-transform:uppercase;margin-bottom:12px">Destination</div>
    <label style="display:block;font-size:13px;font-weight:500;margin-bottom:8px">Channel</label>
    ${channelHtml}
    <div style="display:flex;align-items:flex-start;gap:12px;margin-top:16px;padding:13px 15px;border:1px solid var(--border);border-radius:11px">
      <button data-act="slack-toggle-dm" style="position:relative;width:38px;height:22px;border-radius:20px;flex:none;margin-top:1px;background:${dm ? "var(--oc-done)" : "var(--border-str)"}"><span style="position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.3);transform:translateX(${dm ? 16 : 0}px)"></span></button>
      <div style="min-width:0"><div style="font-size:13.5px;font-weight:600">Also DM the code owner</div><div style="font-size:12px;color:var(--muted);line-height:1.5;margin-top:2px">Also sends a direct message to whoever last touched the relevant code, when we can determine that.</div></div>
    </div>
  </div>
  <div style="padding:15px 16px;border-radius:12px;background:${zero ? "var(--bg-sub)" : "color-mix(in srgb,var(--accent) 5%,transparent)"};border:1px solid ${zero ? "var(--border)" : "color-mix(in srgb,var(--accent) 22%,transparent)"}">
    <div style="display:flex;align-items:center;gap:9px;margin-bottom:${zero ? "6px" : "11px"}">
      ${ICON_SPARKLE}
      <span style="font-size:13px;font-weight:600;color:var(--text)">${dryRun ? `This rule would have matched ${dryRun.total} of the last 50 tasks.` : "Checking recent tasks…"}</span>
    </div>
    ${dryRun && dryRun.total > 0 ? `<div style="display:flex;flex-direction:column;gap:1px;border:1px solid var(--border);border-radius:10px;overflow:hidden">${dryRun.matches.map(t => `<div style="display:flex;align-items:center;gap:10px;padding:9px 13px;background:var(--bg-elev)"><span style="flex:1;min-width:0;font-size:12.5px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(t.title)}</span><span style="font-size:11px;font-weight:500;flex:none">${escapeHtml(t.severity)}</span><span style="font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--faint);flex:none;width:46px;text-align:right">${escapeHtml(t.when)}</span></div>`).join("")}${dryRun.total > 4 ? `<div style="padding:8px 13px;font-size:11.5px;color:var(--faint);background:var(--bg-elev);border-top:1px solid var(--border-soft)">+ ${dryRun.total - 4} more match${dryRun.total - 4 === 1 ? "" : "es"}</div>` : ""}</div>` : ""}
    ${zero ? `<div style="font-size:12px;color:var(--faint);line-height:1.5">No recent matches &mdash; that's fine if this rule is meant to be rare. It'll fire the next time a task fits.</div>` : ""}
  </div>`;
}

function slackSaveButtonHtml() {
  const b = state.slackBuilder;
  const ready = !!(b.name.trim() && b.channelId);
  return `<button data-act="slack-save-rule" style="padding:9px 17px;border-radius:9px;font-size:13px;font-weight:600;color:var(--accent-fg);background:var(--accent);opacity:${ready ? 1 : .45};pointer-events:${ready ? "auto" : "none"}">${b.mode === "edit" ? "Save changes" : "Create rule"}</button>`;
}
```

Check whether `ICON_SPARKLE` already exists as a top-level constant in this file (this app uses sparkle-style icons elsewhere for AI-related affordances per earlier features built this session); if not, add it as a small 4-point-star SVG matching the file's existing icon style.

- [ ] **Step 3: Wire the remaining click handlers**

Extend the click-handler chain:

```javascript
  else if (act === "slack-pick-channel") { state.slackBuilder.channelId = el.dataset.id; state.slackBuilder.channelName = el.dataset.name; state.slackChannelQuery = ""; render(); }
  else if (act === "slack-clear-channel") { state.slackBuilder.channelId = null; state.slackBuilder.channelName = null; state.slackChannelQuery = ""; render(); }
  else if (act === "slack-toggle-dm") { state.slackBuilder.dmOwner = !state.slackBuilder.dmOwner; render(); }
  else if (act === "slack-save-rule") { saveSlackRule(); }
```

Add the save function:

```javascript
async function saveSlackRule() {
  const b = state.slackBuilder;
  if (!b || !b.name.trim() || !b.channelId) return;
  const payload = { name: b.name.trim(), channelId: b.channelId, channelName: b.channelName, dmOwner: b.dmOwner, cond: b.cond };
  const res = b.mode === "edit"
    ? await fetch(`/api/slack/rules/${b.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) })
    : await fetch("/api/slack/rules", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  if (res.ok) {
    SLACK_RULES = await (await fetch("/api/slack/rules")).json();
    flash(b.mode === "edit" ? "Rule updated" : `Rule added — routing to ${b.channelName}`);
    state.slackBuilder = null;
    render();
  } else {
    flash("Could not save rule");
  }
}
```

- [ ] **Step 4: Deploy**

```bash
cd worker && npx wrangler deploy && cd ..
```

- [ ] **Step 5: Playwright-verify end to end (the fullest check in this plan)**

Using the temporary fake `slack_connections` row again: open the rule builder, confirm the channel search box loads (it'll show "Loading channels…" then, since there's no real Slack token, the `GET /api/slack/channels` call returns 400 "Slack not connected" — confirm this degrades to an empty results list without a JS error, not a crash). Since a real channel can't be picked without a real connection, directly exercise the save-readiness logic instead: confirm the Save button is disabled (`opacity:.45`, `pointer-events:none`) with no name/channel filled in, type a name, confirm it's still disabled (no channel), then use `page.evaluate` to directly set `state.slackBuilder.channelId`/`channelName` to a fake value and call `render()` (simulating a channel pick without needing a real Slack channel list), confirm the Save button becomes enabled and clicking it actually calls `POST /api/slack/rules` and a real row lands in `slack_rules` — confirm via a direct D1 query. Confirm the dry-run panel shows a real, correct count against real D1 task data (cross-check against Task 5's dry-run route tested directly). Delete the test rule and the fake `slack_connections` row afterward via D1 so nothing fake is left in production data.

**Deferred pending real Slack credentials:** the real channel-search dropdown actually populating with real channels, and picking one through the real UI rather than the `page.evaluate` shortcut above.

- [ ] **Step 6: Commit**

```bash
git add worker/public/index.html
git commit -m "Add Slack rule builder destination, dry-run, and save"
git push
```

---

### Task 11: Final integration pass + deferred-verification checklist

**Files:**
- None (verification-only task; may produce a small follow-up commit if this pass surfaces a real bug).

**Interfaces:**
- Consumes: everything built in Tasks 1-10.

- [ ] **Step 1: Full Playwright walkthrough of everything that's testable without real Slack credentials**

Log in fresh, navigate Settings → Slack from a clean (no `slack_connections` row) state: confirm the not-connected screen. Insert a fake connected row, reload, confirm the connected view, rules list, new-rule flow through to a saved rule (using the `page.evaluate` channel-pick shortcut from Task 10 since no real channel list exists yet), edit that rule, confirm the builder pre-fills its existing conditions correctly, toggle it off/on from the rules list, delete it. Disconnect, confirm the banner and paused rendering; reconnect (which redirects toward the real OAuth start — confirm the redirect target is correct even though completing it needs real credentials). Confirm zero console errors across the entire walkthrough. Clean up all fake D1 rows created during this pass.

- [ ] **Step 2: Confirm the report-push failure-isolation guarantee one more time under a more realistic shape**

Push a synthetic report (same technique as Task 6 Step 5) for an owner who DOES have a `slack_connections` row with `status='connected'` but an intentionally garbage/undecryptable token (or a syntactically valid but fake token that Slack will reject with `invalid_auth`), confirm the report push still returns `{"ok":true}` — this proves the try/catch in `postSlackNotifications` genuinely isolates a real Slack API rejection, not just the "no connection at all" case Task 6 already covered. Clean up the fake connection row and report row afterward.

- [ ] **Step 3: Write and hand back the deferred-verification checklist**

Produce a short plain list (in your task report, not a new file) of every check across Tasks 2, 3, 6, 8, 9, 10 that was explicitly marked "deferred pending real Slack credentials," so whoever picks this up once `SLACK_CLIENT_ID`/`SLACK_CLIENT_SECRET` exist has a single consolidated list to work through rather than re-reading all ten prior tasks.

- [ ] **Step 4: Commit (only if Step 1 or 2 surfaced and you fixed a real bug)**

```bash
git add -A
git commit -m "Fix issues found in Slack integration final verification pass"
git push
```

If nothing needed fixing, skip this step, there is nothing to commit.

---

## Self-Review

**Spec coverage:**
- Real OAuth (v2, one workspace per account) → Task 2.
- Encrypted token storage via existing `encryptSecret`/`decryptSecret` → Task 2.
- Real channel listing → Task 3.
- Disconnect keeps rules, clears token → Task 3.
- Rule CRUD + orphan detection by real `goal_id`/`tag_id` → Task 4.
- Real matching engine ported from `slMatch`, shared by dry-run and live posting → Task 5, consumed by Task 6 and Task 10.
- Real-time posting hooked into both report-push routes, fan-out to every matching rule, best-effort/never-fails-the-push → Task 6.
- Full frontend port of every screen in the design (not-connected, connecting, connected/disconnected, disconnect-confirm, rules list, rule builder with all 6 condition groups + destination + dry-run) → Tasks 7-10.
- Non-goals respected: no interactive Block Kit buttons (Task 6's message has no `actions` block), no owner-DM sending logic (the toggle exists and is stored, nothing sends a DM), no threading, no multi-workspace (schema is `owner_email PRIMARY KEY`, structurally enforces one row per account), no conversational query surface — none of these appear anywhere in Tasks 1-11.
- Slack App prerequisite surfaced explicitly in Global Constraints and in every task whose full verification depends on it, plus consolidated in Task 11.

**Placeholder scan:** no "TBD"/"add appropriate X"/"similar to the design file" patterns — every step has literal, complete code. The two `typeof` guards in Task 9 (`renderSlackDestinationSection`, `slackSaveButtonHtml`) are not placeholders in the forbidden sense, they're a deliberate, real inter-task compatibility shim so Task 9 alone still produces a working (if visually incomplete) modal, explicitly explained inline.

**Type/interface consistency:** `state.slackBuilder.cond` shape (`{outcome, severity, realBug, reachable, goalIds, tagIds}`) is identical across Tasks 9 and 10. The rules list's rendered shape (`{id, name, enabled, cond, channelId, channelName, dmOwner, orphaned, orphanReason}`) from Task 4's `GET /api/slack/rules` matches exactly what Task 8's `renderSlackRuleCard`/`slackRuleChips` and Task 9's edit-prefill (`slack-rule-edit` handler) both consume. `slackRuleMatches(task, rule)` — Task 5's definition and Task 6's call site both pass the same D1-row-shaped `rule` object (raw `cond_*` string/JSON columns, not the frontend's camelCase `cond` object), consistent throughout.
