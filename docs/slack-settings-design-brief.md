# Slack Settings Tab — Design Brief for Claude Design

**Purpose of this doc:** hand-off brief for producing UI/UX mockups (not final spec, not implementation plan). Written so a designer with zero context on this product can execute without guessing.

---

## 1. What this product is (context for the designer)

Singularity (working repo name: Bug Radar) watches a customer's PostHog analytics and, in future, Last9 observability data. It turns raw signal (clicks, errors, traces) into judged findings: is this a real bug, how severe, is it worth telling the customer about. Each finding is a **task**, and every task carries a fixed set of judgments:

| Field | Values |
|---|---|
| `outcome` | completed / abandoned / blocked / unresolved |
| `severity` | high / medium / low / none |
| `real_bug` | true / false |
| `customer_reachable` | true / false |
| `goal` | one of an open, growing list the pipeline maintains (e.g. "Connect Slack workspace") |
| `tags` | zero or more from an open, growing list (e.g. "Integration Bug", "UI Bug") |

Today a human reviews tasks in a web dashboard. This project adds **Slack as a second surface**: instead of someone having to check a dashboard, the right task reaches the right Slack channel (and sometimes the right person) automatically, the moment it's confirmed.

This tab is where a user connects their Slack workspace and defines the rules that decide what goes where.

---

## 2. Where this lives

A new tab in **Settings**, alongside the existing tabs: Connections, Company knowledge, Pipeline & model, Goals & tags. Same tab-strip pattern, same visual system as the rest of the app (reuse existing typography, color tokens, card/panel styles, chip styles already established there, don't invent a new visual language for this one tab).

Tab label: **Slack**

---

## 3. The two jobs this tab does

1. **Connect** — OAuth into a Slack workspace, one workspace per account.
2. **Route** — define rules that decide which confirmed tasks get posted to which channel, and whether a specific person also gets DM'd.

These are sequential: routing rules can't be built until a workspace is connected. Design both states.

---

## 4. Screen A — Not connected (empty state)

First thing a user sees when they open the tab and no Slack workspace is linked yet.

**Must communicate, in plain language, before asking them to connect:**
- What connecting actually does ("confirmed bugs get posted to the Slack channels you choose, instead of sitting in a dashboard")
- What permissions are being requested and why, phrased in outcomes not scope-names: e.g. "post messages as Singularity", "see your channel list so you can pick one", "look up who's in a channel so we can DM the right person". Do not just show raw Slack OAuth scope strings like `chat:write` without a plain-English line next to each.
- That nothing is read from Slack itself — this app only ever posts, it doesn't read messages. Say this explicitly; it's a trust point worth stating even if not asked.

**Primary action:** a real "Add to Slack" button, following Slack's own brand button (the standard black "Add to Slack" badge, not a custom-styled button, Slack's brand guidelines require using their official button asset or exact spec).

