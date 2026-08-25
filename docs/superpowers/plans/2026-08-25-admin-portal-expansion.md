# Admin Portal Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `worker-admin` into the full cross-tenant admin surface: password login for the single admin account, and dense Linear-style compact-table screens covering Tenants, Sessions, Integrations, Goals, Tags, Slack, and Events across every tenant.

**Architecture:** `worker-admin` is a separate Cloudflare Worker (`bug-radar-admin`) sharing the same D1 database as the main app (`bug-radar-db`, database id `65292c22-00df-42a0-ad9b-b5bb97dee409`). All new screens are read-only cross-tenant SELECT queries against existing tables — no new tables except one small login-attempts counter. The frontend is a single `worker-admin/public/index.html` (vanilla JS, `render()` rebuilds `innerHTML`, `data-act` click delegation) — this plan ports the main app's sidebar/list-row CSS and JS helpers into it wholesale so both apps share one visual language.

**Tech Stack:** Cloudflare Workers, D1 (SQLite), vanilla JS/HTML (no framework, no bundler), Wrangler CLI.

**Spec:** `docs/superpowers/specs/2026-08-25-admin-portal-expansion-design.md`

## Global Constraints

- No unit test framework exists in this repo. Verification is by deploying (`npx wrangler deploy` from `worker-admin/`) and checking with direct `curl` against the live routes, plus a Playwright screenshot pass for UI changes — this is the established verification pattern used throughout this project (see the Slack integration build).
- The D1 database is shared between `worker/` and `worker-admin/` (same `database_id`). Schema changes go in `worker/schema.sql` (the single canonical schema file — `worker-admin/` has no schema file of its own) and are applied live via `npx wrangler d1 execute bug-radar-db --remote --command="..."`.
- `ADMIN_EMAIL` stays hardcoded to `shubhamvishnu@gmail.com` in `worker-admin/src/index.js` — unchanged.
- `ADMIN_PASSWORD_HASH` is set as a Wrangler secret (`npx wrangler secret put ADMIN_PASSWORD_HASH` from `worker-admin/`) by the plan's controller **before Task 2 begins**, computed once from the plaintext password already given in chat. It is never included in any task brief, never printed, and never committed to source. Task 2's implementer must treat `env.ADMIN_PASSWORD_HASH` as already present and correctly formatted (`<salt_hex>:<hash_hex>`).
- "Tenants" is a UI label change only. The existing route (`/api/users`, `/api/users/:email`), function names (`renderUsersTable`, `openUser`, `USER_DETAIL`), and state field (`state.selUserEmail`) are **not** renamed anywhere in this plan — only the sidebar label and page-header title text change to say "Tenants".
- New cross-tenant tables reuse the exact CSS classes ported from `worker/public/index.html` in Task 4 (`.pageheader`, `.list-subhead`, `.list-row`, `.col-user`, `.avatar`) rather than inventing new ones. Columns that need a fixed width use an inline `style="width:Npx"` on the row's `<span>` — this repo already does exactly that for one-off table columns (see `worker-admin/public/index.html`'s existing `renderUsersTable`/`renderCorrectionsTable` inline grid columns), so no new named CSS classes are added for per-screen columns.
- Every new list endpoint that caps results states the cap in its response and the frontend shows it (e.g. "showing latest 200 of the most recent 500 reports scanned") — no cap is silent.
- Deploy from `worker-admin/` after each task (`npx wrangler deploy`) before verification steps that hit the live URL (`https://bug-radar-admin.shubhamvishnu.workers.dev`).

---

### Task 1: `admin_login_attempts` table

**Files:**
- Modify: `worker/schema.sql` (append at end of file)

**Interfaces:**
- Produces: table `admin_login_attempts(email TEXT PRIMARY KEY, failed_count INTEGER NOT NULL DEFAULT 0, locked_until TEXT, updated_at TEXT)`, used by Task 2.

- [ ] **Step 1: Add the table to schema.sql**

Append to `worker/schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS admin_login_attempts (
  email TEXT PRIMARY KEY,
  failed_count INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);
```

- [ ] **Step 2: Apply it to the live database**

Run from `worker/`:
```bash
npx wrangler d1 execute bug-radar-db --remote --command="CREATE TABLE IF NOT EXISTS admin_login_attempts (email TEXT PRIMARY KEY, failed_count INTEGER NOT NULL DEFAULT 0, locked_until TEXT, updated_at TEXT DEFAULT (datetime('now')));"
```
Expected: `"success": true`.

- [ ] **Step 3: Verify the table exists**

```bash
npx wrangler d1 execute bug-radar-db --remote --command="SELECT name FROM sqlite_master WHERE type='table' AND name='admin_login_attempts';"
```
Expected: one row, `name: "admin_login_attempts"`.

- [ ] **Step 4: Commit**

```bash
git add worker/schema.sql
git commit -m "Add admin_login_attempts table for admin password lockout"
```

---

### Task 2: Backend — password login replaces OTP

**Files:**
- Modify: `worker-admin/src/index.js`

**Interfaces:**
- Consumes: `admin_login_attempts` table (Task 1), `env.ADMIN_PASSWORD_HASH` secret (already set by the controller, format `<salt_hex>:<hash_hex>`).
- Produces: `POST /api/auth/login` (body `{email, password}` → `{ok:true, email}` + session cookie on success, `401`/`429` on failure). `getSessionEmail`/`adminAuthed`/`/api/auth/me`/`/api/auth/logout` are unchanged and still used by later tasks.

The current file has (all in `worker-admin/src/index.js`):
- Constants at the top: `SESSION_COOKIE`, `SESSION_DAYS`, `OTP_TTL_MS`, `OTP_RESEND_COOLDOWN_MS`, `OTP_MAX_ATTEMPTS`, `ADMIN_EMAIL` (lines 1-6).
- Helper `sqliteTimeToMs` (line ~24), `randomOtp` (line ~46), `sendOtpEmail` (line ~52).
- Routes `POST /api/auth/request-otp` (line 82) and `POST /api/auth/verify-otp` (line 107).

- [ ] **Step 1: Remove the OTP constants and helpers**

Delete `OTP_TTL_MS`, `OTP_RESEND_COOLDOWN_MS`, `OTP_MAX_ATTEMPTS` from the top-of-file constants (keep `SESSION_COOKIE`, `SESSION_DAYS`, `ADMIN_EMAIL`). Delete the `randomOtp` and `sendOtpEmail` functions entirely.

- [ ] **Step 2: Add password-hashing and constant-time-compare helpers**

Add near the other top-of-file helpers (after `sqliteTimeToMs`):

```js
async function pbkdf2Hash(password, saltHex) {
  const saltBytes = saltHex.match(/.{2}/g).map(b => parseInt(b, 16));
  const salt = new Uint8Array(saltBytes);
  const keyMaterial = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 210000, hash: "SHA-256" }, keyMaterial, 256
  );
  return Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
```

- [ ] **Step 3: Replace `request-otp`/`verify-otp` with `POST /api/auth/login`**

Delete the `if (pathname === "/api/auth/request-otp" ...)` and `if (pathname === "/api/auth/verify-otp" ...)` blocks entirely. In their place:

