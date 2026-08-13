#!/usr/bin/env python3
"""
PostHog Bug Radar — events-only prototype.

Finds real product bugs from PostHog event data alone (no session-recording
video, no PostHog Vision credits spent). Two passes:

  1. Macro:  cluster $dead_click/$rageclick by (pathname, element text) across
             all sessions in a date range -> one LLM call names the themes.
  2. Micro:  find the sessions with the most dead_click/rageclick/exception
             events -> pull each session's ordered event stream -> one LLM
             call per session verdicts real-bug vs noise, with a narrative.

Connection-driven: the PostHog key, region, project ID, identity-property
mapping, discovered event taxonomy, and company description all come from a
saved connection in the Worker (added via Settings > Connections), not from
constants in this file. Run with --connection-id, or omit it if you only
have one connection saved.

Needs the pipeline secret, used to call the Worker's /api/pipeline/* routes:
  security add-generic-password -U -a "$USER" -s BUGRADAR_API_SECRET -w

LLM calls go through the local `claude` CLI (headless `-p` mode), using your
Claude subscription login instead of metered Anthropic API credits.
"""
import argparse
import json
import subprocess
import sys
import time
from datetime import datetime, timezone

import requests


def keychain(service):
    out = subprocess.run(
        ["security", "find-generic-password", "-s", service, "-w"],
        capture_output=True, text=True,
    )
    if out.returncode != 0:
        sys.exit(
            f"Missing keychain entry '{service}'. Add it with:\n"
            f'  security add-generic-password -U -a "$USER" -s {service} -w'
        )
    return out.stdout.strip()


PH_HOSTS = {"us": "https://us.posthog.com", "eu": "https://eu.posthog.com"}


def fetch_connection(worker_url, secret, connection_id):
    headers = {"Authorization": f"Bearer {secret}"}
    if connection_id is None:
        resp = requests.get(f"{worker_url}/api/pipeline/connections", headers=headers, timeout=30)
        resp.raise_for_status()
        conns = resp.json()
        if not conns:
            sys.exit("No PostHog connections saved yet. Add one in Settings > Connections first.")
        if len(conns) > 1:
            options = "\n".join(f"  --connection-id {c['id']}  ({c['project_name']}, {c['owner_email']})" for c in conns)
            sys.exit(f"More than one connection saved, pick one:\n{options}")
        connection_id = conns[0]["id"]

    resp = requests.get(f"{worker_url}/api/pipeline/connections/{connection_id}", headers=headers, timeout=30)
    resp.raise_for_status()
    return resp.json()


def fetch_company_context(worker_url, secret, owner_email):
    headers = {"Authorization": f"Bearer {secret}"}
    resp = requests.get(
        f"{worker_url}/api/pipeline/company-knowledge",
        headers=headers, params={"owner_email": owner_email}, timeout=30,
    )
    resp.raise_for_status()
    data = resp.json()
    return data.get("description") or "No company description saved yet — treat this as a generic web product."


def fetch_goals(worker_url, secret, owner_email):
    headers = {"Authorization": f"Bearer {secret}"}
    resp = requests.get(
        f"{worker_url}/api/pipeline/goals",
        headers=headers, params={"owner_email": owner_email}, timeout=30,
    )
    resp.raise_for_status()
    return resp.json()


def trigger_capture(session_id, key_timestamp, connection_id, task_index):
    """Fire-and-forget: dispatches the GitHub Actions capture workflow. Never
    raises, a failure here must not affect the pipeline's own report push."""
    try:
        subprocess.run(
            [
                "gh", "workflow", "run", "capture-screenshot.yml",
                "-f", f"session_id={session_id}",
                "-f", f"key_timestamp={key_timestamp}",
                "-f", f"connection_id={connection_id}",
                "-f", f"task_index={task_index}",
            ],
            capture_output=True, text=True, timeout=30, check=True,
        )
        print(f"[capture] triggered for {session_id} task {task_index}")
    except Exception as e:
        print(f"[capture] WARNING: could not trigger for {session_id} task {task_index}: {e}")


