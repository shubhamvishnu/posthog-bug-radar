# Screenshot Capture for Captured Moments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Populate the already-built "Captured Moments" UI with a real screenshot of the exact flagged moment in a blocked/high-severity task, rendered by a self-hosted headless browser running for free on GitHub Actions.

**Architecture:** `bug_radar.py` triggers a GitHub Actions `workflow_dispatch` run per qualifying task instead of doing any rendering itself. The Action fetches PostHog's raw rrweb snapshot data for that session (already confirmed reachable this session via an undocumented blob endpoint), decompresses and reassembles it, replays it through a vendored `rrweb-player` bundle inside Playwright, screenshots the exact flagged timestamp, and posts the PNG to a new Worker route. That route stores it in R2 and merges the resulting URL into the right task's `media` array on whatever report is currently latest, asynchronously, since the Action takes longer to run than the pipeline itself.

**Tech Stack:** Python (`bug_radar.py`, new `capture_screenshot.py`), Playwright for Python, GitHub Actions (`workflow_dispatch`), Cloudflare Workers + R2, vanilla JS frontend (existing `worker/public/index.html`).

**Spec:** [docs/superpowers/specs/2026-08-13-screenshot-capture-design.md](../specs/2026-08-13-screenshot-capture-design.md)

## Global Constraints
- Capture only for tasks with `outcome == "blocked"` or `severity == "high"`. Never every task.
- No secrets (PostHog keys, `BUGRADAR_API_SECRET`) ever appear in GitHub Actions workflow inputs or logs. Inputs are non-secret identifiers only (`session_id`, `key_timestamp`, `connection_id`, `owner_email`, `task_index`); the secret is a GitHub repo secret the workflow reads directly, never passed as an input.
- A capture failure must never fail or block the task's actual bug verdict, which is already saved separately and earlier. Always fail soft: log and skip.
- `report.json`, `venv/`, and `__pycache__/` must never be committed, this repo is going public.
- This codebase has no unit test framework anywhere (confirmed: no test files, no pytest/vitest config). Its established verification pattern, used consistently all session, is real calls against the live system: curl, `wrangler d1 execute`, and Playwright-driven browser checks, not synthetic unit tests. This plan follows that existing pattern rather than introducing a new one.
- Reuse `env.BUGRADAR_API_SECRET` as the GitHub Actions secret too (stored in two places: macOS Keychain for local runs, a GitHub repo secret for the Action). Do not build a second auth tier, no other part of this system has one and one secret is enough for a single-maintainer project.

---

## Task 1: Stand up the public GitHub repo (personal account)

**Files:**
- Create: `/Users/shubhamkhandelwal/posthog-bug-radar/.gitignore`

**Interfaces:** none (infrastructure only).

- [ ] **Step 1: Confirm/switch `gh` CLI to the personal account**

`gh` is currently authenticated as `shubham-dreamteam` (checked: `gh auth status`). That's the wrong account for this repo. This step needs the user, it's an interactive browser login, not scriptable:

```bash
gh auth login
```

Choose GitHub.com, HTTPS, and log in with the **personal** account when prompted. Confirm afterward:

```bash
gh auth status
```

Expected: the active account is the personal one, not `shubham-dreamteam`.

- [ ] **Step 2: Write `.gitignore`**

```
venv/
__pycache__/
*.pyc
report.json
.DS_Store
node_modules/
```

- [ ] **Step 3: Initialize the repo and make the first commit**

```bash
cd /Users/shubhamkhandelwal/posthog-bug-radar
git init
git add .gitignore POSTHOG_GUIDE.md PRODUCT_OVERVIEW.md SCREENSHOT_CAPTURE_PLAN.md bug_radar.py requirements.txt worker docs
git status
```

Read the `git status` output carefully before committing, confirm `report.json`, `venv/`, and `__pycache__/` do **not** appear in the staged list. If any of them show up, the `.gitignore` is wrong, fix it before proceeding.

```bash
git commit -m "Initial commit: Bug Radar multi-tenant PostHog bug-detection pipeline"
```

- [ ] **Step 4: Create the public GitHub repo under the personal account and push**

