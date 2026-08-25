const SESSION_COOKIE = "bugradar_session";
const SESSION_DAYS = 30;
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_RESEND_COOLDOWN_MS = 30 * 1000;
const OTP_MAX_ATTEMPTS = 5;

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

function sessionCookieHeader(token, maxAgeSeconds) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

function getCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function sqliteTimeToMs(sqliteText) {
  // D1's datetime('now') default returns "YYYY-MM-DD HH:MM:SS" in UTC, no timezone suffix.
  return Date.parse(sqliteText.replace(" ", "T") + "Z");
}

const SYNC_FREQ_VALUES = ["5m", "30m", "1h", "6h", "12h", "1d", "7d"];
const SYNC_MAX_SESSIONS_VALUES = [8, 20, 50, 100];
const SYNC_FREQ_MS = {
  "5m": 5 * 60 * 1000,
  "30m": 30 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "12h": 12 * 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

function computeDue(syncFreq, lastPipelineRunAt) {
  if (!lastPipelineRunAt) return true; // never run yet — always due, don't make a new customer wait a full cycle
  const freqMs = SYNC_FREQ_MS[syncFreq] || SYNC_FREQ_MS["1d"];
  const lastMs = sqliteTimeToMs(lastPipelineRunAt);
  if (Number.isNaN(lastMs)) return true; // unparseable timestamp — fail safe (due), not silent (never due)
  return Date.now() >= lastMs + freqMs;
}

async function getSessionEmail(request, env) {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const row = await env.DB.prepare("SELECT email, expires_at FROM sessions WHERE token = ? AND surface = 'main'")
    .bind(token)
    .first();
  if (!row) return null;
  if (Date.parse(row.expires_at) < Date.now()) return null;
  return row.email;
}

function randomOtp() {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(100000 + (buf[0] % 900000));
}

async function sendOtpEmail(env, email, code) {
  const from = env.RESEND_FROM || "Bug Radar <login@revsight.io>";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: email,
      subject: "Your Bug Radar login code",
      html: `<div style="font-family:-apple-system,sans-serif;font-size:15px;color:#1a1712">
        <p>Your login code is:</p>
        <p style="font-size:32px;font-weight:700;letter-spacing:6px;font-family:monospace">${code}</p>
        <p style="color:#6b6860;font-size:13px">This code expires in 10 minutes. If you didn't request this, you can ignore this email.</p>
      </div>`,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Resend ${res.status}: ${text}`);
  }
}

const DEFAULT_OWNER_EMAIL = "shubhamvishnu@gmail.com";

/* ---------------- encryption (per-tenant PostHog keys) ---------------- */
async function getAesKey(env) {
  const raw = Uint8Array.from(atob(env.CONNECTION_ENCRYPTION_KEY), c => c.charCodeAt(0));
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
function toB64(buf) { return btoa(String.fromCharCode(...new Uint8Array(buf))); }
function fromB64(b64) { return Uint8Array.from(atob(b64), c => c.charCodeAt(0)); }

async function encryptSecret(env, plaintext) {
  const key = await getAesKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext));
  return { ciphertext: toB64(cipher), iv: toB64(iv) };
}
async function decryptSecret(env, ciphertextB64, ivB64) {
  const key = await getAesKey(env);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromB64(ivB64) },
    key,
    fromB64(ciphertextB64)
  );
  return new TextDecoder().decode(plain);
}

const AI_PROVIDERS = ["anthropic", "openai", "gemini"];

async function resolveAiConfig(env, ownerEmail) {
  const row = await env.DB.prepare(
    "SELECT provider, model, encrypted_api_key, iv FROM tenant_ai_config WHERE owner_email = ?"
  ).bind(ownerEmail).first();

  let provider, model, encryptedKey, iv;
  if (!row) {
    const def = await env.DB.prepare(
      "SELECT encrypted_api_key, iv, default_model FROM ai_provider_defaults WHERE provider = 'anthropic'"
    ).first();
    if (!def) throw new Error("no anthropic default configured");
    provider = "anthropic";
    model = def.default_model;
    encryptedKey = def.encrypted_api_key;
    iv = def.iv;
  } else {
    provider = row.provider;
    model = row.model;
    if (row.encrypted_api_key) {
      encryptedKey = row.encrypted_api_key;
      iv = row.iv;
    } else {
      const def = await env.DB.prepare(
        "SELECT encrypted_api_key, iv FROM ai_provider_defaults WHERE provider = ?"
      ).bind(provider).first();
      if (!def) throw new Error(`no default key configured for provider ${provider}`);
      encryptedKey = def.encrypted_api_key;
      iv = def.iv;
    }
  }
  const apiKey = await decryptSecret(env, encryptedKey, iv);
  return { provider, model, api_key: apiKey };
}

function maskKey(plaintext) {
  if (!plaintext || plaintext.length < 4) return "••••";
  return `••••${plaintext.slice(-4)}`;
}

function parseLlmJson(text) {
  text = text.trim();
  if (text.startsWith("```")) {
    text = text.split("```")[1];
    if (text.startsWith("json")) text = text.slice(4);
  }
  return JSON.parse(text);
}

const LLM_API_TIMEOUT_MS = 120000; // 120 second timeout -- Gemini hung
                                    // past 90s with no timeout set (confirmed live this session)

async function callAnthropicLlm(prompt, model, apiKey) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 16000,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(LLM_API_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  return parseLlmJson(text);
}

async function callOpenaiLlm(prompt, model, apiKey) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(LLM_API_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`OpenAI API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return parseLlmJson(data.choices[0].message.content);
}

async function callGeminiLlm(prompt, model, apiKey) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      signal: AbortSignal.timeout(LLM_API_TIMEOUT_MS),
    }
  );
  if (!res.ok) throw new Error(`Gemini API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const parts = data.candidates?.[0]?.content?.parts || [];
  const text = parts.map(p => p.text).join("");
  return parseLlmJson(text);
}

async function callLlm(prompt, aiConfig) {
  const { provider, model, api_key: apiKey } = aiConfig;
  if (provider === "anthropic") return callAnthropicLlm(prompt, model, apiKey);
  if (provider === "openai") return callOpenaiLlm(prompt, model, apiKey);
  if (provider === "gemini") return callGeminiLlm(prompt, model, apiKey);
  throw new Error(`unknown AI provider: ${provider}`);
}

