# Screenshot capture for Captured Moments

## Context
The session-detail UI already has a "Captured Moments" placeholder (built earlier) that reads `t.media` on each task and renders thumbnails, but nothing populates it. We researched whether a screenshot of a flagged moment can be produced without a browser rendering engine, confirmed it can't (rrweb only serializes DOM, it never paints pixels; every real solution, PostHog's own OG-image pipeline included, uses a headless browser). Decided: self-hosted headless browser (Playwright), no paid third-party rendering API. This spec covers producing and storing that screenshot.

## Scope
Capture one screenshot per task, only for tasks that come back **blocked or high-severity**, at the exact moment already identified by the LLM verdict (`key_timestamp`).

## Execution model: GitHub Actions, not the local machine
Decided against running Playwright directly inside `bug_radar.py` (needs a laptop or a self-maintained always-on machine) and against Cloudflare Browser Run (free tier is ~5 browser-hours/month, real but small). GitHub Actions gives 2,000 free minutes/month on a private repo, unlimited on a public one, 20 concurrent jobs, zero infrastructure to maintain, real horizontal scale for free.

**This repo isn't on GitHub yet.** Decided: **public**, on the user's **personal GitHub account** (not a DreamTeam org account), unlimited free Actions minutes.

Because a job takes time to spin up and run, capture becomes **asynchronous**, decoupled from the pipeline run that produced the finding. The report gets pushed by `bug_radar.py` as it does today, with an empty `media` array; the screenshot lands afterward and gets merged in.

## Pipeline (per qualifying task)
1. `bug_radar.py`, after a task's verdict, calls GitHub's `workflow_dispatch` API with only non-secret identifiers as inputs: `session_id`, `key_timestamp`, `connection_id`, a stable task reference (session_id + task index) to merge the result back later. No PostHog key or other secret goes through GitHub's inputs/logs.
2. The Actions workflow (`.github/workflows/capture-screenshot.yml`) runs on a fresh runner: authenticates to our Worker with its own GitHub-Actions-scoped secret, fetches the connection's decrypted PostHog key from `/api/pipeline/connections/{id}` (same route the pipeline already uses), then fetches the rrweb snapshot manifest and only the blob chunks covering up to `key_timestamp`.
3. Gzip-decompresses the chunks, concatenates into one ordered rrweb event array.
4. A vendored `rrweb-player` bundle (checked into the repo, no CDN, no Node build step) loads that array in a static HTML shell; `playwright install chromium` runs fresh each job (small time cost, no persistent state to maintain), seeks to `key_timestamp`, `page.screenshot()`s it.
5. POSTs the PNG to a new Worker route using its GitHub-Actions-scoped secret.
6. The Worker writes it to R2, then finds the matching report/task by `session_id` + task index and merges the new `media` entry into it, same "find latest report, merge by session_id" pattern already built for `--session-id` runs, extended to merge at the task level.

## Failure handling
Wrap capture in try/except inside the Action; a failure just means that task's `media` array stays empty, it never touches the bug verdict, which already landed separately and earlier. Still rests on an undocumented PostHog endpoint, expect occasional failures as normal, not a bug in our code.

## New pieces
- **New GitHub repo** for this project (currently only local), public or private per the decision above.
- **`.github/workflows/capture-screenshot.yml`**: Playwright install, vendored `rrweb-player`, the capture script.
- **Worker**: an R2 bucket binding, `POST /api/pipeline/media` (service-authed via a GitHub-Actions-scoped secret) to accept the PNG, store it, and merge it into the right task's `media` array; `GET /api/media/:key` to serve it back out (session-authed, consistent with the rest of the app).
- **`bug_radar.py`**: a small addition to call `workflow_dispatch` for each qualifying task instead of doing the capture itself.
- **Data model**: no schema change, `media` already lives inside each task's JSON in `micro_findings`, same as `goal_id`/`new_goal`.

## Verification
- Trigger the workflow manually once against a real blocked/high-severity task, confirm a real PNG lands in R2 and merges into the right task.
- Confirm the Captured Moments section on that task renders a real thumbnail after the Action completes, not immediately after the pipeline run (that's expected, it's async now).
- Confirm a deliberately-broken capture (bad session id) leaves `media` empty without touching the task's verdict.