```bash
gh repo create posthog-bug-radar --public --source=. --remote=origin --push
```

- [ ] **Step 5: Verify**

```bash
gh repo view --web
```

Confirm in the browser: the repo is public, owned by the personal account, `report.json` is not present in the file listing.

- [ ] **Step 6: Add the pipeline secret as a GitHub repo secret**

Pulls the existing local secret into a shell variable and sends it straight to GitHub, never echoed, matching this project's established secret-handling rule.

```bash
security find-generic-password -s "BUGRADAR_API_SECRET" -w | gh secret set BUGRADAR_API_SECRET --repo <personal-account>/posthog-bug-radar
gh secret list --repo <personal-account>/posthog-bug-radar
```

Expected: `BUGRADAR_API_SECRET` appears in the secret list (value never shown, that's correct).

---

## Task 2: R2 bucket + Worker route to store and merge a screenshot

**Files:**
- Modify: `worker/wrangler.jsonc`
- Modify: `worker/src/index.js`

**Interfaces:**
- Consumes: `pipelineAuthed(request, env)` (existing, `worker/src/index.js:429`), `env.BUGRADAR_API_SECRET`.
- Produces: `POST /api/pipeline/media` — accepts a PNG body plus `session_id`, `task_index`, `owner_email`, `ts` as query params; returns `{ ok: true, url }` or `{ error }`.

- [ ] **Step 1: Create the R2 bucket**

```bash
cd /Users/shubhamkhandelwal/posthog-bug-radar/worker
npx wrangler r2 bucket create bug-radar-media
```

- [ ] **Step 2: Bind it in `wrangler.jsonc`**

Add alongside the existing `d1_databases` array:

```json
  "r2_buckets": [
    {
      "binding": "MEDIA",
      "bucket_name": "bug-radar-media"
    }
  ],
```

- [ ] **Step 3: Add the merge-into-task helper and the route**

In `worker/src/index.js`, right after the existing `resolveGoals` function (`worker/src/index.js:286-310`), add:

```javascript
// Best-effort: finds the task by session_id + task_index in whatever report is
// currently latest for this owner, and appends a media entry to it. If that
// session/task isn't in the latest report anymore (a newer run replaced it),
// this is a no-op, not an error, the screenshot is simply dropped, matching
// this feature's fail-soft design.
async function mergeMediaIntoTask(env, ownerEmail, sessionId, taskIndex, mediaEntry) {
  const base = await env.DB.prepare("SELECT * FROM reports WHERE owner_email = ? ORDER BY id DESC LIMIT 1").bind(ownerEmail).first();
  if (!base) return false;
  const micro = JSON.parse(base.micro_findings);
  const finding = micro.find(f => f.session_id === sessionId);
  const task = finding && finding.tasks && finding.tasks[taskIndex];
  if (!task) return false;
  task.media = task.media || [];
  task.media.push(mediaEntry);
  await env.DB.prepare(
    `INSERT INTO reports (generated_at, macro_themes, micro_findings, theme_prompt, session_prompt, owner_email, connection_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    new Date().toISOString(),
    base.macro_themes,
    JSON.stringify(micro),
    base.theme_prompt,
    base.session_prompt,
    ownerEmail,
    base.connection_id
  ).run();
  return true;
}
```

Then, alongside the other `/api/pipeline/*` routes (near `worker/src/index.js:479`), add:

```javascript
if (pathname === "/api/pipeline/media" && request.method === "POST") {
  if (!pipelineAuthed(request, env)) return json({ error: "unauthorized" }, 401);
  const sessionId = url.searchParams.get("session_id");
  const taskIndex = Number(url.searchParams.get("task_index"));
  const ownerEmail = url.searchParams.get("owner_email");
  const ts = url.searchParams.get("ts") || "";
  if (!sessionId || Number.isNaN(taskIndex) || !ownerEmail) {
    return json({ error: "session_id, task_index, owner_email required" }, 400);
  }
  const bytes = await request.arrayBuffer();
  if (!bytes.byteLength) return json({ error: "empty body" }, 400);
  const key = `media/${sessionId}/${taskIndex}/${crypto.randomUUID()}.png`;
  await env.MEDIA.put(key, bytes, { httpMetadata: { contentType: "image/png" } });
  const merged = await mergeMediaIntoTask(env, ownerEmail, sessionId, taskIndex, { ts, isImg: true, url: `/api/media/${key}` });
  return json({ ok: true, url: `/api/media/${key}`, merged });
}
```

- [ ] **Step 4: Add the serving route**

Right after the route above:

```javascript
const mediaMatch = pathname.match(/^\/api\/media\/(.+)$/);
if (mediaMatch && request.method === "GET") {
  const email = await getSessionEmail(request, env);
  if (!email) return json({ error: "not authenticated" }, 401);
  const obj = await env.MEDIA.get(mediaMatch[1]);
  if (!obj) return json({ error: "not found" }, 404);
  return new Response(obj.body, { headers: { "content-type": obj.httpMetadata?.contentType || "image/png" } });
}
```

- [ ] **Step 5: Syntax check and deploy**

```bash
cd /Users/shubhamkhandelwal/posthog-bug-radar/worker
cp src/index.js /tmp/_check_media.mjs && node --check /tmp/_check_media.mjs && echo OK
npx wrangler deploy
```

- [ ] **Step 6: Verify with a real upload**

```bash
SECRET=$(security find-generic-password -s "BUGRADAR_API_SECRET" -w)
curl -s -o /tmp/dot.png -w '' 2>/dev/null
python3 -c "
import struct, zlib
def png():
    sig = b'\x89PNG\r\n\x1a\n'
    def chunk(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t+d))
    ihdr = struct.pack('>IIBBBBB', 1, 1, 8, 2, 0, 0, 0)
    idat = zlib.compress(b'\x00\xff\x00\x00')
    return sig + chunk(b'IHDR', ihdr) + chunk(b'IDAT', idat) + chunk(b'IEND', b'')
open('/tmp/dot.png','wb').write(png())
"
curl -s -X POST "https://bug-radar.shubhamvishnu.workers.dev/api/pipeline/media?session_id=test-session&task_index=0&owner_email=shubhamvishnu@gmail.com&ts=00:00:00" \
  -H "Authorization: Bearer $SECRET" \
  --data-binary @/tmp/dot.png
rm /tmp/dot.png
```

Expected: `{"ok":true,"url":"/api/media/...","merged":false}` (`merged:false` is correct here, `test-session` doesn't exist in any real report, confirming the fail-soft path works without corrupting real data).

---

## Task 3: Frontend renders the real thumbnail

**Files:**
- Modify: `worker/public/index.html:1120-1137` (`renderCapturedMoments`)

**Interfaces:**
- Consumes: `t.media[].url` (new field, added by Task 2's merge), `t.media[].ts`, `t.media[].isVid`, `t.media[].dur` (all pre-existing shape).

- [ ] **Step 1: Replace the placeholder div with a real image**

In `renderCapturedMoments` (`worker/public/index.html:1125-1131`), change:

```javascript
  const grid = media.map((m, mi) => `
    <div class="moment-tile">
      <div class="moment-ph"></div>
      <div class="moment-fade"></div>
      <span class="moment-ts">${escapeHtml(m.ts || "")}</span>
      ${m.isVid ? `<span class="moment-dur">${escapeHtml(m.dur || "")}</span><button class="moment-play" data-act="moment-open" data-task="${ti}" data-media="${mi}" title="Play clip">${ICON_PLAY_FILL}</button>` : ""}
    </div>`).join("");
```

to:

```javascript
  const grid = media.map((m, mi) => `
    <div class="moment-tile">
      ${m.url ? `<img src="${escapeHtml(m.url)}" alt="Captured moment" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"/>` : `<div class="moment-ph"></div>`}
      <div class="moment-fade"></div>
      <span class="moment-ts">${escapeHtml(m.ts || "")}</span>
      ${m.isVid ? `<span class="moment-dur">${escapeHtml(m.dur || "")}</span><button class="moment-play" data-act="moment-open" data-task="${ti}" data-media="${mi}" title="Play clip">${ICON_PLAY_FILL}</button>` : ""}
    </div>`).join("");
```

- [ ] **Step 2: Syntax check and deploy**

```bash
cd /Users/shubhamkhandelwal/posthog-bug-radar/worker
node -e "
const fs = require('fs');
const html = fs.readFileSync('public/index.html', 'utf8');
const m = html.match(/<script>([\s\S]*)<\/script>/);
fs.writeFileSync('/tmp/_check_thumb.js', m[1]);
"
node --check /tmp/_check_thumb.js && echo OK
npx wrangler deploy
```

- [ ] **Step 3: Verify**

Leave this unverified visually until Task 8's end-to-end run produces a real `media` entry to look at, there's nothing to see yet. Confirm only that the deploy succeeded and the JS still parses.

---

## Task 4: Vendor the rrweb-player bundle

**Files:**
- Create: `/Users/shubhamkhandelwal/posthog-bug-radar/vendor/rrweb-player.min.js`
- Create: `/Users/shubhamkhandelwal/posthog-bug-radar/vendor/rrweb-player.min.css`

**Interfaces:**
- Produces: two static files Task 5's HTML shell loads via `file://`.

- [ ] **Step 1: Fetch the prebuilt bundle**

```bash
mkdir -p /Users/shubhamkhandelwal/posthog-bug-radar/vendor
curl -sL https://unpkg.com/rrweb-player@latest/dist/index.js -o /Users/shubhamkhandelwal/posthog-bug-radar/vendor/rrweb-player.min.js
curl -sL https://unpkg.com/rrweb-player@latest/dist/style.css -o /Users/shubhamkhandelwal/posthog-bug-radar/vendor/rrweb-player.min.css
```

- [ ] **Step 2: Verify**

```bash
ls -la /Users/shubhamkhandelwal/posthog-bug-radar/vendor/
head -c 200 /Users/shubhamkhandelwal/posthog-bug-radar/vendor/rrweb-player.min.js
```

Expected: both files non-empty (the JS bundle is normally several hundred KB), the head shows minified JS, not an HTML error page (if it's HTML, the unpkg path is wrong, check the package's actual dist filename on https://unpkg.com/rrweb-player/ and adjust).

- [ ] **Step 3: Commit**

```bash
cd /Users/shubhamkhandelwal/posthog-bug-radar
git add vendor/
git commit -m "Vendor rrweb-player bundle for headless screenshot capture"
git push
```

---

## Task 5: `capture_screenshot.py` — fetch, decompress, render, screenshot, upload

**Files:**
- Create: `/Users/shubhamkhandelwal/posthog-bug-radar/capture_screenshot.py`
- Modify: `/Users/shubhamkhandelwal/posthog-bug-radar/requirements.txt`

**Interfaces:**
- Consumes: `GET /api/pipeline/connections/{id}` (existing, returns `api_key`, `region`, `project_id`), `PH_HOSTS` region mapping (same pattern as `bug_radar.py`).
- Produces: a standalone script invoked as `python3 capture_screenshot.py --session-id ID --key-timestamp TS --connection-id N --owner-email E --task-index I --worker-url URL`, exit code 0 on success, non-zero on failure (never crashes the caller, this only runs inside the isolated GitHub Actions job).

- [ ] **Step 1: Add `playwright` to requirements**

```
requests>=2.31
playwright>=1.45
```

- [ ] **Step 2: Write the script**

```python
#!/usr/bin/env python3
"""
Fetches PostHog's raw rrweb snapshot data for one session, renders it through
a vendored rrweb-player inside headless Chromium, screenshots the exact
flagged moment, and uploads the PNG to the Worker. Runs inside a GitHub
Actions job (see .github/workflows/capture-screenshot.yml), never on a
developer's machine, and never blocks or fails the pipeline that identified
the task, failures here are logged and swallowed by the caller.
"""
import argparse
import base64
import gzip
import json
import os
import sys

import requests
from playwright.sync_api import sync_playwright

PH_HOSTS = {"us": "https://us.posthog.com", "eu": "https://eu.posthog.com"}


def fetch_connection(worker_url, secret, connection_id):
    resp = requests.get(
        f"{worker_url}/api/pipeline/connections/{connection_id}",
        headers={"Authorization": f"Bearer {secret}"}, timeout=30,
    )
    resp.raise_for_status()
    return resp.json()


def fetch_snapshot_manifest(host, project_id, api_key, session_id):
    resp = requests.get(
        f"{host}/api/projects/{project_id}/session_recordings/{session_id}/snapshots",
        headers={"Authorization": f"Bearer {api_key}"}, timeout=30,
    )
    resp.raise_for_status()
    return resp.json().get("sources", [])


def fetch_blob(host, project_id, api_key, session_id, blob_key):
    resp = requests.get(
        f"{host}/api/projects/{project_id}/session_recordings/{session_id}/snapshots",
        params={"source": "blob_v2", "start_blob_key": blob_key, "end_blob_key": blob_key},
        headers={"Authorization": f"Bearer {api_key}"}, timeout=30,
    )
    resp.raise_for_status()
    return resp.text


def parse_rrweb_lines(raw_text):
    """Each line is a JSON array: [window_id, event]. Decompress any gzip'd `data`."""
    events = []
    for line in raw_text.strip().splitlines():
        if not line.strip():
            continue
        _window_id, event = json.loads(line)
        data = event.get("data")
        if isinstance(data, str):
            try:
                event["data"] = json.loads(gzip.decompress(data.encode("latin1")))
            except Exception:
                pass  # not gzip'd, leave as-is
        events.append(event)
    return events


def build_events_for_timestamp(host, project_id, api_key, session_id, key_timestamp_ms):
    manifest = fetch_snapshot_manifest(host, project_id, api_key, session_id)
    events = []
    for source in manifest:
        # source timestamps are ISO strings; only fetch chunks up through the target moment
        if source.get("source") != "blob_v2":
            continue
        events.extend(parse_rrweb_lines(fetch_blob(host, project_id, api_key, session_id, source["blob_key"])))
        if source.get("end_timestamp") and key_timestamp_ms and source["end_timestamp"] >= key_timestamp_ms:
            break
    return sorted(events, key=lambda e: e.get("timestamp", 0))


def render_and_screenshot(events, out_path, vendor_dir):
    html_path = os.path.join(vendor_dir, "_capture_shell.html")
    with open(html_path, "w") as f:
        f.write(f"""<!DOCTYPE html>
<html><head>
<link rel="stylesheet" href="rrweb-player.min.css">
<script src="rrweb-player.min.js"></script>
<style>body{{margin:0}}</style>
</head><body>
<div id="player"></div>
<script>
const events = {json.dumps(events)};
window.__player = new rrwebPlayer({{
  target: document.getElementById('player'),
  props: {{ events, autoPlay: false, width: 1280, height: 800 }},
}});
window.__ready = true;
</script>
</body></html>""")

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1280, "height": 900})
        page.goto(f"file://{html_path}")
        page.wait_for_function("window.__ready === true", timeout=15000)
        page.wait_for_timeout(1500)  # let the first frame paint
        page.screenshot(path=out_path)
        browser.close()


def upload(worker_url, secret, session_id, task_index, owner_email, ts, png_path):
    with open(png_path, "rb") as f:
        resp = requests.post(
            f"{worker_url}/api/pipeline/media",
            params={"session_id": session_id, "task_index": task_index, "owner_email": owner_email, "ts": ts},
            headers={"Authorization": f"Bearer {secret}"},
            data=f.read(), timeout=30,
        )
    resp.raise_for_status()
    return resp.json()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--session-id", required=True)
    ap.add_argument("--key-timestamp", required=True, help="ISO timestamp of the flagged moment")
    ap.add_argument("--connection-id", required=True, type=int)
    ap.add_argument("--owner-email", required=True)
    ap.add_argument("--task-index", required=True, type=int)
    ap.add_argument("--worker-url", default="https://bug-radar.shubhamvishnu.workers.dev")
    args = ap.parse_args()

    secret = os.environ["BUGRADAR_API_SECRET"]
    vendor_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor")

    conn = fetch_connection(args.worker_url, secret, args.connection_id)
    host = PH_HOSTS[conn["region"]]

    events = build_events_for_timestamp(host, conn["project_id"], conn["api_key"], args.session_id, args.key_timestamp)
    if not events:
        print(f"No rrweb events found for session {args.session_id}, skipping capture.")
        return 0

    out_path = "/tmp/capture.png"
    render_and_screenshot(events, out_path, vendor_dir)
    result = upload(args.worker_url, secret, args.session_id, args.task_index, args.owner_email, args.key_timestamp, out_path)
    print(f"Uploaded: {result}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 3: Local smoke test (this machine has Playwright installed already from the earlier brainstorm's setup check, or install it now)**

```bash
cd /Users/shubhamkhandelwal/posthog-bug-radar
source venv/bin/activate
pip install -r requirements.txt
playwright install chromium
SECRET=$(security find-generic-password -s "BUGRADAR_API_SECRET" -w)
BUGRADAR_API_SECRET="$SECRET" python3 capture_screenshot.py \
  --session-id "019fedb0-6ec1-766c-9063-f8417c68251a" \
  --key-timestamp "2026-08-11T03:29:50.000Z" \
  --connection-id 1 \
  --owner-email "shubhamvishnu@gmail.com" \
  --task-index 0
```

Use a real `session_id` known to exist (any of Brandon's sessions from earlier this session work) and a `key-timestamp` near its start. Expected: prints `Uploaded: {'ok': True, 'url': '/api/media/...', 'merged': True or False}`. If `merged: False`, that's fine for this smoke test, it just means that exact task_index/session_id combination isn't in the current latest report, the important thing is that a real PNG made it to R2 without crashing.

- [ ] **Step 4: Commit**

```bash
git add capture_screenshot.py requirements.txt
git commit -m "Add headless rrweb-to-screenshot capture script"
git push
```

---

## Task 6: GitHub Actions workflow

**Files:**
- Create: `/Users/shubhamkhandelwal/posthog-bug-radar/.github/workflows/capture-screenshot.yml`

**Interfaces:**
- Consumes: `capture_screenshot.py` (Task 5), the `BUGRADAR_API_SECRET` repo secret (Task 1).
- Produces: a `workflow_dispatch`-triggered job, inputs `session_id`, `key_timestamp`, `connection_id`, `owner_email`, `task_index`.

- [ ] **Step 1: Write the workflow**

```yaml
name: Capture Screenshot

on:
  workflow_dispatch:
    inputs:
      session_id:
        required: true
        type: string
      key_timestamp:
        required: true
        type: string
      connection_id:
        required: true
        type: string
      owner_email:
        required: true
        type: string
      task_index:
        required: true
        type: string

jobs:
  capture:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
      - run: pip install -r requirements.txt
      - run: playwright install --with-deps chromium
      - run: |
          python3 capture_screenshot.py \
            --session-id "${{ inputs.session_id }}" \
            --key-timestamp "${{ inputs.key_timestamp }}" \
            --connection-id "${{ inputs.connection_id }}" \
            --owner-email "${{ inputs.owner_email }}" \
            --task-index "${{ inputs.task_index }}"
        env:
          BUGRADAR_API_SECRET: ${{ secrets.BUGRADAR_API_SECRET }}
```

- [ ] **Step 2: Commit and push**

```bash
cd /Users/shubhamkhandelwal/posthog-bug-radar
git add .github/workflows/capture-screenshot.yml
git commit -m "Add GitHub Actions workflow for headless screenshot capture"
git push
```

- [ ] **Step 3: Verify by triggering it manually**

```bash
gh workflow run capture-screenshot.yml \
  -f session_id="019fedb0-6ec1-766c-9063-f8417c68251a" \
  -f key_timestamp="2026-08-11T03:29:50.000Z" \
  -f connection_id="1" \
  -f owner_email="shubhamvishnu@gmail.com" \
  -f task_index="0"
gh run watch
```

Expected: the run completes with a green checkmark. If it fails, `gh run view --log-failed` shows exactly which step, most likely candidates are the Playwright browser-deps install on the Actions runner or the vendored bundle path.

---

## Task 7: Wire `bug_radar.py` to trigger captures

**Files:**
- Modify: `bug_radar.py`

**Interfaces:**
- Consumes: `gh` CLI (already authenticated on this machine, confirmed in Task 1), the `finding`/`task` shape already built in `main()`'s per-session loop.
- Produces: a `trigger_capture(session_id, key_timestamp, connection_id, owner_email, task_index)` function, called once per qualifying task.

- [ ] **Step 1: Add the trigger function**

Add near the top of `bug_radar.py`, after the existing `fetch_goals` function:

```python
def trigger_capture(session_id, key_timestamp, connection_id, owner_email, task_index):
    """Fire-and-forget: dispatches the GitHub Actions capture workflow. Never
    raises, a failure here must not affect the pipeline's own report push."""
    try:
        subprocess.run(
            [
                "gh", "workflow", "run", "capture-screenshot.yml",
                "-f", f"session_id={session_id}",
                "-f", f"key_timestamp={key_timestamp}",
                "-f", f"connection_id={connection_id}",
                "-f", f"owner_email={owner_email}",
                "-f", f"task_index={task_index}",
            ],
            capture_output=True, text=True, timeout=30, check=True,
        )
        print(f"[capture] triggered for {session_id} task {task_index}")
    except Exception as e:
        print(f"[capture] WARNING: could not trigger for {session_id} task {task_index}: {e}")
```

- [ ] **Step 2: Call it from the per-session loop**

In `main()`, inside the `for c in candidates:` loop, right after `finding["tasks"] = result.get("tasks", [])` is built (the block that appends `finding` to `findings`), add a pass over the tasks to trigger capture for qualifying ones. Find this block (search for `findings.append(finding)`), and just before it, insert:

```python
    for idx, task in enumerate(finding["tasks"]):
        if task.get("outcome") == "blocked" or task.get("severity") == "high":
            trigger_capture(sid, task.get("key_timestamp") or c["started_at"], conn["id"], conn["owner_email"], idx)
```

- [ ] **Step 3: Verify**

```bash
cd /Users/shubhamkhandelwal/posthog-bug-radar
python3 -m py_compile bug_radar.py && echo OK
python3 bug_radar.py --session-id "019fedb0-6ec1-766c-9063-f8417c68251a"
gh run list --workflow=capture-screenshot.yml --limit 3
```

Expected: `bug_radar.py` runs as before, prints `[capture] triggered for ...` for any blocked/high-severity task it found, and `gh run list` shows a new run.

- [ ] **Step 4: Commit**

```bash
git add bug_radar.py
git commit -m "Trigger screenshot capture for blocked/high-severity tasks"
git push
```

---

## Task 8: End-to-end verification

**Files:** none (verification only).

- [ ] **Step 1: Run the real pipeline against a session known to have a blocked/high-severity task**

```bash
cd /Users/shubhamkhandelwal/posthog-bug-radar
python3 bug_radar.py --session-id "019fec95-668d-7451-b524-8566e9958f68"
```

- [ ] **Step 2: Wait for the triggered Action to finish**

```bash
gh run list --workflow=capture-screenshot.yml --limit 1
gh run watch
```

- [ ] **Step 3: Confirm the merge landed**

```bash
cd worker
npx wrangler d1 execute bug-radar-db --remote --command "SELECT micro_findings FROM reports ORDER BY id DESC LIMIT 1" --json 2>/dev/null | python3 -c "
import json, sys
d = json.load(sys.stdin)
findings = json.loads(d[0]['results'][0]['micro_findings'])
for f in findings:
    if f['session_id'] == '019fec95-668d-7451-b524-8566e9958f68':
        for t in f['tasks']:
            print(t.get('title'), '| media:', t.get('media'))
"
```

Expected: at least one task shows a `media` array with one entry containing a real `/api/media/...` URL.

- [ ] **Step 4: Confirm it renders in the UI**

Use the Playwright MCP tools (same pattern used throughout this project) to log in, navigate to that session, expand the task, expand "Captured Moments," and confirm a real screenshot image renders, not the striped placeholder.
