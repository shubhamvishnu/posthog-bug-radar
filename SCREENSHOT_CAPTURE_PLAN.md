# Screenshot capture — parked, not built yet

Status: scoped out, deferred. Revisit when we're ready to build it.

## Decision on the privacy tradeoff

Password-protected sharing needs PostHog's Access Control feature, not available on the
current plan. Decision: accept the exposure, minimize it — a share is only ever live for
the seconds/minutes it takes to capture the screenshot, then immediately disabled. Not
pursuing an Access Control upgrade or scoping to internal-only sessions.

## What's already verified live (2026-08-07, dreamteam project)

- PostHog personal API key now has `sharing_configuration:write` (was missing this
  originally, blocked the first attempt — since added).
- `PATCH .../session_recordings/{id}/sharing/` with `{"enabled": true}` works, returns an
  `access_token`.
- Share URL resolves at both `https://us.posthog.com/shared/{token}` and
  `.../embedded/{token}` (both returned 200).
- `PATCH ... {"password_required": true}` fails: "Sharing with password requires the
  Access Control feature" — confirmed the plan limitation directly, not assumed.
- Disabled the test share immediately after (`{"enabled": false}`) — no session left
  publicly reachable.
- NOT yet verified: whether `?t=<seconds>` actually seeks the player on the shared URL
  the way it does on the authenticated `/replay/{id}` URL. Page loads; seek behavior on
  the shared view specifically is still unconfirmed.

## Scope, when we build it

Only for tasks that already cleared a bar — same "be hardened" principle as customer
outreach, not applied to every finding:
- `real_bug: true` AND `severity: high`, OR
- tasks with `customer_reachable: true`

In practice, from the last real run, that's a small handful per pipeline run, not dozens.

## Approach

Per qualifying task:
1. `PATCH sharing/ {"enabled": true}` → get `access_token`
2. Build `https://us.posthog.com/shared/{token}?t={offset}` using the same
   session-start-relative offset math the dashboard already computes from `key_timestamp`
3. Headless Playwright: open the URL, wait for the replay player to load and seek,
   screenshot
4. `PATCH sharing/ {"enabled": false}` immediately — close the exposure window
5. Save the image, attach a reference to it on that task in the report

## Dedup (needed, not yet designed in detail)

Pipeline runs on overlapping lookback windows (3-day micro window), so the same
session+task can reappear across consecutive runs. Screenshot capture needs a small
ledger of already-captured session_id + key_timestamp pairs so we don't re-share and
re-screenshot the same moment repeatedly.

## Infra

Local execution for now (same as the rest of the pipeline). Move off-desktop to a real
server later — not now. Cloudflare's Browser Rendering API is worth checking against this
user's existing Cloudflare-heavy stack (Workers, D1, R2) when that time comes; not
verified as the right fit yet, just the first thing to look at.