**No workspace-picker needed in this app** — one Slack workspace per Singularity account. If the designer needs a reason: this keeps the mental model simple (this account's bugs go to this one Slack, not a multi-tenant routing mess).

---

## 5. Screen B — Connected, workspace header

Once connected, a persistent small header/card at the top of the tab, always visible above the rules list:

- Slack workspace icon + name (e.g. "Acme Inc" with the little Slack workspace avatar)
- Connected as: which Slack user authorized it, and when
- Two actions: **Reconnect** (re-run OAuth, e.g. if scopes changed or token expired) and **Disconnect**
- Disconnect needs a confirmation step (this is a meaningfully destructive action — it will stop all routing). On disconnect: existing rules are **kept, not deleted**, but shown greyed out / inactive with a banner: "Slack disconnected. Reconnect to reactivate your rules." Never silently delete a user's rule configuration.

---

## 6. Screen C — Rules list

The main view once connected. This is a list, not a form, most of the time.

**Empty sub-state** (connected, zero rules yet): explicit, honest empty state — "No rules yet. Nothing is being sent to Slack until you add one." (Matches this app's existing convention of never implying data exists when it doesn't — see how other empty tabs in this app are worded.) Primary CTA: **New rule**.

**Each rule, once rules exist, renders as a card/row with:**
- Rule name (user-given label, e.g. "Payments escalations")
- A human-readable summary of its conditions, built from the actual selections, not a raw filter string. Example: *"Severity: High or Medium · Real bug: Yes · Tag: Integration Bug"* — omit any dimension left as "any" from the summary entirely, don't show "Outcome: any."
- Destination: the channel (with Slack's `#` icon + channel name), plus a small icon/label if "also DM owner" is on
- An enabled/disabled toggle (a rule can be paused without deleting it)
- Edit and delete affordances
- **Orphaned-rule state:** if a rule references a goal or tag that no longer exists (it was deleted elsewhere in the app), show a visible warning badge on the card, e.g. "⚠ References a deleted tag" — never let a rule silently stop matching with no visible reason.

**A small persistent explainer near the top of the list** (tooltip, info icon, or a single line of muted text — designer's call on the exact treatment, but it must be visible, not hidden in docs): *"If a task matches more than one rule, it's sent to every matching channel."* This is non-obvious behavior and needs to be stated in-product.

**Primary action:** **New rule** button, always reachable from this list.

---

## 7. Screen D — Rule builder (create/edit, same screen for both)

Likely a modal or a full-screen panel, consistent with how this app already handles create/edit flows elsewhere (match existing pattern, don't invent a new one).

### 7.1 Name
A single text field. Required. This is what shows on the rule card.

### 7.2 Conditions

Five independent condition groups. Within a group, multiple selections are OR'd ("severity is high or medium"). Across groups, it's AND (severity condition AND real-bug condition AND tag condition all have to hold). Leaving a group untouched means "any" — it doesn't narrow the rule at all.

- **Outcome** — multi-select chips: Completed, Abandoned, Blocked, Unresolved. None selected = any.
- **Severity** — multi-select chips: High, Medium, Low, None. None selected = any.
- **Real bug** — three-way choice: Yes / No / Either. Default: Either.
- **Customer reachable** — three-way choice: Yes / No / Either. Default: Either.
- **Goals** — a live-search, multi-select picker against the account's real goal list (this list grows over time as the pipeline runs, so it must be a search-as-you-type field pulling live data, not a static dropdown baked into the design). Selected goals show as removable chips. None selected = any.
- **Tags** — same pattern as Goals: live search, multi-select, removable chips, reuse this app's existing tag-chip visual style (including each tag's actual color) so a tag looks the same here as it does everywhere else in the app. None selected = any.

Design these five as visually equal-weight, parallel sections, not a hierarchy, none of the five is "more important" than the others structurally, even though in practice severity/real-bug will be used most often.

### 7.3 Destination
- **Channel** — a searchable picker listing the connected workspace's real channels (requires reading the channel list from Slack). Single-select for v1 (one rule posts to one channel; if the same conditions need two channels, that's two rules — keep this simple, don't build multi-channel-per-rule in v1).
- **Also DM the code owner** — a toggle. When on, show a short explanatory line: "Also sends a direct message to whoever last touched the relevant code, when we can determine that." Design this toggle now even if the owner-detection logic isn't built yet, it's meant to compose with a future capability, so the UI shouldn't need to change when that ships.

### 7.4 Dry run (build this, it matters)
Before saving, show: **"This rule would have matched N of the last 50 tasks."** Below it, a short preview list (task title + severity + when) of the actual matches, so the person building the rule can sanity-check it before it goes live, not after it's already spammed a channel. If N is 0, don't treat that as an error, some rules are intentionally narrow, but do make the zero-match state visually distinct (e.g. muted, with a small note like "No recent matches, that's fine if this rule is meant to be rare") so it doesn't read as broken.

### 7.5 Save / Cancel
Standard. Saving activates the rule immediately (there's no separate "publish" step, matches the rest of this app's save-immediately convention).

---

## 8. Full list of states the designer needs to cover

1. Not connected to Slack (Screen A)
2. Connected, zero rules (Screen C empty sub-state)
3. Connected, rules exist, all healthy
4. Connected, a rule is orphaned (references a deleted goal/tag)
5. Connected, a rule is manually disabled (toggled off, not deleted)
6. Disconnected after having rules (rules greyed out, banner shown, nothing deleted)
7. Rule builder: fresh/new rule (all fields empty/default)
8. Rule builder: editing an existing rule (fields pre-filled)
9. Rule builder: dry run with matches
10. Rule builder: dry run with zero matches
11. Reconnect flow (re-running OAuth on an already-connected account)

---

## 9. Explicitly out of scope for this design pass

Say no to scope creep here even if it seems related:
- No message-template editor. The Slack message format (the Block Kit card, buttons, thread structure) is a fixed system template for v1, not user-customizable.
- No owner/CODEOWNERS mapping UI. The "also DM owner" toggle exists, but the screen that defines *how* ownership is determined is a separate, future piece of work.
- No multi-workspace support. One Slack workspace per account.
- No per-rule schedule/quiet-hours. All rules are always-on for v1.

---

## 10. Tone and visual notes

- Copy voice: plain, direct, no corporate jargon, e.g. "Nothing is being sent to Slack until you add one," not "No routing configurations have been provisioned." Match the plain-spoken tone already used elsewhere in this app's copy.
- Reuse, don't reinvent: tab navigation, chip components, toggle switches, empty-state pattern, and the tag color system are all already established elsewhere in this app (Goals & tags tab, Connections tab). This new tab should feel like it was always part of the app, not a bolted-on module.
- Every state that can be empty, broken, or partial (rules list, dry run, orphaned rule) must be designed explicitly. This app has a consistent habit of never showing a fake/implied state, extend that habit here.