def hogql(host, project_id, query, key, retries=3):
    for attempt in range(retries):
        resp = requests.post(
            f"{host}/api/projects/{project_id}/query/",
            headers={"Authorization": f"Bearer {key}"},
            json={"query": {"kind": "HogQLQuery", "query": query}},
            timeout=60,
        )
        if resp.status_code >= 500 and attempt < retries - 1:
            time.sleep(2 * (attempt + 1))
            continue
        resp.raise_for_status()
        data = resp.json()
        cols = data["columns"]
        return [dict(zip(cols, row)) for row in data["results"]]


def fetch_macro_clusters(host, project_id, key, window, limit):
    return hogql(host, project_id, f"""
        SELECT
            properties.$pathname AS pathname,
            properties.$el_text AS el_text,
            count() AS clicks,
            uniq(person_id) AS users
        FROM events
        WHERE event IN ('$dead_click', '$rageclick')
          AND timestamp >= now() - INTERVAL {window}
        GROUP BY pathname, el_text
        ORDER BY clicks DESC
        LIMIT {limit}
    """, key)


def fetch_candidate_sessions(host, project_id, key, window, limit, identity):
    email_expr = f"any(person.properties.{identity['email']})" if identity.get("email") else "NULL"
    name_expr = f"any(person.properties.{identity['name']})" if identity.get("name") else "NULL"
    role_expr = f"any(person.properties.{identity['role']})" if identity.get("role") else "NULL"
    return hogql(host, project_id, f"""
        SELECT
            properties.$session_id AS session_id,
            countIf(event = '$dead_click') AS dead_clicks,
            countIf(event = '$rageclick') AS rage_clicks,
            countIf(event = '$exception') AS exceptions,
            uniq(person_id) AS users,
            min(timestamp) AS started_at,
            any(person_id) AS person_id,
            {email_expr} AS email,
            {name_expr} AS name,
            {role_expr} AS role
        FROM events
        WHERE event IN ('$dead_click', '$rageclick', '$exception')
          AND timestamp >= now() - INTERVAL {window}
          AND properties.$session_id IS NOT NULL
        GROUP BY session_id
        ORDER BY (dead_clicks + rage_clicks * 3 + exceptions * 5) DESC
        LIMIT {limit}
    """, key)


def fetch_sessions_by_id(host, project_id, key, session_ids, identity, lookback_days=30):
    email_expr = f"any(person.properties.{identity['email']})" if identity.get("email") else "NULL"
    name_expr = f"any(person.properties.{identity['name']})" if identity.get("name") else "NULL"
    role_expr = f"any(person.properties.{identity['role']})" if identity.get("role") else "NULL"
    id_list = ", ".join(f"'{sid}'" for sid in session_ids)
    return hogql(host, project_id, f"""
        SELECT
            properties.$session_id AS session_id,
            countIf(event = '$dead_click') AS dead_clicks,
            countIf(event = '$rageclick') AS rage_clicks,
            countIf(event = '$exception') AS exceptions,
            uniq(person_id) AS users,
            min(timestamp) AS started_at,
            any(person_id) AS person_id,
            {email_expr} AS email,
            {name_expr} AS name,
            {role_expr} AS role
        FROM events
        WHERE properties.$session_id IN ({id_list})
          AND timestamp >= now() - INTERVAL {lookback_days} DAY
        GROUP BY session_id
    """, key)


def fetch_session_events(host, project_id, key, session_id, window, custom_events):
    baseline = ["$pageview", "$autocapture", "$dead_click", "$rageclick", "$exception"]
    event_list = ", ".join(f"'{e}'" for e in dict.fromkeys(baseline + custom_events))
    time_filter = f"AND timestamp >= now() - INTERVAL {window}" if window else ""
    return hogql(host, project_id, f"""
        SELECT
            event,
            properties.$el_text AS el_text,
            properties.$pathname AS pathname,
            timestamp
        FROM events
        WHERE properties.$session_id = '{session_id}'
          {time_filter}
          AND event IN ({event_list})
        ORDER BY timestamp
        LIMIT 150
    """, key)


THEME_PROMPT = """You are looking at PostHog dead-click/rage-click clusters for this product:
{company_context}

Each row is (page, clicked-element-text, click count, unique users) over the last few days.

Group these into 3-8 named themes. For each theme give:
- title: short name for the problem
- pages: which page(s) it's on
- likely_cause: one sentence, best guess at what's actually broken
- confidence: high/medium/low
- false_positive_risk: one sentence on whether this might just be users clicking
  read-only content (long text, AI-generated summaries) rather than a real bug

Return ONLY a JSON array of theme objects, no prose.

DATA:
{data}
"""