```js
if (pathname === "/api/auth/login" && request.method === "POST") {
  const body = await request.json().catch(() => ({}));
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  if (email !== ADMIN_EMAIL) return json({ error: "Incorrect email or password." }, 401);

  const attemptRow = await env.DB.prepare(
    "SELECT failed_count, locked_until FROM admin_login_attempts WHERE email = ?"
  ).bind(email).first();
  if (attemptRow && attemptRow.locked_until && Date.parse(attemptRow.locked_until) > Date.now()) {
    return json({ error: "Too many attempts. Try again in 15 minutes." }, 429);
  }

  const [saltHex, expectedHashHex] = String(env.ADMIN_PASSWORD_HASH || "").split(":");
  const candidateHashHex = saltHex ? await pbkdf2Hash(password, saltHex) : "";
  const ok = !!saltHex && !!expectedHashHex && timingSafeEqual(candidateHashHex, expectedHashHex);

  if (!ok) {
    const failedCount = (attemptRow?.failed_count || 0) + 1;
    const lockedUntil = failedCount >= 5 ? new Date(Date.now() + 15 * 60 * 1000).toISOString() : null;
    await env.DB.prepare(
      `INSERT INTO admin_login_attempts (email, failed_count, locked_until, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(email) DO UPDATE SET failed_count = ?, locked_until = ?, updated_at = datetime('now')`
    ).bind(email, failedCount, lockedUntil, failedCount, lockedUntil).run();
    return json({ error: "Incorrect email or password." }, 401);
  }

  await env.DB.prepare(
    `INSERT INTO admin_login_attempts (email, failed_count, locked_until, updated_at)
     VALUES (?, 0, NULL, datetime('now'))
     ON CONFLICT(email) DO UPDATE SET failed_count = 0, locked_until = NULL, updated_at = datetime('now')`
  ).bind(email).run();

  await env.DB.prepare("INSERT OR IGNORE INTO users (email) VALUES (?)").bind(email).run();
  const token = crypto.randomUUID();
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  const expiresAt = new Date(Date.now() + maxAge * 1000).toISOString();
  await env.DB.prepare(
    "INSERT INTO sessions (token, email, expires_at, surface) VALUES (?, ?, ?, 'admin')"
  ).bind(token, email, expiresAt).run();
  return json({ ok: true, email }, 200, { "set-cookie": sessionCookieHeader(token, maxAge) });
}
```

- [ ] **Step 4: Deploy**

```bash
cd worker-admin && npx wrangler deploy
```

- [ ] **Step 5: Verify — wrong password is rejected**

```bash
curl -s -X POST https://bug-radar-admin.shubhamvishnu.workers.dev/api/auth/login \
  -H "content-type: application/json" -d '{"email":"shubhamvishnu@gmail.com","password":"wrong"}'
```
Expected: `{"error":"Incorrect email or password."}` with HTTP 401.

- [ ] **Step 6: Verify — correct password succeeds and sets a cookie**

Ask the controller for the real password out-of-band (never write it into a command in this task); run the same curl with `-i` and the real password, confirm `HTTP/2 200`, a `set-cookie: bugradar_admin_session=...` header, and body `{"ok":true,"email":"shubhamvishnu@gmail.com"}`.

- [ ] **Step 7: Verify — 5 wrong attempts lock the account**

Run the Step 5 curl 5 times in a row, then once more. Expected: the 6th call returns HTTP 429 with `{"error":"Too many attempts. Try again in 15 minutes."}`.

- [ ] **Step 8: Reset the lockout from Step 7 before continuing**

```bash
cd worker && npx wrangler d1 execute bug-radar-db --remote --command="DELETE FROM admin_login_attempts WHERE email = 'shubhamvishnu@gmail.com';"
```

- [ ] **Step 9: Commit**

```bash
git add worker-admin/src/index.js
git commit -m "Replace admin OTP login with password login + lockout"
```

---

### Task 3: Frontend — password login screen

**Files:**
- Modify: `worker-admin/public/index.html`

**Interfaces:**
- Consumes: `POST /api/auth/login` (Task 2).
- Produces: `renderLoginShell()` (unchanged name, new contents), `loginState` (new shape: `{email: "", password: "", error: "", submitting: false}` — replaces the old 2-step shape).

The current file has: `loginState` (line 91, old 2-step shape), `submitLoginEmail`/`verifyLoginOtp`/`backToLoginEmail`/`startResendTimer`/`otpResendRowHtml`/`onOtpInput`/`onOtpKeydown` (lines 376-481), `renderLoginEmailStep`/`renderLoginOtpStep`/`renderLoginShell` (lines 483-529), the OTP-related `data-act` handlers in the `click`/`input`/`keydown`/`submit` delegates (lines 564-596), and the OTP-specific CSS (`.otp-back`, `.otp-cells`, `.otp-cell`, `.otp-verify-btn`, `.otp-resend-row`, `.spinner`, lines 52-62).

- [ ] **Step 1: Replace `loginState`**

Replace line 91:
```js
const loginState = { step: "email", email: "", sending: false, emailError: "", otp: ["", "", "", "", "", ""], otpError: "", verifying: false, resendIn: 0 };
```
with:
```js
const loginState = { email: "", password: "", error: "", submitting: false };
```

- [ ] **Step 2: Replace the login JS functions**

Delete `submitLoginEmail`, `verifyLoginOtp`, `backToLoginEmail`, `resendTimer`/`startResendTimer`, `otpResendRowHtml`, `onOtpInput`, `onOtpKeydown` entirely. Replace with:

```js
async function submitLogin(e) {
  e.preventDefault();
  loginState.error = "";
  loginState.submitting = true;
  render();
  try {
    const res = await fetch("/api/auth/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: loginState.email, password: loginState.password }),
    });
    const data = await res.json().catch(() => ({}));
    loginState.submitting = false;
    if (!res.ok) { loginState.error = data.error || "Something went wrong. Try again."; render(); return; }
    AUTH.email = data.email;
    await loadOverview();
    await loadUsers();
    render();
  } catch (err) {
    loginState.submitting = false;
    loginState.error = "Network error. Try again.";
    render();
  }
}
```

- [ ] **Step 3: Replace the login render functions**

Delete `renderLoginEmailStep` and `renderLoginOtpStep`. Replace `renderLoginShell` (line 521) with:

```js
function renderLoginShell() {
  const s = loginState;
  return `
  <div class="login-wrap">
    <div class="login-card">
      <div class="login-brand">Bug Radar Admin</div>
      <div class="login-title">Bug Radar Admin</div>
      <div class="login-subtitle">Sign in with the admin account.</div>
      <form id="loginForm">
        <label class="login-label">Email</label>
        <div class="login-field${s.error ? " err" : ""}">
          <input id="loginEmailInput" type="email" placeholder="you@company.com" autocomplete="email" value="${escapeHtml(s.email)}"/>
        </div>
        <label class="login-label" style="margin-top:14px">Password</label>
        <div class="login-field${s.error ? " err" : ""}">
          <input id="loginPasswordInput" type="password" placeholder="••••••••" autocomplete="current-password" value="${escapeHtml(s.password)}"/>
        </div>
        ${s.error ? `<div class="login-error">${escapeHtml(s.error)}</div>` : ""}
        <button type="submit" class="login-primary-btn${s.submitting ? " disabled" : ""}">
          ${s.submitting ? `<span class="spinner"></span>` : `<span>Sign in</span>`}
        </button>
      </form>
    </div>
  </div>`;
}
```

- [ ] **Step 4: Update the event delegates**

In the `document.addEventListener("click", ...)` block (line 564), delete the `otp-back`, `otp-verify`, `otp-resend` branches.

In the `document.addEventListener("input", ...)` block (line 578), replace:
```js
document.addEventListener("input", e => {
  if (e.target.dataset && e.target.dataset.otpIndex !== undefined) {
    onOtpInput(Number(e.target.dataset.otpIndex), e.target.value);
  }
  if (e.target.id === "loginEmailInput") {
    loginState.email = e.target.value;
    loginState.emailError = "";
  }
});
```
with:
```js
document.addEventListener("input", e => {
  if (e.target.id === "loginEmailInput") { loginState.email = e.target.value; loginState.error = ""; }
  if (e.target.id === "loginPasswordInput") { loginState.password = e.target.value; loginState.error = ""; }
});
```

Delete the `document.addEventListener("keydown", ...)` block (line 588) entirely — it existed only for OTP backspace-navigation.

In the `document.addEventListener("submit", ...)` block (line 594), replace:
```js
document.addEventListener("submit", e => {
  if (e.target.id === "loginEmailForm") submitLoginEmail(e);
});
```
with:
```js
document.addEventListener("submit", e => {
  if (e.target.id === "loginForm") submitLogin(e);
});
```

- [ ] **Step 5: Update `logout()`**

In `logout()` (line 607), replace the trailing OTP-state reset lines:
```js
  loginState.step = "email";
  loginState.email = "";
  loginState.otp = ["", "", "", "", "", ""];
```
with:
```js
  loginState.email = "";
  loginState.password = "";
```

- [ ] **Step 6: Remove the now-dead OTP CSS**

Delete these rules from the `<style>` block (lines 52-60): `.otp-back`, `.otp-cells`, `.otp-cell`, `.otp-cell.filled`, `.otp-cell.err`, `.otp-verify-btn`, `.otp-verify-btn.disabled`, `.otp-resend-row`, `.otp-resend-row button`. Keep `.spinner`/`@keyframes spin` (line 61-62) — still used by the new submit button.

- [ ] **Step 7: Deploy and verify visually**

```bash
cd worker-admin && npx wrangler deploy
```
Navigate to `https://bug-radar-admin.shubhamvishnu.workers.dev/` with Playwright, take a screenshot: expect one form with Email + Password fields and a single "Sign in" button, no OTP UI. Check console for errors (expect none beyond the pre-existing harmless 401 on `/api/auth/me` before login).

- [ ] **Step 8: Commit**

```bash
git add worker-admin/public/index.html
git commit -m "Replace admin OTP login UI with password form"
```

---

### Task 4: Sidebar shell — port CSS/icons, promote Events, relabel Tenants

**Files:**
- Modify: `worker-admin/public/index.html`
- Modify: `worker-admin/src/index.js` (`GET /api/users`, small addition — see Step 4b)

**Interfaces:**
- Consumes: `slack_connections` table (Step 4b).
- Produces: CSS classes `.sidebar`, `.side-nav`, `.nav-item`, `.pageheader`, `.list-subhead`, `.list-row`, `.col-user`, `.avatar` (+ `.avatar.md`), now present in `worker-admin`'s `<style>` block for Tasks 5-10 to use. `ICON_LOGO`, `ICON_PEOPLE`, `ICON_SESSIONS`, `ICON_PLUG`, `ICON_TARGET`, `ICON_TAG`, `ICON_ACTIVITY`, `SLACK_MARK_SVG` as global JS constants/functions. `state.view` gains two new valid values used from this task on: `"events"`. `renderSidebar()` (new function) and `renderMainContent()`/`render()` updated to use it instead of `renderTopbar()`. `GET /api/users`'s response objects gain a `slack_status` field (`"connected" | null`).

This task does **not** add Sessions/Integrations/Goals/Tags/Slack nav items yet — those are added by their own tasks (5 through 10), each alongside the screen it links to, so the sidebar never has a nav item with nothing behind it.

- [ ] **Step 1: Copy the shared CSS rules verbatim**

From `worker/public/index.html`, copy these exact rule blocks into `worker-admin/public/index.html`'s `<style>` block, appended after the existing `.empty-note` rule (former line 79):

- Lines 65-101 (`.app` through `.user-role` — the sidebar shell, nav items, and avatar rules). Skip `.profile-menu*` rules (lines 82-88) and `.theme-wrap`/`.theme-btn` rules (lines 74-78) — not needed for this admin's simpler bottom section.
- Lines 102-111 (`.main` through `.contentpad`).
- Lines 151-160 (`.list-subhead` through `.col-user .meta`).

Do not copy `:root`/`html[data-theme="dark"]` variable blocks — `worker-admin` already defines its own (they use the same variable names, values match closely enough that visual parity holds; if any variable referenced by the copied rules is undefined in `worker-admin`'s `:root` block, add it there with the exact value from `worker/public/index.html`'s `:root` block — check `--bg-side`, `--bg-active` specifically, both are used by the copied rules and are missing from `worker-admin`'s current `:root`).

Remove the old `.topbar*` rules (lines 66-71 of the original `worker-admin/public/index.html`) — replaced by the sidebar.

- [ ] **Step 2: Add the icon constants**

Add near the top of the `<script>` block (after the `safeColor` function):

```js
const ICON_LOGO = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="3.4" cy="12.6" r="1.7" fill="var(--accent)"/><path d="M3.4 8.4A4.2 4.2 0 0 1 7.6 12.6" stroke="var(--icon-fg)" stroke-width="1.5" stroke-linecap="round" stroke-opacity=".92"/><path d="M3.4 4.4A8.2 8.2 0 0 1 11.6 12.6" stroke="var(--icon-fg)" stroke-width="1.5" stroke-linecap="round" stroke-opacity=".5"/></svg>`;
const ICON_PEOPLE = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="flex:none"><circle cx="9" cy="8" r="3.1"/><path d="M3.6 19c.5-3 2.8-4.6 5.4-4.6S13.9 16 14.4 19"/><path d="M16.4 5.5a3 3 0 0 1 0 5.1M18.4 19c-.3-2-1.1-3.3-2.5-4.1"/></svg>`;
const ICON_SESSIONS = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="flex:none"><rect x="3.5" y="4.5" width="17" height="15" rx="2.4"/><path d="M3.5 9h17M8 13h5M8 16h8"/></svg>`;
const ICON_PLUG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="flex:none"><path d="M9 2v6M15 2v6M7 8h10l-1 5a5 5 0 0 1-8 0z"/><path d="M12 17v5"/></svg>`;
const ICON_TARGET = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="flex:none"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r=".8" fill="currentColor"/></svg>`;
const ICON_TAG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="flex:none"><path d="M11.5 3.5H5a1.5 1.5 0 0 0-1.5 1.5v6.5L13 21l7.5-7.5z"/><circle cx="8" cy="8" r="1.2" fill="currentColor" stroke="none"/></svg>`;
const ICON_ACTIVITY = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="flex:none"><path d="M3 12h4l2.5-7L14 19l2.5-7H21"/></svg>`;
const SLACK_MARK_SVG = (px) => `<svg width="${px}" height="${px}" viewBox="0 0 122 122" fill="none"><path d="M25.8 77c0 7.1-5.8 12.9-12.9 12.9S0 84.1 0 77s5.8-12.9 12.9-12.9h12.9V77z" fill="#E01E5A"/><path d="M32.3 77c0-7.1 5.8-12.9 12.9-12.9S58.1 69.9 58.1 77v32.3c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V77z" fill="#E01E5A"/><path d="M45.2 25.8c-7.1 0-12.9-5.8-12.9-12.9S38.1 0 45.2 0s12.9 5.8 12.9 12.9v12.9H45.2z" fill="#36C5F0"/><path d="M45.2 32.3c7.1 0 12.9 5.8 12.9 12.9S52.3 58.1 45.2 58.1H12.9C5.8 58.1 0 52.3 0 45.2s5.8-12.9 12.9-12.9h32.3z" fill="#36C5F0"/><path d="M96.2 45.2c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9-5.8 12.9-12.9 12.9H96.2V45.2z" fill="#2EB67D"/><path d="M89.7 45.2c0 7.1-5.8 12.9-12.9 12.9S63.9 52.3 63.9 45.2V12.9C63.9 5.8 69.7 0 76.8 0s12.9 5.8 12.9 12.9v32.3z" fill="#2EB67D"/><path d="M76.8 96.2c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9-12.9-5.8-12.9-12.9V96.2h12.9z" fill="#ECB22E"/><path d="M76.8 89.7c-7.1 0-12.9-5.8-12.9-12.9s5.8-12.9 12.9-12.9h32.3c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H76.8z" fill="#ECB22E"/></svg>`;
```

- [ ] **Step 3: Add `renderSidebar()`**

```js
function renderSidebar() {
  const v = state.view;
  const isTenants = v === "tenants" || v === "user-detail";
  return `
  <aside class="sidebar">
    <div class="ws-row">
      <button class="ws-btn" data-act="nav" data-view="overview">
        <span class="logo-tile">${ICON_LOGO}</span>
        <span class="lbl ws-name">Bug Radar Admin</span>
      </button>
    </div>
    <nav class="side-nav">
      <button class="nav-item${v === "overview" ? " active" : ""}" data-act="nav" data-view="overview">${ICON_ACTIVITY}<span class="lbl">Overview</span></button>
      <button class="nav-item${isTenants ? " active" : ""}" data-act="nav" data-view="tenants">${ICON_PEOPLE}<span class="lbl">Tenants</span></button>
      <button class="nav-item${v === "events" ? " active" : ""}" data-act="nav" data-view="events">${ICON_SESSIONS}<span class="lbl">Events</span></button>
    </nav>
    <div class="side-bottom">
      <div style="display:flex;align-items:center;gap:9px;padding:4px">
        <span class="avatar md">${escapeHtml((AUTH.email || "?")[0].toUpperCase())}</span>
        <span class="user-meta" style="min-width:0;overflow:hidden">
          <span class="user-name" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(AUTH.email || "")}</span>
        </span>
      </div>
      <button data-act="logout" style="font-size:12.5px;color:var(--muted);text-align:left;padding:6px 4px">Log out</button>
    </div>
  </aside>`;
}
```

(This task uses `ICON_ACTIVITY` for Overview and `ICON_SESSIONS` for the promoted Events screen — a small icon-reuse choice since Overview/Events aren't in the icon set built for their eventual own screens. Task 7 reassigns `ICON_SESSIONS` to the new Sessions screen and gives Events its own nav icon at that point — see Task 7 Step 3.)

- [ ] **Step 4: Rename the "Users" tab to "Tenants" in `renderUsersTable()`**

In `renderUsersTable()` (line 152), change the `.section-title` line from:
```js
  <div class="section-title">Users<span style="margin-left:8px;font-family:'JetBrains Mono',monospace;font-weight:600;color:var(--faint)">${USERS.length}</span></div>
```
to:
```js
  <div class="pageheader"><span class="title">Tenants</span><span class="count">${USERS.length}</span></div>
```
(This also switches the header from the old `.section-title`+`.panel` look to the new `.pageheader` look, consistent with the rest of this task's shell change. The table body below it — the `.panel` with grid-column rows — is untouched; Task 5 does not change `renderUsersTable`'s row layout, only Task 6 touches `renderUserDetail`.)

Also update `renderUserDetail()`'s back-link (line 348) from:
```js
  <button data-act="nav" data-view="users" style="font-size:13px;color:var(--muted);margin-bottom:14px;display:inline-block">&larr; Users</button>
```
to:
```js
  <button data-act="nav" data-view="tenants" style="font-size:13px;color:var(--muted);margin-bottom:14px;display:inline-block">&larr; Tenants</button>
```

- [ ] **Step 4b: Add a Slack-status column to the Tenants list**

Backend (`worker-admin/src/index.js`, `GET /api/users` handler, line 176): after the existing `reportActivityMap` block and before the `enriched` map, add:

```js
      const { results: slackRows } = await env.DB.prepare("SELECT owner_email, status FROM slack_connections").all();
      const slackStatusMap = {};
      for (const row of slackRows) slackStatusMap[row.owner_email] = row.status;
```

Add `slack_status: slackStatusMap[u.email] || null,` to the `enriched` map's returned object (alongside `connection_count` and `last_activity`).

Frontend (`renderUsersTable()`, line 152): change the grid from 4 to 5 columns. Row template changes from:
```js
    <button data-act="open-user" data-email="${escapeHtml(u.email)}" style="display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:12px;width:100%;text-align:left;padding:12px 0;border-top:1px solid var(--border-soft);font-size:13px">
      <span style="font-weight:500">${escapeHtml(u.email)}</span>
      <span style="color:var(--muted)">${escapeHtml(String(u.created_at || "").slice(0, 10))}</span>
      <span style="color:var(--muted)">${u.connection_count} connection${u.connection_count === 1 ? "" : "s"}</span>
      <span style="color:var(--faint)">${u.last_activity ? relTimeLabel(u.last_activity) : "no activity"}</span>
    </button>`
```
to:
```js
    <button data-act="open-user" data-email="${escapeHtml(u.email)}" style="display:grid;grid-template-columns:2fr 1fr 1fr 1fr 1fr;gap:12px;width:100%;text-align:left;padding:12px 0;border-top:1px solid var(--border-soft);font-size:13px">
      <span style="font-weight:500">${escapeHtml(u.email)}</span>
      <span style="color:var(--muted)">${escapeHtml(String(u.created_at || "").slice(0, 10))}</span>
      <span style="color:var(--muted)">${u.connection_count} connection${u.connection_count === 1 ? "" : "s"}</span>
      <span style="color:var(--faint)">${u.last_activity ? relTimeLabel(u.last_activity) : "no activity"}</span>
      <span style="color:${u.slack_status === "connected" ? "var(--oc-done)" : "var(--faint)"}">${u.slack_status === "connected" ? "Slack connected" : "No Slack"}</span>
    </button>`
```
And the column-header row above it, from `grid-template-columns:2fr 1fr 1fr 1fr` to `2fr 1fr 1fr 1fr 1fr`, adding a `<span>Slack</span>` after `<span>Last activity</span>`.

- [ ] **Step 5: Rename `state.view` value `"users"` to `"tenants"` everywhere it's checked**

In `renderMainContent()` (line 532), change `case "users": return renderUsersTable();` to `case "tenants": return renderUsersTable();`.

In the click delegate's `nav` branch (line 572), change:
```js
else if (act === "nav") { state.view = el.dataset.view; if (el.dataset.view === "users" && !USERS.length) loadUsers(); render(); }
```
to:
```js
else if (act === "nav") { state.view = el.dataset.view; if (el.dataset.view === "tenants" && !USERS.length) loadUsers(); render(); }
```

In `init()` (line 620), `state.view` starts as `"overview"` already (line 92) — no change needed there.

- [ ] **Step 6: Promote Events to its own screen**

Add a new render function (near `renderOverview`):

```js
function renderEventsScreen() {
  return `
  <div class="pageheader"><span class="title">Events</span><span class="count">${EVENTS.length}</span></div>
  <div class="content contentpad">
    <div class="panel">${EVENTS.length ? EVENTS.map(ev => auditRowHtml(ev, { showOwner: true })).join("") : `<div class="empty-note">No activity yet.</div>`}</div>
  </div>`;
}
```

In `renderOverview()` (line 359), delete the trailing "Global activity" block:
```js
  <div class="section-title">Global activity</div>
  <div class="panel">
    ${EVENTS.length ? EVENTS.map(ev => auditRowHtml(ev, { showOwner: true })).join("") : `<div class="empty-note">No activity yet.</div>`}
  </div>`;
```
so `renderOverview()` now ends right after the `.stat-row` div's closing `</div>` (keep the stat cards, drop the activity feed — it now lives on its own screen). Give Overview a `.pageheader` too, for visual consistency with the rest of the app: wrap the stat-row in a `.content contentpad` div under a new `.pageheader` at the top of `renderOverview()`'s return, mirroring `renderEventsScreen()`'s structure.

Add the new case to `renderMainContent()`:
```js
    case "events": return renderEventsScreen();
```

`loadOverview()` already fetches both `/api/overview` and `/api/events?limit=100` (line 130-134) — no backend or fetch changes needed for this step, `EVENTS` is already populated by the time either screen renders.

- [ ] **Step 7: Wire the new shell into `render()`**

Replace `renderTopbar()`'s call site in `render()` (line 561):
```js
  app.innerHTML = `<div class="app">${renderTopbar()}<main class="main">${renderMainContent()}</main></div>`;
```
with:
```js
  app.innerHTML = `<div class="app">${renderSidebar()}<main class="main">${renderMainContent()}</main></div>`;
```
Delete the old `renderTopbar()` function entirely.

- [ ] **Step 8: Deploy and verify visually**

```bash
cd worker-admin && npx wrangler deploy
```
Log in via Playwright (real password, out-of-band). Screenshot the Overview screen: expect a left sidebar with Overview/Tenants/Events, stat cards in the content area, no activity feed. Click "Events": expect the full activity list in the new compact-table style. Click "Tenants": expect the existing table with a `.pageheader` title and a 5th "Slack" column showing connected/no-Slack per tenant. Check console for zero errors.

- [ ] **Step 9: Commit**

```bash
git add worker-admin/public/index.html worker-admin/src/index.js
git commit -m "Add sidebar shell, promote Events to its own screen, relabel Tenants, add Slack-status column"
```

---

### Task 5: Overview — Slack-connected and failing-connections counts

**Files:**
- Modify: `worker-admin/src/index.js` (`GET /api/overview`, line 150)
- Modify: `worker-admin/public/index.html` (`renderOverview`)

**Interfaces:**
- Consumes: `slack_connections` table (already exists, `worker/schema.sql`), `connections.last_error` column (already exists).
- Produces: `OVERVIEW` gains two new fields, `slackConnectedCount` and `failingConnectionCount`, consumed by `renderOverview()`.

- [ ] **Step 1: Extend the `/api/overview` route**

In `worker-admin/src/index.js`, inside the `/api/overview` handler, after the existing `connectionsByStatus` computation and before the final `return json(...)`, add:

```js
      const slackConnectedCount = (await env.DB.prepare(
        "SELECT COUNT(*) as n FROM slack_connections WHERE status = 'connected'"
      ).first()).n;
      const failingConnectionCount = (await env.DB.prepare(
        "SELECT COUNT(*) as n FROM connections WHERE last_error IS NOT NULL"
      ).first()).n;
```

Change the final line from:
```js
      return json({ userCount, connectionCount, reportCount, connectionsByStatus });
```
to:
```js
      return json({ userCount, connectionCount, reportCount, connectionsByStatus, slackConnectedCount, failingConnectionCount });
```

- [ ] **Step 2: Deploy and verify the API directly**

```bash
cd worker-admin && npx wrangler deploy
curl -s -b "bugradar_admin_session=<paste a valid session token from Task 2's Step 6 login>" \
  https://bug-radar-admin.shubhamvishnu.workers.dev/api/overview
```
Expected: JSON includes `slackConnectedCount` and `failingConnectionCount` as non-negative integers.

- [ ] **Step 3: Update `OVERVIEW`'s default shape and `renderOverview()`**

In `worker-admin/public/index.html`, update the `OVERVIEW` default (line 94):
```js
let OVERVIEW = { userCount: 0, connectionCount: 0, reportCount: 0, connectionsByStatus: {}, slackConnectedCount: 0, failingConnectionCount: 0 };
```
Also apply the same shape to the reset in `logout()` (line 611).

In `renderOverview()`'s `.stat-row`, add two more `.stat-card` entries after the existing four:
```js
    <div class="stat-card"><div class="n">${OVERVIEW.slackConnectedCount}</div><div class="lbl">Slack connected</div></div>
    <div class="stat-card"><div class="n" style="${OVERVIEW.failingConnectionCount ? "color:var(--sev-high)" : ""}">${OVERVIEW.failingConnectionCount}</div><div class="lbl">Connections failing</div></div>
```
Change `.stat-row`'s CSS from `grid-template-columns:repeat(4,1fr)` to `repeat(3,1fr)` (6 cards read better as a 2-row 3-wide grid than a cramped 6-wide one) — update the rule in the `<style>` block.

- [ ] **Step 4: Deploy and verify visually**

```bash
cd worker-admin && npx wrangler deploy
```
Screenshot the Overview screen: expect 6 stat cards in a 3-wide grid, including "Slack connected" and "Connections failing".

- [ ] **Step 5: Commit**

```bash
git add worker-admin/src/index.js worker-admin/public/index.html
git commit -m "Add Slack-connected and failing-connections counts to Overview"
```

---

### Task 6: Tenant Detail — Slack section and paginated report history

**Files:**
- Modify: `worker-admin/src/index.js` (`GET /api/users/:email`, line 204; new `GET /api/users/:email/reports`)
- Modify: `worker-admin/public/index.html` (`renderUserDetail`, `renderLatestReportSection`)

**Interfaces:**
- Consumes: `slack_connections`, `slack_rules` tables.
- Produces: `/api/users/:email` response gains a `slack` field (`{team_name, status, rule_count} | null`). New route `GET /api/users/:email/reports?before_id=N` returns `{report_history: [...]}` for pagination.

- [ ] **Step 1: Add the Slack lookup to `/api/users/:email`**

In the `userDetailMatch` handler, after the `corrections` query and before the `connectionIds`/`events` block, add:

```js
      const slackConn = await env.DB.prepare(
        "SELECT team_name, status FROM slack_connections WHERE owner_email = ?"
      ).bind(targetEmail).first();
      const slackRuleCount = (await env.DB.prepare(
        "SELECT COUNT(*) as n FROM slack_rules WHERE owner_email = ?"
      ).bind(targetEmail).first()).n;
      const slack = slackConn ? { team_name: slackConn.team_name, status: slackConn.status, rule_count: slackRuleCount } : null;
```

Add `slack,` to the final `return json({...})` object (alongside `goals, tags, corrections, events,`).

- [ ] **Step 2: Add the paginated report-history route**

Add a new route, near the `userDetailMatch` block:

```js
    const reportsPageMatch = pathname.match(/^\/api\/users\/([^/]+)\/reports$/);
    if (reportsPageMatch && request.method === "GET") {
      if (!(await adminAuthed(request, env))) return json({ error: "not authenticated" }, 401);
      const targetEmail = decodeURIComponent(reportsPageMatch[1]).trim().toLowerCase();
      const beforeId = Number(url.searchParams.get("before_id")) || null;
      const { results: rows } = beforeId
        ? await env.DB.prepare(
            "SELECT id, connection_id, generated_at, created_at, micro_findings FROM reports WHERE owner_email = ? AND id < ? ORDER BY id DESC LIMIT 10"
          ).bind(targetEmail, beforeId).all()
        : await env.DB.prepare(
            "SELECT id, connection_id, generated_at, created_at, micro_findings FROM reports WHERE owner_email = ? ORDER BY id DESC LIMIT 10"
          ).bind(targetEmail).all();
      const report_history = rows.map(r => ({
        id: r.id, connection_id: r.connection_id, generated_at: r.generated_at, created_at: r.created_at,
        task_count: JSON.parse(r.micro_findings).reduce((n, f) => n + (f.tasks || []).length, 0),
      }));
      return json({ report_history });
    }
```

- [ ] **Step 3: Deploy and verify the API directly**

```bash
cd worker-admin && npx wrangler deploy
curl -s -b "bugradar_admin_session=<valid token>" \
  "https://bug-radar-admin.shubhamvishnu.workers.dev/api/users/<a real tenant email>" | python3 -c "import json,sys; d=json.load(sys.stdin); print('slack' in d, d.get('slack'))"
```
Expected: `True` and either `None` or an object with `team_name`/`status`/`rule_count`.

- [ ] **Step 4: Add the Slack section to `renderUserDetail()`**

Add a new render function:

```js
function renderTenantSlackSection() {
  const slack = USER_DETAIL.slack;
  return `
  <div class="section-title">Slack</div>
  <div class="panel" style="padding:14px 18px">
    ${slack
      ? `<div style="display:flex;align-items:center;gap:10px;font-size:13px">
           ${SLACK_MARK_SVG(18)}
           <span style="font-weight:600">${escapeHtml(slack.team_name)}</span>
           <span style="color:${slack.status === "connected" ? "var(--oc-done)" : "var(--faint)"}">${escapeHtml(slack.status)}</span>
           <span style="color:var(--muted);margin-left:auto">${slack.rule_count} rule${slack.rule_count === 1 ? "" : "s"}</span>
         </div>`
      : `<div class="empty-note">Not connected.</div>`}
  </div>`;
}
```

In `renderUserDetail()`, add `${renderTenantSlackSection()}` inside a `<div style="margin-top:24px">` between the connections block and `renderLatestReportSection()`'s call.

- [ ] **Step 5: Add "Load more" to `renderLatestReportSection()`**

Add a new function:

```js
async function loadMoreReports() {
  const history = USER_DETAIL.report_history || [];
  const oldestId = history.length ? history[history.length - 1].id : null;
  if (!oldestId) return;
  const res = await fetch(`/api/users/${encodeURIComponent(state.selUserEmail)}/reports?before_id=${oldestId}`);
  if (!res.ok) return;
  const data = await res.json();
  USER_DETAIL.report_history = [...history, ...data.report_history];
  render();
}
```

In `renderLatestReportSection()` (line 326), change the `historyHtml` block to add a "Load more" button whenever the last fetched page came back full (10 rows — a heuristic that more may exist, matching how the rest of this codebase treats a full page as "possibly more" rather than doing a separate count query):

```js
  const historyHtml = history.length ? `
    <div style="font-size:11.5px;color:var(--faint);margin:10px 0 8px">
      ${history.map(r => `${escapeHtml(String(r.generated_at || "").slice(0, 10))} · ${r.task_count} tasks`).join(" &nbsp;·&nbsp; ")}
    </div>
    ${history.length % 10 === 0 ? `<button data-act="load-more-reports" style="font-size:12px;color:var(--accent);margin-bottom:18px">Load more</button>` : ""}` : "";
```

Add the click handler in the delegate:
```js
  else if (act === "load-more-reports") { loadMoreReports(); }
```

- [ ] **Step 6: Deploy and verify visually**

```bash
cd worker-admin && npx wrangler deploy
```
Open a tenant with a Slack connection in Tenant Detail: expect a Slack section showing team name, status, rule count. Open one with 10+ reports: click "Load more", confirm the history line grows and no duplicate entries appear.

- [ ] **Step 7: Commit**

```bash
git add worker-admin/src/index.js worker-admin/public/index.html
git commit -m "Add Slack section and paginated report history to Tenant Detail"
```

---

### Task 7: Sessions screen (cross-tenant)

**Files:**
- Modify: `worker-admin/src/index.js` (new `GET /api/sessions`, new `GET /api/sessions/:sessionId`)
- Modify: `worker-admin/public/index.html` (new Sessions list + detail screens; generalize `renderSessionCardRO`/`renderTaskCardRO`/`taskTagsHtml`/`taskGoalBadgeHtml` to take an explicit context instead of reading the global `USER_DETAIL`)

**Interfaces:**
- Consumes: `reports` table.
- Produces: `GET /api/sessions?limit=200` → `{sessions: [{session_id, owner_email, worst_severity, task_count, bug_count, timestamp}], scanned_reports}`. `GET /api/sessions/:sessionId?owner_email=` → `{session, owner_email, goals, tags}`.
- **Breaking change to existing signatures** (both call sites updated in this task): `taskTagsHtml(t, tagsList)` (was `taskTagsHtml(t)`, read `USER_DETAIL.tags` internally), `taskGoalBadgeHtml(t, goalsList)` (was `taskGoalBadgeHtml(t)`, read `USER_DETAIL.goals` internally), `renderTaskCardRO(f, ti, t, ctx)` (was `renderTaskCardRO(f, ti, t)`), `renderSessionCardRO(f, ctx)` (was `renderSessionCardRO(f)`, single-arg) — `ctx` is `{tags: [...], goals: [...]}`.

- [ ] **Step 1: Add the Sessions list endpoint**

```js
    if (pathname === "/api/sessions" && request.method === "GET") {
      if (!(await adminAuthed(request, env))) return json({ error: "not authenticated" }, 401);
      const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit")) || 200, 200));
      const { results: reportRows } = await env.DB.prepare(
        "SELECT owner_email, generated_at, micro_findings FROM reports ORDER BY id DESC LIMIT 500"
      ).all();
      const sevRank = { high: 3, medium: 2, low: 1, none: 0 };
      const sessions = [];
      for (const row of reportRows) {
        const findings = JSON.parse(row.micro_findings);
        for (const f of findings) {
          const tasks = f.tasks || [];
          const worst = tasks.reduce((w, t) => {
            const s = (t.severity || "none").toLowerCase();
            return sevRank[s] > sevRank[w] ? s : w;
          }, "none");
          sessions.push({
            session_id: f.session_id,
            owner_email: row.owner_email,
            worst_severity: worst,
            task_count: tasks.length,
            bug_count: tasks.filter(t => t.real_bug).length,
            timestamp: f.key_timestamp || row.generated_at,
          });
        }
      }
      sessions.sort((a, b) => String(b.timestamp || "").localeCompare(String(a.timestamp || "")));
      return json({ sessions: sessions.slice(0, limit), scanned_reports: reportRows.length });
    }
```

- [ ] **Step 2: Add the Session Detail endpoint**

```js
    const sessionDetailMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
    if (sessionDetailMatch && request.method === "GET") {
      if (!(await adminAuthed(request, env))) return json({ error: "not authenticated" }, 401);
      const sessionId = decodeURIComponent(sessionDetailMatch[1]);
      const ownerEmail = String(url.searchParams.get("owner_email") || "").trim().toLowerCase();
      const { results: reportRows } = await env.DB.prepare(
        "SELECT micro_findings FROM reports WHERE owner_email = ? ORDER BY id DESC LIMIT 500"
      ).bind(ownerEmail).all();
      let match = null;
      for (const row of reportRows) {
        const findings = JSON.parse(row.micro_findings);
        match = findings.find(f => f.session_id === sessionId);
        if (match) break;
      }
      if (!match) return json({ error: "not found" }, 404);
      const { results: goalsRaw } = await env.DB.prepare(
        "SELECT id, purpose, description, tags, source, created_at FROM goals WHERE owner_email = ? ORDER BY id DESC"
      ).bind(ownerEmail).all();
      const goals = goalsRaw.map(g => ({ ...g, tags: JSON.parse(g.tags || "[]") }));
      const { results: tags } = await env.DB.prepare(
        "SELECT id, label, color, source, created_at FROM tags WHERE owner_email = ? ORDER BY id DESC"
      ).bind(ownerEmail).all();
      return json({ session: match, owner_email: ownerEmail, goals, tags });
    }
```

Note: this route must be registered **after** the `reportsPageMatch` route from Task 6 and **before** the generic `mediaProxyMatch` route, matching this file's existing top-to-bottom route-matching order — position doesn't matter for correctness here (the regexes don't overlap), just keep new routes grouped with their related ones for readability.

- [ ] **Step 3: Deploy and verify the API directly**

```bash
cd worker-admin && npx wrangler deploy
curl -s -b "bugradar_admin_session=<valid token>" "https://bug-radar-admin.shubhamvishnu.workers.dev/api/sessions?limit=5"
```
Expected: `{"sessions": [...up to 5...], "scanned_reports": <number>}`, each session object has all 6 fields.

```bash
curl -s -b "bugradar_admin_session=<valid token>" \
  "https://bug-radar-admin.shubhamvishnu.workers.dev/api/sessions/<a real session_id from the above>?owner_email=<its owner_email>"
```
Expected: `{"session": {...}, "owner_email": "...", "goals": [...], "tags": [...]}`.

- [ ] **Step 4: Generalize the read-only session/task render functions**

In `taskTagsHtml` (line 251), change:
```js
function taskTagsHtml(t) {
  const tagIds = (t.tags || []).map(tg => tg.tag_id);
  const defs = (USER_DETAIL.tags || []).filter(d => tagIds.includes(d.id));
  return defs.length ? `<div style="display:flex;flex-wrap:wrap;gap:6px;margin:8px 0">${defs.map(tagChipHtml).join("")}</div>` : "";
}
```
to:
```js
function taskTagsHtml(t, tagsList) {
  const tagIds = (t.tags || []).map(tg => tg.tag_id);
  const defs = (tagsList || []).filter(d => tagIds.includes(d.id));
  return defs.length ? `<div style="display:flex;flex-wrap:wrap;gap:6px;margin:8px 0">${defs.map(tagChipHtml).join("")}</div>` : "";
}
```

In `taskGoalBadgeHtml` (line 257), change:
```js
function taskGoalBadgeHtml(t) {
  if (!t.goal_id) return "";
  const goal = (USER_DETAIL.goals || []).find(g => g.id === t.goal_id);
  if (!goal) return "";
  return `<div style="font-size:12px;color:var(--muted);margin:6px 0"><span style="color:var(--faint)">Goal ·</span> ${escapeHtml(goal.purpose)}</div>`;
}
```
to:
```js
function taskGoalBadgeHtml(t, goalsList) {
  if (!t.goal_id) return "";
  const goal = (goalsList || []).find(g => g.id === t.goal_id);
  if (!goal) return "";
  return `<div style="font-size:12px;color:var(--muted);margin:6px 0"><span style="color:var(--faint)">Goal ·</span> ${escapeHtml(goal.purpose)}</div>`;
}
```

In `renderTaskCardRO` (line 293), change the signature and the two call sites inside it:
```js
function renderTaskCardRO(f, ti, t, ctx) {
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
      ${taskGoalBadgeHtml(t, ctx.goals)}
      ${taskTagsHtml(t, ctx.tags)}
      <p style="font-size:12.5px;color:var(--muted);line-height:1.55;margin:6px 0">${escapeHtml(t.narrative || "")}</p>
      ${renderCapturedMomentsRO(f, ti, t)}
    </div>` : ""}
  </div>`;
}
```

In `renderSessionCardRO` (line 313), change the signature and its one call site:
```js
function renderSessionCardRO(f, ctx) {
  const tasks = f.tasks || [];
  return `
  <div class="panel" style="margin-bottom:12px">
    <div style="padding:14px 0 4px;display:flex;align-items:center;gap:10px">
      <span style="font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--faint)">${escapeHtml((f.session_id || "").slice(0, 12))}</span>
      <span style="font-size:12px;color:var(--muted)">${tasks.length} task${tasks.length === 1 ? "" : "s"}</span>
      ${f.recommended_outreach ? `<span style="margin-left:auto;font-size:10.5px;font-weight:600;color:var(--accent);background:color-mix(in srgb,var(--accent) 12%,transparent);padding:2px 8px;border-radius:6px">Outreach recommended</span>` : ""}
    </div>
    ${tasks.map((t, ti) => renderTaskCardRO(f, ti, t, ctx)).join("")}
  </div>`;
}
```

Update `renderLatestReportSection()`'s call site (line ~340):
```js
  ${findings.length ? findings.map(renderSessionCardRO).join("") : `<div class="panel"><div class="empty-note">No sessions in this report.</div></div>`}`;
```
to:
```js
  ${findings.length ? findings.map(f => renderSessionCardRO(f, { tags: USER_DETAIL.tags || [], goals: USER_DETAIL.goals || [] })).join("") : `<div class="panel"><div class="empty-note">No sessions in this report.</div></div>`}`;
```

- [ ] **Step 5: Add the Sessions list and detail screens**

Add state and a global for loaded data (near `USER_DETAIL`):
```js
let SESSIONS = [];
let SESSIONS_SCANNED = 0;
let SESSION_DETAIL = null;
```
Add `state.selSessionId = null;` and `state.selSessionOwner = null;` to the `state` object (line 92).

Add loaders:
```js
async function loadSessions() {
  const res = await fetch("/api/sessions?limit=200");
  if (res.ok) { const data = await res.json(); SESSIONS = data.sessions; SESSIONS_SCANNED = data.scanned_reports; }
}

async function openSession(sessionId, ownerEmail) {
  state.view = "session-detail";
  state.selSessionId = sessionId;
  state.selSessionOwner = ownerEmail;
  SESSION_DETAIL = null;
  render();
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}?owner_email=${encodeURIComponent(ownerEmail)}`);
  if (state.selSessionId !== sessionId) return;
  if (res.ok) SESSION_DETAIL = await res.json();
  render();
}
```

Add the render functions:
```js
function renderSessionsScreen() {
  const rows = SESSIONS.map(s => `
    <button class="list-row" data-act="open-session" data-id="${escapeHtml(s.session_id)}" data-owner="${escapeHtml(s.owner_email)}">
      <span class="col-user">
        <span class="avatar">${escapeHtml((s.owner_email || "?")[0].toUpperCase())}</span>
        <span style="min-width:0;overflow:hidden;display:flex;align-items:baseline;gap:8px">
          <span class="nm">${escapeHtml(s.owner_email)}</span>
          <span class="meta">${escapeHtml((s.session_id || "").slice(0, 12))}</span>
        </span>
      </span>
      <span style="width:90px">${SEV_TEXT[s.worst_severity]}</span>
      <span style="width:70px">${s.bug_count} bug${s.bug_count === 1 ? "" : "s"}</span>
      <span style="width:90px;text-align:right;color:var(--faint)">${escapeHtml(String(s.timestamp || "").slice(0, 10))}</span>
    </button>`).join("");
  return `
  <div class="pageheader"><span class="title">Sessions</span><span class="count">${SESSIONS.length}</span></div>
  <div class="list-subhead"><span style="flex:1">Owner / session</span><span style="width:90px">Worst severity</span><span style="width:70px">Bugs</span><span style="width:90px;text-align:right">Date</span></div>
  <div class="content">
    ${rows || `<div class="empty-note">No sessions yet.</div>`}
    <div class="empty-note">Showing latest ${SESSIONS.length} of the most recent ${SESSIONS_SCANNED} report rows scanned.</div>
  </div>`;
}

