# Tags — Design

## Context

Bug Radar already has **Goals**: a per-owner library of outcomes, auto-created by the pipeline's per-session LLM call or created by hand in Settings, matched onto tasks. This adds **Tags**: a similar per-owner library, but multiple tags per task (not one goal), used to categorize sessions/tasks by theme ("UI Bug", "Integration Bug") for engineering/product to slice by. Reference: the "Goals & tags" section of the `Signularity.dc.html` Claude Design file (project `5f710252-b5a0-4483-bbf1-26f26db08f02`), re-pulled fresh for this feature.

Unlike goals, tags need one capability goals never needed: a human can add or remove an *existing* library tag on an *already-pushed* task, live, from the task panel — not just at pipeline-push time.

## Goals

- The pipeline auto-tags tasks during its normal per-session LLM call, matching existing tags or proposing new ones, same shape as goal matching.
- A human can also create tags by hand in Settings, and manually attach/remove any library tag on any task from the task panel.
- Tags are visible at three points: on each task, aggregated in the session's right-side detail panel, and as a manageable library in Settings.
- Each tag *assignment* is separately marked auto (pipeline) or user (manual) — independent of whether the *tag itself* was auto-created or user-created. Both axes matter for the same reason they matter for goals: provenance.

## Non-goals

- No tag-based filtering/search UI in this pass (not requested; can layer on later since tags are just data on findings).
- No cap on tags per task.
- No cascade-delete of assignments when a tag definition is deleted from Settings — the frontend already has a fallback render path for an unknown tag id (mirrors the `tagChip()` "Unknown" fallback in the design file), so a dangling reference degrades gracefully rather than erroring.

## Data model

New table, mirrors `goals`:

```sql
CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_email TEXT NOT NULL,
  label TEXT NOT NULL,
  color TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'user',
  created_at TEXT DEFAULT (datetime('now'))
);
```

`color` is assigned server-side from a fixed 8-color palette (taken directly from the design file), round-robin by the owner's current tag count at creation time — neither the LLM nor the user picks a hex value:

```js
const TAG_PALETTE = ['#e11d48','#ea580c','#ca8a04','#16a34a','#0891b2','#2563eb','#7c3aed','#db2777'];
```

(The Settings UI still shows a swatch picker per the design, but it picks an *index into this same palette*, not a free color — keeps every tag's color from this one list.)

**Task shape change:** each task inside `micro_findings[].tasks[]` gains a `tags` array, parallel to `goal_id`:

```json
"tags": [{ "tag_id": 7, "assign": "auto" }, { "tag_id": 12, "assign": "user" }]
```

`assign: "auto"` = the pipeline attached it (whether the tag itself is `source: "auto"` or `"user"` — an LLM can match an existing user-made tag automatically, which is the "auto-assigned from a user tag" case from the request). `assign: "user"` = a human attached it by hand from the task panel picker.

## Pipeline changes (`bug_radar.py`)

- New `fetch_tags(worker_url, secret, owner_email)`, same shape as `fetch_goals()`, calling a new `GET /api/pipeline/tags`.
- `SESSION_PROMPT` gains a `tags_context` block (existing tag labels + ids), interpolated the same way `goals_context` is. Instruction to the model: for each task, return zero or more existing `tag_id`s that clearly apply, and/or zero or more `new_tag: {"label": "..."}` proposals for patterns not already covered. Never invent a `tag_id` not in the provided list. Prefer reusing an existing tag over minting a near-duplicate (e.g. don't create "UI Bugs" if "UI Bug" exists).
- Task JSON shape in the LLM's response gains a `tags` field: `[{"tag_id": <id> | null, "new_tag": {"label": "..."} | null}, ...]`, passed through unchanged into the finding object, same as today's `goal_id`/`new_goal` passthrough.

## Worker changes (`worker/src/index.js`)

1. **Migration**: create the `tags` table (same startup-migration pattern as `goals`).
2. **`resolveTags(env, ownerEmail, findings)`**: twin of `resolveGoals`. Walks each task's `tags` array; for any entry with `new_tag` and no `tag_id`, looks up-or-creates a row in `tags` (dedup within the batch by normalized label, same `Map`-based pattern as `resolveGoals`'s `createdThisBatch`), assigns the next palette color, rewrites the entry to `{tag_id, assign: "auto"}`, drops `new_tag`. Entries that already carry a `tag_id` (the LLM matched an existing tag) pass through as `{tag_id, assign: "auto"}` unchanged. Called from both `POST /api/report` and `POST /api/pipeline/report/merge`, same call sites as `resolveGoals` today (chain the two: `resolveTags(env, ownerEmail, await resolveGoals(env, ownerEmail, findings))`).
3. **Settings CRUD**, mirrors the goals routes exactly:
   - `GET /api/tags` (session-authed) — list the owner's tags.
   - `POST /api/tags` (session-authed) — body `{label, color_idx}` (index into `TAG_PALETTE`, validated 0-7), inserts `source: 'user'`.
   - `DELETE /api/tags/:id` (session-authed, ownership-checked) — deletes the tag definition only, no cascade (see Non-goals).
4. **Pipeline-authed read**: `GET /api/pipeline/tags?owner_email=...` (mirrors `/api/pipeline/goals`) — `id, label, color, source`, for `bug_radar.py`'s `fetch_tags()`.
5. **New: live per-task tag mutation** (session-authed), the one genuinely new mechanism this feature needs. Mirrors `mergeMediaIntoTask`'s "find the task by `session_id` + `task_index` in the owner's latest report, patch its JSON in place" pattern — but unlike that fail-soft, pipeline-driven helper, this is a human waiting on the result, so it returns an error rather than silently no-op-ing when the task can't be found:
   - `POST /api/sessions/:sessionId/tasks/:taskIndex/tags` — body `{tag_id}`. Loads the owner's latest report, finds the finding by `session_id` and the task by `task_index`. 404 if either isn't found (report was superseded by a newer pipeline run). 400 if `tag_id` doesn't belong to this owner's library. If the tag is already on the task, no-op (200, not a duplicate entry). Otherwise appends `{tag_id, assign: "user"}` to the task's `tags` array and saves.
   - `DELETE /api/sessions/:sessionId/tasks/:taskIndex/tags/:tagId` — same lookup, removes the matching entry from the task's `tags` array (whatever its `assign` value — a user can remove an auto-assigned tag too, matching the design's remove button on every chip regardless of origin).
   - Both reuse a shared `loadTaskForMutation(env, ownerEmail, sessionId, taskIndex)` helper factored out of the existing `mergeMediaIntoTask` lookup logic, to avoid duplicating the "find report → parse → find finding → find task" block a third time.