SESSION_PROMPT = """You are looking at one user's ordered event stream for this product:
{company_context}

Events are page views, clicks (with element text when captured), dead clicks,
rage clicks, and exceptions, in chronological order.

EXISTING GOALS -- the outcomes users are already known to pursue in this product:
{goals_context}

For each task, decide whether it matches one of the EXISTING GOALS above (the same
underlying purpose, even if phrased differently) or represents a new one not yet tracked:
- If it clearly matches an existing goal, set "goal_id" to that goal's id and leave
  "new_goal" null.
- If it does not match any existing goal, set "goal_id" to null and fill "new_goal" with
  {{"purpose": "short outcome name", "description": "1-2 sentences, what success looks
  like", "tags": ["a few short lowercase tags"]}}.
Never invent a goal_id that isn't in the EXISTING GOALS list above. When in doubt between
a loose match and a new goal, prefer creating a new goal, goals should be specific enough
to be useful, not a catch-all.

A single session often contains MORE THAN ONE distinct thing the user was trying to do --
e.g. they might try to connect an integration, then separately go create a record, then
separately browse something else. Do not force the whole session into one goal. Instead:

1. Segment the event stream into distinct tasks, based on shifts in what the user appears
   to be trying to accomplish (a genuine change in goal, not just a new page -- browsing
   several records in a row is still "browsing", not several separate tasks).
2. For EACH task, independently judge its outcome and whether it's evidence of a real
   product bug.

For each task's "outcome", judge from the LAST relevant action tied to this goal in the
event window -- not the first apparent success. A task can look successful partway through
and then be undone later in the same window; when that happens, the later action wins.
- "completed": the LAST relevant action is a clear success signal, AND nothing after it
  reverses, undoes, disconnects, removes, or cancels that success. If the user connects an
  integration and then later disconnects it, deletes what they just created, or reverts a
  change -- even minutes later, even after navigating elsewhere in between -- that is NOT
  completed. Scan the full window for this before deciding.
- "abandoned": the user visibly gave up, changed their mind, or undid earlier progress
  (navigated away, cancelled, disconnected/removed something they'd just set up)
- "blocked": an error, dead end, or unresponsive control is the last thing tied to this goal
- "unresolved": the event window ends mid-task with no clear success, abandonment, or block
  (e.g. hit the 150-event cap or 3-day window while still in progress) -- use this rather
  than guessing when the data simply runs out

Most sessions will have 1-3 tasks. Only split into multiple tasks when the underlying goal
genuinely changes, not for every page navigation within the same goal.

CUSTOMER OUTREACH -- be extremely conservative here. Proactively messaging a customer about
something that turns out to be normal use, or something minor, damages trust and reads as
spammy. Getting a genuinely blocked customer help fast is valuable; getting it wrong is
costly. So:

For each task, set "customer_reachable" to true ONLY if ALL of these hold:
- outcome is "blocked" (a clear, unambiguous technical failure -- not "unresolved", where
  we simply don't know what happened next, and not "abandoned", which is often just the
  user changing their mind, not a bug)
- the failure is on a core, consequential action for THIS product (see the description
  above for what that is here) -- e.g. an integration/connection failing, a data
  import/upload failing, an AI assistant returning an error or failure message, a
  payment/billing action failing. NOT a dead click on read-only text, NOT general UI
  friction, NOT anything ambiguous or low-severity.
- severity is "high" (never mark medium/low/none as customer_reachable)
Default to false whenever in doubt. Most tasks, even real bugs, should NOT be customer_reachable.

We can send AT MOST ONE outreach message per session, even if multiple tasks qualify. So:
after judging every task, if one or more tasks are customer_reachable, pick the single
best one (worst/clearest failure) and write "recommended_outreach" for it. If zero tasks
qualify, "recommended_outreach" must be null.

The outreach message itself must be short (1-2 sentences), warm but not apologetic or
robotic, specific about what the customer was doing (not generic), and offer help without
presuming the cause. Example tone: "Hey, looks like your CSV import didn't go through --
want a hand getting your contacts in?" Not: "We're sorry you're experiencing issues with
our platform."

Return ONLY this JSON object, no prose:
{{
  "tasks": [
    {{
      "goal": "what the user was trying to accomplish in this task, in a few words",
      "goal_id": null OR <id from EXISTING GOALS above>,
      "new_goal": null OR {{"purpose": "...", "description": "...", "tags": ["..."]}},
      "outcome": "completed/abandoned/blocked/unresolved",
      "real_bug": true/false,
      "severity": "high/medium/low/none",
      "customer_reachable": true/false,
      "title": "short description of this task",
      "narrative": "2-3 sentences: what happened in this task",
      "evidence": "the specific event(s) that support this task's verdict",
      "key_timestamp": "the exact timestamp value (copy verbatim from the input events)
        of the single most important event backing this task's verdict -- e.g. the dead
        click, error, or blocked action that best represents what happened"
    }}
  ],
  "recommended_outreach": null OR {{
    "task_index": 0,
    "message": "the exact customer-facing message to send, per the rules above"
  }}
}}

SESSION EVENTS:
{data}
"""


