# Bug Radar — product overview for design

Live: https://bug-radar.dreamteam-digest.workers.dev
Status: working prototype, real data, one internal user so far. Backend is solid; UI has never had real design attention — built function-first, one feature at a time, over one long build session. This doc exists to hand off for a real design pass.

## What this is, in one paragraph

Bug Radar watches a product's PostHog analytics events (clicks, dead clicks, rage clicks, errors — never session-replay video) and uses an LLM to figure out what's actually broken, for whom, and whether it's worth proactively messaging the customer about. It runs on a schedule against a live CRM product (dreamteam), finds recurring problem patterns across all users (macro) and specific broken moments in individual sessions (micro), and gives a human reviewer a place to correct the AI's judgment when it gets something wrong — building toward a system that gets more accurate over time from that feedback.

## Why it exists (the actual problem)

Product teams have session replay and analytics tools, but nobody watches most of it. Dead clicks and errors pile up as noise. The handful of things that are (a) genuinely broken and (b) worth telling a customer about get lost in that noise. Bug Radar's job is triage: turn a firehose of click events into a short, trustworthy list of "here's what's actually wrong, here's proof, here's whether we should say something."

## Who uses it

One persona right now: an internal product/eng person reviewing what the AI found, watching the actual moment in PostHog when they want to verify, and correcting the AI when its read of a situation is wrong (e.g. "this looks like a bug because there's no confirmation toast — but that's a known UI gap, not proof the action failed"). This is a working tool for a small, expert audience, not a customer-facing product yet.

## Core design principles already decided (don't relitigate these, design around them)

