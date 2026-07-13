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
    ['employee', 'TEXT'],
    ['group_key', 'TEXT'],
    ['model', 'TEXT'],
    ['engine_session_id', 'TEXT'],
    ['last_error', 'TEXT'],
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
  if (refreshedNames.has('group_key')) {
    database.exec(`
      UPDATE sessions
         SET group_key = CASE
           WHEN source = 'cron' OR source_ref LIKE 'cron:%' THEN '__cron__'
           WHEN employee IS NULL OR employee = '' THEN '__direct__'
           ELSE employee
         END
       WHERE group_key IS NULL OR group_key = ''
    `);
  }
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_group_activity ON sessions (group_key, last_activity DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_cwd_activity ON sessions (cwd, last_activity DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_status_activity ON sessions (status, last_activity DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_source_activity ON sessions (source, last_activity DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_engine_activity ON sessions (engine, last_activity DESC);
  `);
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
    CREATE INDEX IF NOT EXISTS idx_files_path ON files (path);
    CREATE INDEX IF NOT EXISTS idx_files_source_path ON files (source_path);
  `);
}

export function migrateApprovalsSchema(database: Database.Database): void {
  const cols = database.prepare('PRAGMA table_info(approvals)').all() as Array<{ name: string }>;
  // Fresh DB: the approvals table is created (with its FK) by installPostMigrationSchema,
  // which runs after this migration — nothing to upgrade here.
  if (cols.length === 0) return;
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

  // Add the FOREIGN KEY (session_id -> sessions.id, ON DELETE CASCADE) on upgraded
  // homes whose approvals table predates it. SQLite cannot ALTER-ADD a constraint,
  // so the table is rebuilt. PRAGMA foreign_keys must be toggled OUTSIDE any
  // transaction (better-sqlite3 throws otherwise), and the rebuild runs with FKs
  // OFF so copying rows can't trip the constraint being added.
  const hasForeignKey = (database.prepare('PRAGMA foreign_key_list(approvals)').all() as unknown[]).length > 0;
  if (!hasForeignKey) {
    // Pre-flight: remove any orphaned approvals (no matching session) so the
    // rebuild and subsequent FK enforcement can't fail on pre-existing dangling rows.
    database.prepare('DELETE FROM approvals WHERE session_id NOT IN (SELECT id FROM sessions)').run();

    const fkWasOn = (database.pragma('foreign_keys', { simple: true }) as number) === 1;
    database.pragma('foreign_keys = OFF');
    try {
      database.exec(`
        CREATE TABLE approvals_new (
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
        );
        INSERT INTO approvals_new
          (id, session_id, type, payload, state, created_at, resolved_at, actor, decision_notes, resulting_action)
          SELECT id, session_id, type, payload, state, created_at, resolved_at, actor, decision_notes, resulting_action
          FROM approvals;
        DROP TABLE approvals;
        ALTER TABLE approvals_new RENAME TO approvals;
      `);
    } finally {
      if (fkWasOn) database.pragma('foreign_keys = ON');
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
      claim_expires_at TEXT,
      delivered_at TEXT,
      remote_id TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL
    );
  `);
  const cols = database.prepare('PRAGMA table_info(external_outbox)').all() as Array<{ name: string }>;
  if (!cols.some((column) => column.name === 'claim_expires_at')) {
    database.exec('ALTER TABLE external_outbox ADD COLUMN claim_expires_at TEXT');
  }
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_external_outbox_sink_idempotency
      ON external_outbox (sink_name, idempotency_key);
    CREATE INDEX IF NOT EXISTS idx_external_outbox_pending
      ON external_outbox (status, next_attempt_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_external_outbox_claim_expiry
      ON external_outbox (status, claim_expires_at);
  `);
}