function renderSessionDetailScreen() {
  if (!SESSION_DETAIL) return `<div class="pageheader"><button class="crumb" data-act="nav" data-view="sessions">Sessions</button></div><div class="content contentpad"><div class="empty-note">Loading…</div></div>`;
  const ctx = { tags: SESSION_DETAIL.tags || [], goals: SESSION_DETAIL.goals || [] };
  return `
  <div class="pageheader">
    <button class="crumb" data-act="nav" data-view="sessions">Sessions</button>
    <span class="sep">/</span>
    <span class="idmono">${escapeHtml((SESSION_DETAIL.session.session_id || "").slice(0, 16))}</span>
  </div>
  <div class="content contentpad">
    <div style="font-size:12.5px;color:var(--muted);margin-bottom:16px">${escapeHtml(SESSION_DETAIL.owner_email)}</div>
    ${renderSessionCardRO(SESSION_DETAIL.session, ctx)}
  </div>`;
}
```

Add `SEV_TEXT` (used above but not yet defined in `worker-admin`):
```js
const SEV_TEXT = { high: "High", medium: "Medium", low: "Low", none: "None" };
```
(place it next to the existing `SEV_VAR` at line 241).

Add the two new cases to `renderMainContent()`:
```js
    case "sessions": return renderSessionsScreen();
    case "session-detail": return renderSessionDetailScreen();
