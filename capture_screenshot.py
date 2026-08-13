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
