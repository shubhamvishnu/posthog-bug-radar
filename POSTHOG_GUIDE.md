# PostHog, zero to hero — for Bug Radar

A no-jargon walkthrough of how PostHog actually works, what Bug Radar reads from it today, and what else is sitting there we could use. Written for someone who has never touched PostHog before.

Every factual claim below is either **sourced** (checked against PostHog's own docs or our live project data today) or **inferred** (a reasonable read, not directly verified). Where it matters, I've marked which.

---

## TL;DR

- PostHog records **events** (clicks, page views, errors) as JSON blobs. Bug Radar reads five kinds of these events straight out of the database with SQL. That's it — no video, no AI features from PostHog itself.
- PostHog also offers **Session Replay** (actual video), **AI session summaries** (an LLM reads the event stream, same idea as Bug Radar's own pipeline), **Error Tracking** (grouped stack traces), **Heatmaps**, and a newer **Self-driving** product that opens pull requests automatically. We use none of these yet.
- Pulled dreamteam's actual project settings directly (not a guess): Session Replay is **on**, Heatmaps are **on**, dead-click capture is **on**, console log recording is **off**, network body/header capture is **off** (basic network timing capture is on), and exception autocapture is **not explicitly turned on** — see Part 5.1 for what that last one means for Bug Radar. Replays are only retained **30 days**, so old "watch this moment" links stop playing eventually.
- The single most useful thing we're not using: PostHog's own **AI session summaries** read the event stream exactly like Bug Radar's LLM pass does, and could replace or double-check our custom prompt — but it's a PostHog Cloud paid feature with its own cost, separate from our `claude -p` trick.

---

## Part 1 — PostHog from zero

### 1.1 What PostHog actually is

PostHog is a big table of things that happened, plus tools to query, watch, and act on that table. When someone installs the PostHog snippet on a website or app, every click, page load, and error gets written as a row. Everything else PostHog sells — dashboards, replay, AI features, error tracking — is just a different way of looking at that same table.

### 1.2 The one idea everything else builds on: the **event**

An event is one row: *someone did something, at a time, with some details attached.*

```
event:      "$pageview"
distinct_id: "abc123"            ← who (see Part 2)
timestamp:  "2026-08-09T09:14:02Z"
properties: { $pathname: "/settings/import", $browser: "Chrome", ... }
```

That's the whole shape. A click, a page load, an error, a payment, a custom "invited a teammate" event — all the same shape, just a different `event` name and different `properties`.

### 1.3 Where events come from

Two ways:

1. **Autocapture** — PostHog's script watches the page and automatically turns clicks, page views, form submits, and a few other things into events, with zero code from the product team. This is where `$pageview`, `$autocapture` (a generic click), `$dead_click`, and `$rageclick` all come from. **Sourced**: PostHog auto-captures clicks/taps/changes/submits on `a, button, form, input, select, textarea, label` elements by default.
2. **Custom capture** — the product's own code calls `posthog.capture('deal_created', {...})` for anything autocapture can't infer (e.g., "this specific button click means the user created a deal", not just "a button was clicked"). dreamteam doesn't appear to send custom events into the paths Bug Radar reads — it's leaning entirely on autocapture-derived signals (clicks, dead clicks, rage clicks, exceptions).

### 1.4 Two special autocaptured events Bug Radar is built on

- **Dead click** (`$dead_click`) — a click that didn't cause any visible change on the page. **Sourced** from PostHog's own docs: "Captures clicks that don't trigger a change to the page." This is PostHog's proxy for "the user tried to interact with something and nothing happened."
- **Rage click** (`$rageclick`) — more than 3 clicks on the same spot within 1 second. **Sourced**, and this exact threshold is hardcoded in PostHog's SDK (not currently configurable per PostHog's issue tracker, though a request to make it configurable is open).

Both are heuristics, not certainties — a dead click on a link that triggers a file download is a false positive (PostHog's own team acknowledges this; there's an open feature request for a way to exclude specific elements). This is exactly why Bug Radar's `false_positive_risk` field on macro themes exists — we're already compensating for a known PostHog blind spot.

---

## Part 2 — Identity: how PostHog knows *who*

### 2.1 `distinct_id` — the only thing PostHog actually requires

Every event needs a `distinct_id`. On a website, if the product's code never says otherwise, PostHog's script invents a random anonymous ID and stores it in the browser, silently. At this point PostHog has no idea who this is — just "the same browser came back."

### 2.2 `identify()` — the introduction

When a user logs in (or signs up), the product's own code calls:

```js
posthog.identify('some-stable-id', { email: 'max@company.com', name: 'Max' })
```

**Sourced**, verbatim from PostHog's docs. This does three things:
1. Tells PostHog "this browser's anonymous activity belongs to this real person from now on."
2. **Merges** the anonymous history *before* login into the same person record — so you get one continuous timeline, pre- and post-login.
3. Attaches whatever **person properties** you pass (`email`, `name`, anything) to that person going forward.

This is a one-time "introduction." The product calls it once per login; PostHog remembers.

### 2.3 Why Bug Radar sees real names and emails for dreamteam

We verified this directly against the live project (project 253183): querying `person.properties.email`, `.name`, `.role` returns real values like `anand@dreamteam.co` / `Anand` / `admin`. That only works because dreamteam's own app calls `identify()` when a rep logs in and passes those exact property names. **This is a choice dreamteam's engineers made** — nothing PostHog does automatically. Bug Radar's People tab only works because of that choice.

### 2.4 Scenario: what if a product never calls `identify()`?

Then every session is anonymous. `person.properties.email` would be empty for every row. Bug Radar's People tab would have nothing to group by — you'd fall back to grouping by raw `person_id` (a random string) or `$device_id`, which tells you "the same browser did this twice" but never a name. **This is the single biggest reason Bug Radar can't be dropped into just any PostHog project unmodified** — it currently assumes `email`/`name`/`role` exist as person properties, and those are dreamteam-specific conventions, not a PostHog default.

### 2.5 Anonymous vs identified events — the cost angle

**Sourced**: PostHog bills identified events (events tied to a real person profile) at up to 4x the cost of anonymous ones, because identified events create/update a person record. This is worth knowing if dreamteam ever asks "why is our PostHog bill what it is" — every logged-in rep's click is an identified event.

### 2.6 The API for identity: the Persons endpoint

Bug Radar reads person properties as a side-effect of the events query (`person.properties.email` tacked onto the events HogQL query, via `any(...)` since ClickHouse needs an aggregate). PostHog also has a **dedicated Persons API** if you ever need person data on its own, without joining through events:

```
GET  /api/projects/:project_id/persons/            # list, paginated
GET  /api/projects/:project_id/persons/:id/         # one person
GET  /api/projects/:project_id/persons/:id/activity/          # their event history
GET  /api/projects/:project_id/persons/:id/properties_timeline/  # how a property changed over time
POST /api/projects/:project_id/persons/:id/split/   # undo a bad identify()/merge
```

**Sourced**, full endpoint list from PostHog's own API reference. `properties_timeline` is worth flagging for a specific reason: it shows how a person property **changed over time** — e.g. if a rep's `role` was ever updated from `sales_member` to `admin`. Right now Bug Radar's People tab shows only the *current* role because it reads `person.properties.role` off events (which, per Part 2, reflects the value **at the time the event was ingested**, not necessarily "right now" — a subtlety already noted in this project's own working notes on person-on-events mode). The Persons API's `/split/` endpoint is also the documented fix if a merge ever goes wrong (two real people accidentally merged into one identity).