def call_llm(prompt):
    result = subprocess.run(
        ["claude", "-p", prompt],
        capture_output=True, text=True, timeout=240,
    )
    if result.returncode != 0:
        raise RuntimeError(f"claude CLI failed: {result.stderr.strip()}")
    text = result.stdout.strip()
    if text.startswith("```"):
        text = text.split("```")[1]
        if text.startswith("json"):
            text = text[4:]
    return json.loads(text)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--connection-id", type=int, default=None, help="which saved PostHog connection to run against")
    ap.add_argument("--macro-days", type=int, default=14)
    ap.add_argument("--micro-days", type=int, default=3)
    ap.add_argument("--hours", type=float, default=None, help="override both windows to the last N hours (e.g. --hours 12)")
    ap.add_argument("--sessions", type=int, default=8)
    ap.add_argument("--session-id", default=None, help="comma-separated session_id(s) to target directly, skips macro pass and candidate selection, merges into the existing report instead of replacing it")
    ap.add_argument("--out", default="report.json")
    ap.add_argument("--worker-url", default="https://bug-radar.shubhamvishnu.workers.dev")
    ap.add_argument("--no-push", action="store_true", help="skip pushing to the live Worker")
    args = ap.parse_args()
    target_session_ids = [s.strip() for s in args.session_id.split(",")] if args.session_id else None

    if args.hours is not None:
        macro_window = f"{args.hours} HOUR"
        micro_window = f"{args.hours} HOUR"
        session_window = f"{args.hours + 2} HOUR"
        macro_label = f"{args.hours}h"
        micro_label = f"{args.hours}h"
    else:
        macro_window = f"{args.macro_days} DAY"
        micro_window = f"{args.micro_days} DAY"
        session_window = f"{args.micro_days + 1} DAY"
        macro_label = f"{args.macro_days}d"
        micro_label = f"{args.micro_days}d"

    secret = keychain("BUGRADAR_API_SECRET")
    conn = fetch_connection(args.worker_url, secret, args.connection_id)
    host = PH_HOSTS[conn["region"]]
    project_id = conn["project_id"]
    ph_key = conn["api_key"]
    identity = {
        "email": conn.get("identity_email_prop"),
        "name": conn.get("identity_name_prop"),
        "role": conn.get("identity_role_prop"),
    }
    custom_events = (conn.get("config") or {}).get("customEvents", [])
    company_context = fetch_company_context(args.worker_url, secret, conn["owner_email"])
    goals = fetch_goals(args.worker_url, secret, conn["owner_email"])
    goals_context = json.dumps([{"id": g["id"], "purpose": g["purpose"], "description": g.get("description"), "tags": g.get("tags", [])} for g in goals]) if goals else "(none yet — every task in this run should propose a new_goal)"
    print(f"[connection] #{conn['id']} {conn['project_name']} ({conn['region']}) owner={conn['owner_email']}")
    print(f"[goals] {len(goals)} existing goal(s) loaded")

    themes = None
    theme_prompt = None
    if target_session_ids:
        print(f"[targeted] fetching {len(target_session_ids)} specific session(s)...")
        candidates = fetch_sessions_by_id(host, project_id, ph_key, target_session_ids, identity)
        found_ids = {c["session_id"] for c in candidates}
        missing = [sid for sid in target_session_ids if sid not in found_ids]
        if missing:
            print(f"WARNING: no events found for session_id(s): {missing}")
        session_window = "30 DAY"  # bounded, just enough to keep the query fast; not a real relevance cutoff
    else:
        print(f"[macro] pulling dead/rage click clusters, last {macro_label}...")
        clusters = fetch_macro_clusters(host, project_id, ph_key, macro_window, limit=25)
        print(f"[macro] {len(clusters)} clusters -> naming themes with LLM...")
        theme_prompt = THEME_PROMPT.format(company_context=company_context, data=json.dumps(clusters, default=str))
        themes = call_llm(theme_prompt)

        print(f"[micro] finding top {args.sessions} candidate sessions, last {micro_label}...")
        candidates = fetch_candidate_sessions(host, project_id, ph_key, micro_window, args.sessions, identity)

    findings = []
    pending_captures = []
    for c in candidates:
        sid = c["session_id"]
        print(f"[micro] {sid}: pulling events + LLM verdict...")
        events = fetch_session_events(host, project_id, ph_key, sid, session_window, custom_events)
        if not events:
            continue
        session_prompt = SESSION_PROMPT.format(company_context=company_context, goals_context=goals_context, data=json.dumps(events, default=str))
        result = call_llm(session_prompt)
        finding = {
            "session_id": sid,
            "replay_url": f"{host}/project/{project_id}/replay/{sid}",
            "started_at": c["started_at"],
            "person": {
                "person_id": c.get("person_id"),
                "email": c.get("email"),
                "name": c.get("name"),
                "role": c.get("role"),
            },
            "triage_counts": {
                "dead_clicks": c["dead_clicks"],
                "rage_clicks": c["rage_clicks"],
                "exceptions": c["exceptions"],
            },
            "events": events,
            "tasks": result.get("tasks", []),
            "recommended_outreach": result.get("recommended_outreach"),
        }
        for idx, task in enumerate(finding["tasks"]):
            if task.get("outcome") == "blocked" or task.get("severity") == "high":
                pending_captures.append((sid, task.get("key_timestamp") or c["started_at"], idx))
        findings.append(finding)

    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "macro_themes": themes,
        "micro_findings": findings,
    }
    with open(args.out, "w") as f:
        json.dump(report, f, indent=2, default=str)

    session_prompt_sample = SESSION_PROMPT.format(company_context=company_context, goals_context=goals_context, data="<per-session events>")
    if not args.no_push:
        if target_session_ids:
            push_body = {
                "owner_email": conn["owner_email"],
                "connection_id": conn["id"],
                "findings": findings,
                "session_prompt": session_prompt_sample,
            }
            resp = requests.post(
                f"{args.worker_url}/api/pipeline/report/merge",
                headers={"Authorization": f"Bearer {secret}"},
                json=push_body,
                timeout=30,
            )
        else:
            push_body = {
                "generated_at": report["generated_at"],
                "macro_themes": report["macro_themes"],
                "micro_findings": report["micro_findings"],
                "theme_prompt": theme_prompt,
                "session_prompt": session_prompt_sample,
                "owner_email": conn["owner_email"],
                "connection_id": conn["id"],
            }
            resp = requests.post(
                f"{args.worker_url}/api/report",
                headers={"Authorization": f"Bearer {secret}"},
                json=push_body,
                timeout=30,
            )
        if resp.status_code == 200:
            print(f"Pushed to {args.worker_url}")
            for sid, key_ts, idx in pending_captures:
                trigger_capture(sid, key_ts, conn["id"], idx)
        else:
            print(f"WARNING: push to {args.worker_url} failed ({resp.status_code}): {resp.text}")

    total_tasks = sum(len(f["tasks"]) for f in findings)
    real_bugs = sum(1 for f in findings for t in f["tasks"] if t.get("real_bug"))
    outreach_count = sum(1 for f in findings if f.get("recommended_outreach"))
    theme_count = len(themes) if themes is not None else 0
    print(f"\nDone. {theme_count} macro themes, {len(findings)} sessions -> {total_tasks} tasks, {real_bugs} flagged as real bugs.")
    print(f"{outreach_count}/{len(findings)} sessions have a recommended customer outreach.")
    print(f"Report written to {args.out}")


if __name__ == "__main__":
    main()
