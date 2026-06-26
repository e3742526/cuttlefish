import type Database from 'better-sqlite3';

export function migrateMessagesSchema(database: Database.Database): void {
  const cols = database.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));
  if (!colNames.has('media')) {
    database.exec('ALTER TABLE messages ADD COLUMN media TEXT');
  }
  if (!colNames.has('partial')) {
    database.exec('ALTER TABLE messages ADD COLUMN partial INTEGER');
  }
  if (!colNames.has('seq')) {
    database.exec('ALTER TABLE messages ADD COLUMN seq INTEGER');
  }
  if (!colNames.has('tool_call')) {
    database.exec('ALTER TABLE messages ADD COLUMN tool_call TEXT');
  }
  if (!colNames.has('blocks')) {
    database.exec('ALTER TABLE messages ADD COLUMN blocks TEXT');
  }
}

export function migrateSessionsSchema(database: Database.Database): void {
  const cols = database.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));
  const missingColumns: Array<[string, string, string?]> = [
    ['title', 'TEXT'],
    ['parent_session_id', 'TEXT'],
    ['connector', 'TEXT'],
    ['session_key', 'TEXT'],
    ['reply_context', 'TEXT'],
    ['message_id', 'TEXT'],
    ['transport_meta', 'TEXT'],
    ['total_cost', 'REAL', '0'],
    ['total_turns', 'INTEGER', '0'],
    ['effort_level', 'TEXT'],
    ['last_context_tokens', 'INTEGER'],
    ['user_id', 'TEXT'],
    ['prompt_excerpt', 'TEXT'],
    ['cwd', 'TEXT'],
  ];

  for (const [name, type, defaultVal] of missingColumns) {
    if (!colNames.has(name)) {
      const defaultClause = defaultVal !== undefined ? ` DEFAULT ${defaultVal}` : '';
      database.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${type}${defaultClause}`);
    }
  }

  const refreshedCols = database.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
  const refreshedNames = new Set(refreshedCols.map((c) => c.name));
  if (refreshedNames.has('session_key')) {
    database.exec(`UPDATE sessions SET session_key = COALESCE(session_key, source_ref) WHERE session_key IS NULL OR session_key = ''`);
  }
  if (refreshedNames.has('connector')) {
    database.exec(`UPDATE sessions SET connector = COALESCE(connector, source) WHERE connector IS NULL OR connector = ''`);
  }
}

export function migrateFilesSchema(database: Database.Database): void {
  const cols = database.prepare('PRAGMA table_info(files)').all() as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));
  const missingColumns: Array<[string, string, string?]> = [
    ['sha256', 'TEXT'],
    ['artifact_kind', 'TEXT', "'input'"],
    ['producing_run_id', 'TEXT'],
    ['source_url', 'TEXT'],
    ['source_path', 'TEXT'],
    ['tags', 'TEXT'],
    ['notes', 'TEXT'],
  ];

  for (const [name, type, defaultVal] of missingColumns) {
    if (!colNames.has(name)) {
      const defaultClause = defaultVal !== undefined ? ` DEFAULT ${defaultVal}` : '';
      database.exec(`ALTER TABLE files ADD COLUMN ${name} ${type}${defaultClause}`);
    }
  }

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_files_kind_created ON files (artifact_kind, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_files_producing_run ON files (producing_run_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_files_sha256 ON files (sha256);
  `);
}

export function migrateApprovalsSchema(database: Database.Database): void {
  const cols = database.prepare('PRAGMA table_info(approvals)').all() as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));
  const missingColumns: Array<[string, string]> = [
    ['decision_notes', 'TEXT'],
    ['resulting_action', 'TEXT'],
  ];
  for (const [name, type] of missingColumns) {
    if (!colNames.has(name)) {
      database.exec(`ALTER TABLE approvals ADD COLUMN ${name} ${type}`);
    }
  }
}

export function migrateExternalOutboxSchema(database: Database.Database): void {
  database.exec(`
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
      delivered_at TEXT,
      remote_id TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_external_outbox_sink_idempotency
      ON external_outbox (sink_name, idempotency_key);
    CREATE INDEX IF NOT EXISTS idx_external_outbox_pending
      ON external_outbox (status, next_attempt_at, created_at);
  `);
}