---

## Part 3 — Sessions: how loose events become "one visit"

### 3.1 The rule, exactly

**Sourced**, verbatim: PostHog's JS/mobile SDKs stamp every event with a `$session_id`. A new session starts when either:
- there's **no activity for 30 minutes**, or
- the current session has run for **24 hours** (hard cap).

"Activity" includes autocapture events *and* replay activity like mouse movement — so someone reading a page without clicking still keeps a session alive if replay is on.

A session can span multiple browser tabs on the same device (still one session), but switching browsers (Chrome → Firefox) or calling `posthog.reset()` starts a new one.

### 3.2 Why this matters for Bug Radar specifically

Bug Radar's `fetch_session_events` query pulls every event sharing one `$session_id`, in order, and hands the whole stream to the LLM. Because a session can legitimately contain several unrelated things a user did (import a CSV, then separately browse a contact), the SESSION_PROMPT explicitly segments one session into multiple "tasks" rather than forcing one verdict — this is a direct design response to how PostHog defines a session (one continuous browser visit, not "one user goal").

---

## Part 4 — What Bug Radar reads from PostHog today (verified against the code)

Grounded in [bug_radar.py](posthog-bug-radar/bug_radar.py) as it stands right now:

| What | Exact source | Notes |
|---|---|---|
| Dead clicks, rage clicks, exceptions | `events` table, filtered to `$dead_click`, `$rageclick`, `$exception` | Raw HogQL SQL query, no PostHog product UI involved |
| Session's ordered event stream | Same table, filtered by `$session_id`, includes `$pageview` and `$autocapture` too | Capped at 150 events per session |
| Who did it | `person.properties.email`, `.name`, `.role` | Only works because dreamteam calls `identify()` — see Part 2.3 |
| Session start time | `min(timestamp)` per session | Used for "how long ago" labels |
| The "watch this moment" link | `replay_url + "?t=<seconds>"` computed from the closest matching event timestamp | **Bug Radar never fetches the replay itself** — it only builds a URL a human clicks |

