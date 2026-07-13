import type Database from 'better-sqlite3';

export const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  engine TEXT NOT NULL,
  engine_session_id TEXT,
  source TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  connector TEXT,
  session_key TEXT,
  reply_context TEXT,
  message_id TEXT,
  transport_meta TEXT,
  employee TEXT,
  group_key TEXT,
  model TEXT,
  title TEXT,
  prompt_excerpt TEXT,
  parent_session_id TEXT,
  user_id TEXT,
  status TEXT DEFAULT 'idle',
  created_at TEXT NOT NULL,
  last_activity TEXT NOT NULL,
  last_error TEXT
)`;

export const CREATE_MESSAGES_TABLE = `
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  timestamp INTEGER NOT NULL
)`;

export const CREATE_MESSAGES_INDEX = `
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages (session_id, timestamp)
`;

export const CREATE_MESSAGES_TIMESTAMP_INDEX = `
CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages (timestamp DESC)
`;

export const CREATE_SESSION_KEY_INDEX = `
CREATE INDEX IF NOT EXISTS idx_sessions_session_key ON sessions (session_key, last_activity)
`;

export const CREATE_LAST_ACTIVITY_INDEX = `
CREATE INDEX IF NOT EXISTS idx_sessions_last_activity ON sessions (last_activity DESC)
`;

export const CREATE_STATUS_ACTIVITY_INDEX = `
CREATE INDEX IF NOT EXISTS idx_sessions_status_activity ON sessions (status, last_activity DESC)
`;

export const CREATE_SOURCE_ACTIVITY_INDEX = `
CREATE INDEX IF NOT EXISTS idx_sessions_source_activity ON sessions (source, last_activity DESC)
`;

export const CREATE_ENGINE_ACTIVITY_INDEX = `
CREATE INDEX IF NOT EXISTS idx_sessions_engine_activity ON sessions (engine, last_activity DESC)
`;

export const CREATE_PARENT_INDEX = `
CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions (parent_session_id)
`;

export const CREATE_GROUP_ACTIVITY_INDEX = `
CREATE INDEX IF NOT EXISTS idx_sessions_group_activity ON sessions (group_key, last_activity DESC)
`;

export const CREATE_CWD_ACTIVITY_INDEX = `
CREATE INDEX IF NOT EXISTS idx_sessions_cwd_activity ON sessions (cwd, last_activity DESC)
`;

export const CREATE_FILES_TABLE = `
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  size INTEGER NOT NULL,
  mimetype TEXT,
  path TEXT,
  sha256 TEXT,
  artifact_kind TEXT NOT NULL DEFAULT 'input',
  producing_run_id TEXT,
  source_url TEXT,
  source_path TEXT,
  tags TEXT,
  notes TEXT,
  created_at TEXT NOT NULL
)
`;

export const CREATE_ARCHIVES_TABLE = `
CREATE TABLE IF NOT EXISTS archives (
  id TEXT PRIMARY KEY,
  label TEXT,
  note TEXT,
  kind TEXT NOT NULL,
  source_ref TEXT,
  created_at TEXT NOT NULL,
  session_count INTEGER NOT NULL DEFAULT 0,
  payload TEXT NOT NULL
)
`;

export const CREATE_ARCHIVES_CREATED_INDEX = `
CREATE INDEX IF NOT EXISTS idx_archives_created ON archives (created_at DESC)
`;

export const CREATE_APPROVALS_TABLE = `
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  actor TEXT,
  decision_notes TEXT,
  resulting_action TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
)
`;

export const CREATE_APPROVALS_CREATED_INDEX = `
CREATE INDEX IF NOT EXISTS idx_approvals_created ON approvals (created_at DESC)
`;

export const CREATE_APPROVALS_SESSION_INDEX = `
CREATE INDEX IF NOT EXISTS idx_approvals_session ON approvals (session_id)
`;

export const CREATE_APPROVALS_PENDING_FALLBACK_INDEX = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_approvals_pending_fallback_session
ON approvals (session_id, type, state)
WHERE type = 'fallback' AND state = 'pending'
`;

export const CREATE_META_TABLE = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
)
`;

export const CREATE_EXTERNAL_OUTBOX_TABLE = `
CREATE TABLE IF NOT EXISTS external_outbox (
  id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  partition_key TEXT,
  idempotency_key TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  sink_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_attempt_at TEXT,
  claim_expires_at TEXT,
  delivered_at TEXT,
  remote_id TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL
)`;

export const CREATE_EXTERNAL_OUTBOX_IDEMPOTENCY_INDEX = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_external_outbox_sink_idempotency
ON external_outbox (sink_name, idempotency_key)
`;

export const CREATE_EXTERNAL_OUTBOX_PENDING_INDEX = `
CREATE INDEX IF NOT EXISTS idx_external_outbox_pending
ON external_outbox (status, next_attempt_at, created_at)
`;

export const CREATE_EXTERNAL_OUTBOX_CLAIM_EXPIRY_INDEX = `
CREATE INDEX IF NOT EXISTS idx_external_outbox_claim_expiry
ON external_outbox (status, claim_expires_at)
`;

export const CREATE_CONNECTOR_WEBHOOK_REPLAY_TABLE = `
CREATE TABLE IF NOT EXISTS connector_webhook_replay (
  connector TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (connector, key_hash)
)
`;

