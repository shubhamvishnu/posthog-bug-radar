# Multi-Provider AI Routing — Design

## Goal

Give each tenant an independently configurable AI provider and model for the
`bug_radar.py` pipeline's LLM calls, controlled entirely from the admin
portal: a dropdown per tenant (Anthropic / OpenAI / Gemini + model), backed
by three org-wide default API keys the admin can also edit, with an optional
per-tenant key override. For Anthropic specifically, keep the existing
local-CLI-session-first behavior, falling back to the Anthropic API only if
the session fails.

## Non-goals

- Cross-provider automatic fallback. If a tenant's configured provider call
  fails outright, it errors (and the existing pipeline error-reporting path
  — `sync-failed`, per-connection `last_error` — surfaces it), it does not
  silently retry against a different provider's model. Prompts are not
  guaranteed to produce equivalent output shape/quality across providers,
  so silently switching providers mid-run is a correctness risk, not a
  resilience win.
- Per-call model override (e.g. "use a cheaper model for macro themes, a
  pricier one for micro sessions"). One provider+model per tenant, used for
  every LLM call in that tenant's pipeline run.
- Automatic model-list discovery/live capability lookup. The curated
  dropdown is a maintained list (see Model catalog below); keeping it
  current is a manual, cheap edit, not a live API integration.
- Usage/cost tracking or per-provider spend dashboards. Out of scope for
  this pass — a natural admin-portal follow-up once multiple providers are
  actually in use.

## Current state

`bug_radar.py`'s `call_llm(prompt)` (line 359) shells out to the local
`claude` CLI in headless mode (`claude -p prompt`), parses JSON from
stdout, and is the only LLM entry point — used once per macro-theme pass
and once per session in the micro pass. There is no API key involved at
all today (the CLI uses whatever Claude Code account is authenticated on
the machine running the pipeline), no provider abstraction, and no
per-tenant routing of any kind.

The pipeline already fetches tenant-scoped context from the Worker before
running (`fetch_company_context`, `fetch_goals`, `fetch_tags`, each a
`requests.get` against `{worker_url}/api/pipeline/...` with a
`BUGRADAR_API_SECRET` bearer header) — the new AI-config fetch follows this
exact established pattern.

Encryption of tenant-scoped secrets (the existing PostHog API keys) lives
only on the main worker (`worker/src/index.js`), via `encryptSecret(env,
plaintext)` / `decryptSecret(env, ciphertextB64, ivB64)`
(AES-GCM, key from the `CONNECTION_ENCRYPTION_KEY` secret). `worker-admin`
has no access to that key and never decrypts anything itself — for the one
existing case where it needs privileged main-worker data (serving captured
screenshots), it proxies through the `MAIN_WORKER` service binding to a
main-worker route authenticated with a bearer secret
(`ADMIN_MEDIA_SECRET`), exactly the shape the new AI-key CRUD needs to
follow.

## Data model (`worker/schema.sql`, main worker only)

```sql
CREATE TABLE IF NOT EXISTS ai_provider_defaults (
  provider TEXT PRIMARY KEY,        -- 'anthropic' | 'openai' | 'gemini'
  encrypted_api_key TEXT NOT NULL,
  iv TEXT NOT NULL,
  default_model TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tenant_ai_config (
  owner_email TEXT PRIMARY KEY,
  provider TEXT NOT NULL,           -- 'anthropic' | 'openai' | 'gemini'
  model TEXT NOT NULL,
  encrypted_api_key TEXT,           -- nullable: null = use that provider's default key
  iv TEXT,                          -- nullable, paired with encrypted_api_key
  updated_at TEXT DEFAULT (datetime('now'))
);
```

A tenant with no `tenant_ai_config` row (every existing tenant, until
explicitly reconfigured) resolves to `provider = 'anthropic'`, model = the
`anthropic` row's `default_model` from `ai_provider_defaults`, session-first
behavior on — i.e. today's actual behavior, preserved exactly, so shipping
this feature changes nothing for a tenant nobody has touched.

## Effective-config resolution (main worker, shared by both new endpoints below)

```
resolve(owner_email):
  row = SELECT * FROM tenant_ai_config WHERE owner_email = ?
  if row is null:
    provider = 'anthropic'; model = ai_provider_defaults['anthropic'].default_model
    key = decrypt(ai_provider_defaults['anthropic'])
  else:
    provider = row.provider; model = row.model
    key = row.encrypted_api_key present
          ? decrypt(row.encrypted_api_key, row.iv)      # tenant override key
          : decrypt(ai_provider_defaults[row.provider])  # org default key for that provider
  use_session_first = (provider == 'anthropic')
  return { provider, model, api_key: key, use_session_first }
```

The Anthropic API key resolved here (default or tenant override) is used
**only** as the fallback path when the local CLI session fails — it is
never sent anywhere on a successful session call, since the session
doesn't consume an API key at all. For `openai`/`gemini`, the resolved key
is used directly on every call, since neither has a session concept.

## Worker routes (main worker, `worker/src/index.js`)

**Pipeline-authed** (`BUGRADAR_API_SECRET`, matching `fetch_company_context`'s
existing pattern exactly):
- `GET /api/pipeline/ai-config?owner_email=...` → the resolved object above,
  as JSON. `bug_radar.py` calls this once per pipeline run, before its
  first LLM call.

**Admin-authed** (bearer token, same shape as the existing
`POST /api/admin/media/:key` route's `ADMIN_MEDIA_SECRET` check — reuse
that secret, no need for a second one):
- `GET /api/admin/ai-providers` → the 3 `ai_provider_defaults` rows, key
  **masked** (e.g. last 4 chars only) — full plaintext keys are never
  returned to any client, matching how PostHog connection keys already
  behave (write-only from the client's perspective; the UI shows "•••• last4",
  never the live value).
- `PUT /api/admin/ai-providers/:provider` (body `{api_key?, default_model}`)
  → upserts one `ai_provider_defaults` row; `api_key` optional (omit to
  change only `default_model` without touching the stored key).
- `GET /api/admin/ai-config/:owner_email` → that tenant's `tenant_ai_config`
  row if any (key masked, same rule), or `null`.
- `PUT /api/admin/ai-config/:owner_email` (body `{provider, model, api_key?}`)
  → upserts; omitted/empty `api_key` means "use the provider's default key"
  (stores `NULL` for `encrypted_api_key`/`iv`).
- `DELETE /api/admin/ai-config/:owner_email` → removes the override row,
  reverting that tenant to the `anthropic`-default behavior above.

## worker-admin routes (thin proxy, mirrors the existing media-proxy shape)

`worker-admin/src/index.js` gets 5 new routes, each: `adminAuthed()` check,
then a single `env.MAIN_WORKER.fetch(...)` call to the corresponding main-worker
route above with the `ADMIN_MEDIA_SECRET` bearer header, response passed
through — no D1 access, no encryption logic, identical shape to the
existing `mediaProxyMatch` handler.

## Admin portal frontend (`worker-admin/public/index.html`)

**New "AI Providers" sidebar screen** (current sidebar order is Overview,
Tenants, Sessions, Integrations, Goals, Tags, Slack, Events — this is
inserted after Slack, before Events): one card per provider
(Anthropic/OpenAI/Gemini) — masked key + "Update key" reveal-on-click
field, model dropdown (curated list below + "Other" free-text), Save
button per card.

**New "AI Routing" section on Tenant Detail** (`renderUserDetail()`),
placed after the Slack section: provider dropdown → model dropdown
(curated list for that provider + "Other" free-text) → "Use org default
key" (default, shows nothing further) vs "Custom key for this tenant"
(reveals a key input). Save button. Shows the currently-effective
provider/model even when no override row exists (i.e. displays "Anthropic
· claude-opus-5 (org default)" rather than a blank state), so the admin
always sees what a tenant is actually using, not just whether they've
customized it.

## Model catalog (curated dropdown lists)

Verified current as of 2026-08-25 (Anthropic from this session's loaded
model reference; OpenAI/Gemini from a live web search this session — cite
below since these move fast and this list is a starting point, not a
permanent source of truth):

| Provider | Curated options | Default |
|---|---|---|
| Anthropic | `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5` | `claude-opus-5` |
| OpenAI | `gpt-5.6-sol` (flagship, alias for `gpt-5.6-sol`), `gpt-5.6-terra`, `gpt-5.6-luna` | `gpt-5.6-sol` |
| Gemini | `gemini-3.1-pro-preview`, `gemini-3.7-flash`, `gemini-3.5-flash` | `gemini-3.1-pro-preview` |

Each dropdown's last option is "Other (custom)", revealing a free-text
field — so a model released after this list was written is never a
blocker, just a manual typed value until the dropdown is updated.

## Pipeline changes (`bug_radar.py`)

`call_llm(prompt)` → `call_llm(prompt, ai_config)`, becoming a dispatcher:

- `provider == 'anthropic'`: if `use_session_first`, try the existing CLI
  path (`subprocess.run(["claude", "-p", prompt], ...)`, unchanged); on any
  failure (non-zero exit, timeout, exception), log the failure and fall
  back to a direct Anthropic API call using `ai_config['model']` and
  `ai_config['api_key']` (new `anthropic` Python SDK dependency).
- `provider == 'openai'`: direct call via the `openai` SDK, using
  `ai_config['model']`/`ai_config['api_key']`.
- `provider == 'gemini'`: direct call via the `google-genai` SDK, using
  `ai_config['model']`/`ai_config['api_key']`.
- All three paths return the same shape the caller already expects: parsed
  JSON, after stripping a possible ` ```json ` fence, matching the existing
  CLI path's post-processing exactly — the two call sites in `main()`
  (macro pass, per-session micro pass) don't change at all beyond passing
  `ai_config` through.

`main()` fetches `ai_config` once via a new `fetch_ai_config(worker_url,
secret, owner_email)` (same shape as `fetch_company_context`), right
alongside the existing company-context/goals/tags fetches, before either
LLM pass begins.

New dependencies in `requirements.txt`: `anthropic`, `openai`, `google-genai`.

## Verification plan

- Migrate schema (2 new tables), confirm via direct D1 query, same pattern
  used for every prior migration this project.
- Seed the 3 default keys via the new admin UI, confirm `GET
  /api/pipeline/ai-config?owner_email=<any-untouched-tenant>` resolves to
  `anthropic`/the default model/session-first — proving the "no behavior
  change for untouched tenants" guarantee.
- Set one tenant to a non-Anthropic provider via Tenant Detail's new
  section, confirm the resolved config reflects it, run
  `bug_radar.py --session-id <a known session>` against that tenant and
  confirm the pipeline actually calls the configured provider (visible via
  a log line naming the provider before each LLM call) and produces a
  valid report.
- Confirm the Anthropic session→API fallback path specifically: force the
  local CLI to fail (e.g. temporarily rename the binary or point at a bad
  session), confirm the pipeline logs the fallback and still produces a
  valid report via the Anthropic API path.
- Confirm key masking: `GET /api/admin/ai-providers` and
  `GET /api/admin/ai-config/:owner_email` never return a full plaintext
  key in their JSON.
