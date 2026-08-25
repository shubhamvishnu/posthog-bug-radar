CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  generated_at TEXT NOT NULL,
  macro_themes TEXT NOT NULL,
  micro_findings TEXT NOT NULL,
  theme_prompt TEXT,
  session_prompt TEXT,
  owner_email TEXT,
  connection_id INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS corrections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT DEFAULT (datetime('now')),
  session_id TEXT NOT NULL,
  task_index INTEGER NOT NULL,
  task_title TEXT,
  task_goal TEXT,
  field TEXT NOT NULL,
  from_value TEXT,
  to_value TEXT,
  reason TEXT NOT NULL,
  owner_email TEXT,
  connection_id INTEGER
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS otp_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  code TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  consumed INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  surface TEXT NOT NULL DEFAULT 'main'
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  surface TEXT NOT NULL DEFAULT 'main'
);

CREATE TABLE IF NOT EXISTS connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_email TEXT NOT NULL,
  region TEXT NOT NULL,
  project_id TEXT NOT NULL,
  project_name TEXT,
  timezone TEXT,
  encrypted_api_key TEXT NOT NULL,
  iv TEXT NOT NULL,
  identity_email_prop TEXT,
  identity_name_prop TEXT,
  identity_role_prop TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  last_error TEXT,
  last_synced_at TEXT,
  sync_freq TEXT NOT NULL DEFAULT '1d',
  sync_max_sessions INTEGER NOT NULL DEFAULT 8,
  last_pipeline_run_at TEXT,
  pipeline_lock_at TEXT,
  pipeline_lock_token TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS connection_config (
  connection_id INTEGER PRIMARY KEY REFERENCES connections(id),
  config_json TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS company_knowledge (
  owner_email TEXT PRIMARY KEY,
  domain TEXT,
  description TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_email TEXT NOT NULL,
  purpose TEXT NOT NULL,
  description TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'user',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_email TEXT NOT NULL,
  label TEXT NOT NULL,
  color TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'user',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS connection_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT,
  trigger_label TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS slack_connections (
  owner_email TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  team_name TEXT NOT NULL,
  encrypted_bot_token TEXT,
  iv TEXT,
  connected_by_email TEXT,
  status TEXT NOT NULL DEFAULT 'connected',
  connected_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS slack_oauth_state (
  state TEXT PRIMARY KEY,
  owner_email TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS slack_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_email TEXT NOT NULL,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  cond_outcome TEXT NOT NULL DEFAULT '[]',
  cond_severity TEXT NOT NULL DEFAULT '[]',
  cond_real_bug TEXT NOT NULL DEFAULT 'either',
  cond_reachable TEXT NOT NULL DEFAULT 'either',
  cond_goal_ids TEXT NOT NULL DEFAULT '[]',
  cond_tag_ids TEXT NOT NULL DEFAULT '[]',
  channel_id TEXT NOT NULL,
  channel_name TEXT NOT NULL,
  dm_owner INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS admin_login_attempts (
  email TEXT PRIMARY KEY,
  failed_count INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

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
