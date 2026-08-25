# Multi-Provider AI Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each tenant's `bug_radar.py` pipeline run route its LLM calls through Anthropic, OpenAI, or Gemini — chosen per tenant from the admin portal, backed by three org-wide default API keys, with an optional per-tenant key override.

**Architecture:** Encryption/decryption and D1 writes for the two new tables live only on the main worker (`worker/src/index.js`, the only place holding `CONNECTION_ENCRYPTION_KEY`); `worker-admin` gets thin proxy routes mirroring its existing media-proxy pattern (`adminAuthed()` check, then a service-binding call to the main worker with the `ADMIN_MEDIA_SECRET` bearer). `bug_radar.py` fetches a resolved, ready-to-use config once per pipeline run and dispatches its two existing LLM call sites through a provider-aware `call_llm`.

**Tech Stack:** Cloudflare Workers, D1 (SQLite), vanilla JS/HTML (worker-admin frontend), Python (`bug_radar.py`), `anthropic`/`openai`/`google-genai` Python SDKs.

**Spec:** `docs/superpowers/specs/2026-08-25-ai-provider-routing-design.md`

## Global Constraints

- Schema changes go in `worker/schema.sql` (shared D1 database), applied via `npx wrangler d1 execute bug-radar-db --remote --command="..."` from `worker/`.
- No unit test framework in this repo. Verification is deploy + curl (Workers) or a syntax/import check + a real pipeline dry-run (Python) — matching the pattern used throughout this project.
- Encryption/decryption only ever happens on the main worker (`worker/src/index.js`), via the existing `encryptSecret(env, plaintext)` / `decryptSecret(env, ciphertextB64, ivB64)` helpers. `worker-admin` never touches D1 rows containing encrypted key material directly — it only proxies.
- API keys are **write-only** from any client's perspective: every read-side response returns a masked value (`••••` + last 4 chars of the plaintext), never the full key.
- No cross-provider automatic fallback. Anthropic gets a same-provider fallback only: local `claude` CLI session first, Anthropic API second, only on session failure. OpenAI and Gemini always call their API directly — no session concept, no fallback.
- A tenant with no `tenant_ai_config` row must resolve to exactly today's behavior: Anthropic, session-first, model = `ai_provider_defaults`'s `anthropic` row's `default_model`. Shipping this feature must not change behavior for any tenant nobody has explicitly reconfigured.
- Model catalog (curated dropdown lists, verified current 2026-08-25):
  - Anthropic: `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5` — default `claude-opus-5`
  - OpenAI: `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` — default `gpt-5.6-sol`
  - Gemini: `gemini-3.1-pro-preview`, `gemini-3.7-flash`, `gemini-3.5-flash` — default `gemini-3.1-pro-preview`
- Current worker-admin sidebar order: Overview, Tenants, Sessions, Integrations, Goals, Tags, Slack, Events. The new "AI Providers" screen is inserted after Slack, before Events.

---

### Task 1: `ai_provider_defaults` and `tenant_ai_config` tables

**Files:**
- Modify: `worker/schema.sql` (append)

**Interfaces:**
- Produces: table `ai_provider_defaults(provider TEXT PRIMARY KEY, encrypted_api_key TEXT NOT NULL, iv TEXT NOT NULL, default_model TEXT NOT NULL, updated_at TEXT)`; table `tenant_ai_config(owner_email TEXT PRIMARY KEY, provider TEXT NOT NULL, model TEXT NOT NULL, encrypted_api_key TEXT, iv TEXT, updated_at TEXT)`. Both consumed starting Task 2.

- [ ] **Step 1: Add both tables to schema.sql**

Append to `worker/schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS ai_provider_defaults (
  provider TEXT PRIMARY KEY,
  encrypted_api_key TEXT NOT NULL,
  iv TEXT NOT NULL,
  default_model TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tenant_ai_config (
  owner_email TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  encrypted_api_key TEXT,
  iv TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);
```

- [ ] **Step 2: Apply to the live database**

Run from `worker/`:
```bash
npx wrangler d1 execute bug-radar-db --remote --command="CREATE TABLE IF NOT EXISTS ai_provider_defaults (provider TEXT PRIMARY KEY, encrypted_api_key TEXT NOT NULL, iv TEXT NOT NULL, default_model TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')));"
npx wrangler d1 execute bug-radar-db --remote --command="CREATE TABLE IF NOT EXISTS tenant_ai_config (owner_email TEXT PRIMARY KEY, provider TEXT NOT NULL, model TEXT NOT NULL, encrypted_api_key TEXT, iv TEXT, updated_at TEXT DEFAULT (datetime('now')));"
```

- [ ] **Step 3: Verify both exist**

```bash
npx wrangler d1 execute bug-radar-db --remote --command="SELECT name FROM sqlite_master WHERE type='table' AND name IN ('ai_provider_defaults','tenant_ai_config');"
```
Expected: 2 rows.

- [ ] **Step 4: Commit**

```bash
git add worker/schema.sql
git commit -m "Add ai_provider_defaults and tenant_ai_config tables"
```

---

### Task 2: Main worker — effective-config resolution + pipeline endpoint

**Files:**
- Modify: `worker/src/index.js`

