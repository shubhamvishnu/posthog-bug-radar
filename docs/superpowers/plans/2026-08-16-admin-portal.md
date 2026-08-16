# Admin Portal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a standalone, read-only admin portal — a second Cloudflare Worker (`bug-radar-admin`, directory `worker-admin/`) sharing the main app's D1 database — that lets `shubhamvishnu@gmail.com` see every tenant's connections, reports, goals, tags, corrections, and audit log, plus one narrow new media-proxy route on the existing main Worker.

**Architecture:** Two independent Cloudflare Workers, one shared D1 database (`bug-radar-db`). `worker-admin/src/index.js` is a close port of `worker/src/index.js`'s OTP/session auth (same tables, same cookie mechanics, different cookie name and one restriction: `request-otp` 404s for any email but the admin's), plus five new read-only routes (`/api/overview`, `/api/events`, `/api/users`, `/api/users/:email`, `/api/media/:key`) that only ever `SELECT`. `worker-admin` never gets `CONNECTION_ENCRYPTION_KEY` or `BUGRADAR_API_SECRET` — it has no pipeline routes and never decrypts a connection's API key. Captured-moment images are proxied through a new secret-gated route on the *main* Worker (`GET /api/admin/media/:key`), because only the main Worker holds the R2 `MEDIA` binding. The admin frontend (`worker-admin/public/index.html`) is a new, small, single-file vanilla-JS page — not a fork of the main app's SPA — that reuses the main app's CSS custom-property tokens, font stack, login two-step flow, audit-log row layout, connection-card layout, tag-chip/goal-badge layout, and task-card layout, with every interactive/mutating affordance stripped (this page only ever does `GET`).

**Tech Stack:** Cloudflare Workers + D1 (`worker/src/index.js`, `worker-admin/src/index.js`), vanilla-JS frontend with manual `render()` dispatch (`worker/public/index.html`, `worker-admin/public/index.html`), no build step, no framework, no unit test framework — verification is real curl / `wrangler d1 execute --remote` / Playwright.

**Spec:** `docs/superpowers/specs/2026-08-16-admin-portal-design.md`

## Global Constraints

- No unit test framework anywhere in this codebase — verification is real calls: curl, `wrangler d1 execute --remote --command "..."` (needs `CLOUDFLARE_ACCOUNT_ID=ad1a4dda1125569690132b861f95a63a` set in the environment), and Playwright. Every task's Verify step follows this.
- D1 database name: `bug-radar-db`, `database_id: 65292c22-00df-42a0-ad9b-b5bb97dee409` (confirmed against `worker/wrangler.jsonc`), shared by both Workers via the same `DB` binding. No new tables — every admin route is a read over existing tables.
- Cloudflare `account_id`: `ad1a4dda1125569690132b861f95a63a` (same for both Workers).
- Deployed main-Worker URL: `https://bug-radar.shubhamvishnu.workers.dev`. New admin-Worker URL: `https://bug-radar-admin.shubhamvishnu.workers.dev`.
- Deploy pattern for both Workers: `cd <dir> && npx wrangler deploy` (no local `wrangler` binary or `package.json` needed — `worker/` has neither and deploys fine via `npx`; `worker-admin/` follows the same pattern).
- Admin login is restricted to exactly `shubhamvishnu@gmail.com` — every data route on `worker-admin` is `GET`-only and gated by `adminAuthed(request, env)`; `request-otp` additionally 404s (`{"error":"not found"}`) for any other email before generating or sending a code.
- `worker-admin` never receives `CONNECTION_ENCRYPTION_KEY` or `BUGRADAR_API_SECRET` as secrets — it has no capability to decrypt a connection's API key and no pipeline routes.
- Secrets are set via `wrangler secret put <NAME>` inside each Worker's own directory (interactive prompt). Never echo a secret value into command output or into this plan.
- This project works directly on `main`, no feature branches — commit each task directly, and push to `origin/main` after each commit (standing project convention, confirmed via `git log` on this repo).
- `connection_events.status` values map to exactly four strings: `success`, `warning`, `error`, `info` — reuse these, don't invent new ones.

---

### Task 1: Main worker — `ADMIN_MEDIA_SECRET` + `GET /api/admin/media/:key`

**Files:**
- Modify: `worker/src/index.js:714-729` (insert new route immediately after the existing `mediaMatch` block)

**Interfaces:**
- Consumes: `env.MEDIA` (R2 binding, already present in `worker/wrangler.jsonc`), `env.ADMIN_MEDIA_SECRET` (new secret, set in Step 1).
- Produces: `GET /api/admin/media/:key` — `Authorization: Bearer <ADMIN_MEDIA_SECRET>` gated, returns the raw image bytes with the same `content-type`/`cache-control` headers as `/api/media/:key`, 401 on missing/bad auth, 404 if the key doesn't exist in R2. Task 6 (`worker-admin`'s own `/api/media/:key`) calls this route server-to-server.

- [ ] **Step 1: Generate and set the `ADMIN_MEDIA_SECRET` secret**

```bash
openssl rand -hex 32
```

Copy the output (do not paste it into chat or a file), then:

```bash
cd worker && npx wrangler secret put ADMIN_MEDIA_SECRET
```

Paste the generated value at the prompt. Keep it — Task 6 needs the identical value set on `worker-admin`.

- [ ] **Step 2: Add the new route**

In `worker/src/index.js`, find the end of the existing `mediaMatch` block:

```javascript
    const mediaMatch = pathname.match(/^\/api\/media\/(.+)$/);
    if (mediaMatch && request.method === "GET") {
      const email = await getSessionEmail(request, env);
      if (!email) return json({ error: "not authenticated" }, 401);
      const key = mediaMatch[1];
      const keyOwner = key.split("/")[1];
      if (!keyOwner || decodeURIComponent(keyOwner) !== email) return json({ error: "not found" }, 404);
      const obj = await env.MEDIA.get(key);
      if (!obj) return json({ error: "not found" }, 404);
      return new Response(obj.body, {
        headers: {
          "content-type": obj.httpMetadata?.contentType || "image/png",
          "cache-control": "private, max-age=31536000, immutable",
        },
      });
    }

    if (pathname === "/api/prompts" && request.method === "GET") {
```

Insert the new block between the closing `}` of `mediaMatch` and the `/api/prompts` route:

```javascript
    const mediaMatch = pathname.match(/^\/api\/media\/(.+)$/);
    if (mediaMatch && request.method === "GET") {
      const email = await getSessionEmail(request, env);
      if (!email) return json({ error: "not authenticated" }, 401);
      const key = mediaMatch[1];
      const keyOwner = key.split("/")[1];
      if (!keyOwner || decodeURIComponent(keyOwner) !== email) return json({ error: "not found" }, 404);
      const obj = await env.MEDIA.get(key);
      if (!obj) return json({ error: "not found" }, 404);
      return new Response(obj.body, {
        headers: {
          "content-type": obj.httpMetadata?.contentType || "image/png",
          "cache-control": "private, max-age=31536000, immutable",
        },
      });
    }

    const adminMediaMatch = pathname.match(/^\/api\/admin\/media\/(.+)$/);
    if (adminMediaMatch && request.method === "GET") {
      const auth = request.headers.get("authorization") || "";
      if (auth !== `Bearer ${env.ADMIN_MEDIA_SECRET}`) return json({ error: "unauthorized" }, 401);
      const key = adminMediaMatch[1];
      const obj = await env.MEDIA.get(key);
      if (!obj) return json({ error: "not found" }, 404);
      return new Response(obj.body, {
        headers: {
          "content-type": obj.httpMetadata?.contentType || "image/png",
          "cache-control": "private, max-age=31536000, immutable",
        },
      });
    }

    if (pathname === "/api/prompts" && request.method === "GET") {
```

- [ ] **Step 3: Deploy**

```bash
cd worker && npx wrangler deploy && cd ..
```

- [ ] **Step 4: Verify the 401 paths**

```bash
curl -s -o /dev/null -w "%{http_code}\n" "https://bug-radar.shubhamvishnu.workers.dev/api/admin/media/some-key"
curl -s -o /dev/null -w "%{http_code}\n" "https://bug-radar.shubhamvishnu.workers.dev/api/admin/media/some-key" -H "Authorization: Bearer wrong-secret"
```

Expected: both `401`.

- [ ] **Step 5: Find a real stored media key and verify the success path**

```bash
CLOUDFLARE_ACCOUNT_ID=ad1a4dda1125569690132b861f95a63a npx wrangler d1 execute bug-radar-db --remote --command "SELECT micro_findings FROM reports ORDER BY id DESC LIMIT 5" --json | grep -o '/api/media/[^"\\]*' | head -1
```

If a key comes back (strip the `/api/media/` prefix to get the raw key):

```bash
SECRET=$(security find-generic-password -s "ADMIN_MEDIA_SECRET" -w 2>/dev/null) # only if you stored it in Keychain; otherwise use the value from Step 1
curl -s -o /tmp/admin-media-test.png -w "%{http_code}\n" "https://bug-radar.shubhamvishnu.workers.dev/api/admin/media/<real-key>" -H "Authorization: Bearer $SECRET"
file /tmp/admin-media-test.png
```

Expected: `200`, and `file` reports a real PNG/image, not JSON. If no media key exists yet in this environment, confirm the 404 path instead (`curl` a made-up key with the correct secret → `404`) and note in your task report that the 200 path needs re-verification once real captured-moment data exists (this is picked back up in Task 6's verification).

- [ ] **Step 6: Commit**

```bash
git add worker/src/index.js
git commit -m "Add secret-gated admin media proxy route on the main worker"
git push
```

---

### Task 2: Scaffold `worker-admin` — auth flow + placeholder frontend

**Files:**
- Create: `worker-admin/wrangler.jsonc`
- Create: `worker-admin/src/index.js`
- Create: `worker-admin/public/index.html`

**Interfaces:**
- Consumes: shared D1 tables `users`, `otp_codes`, `sessions` (`worker/schema.sql`).
- Produces: `ADMIN_EMAIL` constant (`"shubhamvishnu@gmail.com"`); `async function adminAuthed(request, env)` → `boolean` (every later route in Tasks 3–6 calls this first); `SESSION_COOKIE = "bugradar_admin_session"`; routes `POST /api/auth/request-otp`, `POST /api/auth/verify-otp`, `GET /api/auth/me`, `POST /api/auth/logout`; a stub `GET /api/overview` returning `{"ok":true}` (Task 3 replaces its body with the real implementation — same route, same match condition, so no other task needs to change).

- [ ] **Step 1: Create `worker-admin/wrangler.jsonc`**

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "bug-radar-admin",
  "main": "src/index.js",
  "compatibility_date": "2025-08-01",
  "account_id": "ad1a4dda1125569690132b861f95a63a",
  "assets": {
    "directory": "./public",
    "binding": "ASSETS"
  },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "bug-radar-db",
      "database_id": "65292c22-00df-42a0-ad9b-b5bb97dee409"
    }
  ],
  "vars": {
    "RESEND_FROM": "Bug Radar Admin <login@revsight.io>",
    "MAIN_WORKER_URL": "https://bug-radar.shubhamvishnu.workers.dev"
  }
}
```

- [ ] **Step 2: Create `worker-admin/src/index.js`**

```javascript
const SESSION_COOKIE = "bugradar_admin_session";
const SESSION_DAYS = 30;
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_RESEND_COOLDOWN_MS = 30 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const ADMIN_EMAIL = "shubhamvishnu@gmail.com";

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