1. **Events only, never video.** No session-replay screenshots or clips in the default flow (a separate, deliberately deferred feature covers optional screenshot capture — see "Deferred" below). Everything shown is derived from clicks, page views, and error events.
2. **A session is not one story.** A single user session can contain several unrelated things they tried to do (connect an integration, then separately create a deal, then browse a contact). The system segments each session into distinct **tasks**, each independently judged — not one verdict per session.
3. **Extremely conservative about proactive customer outreach.** Most real bugs should NOT trigger a customer-facing message. A task only qualifies if the outcome is unambiguously "blocked" (not "abandoned" — that's often just the user changing their mind), severity is "high," and it's a core/consequential action (an integration failing, an import failing, an AI assistant erroring, a payment failing — not general UI friction). At most **one** outreach message per session, even if multiple tasks qualify.
4. **The AI's own confidence is shown, not hidden.** Macro themes carry a "false positive risk" field — e.g., dead clicks on long AI-generated summary text are flagged as *probably* not a real bug (people click on read-only text expecting it to expand), distinct from dead clicks on a genuinely broken control.
5. **Every finding is falsifiable.** Every task links to the exact second in the real PostHog replay (`?t=` deep link), and a human can correct any of the AI's 4 core judgments (outcome / severity / real-bug / customer-reachable) with a required explanation — building a growing record of "here's context the model didn't have."

## Information architecture (current: 3 tabs)

### 1. Overview — macro themes
Product-wide recurring patterns, computed by clustering dead-click/rage-click events by (page, clicked element) across all sessions in the last 14 days, then named by the LLM. Answers "what's broken for lots of people," not "what happened to one person."

Real example:
```
Title: Import wizard unresponsive step control
Pages: /settings/import, /settings/import/mapping, /settings/import/summary
Confidence: high
Likely cause: A 'Next/Continue' button (or upload control) in the CSV import
  wizard isn't responding, so the same small group of users (4-8) clicks
  repeatedly at each of the three sequential steps.
False-positive risk: Low — three sequential wizard pages all show null element
  text and a consistent 11-16x click-to-user ratio, which points to a
  genuinely stuck control rather than passive reading.
```

Currently a card grid: confidence chip, page chips, one-sentence cause, one-sentence FP-risk note.

### 2. Sessions — the actual findings, drill-down
**Table view**: one row per reviewed session (the 8 sessions per run with the worst dead+rage+exception counts, last 3 days). Columns: session (title of first task + count of others), outreach indicator (dot if a message was recommended), a compressed row of outcome dots (one per task, color-coded), worst severity across tasks, bugs-found ratio ("2/3"), raw dead/rage/exception counts. Filterable by severity, searchable by text.

**Detail view** (click a row): replaces the table with:
- Session id, task count, raw dead/rage/exception counts, link to the full PostHog replay
- **Outreach callout** if one task qualified — shows the drafted customer-facing message, e.g.:
  > "Hey, looks like your CSV import didn't go through — want a hand getting your contacts in?"

  or an honest "nothing here cleared the bar for outreach" note if none did.
- **One card per task**, each with: title, badges (customer-reachable / outcome / severity / real-bug-or-not), goal, narrative (2-3 sentences), evidence (the specific events that back the verdict), a "▶ Watch this moment" link that jumps straight to the right second of the real replay, and a "✎ Correct labels" control.
- **Correction form** (hidden until opened): 4 dropdowns (outcome/severity/real-bug/reachable) pre-filled with current values, a required "why are you changing this" textarea. Only changed fields get recorded. Saves to a real backend now (Cloudflare D1), not local-only.
- **Raw event timeline** at the bottom: every event in the session, chronological, with dead-clicks/rage-clicks/exceptions visually distinguished (colored) from routine navigation (dimmed) — the literal ground truth the AI verdict was built from.

Real example task (one of three in a single session):
```
Goal: Review "My Day" AI-generated task cards (meeting prep notes, deal summaries)
Outcome: abandoned | Severity: medium | Real bug: true | Customer reachable: false
Title: Extensive dead clicking on My Day AI insight cards
Narrative: On /myday, the user repeatedly clicked on multiple AI-generated
  insight snippets (firmographic signals, prep questions, deal notes) expecting
  interaction, but none responded. They eventually clicked 'Close', then gave
  up on the card interactions with more dead clicks before closing again.
Evidence: 17+ $dead_click events on non-interactive text elements across
  /myday between 15:56:31 and 15:57:06, interspersed with 'Close' clicks
```

### 3. Settings — transparency + audit
- **Pipeline config**: what's running, on what schedule, what data source (a small key-value grid).
- **The exact prompts**, verbatim, pulled live from the running script — not a paraphrase. Two blocks: macro theme-naming prompt, micro per-session prompt.
- **Context corrections log**: every correction ever made, newest first — timestamp, session, field changed (from → to), the human's reasoning, which task it was on. Export-as-JSON button.

## Data model (what design has to represent)

A **finding** (one row in Sessions) = one session:
- `session_id`, `replay_url`, `triage_counts` (dead/rage/exception counts — the cheap pre-filter signal)
- `tasks[]` — 1 to ~7 per session, each: `goal`, `outcome` (completed/abandoned/blocked/unresolved), `real_bug` (bool), `severity` (high/medium/low/none), `customer_reachable` (bool), `title`, `narrative`, `evidence`, `key_timestamp`
- `recommended_outreach` — null, or `{task_index, message}`
- `events[]` — the full raw ordered event stream for the timeline (event type, page, clicked element text, timestamp)

A **macro theme** = `title`, `pages[]`, `likely_cause`, `confidence` (high/medium/low), `false_positive_risk`

A **correction** = `session_id`, `task_index`, `task_title`, `task_goal`, `field`, `from`, `to`, `reason`, `timestamp`

## Current visual system (context, not a constraint — redesign freely)

Token-based, light/dark aware. Warm-paper light theme (`#f4f2ed` ground) / deep ink-teal dark theme (`#0f1613`), a burnt-copper accent (`#b8632a` light / `#d98a4a` dark) chosen deliberately to avoid the generic AI-tool palette (cream+terracotta, near-black+neon). Display/body text on system sans stacks, monospace for anything numeric or data-like (counts, timestamps, session IDs, element text quotes) — leaning into an "instrumentation readout" feel since the subject is literally structured event data. Severity/outcome/confidence all use small color-coded chips/dots, kept visually distinct from the accent color (semantic color ≠ brand color).

Known weak points, worth a real design pass:
- The sessions table is dense — 7 columns, small dot-clusters for per-task outcomes that are hard to parse at a glance.
- The correction form is a lot of UI (4 selects + textarea) crammed inline into a task card; feels like an afterthought bolted onto a display card, not a first-class interaction.
- No visual hierarchy yet for "this session needs your attention" vs "this one's fine" — everything reads at roughly the same visual weight in the table.
- The outreach callout (arguably the most important single piece of output — the actual customer-facing message) doesn't visually dominate the page the way its importance would justify.

## What's built vs. deferred (don't design for the deferred parts as if they exist)

**Built and live**: everything above. Real backend (Cloudflare Worker + D1), real API, pipeline runs locally on a schedule and pushes results up.

**Deferred, explicitly parked** (see `SCREENSHOT_CAPTURE_PLAN.md`): optional screenshot capture for qualifying tasks, via PostHog's Sharing API + headless browser, only for high-severity real bugs or customer-reachable tasks, share link kept live only seconds. Not built — don't design a UI element assuming screenshots exist yet, though a placeholder/future-state treatment is fair game if flagged as such.

**Not yet built**: corrections don't feed back into the LLM prompts yet — logged for audit only, not yet closing the loop. Real-time/live proactive outreach (the original vision — messaging a customer at the moment of frustration) is not implemented; this is a scheduled, retrospective batch pipeline today, not a live trigger system.
