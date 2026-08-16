# Admin Portal — Design

## Context

Bug Radar is a real multi-tenant app today: any email can self-serve an OTP login (`worker/src/index.js:439-489`) and gets their own `connections`, `reports`, `goals`, `tags`, `connection_events`, `corrections` — all scoped by `owner_email`. `shubhamvishnu@gmail.com` (already the app's `DEFAULT_OWNER_EMAIL`, `worker/src/index.js:91`) is you, and you're also a real tenant of the app. There is currently no way to see across tenants: who's signed up, whether their connections are healthy, what their pipeline runs actually found, or what's in their audit log.

This adds a second, standalone Cloudflare Worker — `bug-radar-admin` — that gives `shubhamvishnu@gmail.com` read-only visibility into every tenant's full data. It lives on its own `*.workers.dev` host, not as a tab inside the main app, so it has a separate cookie, a separate login surface, and a much smaller attack surface than the main app (no pipeline secrets, no key-decryption capability).

## Goals

- A separate Worker (`bug-radar-admin`, own `worker-admin/` directory, own deploy) reachable at `bug-radar-admin.shubhamvishnu.workers.dev`, sharing the main app's D1 database (`bug-radar-db`) via the same binding.
- Login restricted to `shubhamvishnu@gmail.com` only — reuses the existing OTP/session mechanism and tables, but `request-otp` on this Worker rejects every other email outright, before a code is ever sent.
- Full read-only drill-down per tenant: their connections (config, health, sync settings — never the decrypted API key), latest report (sessions/tasks/tags/goals/real-bug flags/outreach recommendations/captured-moment thumbnails), goals library, tags library, correction history, and full audit log (`connection_events`) across all their connections.
- A global cross-tenant activity feed: every connection's audit-log entries, newest first, with owner email attached.
- An overview screen: total users, total connections (by status), total reports.
- Captured-moment screenshots render as real thumbnails, not just metadata — via one narrow new route on the *main* Worker (see below), not by giving the admin Worker its own copy of the R2 bucket or the encryption key.

## Non-goals

- No editing, deleting, or impersonating a tenant from the admin view — every route here is `GET`.
- No raw SQL browser.
- No real-time push — same lazy, pull-on-navigate convention as the rest of this app.
- No custom domain / DNS work — `*.workers.dev` is enough, confirmed with the user.
- No new capability for the main app's existing users — the only change to the main Worker is one new narrow, secret-gated media-proxy route (below).

## Architecture

Two independent Cloudflare Workers, one shared D1 database:

```
worker/            (existing, unchanged except one new route)
  src/index.js
  public/index.html
  wrangler.jsonc    → name: "bug-radar"

worker-admin/       (new)
  src/index.js
  public/index.html
  wrangler.jsonc    → name: "bug-radar-admin", same D1 database_id as worker/wrangler.jsonc
```

`worker-admin` gets its own Resend secret (email OTP) and a new `ADMIN_MEDIA_SECRET` it shares with the main Worker (below). It does **not** get `CONNECTION_ENCRYPTION_KEY` or `BUGRADAR_API_SECRET` — it never decrypts a connection's API key and has no pipeline routes, so those secrets simply don't exist on this Worker's attack surface.

## Auth

`worker-admin/src/index.js` implements its own copy of the OTP/session flow (`request-otp`, `verify-otp`, `me`, `logout`), reading/writing the same `otp_codes`, `sessions`, `users` D1 tables the main Worker already uses (shared DB, so this is zero new schema). Two differences from the main Worker's copy:

1. `request-otp` here immediately 404s (`{"error":"not found"}`, so an attacker can't even infer this is an admin endpoint) for any email that isn't `shubhamvishnu@gmail.com`. No code is ever generated or sent for anyone else.
2. Every data route additionally calls `adminAuthed(request, env)` → `getSessionEmail(request, env) === ADMIN_EMAIL`. This is the real gate — the `request-otp` restriction is defense in depth, not the only check.

Because this Worker is a different origin, its session cookie is naturally scoped separately from the main app's — logging into one never grants the other.

## Data model

No new tables. Every admin route is a read over existing tables (`users`, `connections`, `reports`, `goals`, `tags`, `corrections`, `connection_events`), plus one new secret (`ADMIN_MEDIA_SECRET`, a fresh random value, set on both Workers) for the media proxy.

## Routes on `worker-admin`

All session-authed via `adminAuthed`, all `GET`:

- `GET /api/overview` → `{ userCount, connectionCount, reportCount, connectionsByStatus: {status: count} }`
- `GET /api/users` → every row from `users`, each with `connection_count` and `last_activity` (max of that owner's `connection_events.created_at` across their connections, falling back to their latest `reports.created_at`, `null` if neither exists)
- `GET /api/users/:email` → the full bundle:
  ```json
  {
    "user": { "email": "...", "created_at": "..." },
    "connections": [ { "id": 1, "region": "...", "project_id": "...", "project_name": "...", "timezone": "...", "identity_email_prop": "...", "identity_name_prop": "...", "identity_role_prop": "...", "status": "...", "last_error": "...", "last_synced_at": "...", "sync_freq": "...", "sync_max_sessions": 8, "last_pipeline_run_at": "...", "created_at": "..." } ],
    "latest_report": { "connection_id": 1, "generated_at": "...", "macro_themes": [...], "micro_findings": [...] } ,
    "report_history": [ { "id": 42, "connection_id": 1, "generated_at": "...", "created_at": "...", "task_count": 7 } ],
    "goals": [ { "id": 1, "purpose": "...", "description": "...", "tags": [...], "source": "...", "created_at": "..." } ],
    "tags": [ { "id": 1, "label": "...", "color": "...", "source": "...", "created_at": "..." } ],
    "corrections": [ { "id": 1, "session_id": "...", "task_index": 0, "task_title": "...", "field": "...", "from_value": "...", "to_value": "...", "reason": "...", "connection_id": 1, "created_at": "..." } ],
    "events": [ { "id": 1, "connection_id": 1, "kind": "...", "status": "...", "title": "...", "detail": "...", "trigger_label": "...", "created_at": "..." } ]
  }
  ```
  `connections` never includes `encrypted_api_key` or `iv`. `latest_report` is the single most recent row across all of this owner's connections (same "latest wins" semantics as the main app's existing `getLatestReport`). `report_history` is the last 10 report rows (lightweight — id/connection/timestamps/task_count only, no full findings payload) so the admin can see run cadence without re-fetching full JSON per row. `events` is capped at the 200 most recent across all of this owner's connections.
- `GET /api/events?limit=100` → global feed: `connection_events` joined to `connections` for `owner_email` and `project_name`, newest first, across every tenant.
- `GET /api/media/:key` → proxies to the main Worker's new `/api/admin/media/:key` (server-to-server, `Authorization: Bearer <ADMIN_MEDIA_SECRET>`) and streams the image back. `:key` is the same opaque R2 key already stored in a task's `media[].url` (currently shaped `/api/media/<key>`) — the admin frontend strips that prefix and requests `/api/media/:key` from this Worker instead.

## One new route on the main Worker (`worker/src/index.js`)

- `GET /api/admin/media/:key` — gated by `Authorization: Bearer <ADMIN_MEDIA_SECRET>` (a new secret, not `BUGRADAR_API_SECRET` — kept distinct so it can't be confused with, or accidentally reused as, the pipeline's identity). Same body as the existing session-authed `/api/media/:key` route, minus the owner-match check (the caller has already been admin-authed by `worker-admin`'s own session gate before this request is ever made).

## Frontend (`worker-admin/public/index.html`)

New, small, purpose-built page — not a fork of the main app's SPA shell:

- **Login**: email + OTP code, same two-step flow as the main app, visually consistent (reuse existing color tokens / font stack) but a much smaller page.
- **Overview**: the four numbers from `/api/overview`, plus a global activity feed (`/api/events`) below it, reusing the existing audit-log row visual pattern (dot · title · trigger, detail below, relative timestamp).
- **Users**: a table (`/api/users`) — email, signup date, connection count, last activity. Click a row → user detail.
- **User detail** (`/api/users/:email`): connection cards (reusing the existing connection-card visual pattern, read-only — no edit affordances, no re-sync button), each connection's own audit log; the latest report rendered as a session/task list reusing the existing task-card, tag-chip, and goal-badge visual patterns (read-only — no tag/goal add-remove controls); captured-moment thumbnails via `/api/media/:key`; goals library; tags library; corrections history as a simple table.

## Verification

No unit test framework in this codebase — real calls, matching every prior feature:

1. Deploy `worker-admin` (`cd worker-admin && npx wrangler deploy`), confirm it's live at its own `*.workers.dev` host.
2. `curl` `POST /api/auth/request-otp` on `worker-admin` with a non-admin email, confirm 404 and confirm no row lands in `otp_codes` for it.
3. Run the real OTP flow for `shubhamvishnu@gmail.com` against `worker-admin`, confirm a session cookie comes back and `GET /api/overview` succeeds with it.
4. Confirm every `worker-admin` data route 401s with no cookie and 403s with some other tenant's cookie (obtained via the main Worker's own OTP flow) if that's technically reachable — since the routes live on a different origin than tenant cookies are scoped to, this should already be structurally impossible, but verify directly rather than assuming.
5. `curl` the new main-Worker route `GET /api/admin/media/:key` with the shared secret against a real stored key, confirm the image bytes come back; confirm it 401s with no/garbage auth.
6. Playwright pass: log into `worker-admin` as the admin, open a real tenant (the existing `dreamteam`-adjacent connection's owner) from the Users table, confirm connections/report/tags/goals/corrections/audit-log all render with real data, confirm a captured-moment thumbnail (if one exists for that tenant) loads.