```

Add the Sessions nav item to `renderSidebar()` (Task 4's function), reassigning `ICON_SESSIONS` to Sessions and giving Events its own icon — replace:
```js
      <button class="nav-item${v === "events" ? " active" : ""}" data-act="nav" data-view="events">${ICON_SESSIONS}<span class="lbl">Events</span></button>
```
with:
```js
      <button class="nav-item${v === "sessions" || v === "session-detail" ? " active" : ""}" data-act="nav" data-view="sessions">${ICON_SESSIONS}<span class="lbl">Sessions</span></button>
      <button class="nav-item${v === "events" ? " active" : ""}" data-act="nav" data-view="events">${ICON_ACTIVITY_EVENTS}<span class="lbl">Events</span></button>
```
And change Overview's icon from `ICON_ACTIVITY` to a distinct one so Overview and Events don't share an icon — add this new constant alongside the other icon constants from Task 4:
```js
const ICON_ACTIVITY_EVENTS = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="flex:none"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`;
```
(Overview keeps `ICON_ACTIVITY`, the four-line trend icon from Task 4; Events gets this new clock icon.)

Add the click delegate branch:
```js
  else if (act === "open-session") { openSession(el.dataset.id, el.dataset.owner); }
```

Add lazy-loading on nav (in the `nav` branch, alongside the existing `tenants` lazy-load):
```js
else if (act === "nav") {
  state.view = el.dataset.view;
  if (el.dataset.view === "tenants" && !USERS.length) loadUsers();
  if (el.dataset.view === "sessions" && !SESSIONS.length) loadSessions();
  render();
}
```

