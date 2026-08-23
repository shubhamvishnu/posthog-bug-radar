# Slack Integration — Design

## Context

Bug Radar's dashboard is the only place a confirmed bug currently surfaces. This adds Slack as a second, push-based surface: a new **Slack** tab in Settings lets an account connect one Slack workspace and define routing rules that decide which confirmed tasks get posted to which channel, and optionally DM the code owner. The UI/UX for this was fully designed in Claude Design (project `5f710252-b5a0-4483-bbf1-26f26db08f02`, file `Signularity.dc.html`) and is implemented here verbatim, this spec covers what that design left as a prototype (a mocked connect flow, mocked channel list, mocked task data) and turns it into a real, working integration against the real Slack API and the real D1 schema.

**Design reference:** `Signularity.dc.html` in the above project (the `SLACK` render block and its `slackVals()`/`slMatch()`/`slackConnect()` logic) is the source of truth for every screen, copy string, and interaction. This spec does not restate the UI, it only fills in what the design intentionally mocked: real OAuth, real channel data, real task matching against the real schema, real message posting.

## Goals

- A new **Slack** tab in Settings (`worker/public/index.html`), positioned alongside Connections / Company knowledge / Pipeline & model / Goals & tags, matching the design pixel-for-pixel: connect screen with scope explanations, connecting-progress screen, connected/disconnected workspace card, disconnect-confirm modal, rules list (empty state, rule cards with paused/orphaned badges), and the full rule builder (name, six condition groups, channel + DM-owner destination, live dry-run).
- Real Slack OAuth (`v2` OAuth flow), one workspace per account, bot token encrypted at rest using this codebase's existing `encryptSecret`/`decryptSecret` helpers (`worker/src/index.js:94-115`) — same pattern already used for PostHog connection API keys, no new crypto primitives.
- Real routing rules stored in D1, matched against real tasks (`goal_id`, `tags[].tag_id`, `outcome`, `severity`, `real_bug`, `customer_reachable` on each task in `reports.micro_findings`), not the design's mocked string-matching.
- Real message posting: when a report is pushed and a task matches one or more enabled rules, Bug Radar posts a real Slack message to each matching rule's channel via `chat.postMessage`.
- Real, live dry-run: matches a rule's conditions against the account's actual recent tasks, not `slackTasks()`'s synthetic 50.

## Non-goals (explicitly deferred, matches what the design itself left as "next"/toggle-without-logic)