async function fetchProviderModels(provider, apiKey) {
  if (provider === "anthropic") {
    const res = await fetch("https://api.anthropic.com/v1/models", {
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    });
    if (!res.ok) throw new Error(`anthropic models list failed: ${res.status}`);
    const data = await res.json();
    return (data.data || []).map(m => m.id);
  }
  if (provider === "openai") {
    const res = await fetch("https://api.openai.com/v1/models", {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`openai models list failed: ${res.status}`);
    const data = await res.json();
    // "gpt-" catches audio/image/realtime/transcribe/tts/search-preview endpoints too --
    // those aren't reachable via chat.completions.create with a plain text prompt, so
    // exclude them explicitly rather than just prefix-matching.
    const NOT_CHAT = /audio|image|realtime|transcribe|tts|search-preview|live-transcribe/;
    return (data.data || [])
      .map(m => m.id)
      .filter(id => /^gpt-/.test(id) && !NOT_CHAT.test(id))
      .sort();
  }
  if (provider === "gemini") {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    if (!res.ok) throw new Error(`gemini models list failed: ${res.status}`);
    const data = await res.json();
    // supportedGenerationMethods includes "generateContent" for image/tts/music models too --
    // exclude the non-text modalities explicitly, same reasoning as the OpenAI filter above.
    const NOT_TEXT = /-image|-tts|lyria|nano-banana|robotics|computer-use/;
    return (data.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map(m => m.name.replace(/^models\//, ""))
      .filter(id => !NOT_TEXT.test(id))
      .sort();
  }
  throw new Error(`unknown provider: ${provider}`);
}

function themePromptFor(companyContext, data) {
  return `You are looking at PostHog dead-click/rage-click clusters for this product:
${companyContext}

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
${data}
`;
}

function sessionPromptFor(companyContext, goalsContext, tagsContext, data) {
  return `You are looking at one user's ordered event stream for this product:
${companyContext}

Events are page views, clicks (with element text when captured), dead clicks,
rage clicks, and exceptions, in chronological order.

EXISTING GOALS -- the outcomes users are already known to pursue in this product:
${goalsContext}

For each task, decide whether it matches one of the EXISTING GOALS above (the same
underlying purpose, even if phrased differently) or represents a new one not yet tracked:
- If it clearly matches an existing goal, set "goal_id" to that goal's id and leave
  "new_goal" null.
- If it does not match any existing goal, set "goal_id" to null and fill "new_goal" with
  {"purpose": "short outcome name", "description": "1-2 sentences, what success looks
  like", "tags": ["a few short lowercase tags"]}.
Never invent a goal_id that isn't in the EXISTING GOALS list above. When in doubt between
a loose match and a new goal, prefer creating a new goal, goals should be specific enough
to be useful, not a catch-all.

EXISTING TAGS -- categories already used to classify tasks in this product:
${tagsContext}

For each task, also assign zero or more tags: labels that categorize what kind of task
this is (e.g. "UI Bug", "Integration Bug", "Data Sync"), useful for engineering and
product to group tasks by theme. For each tag that clearly applies, either reuse an
existing tag's id from EXISTING TAGS above, or, if none fits, propose a new one with just
a short label. Never invent a tag_id that isn't in the EXISTING TAGS list above. Prefer
reusing an existing tag over minting a near-duplicate (don't create "UI Bugs" if "UI Bug"
already exists). Most tasks need 0-2 tags; don't force a tag onto every task.

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
{
  "tasks": [
    {
      "goal": "what the user was trying to accomplish in this task, in a few words",
      "goal_id": null OR <id from EXISTING GOALS above>,
      "new_goal": null OR {"purpose": "...", "description": "...", "tags": ["..."]},
      "tags": [] OR [{"tag_id": <id from EXISTING TAGS above> OR null, "new_tag": {"label": "..."} OR null}],
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
    }
  ],
  "recommended_outreach": null OR {
    "task_index": 0,
    "message": "the exact customer-facing message to send, per the rules above"
  }
}

SESSION EVENTS:
${data}
`;
}

async function getSlackBotToken(env, ownerEmail) {
  const row = await env.DB.prepare(
    "SELECT encrypted_bot_token, iv FROM slack_connections WHERE owner_email = ? AND status = 'connected'"
  ).bind(ownerEmail).first();
  if (!row || !row.encrypted_bot_token) return null;
  return decryptSecret(env, row.encrypted_bot_token, row.iv);
}

/* ---------------- PostHog discovery ---------------- */
const PH_REGIONS = { us: "https://us.posthog.com", eu: "https://eu.posthog.com" };

async function phGet(region, apiKey, path) {
  const res = await fetch(`${PH_REGIONS[region]}${path}`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    const err = new Error(`PostHog ${res.status} on ${path}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function hogqlPost(region, apiKey, projectId, query, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    const res = await fetch(`${PH_REGIONS[region]}/api/projects/${projectId}/query/`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ query: { kind: "HogQLQuery", query } }),
    });
    if (res.status >= 500 && attempt < retries - 1) {
      await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }
    if (!res.ok) {
      const err = new Error(`PostHog ${res.status} on HogQL query`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }
}

function hogqlRows(data) {
  const cols = data.columns;
  return data.results.map(row => Object.fromEntries(cols.map((c, i) => [c, row[i]])));
}

function identityExprs(identity) {
  return {
    email: identity.email ? `any(person.properties.${identity.email})` : "NULL",
    name: identity.name ? `any(person.properties.${identity.name})` : "NULL",
    role: identity.role ? `any(person.properties.${identity.role})` : "NULL",
  };
}

async function fetchMacroClusters(region, apiKey, projectId, window, limit) {
  const data = await hogqlPost(region, apiKey, projectId, `
    SELECT
        properties.$pathname AS pathname,
        properties.$el_text AS el_text,
        count() AS clicks,
        uniq(person_id) AS users
    FROM events
    WHERE event IN ('$dead_click', '$rageclick')
      AND timestamp >= now() - INTERVAL ${window}
    GROUP BY pathname, el_text
    ORDER BY clicks DESC
    LIMIT ${limit}
  `);
  return hogqlRows(data);
}

async function fetchCandidateSessions(region, apiKey, projectId, window, limit, identity) {
  const ex = identityExprs(identity);
  const data = await hogqlPost(region, apiKey, projectId, `
    SELECT
        properties.$session_id AS session_id,
        countIf(event = '$dead_click') AS dead_clicks,
        countIf(event = '$rageclick') AS rage_clicks,
        countIf(event = '$exception') AS exceptions,
        uniq(person_id) AS users,
        min(timestamp) AS started_at,
        any(person_id) AS person_id,
        ${ex.email} AS email,
        ${ex.name} AS name,
        ${ex.role} AS role
    FROM events
    WHERE event IN ('$dead_click', '$rageclick', '$exception')
      AND timestamp >= now() - INTERVAL ${window}
      AND properties.$session_id IS NOT NULL
    GROUP BY session_id
    ORDER BY (dead_clicks + rage_clicks * 3 + exceptions * 5) DESC
    LIMIT ${limit}
  `);
  return hogqlRows(data);
}

async function fetchSessionsById(region, apiKey, projectId, sessionIds, identity, lookbackDays = 30) {
  const ex = identityExprs(identity);
  const idList = sessionIds.map(sid => `'${sid.replace(/'/g, "''")}'`).join(", ");
  const data = await hogqlPost(region, apiKey, projectId, `
    SELECT
        properties.$session_id AS session_id,
        countIf(event = '$dead_click') AS dead_clicks,
        countIf(event = '$rageclick') AS rage_clicks,
        countIf(event = '$exception') AS exceptions,
        uniq(person_id) AS users,
        min(timestamp) AS started_at,
        any(person_id) AS person_id,
        ${ex.email} AS email,
        ${ex.name} AS name,
        ${ex.role} AS role
    FROM events
    WHERE properties.$session_id IN (${idList})
      AND timestamp >= now() - INTERVAL ${lookbackDays} DAY
    GROUP BY session_id
  `);
  return hogqlRows(data);
}

async function fetchSessionEvents(region, apiKey, projectId, sessionId, window, customEvents) {
  const baseline = ["$pageview", "$autocapture", "$dead_click", "$rageclick", "$exception"];
  const eventList = Array.from(new Set([...baseline, ...(customEvents || [])]))
    .map(e => `'${e.replace(/'/g, "''")}'`)
    .join(", ");
  const timeFilter = window ? `AND timestamp >= now() - INTERVAL ${window}` : "";
  const data = await hogqlPost(region, apiKey, projectId, `
    SELECT
        event,
        properties.$el_text AS el_text,
        properties.$pathname AS pathname,
        timestamp
    FROM events
    WHERE properties.$session_id = '${sessionId.replace(/'/g, "''")}'
      ${timeFilter}
      AND event IN (${eventList})
    ORDER BY timestamp
    LIMIT 150
  `);
  return hogqlRows(data);
}

async function detectRegionAndProjects(apiKey) {
  for (const region of ["us", "eu"]) {
    try {
      const data = await phGet(region, apiKey, "/api/projects/");
      return { region, projects: (data.results || []).map(p => ({ id: p.id, name: p.name })) };
    } catch (e) {
      if (e.status === 401 || e.status === 403) continue;
      if (region === "eu") throw e;
    }
  }
  const err = new Error("Could not validate this key on US or EU.");
  err.status = 401;
  throw err;
}

function isCustomEvent(name) { return !name.startsWith("$") && name !== "All events"; }
function isCustomProperty(name) { return !name.startsWith("$"); }

async function discoverProject(region, apiKey, projectId) {
  const settings = await phGet(region, apiKey, `/api/projects/${projectId}/`);
  let events = [], eventsScopeOk = false;
  try {
    const ev = await phGet(region, apiKey, `/api/projects/${projectId}/event_definitions/?limit=200`);
    events = (ev.results || []).map(e => e.name);
    eventsScopeOk = true;
  } catch (e) { /* missing event_definition:read, or a transient error — either way, not fatal to discovery */ }
  let personProps = [], propsScopeOk = false;
  try {
    const pp = await phGet(region, apiKey, `/api/projects/${projectId}/property_definitions/?type=person&limit=200`);
    personProps = (pp.results || []).map(p => p.name);
    propsScopeOk = true;
  } catch (e) { /* missing property_definition:read */ }

  // The pipeline's actual event/session queries run through HogQL (`query` scope), never
  // exercised by the discovery calls above — probe it directly with a trivial query so a
  // missing scope surfaces at connection time, not on the first real pipeline run.
  let queryScopeOk = false;
  try {
    await hogqlPost(region, apiKey, projectId, "SELECT 1");
    queryScopeOk = true;
  } catch (e) { /* missing `query` scope, or the key can't run HogQL for another reason */ }

  // session_recording:read — separate scope from everything above (confirmed via PostHog's
  // own API scope docs). Not required by the pipeline today, but check it now so it's visible
  // before it's ever needed, rather than discovered as a surprise 403 later.
  let sessionRecordingScopeOk = false;
  try {
    await phGet(region, apiKey, `/api/projects/${projectId}/session_recordings/?limit=1`);
    sessionRecordingScopeOk = true;
  } catch (e) { /* missing session_recording:read */ }

  // Vision and Session Summaries have no documented public REST endpoint (confirmed by
  // probing /vision_quota/, /vision_scanners/, /session_recordings/session_summaries/ and
  // their /api/environments/ variants directly, all 404 — only PostHog's own internal MCP
  // tooling can reach them today). Left null so buildConfigMap reports them honestly as
  // "unknown" rather than guessing.
  const visionQuota = null, visionScanners = null, sessionSummaries = null;

  return {
    settings, events, personProps, visionQuota, visionScanners, sessionSummaries,
    scopes: { query: queryScopeOk, eventDefinitions: eventsScopeOk, propertyDefinitions: propsScopeOk, sessionRecording: sessionRecordingScopeOk },
  };
}

function chip(state) { return state; } // active | idle | off | unknown

function buildConfigMap(discovery) {
  const s = discovery.settings;
  const custom = discovery.events.filter(isCustomEvent);
  const system = discovery.events.filter(e => !isCustomEvent(e));
  const hasAiEvents = discovery.events.some(e => e.startsWith("$ai_"));

  const visionConfigured = discovery.visionScanners && Array.isArray(discovery.visionScanners.results);
  const visionCount = visionConfigured ? discovery.visionScanners.results.length : null;
  const visionCredits = discovery.visionQuota;

  const summariesConfigured = discovery.sessionSummaries && Array.isArray(discovery.sessionSummaries.results);
  const summariesCount = summariesConfigured ? (discovery.sessionSummaries.count ?? discovery.sessionSummaries.results.length) : null;

  const scopes = discovery.scopes || {};
  const groups = [
    { name: "API Access", items: [
      { name: "Query (HogQL)", state: chip(scopes.query ? "active" : "off"), note: scopes.query ? "Can run the queries the pipeline depends on" : "Missing `query` scope — the pipeline cannot run at all until this key can run HogQL queries", flag: !scopes.query },
      { name: "Event definitions", state: chip(scopes.eventDefinitions ? "active" : "off"), note: scopes.eventDefinitions ? "Can list event names" : "Missing `event_definition:read` — custom event discovery will be incomplete", flag: !scopes.eventDefinitions },
      { name: "Property definitions", state: chip(scopes.propertyDefinitions ? "active" : "off"), note: scopes.propertyDefinitions ? "Can list person properties" : "Missing `property_definition:read` — identity mapping will be incomplete", flag: !scopes.propertyDefinitions },
      { name: "Session recordings", state: chip(scopes.sessionRecording ? "active" : "off"), note: scopes.sessionRecording ? "Can read session recordings" : "Missing `session_recording:read` — not required today, but blocks any future replay-based enrichment" },
    ]},
    { name: "Capture & Recording", items: [
      { name: "Autocapture", state: chip(s.autocapture_opt_out ? "off" : "active"), note: s.autocapture_opt_out ? "Turned off for this project" : "Firing on all pages" },
      { name: "Dead-click capture", state: chip(s.capture_dead_clicks ? "active" : "off"), note: s.capture_dead_clicks ? "$dead_click enabled" : "Off", flag: !s.capture_dead_clicks },
      { name: "Session recording", state: chip(s.session_recording_opt_in ? "active" : "off"), note: s.session_recording_opt_in ? `${s.session_recording_retention_period || "default"} retention` : "Off" },
      { name: "Web vitals", state: chip(s.autocapture_web_vitals_opt_in ? "active" : "off"), note: s.autocapture_web_vitals_opt_in ? "Enabled" : "Off" },
      { name: "Console log recording", state: chip(s.capture_console_log_opt_in ? "active" : "off"), note: s.capture_console_log_opt_in ? "On" : "Off — bug repros will lack console output", flag: !s.capture_console_log_opt_in },
      { name: "Network / performance capture", state: chip(s.capture_performance_opt_in ? "active" : "off"), note: s.capture_performance_opt_in ? (s.session_recording_network_payload_capture_config ? "Full payload capture" : "Timing only, no bodies") : "Not capturing" },
      { name: "Exception autocapture", state: chip(s.autocapture_exceptions_opt_in ? "active" : "off"), note: s.autocapture_exceptions_opt_in ? "On" : "Off — the Exceptions count may undercount real crashes", flag: !s.autocapture_exceptions_opt_in },
    ]},
    { name: "AI features", items: [
      { name: "Session Summaries", state: chip(summariesConfigured ? (summariesCount > 0 ? "active" : "idle") : "unknown"), note: summariesConfigured ? `${summariesCount} summaries generated` : "Not exposed via PostHog's public REST API, no way to verify or use this from the pipeline" },
      { name: "Vision (recording scans)", state: chip(visionConfigured ? (visionCount > 0 ? "active" : "idle") : "unknown"), note: visionConfigured ? `${visionCount} scanners configured${visionCredits ? `, ${visionCredits.remaining ?? "?"} credits idle` : ""}` : "Not exposed via PostHog's public REST API, no way to verify or use this from the pipeline", flag: visionConfigured && visionCount === 0 },
      { name: "LLM Analytics ($ai_* events)", state: chip(hasAiEvents ? "active" : "off"), note: hasAiEvents ? "Seeing $ai_* events" : "No $ai_* events seen" },
    ]},
    { name: "Error Tracking", items: [
      { name: "Error tracking", state: chip(s.autocapture_exceptions_opt_in ? "active" : "off"), note: s.autocapture_exceptions_opt_in ? "Capturing exceptions" : "Disabled — enable to correlate crashes with sessions", flag: !s.autocapture_exceptions_opt_in },
    ]},
    { name: "Product Analytics extras", items: [
      { name: "Heatmaps", state: chip(s.heatmaps_opt_in ? "active" : "off"), note: s.heatmaps_opt_in ? "Collecting" : "Off" },
      { name: "Revenue Analytics", state: chip((s.revenue_analytics_config && (s.revenue_analytics_config.events || []).length) ? "active" : "idle"), note: s.revenue_analytics_config ? "Configured" : "Not configured" },
      { name: "Customer Analytics mapping", state: chip(s.customer_analytics_config && s.customer_analytics_config.signup_event ? "active" : "idle"), note: s.customer_analytics_config ? "Partially mapped — check signup/subscription/payment events" : "Not configured" },
    ]},
    { name: "Access & compliance", items: [
      { name: "Access control / password sharing", state: chip(s.access_control ? "active" : "off"), note: s.access_control ? "On" : "Plan-gated · not enabled" },
      { name: "IP anonymization", state: chip(s.anonymize_ips ? "active" : "off"), note: s.anonymize_ips ? "On" : "Off" },
      { name: "Cookieless mode", state: chip(s.cookieless_server_hash_mode ? "active" : "off"), note: s.cookieless_server_hash_mode ? "On" : "Off" },
    ]},
  ];

  return {
    projectName: s.name,
    timezone: s.timezone,
    region_meta: `project ${s.id}`,
    customEvents: custom,
    systemEventCount: system.length,
    personProps: discovery.personProps,
    groups,
  };
}

async function inferIdentityMapping(env, personProps, projectName) {
  const candidates = personProps.filter(isCustomProperty);
  if (!candidates.length) return { email: null, name: null, role: null, note: "No custom person properties found — this project may be fully anonymous." };
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 300,
        messages: [{
          role: "user",
          content: `A PostHog project called "${projectName}" has these custom (non-$-prefixed) person properties: ${JSON.stringify(candidates)}.\nPick which one (if any) holds the user's identity email, display name, and role/title. Return ONLY this JSON, no prose: {"email": "<property name or null>", "name": "<property name or null>", "role": "<property name or null>"}`,
        }],
      }),
    });
    const data = await res.json();
    const text = data.content?.[0]?.text || "{}";
    const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
    return { email: parsed.email || null, name: parsed.name || null, role: parsed.role || null };
  } catch (e) {
    const guess = (want) => candidates.find(p => p.toLowerCase() === want) || null;
    return { email: guess("email"), name: guess("name"), role: guess("role"), note: "Agent call failed, used a plain-name-match fallback." };
  }
}

// Walks findings' tasks; any task with a `new_goal` object (and no `goal_id`) gets a
// real goal row created, deduped within this same batch by purpose text, and rewritten
// to reference it by `goal_id`. Existing `goal_id` references pass through untouched.
async function resolveGoals(env, ownerEmail, findings) {
  const createdThisBatch = new Map(); // normalized purpose -> goal id
  for (const f of findings) {
    for (const t of f.tasks || []) {
      if (t.goal_id || !t.new_goal || !t.new_goal.purpose) continue;
      const key = t.new_goal.purpose.trim().toLowerCase();
      let goalId = createdThisBatch.get(key);
      if (!goalId) {
        const result = await env.DB.prepare(
          `INSERT INTO goals (owner_email, purpose, description, tags, source) VALUES (?, ?, ?, ?, 'auto')`
        ).bind(
          ownerEmail,
          t.new_goal.purpose.trim(),
          t.new_goal.description || null,
          JSON.stringify(t.new_goal.tags || [])
        ).run();
        goalId = result.meta.last_row_id;
        createdThisBatch.set(key, goalId);
      }
      t.goal_id = goalId;
      delete t.new_goal;
    }
  }
  return { findings, count: createdThisBatch.size };
}