### 4.1 The exact API call behind all of this

Everything in the table above comes from **one API endpoint**, called four times per pipeline run:

```
POST /api/projects/253183/query/
Authorization: Bearer <personal API key>
Content-Type: application/json

{
  "query": {
    "kind": "HogQLQuery",
    "query": "SELECT event, properties.$el_text, properties.$pathname, timestamp FROM events WHERE properties.$session_id = '...' ORDER BY timestamp LIMIT 150"
  }
}
```

**Sourced**, this is PostHog's general-purpose **Query API**. The response — confirmed directly from `bug_radar.py`'s own working code — is a flat table shape, not nested JSON per row:

```json
{
  "columns": ["event", "properties.$el_text", "properties.$pathname", "timestamp"],
  "results": [
    ["$dead_click", "Continue", "/settings/import/mapping", "2026-08-06T15:20:23Z"],
    ["$autocapture", "Save", "/deals/1053363", "2026-08-06T15:39:46Z"]
  ]
}
```

`bug_radar.py`'s `hogql()` function zips `columns` with each row in `results` to turn this into a list of dicts — that's the entire adapter layer between PostHog and the LLM prompt.

**A real risk worth knowing, sourced straight from PostHog's own docs:** *"The `/query` endpoint is intended for ad-hoc analytics and embedded use cases. It is not a supported export mechanism... We reserve the right to rate-limit, restrict, or reject queries that look like exports, including without prior notice. Pipelines built on `/query` may break at any time."* Bug Radar is, structurally, exactly the kind of scheduled recurring pipeline this warning is aimed at — it's a small, low-volume one (8 sessions, 25 clusters, a few hundred rows per run), which is a very different shape from a bulk export, but it's worth knowing this endpoint isn't contractually guaranteed to stay open for automated recurring use. If PostHog ever throttles it, the documented alternative for scheduled/recurring pulls is [batch exports](https://posthog.com/docs/cdp/batch-exports), a different, purpose-built mechanism.

### 4.2 A second way to see "what got clicked": the Elements API

Bug Radar currently reads *individual* click events and asks an LLM to spot patterns across them. PostHog separately keeps its own **pre-aggregated** table of every distinct clicked element, queryable directly:

```
GET /api/projects/:project_id/elements/stats/
```

**Sourced.** This returns click counts per unique element (tag, text, CSS classes, href) without needing to re-scan raw events or run an LLM over them — PostHog's own toolbar heatmap "clickmap" is built on this same data. It's a legitimate cheaper alternative (or cross-check) for the macro pass specifically, since macro theme-naming is already just "cluster clicks by (page, element)" — the clustering half of that job might not need custom SQL at all.

**What Bug Radar explicitly does NOT touch, today:** session replay video, console logs, network requests, PostHog's own AI session summaries, PostHog's Error Tracking product (it re-derives "is this a real bug" itself from raw `$exception` events instead), heatmaps, Self-driving.

This was a deliberate decision made earlier in this project (not a limitation) — to avoid PostHog's Vision/session-summary credit costs and to avoid metered LLM API costs, by running our own two-pass pipeline over raw event SQL using a `claude -p` subscription call instead.

---

## Part 5 — The rest of PostHog's toolbox

Everything below exists in PostHog and Bug Radar currently ignores it. For each: what it is, what it needs turned on, and whether it's already on for dreamteam.

### 5.1 Session Replay (the actual video)

**What it is** — a real recording of the browser session, played back like a screen recording, with clicks/scrolls/mouse movement. **Sourced**.

**Status for dreamteam:** **on** — pulled straight from the project's live settings (`session_recording_opt_in: true`). Every `replay_url` Bug Radar generates actually plays back a real recording. One practical catch: **`session_recording_retention_period: 30d`** — replays are only kept 30 days, so "watch this moment" links on older findings will eventually 404 even though the link itself still works.

**What it needs to capture *more*** (each is a separate opt-in toggle, off by default):
- **Console log recording** — captures `console.log/warn/error` from the browser. **Off by default because logs can contain sensitive data.** **Status for dreamteam: confirmed off** (`capture_console_log_opt_in: false`).
- **Network recording** — captures request URLs and, optionally, headers/bodies (with automatic redaction of things like `authorization`, `cookie`, credit card numbers, passwords). **Status for dreamteam: partially on** — basic network timing/URL capture is on (`capture_performance_opt_in: true`), but the richer payload capture (headers/bodies) is **not configured** (`session_recording_network_payload_capture_config: null`), so we'd only ever see *that* a request happened and how long it took, not its response body or status code.

**Scenario:** if console/network recording were turned on, a task like "CSV import repeatedly stalls" could show the actual failed API response instead of us inferring failure purely from repeated dead clicks — turning a *guess* ("the button didn't respond") into a *fact* ("the server returned a 500"). Right now Bug Radar has no visibility into *why* a click did nothing, only *that* it did nothing.

**Something worth flagging, found while checking this:** dreamteam's project has `autocapture_exceptions_opt_in: null` — not explicitly turned on. Bug Radar's whole exception-reading path (`$exception` events, the "Exceptions" count on every session) may be quietly starved of data on the frontend even though the SQL query runs without error (a query for an event nobody's sending just returns zero rows, silently — PostHog even warned about this exact thing as a "taxonomy" mismatch when I tested the query directly). Worth turning this on in Settings → Error Tracking if catching real frontend crashes matters, not just dead/rage clicks.

**The API for replay itself:**

```
GET    /api/projects/:project_id/session_recordings/            # list/filter
GET    /api/projects/:project_id/session_recordings/:id/        # one recording's metadata
GET    /api/projects/:project_id/session_recordings/:id/sharing/          # get/create a public share link
POST   /api/projects/:project_id/session_recordings/:id/sharing/passwords/  # password-protect a share
POST   /api/projects/:project_id/session_recordings/bulk_delete/
```

**Sourced.** The metadata response (list/get) includes duration, interaction and console-log counts, viewed status, and the person it belongs to — **but explicitly does not include the raw recording JSON itself**; PostHog's own docs say the only way to get that is clicking "Export as JSON" in the UI, and there's an open feature request for a proper export API. The `sharing`/`sharing/passwords` endpoints are exactly what this project used earlier when testing whether a session could be safely screenshotted — confirmed then: sharing works, but **password-protecting a share requires the "Access Control" feature**, which dreamteam's plan doesn't have (`access_control: false` in the live project settings, confirmed again just now). That's a real plan limitation, not a bug on our end.

### 5.2 AI Session Summaries (PostHog's own LLM pass)

**What it is**, sourced verbatim: PostHog AI "reads the event stream from a recording – every page view, click, input, scroll, error, and custom event – and produces a human-readable summary... It doesn't watch the video; it analyzes the structured event data."

This is, almost exactly, what Bug Radar's micro-pass already does by hand. The difference: PostHog's version also natively understands rage clicks, dead clicks, and error events as first-class concepts, and can be driven by natural language ("find sessions where users rage-clicked on the pricing page").

**Important limit, sourced:** *"Session summaries are available on PostHog Cloud only... This is separate from PostHog AI (Max)."* It's a paid Cloud feature — using it means leaving our zero-marginal-cost `claude -p` approach and picking up PostHog's own billing for it.

**Scenario:** if we ever wanted a *second opinion* on a session's read, we could compare Bug Radar's own verdict against PostHog AI's native summary of the same session — cheap sanity check, not a replacement, since our schema (task segmentation, `customer_reachable`, outreach drafting) is much more specific than a generic summary.

**This is the most directly useful discovery in this whole review — a real, queryable API most people don't know exists:**

```
GET /api/projects/:project_id/single_session_summaries/
GET /api/projects/:project_id/single_session_summaries/:session_id/
```

**Sourced**, straight from PostHog's own API reference. The list endpoint takes filters that map almost one-to-one onto what Bug Radar's own LLM prompt is trying to figure out by hand:

| Filter | What it does |
|---|---|
| `outcome` | `failure` / `success` / `unknown` — PostHog's own version of Bug Radar's `outcome` field |
| `has_exceptions` | boolean — sessions where a real error occurred |
| `has_visual_confirmation` | boolean |
| `distinct_id`, `session_ids` | scope to one person or a specific set of sessions |
| `date_from`, `date_to` | time window |

There's also a **group** version for summarizing many sessions into one report at once:

```
GET  /api/projects/:project_id/session_group_summaries/
POST /api/projects/:project_id/session_group_summaries/
```

**Why this matters concretely:** if Session Summaries were turned on for dreamteam, `GET .../single_session_summaries/?outcome=failure&has_exceptions=true` would hand back a pre-computed, PostHog-generated list of "sessions where something broke" — the exact same *shape* of output Bug Radar's macro/micro pipeline spends two LLM passes computing from scratch. This wouldn't replace Bug Radar's specific schema (task segmentation, `customer_reachable`, drafted outreach message, evidence timestamps for the "watch this moment" link — none of that exists in PostHog's generic summary), but it could very plausibly replace or shrink the **candidate-session-selection** step: instead of `fetch_candidate_sessions` picking "the 8 worst sessions by raw dead+rage+exception count," it could pull PostHog's own `outcome=failure` list first, which already accounts for more signal than a simple weighted click count. Worth a real experiment, not just a note — this is genuinely one API call away from testing. Requires Session Summaries to be turned on for the project first (Cloud only, per the limit above) and costs whatever PostHog charges for it, separately from our LLM cost.

### 5.3 Find Replays with AI

Natural-language search over replays ("users who dropped off during checkout"), translated into PostHog's own replay filters. **Sourced.** Not something Bug Radar needs — we already query the events table directly with more precision than a natural-language filter could give us — but worth knowing it exists if a non-technical teammate ever wants to browse sessions themselves without touching SQL.

### 5.4 Error Tracking (a real product, not just the raw `$exception` event)

Bug Radar reads raw `$exception` events. PostHog's Error Tracking product sits a layer above that:
- **Groups** similar exceptions into one "issue" (by a fingerprint, or custom rules you define), so 40 occurrences of the same bug show up as 1 issue, not 40 events.
- Shows the **real stack trace** (needs source maps uploaded for minified JS) and surrounding code.
- Tracks issue **status** (Active / Resolved / Suppressed) over time.

**Scenario:** right now, if the same JS error fires 40 times across 40 different sessions, Bug Radar has no way to know that — it only ever looks at 8 sessions per run, in isolation. Error Tracking would catch "this exact bug is affecting everyone," which is a materially different (and often more urgent) signal than "this one session had a rough time." This is arguably the single biggest gap in Bug Radar's current design.

**The API surface:** PostHog's REST API for this product mostly manages *configuration* — how issues get grouped and routed — rather than exposing a plain "list issues" endpoint:

```
GET  /api/projects/:project_id/error_tracking/fingerprints/          # how exceptions get grouped into one issue
GET  /api/projects/:project_id/error_tracking/assignment_rules/      # auto-assign issues to a person/team
GET  /api/projects/:project_id/error_tracking/bypass_rules/          # suppress noisy/unhelpful issues
GET  /api/projects/:project_id/error_tracking/external_references/   # links out to e.g. a Linear/GitHub issue
```

**Sourced**, from PostHog's own API reference — this is real but it's the *settings* layer, not a "give me the current issue list" call. The actual way to **query** issues programmatically (which ones exist, how many occurrences, who's affected) is through the same query surface Bug Radar already uses, via three purpose-built query tools this project already has access to: `query-error-tracking-issues-list` (filter/aggregate issues), `query-error-tracking-issue` (one issue's details and impact), and `query-error-tracking-issue-events` (the actual event samples, stack traces, and **session IDs** behind an issue). That last one is the direct bridge back to Bug Radar's world — it hands back the `$session_id`s affected by a grouped issue, which is exactly the join key Bug Radar already keys everything off.

### 5.5 Heatmaps / Clickmaps / Scrollmaps

Visual overlays showing where on a page people click or how far they scroll, aggregated across many sessions. Needs `enable_heatmaps` turned on (separate from autocapture, though the clickmap variant specifically needs autocapture too). **Status for dreamteam: on** (`heatmaps_opt_in: true`).

This is a different lens from Bug Radar's macro pass — Bug Radar clusters dead/rage clicks by (page, element text) using our own SQL and an LLM to name the theme; a heatmap shows the same underlying signal but as a visual, not a written diagnosis. Not something to build on top of, more a manual cross-check tool.

**The API:**

```
GET /api/projects/:project_id/heatmaps/          # aggregated points for a page
GET /api/projects/:project_id/heatmaps/events/
```

**Sourced.** Query params include `type` (`click` / `rageclick` / `mousemove` / `scrolldepth`), `url_exact` or `url_pattern` to scope to one page, `date_from`/`date_to`, and `aggregation` (`total_count` or `unique_visitors`). The response, per PostHog's own description: for `click`/`rageclick`/`mousemove` it's a list of points — relative x-position, absolute y-position, and a count at that spot; for `scrolldepth` it's cumulative scroll-depth buckets instead of points. Because this already includes `rageclick` as a queryable `type`, it's a second, independent way to get the exact same rage-click-by-page data Bug Radar's macro pass computes with custom SQL — worth comparing outputs once, as a sanity check that our own clustering isn't missing anything this endpoint would catch.

### 5.6 Self-driving (open beta, launched this year)

**Sourced.** The newest, most ambitious thing in this space: "scouts" continuously watch signals (error tracking spikes, replay rage-click clusters, even connected Zendesk/Linear/GitHub issues), cluster them into one "report," have an agent investigate against your actual codebase, and — if it's confident — **open a pull request automatically**. First 3 PRs/month free, then $15/PR.

This is conceptually the most similar thing PostHog sells to what Bug Radar is trying to be, but aimed one step further downstream (auto-fixing code, not just flagging it to a human reviewer) and currently in open beta. Not something to adopt today, but worth watching — if it matures, parts of Bug Radar's macro-clustering job may become redundant with PostHog's own "reports."

---

## Part 6 — Scenario matrix: what to do depending on what's switched on

| If this is... | ...then Bug Radar should | ...instead do this |
|---|---|---|
| Console recording **off** — dreamteam's actual state today | Keep guessing "why" from click patterns alone | If turned on: pull console error lines for the same time window as a dead-click cluster, to confirm vs. guess the cause |
| Network recording **partial** (timing only, no bodies) — dreamteam's actual state today | Infer failure from silence + repeated clicks | If body/payload capture were turned on: check for failed (4xx/5xx) responses in the same window as a "Blocked" task, upgrading inferred severity to confirmed severity |
| Exception autocapture **not explicitly on** — dreamteam's actual state today | Treat the "Exceptions" count as possibly under-counting real frontend errors | Turn on in Settings → Error Tracking, or explicitly note in Settings that this number may not reflect all real crashes |
| A product **doesn't call `identify()`** | People tab has nothing to group by | Fall back to grouping by `person_id` (anonymous but stable per-browser) instead of failing silently |
| A product uses **different person-property names** (e.g. `$email` not `email`) | Query returns nulls silently | Before onboarding a new PostHog project, run the same schema-discovery check we ran for dreamteam (`entity_properties` for `person`) rather than assuming `email`/`name`/`role` exist |
| **Error Tracking** is set up with grouped issues | Bug Radar only sees isolated raw exceptions per session | Cross-reference: if a session's exception matches an Error Tracking issue affecting many users, escalate severity — one session's error, multiplied across everyone, is a different story |
| **AI session summaries** available (Cloud, paid) | Bug Radar's own LLM prompt is the only read on a session | Optionally spot-check Bug Radar's verdict against PostHog's own summary for a sample of sessions, as a sanity/calibration check |
| **Session replay video** on but **no session recording at all** (some projects disable it entirely for privacy) | "Watch this moment" links work | If replay is fully disabled: drop the watch-link feature for that project, evidence becomes text-only |
| Heatmaps **on** — dreamteam's actual state today | Not currently used | Manual cross-check: does the heatmap visually agree with what the macro pass named as a theme? |

---

## Glossary (plain language)

- **Event** — one row: something happened, when, to/by whom, with what details.
- **Autocapture** — PostHog automatically turning clicks/pageviews/etc. into events with no code from the product team.
- **`distinct_id`** — PostHog's internal ID for "whoever this is," anonymous or real.
- **`identify()`** — the moment a product tells PostHog "this browser is actually this real person."
- **Person properties** — facts attached to a real person (email, name, role, plan, whatever the product chose to send).
- **Session (`$session_id`)** — all events from one continuous visit, ends after 30 minutes idle or 24 hours total.
- **Dead click** — a click that changed nothing on the page (PostHog's proxy for "user tried something, nothing happened").
- **Rage click** — 3+ clicks in the same spot within 1 second (PostHog's proxy for frustration).
- **Session Replay** — the actual video-like recording of a session.
- **Error Tracking** — PostHog's product for grouping raw exceptions into deduped "issues" with stack traces.
- **HogQL** — PostHog's SQL dialect for querying the raw events table directly (what Bug Radar uses instead of any PostHog UI).

---

## Sources

- [Sessions](https://posthog.com/docs/data/sessions) — session definition, 30-min/24-hour timeout
- [Identify users](https://posthog.com/docs/getting-started/identify-users) · [How identification works](https://posthog.com/docs/product-analytics/identify#how-identification-works)
- [Anonymous vs identified events](https://posthog.com/docs/data/anonymous-vs-identified-events) — billing difference
- [Autocapture](https://posthog.com/docs/product-analytics/autocapture) — dead clicks, rage clicks, heatmap autocapture
- [Session Replay overview](https://posthog.com/docs/session-replay) · [Console log recording](https://posthog.com/docs/session-replay/console-log-recording) · [Network recording](https://posthog.com/docs/session-replay/network-recording)
- [Summarize sessions with PostHog AI](https://posthog.com/docs/session-replay/session-summaries-ai) · [Find replays with AI](https://posthog.com/docs/session-replay/find-replays-ai)
- [Error Tracking: issues and exceptions](https://posthog.com/docs/error-tracking/issues-and-exceptions) · [Grouping exceptions into issues](https://posthog.com/docs/error-tracking/grouping-issues) · [Stack traces](https://posthog.com/docs/error-tracking/stack-traces)
- [Heatmaps](https://posthog.com/docs/toolbar/heatmaps) · [Heatmaps API reference](https://posthog.com/docs/api/heatmaps)
- [Self-driving](https://posthog.com/docs/self-driving) · [Reports](https://posthog.com/docs/self-driving/reports)
- **API references**: [Query API](https://posthog.com/docs/api/query) · [API queries guide (export-restriction warning)](https://posthog.com/docs/api/queries#query-parameters) · [Persons API](https://posthog.com/docs/api/persons) · [Session recordings API](https://posthog.com/docs/api/session-recordings) · [Use Session Replay over the API](https://posthog.com/docs/session-replay/surfaces/api) · [Single Session Summaries API](https://posthog.com/docs/api/single-session-summaries) · [Session Group Summaries API](https://posthog.com/docs/api/session-group-summaries) · [Error tracking API](https://posthog.com/docs/api/error-tracking) · [Elements API](https://posthog.com/docs/api/elements)
- Bug Radar's own [bug_radar.py](posthog-bug-radar/bug_radar.py), a live schema check against project 253183 confirming `email`/`name`/`role` person properties, and a live project-settings pull (`project-get`) confirming session replay/heatmaps/console/network/exception-capture status (all run in this session)

**Weakest claim remaining:** whether Error Tracking issues are actively reviewed day-to-day for dreamteam (vs. just switched on by default) wasn't checked — the project's `product_intents` show it was set up on day one, same as every other product, which doesn't tell us if anyone looks at it.

**Weakest claims, flagged:** whether console/network recording or heatmaps are currently switched on for dreamteam is *unverified* — I didn't check Settings → Replay/Heatmaps directly, only inferred "probably off" from the fact nobody has mentioned configuring them. Worth a 2-minute look in the PostHog UI if it matters.