- [ ] **Step 6: Deploy and verify visually**

```bash
cd worker-admin && npx wrangler deploy
```
Click "Sessions" in the sidebar: expect a compact table, owner/session/severity/bugs/date columns, and the "Showing latest N of the most recent M report rows scanned" note. Click a row: expect the full task-card detail view (matching Tenant Detail's session cards) with a working breadcrumb back to Sessions. Also re-open a Tenant Detail page with an expandable task that has tags/goals: confirm tag chips and goal badges still render correctly (this task changed their function signatures — this is the regression check for that).

- [ ] **Step 7: Commit**

```bash
git add worker-admin/src/index.js worker-admin/public/index.html
git commit -m "Add cross-tenant Sessions screen"
```

---

### Task 8: Integrations screen (cross-tenant)

**Files:**
- Modify: `worker-admin/src/index.js` (new `GET /api/connections`)
- Modify: `worker-admin/public/index.html` (new Integrations screen)

**Interfaces:**
- Consumes: `connections` table.
- Produces: `GET /api/connections` → `{connections: [{id, owner_email, project_name, status, last_error, last_synced_at, sync_freq}]}`, failing ones (`last_error IS NOT NULL`) first.

- [ ] **Step 1: Add the endpoint**

```js
    if (pathname === "/api/connections" && request.method === "GET") {
      if (!(await adminAuthed(request, env))) return json({ error: "not authenticated" }, 401);
      const { results } = await env.DB.prepare(
        `SELECT id, owner_email, project_name, status, last_error, last_synced_at, sync_freq
         FROM connections ORDER BY (last_error IS NOT NULL) DESC, id DESC`
      ).all();
      return json({ connections: results });
    }
```

- [ ] **Step 2: Deploy and verify the API directly**

```bash
cd worker-admin && npx wrangler deploy
curl -s -b "bugradar_admin_session=<valid token>" https://bug-radar-admin.shubhamvishnu.workers.dev/api/connections
```
Expected: `{"connections": [...]}`, any row with a non-null `last_error` appears before rows without one.

- [ ] **Step 3: Add the frontend screen**

Add globals and loader (near `SESSIONS`):
```js
let CONNECTIONS = [];
async function loadConnections() {
  const res = await fetch("/api/connections");
  if (res.ok) CONNECTIONS = (await res.json()).connections;
}
```

Add the render function (reuses `connChipStyle`, already defined at line 170):
```js
function renderIntegrationsScreen() {
  const rows = CONNECTIONS.map(c => `
    <button class="list-row" data-act="open-user" data-email="${escapeHtml(c.owner_email)}">
      <span class="col-user">
        <span class="avatar">${escapeHtml((c.owner_email || "?")[0].toUpperCase())}</span>
        <span style="min-width:0;overflow:hidden;display:flex;align-items:baseline;gap:8px">
          <span class="nm">${escapeHtml(c.owner_email)}</span>
          <span class="meta">${escapeHtml(c.project_name || "")}</span>
        </span>
      </span>
      <span style="width:100px"><span style="padding:3px 8px;border-radius:6px;font-size:11px;font-weight:600;${connChipStyle(c.status)}">${escapeHtml(c.status)}</span></span>
      <span style="width:200px;color:var(--sev-high);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(c.last_error || "")}</span>
      <span style="width:110px;text-align:right;color:var(--faint)">${c.last_synced_at ? escapeHtml(String(c.last_synced_at).slice(0, 10)) : "never"}</span>
    </button>`).join("");
  return `
  <div class="pageheader"><span class="title">Integrations</span><span class="count">${CONNECTIONS.length}</span></div>
  <div class="list-subhead"><span style="flex:1">Owner / project</span><span style="width:100px">Status</span><span style="width:200px">Last error</span><span style="width:110px;text-align:right">Last synced</span></div>
  <div class="content">${rows || `<div class="empty-note">No connections yet.</div>`}</div>`;
}
```

Add the case to `renderMainContent()`: `case "integrations": return renderIntegrationsScreen();`

Add the nav item to `renderSidebar()`, after the Tenants item:
```js
      <button class="nav-item${v === "integrations" ? " active" : ""}" data-act="nav" data-view="integrations">${ICON_PLUG}<span class="lbl">Integrations</span></button>
```

Add lazy-loading to the `nav` click branch:
```js
      if (el.dataset.view === "integrations" && !CONNECTIONS.length) loadConnections();
```

Row clicks reuse the existing `open-user` action (already wired) — clicking a connection opens that tenant's Tenant Detail, satisfying the spec's "row click → that tenant's Tenant Detail" requirement without a new action type.

- [ ] **Step 4: Deploy and verify visually**

```bash
cd worker-admin && npx wrangler deploy
```
Click "Integrations": expect a compact table with owner/project/status/last-error/last-synced columns, failing connections at the top. Click a row: confirm it opens that tenant's Tenant Detail.

- [ ] **Step 5: Commit**

```bash
git add worker-admin/src/index.js worker-admin/public/index.html
git commit -m "Add cross-tenant Integrations screen"
```

---

### Task 9: Goals and Tags screens (cross-tenant)

**Files:**
- Modify: `worker-admin/src/index.js` (new `GET /api/goals`, new `GET /api/tags`)
- Modify: `worker-admin/public/index.html` (new Goals and Tags screens)

**Interfaces:**
- Consumes: `goals`, `tags` tables.
- Produces: `GET /api/goals?limit=500` → `{goals: [...], total}`. `GET /api/tags?limit=500` → `{tags: [...], total}`.

- [ ] **Step 1: Add both endpoints**

```js
    if (pathname === "/api/goals" && request.method === "GET") {
      if (!(await adminAuthed(request, env))) return json({ error: "not authenticated" }, 401);
      const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit")) || 500, 500));
      const total = (await env.DB.prepare("SELECT COUNT(*) as n FROM goals").first()).n;
      const { results } = await env.DB.prepare(
        "SELECT id, owner_email, purpose, description, tags, source, created_at FROM goals ORDER BY id DESC LIMIT ?"
      ).bind(limit).all();
      const goals = results.map(g => ({ ...g, tags: JSON.parse(g.tags || "[]") }));
      return json({ goals, total });
    }

    if (pathname === "/api/tags" && request.method === "GET") {
      if (!(await adminAuthed(request, env))) return json({ error: "not authenticated" }, 401);
      const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit")) || 500, 500));
      const total = (await env.DB.prepare("SELECT COUNT(*) as n FROM tags").first()).n;
      const { results: tags } = await env.DB.prepare(
        "SELECT id, owner_email, label, color, source, created_at FROM tags ORDER BY id DESC LIMIT ?"
      ).bind(limit).all();
      return json({ tags, total });
    }
```

- [ ] **Step 2: Deploy and verify the API directly**

```bash
cd worker-admin && npx wrangler deploy
curl -s -b "bugradar_admin_session=<valid token>" https://bug-radar-admin.shubhamvishnu.workers.dev/api/goals
curl -s -b "bugradar_admin_session=<valid token>" https://bug-radar-admin.shubhamvishnu.workers.dev/api/tags
```
Expected: both return `{goals|tags: [...], total: <int>}` with `total >= results.length`.

- [ ] **Step 3: Add the frontend screens**

Add globals and loaders:
```js
let GOALS = []; let GOALS_TOTAL = 0;
let TAGS = []; let TAGS_TOTAL = 0;
async function loadGoals() {
  const res = await fetch("/api/goals");
  if (res.ok) { const d = await res.json(); GOALS = d.goals; GOALS_TOTAL = d.total; }
  render();
}
async function loadTags() {
  const res = await fetch("/api/tags");
  if (res.ok) { const d = await res.json(); TAGS = d.tags; TAGS_TOTAL = d.total; }
  render();
}
```

Add the render functions (reusing `tagChipHtml`, already defined at line 245, and `safeColor`):
```js
function renderGoalsScreen() {
  const rows = GOALS.map(g => `
    <div class="list-row" style="cursor:default">
      <span class="col-user">
        <span style="min-width:0;overflow:hidden;display:flex;align-items:baseline;gap:8px">
          <span class="nm">${escapeHtml(g.purpose)}</span>
          <span class="meta">${escapeHtml(g.owner_email)}</span>
        </span>
      </span>
      <span style="width:70px"><span style="font-size:10.5px;font-weight:600;color:var(--faint);background:var(--bg-sub);padding:2px 7px;border-radius:6px">${g.source === "auto" ? "AUTO" : "USER"}</span></span>
      <span style="width:90px;text-align:right;color:var(--faint)">${escapeHtml(String(g.created_at || "").slice(0, 10))}</span>
    </div>`).join("");
  return `
  <div class="pageheader"><span class="title">Goals</span><span class="count">${GOALS.length}</span></div>
  <div class="list-subhead"><span style="flex:1">Purpose / owner</span><span style="width:70px">Source</span><span style="width:90px;text-align:right">Created</span></div>
  <div class="content">
    ${rows || `<div class="empty-note">No goals yet.</div>`}
    ${GOALS_TOTAL > GOALS.length ? `<div class="empty-note">Showing latest ${GOALS.length} of ${GOALS_TOTAL} total.</div>` : ""}
  </div>`;
}

function renderTagsScreen() {
  const rows = TAGS.map(t => `
    <div class="list-row" style="cursor:default">
      <span class="col-user">
        <span style="min-width:0;overflow:hidden;display:flex;align-items:baseline;gap:8px">
          ${tagChipHtml(t)}
          <span class="meta">${escapeHtml(t.owner_email)}</span>
        </span>
      </span>
      <span style="width:70px"><span style="font-size:10.5px;font-weight:600;color:var(--faint);background:var(--bg-sub);padding:2px 7px;border-radius:6px">${t.source === "auto" ? "AUTO" : "USER"}</span></span>
      <span style="width:90px;text-align:right;color:var(--faint)">${escapeHtml(String(t.created_at || "").slice(0, 10))}</span>
    </div>`).join("");
  return `
  <div class="pageheader"><span class="title">Tags</span><span class="count">${TAGS.length}</span></div>
  <div class="list-subhead"><span style="flex:1">Label / owner</span><span style="width:70px">Source</span><span style="width:90px;text-align:right">Created</span></div>
  <div class="content">
    ${rows || `<div class="empty-note">No tags yet.</div>`}
    ${TAGS_TOTAL > TAGS.length ? `<div class="empty-note">Showing latest ${TAGS.length} of ${TAGS_TOTAL} total.</div>` : ""}
  </div>`;
}
```

Add cases to `renderMainContent()`:
```js
    case "goals": return renderGoalsScreen();
    case "tags": return renderTagsScreen();
```

Add nav items to `renderSidebar()`, after Integrations:
```js
      <button class="nav-item${v === "goals" ? " active" : ""}" data-act="nav" data-view="goals">${ICON_TARGET}<span class="lbl">Goals</span></button>
      <button class="nav-item${v === "tags" ? " active" : ""}" data-act="nav" data-view="tags">${ICON_TAG}<span class="lbl">Tags</span></button>
```

Add lazy-loading to the `nav` click branch:
```js
      if (el.dataset.view === "goals" && !GOALS.length) loadGoals();
      if (el.dataset.view === "tags" && !TAGS.length) loadTags();
```

- [ ] **Step 4: Deploy and verify visually**

```bash
cd worker-admin && npx wrangler deploy
```
Click "Goals": expect a compact list, purpose/owner/source/date. Click "Tags": expect the same shape with color chips instead of plain text for the label.

- [ ] **Step 5: Commit**

```bash
git add worker-admin/src/index.js worker-admin/public/index.html
git commit -m "Add cross-tenant Goals and Tags screens"
```

---

### Task 10: Slack screen (cross-tenant)

**Files:**
- Modify: `worker-admin/src/index.js` (new `GET /api/slack`)
- Modify: `worker-admin/public/index.html` (new Slack screen)

**Interfaces:**
- Consumes: `slack_connections`, `slack_rules` tables.
- Produces: `GET /api/slack` → `{tenants: [{owner_email, team_name, status, rule_count}]}` (only tenants with a `slack_connections` row — tenants that never connected Slack don't appear, matching the spec's "one row per tenant with any Slack footprint").

- [ ] **Step 1: Add the endpoint**

```js
    if (pathname === "/api/slack" && request.method === "GET") {
      if (!(await adminAuthed(request, env))) return json({ error: "not authenticated" }, 401);
      const { results } = await env.DB.prepare(
        `SELECT sc.owner_email, sc.team_name, sc.status,
                (SELECT COUNT(*) FROM slack_rules sr WHERE sr.owner_email = sc.owner_email) as rule_count
         FROM slack_connections sc ORDER BY sc.connected_at DESC`
      ).all();
      return json({ tenants: results });
    }
```

- [ ] **Step 2: Deploy and verify the API directly**

```bash
cd worker-admin && npx wrangler deploy
curl -s -b "bugradar_admin_session=<valid token>" https://bug-radar-admin.shubhamvishnu.workers.dev/api/slack
```
Expected: `{"tenants": [...]}`, each entry has `owner_email`, `team_name`, `status`, `rule_count`.

- [ ] **Step 3: Add the frontend screen**

Add global and loader:
```js
let SLACK_TENANTS = [];
async function loadSlackTenants() {
  const res = await fetch("/api/slack");
  if (res.ok) SLACK_TENANTS = (await res.json()).tenants;
  render();
}
```

Add the render function:
```js
function renderSlackScreen() {
  const rows = SLACK_TENANTS.map(t => `
    <button class="list-row" data-act="open-user" data-email="${escapeHtml(t.owner_email)}">
      <span class="col-user">
        <span class="avatar">${escapeHtml((t.owner_email || "?")[0].toUpperCase())}</span>
        <span style="min-width:0;overflow:hidden;display:flex;align-items:baseline;gap:8px">
          <span class="nm">${escapeHtml(t.owner_email)}</span>
          <span class="meta">${escapeHtml(t.team_name)}</span>
        </span>
      </span>
      <span style="width:100px;color:${t.status === "connected" ? "var(--oc-done)" : "var(--faint)"}">${escapeHtml(t.status)}</span>
      <span style="width:90px;text-align:right;color:var(--muted)">${t.rule_count} rule${t.rule_count === 1 ? "" : "s"}</span>
    </button>`).join("");
  return `
  <div class="pageheader"><span class="title">Slack</span><span class="count">${SLACK_TENANTS.length}</span></div>
  <div class="list-subhead"><span style="flex:1">Owner / workspace</span><span style="width:100px">Status</span><span style="width:90px;text-align:right">Rules</span></div>
  <div class="content">${rows || `<div class="empty-note">No tenants have connected Slack yet.</div>`}</div>`;
}
```

Add the case to `renderMainContent()`: `case "slack": return renderSlackScreen();`

Add the nav item to `renderSidebar()`, after Tags:
```js
      <button class="nav-item${v === "slack" ? " active" : ""}" data-act="nav" data-view="slack">${SLACK_MARK_SVG(16)}<span class="lbl">Slack</span></button>
```

Add lazy-loading:
```js
      if (el.dataset.view === "slack" && !SLACK_TENANTS.length) loadSlackTenants();
```

Row clicks reuse `open-user`, same as Integrations — opens that tenant's Tenant Detail (which already shows the fuller Slack section built in Task 6).

- [ ] **Step 4: Deploy and verify visually**

```bash
cd worker-admin && npx wrangler deploy
```
Click "Slack": expect a compact table, owner/workspace/status/rules. Click a row: confirm it opens Tenant Detail and the Slack section there matches.

- [ ] **Step 5: Commit**

```bash
git add worker-admin/src/index.js worker-admin/public/index.html
git commit -m "Add cross-tenant Slack screen"
```

---

### Task 11: Data verification pass

**Files:** none (verification only — any drift found gets a follow-up fix committed to the file where the bug is, but this task itself makes no planned changes).

**Interfaces:** none new.

- [ ] **Step 1: Verify Overview counts against direct D1 queries**

For each of `userCount`, `connectionCount`, `reportCount`, `slackConnectedCount`, `failingConnectionCount`, run the matching direct query and diff against what `/api/overview` returns:
```bash
cd worker
npx wrangler d1 execute bug-radar-db --remote --command="SELECT COUNT(*) FROM users;"
npx wrangler d1 execute bug-radar-db --remote --command="SELECT COUNT(*) FROM connections;"
npx wrangler d1 execute bug-radar-db --remote --command="SELECT COUNT(*) FROM reports;"
npx wrangler d1 execute bug-radar-db --remote --command="SELECT COUNT(*) FROM slack_connections WHERE status = 'connected';"
npx wrangler d1 execute bug-radar-db --remote --command="SELECT COUNT(*) FROM connections WHERE last_error IS NOT NULL;"
```
Compare each against `curl -s -b "bugradar_admin_session=<valid token>" https://bug-radar-admin.shubhamvishnu.workers.dev/api/overview`.

- [ ] **Step 2: Verify Tenants' per-row connection counts**

Pick 2-3 tenants from `GET /api/users`. For each, run:
```bash
npx wrangler d1 execute bug-radar-db --remote --command="SELECT COUNT(*) FROM connections WHERE owner_email = '<email>';"
```
Compare against that tenant's `connection_count` in the API response.

- [ ] **Step 3: Verify Sessions, Integrations, Goals, Tags, Slack counts**

```bash
npx wrangler d1 execute bug-radar-db --remote --command="SELECT COUNT(*) FROM goals;"
npx wrangler d1 execute bug-radar-db --remote --command="SELECT COUNT(*) FROM tags;"
npx wrangler d1 execute bug-radar-db --remote --command="SELECT COUNT(*) FROM connections;"
npx wrangler d1 execute bug-radar-db --remote --command="SELECT COUNT(*) FROM slack_connections;"
```
Compare `total` from `/api/goals` and `/api/tags` against the direct counts (should match exactly). Compare `/api/connections`'s array length against the direct `connections` count (should match — no cap on that endpoint). Compare `/api/slack`'s array length against the direct `slack_connections` count (should match).

For Sessions, confirm `scanned_reports` from `/api/sessions` matches `min(500, SELECT COUNT(*) FROM reports)`.

- [ ] **Step 4: If any drift is found, fix it and note why in the commit message**

Fix the underlying query in `worker-admin/src/index.js`, redeploy, re-run the specific comparison from whichever step caught it, confirm it now matches, then commit:
```bash
git add worker-admin/src/index.js
git commit -m "Fix data drift found in admin portal verification: <what was wrong>"
```

- [ ] **Step 5: If everything matches, no commit needed for this task** — report the verification results (which counts were checked, that all matched) as this task's completion note.