const TAG_PALETTE = ["#e11d48", "#ea580c", "#ca8a04", "#16a34a", "#0891b2", "#2563eb", "#7c3aed", "#db2777"];

// Finds the task by session_id + task_index inside whatever report is currently
// latest for this owner. Returns null if there's no report yet, or if that
// session/task isn't in it (a newer pipeline run replaced it). Shared by every
// route that needs to read or patch a single already-pushed task in place.
async function loadTaskForMutation(env, ownerEmail, sessionId, taskIndex) {
  const report = await env.DB.prepare("SELECT * FROM reports WHERE owner_email = ? ORDER BY id DESC LIMIT 1").bind(ownerEmail).first();
  if (!report) return null;
  const micro = JSON.parse(report.micro_findings);
  const finding = micro.find(f => f.session_id === sessionId);
  const task = finding && finding.tasks && finding.tasks[taskIndex];
  if (!task) return null;
  return { report, micro, finding, task };
}

async function saveMicroFindings(env, reportId, micro) {
  await env.DB.prepare("UPDATE reports SET micro_findings = ? WHERE id = ?")
    .bind(JSON.stringify(micro), reportId)
    .run();
}

async function logConnectionEvent(env, connectionId, kind, status, title, detail, triggerLabel) {
  await env.DB.prepare(
    `INSERT INTO connection_events (connection_id, kind, status, title, detail, trigger_label) VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(connectionId, kind, status, title, detail || null, triggerLabel).run();
}

// Best-effort: appends a media entry to a task via loadTaskForMutation. If that
// session/task isn't in the latest report anymore, this is a no-op, not an
// error, the screenshot is simply dropped, matching this feature's fail-soft
// design (unlike the live tag-mutation routes below, which DO error on a miss,
// since those have a human waiting on the result).
async function mergeMediaIntoTask(env, ownerEmail, sessionId, taskIndex, mediaEntry) {
  const ctx = await loadTaskForMutation(env, ownerEmail, sessionId, taskIndex);
  if (!ctx) return false;
  const { report, micro, task } = ctx;
  if (task.key_timestamp && task.key_timestamp !== mediaEntry.ts) return false;
  task.media = task.media || [];
  task.media.push(mediaEntry);
  await saveMicroFindings(env, report.id, micro);
  return true;
}

// Walks findings' tasks; any tag entry with `new_tag` and no `tag_id` gets a real
// tags row created (source: 'auto'), deduped within this same batch by label,
// with the next color assigned round-robin from TAG_PALETTE. Every entry (new or
// matched-existing) is stamped assign: 'auto' -- everything resolveTags sees was
// just emitted by the pipeline's own LLM call, never a human edit.
async function resolveTags(env, ownerEmail, findings) {
  const createdThisBatch = new Map(); // normalized label -> tag id
  let newlyCreatedCount = 0;
  const countRow = await env.DB.prepare("SELECT COUNT(*) as n FROM tags WHERE owner_email = ?").bind(ownerEmail).first();
  let nextColorIndex = countRow.n;
  for (const f of findings) {
    for (const t of f.tasks || []) {
      if (!Array.isArray(t.tags)) continue;
      for (const tg of t.tags) {
        if (!tg || typeof tg !== "object") continue;
        if (!tg.tag_id && tg.new_tag && tg.new_tag.label) {
          const key = tg.new_tag.label.trim().toLowerCase();
          let tagId = createdThisBatch.get(key);
          if (!tagId) {
            const existing = await env.DB.prepare(
              "SELECT id FROM tags WHERE owner_email = ? AND lower(label) = ?"
            ).bind(ownerEmail, key).first();
            if (existing) {
              tagId = existing.id;
            } else {
              const color = TAG_PALETTE[nextColorIndex % TAG_PALETTE.length];
              nextColorIndex++;
              const result = await env.DB.prepare(
                `INSERT INTO tags (owner_email, label, color, source) VALUES (?, ?, ?, 'auto')`
              ).bind(ownerEmail, tg.new_tag.label.trim(), color).run();
              tagId = result.meta.last_row_id;
              newlyCreatedCount++;
            }
            createdThisBatch.set(key, tagId);
          }
          tg.tag_id = tagId;
        }
        tg.assign = "auto";
        delete tg.new_tag;
      }
    }
  }
  return { findings, count: newlyCreatedCount };
}

async function getLatestReport(db, ownerEmail) {
  const row = await db
    .prepare("SELECT * FROM reports WHERE owner_email = ? ORDER BY id DESC LIMIT 1")
    .bind(ownerEmail)
    .first();
  if (!row) return null;
  return {
    generated_at: row.generated_at,
    macro_themes: JSON.parse(row.macro_themes),
    micro_findings: JSON.parse(row.micro_findings),
  };
}

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

async function postSlackNotifications(env, ownerEmail, findings) {
  try {
    const conn = await env.DB.prepare("SELECT status FROM slack_connections WHERE owner_email = ?").bind(ownerEmail).first();
    if (!conn || conn.status !== "connected") return;
    const { results: rules } = await env.DB.prepare("SELECT * FROM slack_rules WHERE owner_email = ? AND enabled = 1").bind(ownerEmail).all();
    if (!rules.length) return;
    const token = await getSlackBotToken(env, ownerEmail);
    if (!token) return;
    for (const f of findings) {
      for (const t of f.tasks || []) {
        for (const rule of rules) {
          if (!slackRuleMatches(t, rule)) continue;
          const sevEmoji = t.severity === "high" ? "🔴" : t.severity === "medium" ? "🟠" : "⚪";
          const fields = [
            { type: "mrkdwn", text: `*Outcome*\n${t.outcome || "unresolved"}` },
            { type: "mrkdwn", text: `*Real bug*\n${t.real_bug ? "Yes" : "No"}` },
          ];
          const blocks = [
            { type: "section", text: { type: "mrkdwn", text: `${sevEmoji} *${t.title || "Untitled task"}*` } },
            { type: "section", fields },
            { type: "context", elements: [{ type: "mrkdwn", text: `Routed here: ${rule.name}` }] },
          ];
          try {
            await fetch("https://slack.com/api/chat.postMessage", {
              method: "POST",
              headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
              body: JSON.stringify({ channel: rule.channel_id, text: t.title || "A confirmed bug was detected", blocks }),
            });
          } catch (e) {
            // best-effort: a Slack post failure must never fail the report push
            console.error(`Slack post failed for rule ${rule.id} (owner ${ownerEmail}):`, e);
          }
        }
      }
    }
  } catch (e) {
    // best-effort at the outer level too — this function must never throw into its caller
    console.error(`postSlackNotifications failed for owner ${ownerEmail}:`, e);
  }
}

async function getRecentTasksForOwner(env, ownerEmail, limit) {
  const { results: reportRows } = await env.DB.prepare(
    "SELECT micro_findings, generated_at FROM reports WHERE owner_email = ? ORDER BY id DESC LIMIT 10"
  ).bind(ownerEmail).all();
  const flat = [];
  for (const row of reportRows) {
    const findings = JSON.parse(row.micro_findings);
    for (const f of findings) {
      for (const t of f.tasks || []) {
        flat.push({ ...t, _sessionId: f.session_id, _generatedAt: row.generated_at });
      }
    }
  }
  flat.sort((a, b) => {
    const ta = a.key_timestamp || a._generatedAt || "";
    const tb = b.key_timestamp || b._generatedAt || "";
    return tb.localeCompare(ta);
  });
  return flat.slice(0, limit);
}

function relativeAgeLabel(iso) {
  if (!iso) return "";
  const ms = Date.now() - Date.parse(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z");
  if (Number.isNaN(ms) || ms < 0) return "";
  const hrs = Math.round(ms / 3600000);
  return hrs < 24 ? `${hrs}h` : `${Math.round(hrs / 24)}d`;
}

// Merges into the owner's latest existing report rather than blindly replacing it --
// this now runs on an unattended timer instead of only ever by hand, so two bugs that
// were tolerable as an occasional manual annoyance become structural if left as-is:
// (1) a session still inside the rolling lookback window would get re-notified to
// Slack and re-dispatched for screenshot capture on every single run it keeps
// appearing in, and (2) any human-assigned tag on a still-in-window session would get
// silently wiped by the next run's fresh LLM verdict. Both are fixed by diffing
// against the previous report: only genuinely-new sessions get notified/captured, and
// human tags on sessions the new run still recognizes are carried forward.
async function saveGeneratedReport(env, { ownerEmail, connectionId, generatedAt, macroThemes, microFindings, themePrompt, sessionPrompt, captureCount, triggerLabel }) {
  const goalsResult = await resolveGoals(env, ownerEmail, microFindings || []);
  const tagsResult = await resolveTags(env, ownerEmail, goalsResult.findings);
  const newFindings = tagsResult.findings;

  const base = await env.DB.prepare("SELECT * FROM reports WHERE owner_email = ? ORDER BY id DESC LIMIT 1").bind(ownerEmail).first();
  const baseMicro = base ? JSON.parse(base.micro_findings) : [];
  const bySession = new Map(baseMicro.map(f => [f.session_id, f]));
  const genuinelyNewFindings = newFindings.filter(f => !bySession.has(f.session_id));

  for (const f of newFindings) {
    const old = bySession.get(f.session_id);
    if (old) {
      (old.tasks || []).forEach((oldTask, i) => {
        const userTags = (oldTask.tags || []).filter(tg => tg.assign === "user");
        if (userTags.length && f.tasks && f.tasks[i]) {
          const newTask = f.tasks[i];
          newTask.tags = newTask.tags || [];
          for (const ut of userTags) {
            if (!newTask.tags.some(tg => tg.tag_id === ut.tag_id)) newTask.tags.push(ut);
          }
        }
      });
    }
    bySession.set(f.session_id, f);
  }
  const mergedMicro = Array.from(bySession.values());

  await env.DB.prepare(
    `INSERT INTO reports (generated_at, macro_themes, micro_findings, theme_prompt, session_prompt, owner_email, connection_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      generatedAt,
      JSON.stringify(Array.isArray(macroThemes) ? macroThemes : (base ? JSON.parse(base.macro_themes) : [])),
      JSON.stringify(mergedMicro),
      themePrompt || (base ? base.theme_prompt : null),
      sessionPrompt || (base ? base.session_prompt : null),
      ownerEmail,
      connectionId || null
    )
    .run();
  if (connectionId) {
    await env.DB.prepare("UPDATE connections SET last_pipeline_run_at = datetime('now') WHERE id = ?").bind(connectionId).run();
    const taskCount = newFindings.reduce((n, f) => n + (f.tasks || []).length, 0);
    const realBugCount = newFindings.reduce((n, f) => n + (f.tasks || []).filter(t => t.real_bug).length, 0);
    const outreachCount = newFindings.filter(f => f.recommended_outreach).length;
    await logConnectionEvent(
      env, connectionId, "sync_completed", "success", "Sync completed",
      `Pulled ${newFindings.length} sessions · ${taskCount} tasks · ${realBugCount} real bugs · ${outreachCount} outreach · ${goalsResult.count} new goals · ${tagsResult.count} new tags · ${captureCount || 0} moments queued.`,
      triggerLabel || "scheduled"
    );
  }
  await postSlackNotifications(env, ownerEmail, genuinelyNewFindings);
  return { ok: true, findings: newFindings, newFindings: genuinelyNewFindings };
}

const CAPTURE_REPO = "shubhamvishnu/posthog-bug-radar";

async function triggerCaptureViaGithub(env, sessionId, keyTimestamp, connectionId, taskIndex) {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${CAPTURE_REPO}/actions/workflows/capture-screenshot.yml/dispatches`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.GITHUB_TOKEN}`,
          accept: "application/vnd.github+json",
          "content-type": "application/json",
          "user-agent": "bug-radar-worker",
        },
        body: JSON.stringify({
          ref: "main",
          inputs: {
            session_id: sessionId,
            key_timestamp: keyTimestamp,
            connection_id: String(connectionId),
            task_index: String(taskIndex),
          },
        }),
      }
    );
    if (!res.ok) {
      console.error(`[capture] dispatch failed for ${sessionId} task ${taskIndex}: ${res.status} ${await res.text()}`);
      return;
    }
    console.log(`[capture] triggered for ${sessionId} task ${taskIndex}`);
  } catch (e) {
    console.error(`[capture] WARNING: could not trigger for ${sessionId} task ${taskIndex}: ${e.message}`);
  }
}

const PIPELINE_MACRO_WINDOW = "14 DAY";
const PIPELINE_MICRO_WINDOW = "3 DAY";
const PIPELINE_SESSION_WINDOW = "4 DAY"; // micro window + 1 day