## Frontend changes (`worker/public/index.html`)

- **Load**: add `fetch("/api/tags")` alongside the existing `Promise.all` data load in `loadData()`, store as a module-level `TAGS` array (mirrors `GOALS`).
- **Task panel**: render `t.tags` as chips (color from `TAGS.find(x => x.id === tagId)`, "Unknown"/gray fallback if not found) with a remove button per chip calling the new `DELETE .../tags/:tagId` route. A "+ Tag" button opens a picker listing library tags not already on this task (`TAGS` filtered against the task's current `tag_id`s), clicking one calls the new `POST .../tags` route. No "create new tag" option here — matches the design, creation is Settings-only.
- **Session right panel**: new "TAGS" section, computed client-side by reducing over the session's `tasks[].tags` (dedupe by `tag_id`, count occurrences, mark a tag "user"-flavored if any occurrence in this session has `assign: "user"`), matching the design's `sd.tags` aggregation. Empty state: "No tags yet — open a task and add one to categorise this session."
- **Settings**: extend the existing Goals tab into "Goals & tags" (rename the tab label; add a TAGS section below the existing goals list, same tab body). Two subsections, Auto and User, each with chips + remove button + count, plus a "New tag" toggle that opens a label input + 8-swatch color picker (index into `TAG_PALETTE`) + Save, calling `POST /api/tags`. Follows the exact pattern already used for `renderGoalsTab()`'s form toggle.

## Verification

No unit test framework in this codebase — verification is via real calls, matching every prior feature in this project:

1. Migrate schema on the remote D1 database, confirm via `wrangler d1 execute ... --command "PRAGMA table_info(tags)"`.
2. Curl the four settings CRUD routes with a real session cookie; confirm color assignment round-robins across the palette as tags are created.
3. Run `bug_radar.py --session-id <a known session>` against the real dreamteam connection with an empty tag library first (everything should come back as `new_tag`), confirm rows land in D1 with `source: 'auto'` and round-robin colors; run again and confirm at least one task now matches an existing `tag_id` instead of minting a near-duplicate.
4. Curl `POST` and `DELETE` on the live per-task tag route against a real pushed report: confirm a tag attaches with `assign: "user"`, confirm removing an auto-assigned tag works, confirm a bogus `task_index` 404s instead of silently succeeding.
5. Playwright pass: open a task, add a tag from the picker, remove one, confirm the session right-panel TAGS section reflects the change; create a user tag in Settings, confirm it's immediately available in the task picker; delete a tag definition that's still attached to a task, confirm the task's chip falls back to "Unknown" instead of erroring.