**Interfaces:**
- Consumes: `ai_provider_defaults`, `tenant_ai_config` tables (Task 1); existing `encryptSecret`/`decryptSecret`; existing `pipelineAuthed(request, env)` helper (already defined in this file, reused verbatim).
- Produces: `resolveAiConfig(env, ownerEmail)` → `Promise<{provider, model, api_key, use_session_first}>`, used by Task 3's admin GET route and by `bug_radar.py` via the new endpoint. Route `GET /api/pipeline/ai-config?owner_email=`.

- [ ] **Step 1: Add the `AI_PROVIDERS` constant and `resolveAiConfig` helper**

Add near the top of `worker/src/index.js`, after the existing encryption helpers (`encryptSecret`/`decryptSecret`):

```js
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
  return { provider, model, api_key: apiKey, use_session_first: provider === "anthropic" };
}

function maskKey(plaintext) {
  if (!plaintext || plaintext.length < 4) return "••••";
  return `••••${plaintext.slice(-4)}`;
}
```

- [ ] **Step 2: Add the pipeline-authed route**

Add near the other `/api/pipeline/*` routes (after `/api/pipeline/tags`, matching the file's existing grouping):

```js
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
```

- [ ] **Step 3: Seed the 3 default rows so the route is testable**

This is a one-time manual step, not part of the deployed code — the real admin UI (Task 5) is how this gets managed going forward. Run from `worker/` (replace the placeholder keys with real ones; if you don't have them yet, use any placeholder string — Task 8 re-verifies with real keys):

```bash
node -e '
const crypto = require("crypto");
function enc(plaintext, keyB64) {
  const key = Buffer.from(keyB64, "base64");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext: Buffer.concat([ciphertext, tag]).toString("base64"), iv: iv.toString("base64") };
}
const keyB64 = process.env.CONNECTION_ENCRYPTION_KEY_B64; // pass in separately, do not hardcode
for (const [provider, plaintext, model] of [["anthropic","placeholder-anthropic-key","claude-opus-5"],["openai","placeholder-openai-key","gpt-5.6-sol"],["gemini","placeholder-gemini-key","gemini-3.1-pro-preview"]]) {
  const { ciphertext, iv } = enc(plaintext, keyB64);
  console.log(`INSERT INTO ai_provider_defaults (provider, encrypted_api_key, iv, default_model) VALUES ('${provider}', '${ciphertext}', '${iv}', '${model}') ON CONFLICT(provider) DO UPDATE SET encrypted_api_key=excluded.encrypted_api_key, iv=excluded.iv, default_model=excluded.default_model;`);
}
'
```

Note: this step requires the live `CONNECTION_ENCRYPTION_KEY` value, which is a Wrangler secret and not retrievable via `wrangler secret list` (it only lists names). **Skip this manual-seed step if you cannot retrieve the raw key value** — instead, verify Step 4 differently: deploy, then curl the route for a tenant and confirm it returns `404`/`500` with "no anthropic default configured" (proving the route and auth check work correctly even with an empty table), and defer full verification to Task 8, which seeds real keys through the finished admin UI instead of this manual script.

- [ ] **Step 4: Deploy and verify**

```bash
cd worker && npx wrangler deploy
```
```bash
curl -s https://bug-radar.shubhamvishnu.workers.dev/api/pipeline/ai-config?owner_email=shubhamvishnu@gmail.com
```
Expected (no auth header): `{"error":"unauthorized"}` with HTTP 401.
```bash
curl -s -H "Authorization: Bearer $(security find-generic-password -s BUGRADAR_API_SECRET -w)" \
  "https://bug-radar.shubhamvishnu.workers.dev/api/pipeline/ai-config?owner_email=shubhamvishnu@gmail.com"
```
Expected: either a valid `{"provider":...,"model":...,"api_key":...,"use_session_first":...}` object (if Step 3's seed succeeded) or `{"error":"no anthropic default configured"}` (if skipped) — both are correct outcomes for this task, per Step 3's note.

- [ ] **Step 5: Commit**

```bash
git add worker/src/index.js
git commit -m "Add AI-config resolution helper and pipeline endpoint"
```

---

### Task 3: Main worker — admin-authed CRUD routes

**Files:**
- Modify: `worker/src/index.js`

**Interfaces:**
- Consumes: `resolveAiConfig`, `maskKey`, `AI_PROVIDERS` (Task 2); existing `encryptSecret`; existing admin-media auth pattern (`env.ADMIN_MEDIA_SECRET` bearer check, same as the `adminMediaMatch` route already in this file).
- Produces: routes `GET /api/admin/ai-providers`, `PUT /api/admin/ai-providers/:provider`, `GET /api/admin/ai-config/:owner_email`, `PUT /api/admin/ai-config/:owner_email`, `DELETE /api/admin/ai-config/:owner_email` — all consumed by Task 4's worker-admin proxy.

- [ ] **Step 1: Add an `adminSecretAuthed` helper**

Add near `pipelineAuthed` (same file, same style):

```js
function adminSecretAuthed(request, env) {
  const auth = request.headers.get("authorization") || "";
  return !!env.ADMIN_MEDIA_SECRET && auth === `Bearer ${env.ADMIN_MEDIA_SECRET}`;
}
```

- [ ] **Step 2: Add `GET /api/admin/ai-providers`**

```js
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
```

- [ ] **Step 3: Add `PUT /api/admin/ai-providers/:provider`**

```js
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
```

- [ ] **Step 4: Add `GET /api/admin/ai-config/:owner_email`**

This returns the **effective** resolved config (reusing `resolveAiConfig`), not just the raw override row — so the admin UI can always show what a tenant is actually using, even with no override configured.

```js
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
```

- [ ] **Step 5: Add `PUT /api/admin/ai-config/:owner_email`**

Body: `{provider, model, use_custom_key: boolean, api_key?: string}`. `use_custom_key: false` clears any stored key (falls back to the org default for that provider). `use_custom_key: true` with `api_key` stores a new encrypted key. `use_custom_key: true` with no `api_key` keeps whatever key is already on file (lets the admin change provider/model without re-entering an unchanged key) — this branch 400s if no key is on file yet, since there's nothing to keep.

```js
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
```

- [ ] **Step 6: Add `DELETE /api/admin/ai-config/:owner_email`**

```js
if (tenantConfigMatch && request.method === "DELETE") {
  if (!adminSecretAuthed(request, env)) return json({ error: "unauthorized" }, 401);
  const ownerEmail = decodeURIComponent(tenantConfigMatch[1]).trim().toLowerCase();
  await env.DB.prepare("DELETE FROM tenant_ai_config WHERE owner_email = ?").bind(ownerEmail).run();
  return json({ ok: true });
}
```

- [ ] **Step 7: Deploy and verify**

```bash
cd worker && npx wrangler deploy
```
```bash
curl -s https://bug-radar.shubhamvishnu.workers.dev/api/admin/ai-providers
```
Expected: `{"error":"unauthorized"}`, HTTP 401 (no bearer header).
```bash
SECRET=$(security find-generic-password -s "ADMIN_MEDIA_SECRET" -w 2>/dev/null || echo "<ask the controller for this value, it's a Wrangler secret with no CLI retrieval command>")
curl -s -H "Authorization: Bearer $SECRET" https://bug-radar.shubhamvishnu.workers.dev/api/admin/ai-providers
```
Expected: a JSON object with `anthropic`/`openai`/`gemini` keys, each `{configured, masked_key, default_model}` (all `configured: false` if Task 2's Step 3 seed was skipped — that's correct for this task).
```bash
curl -s -H "Authorization: Bearer $SECRET" https://bug-radar.shubhamvishnu.workers.dev/api/admin/ai-config/shubhamvishnu@gmail.com
```
Expected: `{"provider":"anthropic","model":<default or error if unseeded>,"is_override":false,...}` — `is_override: false` confirms the "no row = org default" resolution path.

- [ ] **Step 8: Commit**

```bash
git add worker/src/index.js
git commit -m "Add admin CRUD routes for AI provider defaults and tenant overrides"
```

---

### Task 4: worker-admin — proxy routes

**Files:**
- Modify: `worker-admin/src/index.js`

**Interfaces:**
- Consumes: Task 3's 5 main-worker routes, existing `adminAuthed(request, env)`, existing `env.MAIN_WORKER`/`env.MAIN_WORKER_URL`/`env.ADMIN_MEDIA_SECRET` bindings (already present, used by the existing media proxy).
- Produces: worker-admin-side routes `GET /api/admin/ai-providers`, `PUT /api/admin/ai-providers/:provider`, `GET /api/admin/ai-config/:owner_email`, `PUT /api/admin/ai-config/:owner_email`, `DELETE /api/admin/ai-config/:owner_email` — consumed by Tasks 5 and 6's frontend code via plain same-origin `fetch()`.

The existing `mediaProxyMatch` route (near the end of `worker-admin/src/index.js`, just before `return env.ASSETS.fetch(request);`) is the pattern to match:
```js
const mediaProxyMatch = pathname.match(/^\/api\/media\/(.+)$/);
if (mediaProxyMatch && request.method === "GET") {
  if (!(await adminAuthed(request, env))) return json({ error: "not authenticated" }, 401);
  const key = mediaProxyMatch[1];
  const upstream = await env.MAIN_WORKER.fetch(
    new Request(`${env.MAIN_WORKER_URL}/api/admin/media/${key}`, {
      headers: { authorization: `Bearer ${env.ADMIN_MEDIA_SECRET}` },
    })
  );
  if (!upstream.ok) return json({ error: "not found" }, upstream.status === 401 ? 401 : 404);
  return new Response(upstream.body, { headers: { "content-type": upstream.headers.get("content-type") || "image/png", "cache-control": "private, max-age=31536000, immutable" } });
}
```

- [ ] **Step 1: Add a generic JSON proxy helper**

Add near `mediaProxyMatch` (same file):

```js
async function proxyJsonToMain(env, path, request) {
  const init = {
    method: request.method,
    headers: { authorization: `Bearer ${env.ADMIN_MEDIA_SECRET}`, "content-type": "application/json" },
  };
  if (request.method === "PUT") init.body = await request.text();
  const upstream = await env.MAIN_WORKER.fetch(new Request(`${env.MAIN_WORKER_URL}${path}`, init));
  const body = await upstream.text();
  return new Response(body, { status: upstream.status, headers: { "content-type": "application/json" } });
}
```

- [ ] **Step 2: Add the 5 proxy routes**

Add right after `mediaProxyMatch`'s block, before `return env.ASSETS.fetch(request);`:

```js
if (pathname === "/api/admin/ai-providers" && request.method === "GET") {
  if (!(await adminAuthed(request, env))) return json({ error: "not authenticated" }, 401);
  return proxyJsonToMain(env, "/api/admin/ai-providers", request);
}

const aiProviderPutMatch = pathname.match(/^\/api\/admin\/ai-providers\/([^/]+)$/);
if (aiProviderPutMatch && request.method === "PUT") {
  if (!(await adminAuthed(request, env))) return json({ error: "not authenticated" }, 401);
  return proxyJsonToMain(env, `/api/admin/ai-providers/${aiProviderPutMatch[1]}`, request);
}

const aiTenantConfigMatch = pathname.match(/^\/api\/admin\/ai-config\/([^/]+)$/);
if (aiTenantConfigMatch && (request.method === "GET" || request.method === "PUT" || request.method === "DELETE")) {
  if (!(await adminAuthed(request, env))) return json({ error: "not authenticated" }, 401);
  return proxyJsonToMain(env, `/api/admin/ai-config/${aiTenantConfigMatch[1]}`, request);
}
```

- [ ] **Step 3: Deploy and verify**

```bash
cd worker-admin && npx wrangler deploy
```
```bash
curl -s https://bug-radar-admin.shubhamvishnu.workers.dev/api/admin/ai-providers
```
Expected: `{"error":"not authenticated"}`, HTTP 401 (no admin session cookie).
```bash
COOKIE=$(curl -s -i -X POST https://bug-radar-admin.shubhamvishnu.workers.dev/api/auth/login -H "content-type: application/json" -d '{"email":"shubhamvishnu@gmail.com","password":"<the real password>"}' | grep -i '^set-cookie' | sed -E 's/set-cookie: ([^;]+);.*/\1/')
curl -s -b "$COOKIE" https://bug-radar-admin.shubhamvishnu.workers.dev/api/admin/ai-providers
```
Expected: the same JSON shape Task 3's Step 7 returned directly from the main worker — proving the proxy forwards correctly.

- [ ] **Step 4: Commit**

```bash
git add worker-admin/src/index.js
git commit -m "Add worker-admin proxy routes for AI provider config"
```

---

### Task 5: worker-admin frontend — AI Providers screen

**Files:**
- Modify: `worker-admin/public/index.html`

**Interfaces:**
- Consumes: Task 4's `GET /api/admin/ai-providers`, `PUT /api/admin/ai-providers/:provider`.
- Produces: `AI_MODEL_CATALOG`, `AI_PROVIDER_LABEL` constants (also consumed by Task 6); `renderAiProvidersScreen()`; a new `document.addEventListener("change", ...)` delegate (new to this file — also extended by Task 6).

- [ ] **Step 1: Add the model catalog constants**

Add near the top of the `<script>` block, alongside other constants like `SEV_VAR`:

```js
const AI_MODEL_CATALOG = {
  anthropic: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"],
  openai: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
  gemini: ["gemini-3.1-pro-preview", "gemini-3.7-flash", "gemini-3.5-flash"],
};
const AI_PROVIDER_LABEL = { anthropic: "Anthropic", openai: "OpenAI", gemini: "Gemini" };
```

- [ ] **Step 2: Add globals, loader, and form-state initializer**

```js
let AI_PROVIDERS_DATA = null;
let AI_PROVIDER_FORMS = null;

async function loadAiProviders() {
  const res = await fetch("/api/admin/ai-providers");
  if (res.ok) AI_PROVIDERS_DATA = await res.json();
  render();
}

function initAiProviderForms() {
  AI_PROVIDER_FORMS = {};
  for (const p of ["anthropic", "openai", "gemini"]) {
    const d = AI_PROVIDERS_DATA[p];
    const catalog = AI_MODEL_CATALOG[p];
    const model = d.default_model || catalog[0];
    const isOther = !catalog.includes(model);
    AI_PROVIDER_FORMS[p] = { model: isOther ? "other" : model, customModel: isOther ? model : "", keyEditing: false, newKey: "" };
  }
}
```

- [ ] **Step 3: Add the render functions**

```js
function renderAiProvidersScreen() {
  if (!AI_PROVIDERS_DATA) return `<div class="pageheader"><span class="title">AI Providers</span></div><div class="content contentpad"><div class="empty-note">Loading…</div></div>`;
  if (!AI_PROVIDER_FORMS) initAiProviderForms();
  const cards = ["anthropic", "openai", "gemini"].map(p => renderAiProviderCard(p)).join("");
  return `
  <div class="pageheader"><span class="title">AI Providers</span></div>
  <div class="content contentpad">${cards}</div>`;
}

function renderAiProviderCard(provider) {
  const d = AI_PROVIDERS_DATA[provider];
  const form = AI_PROVIDER_FORMS[provider];
  const catalog = AI_MODEL_CATALOG[provider];
  const modelOptions = catalog.map(m => `<option value="${escapeHtml(m)}"${form.model === m ? " selected" : ""}>${escapeHtml(m)}</option>`).join("")
    + `<option value="other"${form.model === "other" ? " selected" : ""}>Other (custom)</option>`;
  return `
  <div class="panel" style="margin-bottom:14px;padding:16px 18px">
    <div style="font-weight:700;font-size:15.5px;margin-bottom:10px">${escapeHtml(AI_PROVIDER_LABEL[provider])}</div>
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
      <span style="font-size:12.5px;color:var(--muted);width:70px">API key</span>
      ${form.keyEditing
        ? `<input data-ai-key-input="${provider}" type="password" placeholder="Paste new key" value="${escapeHtml(form.newKey)}" style="flex:1;height:34px;padding:0 10px;border-radius:8px;border:1px solid var(--border-str);background:var(--bg-sub);color:var(--text)"/>`
        : `<span style="font-family:'JetBrains Mono',monospace;font-size:13px">${d.configured ? escapeHtml(d.masked_key) : "not set"}</span>
           <button data-act="ai-provider-edit-key" data-provider="${provider}" style="font-size:12px;color:var(--accent)">Update key</button>`}
    </div>
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
      <span style="font-size:12.5px;color:var(--muted);width:70px">Model</span>
      <select data-ai-model-select="${provider}" style="height:34px;padding:0 8px;border-radius:8px;border:1px solid var(--border-str);background:var(--bg-sub);color:var(--text)">${modelOptions}</select>
      ${form.model === "other" ? `<input data-ai-custom-model="${provider}" type="text" placeholder="model-id" value="${escapeHtml(form.customModel)}" style="height:34px;padding:0 10px;border-radius:8px;border:1px solid var(--border-str);background:var(--bg-sub);color:var(--text)"/>` : ""}
    </div>
    <button data-act="ai-provider-save" data-provider="${provider}" class="login-primary-btn" style="width:auto;padding:0 18px;height:34px;margin-top:2px">Save</button>
  </div>`;
}
```

- [ ] **Step 4: Add `saveAiProvider` and wire the nav/dispatch**

```js
async function saveAiProvider(provider) {
  const form = AI_PROVIDER_FORMS[provider];
  const model = form.model === "other" ? form.customModel.trim() : form.model;
  if (!model) return;
  const body = { default_model: model };
  if (form.keyEditing && form.newKey.trim()) body.api_key = form.newKey.trim();
  const res = await fetch(`/api/admin/ai-providers/${provider}`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  if (res.ok) {
    form.keyEditing = false;
    form.newKey = "";
    await loadAiProviders();
  } else {
    render();
  }
}
```

Add the case to `renderMainContent()`:
```js
    case "ai-providers": return renderAiProvidersScreen();
```

Add the nav item to `renderSidebar()`, after Slack and before Events:
```js
      <button class="nav-item${v === "ai-providers" ? " active" : ""}" data-act="nav" data-view="ai-providers">${ICON_TARGET}<span class="lbl">AI Providers</span></button>
```
(Reuses the existing `ICON_TARGET` constant, already imported for Goals — a distinct icon isn't essential for one more sidebar item and keeps this task from needing a new SVG.)

Add lazy-loading to the `nav` click branch:
```js
      if (el.dataset.view === "ai-providers" && !AI_PROVIDERS_DATA) loadAiProviders();
```

Add the click delegate branches:
```js
  else if (act === "ai-provider-edit-key") { AI_PROVIDER_FORMS[el.dataset.provider].keyEditing = true; render(); }
  else if (act === "ai-provider-save") { saveAiProvider(el.dataset.provider); }
```

Add to the existing `input` delegate (no `render()` call needed — matches this file's established pattern of letting typed input persist to state silently, same as the login form's email/password fields):
```js
  if (e.target.dataset.aiKeyInput) { AI_PROVIDER_FORMS[e.target.dataset.aiKeyInput].newKey = e.target.value; }
  if (e.target.dataset.aiCustomModel) { AI_PROVIDER_FORMS[e.target.dataset.aiCustomModel].customModel = e.target.value; }
```

Add a new `change` event delegate (this file has no `change` listener yet — needed because selecting "Other" must swap in a text input, which changes DOM structure and therefore needs a `render()`, unlike plain text typing):
```js
document.addEventListener("change", e => {
  if (e.target.dataset.aiModelSelect) {
    AI_PROVIDER_FORMS[e.target.dataset.aiModelSelect].model = e.target.value;
    render();
  }
});
```

- [ ] **Step 5: Deploy and verify visually**

```bash
cd worker-admin && npx wrangler deploy
```
Log in via Playwright with the real password. Click "AI Providers" in the sidebar: expect 3 cards (Anthropic/OpenAI/Gemini), each showing "not set" (if Task 2's seed was skipped) or a masked key, a model dropdown, and a Save button. Click "Update key" on one card: expect a password-type input to appear. Select "Other (custom)" in a model dropdown: expect a text input to appear. Type a key and a model, click Save: expect the card to refresh with the new masked key and model reflected (confirm via a follow-up `curl` to `/api/admin/ai-providers` showing the change, or by reloading the screen).

- [ ] **Step 6: Commit**

```bash
git add worker-admin/public/index.html
git commit -m "Add AI Providers screen to admin portal"
```

---

### Task 6: worker-admin frontend — Tenant Detail AI Routing section

**Files:**
- Modify: `worker-admin/public/index.html`

**Interfaces:**
- Consumes: Task 4's `GET/PUT /api/admin/ai-config/:owner_email`; Task 5's `AI_MODEL_CATALOG`/`AI_PROVIDER_LABEL` constants and `change` event delegate (extended, not replaced).
- Produces: `renderTenantAiSection()`, wired into `renderUserDetail()` after the Slack section.

- [ ] **Step 1: Add the global and loader**

```js
let AI_TENANT_FORM = null;

async function loadTenantAiConfig(email) {
  const res = await fetch(`/api/admin/ai-config/${encodeURIComponent(email)}`);
  if (res.ok) {
    const d = await res.json();
    const catalog = AI_MODEL_CATALOG[d.provider];
    const isOther = !catalog.includes(d.model);
    AI_TENANT_FORM = {
      provider: d.provider,
      model: isOther ? "other" : d.model,
      customModel: isOther ? d.model : "",
      useCustomKey: d.has_custom_key,
      newKey: "",
      keyEditing: false,
      isOverride: d.is_override,
      maskedKey: d.masked_key,
    };
  }
  render();
}
```

- [ ] **Step 2: Wire the loader into `openUser`**

In `openUser(email)`, add `AI_TENANT_FORM = null;` alongside the existing `USER_DETAIL = null;` reset (before the first `render()`), and after `if (res.ok) USER_DETAIL = await res.json();`, add a call to `loadTenantAiConfig(email)` (fire-and-forget, don't await — it renders on its own once its fetch resolves, same pattern as this file's other independent per-detail loaders):

```js
async function openUser(email) {
  state.view = "user-detail";
  state.selUserEmail = email;
  USER_DETAIL = null;
  AI_TENANT_FORM = null;
  render();
  const res = await fetch(`/api/users/${encodeURIComponent(email)}`);
  if (state.selUserEmail !== email) return;
  if (res.ok) USER_DETAIL = await res.json();
  loadTenantAiConfig(email);
  render();
}
```

- [ ] **Step 3: Add `renderTenantAiSection()`**

```js
function renderTenantAiSection() {
  if (!AI_TENANT_FORM) return `<div class="section-title">AI Routing</div><div class="panel" style="padding:16px 18px"><div class="empty-note">Loading…</div></div>`;
  const form = AI_TENANT_FORM;
  const providerOptions = ["anthropic", "openai", "gemini"]
    .map(p => `<option value="${p}"${form.provider === p ? " selected" : ""}>${escapeHtml(AI_PROVIDER_LABEL[p])}</option>`).join("");
  const catalog = AI_MODEL_CATALOG[form.provider];
  const modelOptions = catalog.map(m => `<option value="${escapeHtml(m)}"${form.model === m ? " selected" : ""}>${escapeHtml(m)}</option>`).join("")
    + `<option value="other"${form.model === "other" ? " selected" : ""}>Other (custom)</option>`;
  return `
  <div class="section-title">AI Routing${form.isOverride ? "" : `<span style="margin-left:8px;font-size:10.5px;font-weight:600;color:var(--faint);background:var(--bg-sub);padding:2px 7px;border-radius:6px">ORG DEFAULT</span>`}</div>
  <div class="panel" style="padding:16px 18px">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
      <span style="font-size:12.5px;color:var(--muted);width:70px">Provider</span>
      <select data-ai-tenant-provider style="height:34px;padding:0 8px;border-radius:8px;border:1px solid var(--border-str);background:var(--bg-sub);color:var(--text)">${providerOptions}</select>
    </div>
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
      <span style="font-size:12.5px;color:var(--muted);width:70px">Model</span>
      <select data-ai-tenant-model style="height:34px;padding:0 8px;border-radius:8px;border:1px solid var(--border-str);background:var(--bg-sub);color:var(--text)">${modelOptions}</select>
      ${form.model === "other" ? `<input data-ai-tenant-custom-model type="text" placeholder="model-id" value="${escapeHtml(form.customModel)}" style="height:34px;padding:0 10px;border-radius:8px;border:1px solid var(--border-str);background:var(--bg-sub);color:var(--text)"/>` : ""}
    </div>
    <div style="display:flex;align-items:center;gap:16px;margin-bottom:10px">
      <span style="font-size:12.5px;color:var(--muted);width:70px">API key</span>
      <label style="display:flex;align-items:center;gap:6px;font-size:12.5px"><input type="radio" name="aiTenantKeyMode" data-ai-tenant-key-mode="default" ${!form.useCustomKey ? "checked" : ""}/> Org default</label>
      <label style="display:flex;align-items:center;gap:6px;font-size:12.5px"><input type="radio" name="aiTenantKeyMode" data-ai-tenant-key-mode="custom" ${form.useCustomKey ? "checked" : ""}/> Custom for this tenant</label>
    </div>
    ${form.useCustomKey ? `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
      <span style="font-size:12.5px;color:var(--muted);width:70px"></span>
      ${form.keyEditing
        ? `<input data-ai-tenant-key-input type="password" placeholder="Paste new key" value="${escapeHtml(form.newKey)}" style="flex:1;height:34px;padding:0 10px;border-radius:8px;border:1px solid var(--border-str);background:var(--bg-sub);color:var(--text)"/>`
        : `<span style="font-family:'JetBrains Mono',monospace;font-size:13px">${escapeHtml(form.maskedKey || "not set")}</span>
           <button data-act="ai-tenant-edit-key" style="font-size:12px;color:var(--accent)">Update key</button>`}
    </div>` : ""}
    <button data-act="ai-tenant-save" data-email="${escapeHtml(state.selUserEmail)}" class="login-primary-btn" style="width:auto;padding:0 18px;height:34px;margin-top:2px">Save</button>
  </div>`;
}
```

- [ ] **Step 4: Wire into `renderUserDetail()`**

In `renderUserDetail()`, add `<div style="margin-top:24px">${renderTenantAiSection()}</div>` immediately after the Slack section's div (the one added in the earlier Slack-integration work) and before `renderLatestReportSection()`'s call.

- [ ] **Step 5: Add `saveTenantAiConfig` and wire the dispatch**

```js
async function saveTenantAiConfig(email) {
  const form = AI_TENANT_FORM;
  const model = form.model === "other" ? form.customModel.trim() : form.model;
  if (!model) return;
  const body = { provider: form.provider, model, use_custom_key: form.useCustomKey };
  if (form.useCustomKey && form.keyEditing && form.newKey.trim()) body.api_key = form.newKey.trim();
  const res = await fetch(`/api/admin/ai-config/${encodeURIComponent(email)}`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  if (res.ok) { await loadTenantAiConfig(email); } else { render(); }
}
```

Add to the click delegate:
```js
  else if (act === "ai-tenant-edit-key") { AI_TENANT_FORM.keyEditing = true; render(); }
  else if (act === "ai-tenant-save") { saveTenantAiConfig(el.dataset.email); }
```

Add to the `input` delegate (no `render()`, same reasoning as Task 5's key/custom-model inputs):
```js
  if (e.target.dataset.aiTenantCustomModel !== undefined) { AI_TENANT_FORM.customModel = e.target.value; }
  if (e.target.dataset.aiTenantKeyInput !== undefined) { AI_TENANT_FORM.newKey = e.target.value; }
```

Extend Task 5's `change` delegate with 3 more branches (in the same `document.addEventListener("change", ...)` block, not a second listener):
```js
  if (e.target.dataset.aiTenantProvider !== undefined) {
    AI_TENANT_FORM.provider = e.target.value;
    AI_TENANT_FORM.model = AI_MODEL_CATALOG[e.target.value][0];
    AI_TENANT_FORM.customModel = "";
    render();
  }
  if (e.target.dataset.aiTenantModel !== undefined) {
    AI_TENANT_FORM.model = e.target.value;
    render();
  }
  if (e.target.dataset.aiTenantKeyMode !== undefined) {
    AI_TENANT_FORM.useCustomKey = e.target.dataset.aiTenantKeyMode === "custom";
    render();
  }
```

- [ ] **Step 6: Deploy and verify visually**

```bash
cd worker-admin && npx wrangler deploy
```
Open a tenant in Tenant Detail: expect an "AI Routing" section after Slack, showing "ORG DEFAULT" badge, Anthropic pre-selected, the default model pre-selected, "Org default" key mode selected. Change the provider dropdown to OpenAI: expect the model dropdown to repopulate with OpenAI's catalog. Select "Custom for this tenant": expect a masked-key/Update-key row to appear. Click Save, reload the tenant: expect the "ORG DEFAULT" badge to disappear (now an override) and the saved provider/model/key-mode to persist.

- [ ] **Step 7: Commit**

```bash
git add worker-admin/public/index.html
git commit -m "Add AI Routing section to Tenant Detail"
```

---

### Task 7: Pipeline — multi-provider `call_llm` dispatcher

**Files:**
- Modify: `bug_radar.py`
- Modify: `requirements.txt`

**Interfaces:**
- Consumes: `GET /api/pipeline/ai-config` (Task 2); existing `fetch_company_context`/`fetch_goals`/`fetch_tags` call-site pattern in `main()`.
- Produces: `fetch_ai_config(worker_url, secret, owner_email)`; `call_llm(prompt, ai_config)` (signature change from today's `call_llm(prompt)` — both existing call sites in `main()` updated in this task).

- [ ] **Step 1: Add the new dependencies**

Add to `requirements.txt`:
```
anthropic
openai
google-genai
```

Install locally to verify they resolve:
```bash
pip install -r requirements.txt
```

- [ ] **Step 2: Add `fetch_ai_config`**

Add near the other `fetch_*` helpers (`fetch_company_context`, `fetch_goals`, `fetch_tags`), matching their exact style:

```python
def fetch_ai_config(worker_url, secret, owner_email):
    headers = {"Authorization": f"Bearer {secret}"}
    resp = requests.get(
        f"{worker_url}/api/pipeline/ai-config",
        headers=headers, params={"owner_email": owner_email}, timeout=30,
    )
    resp.raise_for_status()
    return resp.json()
```

- [ ] **Step 3: Replace `call_llm` with a dispatcher and 4 provider-specific functions**

Replace the current `call_llm(prompt)` function (the one shelling out to `claude -p`) with:

```python
def _parse_llm_json(text):
    text = text.strip()
    if text.startswith("```"):
        text = text.split("```")[1]
        if text.startswith("json"):
            text = text[4:]
    return json.loads(text)


def call_llm_claude_session(prompt):
    result = subprocess.run(
        ["claude", "-p", prompt],
        capture_output=True, text=True, timeout=240,
    )
    if result.returncode != 0:
        raise RuntimeError(f"claude CLI failed: {result.stderr.strip()}")
    return _parse_llm_json(result.stdout)


def call_llm_anthropic_api(prompt, model, api_key):
    import anthropic
    client = anthropic.Anthropic(api_key=api_key)
    response = client.messages.create(
        model=model, max_tokens=16000,
        messages=[{"role": "user", "content": prompt}],
    )
    text = "".join(block.text for block in response.content if block.type == "text")
    return _parse_llm_json(text)


def call_llm_openai(prompt, model, api_key):
    from openai import OpenAI
    client = OpenAI(api_key=api_key)
    response = client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": prompt}],
    )
    return _parse_llm_json(response.choices[0].message.content)


def call_llm_gemini(prompt, model, api_key):
    from google import genai
    client = genai.Client(api_key=api_key)
    response = client.models.generate_content(model=model, contents=prompt)
    return _parse_llm_json(response.text)


def call_llm(prompt, ai_config):
    provider = ai_config["provider"]
    model = ai_config["model"]
    api_key = ai_config["api_key"]
    if provider == "anthropic":
        if ai_config.get("use_session_first"):
            try:
                return call_llm_claude_session(prompt)
            except Exception as e:
                print(f"[llm] claude session failed ({e}), falling back to Anthropic API ({model})")
        return call_llm_anthropic_api(prompt, model, api_key)
    elif provider == "openai":
        return call_llm_openai(prompt, model, api_key)
    elif provider == "gemini":
        return call_llm_gemini(prompt, model, api_key)
    raise RuntimeError(f"unknown AI provider: {provider}")
```

- [ ] **Step 4: Fetch `ai_config` once per connection and thread it through both call sites**

In `main()`, right after the existing `tags_context = ...` line (which itself follows `company_context`/`goals`/`tags` fetches), add:

```python
        ai_config = fetch_ai_config(args.worker_url, secret, conn["owner_email"])
        print(f"[llm] routing through {ai_config['provider']} / {ai_config['model']} for {conn['owner_email']}")
```

Update the two existing call sites:
- `themes = call_llm(theme_prompt)` → `themes = call_llm(theme_prompt, ai_config)`
- `result = call_llm(session_prompt)` → `result = call_llm(session_prompt, ai_config)`

- [ ] **Step 5: Verify syntax and imports**

```bash
python3 -c "import ast; ast.parse(open('bug_radar.py').read())"
python3 -c "import anthropic, openai; from google import genai; print('all imports OK')"
```
Expected: no errors, "all imports OK" printed.

- [ ] **Step 6: Commit**

```bash
git add bug_radar.py requirements.txt
git commit -m "Add multi-provider AI routing dispatcher to the pipeline"
```

---

### Task 8: End-to-end verification

**Files:** none planned (verification only; any drift found gets a fix committed to whichever file has the bug).

**Interfaces:** none new.

- [ ] **Step 1: Seed real default keys through the finished admin UI**

Log into the admin portal, go to AI Providers, and set real API keys + confirm default models for all 3 providers (the controller has these keys already, per the original request). This supersedes Task 2's placeholder-seed step if that was used.

- [ ] **Step 2: Confirm an untouched tenant still resolves to today's behavior**

```bash
curl -s -H "Authorization: Bearer $(security find-generic-password -s BUGRADAR_API_SECRET -w)" \
  "https://bug-radar.shubhamvishnu.workers.dev/api/pipeline/ai-config?owner_email=<a tenant with no override>"
```
Expected: `{"provider":"anthropic","model":"claude-opus-5","api_key":"...","use_session_first":true}` (model reflects whatever was actually set as the Anthropic default in Step 1).

- [ ] **Step 3: Route one real tenant to a non-Anthropic provider and run the pipeline**

Via the admin portal's Tenant Detail AI Routing section, switch one real tenant (e.g. the `dreamteam` connection) to Gemini with `gemini-3.1-pro-preview`. Then run:
```bash
python3 bug_radar.py --session-id <a known real session_id for that tenant>
```
Expected: the `[llm] routing through gemini / gemini-3.1-pro-preview for ...` log line appears, the run completes without error, and the resulting report is valid JSON with the expected task shape (same as any other successful run).

- [ ] **Step 4: Confirm the Anthropic session-to-API fallback**

Set the same or another tenant back to Anthropic (or use one already on Anthropic). Temporarily break the local session (e.g. `mv $(which claude) $(which claude).bak` or point `PATH` away from it for one invocation), then run the same `--session-id` command. Expected: a `[llm] claude session failed (...), falling back to Anthropic API (...)` log line, followed by a successful run via the API path. Restore the CLI afterward (`mv` back).

- [ ] **Step 5: Confirm key masking end-to-end**

```bash
curl -s -H "Authorization: Bearer $SECRET" https://bug-radar-admin.shubhamvishnu.workers.dev/api/admin/ai-providers
curl -s -H "Authorization: Bearer $SECRET" https://bug-radar-admin.shubhamvishnu.workers.dev/api/admin/ai-config/<the tenant configured in Step 3>
```
Expected: neither response contains a full plaintext key anywhere — only `masked_key` values of the shape `••••XXXX`.

- [ ] **Step 6: If any drift or bug is found, fix it and commit**

```bash
git add <fixed file>
git commit -m "Fix <what was wrong>, found during AI-routing end-to-end verification"
```

- [ ] **Step 7: If everything passes, no commit needed** — report which checks were run and that all passed as this task's completion note.