async function runPipelineForConnection(env, conn) {
  // Lock (not the heartbeat -- see runPipelineSafely): stamp pipeline_lock_at BEFORE
  // doing any real work. last_pipeline_run_at is left alone here -- it only means
  // "last successful completion" (set by saveGeneratedReport), which is what
  // computeDue needs to decide the NEXT due time. pipeline_lock_at is a separate,
  // short-lived "currently running" flag scheduled() checks so a run that outlives
  // one cron tick can't be picked up a second time before it finishes.
  await env.DB.prepare("UPDATE connections SET pipeline_lock_at = datetime('now') WHERE id = ?").bind(conn.id).run();

  const region = conn.region;
  const projectId = conn.project_id;
  const apiKey = await decryptSecret(env, conn.encrypted_api_key, conn.iv);
  const identity = {
    email: conn.identity_email_prop,
    name: conn.identity_name_prop,
    role: conn.identity_role_prop,
  };
  const customEvents = (conn.config_json ? JSON.parse(conn.config_json) : {}).customEvents || [];
  const sessionLimit = conn.sync_max_sessions || 8;

  const companyRow = await env.DB.prepare("SELECT description FROM company_knowledge WHERE owner_email = ?").bind(conn.owner_email).first();
  const companyContext = companyRow?.description || "No company description saved yet — treat this as a generic web product.";

  const { results: goalRows } = await env.DB.prepare("SELECT id, purpose, description, tags FROM goals WHERE owner_email = ? ORDER BY id").bind(conn.owner_email).all();
  const goals = goalRows.map(g => ({ ...g, tags: JSON.parse(g.tags || "[]") }));
  const goalsContext = goals.length
    ? JSON.stringify(goals.map(g => ({ id: g.id, purpose: g.purpose, description: g.description, tags: g.tags })))
    : "(none yet — every task in this run should propose a new_goal)";

  const { results: tagRows } = await env.DB.prepare("SELECT id, label FROM tags WHERE owner_email = ? ORDER BY id").bind(conn.owner_email).all();
  const tagsContext = tagRows.length
    ? JSON.stringify(tagRows.map(t => ({ id: t.id, label: t.label })))
    : "(none yet — propose a new_tag for any task that clearly needs one)";

  const aiConfig = await resolveAiConfig(env, conn.owner_email);
  console.log(`[llm] routing through ${aiConfig.provider} / ${aiConfig.model} for ${conn.owner_email}`);
  console.log(`[connection] #${conn.id} ${conn.project_name} (${region}) owner=${conn.owner_email}`);

  const clusters = await fetchMacroClusters(region, apiKey, projectId, PIPELINE_MACRO_WINDOW, 25);
  const themePrompt = themePromptFor(companyContext, JSON.stringify(clusters));
  const themes = await callLlm(themePrompt, aiConfig);

  const candidates = await fetchCandidateSessions(region, apiKey, projectId, PIPELINE_MICRO_WINDOW, sessionLimit, identity);

  const findings = [];
  const pendingCaptures = [];
  for (const c of candidates) {
    const sid = c.session_id;
    const events = await fetchSessionEvents(region, apiKey, projectId, sid, PIPELINE_SESSION_WINDOW, customEvents);
    if (!events.length) continue;
    const sessionPrompt = sessionPromptFor(companyContext, goalsContext, tagsContext, JSON.stringify(events));
    const result = await callLlm(sessionPrompt, aiConfig);
    const finding = {
      session_id: sid,
      replay_url: `${PH_REGIONS[region]}/project/${projectId}/replay/${sid}`,
      started_at: c.started_at,
      person: { person_id: c.person_id, email: c.email, name: c.name, role: c.role },
      triage_counts: { dead_clicks: c.dead_clicks, rage_clicks: c.rage_clicks, exceptions: c.exceptions },
      events,
      tasks: result.tasks || [],
      recommended_outreach: result.recommended_outreach || null,
    };
    (finding.tasks || []).forEach((task, idx) => {
      if (task.outcome === "blocked" || task.severity === "high") {
        pendingCaptures.push([sid, task.key_timestamp || c.started_at, idx]);
      }
    });
    findings.push(finding);
  }

  const generatedAt = new Date().toISOString();
  const sessionPromptSample = sessionPromptFor(companyContext, goalsContext, tagsContext, "<per-session events>");
  const saveResult = await saveGeneratedReport(env, {
    ownerEmail: conn.owner_email,
    connectionId: conn.id,
    generatedAt,
    macroThemes: themes,
    microFindings: findings,
    themePrompt,
    sessionPrompt: sessionPromptSample,
    captureCount: pendingCaptures.length,
    triggerLabel: "scheduled",
  });

  // Only dispatch a screenshot capture for sessions that are genuinely new this run --
  // a session still inside the rolling lookback window would otherwise get re-captured
  // every single time it keeps appearing in the candidate list.
  const newSessionIds = new Set(saveResult.newFindings.map(f => f.session_id));
  for (const [sid, keyTs, idx] of pendingCaptures) {
    if (newSessionIds.has(sid)) {
      await triggerCaptureViaGithub(env, sid, keyTs, conn.id, idx);
    }
  }

  const themeCount = Array.isArray(themes) ? themes.length : 0;
  const totalTasks = findings.reduce((n, f) => n + f.tasks.length, 0);
  const realBugs = findings.reduce((n, f) => n + f.tasks.filter(t => t.real_bug).length, 0);
  console.log(`[done] connection #${conn.id}: ${themeCount} macro themes, ${findings.length} sessions -> ${totalTasks} tasks, ${realBugs} real bugs`);
  return { themes: themeCount, sessions: findings.length, tasks: totalTasks, real_bugs: realBugs };
}

