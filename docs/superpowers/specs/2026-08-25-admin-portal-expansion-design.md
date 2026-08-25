# Admin Portal Expansion — Design

## Goal

Turn `worker-admin` (today: login, a 2-tab overview/users shell, and per-tenant
detail) into the real "sudo admin" surface for the whole platform: dense,
Linear-style compact tables giving cross-tenant visibility into every entity
in the schema — tenants, sessions, integrations, goals, tags, Slack, and the
audit-event feed — plus a simpler password-based login for the single admin
account.

## Non-goals

- Bulk edit/delete actions from the admin UI (view-only for v1; corrections
  and data fixes still happen through the main app or direct D1 access).
- Multi-admin / role-based access. One hardcoded admin account
  (`shubhamvishnu@gmail.com`). Adding teammates is a follow-up once this
  shape is proven.
- Real-time updates (polling/websockets). Every screen loads on navigation,
  same as the main app and current worker-admin.
- Billing/usage/cost views — no billing data exists anywhere in the schema
  yet.
- Per-tenant Slack **notification history** ("last message sent", "N
  notifications this week"). `postSlackNotifications`
  (`worker/src/index.js:459`) has no write-side log of what it posted, only
  `console.error` on failure. Adding that log is real new scope (a
  `slack_notifications_log` table + a write on every successful
  `chat.postMessage`), deliberately deferred. The Slack screen for v1 shows
  connection status and rule count only.

## Current state (what already exists, not being rebuilt)

`worker-admin/` is a separate deployed Worker (`bug-radar-admin`, live at
`https://bug-radar-admin.shubhamvishnu.workers.dev`), service-bound to the
main worker (`env.MAIN_WORKER`) for the media proxy, sharing the same D1
database (`env.DB`, database `bug-radar-db`) as the main app.

- **Auth today:** OTP over email (`otp_codes`/`sessions` tables, both
  scoped by `surface = 'admin'`), gated to a single hardcoded
  `ADMIN_EMAIL` (`worker-admin/src/index.js:6`).
- **Routes today:** `/api/auth/{request-otp,verify-otp,me,logout}`,
  `/api/overview`, `/api/events`, `/api/users`, `/api/users/:email`,
  `/api/media/:key` (all in `worker-admin/src/index.js`, 300 lines).
- **Frontend today:** single `worker-admin/public/index.html` (627 lines),
  flat topbar with two tabs (Overview, Users — `renderTopbar()` at line 541,
  `renderMainContent()` at line 532), `renderUserDetail()` nests a tenant's
  connections/audit-log/goals/tags/corrections/latest-report — none of
  that is reachable except by drilling into one tenant at a time.
- **What's genuinely missing:** any cross-tenant table view. Sessions,
  connections, goals, tags, and Slack state are all locked inside
  per-tenant detail pages today; there's no "show me every X across every
  tenant" screen for any entity.

## Auth: OTP → password

Replace the OTP flow with a single password field for the one hardcoded
admin account. This is an internal, low-blast-radius surface (one person,
not customer-facing), so the design optimizes for simplicity over the
fuller OTP machinery it replaces.

- **Storage:** the password is never committed to source. At
  implementation time, generate a PBKDF2-SHA256 hash (210,000 iterations,
  16-byte random salt, via Web Crypto's `crypto.subtle.deriveBits`) from
  the password the user provided in chat, and store it as a Wrangler
  secret `ADMIN_PASSWORD_HASH` in the format `<salt_hex>:<hash_hex>`. The
  plaintext password is used once, locally, to produce this secret, and
  discarded.
- **Route:** `POST /api/auth/login` replaces
  `request-otp`/`verify-otp`. Body `{email, password}`. Reject
  immediately (`401`) if `email !== ADMIN_EMAIL`. Re-derive the hash from
  the submitted password using the stored salt and compare to
  `ADMIN_PASSWORD_HASH`. On match, same session-issuance as today:
  `crypto.randomUUID()` token, `sessions` table row with
  `surface = 'admin'`, `set-cookie`.
- **Brute-force guard:** mirror the existing OTP pattern's discipline —
  track failed attempts per email in a small in-DB counter (reuse the
  `otp_codes` table's shape is overkill; instead add a one-row-per-email
  `admin_login_attempts` table: `email TEXT PRIMARY KEY, failed_count
  INTEGER DEFAULT 0, locked_until TEXT`). 5 failed attempts locks the
  account for 15 minutes; a successful login resets `failed_count` to 0.
- **What's removed:** the `/api/auth/request-otp` and
  `/api/auth/verify-otp` routes, `sendOtpEmail`, `randomOtp`,
  `OTP_TTL_MS`/`OTP_RESEND_COOLDOWN_MS`/`OTP_MAX_ATTEMPTS` constants, and
  the login-shell's OTP-step UI (`renderLoginOtpStep()`,
  `worker-admin/public/index.html:502`). The `otp_codes` table itself is
  untouched (still used by the main app's customer-facing login) — only
  worker-admin's *use* of it (`surface = 'admin'` rows) goes away.
- **What's unchanged:** `/api/auth/me`, `/api/auth/logout`,
  `getSessionEmail`/`adminAuthed` helpers, the cookie mechanism, and the
  main app's own OTP login for customers (completely separate surface).

## Navigation

Replace the flat two-tab topbar with a left sidebar, matching the main
app's `.nav-item` pattern (`worker/public/index.html:67`) — icon + label,
`.active` state, same hover/active CSS variables so the two apps read as
one product family. Sections, top to bottom: **Overview, Tenants,
Sessions, Integrations, Goals, Tags, Slack, Events**. The admin's email +
logout stays in a slim top strip above the content area, not the sidebar.

## Screens

Every list screen reuses the compact-table pattern already proven in the
main app's People screen (`worker/public/index.html:931`, `renderPeople()`):
a `.pageheader` with title + `.count`, a `.list-subhead` column-header row,
`.list-row` clickable rows (avatar/initials via the shared `.avatar` class,
`chip()` helper for status/severity badges), and a `.crumb`-based breadcrumb
into detail views. No new visual language — the admin app inherits the main
app's CSS variables and component classes wholesale so both surfaces stay
visually identical.

### Overview
Extends today's counts (`userCount`, `connectionCount`, `reportCount`,
`connectionsByStatus`) with: Slack-connected tenant count (`COUNT(*) FROM
slack_connections WHERE status = 'connected'`), and a rolling error count
(`connections` rows where `last_error IS NOT NULL`, surfaced as "N
connections currently failing").

### Tenants (renamed from Users)
Same list as today's Users table, plus a Slack-status column (connected /
not connected, from a `LEFT JOIN slack_connections`). Row click → Tenant
Detail (unchanged route, `/api/users/:email`, expanded per below).

### Tenant Detail
Everything `renderUserDetail()` already shows
(`worker-admin/public/index.html:343`), plus:
- Slack: connection status, team name, rule count (`SELECT COUNT(*) FROM
  slack_rules WHERE owner_email = ?`).
- Full report history instead of the current `LIMIT 10` — paginate
  (`?before_id=`) rather than raising the cap silently.

### Sessions (new, cross-tenant)
New endpoint `GET /api/sessions?limit=200`. Scans the most recent 500
`reports` rows (globally, ordered by `id DESC` — a stated cap, not a
silent one; the screen's header shows "latest 200 of the most recent 500
report rows scanned" so nothing reads as exhaustive when it isn't),
flattens each report's `micro_findings` array into one row per session
(`session_id`, `owner_email`, worst severity across its tasks, bug count,
task count, timestamp), sorts by timestamp descending, returns the top
`limit`. Frontend table: owner, session id, worst severity (reuse
`SEV_TEXT`/`barsSvg` pattern from the main app), bug count, age. Row click
→ the same read-only session/task card rendering worker-admin already has
(`renderSessionCardRO`/`renderTaskCardRO`,
`worker-admin/public/index.html:274-325`), reused as a standalone detail
view instead of only nested in Tenant Detail.

### Integrations (new, cross-tenant)
New endpoint `GET /api/connections`. Every row from `connections` (all
tenants), with `owner_email`, `project_name`, `status`, `last_error`,
`last_synced_at`, `sync_freq`. Table sorted with failing connections
(`last_error IS NOT NULL`) first. Row click → that tenant's Tenant Detail,
scrolled/anchored to its connections section.

### Goals (new, cross-tenant)
New endpoint `GET /api/goals?limit=500`. Every row from `goals` across all
tenants, `id DESC`, capped at 500 with the same stated-not-silent-cap
treatment as Sessions. Table: owner, purpose, tag chips, source
(auto/user badge, matching the pattern already built into the main app's
Slack rule-builder work), created date.

### Tags (new, cross-tenant)
New endpoint `GET /api/tags?limit=500`. Same shape as Goals: owner, label
(rendered as a color chip using the tag's own `color` field), source,
created date.

### Slack (new)
New endpoint `GET /api/slack`. One row per tenant with any Slack
footprint: `LEFT JOIN` `slack_connections` and a `COUNT(*)` subquery
against `slack_rules`. Columns: owner, connection status, team name, rule
count. (Notification history explicitly out of scope — see Non-goals.)

### Events
Unchanged (`GET /api/events`, already cross-tenant). Sidebar entry only —
the screen itself needs no changes.

## Data verification

Before treating any screen as done, cross-check its numbers against a
direct D1 query for the same count (e.g. does the Tenants table's
per-tenant connection count match `SELECT COUNT(*) FROM connections WHERE
owner_email = ?` run by hand). This applies to the *existing* Overview and
Tenants screens too, not just new ones — they haven't been independently
verified against real data before now.

## Out of scope (see Non-goals for the reasoning)

Bulk actions, multi-admin/roles, real-time updates, billing/cost views,
Slack notification history.