export const CREATE_CONNECTOR_WEBHOOK_REPLAY_EXPIRY_INDEX = `
CREATE INDEX IF NOT EXISTS idx_connector_webhook_replay_expiry
ON connector_webhook_replay (expires_at_ms)
`;

export const CREATE_EMAIL_MESSAGES_TABLE = `
CREATE TABLE IF NOT EXISTS email_messages (
  id TEXT PRIMARY KEY,
  inbox_id TEXT NOT NULL,
  provider_message_id TEXT NOT NULL,
  message_id_header TEXT,
  thread_key TEXT NOT NULL,
  from_address TEXT,
  to_addresses TEXT NOT NULL,
  cc_addresses TEXT NOT NULL,
  subject TEXT,
  received_at TEXT,
  text_body TEXT NOT NULL,
  html_body TEXT,
  headers_json TEXT NOT NULL,
  auth_results TEXT,
  attachments_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'cached',
  session_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
`;

export const CREATE_EMAIL_DEDUPE_TABLE = `
CREATE TABLE IF NOT EXISTS email_ingest_state (
  inbox_id TEXT NOT NULL,
  provider_message_id TEXT NOT NULL,
  email_message_id TEXT NOT NULL,
  status TEXT NOT NULL,
  session_id TEXT,
  error TEXT,
  first_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (inbox_id, provider_message_id)
)
`;

export const CREATE_EMAIL_HEALTH_TABLE = `
CREATE TABLE IF NOT EXISTS email_inbox_health (
  inbox_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  detail TEXT,
  last_checked_at TEXT,
  last_success_at TEXT,
  last_error_at TEXT
)
`;

export const CREATE_EMAIL_MESSAGES_INBOX_INDEX = `
CREATE INDEX IF NOT EXISTS idx_email_messages_inbox_received
ON email_messages (inbox_id, received_at DESC, created_at DESC)
`;

export const CREATE_EMAIL_MESSAGES_THREAD_INDEX = `
CREATE INDEX IF NOT EXISTS idx_email_messages_thread
ON email_messages (inbox_id, thread_key, received_at DESC)
`;

export const CREATE_FTS = `
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content, content='messages', content_rowid='rowid', tokenize='unicode61');
CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages WHEN new.role IN ('user','assistant') BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages WHEN old.role IN ('user','assistant') BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages WHEN new.role IN ('user','assistant') BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
`;

export function installBaseSchema(db: Database.Database): void {
  db.exec(CREATE_TABLE);
  db.exec(CREATE_MESSAGES_TABLE);
  db.exec(CREATE_MESSAGES_INDEX);
  db.exec(CREATE_MESSAGES_TIMESTAMP_INDEX);
  db.exec(CREATE_META_TABLE);
}

export function installPostMigrationSchema(db: Database.Database): void {
  db.exec(CREATE_SESSION_KEY_INDEX);
  db.exec(CREATE_LAST_ACTIVITY_INDEX);
  db.exec(CREATE_STATUS_ACTIVITY_INDEX);
  db.exec(CREATE_SOURCE_ACTIVITY_INDEX);
  db.exec(CREATE_ENGINE_ACTIVITY_INDEX);
  db.exec(CREATE_PARENT_INDEX);
  db.exec(CREATE_GROUP_ACTIVITY_INDEX);
  db.exec(CREATE_CWD_ACTIVITY_INDEX);
  db.exec(`
    CREATE TABLE IF NOT EXISTS queue_items (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      session_key TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_queue_session
      ON queue_items (session_key, status, position);
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS queue_pauses (
      session_key TEXT PRIMARY KEY,
      paused_at TEXT NOT NULL
    );
  `);
  db.exec(CREATE_FILES_TABLE);
  db.exec(CREATE_ARCHIVES_TABLE);
  db.exec(CREATE_ARCHIVES_CREATED_INDEX);
  db.exec(CREATE_APPROVALS_TABLE);
  db.exec(CREATE_APPROVALS_CREATED_INDEX);
  db.exec(CREATE_APPROVALS_SESSION_INDEX);
  db.exec(CREATE_APPROVALS_PENDING_FALLBACK_INDEX);
  db.exec(CREATE_EXTERNAL_OUTBOX_TABLE);
  db.exec(CREATE_EXTERNAL_OUTBOX_IDEMPOTENCY_INDEX);
  db.exec(CREATE_EXTERNAL_OUTBOX_PENDING_INDEX);
  db.exec(CREATE_EXTERNAL_OUTBOX_CLAIM_EXPIRY_INDEX);
  db.exec(CREATE_CONNECTOR_WEBHOOK_REPLAY_TABLE);
  db.exec(CREATE_CONNECTOR_WEBHOOK_REPLAY_EXPIRY_INDEX);
  db.exec(CREATE_EMAIL_MESSAGES_TABLE);
  try {
    db.exec("ALTER TABLE email_messages ADD COLUMN auth_results TEXT");
  } catch {
    // Column already exists on upgraded homes.
  }
  db.exec(CREATE_EMAIL_DEDUPE_TABLE);
  db.exec(CREATE_EMAIL_HEALTH_TABLE);
  db.exec(CREATE_EMAIL_MESSAGES_INBOX_INDEX);
  db.exec(CREATE_EMAIL_MESSAGES_THREAD_INDEX);
  db.exec(`UPDATE email_messages SET received_at = created_at WHERE received_at IS NULL`);
}