- **No interactive Block Kit buttons** (Acknowledge / Create ticket / Not a bug) in the posted message for this pass. Those require a public HTTPS endpoint that verifies Slack's request signature (`SLACK_SIGNING_SECRET`) and a whole separate interactivity-handling surface — real scope, not this pass. The posted message is informational: title, severity, fields, evidence links if present, footer explaining why it was routed here.
- **No "also DM the code owner" logic.** The toggle is built, stored, and shown in the UI exactly as designed (the design brief calls this out explicitly: build the UI now even though owner-detection doesn't exist), but no DM is actually sent in this pass, there's no git-blame/CODEOWNERS/Linear-component mapping anywhere in this codebase to determine an owner from. Storing `dm_owner` now means the UI never needs to change shape when that capability ships later.
- **No thread-based updates** (PR opened / ticket filed / resolved, as replies in the same thread) — that depends on the Linear + PR automation from the product vision doc, neither of which exists in this codebase yet. The initial post is a single message per matching rule.
- **No multi-workspace support.** One Slack workspace per account, matches the design's "One Slack workspace per account" copy verbatim.
- **No conversational query surface** (`@Singularity what broke today`) — needs Slack's Events API + a real query-answering backend; out of scope for this pass.

## Required user action before this can go live (blocking, external)

I cannot self-issue Slack API credentials. Before OAuth can be tested against a real workspace, you need to:

1. Go to `https://api.slack.com/apps` → **Create New App** → **From scratch**. Name it "Singularity" (or "Bug Radar", your call), pick the workspace you'll test against.
2. Under **OAuth & Permissions** → **Bot Token Scopes**, add: `chat:write`, `chat:write.public` (so the bot can post to any public channel without someone manually inviting it first), `channels:read` (channel list for the picker), `users:read` (needed later for DM-owner, harmless to request now so we don't need a second OAuth round-trip when that ships).
3. Under **OAuth & Permissions** → **Redirect URLs**, add: `https://bug-radar.shubhamvishnu.workers.dev/api/slack/oauth/callback`.
4. Under **Basic Information**, copy the **Client ID** and **Client Secret**.
5. Store them in macOS Keychain (matching this project's established convention) so I can retrieve and set them as Worker secrets without you pasting them into chat:
   ```bash
   security add-generic-password -U -a "bugradar" -s "SLACK_CLIENT_ID" -w
   security add-generic-password -U -a "bugradar" -s "SLACK_CLIENT_SECRET" -w
   ```
   (each `-w` with no value prompts you to type it, not echoed, not in shell history)

I'll build everything, including the full OAuth exchange, in parallel — the implementation doesn't block on this, but a real end-to-end "click Add to Slack and see a message land in a real channel" verification does. Do this whenever convenient; I'll pick up the secrets when I get there.

## Data model (`worker/schema.sql`)

Three new tables, all `owner_email`-scoped like every other table in this app:

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

- `slack_connections.status`: `'connected'` | `'disconnected'`. On disconnect, `encrypted_bot_token`/`iv` are cleared (nulled) and `status` flips, `slack_rules` rows are **never touched** — matches the design's "kept, not deleted" copy exactly. Reconnect always re-runs full OAuth (matches the design: `slReconnect` calls the same `slackConnect()` as first-time connect), a fresh token replaces the null.
- `slack_oauth_state`: short-lived CSRF-protection rows for the OAuth redirect round-trip (browser leaves the app during OAuth, so this can't ride on an in-memory session the way an XHR-based flow could). A row older than 10 minutes is treated as invalid at callback time and deleted either way once consumed.
- `slack_rules.cond_goal_ids`/`cond_tag_ids` store real `goals.id`/`tags.id` values (JSON array of integers), not label strings like the mock, this is what makes orphan-detection possible: a rule is orphaned if any id in these arrays no longer exists in `goals`/`tags` for this owner.
- `channel_id` + `channel_name` both stored: `channel_id` (Slack's `C0123456` form) is what `chat.postMessage` needs, `channel_name` is cached purely so the rules list can render `#payments-eng` without an extra live Slack call on every page load.

## Auth model

Slack's own token (`encrypted_bot_token`) is a service credential for calling the Slack API on the account's behalf, it is never used to authenticate a *user* into this app. All Slack tab routes are session-authed exactly like every other Settings route (`getSessionEmail`), no new auth mechanism.

## Routes on the main Worker (`worker/src/index.js`)

All session-authed via the existing `getSessionEmail` pattern unless noted:

- `GET /api/slack/status` → `{ connected: bool, team_name, connected_by_email, connected_at }` or `{ connected: false }`. Drives the tab's initial view (`none` / `connected` / `disconnected`) on page load.
- `GET /api/slack/oauth/start` → generates a random `state`, inserts `(state, owner_email)` into `slack_oauth_state`, redirects (302) to `https://slack.com/oauth/v2/authorize?client_id=...&scope=chat:write,chat:write.public,channels:read,users:read&redirect_uri=...&state=...`.
- `GET /api/slack/oauth/callback` (no session cookie required — Slack's redirect is a plain browser navigation that may arrive without the app's session context in some browsers; the `state` row is what proves this callback belongs to a real `owner_email`, not the cookie) → looks up `state` in `slack_oauth_state` (404/expired if missing or >10 min old, delete the row either way once read), exchanges `code` via `POST https://slack.com/api/oauth.v2.access` (`client_id`, `client_secret`, `code`, `redirect_uri`), on success encrypts the returned `access_token` and upserts `slack_connections` (`team_id`, `team_name` from `team.id`/`team.name` in the response, `connected_by_email` from the session tied to that `state` row), redirects (302) back to the app's Slack settings tab.
- `GET /api/slack/channels` → requires an active connection; calls Slack's `conversations.list` (`types=public_channel`, `exclude_archived=true`, paginated via `cursor` until exhausted, capped at a sane limit e.g. 500 channels) with the decrypted bot token, returns `[{ id, name, num_members }]`.
- `POST /api/slack/disconnect` → sets `status='disconnected'`, nulls `encrypted_bot_token`/`iv`, leaves `slack_rules` untouched.
- `GET /api/slack/rules` → this owner's rules, each enriched with an `orphaned` computed field (cross-checked against live `goals`/`tags` tables) matching the design's `orphaned`/`orphanText`.
- `POST /api/slack/rules` / `PATCH /api/slack/rules/:id` / `DELETE /api/slack/rules/:id` — standard CRUD, body shape mirrors the D1 columns above (arrays as real JSON, not stringified, the route stringifies for storage).
- `POST /api/slack/rules/:id/toggle` — flips `enabled`, matches the design's rule-card toggle switch (a dedicated route rather than requiring a full PATCH body for a one-field flip, same pattern as this app's other toggle-style routes).
- `POST /api/slack/dry-run` → body is a **candidate condition object** (not yet saved, matches the design's live-as-you-build dry-run), returns `{ total, matches: [{title, severity, when}] }` capped at the same "4 shown, N more" shape as the design (`slDryPreview`/`slDryMore`). Matches against the owner's most recent tasks (see below).

## Rule matching

Shared matching function (used by both the dry-run route and real-time posting), a direct real-data port of the design's `slMatch(t, c)`:

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
```

**"Recent tasks" for dry-run**: flatten `micro_findings[].tasks[]` across this owner's most recent report rows (`ORDER BY id DESC`), stopping once 50 tasks are collected or 10 report rows are scanned (whichever first, avoids an unbounded scan for an owner with very few tasks per report). Sort the flattened set by each task's `key_timestamp` (falling back to the parent report's `generated_at` if a task has no `key_timestamp`) descending, then take the first 50, matching the design's "last 50 tasks" framing as closely as real data allows.

## Real-time posting (the actual integration point)

`POST /api/report` and `POST /api/pipeline/report/merge` (`worker/src/index.js`) already resolve `goal_id`/`tag_id` for every task before the report is stored (`resolveGoals`/`resolveTags`). Immediately after that resolution and the report row is written, add one step: if this owner has an active Slack connection (`status='connected'`) and at least one enabled rule, evaluate every task in the just-pushed findings against every enabled rule; for each match, call `chat.postMessage` with a Block Kit payload matching the design's channel-message screen — title (task title), severity dot + label, outcome, evidence links only for fields that actually exist on the task (don't render a fake "session replay" link if there's no session data to link to), and a footer line: `Routed here: <rule.name>`. This runs **after** the report write succeeds and is best-effort: a Slack API failure (rate limit, revoked token, channel archived) must never fail or roll back the report push, log it (reuse `logConnectionEvent`'s pattern if a natural connection_id is available, otherwise a plain `console.error` is acceptable for v1 since there's no per-Slack-connection audit log in scope here) and move on to the next match.

**Fan-out, not first-match**: a task can match more than one enabled rule, if so it's posted to every matching rule's channel, exactly as the design's persistent in-product explainer states ("If a task matches more than one rule, it's sent to every matching channel").

## Frontend (`worker/public/index.html`)

Port the `SLACK` render block from `Signularity.dc.html` verbatim into this app's existing vanilla-JS render/state architecture (the `render()` dispatch + `state` object pattern already used for every other Settings tab in this file), adapting only the plumbing (Claude Design's `{{ }}`/`sc-if`/`sc-for` template directives become this app's existing template-literal + `escapeHtml` pattern, `setState`/`DCLogic` become this app's existing `state.x = y; render()` pattern), not the visuals, copy, or interaction logic, all of which are already exactly specified in the design file.

State additions mirror the design's mocked state shape one-to-one: `settingsTab` gains a `'slack'` value; add `slackView` ('none'/'connecting'/'connected'/'disconnected'), `slackConnectStep`, `slackRules`, `slackBuilder`, `slackConfirmDisc`, `slackGoalQuery`/`slackTagQuery`/`slackChannelQuery`, `slackChannels` (fetched live, replaces the design's static `SL_CHANNELS`), `slackDryRun` (fetched live per builder-condition-change, replaces `slackTasks()`).

Wherever the design used a mocked/synthetic source, swap in the real route:
- `slackConnect()`'s 3-step fake timer → real: clicking "Add to Slack" navigates the browser to `/api/slack/oauth/start` (a real redirect, not an XHR — OAuth requires a full top-level navigation to Slack's own domain). On return, the app reloads and `GET /api/slack/status` determines the view.
- `SL_CHANNELS` (static array) → `GET /api/slack/channels`, fetched once when the rule builder opens, filtered client-side exactly like the design already does (no behavior change, just a real data source).
- `slackTasks()` + local `slMatch()` → `POST /api/slack/dry-run`, called whenever the builder's condition state changes (debounced), response shape matches `slDryPreview`/`slDryHasMatches`/`slDryZero` directly.
- `SL_GOALS_FALLBACK` / `tagLib` goal-and-tag search → this app already has live `goals`/`tags` state loaded elsewhere in Settings (Goals & tags tab), reuse that same in-memory list for the picker's local filter, no new fetch needed.

## Verification

No unit test framework in this codebase, real calls throughout, matching every prior feature:

1. Migrate schema on remote D1 (`slack_connections`, `slack_oauth_state`, `slack_rules`), confirm via `PRAGMA table_info`.
2. Once `SLACK_CLIENT_ID`/`SLACK_CLIENT_SECRET` are available (see prerequisite above): drive the real OAuth flow via Playwright against the real deployed app, land back on the Slack tab connected to a real workspace, confirm `slack_connections` has a real encrypted token and the plaintext round-trips through `decryptSecret`.
3. `GET /api/slack/channels` against the real connected workspace, confirm real channel names come back.
4. Create a real rule via the UI, confirm the dry-run count matches a hand-count against real D1 task data for a known set of conditions.
5. Push a real report (`bug_radar.py` run or a synthetic `POST /api/report`) containing a task that matches a saved rule, confirm a real message lands in the real Slack channel.
6. Disconnect, confirm rules remain in `GET /api/slack/rules` (not deleted) but the tab shows the disconnected banner and rules render paused; reconnect, confirm they reactivate with no re-creation needed.
7. Delete a tag referenced by a saved rule's `cond_tag_ids`, confirm `GET /api/slack/rules` marks that rule `orphaned: true`.