async function runPipelineForConnectionTargeted(env, conn, sessionIds) {
  // Same lock rationale as runPipelineForConnection: stamps pipeline_lock_at
  // (not last_pipeline_run_at) before any real work, so two overlapping manual
  // run-now calls on the same connection can't race each other's D1 writes.
  await env.DB.prepare("UPDATE connections SET pipeline_lock_at = datetime('now') WHERE id = ?").bind(conn.id).run();

  const region = conn.region;
  const projectId = conn.project_id;
  const apiKey = await decryptSecret(env, conn.encrypted_api_key, conn.iv);
  const identity = {
    email: conn.identity_email_prop,
    name: conn.identity_name_prop,
    role: conn.identity_role_prop,
  };
  const customEvents = (conn.config_json ? JSON.parse(conn.config_json) : {}).customEvents || [];

  const companyRow = await env.DB.prepare("SELECT description FROM company_knowledge WHERE owner_email = ?").bind(conn.owner_email).first();
  const companyContext = companyRow?.description || "No company description saved yet — treat this as a generic web product.";

  const { results: goalRows } = await env.DB.prepare("SELECT id, purpose, description, tags FROM goals WHERE owner_email = ? ORDER BY id").bind(conn.owner_email).all();
  const goals = goalRows.map(g => ({ ...g, tags: JSON.parse(g.tags || "[]") }));
  const goalsContext = goals.length
    ? JSON.stringify(goals.map(g => ({ id: g.id, purpose: g.purpose, description: g.description, tags: g.tags })))
    : "(none yet — every task in this run should propose a new_goal)";

  const { results: tagRows } = await env.DB.prepare("SELECT id, label FROM tags WHERE owner_email = ? ORDER BY id").bind(conn.owner_email).all();
  const tagsContext = tagRows.length
    ? JSON.stringify(tagRows.map(t => ({ id: t.id, label: t.label })))
    : "(none yet — propose a new_tag for any task that clearly needs one)";

  const aiConfig = await resolveAiConfig(env, conn.owner_email);
  const candidates = await fetchSessionsById(region, apiKey, projectId, sessionIds, identity, 30);

  const findings = [];
  const pendingCaptures = [];
  for (const c of candidates) {
    const sid = c.session_id;
    const events = await fetchSessionEvents(region, apiKey, projectId, sid, "30 DAY", customEvents);
    if (!events.length) continue;
    const sessionPrompt = sessionPromptFor(companyContext, goalsContext, tagsContext, JSON.stringify(events));
    const result = await callLlm(sessionPrompt, aiConfig);
    const finding = {
      session_id: sid,
      replay_url: `${PH_REGIONS[region]}/project/${projectId}/replay/${sid}`,
      started_at: c.started_at,
      person: { person_id: c.person_id, email: c.email, name: c.name, role: c.role },
      triage_counts: { dead_clicks: c.dead_clicks, rage_clicks: c.rage_clicks, exceptions: c.exceptions },
      events,
      tasks: result.tasks || [],
      recommended_outreach: result.recommended_outreach || null,
    };
    (finding.tasks || []).forEach((task, idx) => {
      if (task.outcome === "blocked" || task.severity === "high") {
        pendingCaptures.push([sid, task.key_timestamp || c.started_at, idx]);
      }
    });
    findings.push(finding);
  }

  const sessionPromptSample = sessionPromptFor(companyContext, goalsContext, tagsContext, "<per-session events>");
  const goalsResult = await resolveGoals(env, conn.owner_email, findings);
  const tagsResult = await resolveTags(env, conn.owner_email, goalsResult.findings);
  const resolvedFindings = tagsResult.findings;

  const base = await env.DB.prepare("SELECT * FROM reports WHERE owner_email = ? ORDER BY id DESC LIMIT 1").bind(conn.owner_email).first();
  const baseMicro = base ? JSON.parse(base.micro_findings) : [];
  const baseMacro = base ? JSON.parse(base.macro_themes) : [];
  const bySession = new Map(baseMicro.map(f => [f.session_id, f]));
  for (const f of resolvedFindings) {
    const old = bySession.get(f.session_id);
    if (old) {
      (old.tasks || []).forEach((oldTask, i) => {
        const userTags = (oldTask.tags || []).filter(tg => tg.assign === "user");
        if (userTags.length && f.tasks && f.tasks[i]) {
          const newTask = f.tasks[i];
          newTask.tags = newTask.tags || [];
          for (const ut of userTags) {
            if (!newTask.tags.some(tg => tg.tag_id === ut.tag_id)) newTask.tags.push(ut);
          }
        }
      });
    }
    bySession.set(f.session_id, f);
  }
  const mergedMicro = Array.from(bySession.values());
  await env.DB.prepare(
    `INSERT INTO reports (generated_at, macro_themes, micro_findings, theme_prompt, session_prompt, owner_email, connection_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    new Date().toISOString(), JSON.stringify(baseMacro), JSON.stringify(mergedMicro),
    base ? base.theme_prompt : null, sessionPromptSample, conn.owner_email, conn.id
  ).run();
  await env.DB.prepare("UPDATE connections SET last_pipeline_run_at = datetime('now') WHERE id = ?").bind(conn.id).run();
  const taskCount = resolvedFindings.reduce((n, f) => n + (f.tasks || []).length, 0);
  const realBugCount = resolvedFindings.reduce((n, f) => n + (f.tasks || []).filter(t => t.real_bug).length, 0);
  const outreachCount = resolvedFindings.filter(f => f.recommended_outreach).length;
  await logConnectionEvent(
    env, conn.id, "sync_completed", "success", "Sync completed",
    `Pulled ${resolvedFindings.length} sessions · ${taskCount} tasks · ${realBugCount} real bugs · ${outreachCount} outreach · ${goalsResult.count} new goals · ${tagsResult.count} new tags · ${pendingCaptures.length} moments queued.`,
    "manual · targeted"
  );
  await postSlackNotifications(env, conn.owner_email, resolvedFindings);

  for (const [sid, keyTs, idx] of pendingCaptures) {
    await triggerCaptureViaGithub(env, sid, keyTs, conn.id, idx);
  }
  return { sessions: resolvedFindings.length, tasks: taskCount, real_bugs: realBugCount };
}

async function runPipelineSafely(env, conn, sessionIds) {
  try {
    const result = sessionIds
      ? await runPipelineForConnectionTargeted(env, conn, sessionIds)
      : await runPipelineForConnection(env, conn);
    return { ok: true, ...result };
  } catch (e) {
    console.error(`ERROR: pipeline run failed for connection ${conn.id}: ${e.message}`);
    await logConnectionEvent(env, conn.id, "sync_failed", "error", "Sync failed", e.message || "Unknown error", sessionIds ? "manual · targeted" : "scheduled").catch(() => {});
    return { ok: false, error: e.message };
  } finally {
    // Always clear the lock, success or failure, so a genuinely-finished run never
    // blocks the next legitimate one.
    await env.DB.prepare("UPDATE connections SET pipeline_lock_at = NULL WHERE id = ?").bind(conn.id).run().catch(() => {});
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === "/api/auth/request-otp" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const email = String(body.email || "").trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return json({ error: "Enter a valid email address." }, 400);
      }
      const recent = await env.DB.prepare(
        "SELECT created_at FROM otp_codes WHERE email = ? AND surface = 'main' ORDER BY id DESC LIMIT 1"
      ).bind(email).first();
      if (recent && Date.now() - sqliteTimeToMs(recent.created_at) < OTP_RESEND_COOLDOWN_MS) {
        return json({ error: "Please wait before requesting another code." }, 429);
      }
      const code = randomOtp();
      const expiresAt = new Date(Date.now() + OTP_TTL_MS).toISOString();
      await env.DB.prepare("INSERT INTO otp_codes (email, code, expires_at, surface) VALUES (?, ?, ?, 'main')")
        .bind(email, code, expiresAt)
        .run();
      try {
        await sendOtpEmail(env, email, code);
      } catch (e) {
        return json({ error: "Could not send the email. Try again in a moment." }, 502);
      }
      return json({ ok: true });
    }

    if (pathname === "/api/auth/verify-otp" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const email = String(body.email || "").trim().toLowerCase();
      const code = String(body.code || "").trim();
      const row = await env.DB.prepare(
        "SELECT * FROM otp_codes WHERE email = ? AND consumed = 0 AND surface = 'main' ORDER BY id DESC LIMIT 1"
      ).bind(email).first();
      if (!row || Date.parse(row.expires_at) < Date.now()) {
        return json({ error: "That code has expired. Request a new one." }, 401);
      }
      if (row.attempts >= OTP_MAX_ATTEMPTS) {
        return json({ error: "Too many attempts. Request a new code." }, 401);
      }
      if (row.code !== code) {
        await env.DB.prepare("UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?").bind(row.id).run();
        return json({ error: "That code doesn't match." }, 401);
      }
      await env.DB.prepare("UPDATE otp_codes SET consumed = 1 WHERE id = ?").bind(row.id).run();
      await env.DB.prepare("INSERT OR IGNORE INTO users (email) VALUES (?)").bind(email).run();
      const token = crypto.randomUUID();
      const maxAge = SESSION_DAYS * 24 * 60 * 60;
      const expiresAt = new Date(Date.now() + maxAge * 1000).toISOString();
      await env.DB.prepare("INSERT INTO sessions (token, email, expires_at, surface) VALUES (?, ?, ?, 'main')")
        .bind(token, email, expiresAt)
        .run();
      return json({ ok: true, email }, 200, { "set-cookie": sessionCookieHeader(token, maxAge) });
    }

    if (pathname === "/api/auth/me" && request.method === "GET") {
      const email = await getSessionEmail(request, env);
      if (!email) return json({ error: "not authenticated" }, 401);
      return json({ email });
    }

    if (pathname === "/api/auth/logout" && request.method === "POST") {
      const token = getCookie(request, SESSION_COOKIE);
      if (token) await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
      return json({ ok: true }, 200, { "set-cookie": sessionCookieHeader("", 0) });
    }

    if (pathname === "/api/report" && request.method === "GET") {
      const email = await getSessionEmail(request, env);
      if (!email) return json({ error: "not authenticated" }, 401);
      const report = await getLatestReport(env.DB, email);
      if (!report) return json({ error: "no report yet" }, 404);
      return json(report);
    }

    if (pathname === "/api/report" && request.method === "POST") {
      const auth = request.headers.get("authorization") || "";
      if (auth !== `Bearer ${env.BUGRADAR_API_SECRET}`) {
        return json({ error: "unauthorized" }, 401);
      }
      const body = await request.json();
      const ownerEmail = body.owner_email || DEFAULT_OWNER_EMAIL;
      await saveGeneratedReport(env, {
        ownerEmail,
        connectionId: body.connection_id || null,
        generatedAt: body.generated_at,
        macroThemes: body.macro_themes,
        microFindings: body.micro_findings,
        themePrompt: body.theme_prompt,
        sessionPrompt: body.session_prompt,
        captureCount: body.capture_count,
        triggerLabel: "scheduled",
      });
      return json({ ok: true });
    }

    /* pipeline-only routes: service auth via BUGRADAR_API_SECRET, not user session */
    function pipelineAuthed(request, env) {
      return !!env.BUGRADAR_API_SECRET && (request.headers.get("authorization") || "") === `Bearer ${env.BUGRADAR_API_SECRET}`;
    }

    /* admin-only routes: service auth via ADMIN_MEDIA_SECRET, not user session */
    function adminSecretAuthed(request, env) {
      const auth = request.headers.get("authorization") || "";
      return !!env.ADMIN_MEDIA_SECRET && auth === `Bearer ${env.ADMIN_MEDIA_SECRET}`;
    }

    if (pathname === "/api/pipeline/connections" && request.method === "GET") {
      if (!pipelineAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      const { results } = await env.DB.prepare(
        `SELECT c.id, c.owner_email, c.region, c.project_id, c.project_name, c.timezone, c.status,
                c.identity_email_prop, c.identity_name_prop, c.identity_role_prop,
                c.sync_freq, c.sync_max_sessions, c.last_pipeline_run_at, cc.config_json
         FROM connections c LEFT JOIN connection_config cc ON cc.connection_id = c.id
         ORDER BY c.id`
      ).all();
      return json(results.map(r => ({
        ...r,
        config: r.config_json ? JSON.parse(r.config_json) : null,
        config_json: undefined,
        due: computeDue(r.sync_freq, r.last_pipeline_run_at),
      })));
    }

    const pipelineConnMatch = pathname.match(/^\/api\/pipeline\/connections\/(\d+)$/);
    if (pipelineConnMatch && request.method === "GET") {
      if (!pipelineAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      const id = Number(pipelineConnMatch[1]);
      const conn = await env.DB.prepare(
        `SELECT c.*, cc.config_json FROM connections c LEFT JOIN connection_config cc ON cc.connection_id = c.id WHERE c.id = ?`
      ).bind(id).first();
      if (!conn) return json({ error: "not found" }, 404);
      const apiKey = await decryptSecret(env, conn.encrypted_api_key, conn.iv);
      return json({
        id: conn.id, owner_email: conn.owner_email, region: conn.region, project_id: conn.project_id,
        project_name: conn.project_name, timezone: conn.timezone, api_key: apiKey,
        identity_email_prop: conn.identity_email_prop, identity_name_prop: conn.identity_name_prop, identity_role_prop: conn.identity_role_prop,
        config: conn.config_json ? JSON.parse(conn.config_json) : null,
      });
    }

    const runNowMatch = pathname.match(/^\/api\/admin\/connections\/(\d+)\/run-now$/);
    if (runNowMatch && request.method === "POST") {
      if (!pipelineAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      const id = Number(runNowMatch[1]);
      const conn = await env.DB.prepare(
        `SELECT c.*, cc.config_json FROM connections c LEFT JOIN connection_config cc ON cc.connection_id = c.id WHERE c.id = ?`
      ).bind(id).first();
      if (!conn) return json({ error: "not found" }, 404);
      const body = await request.json().catch(() => ({}));
      const sessionIds = Array.isArray(body.session_ids) && body.session_ids.length ? body.session_ids : null;
      const result = await runPipelineSafely(env, conn, sessionIds);
      return json(result, result.ok ? 200 : 500);
    }

    if (pathname === "/api/pipeline/company-knowledge" && request.method === "GET") {
      if (!pipelineAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      const ownerEmail = url.searchParams.get("owner_email");
      if (!ownerEmail) return json({ error: "owner_email required" }, 400);
      const row = await env.DB.prepare("SELECT domain, description FROM company_knowledge WHERE owner_email = ?").bind(ownerEmail).first();
      return json(row || { domain: "", description: "" });
    }

    if (pathname === "/api/pipeline/goals" && request.method === "GET") {
      if (!pipelineAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      const ownerEmail = url.searchParams.get("owner_email");
      if (!ownerEmail) return json({ error: "owner_email required" }, 400);
      const { results } = await env.DB.prepare(
        "SELECT id, purpose, description, tags FROM goals WHERE owner_email = ? ORDER BY id"
      ).bind(ownerEmail).all();
      return json(results.map(g => ({ ...g, tags: JSON.parse(g.tags || "[]") })));
    }

    if (pathname === "/api/pipeline/tags" && request.method === "GET") {
      if (!pipelineAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      const ownerEmail = url.searchParams.get("owner_email");
      if (!ownerEmail) return json({ error: "owner_email required" }, 400);
      const { results } = await env.DB.prepare(
        "SELECT id, label, color, source FROM tags WHERE owner_email = ? ORDER BY id"
      ).bind(ownerEmail).all();
      return json(results);
    }

    if (pathname === "/api/pipeline/ai-config" && request.method === "GET") {
      if (!pipelineAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      const ownerEmail = url.searchParams.get("owner_email");
      if (!ownerEmail) return json({ error: "owner_email required" }, 400);
      try {
        const config = await resolveAiConfig(env, ownerEmail);
        return json(config);
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    if (pathname === "/api/pipeline/report/merge" && request.method === "POST") {
      if (!pipelineAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      const body = await request.json().catch(() => ({}));
      const { owner_email: ownerEmail, connection_id: connectionId, findings: newFindings, session_prompt: sessionPrompt } = body;
      if (!ownerEmail || !Array.isArray(newFindings) || !newFindings.length) {
        return json({ error: "owner_email and a non-empty findings array are required" }, 400);
      }
      const base = await env.DB.prepare("SELECT * FROM reports WHERE owner_email = ? ORDER BY id DESC LIMIT 1").bind(ownerEmail).first();
      const baseMicro = base ? JSON.parse(base.micro_findings) : [];
      const baseMacro = base ? JSON.parse(base.macro_themes) : [];
      const goalsResult = await resolveGoals(env, ownerEmail, newFindings);
      const tagsResult = await resolveTags(env, ownerEmail, goalsResult.findings);
      const resolvedNewFindings = tagsResult.findings;
      const bySession = new Map(baseMicro.map(f => [f.session_id, f]));
      for (const f of resolvedNewFindings) {
        const old = bySession.get(f.session_id);
        if (old) {
          (old.tasks || []).forEach((oldTask, i) => {
            const userTags = (oldTask.tags || []).filter(tg => tg.assign === "user");
            if (userTags.length && f.tasks && f.tasks[i]) {
              const newTask = f.tasks[i];
              newTask.tags = newTask.tags || [];
              for (const ut of userTags) {
                if (!newTask.tags.some(tg => tg.tag_id === ut.tag_id)) {
                  newTask.tags.push(ut);
                }
              }
            }
          });
        }
        bySession.set(f.session_id, f);
      }
      const mergedMicro = Array.from(bySession.values());
      const resolvedConnectionId = connectionId || (base ? base.connection_id : null);
      await env.DB.prepare(
        `INSERT INTO reports (generated_at, macro_themes, micro_findings, theme_prompt, session_prompt, owner_email, connection_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        new Date().toISOString(),
        JSON.stringify(baseMacro),
        JSON.stringify(mergedMicro),
        base ? base.theme_prompt : null,
        sessionPrompt || (base ? base.session_prompt : null),
        ownerEmail,
        resolvedConnectionId
      ).run();
      if (resolvedConnectionId) {
        await env.DB.prepare("UPDATE connections SET last_pipeline_run_at = datetime('now') WHERE id = ?").bind(resolvedConnectionId).run();
        const taskCount = resolvedNewFindings.reduce((n, f) => n + (f.tasks || []).length, 0);
        const realBugCount = resolvedNewFindings.reduce((n, f) => n + (f.tasks || []).filter(t => t.real_bug).length, 0);
        const outreachCount = resolvedNewFindings.filter(f => f.recommended_outreach).length;
        const captureCount = Number(body.capture_count) || 0;
        await logConnectionEvent(
          env, resolvedConnectionId, "sync_completed", "success", "Sync completed",
          `Pulled ${resolvedNewFindings.length} sessions · ${taskCount} tasks · ${realBugCount} real bugs · ${outreachCount} outreach · ${goalsResult.count} new goals · ${tagsResult.count} new tags · ${captureCount} moments queued.`,
          "manual · targeted"
        );
      }
      await postSlackNotifications(env, ownerEmail, resolvedNewFindings);
      return json({ ok: true, merged_session_ids: newFindings.map(f => f.session_id), total_findings: mergedMicro.length });
    }

    const touchMatch = pathname.match(/^\/api\/pipeline\/connections\/(\d+)\/touch$/);
    if (touchMatch && request.method === "POST") {
      if (!pipelineAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      const id = Number(touchMatch[1]);
      await env.DB.prepare("UPDATE connections SET last_pipeline_run_at = datetime('now') WHERE id = ?").bind(id).run();
      return json({ ok: true });
    }

    const syncFailedMatch = pathname.match(/^\/api\/pipeline\/connections\/(\d+)\/sync-failed$/);
    if (syncFailedMatch && request.method === "POST") {
      if (!pipelineAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      const id = Number(syncFailedMatch[1]);
      const body = await request.json().catch(() => ({}));
      await logConnectionEvent(env, id, "sync_failed", "error", "Sync failed", String(body.error || "Unknown error"), "scheduled");
      return json({ ok: true });
    }

    if (pathname === "/api/pipeline/media" && request.method === "POST") {
      if (!pipelineAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      const sessionId = url.searchParams.get("session_id");
      const taskIndexRaw = url.searchParams.get("task_index");
      const taskIndex = Number(taskIndexRaw);
      const ownerEmail = url.searchParams.get("owner_email");
      const ts = url.searchParams.get("ts") || "";
      if (!sessionId || taskIndexRaw === null || taskIndexRaw === "" || !Number.isInteger(taskIndex) || taskIndex < 0 || !ownerEmail) {
        return json({ error: "session_id, task_index, owner_email required" }, 400);
      }
      const bytes = await request.arrayBuffer();
      if (!bytes.byteLength) return json({ error: "empty body" }, 400);
      const key = `media/${encodeURIComponent(ownerEmail)}/${sessionId}/${taskIndex}/${crypto.randomUUID()}.png`;
      await env.MEDIA.put(key, bytes, { httpMetadata: { contentType: "image/png" } });
      const merged = await mergeMediaIntoTask(env, ownerEmail, sessionId, taskIndex, { ts, isImg: true, url: `/api/media/${key}` });
      return json({ ok: true, url: `/api/media/${key}`, merged });
    }

    const mediaMatch = pathname.match(/^\/api\/media\/(.+)$/);
    if (mediaMatch && request.method === "GET") {
      const email = await getSessionEmail(request, env);
      if (!email) return json({ error: "not authenticated" }, 401);
      const key = mediaMatch[1];
      const keyOwner = key.split("/")[1];
      if (!keyOwner || decodeURIComponent(keyOwner) !== email) return json({ error: "not found" }, 404);
      const obj = await env.MEDIA.get(key);
      if (!obj) return json({ error: "not found" }, 404);
      return new Response(obj.body, {
        headers: {
          "content-type": obj.httpMetadata?.contentType || "image/png",
          "cache-control": "private, max-age=31536000, immutable",
        },
      });
    }

    const adminMediaMatch = pathname.match(/^\/api\/admin\/media\/(.+)$/);
    if (adminMediaMatch && request.method === "GET") {
      const auth = request.headers.get("authorization") || "";
      if (!env.ADMIN_MEDIA_SECRET || auth !== `Bearer ${env.ADMIN_MEDIA_SECRET}`) return json({ error: "unauthorized" }, 401);
      const key = adminMediaMatch[1];
      const obj = await env.MEDIA.get(key);
      if (!obj) return json({ error: "not found" }, 404);
      return new Response(obj.body, {
        headers: {
          "content-type": obj.httpMetadata?.contentType || "image/png",
          "cache-control": "private, max-age=31536000, immutable",
        },
      });
    }

    if (pathname === "/api/admin/ai-providers" && request.method === "GET") {
      if (!adminSecretAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      const { results } = await env.DB.prepare(
        "SELECT provider, encrypted_api_key, iv, default_model FROM ai_provider_defaults"
      ).all();
      const out = {};
      for (const p of AI_PROVIDERS) out[p] = { configured: false, masked_key: null, default_model: null };
      for (const row of results) {
        const plaintext = await decryptSecret(env, row.encrypted_api_key, row.iv);
        out[row.provider] = { configured: true, masked_key: maskKey(plaintext), default_model: row.default_model };
      }
      return json(out);
    }

    const providerPutMatch = pathname.match(/^\/api\/admin\/ai-providers\/([^/]+)$/);
    if (providerPutMatch && request.method === "PUT") {
      if (!adminSecretAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      const provider = providerPutMatch[1];
      if (!AI_PROVIDERS.includes(provider)) return json({ error: "unknown provider" }, 400);
      const body = await request.json().catch(() => ({}));
      const defaultModel = String(body.default_model || "").trim();
      if (!defaultModel) return json({ error: "default_model required" }, 400);
      if (body.api_key) {
        const { ciphertext, iv } = await encryptSecret(env, String(body.api_key));
        await env.DB.prepare(
          `INSERT INTO ai_provider_defaults (provider, encrypted_api_key, iv, default_model, updated_at)
           VALUES (?, ?, ?, ?, datetime('now'))
           ON CONFLICT(provider) DO UPDATE SET encrypted_api_key = ?, iv = ?, default_model = ?, updated_at = datetime('now')`
        ).bind(provider, ciphertext, iv, defaultModel, ciphertext, iv, defaultModel).run();
      } else {
        const existing = await env.DB.prepare("SELECT provider FROM ai_provider_defaults WHERE provider = ?").bind(provider).first();
        if (!existing) return json({ error: "api_key required for first-time setup" }, 400);
        await env.DB.prepare(
          "UPDATE ai_provider_defaults SET default_model = ?, updated_at = datetime('now') WHERE provider = ?"
        ).bind(defaultModel, provider).run();
      }
      return json({ ok: true });
    }

    const modelsListMatch = pathname.match(/^\/api\/admin\/ai-providers\/([^/]+)\/models$/);
    if (modelsListMatch && request.method === "GET") {
      if (!adminSecretAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      const provider = modelsListMatch[1];
      if (!AI_PROVIDERS.includes(provider)) return json({ error: "unknown provider" }, 400);
      const def = await env.DB.prepare(
        "SELECT encrypted_api_key, iv FROM ai_provider_defaults WHERE provider = ?"
      ).bind(provider).first();
      if (!def) return json({ error: "no default key configured for this provider" }, 400);
      try {
        const apiKey = await decryptSecret(env, def.encrypted_api_key, def.iv);
        const models = await fetchProviderModels(provider, apiKey);
        return json({ models });
      } catch (e) {
        return json({ error: e.message }, 502);
      }
    }

    const tenantConfigMatch = pathname.match(/^\/api\/admin\/ai-config\/([^/]+)$/);
    if (tenantConfigMatch && request.method === "GET") {
      if (!adminSecretAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      const ownerEmail = decodeURIComponent(tenantConfigMatch[1]).trim().toLowerCase();
      const row = await env.DB.prepare(
        "SELECT provider, model, encrypted_api_key FROM tenant_ai_config WHERE owner_email = ?"
      ).bind(ownerEmail).first();
      let resolved;
      try {
        resolved = await resolveAiConfig(env, ownerEmail);
      } catch (e) {
        return json({ error: e.message }, 500);
      }
      return json({
        provider: resolved.provider,
        model: resolved.model,
        is_override: !!row,
        has_custom_key: !!(row && row.encrypted_api_key),
        masked_key: maskKey(resolved.api_key),
      });
    }

    if (tenantConfigMatch && request.method === "PUT") {
      if (!adminSecretAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      const ownerEmail = decodeURIComponent(tenantConfigMatch[1]).trim().toLowerCase();
      const body = await request.json().catch(() => ({}));
      const provider = String(body.provider || "").trim();
      const model = String(body.model || "").trim();
      const useCustomKey = !!body.use_custom_key;
      if (!AI_PROVIDERS.includes(provider)) return json({ error: "unknown provider" }, 400);
      if (!model) return json({ error: "model required" }, 400);

      if (!useCustomKey) {
        await env.DB.prepare(
          `INSERT INTO tenant_ai_config (owner_email, provider, model, encrypted_api_key, iv, updated_at)
           VALUES (?, ?, ?, NULL, NULL, datetime('now'))
           ON CONFLICT(owner_email) DO UPDATE SET provider = ?, model = ?, encrypted_api_key = NULL, iv = NULL, updated_at = datetime('now')`
        ).bind(ownerEmail, provider, model, provider, model).run();
      } else if (body.api_key) {
        const { ciphertext, iv } = await encryptSecret(env, String(body.api_key));
        await env.DB.prepare(
          `INSERT INTO tenant_ai_config (owner_email, provider, model, encrypted_api_key, iv, updated_at)
           VALUES (?, ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(owner_email) DO UPDATE SET provider = ?, model = ?, encrypted_api_key = ?, iv = ?, updated_at = datetime('now')`
        ).bind(ownerEmail, provider, model, ciphertext, iv, provider, model, ciphertext, iv).run();
      } else {
        const existing = await env.DB.prepare(
          "SELECT encrypted_api_key FROM tenant_ai_config WHERE owner_email = ?"
        ).bind(ownerEmail).first();
        if (!existing || !existing.encrypted_api_key) {
          return json({ error: "custom key required (none on file yet)" }, 400);
        }
        await env.DB.prepare(
          `INSERT INTO tenant_ai_config (owner_email, provider, model, updated_at)
           VALUES (?, ?, ?, datetime('now'))
           ON CONFLICT(owner_email) DO UPDATE SET provider = ?, model = ?, updated_at = datetime('now')`
        ).bind(ownerEmail, provider, model, provider, model).run();
      }
      return json({ ok: true });
    }

    if (tenantConfigMatch && request.method === "DELETE") {
      if (!adminSecretAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      const ownerEmail = decodeURIComponent(tenantConfigMatch[1]).trim().toLowerCase();
      await env.DB.prepare("DELETE FROM tenant_ai_config WHERE owner_email = ?").bind(ownerEmail).run();
      return json({ ok: true });
    }

    if (pathname === "/api/prompts" && request.method === "GET") {
      const email = await getSessionEmail(request, env);
      if (!email) return json({ error: "not authenticated" }, 401);
      const row = await env.DB
        .prepare("SELECT theme_prompt, session_prompt FROM reports WHERE owner_email = ? ORDER BY id DESC LIMIT 1")
        .bind(email)
        .first();
      if (!row) return json({ error: "no report yet" }, 404);
      return json({ theme: row.theme_prompt, session: row.session_prompt });
    }

    if (pathname === "/api/corrections" && request.method === "GET") {
      const email = await getSessionEmail(request, env);
      if (!email) return json({ error: "not authenticated" }, 401);
      const { results } = await env.DB
        .prepare("SELECT * FROM corrections WHERE owner_email = ? ORDER BY id DESC")
        .bind(email)
        .all();
      return json(results);
    }

    if (pathname === "/api/corrections" && request.method === "POST") {
      const email = await getSessionEmail(request, env);
      if (!email) return json({ error: "not authenticated" }, 401);
      const body = await request.json();
      if (!body.session_id || !body.field || !body.reason) {
        return json({ error: "session_id, field, and reason are required" }, 400);
      }
      await env.DB.prepare(
        `INSERT INTO corrections (session_id, task_index, task_title, task_goal, field, from_value, to_value, reason, owner_email)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          body.session_id,
          body.task_index ?? 0,
          body.task_title || null,
          body.task_goal || null,
          body.field,
          body.from === undefined || body.from === null ? null : String(body.from),
          body.to === undefined || body.to === null ? null : String(body.to),
          body.reason,
          email
        )
        .run();
      return json({ ok: true });
    }

    if (pathname === "/api/connections/resolve" && request.method === "POST") {
      const email = await getSessionEmail(request, env);
      if (!email) return json({ error: "not authenticated" }, 401);
      const body = await request.json().catch(() => ({}));
      const apiKey = String(body.api_key || "").trim();
      if (!apiKey) return json({ error: "API key required" }, 400);
      try {
        const { region, projects } = await detectRegionAndProjects(apiKey);
        return json({ region, projects });
      } catch (e) {
        return json({ error: e.message || "Could not validate this key." }, e.status || 502);
      }
    }

    if (pathname === "/api/connections/discover" && request.method === "POST") {
      const email = await getSessionEmail(request, env);
      if (!email) return json({ error: "not authenticated" }, 401);
      const body = await request.json().catch(() => ({}));
      const { api_key: apiKey, region, project_id: projectId } = body;
      if (!apiKey || !region || !projectId) return json({ error: "api_key, region, project_id required" }, 400);
      try {
        const discovery = await discoverProject(region, apiKey, projectId);
        const configMap = buildConfigMap(discovery);
        const identity = await inferIdentityMapping(env, discovery.personProps, configMap.projectName);
        return json({ configMap, identity });
      } catch (e) {
        return json({ error: e.message || "Discovery failed." }, e.status || 502);
      }
    }

    if (pathname === "/api/connections/save" && request.method === "POST") {
      const email = await getSessionEmail(request, env);
      if (!email) return json({ error: "not authenticated" }, 401);
      const body = await request.json().catch(() => ({}));
      const { api_key: apiKey, region, project_id: projectId, config_map: configMap, identity } = body;
      if (!apiKey || !region || !projectId || !configMap) return json({ error: "missing fields" }, 400);
      const { ciphertext, iv } = await encryptSecret(env, apiKey);
      const result = await env.DB.prepare(
        `INSERT INTO connections (owner_email, region, project_id, project_name, timezone, encrypted_api_key, iv, identity_email_prop, identity_name_prop, identity_role_prop, status, last_synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'healthy', datetime('now'))`
      ).bind(
        email, region, String(projectId), configMap.projectName || null, configMap.timezone || null,
        ciphertext, iv,
        identity?.email || null, identity?.name || null, identity?.role || null
      ).run();
      const connectionId = result.meta.last_row_id;
      await env.DB.prepare(
        `INSERT INTO connection_config (connection_id, config_json) VALUES (?, ?)`
      ).bind(connectionId, JSON.stringify(configMap)).run();
      await logConnectionEvent(
        env, connectionId, "connection_established", "success", "Connection established",
        `PostHog project "${configMap.projectName || String(projectId)}" linked.`, `you · ${email}`
      );
      return json({ ok: true, connection_id: connectionId });
    }

    if (pathname === "/api/connections" && request.method === "GET") {
      const email = await getSessionEmail(request, env);
      if (!email) return json({ error: "not authenticated" }, 401);
      const { results } = await env.DB.prepare(
        `SELECT c.id, c.region, c.project_id, c.project_name, c.timezone, c.status, c.last_error, c.last_synced_at,
                c.identity_email_prop, c.identity_name_prop, c.identity_role_prop,
                c.sync_freq, c.sync_max_sessions, c.last_pipeline_run_at, cc.config_json
         FROM connections c LEFT JOIN connection_config cc ON cc.connection_id = c.id
         WHERE c.owner_email = ? ORDER BY c.id DESC`
      ).bind(email).all();
      return json(results.map(r => ({
        ...r,
        config_json: undefined,
        config: r.config_json ? JSON.parse(r.config_json) : null,
        due: computeDue(r.sync_freq, r.last_pipeline_run_at),
      })));
    }

    const resyncMatch = pathname.match(/^\/api\/connections\/(\d+)\/resync$/);
    if (resyncMatch && request.method === "POST") {
      const email = await getSessionEmail(request, env);
      if (!email) return json({ error: "not authenticated" }, 401);
      const id = Number(resyncMatch[1]);
      const conn = await env.DB.prepare("SELECT * FROM connections WHERE id = ? AND owner_email = ?").bind(id, email).first();
      if (!conn) return json({ error: "not found" }, 404);
      try {
        const apiKey = await decryptSecret(env, conn.encrypted_api_key, conn.iv);
        const discovery = await discoverProject(conn.region, apiKey, conn.project_id);
        const configMap = buildConfigMap(discovery);
        await env.DB.prepare(
          `INSERT INTO connection_config (connection_id, config_json, updated_at) VALUES (?, ?, datetime('now'))
           ON CONFLICT(connection_id) DO UPDATE SET config_json = excluded.config_json, updated_at = datetime('now')`
        ).bind(id, JSON.stringify(configMap)).run();
        await env.DB.prepare("UPDATE connections SET status = 'healthy', last_error = NULL, last_synced_at = datetime('now'), project_name = ? WHERE id = ?")
          .bind(configMap.projectName || conn.project_name, id).run();
        await logConnectionEvent(
          env, id, "resync", "success", "Connection re-synced",
          `PostHog project "${configMap.projectName || conn.project_name}" re-verified.`, `you · ${email}`
        );
        return json({ ok: true, config: configMap });
      } catch (e) {
        await env.DB.prepare("UPDATE connections SET status = 'error', last_error = ? WHERE id = ?").bind(e.message || "Re-sync failed.", id).run();
        await logConnectionEvent(env, id, "resync", "error", "Re-sync failed", e.message || "Re-sync failed.", `you · ${email}`);
        return json({ error: e.message || "Re-sync failed." }, e.status || 502);
      }
    }

    const identityMatch = pathname.match(/^\/api\/connections\/(\d+)\/identity$/);
    if (identityMatch && request.method === "POST") {
      const email = await getSessionEmail(request, env);
      if (!email) return json({ error: "not authenticated" }, 401);
      const id = Number(identityMatch[1]);
      const body = await request.json().catch(() => ({}));
      const conn = await env.DB.prepare("SELECT id FROM connections WHERE id = ? AND owner_email = ?").bind(id, email).first();
      if (!conn) return json({ error: "not found" }, 404);
      await env.DB.prepare("UPDATE connections SET identity_email_prop = ?, identity_name_prop = ?, identity_role_prop = ? WHERE id = ?")
        .bind(body.email || null, body.name || null, body.role || null, id).run();
      return json({ ok: true });
    }

    const syncSettingsMatch = pathname.match(/^\/api\/connections\/(\d+)\/sync-settings$/);
    if (syncSettingsMatch && request.method === "POST") {
      const email = await getSessionEmail(request, env);
      if (!email) return json({ error: "not authenticated" }, 401);
      const id = Number(syncSettingsMatch[1]);
      const body = await request.json().catch(() => ({}));
      const syncFreq = body.sync_freq;
      const syncMaxSessions = Number(body.sync_max_sessions);
      if (!SYNC_FREQ_VALUES.includes(syncFreq) || !SYNC_MAX_SESSIONS_VALUES.includes(syncMaxSessions)) {
        return json({ error: "invalid sync_freq or sync_max_sessions" }, 400);
      }
      const conn = await env.DB.prepare("SELECT id FROM connections WHERE id = ? AND owner_email = ?").bind(id, email).first();
      if (!conn) return json({ error: "not found" }, 404);
      await env.DB.prepare("UPDATE connections SET sync_freq = ?, sync_max_sessions = ? WHERE id = ?")
        .bind(syncFreq, syncMaxSessions, id).run();
      await logConnectionEvent(
        env, id, "settings_changed", "info", "Settings changed",
        `Sync frequency set to ${syncFreq} · max sessions set to ${syncMaxSessions}.`, `you · ${email}`
      );
      return json({ ok: true });
    }

    const eventsMatch = pathname.match(/^\/api\/connections\/(\d+)\/events$/);
    if (eventsMatch && request.method === "GET") {
      const email = await getSessionEmail(request, env);
      if (!email) return json({ error: "not authenticated" }, 401);
      const id = Number(eventsMatch[1]);
      const conn = await env.DB.prepare("SELECT id FROM connections WHERE id = ? AND owner_email = ?").bind(id, email).first();
      if (!conn) return json({ error: "not found" }, 404);
      const limit = Math.min(Number(url.searchParams.get("limit")) || 20, 100);
      const { results } = await env.DB.prepare(
        "SELECT id, kind, status, title, detail, trigger_label, created_at FROM connection_events WHERE connection_id = ? ORDER BY id DESC LIMIT ?"
      ).bind(id, limit).all();
      return json(results);
    }

    if (pathname === "/api/company-knowledge" && request.method === "GET") {
      const email = await getSessionEmail(request, env);
      if (!email) return json({ error: "not authenticated" }, 401);
      const row = await env.DB.prepare("SELECT domain, description FROM company_knowledge WHERE owner_email = ?").bind(email).first();
      return json(row || { domain: "", description: "" });
    }

    if (pathname === "/api/company-knowledge" && request.method === "POST") {
      const email = await getSessionEmail(request, env);
      if (!email) return json({ error: "not authenticated" }, 401);
      const body = await request.json().catch(() => ({}));
      await env.DB.prepare(
        `INSERT INTO company_knowledge (owner_email, domain, description, updated_at) VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(owner_email) DO UPDATE SET domain = excluded.domain, description = excluded.description, updated_at = datetime('now')`
      ).bind(email, body.domain || "", body.description || "").run();
      return json({ ok: true });
    }

    if (pathname === "/api/company-knowledge/autofill" && request.method === "POST") {
      const email = await getSessionEmail(request, env);
      if (!email) return json({ error: "not authenticated" }, 401);
      const body = await request.json().catch(() => ({}));
      const domain = String(body.domain || "").trim();
      if (!domain) return json({ error: "domain required" }, 400);
      let pageText = "";
      try {
        const url = domain.startsWith("http") ? domain : `https://${domain}`;
        const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (BugRadarBot)" } });
        const html = await res.text();
        pageText = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 4000);
      } catch (e) {
        return json({ error: "Could not reach that domain." }, 502);
      }
      try {
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
          body: JSON.stringify({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 400,
            messages: [{
              role: "user",
              content: `Here's the homepage text of ${domain}:\n\n${pageText}\n\nWrite a 3-5 sentence description of what this product does, who uses it, and what the core actions that matter for the product are (the things a bug in would be worth proactively telling a customer about). Plain text, no markdown, no preamble.`,
            }],
          }),
        });
        const data = await res.json();
        const description = data.content?.[0]?.text?.trim() || "";
        return json({ description });
      } catch (e) {
        return json({ error: "Could not draft a description." }, 502);
      }
    }

    if (pathname === "/api/goals" && request.method === "GET") {
      const email = await getSessionEmail(request, env);
      if (!email) return json({ error: "not authenticated" }, 401);
      const { results } = await env.DB.prepare(
        "SELECT id, purpose, description, tags, source, created_at FROM goals WHERE owner_email = ? ORDER BY id DESC"
      ).bind(email).all();
      return json(results.map(g => ({ ...g, tags: JSON.parse(g.tags || "[]") })));
    }

    if (pathname === "/api/goals" && request.method === "POST") {
      const email = await getSessionEmail(request, env);
      if (!email) return json({ error: "not authenticated" }, 401);
      const body = await request.json().catch(() => ({}));
      const purpose = String(body.purpose || "").trim();
      if (!purpose) return json({ error: "purpose is required" }, 400);
      const result = await env.DB.prepare(
        `INSERT INTO goals (owner_email, purpose, description, tags, source) VALUES (?, ?, ?, ?, 'user')`
      ).bind(email, purpose, (body.description || "").trim() || null, JSON.stringify(body.tags || [])).run();
      return json({ ok: true, id: result.meta.last_row_id });
    }

    const goalDeleteMatch = pathname.match(/^\/api\/goals\/(\d+)$/);
    if (goalDeleteMatch && request.method === "DELETE") {
      const email = await getSessionEmail(request, env);
      if (!email) return json({ error: "not authenticated" }, 401);
      await env.DB.prepare("DELETE FROM goals WHERE id = ? AND owner_email = ?").bind(Number(goalDeleteMatch[1]), email).run();
      return json({ ok: true });
    }

    if (pathname === "/api/tags" && request.method === "GET") {
      const email = await getSessionEmail(request, env);
      if (!email) return json({ error: "not authenticated" }, 401);
      const { results } = await env.DB.prepare(
        "SELECT id, label, color, source, created_at FROM tags WHERE owner_email = ? ORDER BY id DESC"
      ).bind(email).all();
      return json(results);
    }

    if (pathname === "/api/slack/status" && request.method === "GET") {
      const email = await getSessionEmail(request, env);
      if (!email) return json({ error: "not authenticated" }, 401);
      const row = await env.DB.prepare(
        "SELECT team_name, status, connected_by_email, connected_at FROM slack_connections WHERE owner_email = ?"
      ).bind(email).first();
      if (!row) return json({ connected: false });
      return json({
        connected: row.status === "connected",
        status: row.status,
        team_name: row.team_name,
        connected_by_email: row.connected_by_email,
        connected_at: row.connected_at,
      });
    }

    if (pathname === "/api/slack/oauth/start" && request.method === "GET") {
      const email = await getSessionEmail(request, env);
      if (!email) return json({ error: "not authenticated" }, 401);
      if (!env.SLACK_CLIENT_ID) return json({ error: "Slack app not configured" }, 500);
      const state = crypto.randomUUID();
      await env.DB.prepare("INSERT INTO slack_oauth_state (state, owner_email) VALUES (?, ?)").bind(state, email).run();
      const redirectUri = `${url.origin}/api/slack/oauth/callback`;
      const scopes = "chat:write,chat:write.public,channels:read,users:read";
      const authUrl = `https://slack.com/oauth/v2/authorize?client_id=${encodeURIComponent(env.SLACK_CLIENT_ID)}&scope=${encodeURIComponent(scopes)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}`;
      return Response.redirect(authUrl, 302);
    }

    if (pathname === "/api/slack/oauth/callback" && request.method === "GET") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const appOrigin = url.origin;
      if (!code || !state) {
        return new Response("Missing code or state.", { status: 400 });
      }
      const stateRow = await env.DB.prepare("SELECT owner_email, created_at FROM slack_oauth_state WHERE state = ?").bind(state).first();
      await env.DB.prepare("DELETE FROM slack_oauth_state WHERE state = ?").bind(state).run();
      if (!stateRow) {
        return new Response("This connection link has expired or was already used. Go back and click Add to Slack again.", { status: 400 });
      }
      const ageMs = Date.now() - sqliteTimeToMs(stateRow.created_at);
      if (Number.isNaN(ageMs) || ageMs > 10 * 60 * 1000) {
        return new Response("This connection link has expired. Go back and click Add to Slack again.", { status: 400 });
      }
      const ownerEmail = stateRow.owner_email;
      if (!env.SLACK_CLIENT_ID || !env.SLACK_CLIENT_SECRET) {
        return new Response("Slack app not configured.", { status: 500 });
      }
      const redirectUri = `${appOrigin}/api/slack/oauth/callback`;
      const tokenRes = await fetch("https://slack.com/api/oauth.v2.access", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: env.SLACK_CLIENT_ID,
          client_secret: env.SLACK_CLIENT_SECRET,
          code,
          redirect_uri: redirectUri,
        }),
      });
      const tokenData = await tokenRes.json();
      if (!tokenData.ok) {
        return new Response(`Slack couldn't complete the connection: ${tokenData.error || "unknown error"}.`, { status: 400 });
      }
      const { ciphertext, iv } = await encryptSecret(env, tokenData.access_token);
      await env.DB.prepare(
        `INSERT INTO slack_connections (owner_email, team_id, team_name, encrypted_bot_token, iv, connected_by_email, status, connected_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'connected', datetime('now'), datetime('now'))
         ON CONFLICT(owner_email) DO UPDATE SET
           team_id=excluded.team_id, team_name=excluded.team_name, encrypted_bot_token=excluded.encrypted_bot_token,
           iv=excluded.iv, connected_by_email=excluded.connected_by_email, status='connected', updated_at=datetime('now')`
      ).bind(ownerEmail, tokenData.team.id, tokenData.team.name, ciphertext, iv, ownerEmail).run();
      return Response.redirect(`${appOrigin}/?slack=connected`, 302);
    }

    if (pathname === "/api/slack/channels" && request.method === "GET") {
      const email = await getSessionEmail(request, env);
      if (!email) return json({ error: "not authenticated" }, 401);
      const token = await getSlackBotToken(env, email);
      if (!token) return json({ error: "Slack not connected" }, 400);
      const channels = [];
      let cursor = "";
      for (let page = 0; page < 10; page++) {
        const qs = new URLSearchParams({ types: "public_channel", exclude_archived: "true", limit: "200" });
        if (cursor) qs.set("cursor", cursor);
        const res = await fetch(`https://slack.com/api/conversations.list?${qs}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        const data = await res.json();
        if (!data.ok) return json({ error: `Slack error: ${data.error || "unknown"}` }, 502);
        for (const c of data.channels || []) {
          channels.push({ id: c.id, name: `#${c.name}`, num_members: c.num_members || 0 });
        }
        cursor = data.response_metadata && data.response_metadata.next_cursor;
        if (!cursor) break;
        if (channels.length >= 500) break;
      }
      return json(channels);
    }

    if (pathname === "/api/slack/disconnect" && request.method === "POST") {
      const email = await getSessionEmail(request, env);
      if (!email) return json({ error: "not authenticated" }, 401);
      await env.DB.prepare(
        "UPDATE slack_connections SET status = 'disconnected', encrypted_bot_token = NULL, iv = NULL, updated_at = datetime('now') WHERE owner_email = ?"
      ).bind(email).run();
      return json({ ok: true });
    }

    if (pathname === "/api/slack/rules" && request.method === "GET") {
      const email = await getSessionEmail(request, env);
      if (!email) return json({ error: "not authenticated" }, 401);
      const { results: rows } = await env.DB.prepare(
        "SELECT * FROM slack_rules WHERE owner_email = ? ORDER BY id DESC"
      ).bind(email).all();
      const { results: goalRows } = await env.DB.prepare("SELECT id FROM goals WHERE owner_email = ?").bind(email).all();
      const { results: tagRows } = await env.DB.prepare("SELECT id FROM tags WHERE owner_email = ?").bind(email).all();
      const validGoalIds = new Set(goalRows.map(g => g.id));
      const validTagIds = new Set(tagRows.map(t => t.id));
      const rules = rows.map(r => {
        const goalIds = JSON.parse(r.cond_goal_ids);
        const tagIds = JSON.parse(r.cond_tag_ids);
        const missingGoal = goalIds.some(id => !validGoalIds.has(id));
        const missingTag = tagIds.some(id => !validTagIds.has(id));
        const orphaned = missingGoal || missingTag;
        return {
          id: r.id, name: r.name, enabled: !!r.enabled,
          cond: {
            outcome: JSON.parse(r.cond_outcome), severity: JSON.parse(r.cond_severity),
            realBug: r.cond_real_bug, reachable: r.cond_reachable,
            goalIds, tagIds,
          },
          channelId: r.channel_id, channelName: r.channel_name, dmOwner: !!r.dm_owner,
          orphaned,
          orphanReason: orphaned ? (missingGoal && missingTag ? "References a deleted goal and tag" : missingGoal ? "References a deleted goal" : "References a deleted tag") : null,
        };
      });
      return json(rules);
    }

    if (pathname === "/api/slack/rules" && request.method === "POST") {
      const email = await getSessionEmail(request, env);
      if (!email) return json({ error: "not authenticated" }, 401);
      const body = await request.json().catch(() => ({}));
      if (!body.name || !String(body.name).trim() || !body.channelId || !body.channelName) {
        return json({ error: "name and channel are required" }, 400);
      }
      const cond = body.cond || {};
      const result = await env.DB.prepare(
        `INSERT INTO slack_rules (owner_email, name, enabled, cond_outcome, cond_severity, cond_real_bug, cond_reachable, cond_goal_ids, cond_tag_ids, channel_id, channel_name, dm_owner)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        email, String(body.name).trim(),
        JSON.stringify(cond.outcome || []), JSON.stringify(cond.severity || []),
        cond.realBug || "either", cond.reachable || "either",
        JSON.stringify(cond.goalIds || []), JSON.stringify(cond.tagIds || []),
        body.channelId, body.channelName, body.dmOwner ? 1 : 0
      ).run();
      return json({ ok: true, id: result.meta.last_row_id });
    }

    const ruleMatch = pathname.match(/^\/api\/slack\/rules\/(\d+)$/);
    if (ruleMatch && request.method === "PATCH") {
      const email = await getSessionEmail(request, env);
      if (!email) return json({ error: "not authenticated" }, 401);
      const id = Number(ruleMatch[1]);
      const owns = await env.DB.prepare("SELECT id FROM slack_rules WHERE id = ? AND owner_email = ?").bind(id, email).first();
      if (!owns) return json({ error: "not found" }, 404);
      const body = await request.json().catch(() => ({}));
      if (!body.name || !String(body.name).trim() || !body.channelId || !body.channelName) {
        return json({ error: "name and channel are required" }, 400);
      }
      const cond = body.cond || {};
      await env.DB.prepare(
        `UPDATE slack_rules SET name=?, cond_outcome=?, cond_severity=?, cond_real_bug=?, cond_reachable=?, cond_goal_ids=?, cond_tag_ids=?, channel_id=?, channel_name=?, dm_owner=?, updated_at=datetime('now')
         WHERE id = ?`
      ).bind(
        String(body.name).trim(),
        JSON.stringify(cond.outcome || []), JSON.stringify(cond.severity || []),
        cond.realBug || "either", cond.reachable || "either",
        JSON.stringify(cond.goalIds || []), JSON.stringify(cond.tagIds || []),
        body.channelId, body.channelName, body.dmOwner ? 1 : 0,
        id
      ).run();
      return json({ ok: true });
    }

    if (ruleMatch && request.method === "DELETE") {
      const email = await getSessionEmail(request, env);
      if (!email) return json({ error: "not authenticated" }, 401);
      const id = Number(ruleMatch[1]);
      const owns = await env.DB.prepare("SELECT id FROM slack_rules WHERE id = ? AND owner_email = ?").bind(id, email).first();
      if (!owns) return json({ error: "not found" }, 404);
      await env.DB.prepare("DELETE FROM slack_rules WHERE id = ? AND owner_email = ?").bind(id, email).run();
      return json({ ok: true });
    }

    const ruleToggleMatch = pathname.match(/^\/api\/slack\/rules\/(\d+)\/toggle$/);
    if (ruleToggleMatch && request.method === "POST") {
      const email = await getSessionEmail(request, env);
      if (!email) return json({ error: "not authenticated" }, 401);
      const id = Number(ruleToggleMatch[1]);
      const row = await env.DB.prepare("SELECT enabled FROM slack_rules WHERE id = ? AND owner_email = ?").bind(id, email).first();
      if (!row) return json({ error: "not found" }, 404);
      await env.DB.prepare("UPDATE slack_rules SET enabled = ?, updated_at = datetime('now') WHERE id = ?").bind(row.enabled ? 0 : 1, id).run();
      return json({ ok: true, enabled: !row.enabled });
    }

    if (pathname === "/api/slack/dry-run" && request.method === "POST") {
      const email = await getSessionEmail(request, env);
      if (!email) return json({ error: "not authenticated" }, 401);
      const body = await request.json().catch(() => ({}));
      const cond = body.cond || {};
      const pseudoRule = {
        cond_outcome: JSON.stringify(cond.outcome || []),
        cond_severity: JSON.stringify(cond.severity || []),
        cond_real_bug: cond.realBug || "either",
        cond_reachable: cond.reachable || "either",
        cond_goal_ids: JSON.stringify(cond.goalIds || []),
        cond_tag_ids: JSON.stringify(cond.tagIds || []),
      };
      const tasks = await getRecentTasksForOwner(env, email, 50);
      const matches = tasks.filter(t => slackRuleMatches(t, pseudoRule));
      return json({
        total: matches.length,
        matches: matches.slice(0, 4).map(t => ({ title: t.title, severity: t.severity || "none", when: relativeAgeLabel(t.key_timestamp || t._generatedAt) })),
      });
    }

    if (pathname === "/api/tags" && request.method === "POST") {
      const email = await getSessionEmail(request, env);
      if (!email) return json({ error: "not authenticated" }, 401);
      const body = await request.json().catch(() => ({}));
      const label = String(body.label || "").trim();
      if (!label) return json({ error: "label is required" }, 400);
      const colorIdx = Number.isInteger(body.color_idx) && body.color_idx >= 0 && body.color_idx < TAG_PALETTE.length ? body.color_idx : 0;
      const result = await env.DB.prepare(
        `INSERT INTO tags (owner_email, label, color, source) VALUES (?, ?, ?, 'user')`
      ).bind(email, label, TAG_PALETTE[colorIdx]).run();
      return json({ ok: true, id: result.meta.last_row_id, color: TAG_PALETTE[colorIdx] });
    }

    const tagDeleteMatch = pathname.match(/^\/api\/tags\/(\d+)$/);
    if (tagDeleteMatch && request.method === "DELETE") {
      const email = await getSessionEmail(request, env);
      if (!email) return json({ error: "not authenticated" }, 401);
      await env.DB.prepare("DELETE FROM tags WHERE id = ? AND owner_email = ?").bind(Number(tagDeleteMatch[1]), email).run();
      return json({ ok: true });
    }

    const taskTagAddMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/tasks\/(\d+)\/tags$/);
    if (taskTagAddMatch && request.method === "POST") {
      const email = await getSessionEmail(request, env);
      if (!email) return json({ error: "not authenticated" }, 401);
      const sessionId = decodeURIComponent(taskTagAddMatch[1]);
      const taskIndex = Number(taskTagAddMatch[2]);
      const body = await request.json().catch(() => ({}));
      const tagId = Number(body.tag_id);
      if (!Number.isInteger(tagId)) return json({ error: "tag_id is required" }, 400);
      const tagRow = await env.DB.prepare("SELECT id FROM tags WHERE id = ? AND owner_email = ?").bind(tagId, email).first();
      if (!tagRow) return json({ error: "tag not found" }, 400);
      const ctx = await loadTaskForMutation(env, email, sessionId, taskIndex);
      if (!ctx) return json({ error: "task not found" }, 404);
      const { report, micro, task } = ctx;
      task.tags = task.tags || [];
      if (!task.tags.some(tg => tg.tag_id === tagId)) {
        task.tags.push({ tag_id: tagId, assign: "user" });
        await saveMicroFindings(env, report.id, micro);
      }
      return json({ ok: true });
    }

    const taskTagRemoveMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/tasks\/(\d+)\/tags\/(\d+)$/);
    if (taskTagRemoveMatch && request.method === "DELETE") {
      const email = await getSessionEmail(request, env);
      if (!email) return json({ error: "not authenticated" }, 401);
      const sessionId = decodeURIComponent(taskTagRemoveMatch[1]);
      const taskIndex = Number(taskTagRemoveMatch[2]);
      const tagId = Number(taskTagRemoveMatch[3]);
      const ctx = await loadTaskForMutation(env, email, sessionId, taskIndex);
      if (!ctx) return json({ error: "task not found" }, 404);
      const { report, micro, task } = ctx;
      task.tags = (task.tags || []).filter(tg => tg.tag_id !== tagId);
      await saveMicroFindings(env, report.id, micro);
      return json({ ok: true });
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    // PIPELINE_LOCK_TTL_MS: how long a connection is treated as "actively running"
    // (skipped by the next tick) after pipeline_lock_at is stamped. Generous upper
    // bound even for the largest sync_max_sessions (100) at the 120s-per-call LLM
    // timeout. A lock older than this is treated as abandoned -- a run that was
    // killed by the platform without ever reaching runPipelineSafely's `finally` --
    // and the connection becomes eligible again rather than staying stuck forever.
    const PIPELINE_LOCK_TTL_MS = 20 * 60 * 1000;
    try {
      const { results: rows } = await env.DB.prepare(
        `SELECT c.*, cc.config_json FROM connections c LEFT JOIN connection_config cc ON cc.connection_id = c.id`
      ).all();
      const now = Date.now();
      const due = [];
      for (const r of rows) {
        if (!computeDue(r.sync_freq, r.last_pipeline_run_at)) continue;
        if (r.pipeline_lock_at) {
          const lockMs = sqliteTimeToMs(r.pipeline_lock_at);
          if (!Number.isNaN(lockMs) && now - lockMs < PIPELINE_LOCK_TTL_MS) continue; // genuinely still running, skip this tick
          // Stale lock -- the run that set it never cleared it (likely killed by the
          // platform mid-run). Log it so a silent kill isn't invisible, then retry.
          await logConnectionEvent(
            env, r.id, "sync_failed", "error", "Sync failed",
            "A previous run did not finish within the expected window and was treated as failed. Retrying now.",
            "scheduled"
          ).catch(() => {});
        }
        due.push(r);
      }
      console.log(`[scheduled] ${due.length}/${rows.length} connection(s) due`);
      for (const conn of due) {
        await runPipelineSafely(env, conn, null);
      }
    } catch (e) {
      console.error(`ERROR: scheduled() failed before/outside any per-connection run: ${e.message}`);
    }
  },
};