function sessionCookieHeader(token, maxAgeSeconds) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

function getCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function sqliteTimeToMs(sqliteText) {
  // D1's datetime('now') default returns "YYYY-MM-DD HH:MM:SS" in UTC, no timezone suffix.
  return Date.parse(sqliteText.replace(" ", "T") + "Z");
}

async function getSessionEmail(request, env) {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const row = await env.DB.prepare("SELECT email, expires_at FROM sessions WHERE token = ?")
    .bind(token)
    .first();
  if (!row) return null;
  if (Date.parse(row.expires_at) < Date.now()) return null;
  return row.email;
}

async function adminAuthed(request, env) {
  const email = await getSessionEmail(request, env);
  return email === ADMIN_EMAIL;
}

function randomOtp() {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(100000 + (buf[0] % 900000));
}

async function sendOtpEmail(env, email, code) {
  const from = env.RESEND_FROM || "Bug Radar Admin <login@revsight.io>";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: email,
      subject: "Your Bug Radar Admin login code",
      html: `<div style="font-family:-apple-system,sans-serif;font-size:15px;color:#1a1712">
        <p>Your admin login code is:</p>
        <p style="font-size:32px;font-weight:700;letter-spacing:6px;font-family:monospace">${code}</p>
        <p style="color:#6b6860;font-size:13px">This code expires in 10 minutes. If you didn't request this, you can ignore this email.</p>
      </div>`,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Resend ${res.status}: ${text}`);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === "/api/auth/request-otp" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const email = String(body.email || "").trim().toLowerCase();
      if (email !== ADMIN_EMAIL) {
        return json({ error: "not found" }, 404);
      }
      const recent = await env.DB.prepare(
        "SELECT created_at FROM otp_codes WHERE email = ? ORDER BY id DESC LIMIT 1"
      ).bind(email).first();
      if (recent && Date.now() - sqliteTimeToMs(recent.created_at) < OTP_RESEND_COOLDOWN_MS) {
        return json({ error: "Please wait before requesting another code." }, 429);
      }
      const code = randomOtp();
      const expiresAt = new Date(Date.now() + OTP_TTL_MS).toISOString();
      await env.DB.prepare("INSERT INTO otp_codes (email, code, expires_at) VALUES (?, ?, ?)")
        .bind(email, code, expiresAt)
        .run();
      try {
        await sendOtpEmail(env, email, code);
      } catch (e) {
        return json({ error: "Could not send the email. Try again in a moment." }, 502);
      }
      return json({ ok: true });
    }

    if (pathname === "/api/auth/verify-otp" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const email = String(body.email || "").trim().toLowerCase();
      const code = String(body.code || "").trim();
      if (email !== ADMIN_EMAIL) {
        return json({ error: "That code doesn't match." }, 401);
      }
      const row = await env.DB.prepare(
        "SELECT * FROM otp_codes WHERE email = ? AND consumed = 0 ORDER BY id DESC LIMIT 1"
      ).bind(email).first();
      if (!row || Date.parse(row.expires_at) < Date.now()) {
        return json({ error: "That code has expired. Request a new one." }, 401);
      }
      if (row.attempts >= OTP_MAX_ATTEMPTS) {
        return json({ error: "Too many attempts. Request a new code." }, 401);
      }
      if (row.code !== code) {
        await env.DB.prepare("UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?").bind(row.id).run();
        return json({ error: "That code doesn't match." }, 401);
      }
      await env.DB.prepare("UPDATE otp_codes SET consumed = 1 WHERE id = ?").bind(row.id).run();
      await env.DB.prepare("INSERT OR IGNORE INTO users (email) VALUES (?)").bind(email).run();
      const token = crypto.randomUUID();
      const maxAge = SESSION_DAYS * 24 * 60 * 60;
      const expiresAt = new Date(Date.now() + maxAge * 1000).toISOString();
      await env.DB.prepare("INSERT INTO sessions (token, email, expires_at) VALUES (?, ?, ?)")
        .bind(token, email, expiresAt)
        .run();
      return json({ ok: true, email }, 200, { "set-cookie": sessionCookieHeader(token, maxAge) });
    }

    if (pathname === "/api/auth/me" && request.method === "GET") {
      const email = await getSessionEmail(request, env);
      if (!email || email !== ADMIN_EMAIL) return json({ error: "not authenticated" }, 401);
      return json({ email });
    }

    if (pathname === "/api/auth/logout" && request.method === "POST") {
      const token = getCookie(request, SESSION_COOKIE);
      if (token) await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
      return json({ ok: true }, 200, { "set-cookie": sessionCookieHeader("", 0) });
    }

    if (pathname === "/api/overview" && request.method === "GET") {
      if (!(await adminAuthed(request, env))) return json({ error: "not authenticated" }, 401);
      return json({ ok: true });
    }

    return env.ASSETS.fetch(request);
  },
};
```

- [ ] **Step 3: Create a minimal placeholder `worker-admin/public/index.html`**

```html
<!doctype html>
<meta charset="utf-8">
<title>Bug Radar Admin</title>
<body>
  <p>Bug Radar Admin — scaffold placeholder, replaced in Task 7.</p>
</body>
```

- [ ] **Step 4: Deploy**

```bash
cd worker-admin && npx wrangler deploy && cd ..
```

If this is the first deploy, `wrangler` will create the Worker under the name `bug-radar-admin`; confirm the deploy output prints a `*.workers.dev` URL.

- [ ] **Step 5: Set the Resend secret**

```bash
cd worker-admin && npx wrangler secret put RESEND_API_KEY && cd ..
```

Use the same Resend API key value already used by `worker/` (retrieve it from wherever it's stored — macOS Keychain if that's the convention, or ask the user to confirm the value — never echo it).

- [ ] **Step 6: Verify the placeholder page serves**

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://bug-radar-admin.shubhamvishnu.workers.dev/
```

Expected: `200`.

- [ ] **Step 7: Verify `request-otp` rejects a non-admin email**

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://bug-radar-admin.shubhamvishnu.workers.dev/api/auth/request-otp \
  -H "content-type: application/json" -d '{"email":"not-the-admin@example.com"}'
```

Expected: `404`.

```bash
CLOUDFLARE_ACCOUNT_ID=ad1a4dda1125569690132b861f95a63a npx wrangler d1 execute bug-radar-db --remote --command "SELECT COUNT(*) as n FROM otp_codes WHERE email = 'not-the-admin@example.com'"
```

Expected: `n = 0` — no code was ever generated for the rejected email.

- [ ] **Step 8: Verify the real admin OTP flow end to end**

```bash
curl -s -X POST https://bug-radar-admin.shubhamvishnu.workers.dev/api/auth/request-otp \
  -H "content-type: application/json" -d '{"email":"shubhamvishnu@gmail.com"}'
```

Expected: `{"ok":true}`.

```bash
CLOUDFLARE_ACCOUNT_ID=ad1a4dda1125569690132b861f95a63a npx wrangler d1 execute bug-radar-db --remote --command "SELECT code FROM otp_codes WHERE email='shubhamvishnu@gmail.com' ORDER BY id DESC LIMIT 1"
```

```bash
curl -s -i -X POST https://bug-radar-admin.shubhamvishnu.workers.dev/api/auth/verify-otp \
  -H "content-type: application/json" -d '{"email":"shubhamvishnu@gmail.com","code":"<real code from D1>"}'
```

Expected: `200`, body `{"ok":true,"email":"shubhamvishnu@gmail.com"}`, and a `set-cookie: bugradar_admin_session=...` header. Capture the token.

```bash
COOKIE="bugradar_admin_session=<real token>"
curl -s -o /dev/null -w "%{http_code}\n" "https://bug-radar-admin.shubhamvishnu.workers.dev/api/overview"
curl -s "https://bug-radar-admin.shubhamvishnu.workers.dev/api/overview" -H "Cookie: $COOKIE"
```

Expected: no-cookie call → `401`; with-cookie call → `200`, body `{"ok":true}`.

- [ ] **Step 9: Commit**

```bash
git add worker-admin/wrangler.jsonc worker-admin/src/index.js worker-admin/public/index.html
git commit -m "Scaffold worker-admin: restricted OTP/session auth, placeholder frontend"
git push
```

---

### Task 3: `worker-admin` — `GET /api/overview` (real) + `GET /api/events`

**Files:**
- Modify: `worker-admin/src/index.js` (replace the Task 2 stub `/api/overview` block; add a new `/api/events` block immediately after it)

**Interfaces:**
- Consumes: `adminAuthed` (Task 2), tables `users`, `connections`, `reports`, `connection_events` (join to `connections`).
- Produces: `GET /api/overview` → `{ userCount, connectionCount, reportCount, connectionsByStatus: {status: count} }`. `GET /api/events?limit=100` → array of `{ id, connection_id, kind, status, title, detail, trigger_label, created_at, owner_email, project_name }`, newest first, capped at `min(limit, 500)`, default `100`.

- [ ] **Step 1: Replace the stub `/api/overview` route**

Find:

```javascript
    if (pathname === "/api/overview" && request.method === "GET") {
      if (!(await adminAuthed(request, env))) return json({ error: "not authenticated" }, 401);
      return json({ ok: true });
    }
```

Replace with:

```javascript
    if (pathname === "/api/overview" && request.method === "GET") {
      if (!(await adminAuthed(request, env))) return json({ error: "not authenticated" }, 401);
      const userCount = (await env.DB.prepare("SELECT COUNT(*) as n FROM users").first()).n;
      const connectionCount = (await env.DB.prepare("SELECT COUNT(*) as n FROM connections").first()).n;
      const reportCount = (await env.DB.prepare("SELECT COUNT(*) as n FROM reports").first()).n;
      const { results: statusRows } = await env.DB.prepare(
        "SELECT status, COUNT(*) as n FROM connections GROUP BY status"
      ).all();
      const connectionsByStatus = {};
      for (const row of statusRows) connectionsByStatus[row.status] = row.n;
      return json({ userCount, connectionCount, reportCount, connectionsByStatus });
    }

    if (pathname === "/api/events" && request.method === "GET") {
      if (!(await adminAuthed(request, env))) return json({ error: "not authenticated" }, 401);
      const limit = Math.min(Number(url.searchParams.get("limit")) || 100, 500);
      const { results } = await env.DB.prepare(
        `SELECT ce.id, ce.connection_id, ce.kind, ce.status, ce.title, ce.detail, ce.trigger_label, ce.created_at,
                c.owner_email, c.project_name
         FROM connection_events ce
         JOIN connections c ON c.id = ce.connection_id
         ORDER BY ce.id DESC LIMIT ?`
      ).bind(limit).all();
      return json(results);
    }
```

- [ ] **Step 2: Deploy**

```bash
cd worker-admin && npx wrangler deploy && cd ..
```

- [ ] **Step 3: Verify `/api/overview` with real data**

```bash
COOKIE="bugradar_admin_session=<real token from Task 2>"
curl -s "https://bug-radar-admin.shubhamvishnu.workers.dev/api/overview" -H "Cookie: $COOKIE"
```

Expected: real integers for `userCount`/`connectionCount`/`reportCount`, and `connectionsByStatus` with at least one real status key (e.g. `"healthy"`). Cross-check `userCount` against:

```bash
CLOUDFLARE_ACCOUNT_ID=ad1a4dda1125569690132b861f95a63a npx wrangler d1 execute bug-radar-db --remote --command "SELECT COUNT(*) as n FROM users"
```

- [ ] **Step 4: Verify `/api/events`**

```bash
curl -s "https://bug-radar-admin.shubhamvishnu.workers.dev/api/events?limit=5" -H "Cookie: $COOKIE"
curl -s -o /dev/null -w "%{http_code}\n" "https://bug-radar-admin.shubhamvishnu.workers.dev/api/events"
```

Expected: with-cookie call returns up to 5 real rows, newest first, each with a real `owner_email` and (where available) `project_name`; no-cookie call → `401`.

- [ ] **Step 5: Commit**

```bash
git add worker-admin/src/index.js
git commit -m "Add real overview stats and global events feed to worker-admin"
git push
```

---

### Task 4: `worker-admin` — `GET /api/users`

**Files:**
- Modify: `worker-admin/src/index.js` (insert new route after the `/api/events` block from Task 3)

**Interfaces:**
- Consumes: `adminAuthed` (Task 2), `sqliteTimeToMs` (Task 2, used implicitly via string comparison — not required here since we take the raw more-recent string, see Step 1 note), tables `users`, `connections`, `connection_events`, `reports`.
- Produces: `GET /api/users` → array of `{ id, email, created_at, connection_count, last_activity }`, ordered by `id`. `last_activity` is that owner's most recent `connection_events.created_at` across all their connections; if none, falls back to their most recent `reports.created_at`; `null` if neither exists.

- [ ] **Step 1: Add the route**

Find the end of the `/api/events` block added in Task 3 (the closing `}` right before `return env.ASSETS.fetch(request);` at the bottom, or before whatever route currently follows). Insert:

```javascript
    if (pathname === "/api/users" && request.method === "GET") {
      if (!(await adminAuthed(request, env))) return json({ error: "not authenticated" }, 401);
      const { results: users } = await env.DB.prepare("SELECT id, email, created_at FROM users ORDER BY id").all();
      const { results: connCounts } = await env.DB.prepare(
        "SELECT owner_email, COUNT(*) as n FROM connections GROUP BY owner_email"
      ).all();
      const connCountMap = {};
      for (const row of connCounts) connCountMap[row.owner_email] = row.n;
      const { results: eventActivity } = await env.DB.prepare(
        `SELECT c.owner_email as owner_email, MAX(ce.created_at) as last_event
         FROM connection_events ce JOIN connections c ON c.id = ce.connection_id
         GROUP BY c.owner_email`
      ).all();
      const eventActivityMap = {};
      for (const row of eventActivity) eventActivityMap[row.owner_email] = row.last_event;
      const { results: reportActivity } = await env.DB.prepare(
        "SELECT owner_email, MAX(created_at) as last_report FROM reports GROUP BY owner_email"
      ).all();
      const reportActivityMap = {};
      for (const row of reportActivity) reportActivityMap[row.owner_email] = row.last_report;
      const enriched = users.map(u => ({
        ...u,
        connection_count: connCountMap[u.email] || 0,
        last_activity: eventActivityMap[u.email] || reportActivityMap[u.email] || null,
      }));
      return json(enriched);
    }
```

- [ ] **Step 2: Deploy**

```bash
cd worker-admin && npx wrangler deploy && cd ..
```

- [ ] **Step 3: Verify**

```bash
COOKIE="bugradar_admin_session=<real token>"
curl -s "https://bug-radar-admin.shubhamvishnu.workers.dev/api/users" -H "Cookie: $COOKIE"
```

Expected: a real array including at least `shubhamvishnu@gmail.com`, with `connection_count >= 1` and a non-null `last_activity` (this owner has real connection events from the audit-log plan's own verification steps).

```bash
curl -s -o /dev/null -w "%{http_code}\n" "https://bug-radar-admin.shubhamvishnu.workers.dev/api/users"
```

Expected: `401` with no cookie.

- [ ] **Step 4: Commit**

```bash
git add worker-admin/src/index.js
git commit -m "Add GET /api/users to worker-admin"
git push
```

---

### Task 5: `worker-admin` — `GET /api/users/:email`

**Files:**
- Modify: `worker-admin/src/index.js` (insert new route after the `/api/users` block from Task 4)

**Interfaces:**
- Consumes: `adminAuthed` (Task 2), tables `users`, `connections`, `reports`, `goals`, `tags`, `corrections`, `connection_events`.
- Produces: `GET /api/users/:email` → `{ user, connections, latest_report, report_history, goals, tags, corrections, events }` exactly shaped per the spec (see Step 1). `connections` never includes `encrypted_api_key`/`iv`. `report_history` is the last 10 reports, lightweight (`id, connection_id, generated_at, created_at, task_count`), no `micro_findings`/`macro_themes` payload. `events` capped at 200, across all of this owner's connections.

- [ ] **Step 1: Add the route**

Insert after the `/api/users` block from Task 4:

```javascript
    const userDetailMatch = pathname.match(/^\/api\/users\/([^/]+)$/);
    if (userDetailMatch && request.method === "GET") {
      if (!(await adminAuthed(request, env))) return json({ error: "not authenticated" }, 401);
      const targetEmail = decodeURIComponent(userDetailMatch[1]).trim().toLowerCase();
      const user = await env.DB.prepare("SELECT id, email, created_at FROM users WHERE email = ?").bind(targetEmail).first();
      if (!user) return json({ error: "not found" }, 404);

      const { results: connections } = await env.DB.prepare(
        `SELECT id, region, project_id, project_name, timezone, identity_email_prop, identity_name_prop, identity_role_prop,
                status, last_error, last_synced_at, sync_freq, sync_max_sessions, last_pipeline_run_at, created_at
         FROM connections WHERE owner_email = ? ORDER BY id DESC`
      ).bind(targetEmail).all();

      const latestReportRow = await env.DB.prepare(
        "SELECT connection_id, generated_at, macro_themes, micro_findings FROM reports WHERE owner_email = ? ORDER BY id DESC LIMIT 1"
      ).bind(targetEmail).first();
      const latestReport = latestReportRow ? {
        connection_id: latestReportRow.connection_id,
        generated_at: latestReportRow.generated_at,
        macro_themes: JSON.parse(latestReportRow.macro_themes),
        micro_findings: JSON.parse(latestReportRow.micro_findings),
      } : null;

      const { results: reportHistoryRaw } = await env.DB.prepare(
        "SELECT id, connection_id, generated_at, created_at, micro_findings FROM reports WHERE owner_email = ? ORDER BY id DESC LIMIT 10"
      ).bind(targetEmail).all();
      const reportHistory = reportHistoryRaw.map(r => ({
        id: r.id,
        connection_id: r.connection_id,
        generated_at: r.generated_at,
        created_at: r.created_at,
        task_count: JSON.parse(r.micro_findings).reduce((n, f) => n + (f.tasks || []).length, 0),
      }));

      const { results: goalsRaw } = await env.DB.prepare(
        "SELECT id, purpose, description, tags, source, created_at FROM goals WHERE owner_email = ? ORDER BY id DESC"
      ).bind(targetEmail).all();
      const goals = goalsRaw.map(g => ({ ...g, tags: JSON.parse(g.tags || "[]") }));

      const { results: tags } = await env.DB.prepare(
        "SELECT id, label, color, source, created_at FROM tags WHERE owner_email = ? ORDER BY id DESC"
      ).bind(targetEmail).all();

      const { results: corrections } = await env.DB.prepare(
        `SELECT id, session_id, task_index, task_title, field, from_value, to_value, reason, connection_id, created_at
         FROM corrections WHERE owner_email = ? ORDER BY id DESC`
      ).bind(targetEmail).all();

      const connectionIds = connections.map(c => c.id);
      let events = [];
      if (connectionIds.length) {
        const placeholders = connectionIds.map(() => "?").join(",");
        const { results } = await env.DB.prepare(
          `SELECT id, connection_id, kind, status, title, detail, trigger_label, created_at
           FROM connection_events WHERE connection_id IN (${placeholders}) ORDER BY id DESC LIMIT 200`
        ).bind(...connectionIds).all();
        events = results;
      }

      return json({
        user: { email: user.email, created_at: user.created_at },
        connections,
        latest_report: latestReport,
        report_history: reportHistory,
        goals,
        tags,
        corrections,
        events,
      });
    }
```

- [ ] **Step 2: Deploy**

```bash
cd worker-admin && npx wrangler deploy && cd ..
```

- [ ] **Step 3: Verify against the real `shubhamvishnu@gmail.com` tenant**

```bash
COOKIE="bugradar_admin_session=<real token>"
curl -s "https://bug-radar-admin.shubhamvishnu.workers.dev/api/users/shubhamvishnu%40gmail.com" -H "Cookie: $COOKIE" -o /tmp/user-detail.json
cat /tmp/user-detail.json | python3 -m json.tool | head -60
grep -c "encrypted_api_key\|\"iv\"" /tmp/user-detail.json
```

Expected: real `connections` (at least one, with real `project_name`/`status`), a real `latest_report` with populated `micro_findings`, `report_history` with `task_count` matching what you'd hand-count from the latest report, real `goals`/`tags`/`corrections`/`events`; the `grep -c` must print `0` (no secret fields leaked).

```bash
curl -s -o /dev/null -w "%{http_code}\n" "https://bug-radar-admin.shubhamvishnu.workers.dev/api/users/nobody-real%40example.com" -H "Cookie: $COOKIE"
```

Expected: `404`.

- [ ] **Step 4: Commit**

```bash
git add worker-admin/src/index.js
git commit -m "Add GET /api/users/:email full-bundle route to worker-admin"
git push
```

---

### Task 6: `worker-admin` — `GET /api/media/:key` (proxy to main worker)

**Files:**
- Modify: `worker-admin/src/index.js` (insert new route after the `/api/users/:email` block from Task 5)

**Interfaces:**
- Consumes: `adminAuthed` (Task 2), `env.MAIN_WORKER_URL` (set in `worker-admin/wrangler.jsonc`, Task 2), `env.ADMIN_MEDIA_SECRET` (new secret, set in Step 1 below), the main worker's `GET /api/admin/media/:key` (Task 1).
- Produces: `GET /api/media/:key` on `worker-admin` — session-authed, streams the image back with the upstream's `content-type`. Task 10's frontend uses this as the `src` of captured-moment `<img>` tags.

- [ ] **Step 1: Set `ADMIN_MEDIA_SECRET` on `worker-admin`, identical value to Task 1**

```bash
cd worker-admin && npx wrangler secret put ADMIN_MEDIA_SECRET && cd ..
```

Paste the exact same value generated and set on `worker/` in Task 1, Step 1.

- [ ] **Step 2: Add the route**

Insert after the `/api/users/:email` block from Task 5:

```javascript
    const mediaProxyMatch = pathname.match(/^\/api\/media\/(.+)$/);
    if (mediaProxyMatch && request.method === "GET") {
      if (!(await adminAuthed(request, env))) return json({ error: "not authenticated" }, 401);
      const key = mediaProxyMatch[1];
      const upstream = await fetch(`${env.MAIN_WORKER_URL}/api/admin/media/${key}`, {
        headers: { authorization: `Bearer ${env.ADMIN_MEDIA_SECRET}` },
      });
      if (!upstream.ok) return json({ error: "not found" }, upstream.status === 401 ? 401 : 404);
      return new Response(upstream.body, {
        headers: {
          "content-type": upstream.headers.get("content-type") || "image/png",
          "cache-control": "private, max-age=31536000, immutable",
        },
      });
    }
```

- [ ] **Step 3: Deploy**

```bash
cd worker-admin && npx wrangler deploy && cd ..
```

- [ ] **Step 4: Verify the plumbing**

```bash
COOKIE="bugradar_admin_session=<real token>"
curl -s -o /dev/null -w "%{http_code}\n" "https://bug-radar-admin.shubhamvishnu.workers.dev/api/media/made-up-key" -H "Cookie: $COOKIE"
curl -s -o /dev/null -w "%{http_code}\n" "https://bug-radar-admin.shubhamvishnu.workers.dev/api/media/made-up-key"
```

Expected: with-cookie call against a made-up key → `404` (upstream 404 passed through); no-cookie call → `401` (this Worker's own session gate, never reaches the upstream call).

- [ ] **Step 5: If Task 1 found a real media key, verify the full round trip; otherwise defer**

If Task 1, Step 5 found a real key:

```bash
curl -s -o /tmp/admin-proxy-test.png -w "%{http_code}\n" "https://bug-radar-admin.shubhamvishnu.workers.dev/api/media/<same real key>" -H "Cookie: $COOKIE"
file /tmp/admin-proxy-test.png
```

Expected: `200`, real image bytes. If no real key was available at Task 1, note in your report that end-to-end image verification is deferred to Task 10's Playwright pass, once real captured-moment data may exist for a tenant.

- [ ] **Step 6: Commit**

```bash
git add worker-admin/src/index.js
git commit -m "Add media proxy route to worker-admin, backed by the main worker's admin media route"
git push
```

---

### Task 7: `worker-admin` frontend — login screen + overview screen

**Files:**
- Modify: `worker-admin/public/index.html` (full rewrite, replacing the Task 2 placeholder)

**Interfaces:**
- Consumes: `GET/POST /api/auth/*` (Task 2), `GET /api/overview` (Task 3), `GET /api/events` (Task 3).
- Produces: `AUTH` (object, `{ email }`), `loginState` (object), `state` (object, `{ view, ... }` — Task 8 extends this with `selUserEmail`), `escapeHtml(s)`, `relTimeLabel(iso)`, `AUDIT_STATUS_VAR`, `AUDIT_KIND_LABEL`, `auditRowHtml(ev)` (Tasks 9/10 reuse this for per-connection audit logs), `render()`, `init()`. Later tasks extend `renderMainContent()`'s `switch (state.view)`.

- [ ] **Step 1: Write the full file**

```html
<!doctype html>
<meta charset="utf-8">
<title>Bug Radar Admin</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;450;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box}
html,body{margin:0;padding:0;height:100%}
body{font-family:'Inter',system-ui,sans-serif;-webkit-font-smoothing:antialiased;letter-spacing:-.006em;background:var(--bg);color:var(--text);font-size:14px}
button{font-family:inherit;cursor:pointer;border:none;background:none;color:inherit}
a{color:var(--accent);text-decoration:none}
::-webkit-scrollbar{width:10px;height:10px}
::-webkit-scrollbar-thumb{background:var(--scroll);border-radius:8px;border:3px solid transparent;background-clip:padding-box}

:root{
--bg:#ffffff;--bg-sub:#f7f6f4;--bg-elev:#ffffff;--bg-hover:#f3f2ef;
--border:#eceae5;--border-soft:#f1efeb;--border-str:#ddd9d2;--scroll:#d9d6cf;
--text:#1a1712;--muted:#6b6860;--faint:#9c988e;
--accent:#e5482b;--accent-fg:#ffffff;
--sev-high:#e0442e;--sev-med:#bd7a17;
--oc-done:#2f9e6b;
--shadow:0 1px 2px rgba(20,16,10,.05),0 6px 18px rgba(20,16,10,.045);
--panel-grad:linear-gradient(150deg,#d5e6ff 0%,#ffe6d5 46%,#ffe1ce 62%,#d9f2e7 100%);
}
html[data-theme="dark"]{
--bg:#0c0d10;--bg-sub:#101116;--bg-elev:#15161b;--bg-hover:#16181d;
--border:#212228;--border-soft:#1a1b20;--border-str:#2d2f37;--scroll:#2a2c33;
--text:#eef0f3;--muted:#989ca4;--faint:#63676f;
--accent:#ff6a48;--accent-fg:#0c0d10;
--sev-high:#ff5c52;--sev-med:#e0a13c;
--oc-done:#3fce8f;
--shadow:0 1px 2px rgba(0,0,0,.4),0 10px 26px rgba(0,0,0,.3);
--panel-grad:linear-gradient(150deg,#12233b 0%,#2a1a12 50%,#122a20 100%);
}
@keyframes fade-up{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}

/* ---- login (ported from worker/public/index.html) ---- */
.login-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--panel-grad)}
.login-card{width:100%;max-width:380px;background:var(--bg-elev);border:1px solid var(--border);border-radius:16px;box-shadow:var(--shadow);padding:32px;animation:fade-up .3s ease both}
.login-brand{display:flex;align-items:center;gap:9px;margin-bottom:22px;font-weight:600;font-size:15px}
.login-title{font-size:20px;font-weight:700;letter-spacing:-.02em;margin:0}
.login-subtitle{font-size:13.5px;color:var(--muted);margin:6px 0 20px}
.login-label{display:block;font-size:12.5px;font-weight:500;color:var(--muted);margin-bottom:7px}
.login-field{display:flex;align-items:center;gap:9px;height:44px;padding:0 13px;border-radius:11px;background:var(--bg-sub);border:1px solid var(--border-str)}
.login-field input{flex:1;min-width:0;border:none;background:none;outline:none;color:var(--text);font-size:14px;height:100%}
.login-field.err{border-color:var(--accent)}
.login-error{display:flex;align-items:center;gap:6px;margin-top:8px;color:var(--accent);font-size:12.5px}
.login-primary-btn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;height:44px;margin-top:16px;border-radius:11px;background:var(--accent);color:var(--accent-fg);font-size:14px;font-weight:600}
.login-primary-btn.disabled{opacity:.45;pointer-events:none}
.otp-back{display:inline-flex;align-items:center;gap:6px;font-size:13px;color:var(--muted);margin-bottom:18px}
.otp-cells{display:flex;gap:8px;margin:18px 0 4px}
.otp-cell{width:44px;height:52px;text-align:center;font-size:21px;font-weight:600;font-family:'JetBrains Mono',monospace;color:var(--text);background:var(--bg-sub);border:1px solid var(--border-str);border-radius:11px;outline:none}
.otp-cell.filled{border-color:var(--accent)}
.otp-cell.err{border-color:var(--accent)}
.otp-verify-btn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;height:44px;margin-top:20px;border-radius:11px;background:var(--accent);color:var(--accent-fg);font-size:14px;font-weight:600}
.otp-verify-btn.disabled{opacity:.45;pointer-events:none}
.otp-resend-row{text-align:center;margin-top:16px;font-size:13px;color:var(--muted)}
.otp-resend-row button{color:var(--accent);font-weight:500}
.spinner{width:16px;height:16px;border-radius:50%;border:2px solid rgba(255,255,255,.35);border-top-color:#fff;animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}

/* ---- app shell ---- */
.app{min-height:100vh}
.topbar{display:flex;align-items:center;gap:18px;padding:14px 24px;border-bottom:1px solid var(--border);background:var(--bg-elev)}
.topbar-brand{font-weight:700;font-size:15px;letter-spacing:-.01em}
.topbar-nav{display:flex;gap:4px;margin-left:12px}
.topbar-nav button{padding:7px 13px;border-radius:8px;font-size:13px;font-weight:500;color:var(--muted)}
.topbar-nav button.active{color:var(--text);background:var(--bg-active,var(--bg-sub))}
.topbar-right{margin-left:auto;display:flex;align-items:center;gap:12px;font-size:12.5px;color:var(--muted)}
.main{max-width:1080px;margin:0 auto;padding:28px 24px 60px}
.stat-row{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:28px}
.stat-card{border:1px solid var(--border);border-radius:14px;background:var(--bg-elev);padding:18px}
.stat-card .n{font-size:26px;font-weight:700;letter-spacing:-.02em}
.stat-card .lbl{font-size:12px;color:var(--muted);margin-top:4px}
.section-title{font-size:13px;font-weight:600;color:var(--muted);letter-spacing:.02em;text-transform:uppercase;margin:0 0 12px}
.panel{border:1px solid var(--border);border-radius:14px;background:var(--bg-elev);padding:6px 18px}
.empty-note{color:var(--faint);font-size:13px;padding:16px 2px}
</style>
<div id="app"></div>
<script>
function escapeHtml(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

function getTheme() { return localStorage.getItem("bra_theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"); }

const AUTH = { email: null };
const loginState = { step: "email", email: "", sending: false, emailError: "", otp: ["", "", "", "", "", ""], otpError: "", verifying: false, resendIn: 0 };
const state = { view: "overview" };

let OVERVIEW = { userCount: 0, connectionCount: 0, reportCount: 0, connectionsByStatus: {} };
let EVENTS = [];

const AUDIT_STATUS_VAR = { success: "var(--oc-done)", warning: "var(--sev-med)", error: "var(--sev-high)", info: "var(--faint)" };
const AUDIT_KIND_LABEL = { connection_established: "Connection established", settings_changed: "Settings changed", resync: "Re-sync", sync_completed: "Sync completed", sync_failed: "Sync failed" };

function relTimeLabel(iso) {
  const ts = iso.includes("T") ? iso : iso.replace(" ", "T") + "Z";
  const mins = Math.max(0, Math.round((Date.now() - new Date(ts).getTime()) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function auditRowHtml(ev, opts) {
  opts = opts || {};
  return `
  <div style="display:flex;align-items:flex-start;gap:12px;padding:11px 0;border-top:1px solid var(--border-soft)">
    <span style="width:8px;height:8px;border-radius:50%;flex:none;margin-top:5px;background:${AUDIT_STATUS_VAR[ev.status] || "var(--faint)"}"></span>
    <div style="min-width:0;flex:1">
      <div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap">
        <span style="font-size:13px;font-weight:600">${escapeHtml(ev.title || AUDIT_KIND_LABEL[ev.kind] || ev.kind)}</span>
        ${opts.showOwner && ev.owner_email ? `<button data-act="open-user" data-email="${escapeHtml(ev.owner_email)}" style="font-size:11.5px;color:var(--accent);font-weight:500">${escapeHtml(ev.owner_email)}</button>` : ""}
        ${opts.showOwner && ev.project_name ? `<span style="font-size:11.5px;color:var(--faint)">${escapeHtml(ev.project_name)}</span>` : ""}
        <span style="font-size:11.5px;color:var(--faint)">${escapeHtml(ev.trigger_label || "")}</span>
      </div>
      ${ev.detail ? `<div style="font-size:12px;color:var(--muted);line-height:1.45;margin-top:2px">${escapeHtml(ev.detail)}</div>` : ""}
    </div>
    <span style="font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--faint);flex:none;white-space:nowrap;margin-top:1px">${escapeHtml(relTimeLabel(ev.created_at))}</span>
  </div>`;
}

async function loadOverview() {
  const [ovRes, evRes] = await Promise.all([fetch("/api/overview"), fetch("/api/events?limit=100")]);
  if (ovRes.ok) OVERVIEW = await ovRes.json();
  if (evRes.ok) EVENTS = await evRes.json();
}

function renderOverview() {
  const statusEntries = Object.entries(OVERVIEW.connectionsByStatus || {});
  const statusLabel = statusEntries.length ? statusEntries.map(([s, n]) => `${n} ${s}`).join(" · ") : "no connections yet";
  return `
  <div class="stat-row">
    <div class="stat-card"><div class="n">${OVERVIEW.userCount}</div><div class="lbl">Users</div></div>
    <div class="stat-card"><div class="n">${OVERVIEW.connectionCount}</div><div class="lbl">Connections</div></div>
    <div class="stat-card"><div class="n">${OVERVIEW.reportCount}</div><div class="lbl">Reports</div></div>
    <div class="stat-card"><div class="n" style="font-size:15px;font-weight:600;line-height:1.5">${escapeHtml(statusLabel)}</div><div class="lbl">By status</div></div>
  </div>
  <div class="section-title">Global activity</div>
  <div class="panel">
    ${EVENTS.length ? EVENTS.map(ev => auditRowHtml(ev, { showOwner: true })).join("") : `<div class="empty-note">No activity yet.</div>`}
  </div>`;
}

/* ---------------- login (ported two-step flow) ---------------- */
async function submitLoginEmail(e) {
  e.preventDefault();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(loginState.email)) {
    loginState.emailError = "Enter a valid email address.";
    render();
    return;
  }
  loginState.emailError = "";
  loginState.sending = true;
  render();
  try {
    const res = await fetch("/api/auth/request-otp", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: loginState.email }),
    });
    const data = await res.json().catch(() => ({}));
    loginState.sending = false;
    if (!res.ok) { loginState.emailError = data.error || "Something went wrong. Try again."; render(); return; }
    loginState.step = "otp";
    loginState.otp = ["", "", "", "", "", ""];
    loginState.otpError = "";
    render();
    startResendTimer();
  } catch (e) {
    loginState.sending = false;
    loginState.emailError = "Network error. Try again.";
    render();
  }
}

async function verifyLoginOtp() {
  const code = loginState.otp.join("");
  if (code.length !== 6) return;
  loginState.verifying = true;
  render();
  try {
    const res = await fetch("/api/auth/verify-otp", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: loginState.email, code }),
    });
    const data = await res.json().catch(() => ({}));
    loginState.verifying = false;
    if (!res.ok) {
      loginState.otpError = data.error || "That code doesn't match.";
      loginState.otp = ["", "", "", "", "", ""];
      render();
      return;
    }
    AUTH.email = data.email;
    await loadOverview();
    render();
  } catch (e) {
    loginState.verifying = false;
    loginState.otpError = "Network error. Try again.";
    render();
  }
}

function backToLoginEmail() {
  loginState.step = "email";
  loginState.otpError = "";
  render();
}

let resendTimer = null;
function startResendTimer() {
  loginState.resendIn = 30;
  clearInterval(resendTimer);
  resendTimer = setInterval(() => {
    loginState.resendIn -= 1;
    if (loginState.resendIn <= 0) { clearInterval(resendTimer); loginState.resendIn = 0; }
    const row = document.getElementById("otpResendRow");
    if (row) row.innerHTML = otpResendRowHtml();
  }, 1000);
}

function otpResendRowHtml() {
  const s = loginState;
  return s.resendIn <= 0
    ? `Didn't get it? <button data-act="otp-resend">Resend code</button>`
    : `Resend code in ${s.resendIn}s`;
}

function onOtpInput(i, val) {
  const digit = val.replace(/\D/g, "").slice(-1);
  const otp = loginState.otp.slice();
  otp[i] = digit;
  loginState.otp = otp;
  loginState.otpError = "";
  render();
  if (digit) {
    const next = document.getElementById("otp-" + (i + 1));
    if (next) next.focus();
  }
}

function onOtpKeydown(i, e) {
  if (e.key === "Backspace" && !loginState.otp[i] && i > 0) {
    const prev = document.getElementById("otp-" + (i - 1));
    if (prev) prev.focus();
  }
}

function renderLoginEmailStep() {
  const s = loginState;
  return `
  <div>
    <div class="login-title">Bug Radar Admin</div>
    <div class="login-subtitle">Sign in with the admin account.</div>
    <form id="loginEmailForm">
      <label class="login-label">Email</label>
      <div class="login-field${s.emailError ? " err" : ""}">
        <input id="loginEmailInput" type="email" placeholder="you@company.com" autocomplete="email" value="${escapeHtml(s.email)}"/>
      </div>
      ${s.emailError ? `<div class="login-error">${escapeHtml(s.emailError)}</div>` : ""}
      <button type="submit" class="login-primary-btn${s.sending ? " disabled" : ""}">
        ${s.sending ? `<span class="spinner"></span>` : `<span>Send login code</span>`}
      </button>
    </form>
  </div>`;
}

function renderLoginOtpStep() {
  const s = loginState;
  const complete = s.otp.join("").length === 6;
  return `
  <div>
    <button class="otp-back" data-act="otp-back">&larr; Back</button>
    <div class="login-title">Check your inbox</div>
    <div class="login-subtitle">We sent a 6-digit code to <b style="color:var(--text);font-weight:500">${escapeHtml(s.email)}</b>.</div>
    <div class="otp-cells">
      ${s.otp.map((d, i) => `<input class="otp-cell${s.otpError ? " err" : (d ? " filled" : "")}" id="otp-${i}" data-otp-index="${i}" inputmode="numeric" maxlength="1" value="${escapeHtml(d)}"/>`).join("")}
    </div>
    ${s.otpError ? `<div class="login-error">${escapeHtml(s.otpError)}</div>` : ""}
    <button class="otp-verify-btn${complete ? "" : " disabled"}" data-act="otp-verify">
      ${s.verifying ? `<span class="spinner"></span>` : `<span>Verify &amp; continue</span>`}
    </button>
    <div class="otp-resend-row" id="otpResendRow">${otpResendRowHtml()}</div>
  </div>`;
}

function renderLoginShell() {
  return `
  <div class="login-wrap">
    <div class="login-card">
      <div class="login-brand">Bug Radar Admin</div>
      ${loginState.step === "email" ? renderLoginEmailStep() : renderLoginOtpStep()}
    </div>
  </div>`;
}

/* ---------------- main render ---------------- */
function renderMainContent() {
  switch (state.view) {
    case "overview": return renderOverview();
    default: return "";
  }
}

function renderTopbar() {
  const tabs = [["overview", "Overview"]];
  return `
  <div class="topbar">
    <span class="topbar-brand">Bug Radar Admin</span>
    <div class="topbar-nav">${tabs.map(([v, l]) => `<button class="${state.view === v ? "active" : ""}" data-act="nav" data-view="${v}">${l}</button>`).join("")}</div>
    <div class="topbar-right">
      <span>${escapeHtml(AUTH.email || "")}</span>
      <button data-act="logout" style="color:var(--muted)">Log out</button>
    </div>
  </div>`;
}

function render() {
  document.documentElement.setAttribute("data-theme", getTheme());
  const app = document.getElementById("app");
  if (!AUTH.email) {
    app.innerHTML = renderLoginShell();
    return;
  }
  app.innerHTML = `<div class="app">${renderTopbar()}<main class="main">${renderMainContent()}</main></div>`;
}

document.addEventListener("click", e => {
  const el = e.target.closest("[data-act]");
  if (!el) return;
  const act = el.dataset.act;
  if (act === "otp-back") backToLoginEmail();
  else if (act === "otp-verify") verifyLoginOtp();
  else if (act === "otp-resend") submitLoginEmail({ preventDefault(){} });
  else if (act === "logout") logout();
  else if (act === "nav") { state.view = el.dataset.view; render(); }
});

document.addEventListener("input", e => {
  if (e.target.dataset && e.target.dataset.otpIndex !== undefined) {
    onOtpInput(Number(e.target.dataset.otpIndex), e.target.value);
  }
  if (e.target.id === "loginEmailInput") {
    loginState.email = e.target.value;
    loginState.emailError = "";
  }
});

document.addEventListener("keydown", e => {
  if (e.target.dataset && e.target.dataset.otpIndex !== undefined) {
    onOtpKeydown(Number(e.target.dataset.otpIndex), e);
  }
});

document.addEventListener("submit", e => {
  if (e.target.id === "loginEmailForm") submitLoginEmail(e);
});

async function checkAuth() {
  try {
    const res = await fetch("/api/auth/me");
    if (res.ok) { AUTH.email = (await res.json()).email; return true; }
  } catch (e) {}
  AUTH.email = null;
  return false;
}

async function logout() {
  try { await fetch("/api/auth/logout", { method: "POST" }); } catch (e) {}
  AUTH.email = null;
  loginState.step = "email";
  loginState.email = "";
  loginState.otp = ["", "", "", "", "", ""];
  render();
}

async function init() {
  document.documentElement.setAttribute("data-theme", getTheme());
  const authed = await checkAuth();
  if (authed) await loadOverview();
  render();
}
init();
</script>
```

- [ ] **Step 2: Deploy**

```bash
cd worker-admin && npx wrangler deploy && cd ..
```

- [ ] **Step 3: Playwright-verify the real login + overview flow**

Navigate to `https://bug-radar-admin.shubhamvishnu.workers.dev`, enter `shubhamvishnu@gmail.com`, fetch the real code from D1 (`CLOUDFLARE_ACCOUNT_ID=ad1a4dda1125569690132b861f95a63a npx wrangler d1 execute bug-radar-db --remote --command "SELECT code FROM otp_codes WHERE email='shubhamvishnu@gmail.com' ORDER BY id DESC LIMIT 1"`), enter it, confirm:
1. Login succeeds and lands on the Overview screen.
2. The four stats match what `curl .../api/overview` (with a fresh cookie) returns.
3. The global activity feed shows real rows with real owner emails, correctly colored status dots, and real relative timestamps.
4. No console errors.

- [ ] **Step 4: Commit**

```bash
git add worker-admin/public/index.html
git commit -m "Add worker-admin login + overview frontend"
git push
```

---

### Task 8: `worker-admin` frontend — Users table + routing to user detail

**Files:**
- Modify: `worker-admin/public/index.html`

**Interfaces:**
- Consumes: `GET /api/users` (Task 4), `GET /api/users/:email` (Task 5), `state` (Task 7).
- Produces: `state.selUserEmail` (new field), `state.view === "users"` and `state.view === "user-detail"` cases, `USERS` (array), `USER_DETAIL` (object or `null`), `openUser(email)`, `loadUsers()`. Tasks 9/10 render the body of the `user-detail` view by reading `USER_DETAIL`.

- [ ] **Step 1: Extend `state` and add data globals**

Find:

```javascript
const state = { view: "overview" };

let OVERVIEW = { userCount: 0, connectionCount: 0, reportCount: 0, connectionsByStatus: {} };
let EVENTS = [];
```

Replace with:

```javascript
const state = { view: "overview", selUserEmail: null };

let OVERVIEW = { userCount: 0, connectionCount: 0, reportCount: 0, connectionsByStatus: {} };
let EVENTS = [];
let USERS = [];
let USER_DETAIL = null;
```

- [ ] **Step 2: Add `loadUsers`, `openUser`, and the Users table renderer**

Find:

```javascript
function renderOverview() {
```

Insert immediately before it:

```javascript
async function loadUsers() {
  const res = await fetch("/api/users");
  if (res.ok) USERS = await res.json();
}

async function openUser(email) {
  state.view = "user-detail";
  state.selUserEmail = email;
  USER_DETAIL = null;
  render();
  const res = await fetch(`/api/users/${encodeURIComponent(email)}`);
  if (res.ok) USER_DETAIL = await res.json();
  render();
}

function renderUsersTable() {
  const rows = USERS.map(u => `
    <button data-act="open-user" data-email="${escapeHtml(u.email)}" style="display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:12px;width:100%;text-align:left;padding:12px 0;border-top:1px solid var(--border-soft);font-size:13px">
      <span style="font-weight:500">${escapeHtml(u.email)}</span>
      <span style="color:var(--muted)">${escapeHtml(String(u.created_at || "").slice(0, 10))}</span>
      <span style="color:var(--muted)">${u.connection_count} connection${u.connection_count === 1 ? "" : "s"}</span>
      <span style="color:var(--faint)">${u.last_activity ? relTimeLabel(u.last_activity) : "no activity"}</span>
    </button>`).join("");
  return `
  <div class="section-title">Users<span style="margin-left:8px;font-family:'JetBrains Mono',monospace;font-weight:600;color:var(--faint)">${USERS.length}</span></div>
  <div class="panel">
    <div style="display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:12px;padding:10px 0;font-size:11px;font-weight:600;color:var(--faint);text-transform:uppercase;letter-spacing:.03em">
      <span>Email</span><span>Signed up</span><span>Connections</span><span>Last activity</span>
    </div>
    ${rows || `<div class="empty-note">No users yet.</div>`}
  </div>`;
}
```

- [ ] **Step 3: Wire `state.view` into `renderMainContent`, `renderTopbar`, and the click handler**

Find:

```javascript
function renderMainContent() {
  switch (state.view) {
    case "overview": return renderOverview();
    default: return "";
  }
}
```

Replace with:

```javascript
function renderMainContent() {
  switch (state.view) {
    case "overview": return renderOverview();
    case "users": return renderUsersTable();
    case "user-detail": return renderUserDetail();
    default: return "";
  }
}
```

(`renderUserDetail` is defined in Task 9 — this reference is forward-declared here and satisfied before this file is next deployed.)

Find:

```javascript
function renderTopbar() {
  const tabs = [["overview", "Overview"]];
```

Replace with:

```javascript
function renderTopbar() {
  const tabs = [["overview", "Overview"], ["users", "Users"]];
```

Find:

```javascript
  else if (act === "nav") { state.view = el.dataset.view; render(); }
});
```

Replace with:

```javascript
  else if (act === "nav") { state.view = el.dataset.view; if (el.dataset.view === "users" && !USERS.length) loadUsers(); render(); }
  else if (act === "open-user") { openUser(el.dataset.email); }
});
```

- [ ] **Step 4: Load users eagerly on login too, so the tab has data on first click after a fresh login**

Find:

```javascript
async function init() {
  document.documentElement.setAttribute("data-theme", getTheme());
  const authed = await checkAuth();
  if (authed) await loadOverview();
  render();
}
```

Replace with:

```javascript
async function init() {
  document.documentElement.setAttribute("data-theme", getTheme());
  const authed = await checkAuth();
  if (authed) { await loadOverview(); await loadUsers(); }
  render();
}
```

- [ ] **Step 5: Add a temporary stub `renderUserDetail` so the file is valid before Task 9 lands**

Immediately after `renderUsersTable`'s closing `}` (from Step 2), insert:

```javascript
function renderUserDetail() {
  if (!USER_DETAIL) return `<div class="empty-note">Loading…</div>`;
  return `<div class="empty-note">User detail rendering lands in Task 9/10.</div>`;
}
```

(Task 9 replaces this stub's body.)

- [ ] **Step 6: Deploy**

```bash
cd worker-admin && npx wrangler deploy && cd ..
```

- [ ] **Step 7: Playwright-verify**

Log in, click the "Users" tab, confirm the real users table renders (including `shubhamvishnu@gmail.com` with a real connection count and last-activity label). Click that row, confirm the view switches to user detail and shows the temporary placeholder text (proving the fetch + routing works end to end — full detail rendering is Tasks 9/10).

- [ ] **Step 8: Commit**

```bash
git add worker-admin/public/index.html
git commit -m "Add worker-admin users table and user-detail routing"
git push
```

---

### Task 9: `worker-admin` frontend — user detail part 1 (connections, per-connection audit log, goals, tags, corrections)

**Files:**
- Modify: `worker-admin/public/index.html` (replace the Task 8 stub `renderUserDetail`)

**Interfaces:**
- Consumes: `USER_DETAIL` (Task 8), `auditRowHtml` (Task 7).
- Produces: real `renderUserDetail()` body covering everything except the latest report (Task 10 appends the report/session/task section to this same function's returned HTML).

- [ ] **Step 1: Replace the stub**

Find:

```javascript
function renderUserDetail() {
  if (!USER_DETAIL) return `<div class="empty-note">Loading…</div>`;
  return `<div class="empty-note">User detail rendering lands in Task 9/10.</div>`;
}
```

Replace with:

```javascript
function connChipStyle(status) {
  const color = status === "healthy" ? "var(--oc-done)" : status === "error" ? "var(--sev-high)" : "var(--faint)";
  return `color:${color};background:color-mix(in srgb,${color} 14%,transparent);border:1px solid color-mix(in srgb,${color} 30%,transparent)`;
}

function renderConnectionCard(conn) {
  const connEvents = (USER_DETAIL.events || []).filter(ev => ev.connection_id === conn.id);
  return `
  <div class="panel" style="margin-bottom:14px">
    <div style="display:flex;align-items:center;gap:10px;padding:14px 0 8px">
      <div style="min-width:0;flex:1">
        <div style="font-weight:700;font-size:15.5px">${escapeHtml(conn.project_name || conn.project_id)}</div>
        <div style="font-size:12px;color:var(--muted);font-family:'JetBrains Mono',monospace;margin-top:2px">${escapeHtml((conn.region || "").toUpperCase())} · ${escapeHtml(conn.timezone || "")}</div>
      </div>
      <span style="padding:4px 10px;border-radius:7px;font-size:11.5px;font-weight:600;${connChipStyle(conn.status)}">${escapeHtml(conn.status)}</span>
    </div>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;padding:10px 0;font-size:12.5px;border-top:1px solid var(--border-soft)">
      <span><span style="color:var(--muted)">Sync</span> ${escapeHtml(conn.sync_freq)} / ${conn.sync_max_sessions} sessions</span>
      <span><span style="color:var(--muted)">Last synced</span> ${conn.last_synced_at ? escapeHtml(String(conn.last_synced_at)) : "never"}</span>
      <span><span style="color:var(--muted)">Last pipeline run</span> ${conn.last_pipeline_run_at ? escapeHtml(String(conn.last_pipeline_run_at)) : "never"}</span>
    </div>
    ${conn.last_error ? `<div style="padding:8px 0;font-size:12.5px;color:var(--sev-high);border-top:1px solid var(--border-soft)">${escapeHtml(conn.last_error)}</div>` : ""}
    <div style="border-top:1px solid var(--border-soft);padding-top:4px">
      <div style="font-size:11px;font-weight:600;color:var(--faint);letter-spacing:.03em;padding:10px 0 2px">AUDIT LOG · ${connEvents.length}</div>
      ${connEvents.length ? connEvents.map(ev => auditRowHtml(ev)).join("") : `<div class="empty-note">No activity yet.</div>`}
    </div>
  </div>`;
}

function renderGoalsLibrary() {
  const goals = USER_DETAIL.goals || [];
  const rows = goals.map(g => `
    <div style="padding:12px 0;border-top:1px solid var(--border-soft)">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span style="font-weight:600;font-size:13px">${escapeHtml(g.purpose)}</span>
        <span style="font-size:10.5px;font-weight:600;color:var(--faint);background:var(--bg-sub);padding:2px 7px;border-radius:6px">${g.source === "auto" ? "AUTO" : "USER"}</span>
      </div>
      ${g.description ? `<div style="font-size:12.5px;color:var(--muted);margin-top:4px;line-height:1.5">${escapeHtml(g.description)}</div>` : ""}
    </div>`).join("");
  return `
  <div class="section-title">Goals<span style="margin-left:8px;font-family:'JetBrains Mono',monospace;font-weight:600;color:var(--faint)">${goals.length}</span></div>
  <div class="panel">${rows || `<div class="empty-note">No goals yet.</div>`}</div>`;
}

function renderTagsLibrary() {
  const tags = USER_DETAIL.tags || [];
  const chip = t => `<span style="display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:600;padding:4px 8px;border-radius:20px;color:${escapeHtml(t.color)};background:color-mix(in srgb,${escapeHtml(t.color)} 13%,transparent);border:1px solid color-mix(in srgb,${escapeHtml(t.color)} 28%,transparent)">${escapeHtml(t.label)}</span>`;
  return `
  <div class="section-title">Tags<span style="margin-left:8px;font-family:'JetBrains Mono',monospace;font-weight:600;color:var(--faint)">${tags.length}</span></div>
  <div class="panel" style="padding:16px 18px"><div style="display:flex;flex-wrap:wrap;gap:8px">${tags.length ? tags.map(chip).join("") : `<span class="empty-note">No tags yet.</span>`}</div></div>`;
}

function renderCorrectionsTable() {
  const corrections = USER_DETAIL.corrections || [];
  const rows = corrections.map(c => `
    <div style="display:grid;grid-template-columns:1.5fr 1fr 1fr 1fr 2fr;gap:12px;padding:10px 0;border-top:1px solid var(--border-soft);font-size:12.5px">
      <span style="font-weight:500">${escapeHtml(c.task_title || c.session_id)}</span>
      <span style="color:var(--muted)">${escapeHtml(c.field)}</span>
      <span style="color:var(--faint)">${escapeHtml(c.from_value ?? "")} &rarr; ${escapeHtml(c.to_value ?? "")}</span>
      <span style="color:var(--faint)">${escapeHtml(String(c.created_at || "").slice(0, 10))}</span>
      <span style="color:var(--muted)">${escapeHtml(c.reason)}</span>
    </div>`).join("");
  return `
  <div class="section-title">Corrections<span style="margin-left:8px;font-family:'JetBrains Mono',monospace;font-weight:600;color:var(--faint)">${corrections.length}</span></div>
  <div class="panel">
    ${corrections.length ? `<div style="display:grid;grid-template-columns:1.5fr 1fr 1fr 1fr 2fr;gap:12px;padding:10px 0;font-size:11px;font-weight:600;color:var(--faint);text-transform:uppercase;letter-spacing:.03em">
      <span>Task</span><span>Field</span><span>Change</span><span>Date</span><span>Reason</span>
    </div>${rows}` : `<div class="empty-note">No corrections yet.</div>`}
  </div>`;
}

function renderUserDetail() {
  if (!USER_DETAIL) return `<div class="empty-note">Loading…</div>`;
  const u = USER_DETAIL;
  const connections = u.connections || [];
  return `
  <button data-act="nav" data-view="users" style="font-size:13px;color:var(--muted);margin-bottom:14px;display:inline-block">&larr; Users</button>
  <div style="font-size:20px;font-weight:700;letter-spacing:-.02em;margin-bottom:2px">${escapeHtml(u.user.email)}</div>
  <div style="font-size:12.5px;color:var(--muted);margin-bottom:22px">Signed up ${escapeHtml(String(u.user.created_at || "").slice(0, 10))}</div>
  <div class="section-title">Connections<span style="margin-left:8px;font-family:'JetBrains Mono',monospace;font-weight:600;color:var(--faint)">${connections.length}</span></div>
  ${connections.length ? connections.map(renderConnectionCard).join("") : `<div class="panel"><div class="empty-note">No connections yet.</div></div>`}
  <div style="margin-top:24px">${renderLatestReportSection()}</div>
  <div style="margin-top:24px">${renderGoalsLibrary()}</div>
  <div style="margin-top:24px">${renderTagsLibrary()}</div>
  <div style="margin-top:24px">${renderCorrectionsTable()}</div>`;
}
```

- [ ] **Step 2: Add a temporary stub for `renderLatestReportSection`, replaced in Task 10**

Immediately before `function renderUserDetail() {` (from Step 1), insert:

```javascript
function renderLatestReportSection() {
  return `<div class="section-title">Latest report</div><div class="panel"><div class="empty-note">Report rendering lands in Task 10.</div></div>`;
}
```

- [ ] **Step 3: Deploy**

```bash
cd worker-admin && npx wrangler deploy && cd ..
```

- [ ] **Step 4: Playwright-verify against real data**

Log in, open the Users table, click `shubhamvishnu@gmail.com`, confirm:
1. At least one real connection card renders with real `project_name`, correctly colored status chip, real sync settings, and its own real audit-log entries (matching what `curl .../api/connections/1/events` on the *main* app already showed in the audit-log plan's verification).
2. Goals library shows real goals (if any exist) with correct AUTO/USER badges.
3. Tags library shows real tag chips with correct colors.
4. Corrections table shows real rows (if any exist) or the empty state.
5. No console errors.

- [ ] **Step 5: Commit**

```bash
git add worker-admin/public/index.html
git commit -m "Add worker-admin user-detail: connections, per-connection audit log, goals, tags, corrections"
git push
```

---

### Task 10: `worker-admin` frontend — user detail part 2 (latest report, task cards, tag chips, goal badges, captured moments)

**Files:**
- Modify: `worker-admin/public/index.html` (replace the Task 9 stub `renderLatestReportSection`)

**Interfaces:**
- Consumes: `USER_DETAIL.latest_report` (Task 5), `GET /api/media/:key` (Task 6), `AUDIT_STATUS_VAR`/`escapeHtml` (Task 7).
- Produces: real `renderLatestReportSection()` body; `state.expandedTask` (new field, tracks which task card is open per session, read-only expand/collapse — no mutation).

- [ ] **Step 1: Extend `state` with expand-tracking fields**

Find:

```javascript
const state = { view: "overview", selUserEmail: null };
```

Replace with:

```javascript
const state = { view: "overview", selUserEmail: null, expandedTask: {}, expandedMoments: {} };
```

- [ ] **Step 2: Replace the stub `renderLatestReportSection`**

Find:

```javascript
function renderLatestReportSection() {
  return `<div class="section-title">Latest report</div><div class="panel"><div class="empty-note">Report rendering lands in Task 10.</div></div>`;
}
```

Replace with:

```javascript
const SEV_VAR = { high: "var(--sev-high)", medium: "var(--sev-med)", low: "var(--faint)", none: "var(--faint)" };

function sevOf(t) { return t.severity || "none"; }

function tagChipHtml(tag) {
  if (!tag) return "";
  const color = tag.color || "#64748b";
  return `<span style="display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:600;padding:4px 8px;border-radius:20px;color:${escapeHtml(color)};background:color-mix(in srgb,${escapeHtml(color)} 13%,transparent);border:1px solid color-mix(in srgb,${escapeHtml(color)} 28%,transparent)">${escapeHtml(tag.label)}</span>`;
}

function taskTagsHtml(t) {
  const tagIds = (t.tags || []).map(tg => tg.tag_id);
  const defs = (USER_DETAIL.tags || []).filter(d => tagIds.includes(d.id));
  return defs.length ? `<div style="display:flex;flex-wrap:wrap;gap:6px;margin:8px 0">${defs.map(tagChipHtml).join("")}</div>` : "";
}

function taskGoalBadgeHtml(t) {
  if (!t.goal_id) return "";
  const goal = (USER_DETAIL.goals || []).find(g => g.id === t.goal_id);
  if (!goal) return "";
  return `<div style="font-size:12px;color:var(--muted);margin:6px 0"><span style="color:var(--faint)">Goal ·</span> ${escapeHtml(goal.purpose)}</div>`;
}

function toggleTask(key) {
  state.expandedTask[key] = !state.expandedTask[key];
  render();
}

function toggleMoments(key) {
  state.expandedMoments[key] = !state.expandedMoments[key];
  render();
}

function renderCapturedMomentsRO(f, ti, t) {
  const media = t.media || [];
  if (!media.length) return "";
  const key = `${f.session_id}:${ti}`;
  const shown = !!state.expandedMoments[key];
  // task.media[].url is stored as "/api/media/<key>" (main app's own route shape); worker-admin
  // serves the identical path shape from its own /api/media/:key proxy, so it's used as-is.
  const grid = media.map(m => `
    <div style="position:relative;width:120px;height:76px;flex:none;border-radius:8px;overflow:hidden;background:var(--bg-sub)">
      ${m.url ? `<img src="${escapeHtml(m.url)}" alt="Captured moment" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover" onerror="this.style.display='none'"/>` : ""}
      <span style="position:absolute;left:6px;bottom:5px;font-size:10px;color:#fff;text-shadow:0 1px 2px rgba(0,0,0,.6)">${escapeHtml(m.ts || "")}</span>
    </div>`).join("");
  return `
  <div style="margin-top:10px">
    <button data-act="toggle-moments" data-key="${escapeHtml(key)}" style="font-size:11px;font-weight:600;color:var(--muted);display:flex;align-items:center;gap:5px">CAPTURED MOMENTS <span style="color:var(--faint)">${media.length}</span></button>
    ${shown ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">${grid}</div>` : ""}
  </div>`;
}

function renderTaskCardRO(f, ti, t) {
  const key = `${f.session_id}:${ti}`;
  const open = !!state.expandedTask[key];
  return `
  <div style="border-top:1px solid var(--border-soft)">
    <button data-act="toggle-task" data-key="${escapeHtml(key)}" style="display:flex;align-items:center;gap:10px;width:100%;text-align:left;padding:12px 0">
      <span style="font-size:13px;font-weight:600;flex:1;min-width:0">${escapeHtml(t.title)}</span>
      <span style="font-size:11.5px;font-weight:500;color:${SEV_VAR[sevOf(t)]}">${escapeHtml(sevOf(t))}</span>
      <span style="width:7px;height:7px;border-radius:50%;background:${t.real_bug ? "var(--sev-high)" : "var(--faint)"}" title="${t.real_bug ? "Real bug" : "Not a bug"}"></span>
    </button>
    ${open ? `
    <div style="padding-bottom:14px">
      ${taskGoalBadgeHtml(t)}
      ${taskTagsHtml(t)}
      <p style="font-size:12.5px;color:var(--muted);line-height:1.55;margin:6px 0">${escapeHtml(t.narrative || "")}</p>
      ${renderCapturedMomentsRO(f, ti, t)}
    </div>` : ""}
  </div>`;
}

function renderSessionCardRO(f) {
  const tasks = f.tasks || [];
  return `
  <div class="panel" style="margin-bottom:12px">
    <div style="padding:14px 0 4px;display:flex;align-items:center;gap:10px">
      <span style="font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--faint)">${escapeHtml((f.session_id || "").slice(0, 12))}</span>
      <span style="font-size:12px;color:var(--muted)">${tasks.length} task${tasks.length === 1 ? "" : "s"}</span>
      ${f.recommended_outreach ? `<span style="margin-left:auto;font-size:10.5px;font-weight:600;color:var(--accent);background:color-mix(in srgb,var(--accent) 12%,transparent);padding:2px 8px;border-radius:6px">Outreach recommended</span>` : ""}
    </div>
    ${tasks.map((t, ti) => renderTaskCardRO(f, ti, t)).join("")}
  </div>`;
}

function renderLatestReportSection() {
  const report = USER_DETAIL.latest_report;
  const history = USER_DETAIL.report_history || [];
  const historyHtml = history.length ? `
    <div style="font-size:11.5px;color:var(--faint);margin:10px 0 18px">
      ${history.map(r => `${escapeHtml(String(r.generated_at || "").slice(0, 10))} · ${r.task_count} tasks`).join(" &nbsp;·&nbsp; ")}
    </div>` : "";
  if (!report) {
    return `<div class="section-title">Latest report</div><div class="panel"><div class="empty-note">No report yet.</div></div>${historyHtml}`;
  }
  const findings = report.micro_findings || [];
  return `
  <div class="section-title">Latest report<span style="margin-left:8px;font-family:'JetBrains Mono',monospace;font-weight:600;color:var(--faint)">${escapeHtml(String(report.generated_at || "").slice(0, 10))}</span></div>
  ${historyHtml}
  ${findings.length ? findings.map(renderSessionCardRO).join("") : `<div class="panel"><div class="empty-note">No sessions in this report.</div></div>`}`;
}
```

- [ ] **Step 3: Wire the new click handlers**

Find:

```javascript
  else if (act === "open-user") { openUser(el.dataset.email); }
});
```

Replace with:

```javascript
  else if (act === "open-user") { openUser(el.dataset.email); }
  else if (act === "toggle-task") { toggleTask(el.dataset.key); }
  else if (act === "toggle-moments") { toggleMoments(el.dataset.key); }
});
```

- [ ] **Step 4: Deploy**

```bash
cd worker-admin && npx wrangler deploy && cd ..
```

- [ ] **Step 5: Playwright-verify against real report data**

Log in, open `shubhamvishnu@gmail.com`'s user detail, scroll to "Latest report", confirm:
1. Real sessions render as cards with real session IDs and task counts.
2. Clicking a task card expands it, showing the real narrative, any real tag chips (matching colors from the tags library rendered in Task 9), and a goal badge if `goal_id` is set.
3. If any task has `media`, "CAPTURED MOMENTS" appears; click to expand, confirm a real `<img>` requests `/api/media/<key>` and (if a real captured-moment image exists for this tenant) the thumbnail actually loads — check the Network tab for a `200` on that request, not a broken-image icon.
4. Report history line shows real prior report dates/task counts if more than one report exists.
5. No console errors anywhere in the user-detail view.

- [ ] **Step 6: Commit**

```bash
git add worker-admin/public/index.html
git commit -m "Add worker-admin latest report: session/task cards, tag chips, goal badges, captured moments"
git push
```

---

## Self-Review

**Spec coverage:**
- Separate Worker `bug-radar-admin`, own `worker-admin/` dir, shared D1 → Task 2.
- Login restricted to `shubhamvishnu@gmail.com`, `request-otp` 404s others → Task 2.
- Full read-only drill-down per tenant (connections minus key, latest report, goals, tags, corrections, audit log) → Task 5 (data), Tasks 9–10 (UI).
- Global cross-tenant activity feed → Task 3 (`/api/events`), Task 7 (UI).
- Overview screen (4 numbers) → Task 3, Task 7.
- Captured-moment thumbnails via new main-Worker route, not a second R2/key copy → Task 1 (main-Worker route), Task 6 (proxy), Task 10 (UI).
- No editing/deleting/impersonating, every route `GET` → enforced throughout (`adminAuthed` checks, no `POST`/`PATCH`/`DELETE` routes added anywhere in `worker-admin`).
- No raw SQL browser → not built.
- No custom domain → not built, `*.workers.dev` used throughout.
- Only main-Worker change is the one narrow media route → Task 1 is the only `worker/` change in this plan.
- `worker-admin` never gets `CONNECTION_ENCRYPTION_KEY`/`BUGRADAR_API_SECRET` → never referenced anywhere in Tasks 2–10.
- Verification steps 1–6 from the spec's own Verification section → mapped to Task 2 (steps 1–4 of spec), Task 1 (step 5), Task 7/9/10 (step 6, Playwright pass).

**Placeholder scan:** No "TBD"/"add appropriate X"/"similar to Task N" patterns present — every step has literal code or a literal, runnable command. The two intentionally temporary stubs (`renderUserDetail` in Task 8, `renderLatestReportSection` in Task 9) are not placeholders in the forbidden sense — they're real, working, minimal implementations that keep the file valid and testable at every commit boundary, each explicitly replaced by name in the very next task.

**Type/interface consistency:**
- `adminAuthed(request, env)` defined in Task 2, called identically (`if (!(await adminAuthed(request, env))) return json(...)`) in Tasks 3, 4, 5, 6.
- `ADMIN_EMAIL` defined once in Task 2, referenced nowhere else by literal string (all comparisons go through `adminAuthed`/the request-otp and verify-otp checks written in Task 2).
- `SESSION_COOKIE = "bugradar_admin_session"` defined once in Task 2, never redefined.
- `env.MAIN_WORKER_URL` and `env.ADMIN_MEDIA_SECRET` set in Task 2 (wrangler.jsonc var) and Task 6 (secret) respectively, consumed only in Task 6.
- `GET /api/users/:email` response shape (`user`, `connections`, `latest_report`, `report_history`, `goals`, `tags`, `corrections`, `events`) defined in Task 5 matches exactly what Tasks 9–10's `USER_DETAIL.*` accessors read (`USER_DETAIL.user.email`, `USER_DETAIL.connections`, `USER_DETAIL.latest_report.micro_findings`, `USER_DETAIL.report_history`, `USER_DETAIL.goals`, `USER_DETAIL.tags`, `USER_DETAIL.corrections`, `USER_DETAIL.events`).
- `auditRowHtml(ev, opts)` defined in Task 7 with an `opts.showOwner` flag; Task 7's own overview feed passes `{ showOwner: true }` (cross-tenant feed needs the owner label); Task 9's per-connection audit log calls it with no `opts` (single-tenant context, owner label would be redundant) — both call sites match the function's actual signature.
- `state.view` cases (`overview`, `users`, `user-detail`) are added to `renderMainContent`'s `switch` in the same task that introduces each view (Task 7 adds `overview` and the `switch`, Task 8 adds `users`/`user-detail`) — no task references a `state.view` value that isn't a real `case`.
