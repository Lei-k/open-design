import type Database from 'better-sqlite3';

const routineColumns = `id TEXT PRIMARY KEY, owner_account_id TEXT NOT NULL, name TEXT NOT NULL, prompt TEXT NOT NULL,
  schedule_json TEXT NOT NULL, target_json TEXT NOT NULL, skill_ids_json TEXT NOT NULL DEFAULT '[]',
  execution_source TEXT NOT NULL CHECK(execution_source IN ('personal_subscription','company_pool','personal_api_key')),
  enabled INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, template_id TEXT`;

/** Widen source custody without cascading deletion of history or claimed schedule slots. */
export function migrateStudioRoutines(db: Database.Database): void {
  const existing = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'studio_routines'").get() as { sql: string } | undefined;
  if (existing && !existing.sql.includes("'personal_api_key'")) {
    if (db.inTransaction) throw new Error('Studio routine migration requires a standalone transaction');
    const foreignKeys = db.pragma('foreign_keys', { simple: true }) === 1;
    const hasTemplate = (db.prepare('PRAGMA table_info(studio_routines)').all() as Array<{ name: string }>).some((column) => column.name === 'template_id');
    // DROP with foreign_keys enabled would delete every child row. Keep this
    // synchronous and restore the caller's setting on success or rollback.
    db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        db.exec(`CREATE TABLE studio_routines_next (${routineColumns});
          INSERT INTO studio_routines_next SELECT id, owner_account_id, name, prompt, schedule_json, target_json, skill_ids_json,
            execution_source, enabled, created_at, updated_at, ${hasTemplate ? 'template_id' : 'NULL'} FROM studio_routines;
          DROP TABLE studio_routines;
          ALTER TABLE studio_routines_next RENAME TO studio_routines;`);
        for (const table of ['studio_routine_runs', 'studio_routine_claims']) {
          if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
            && (db.pragma(`foreign_key_check(${table})`) as unknown[]).length) throw new Error('Studio routine migration found invalid history');
        }
      }).immediate();
    } finally { db.pragma(`foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`); }
  }
  db.exec(`CREATE TABLE IF NOT EXISTS studio_routines (${routineColumns});
    CREATE INDEX IF NOT EXISTS studio_routines_owner ON studio_routines(owner_account_id);
    CREATE TABLE IF NOT EXISTS studio_routine_runs (
      id TEXT PRIMARY KEY, routine_id TEXT NOT NULL REFERENCES studio_routines(id) ON DELETE CASCADE,
      owner_account_id TEXT NOT NULL, trigger TEXT NOT NULL, status TEXT NOT NULL, project_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL, agent_run_id TEXT NOT NULL, started_at INTEGER NOT NULL, completed_at INTEGER,
      summary TEXT, error TEXT, error_code TEXT
    );
    CREATE INDEX IF NOT EXISTS studio_routine_runs_routine ON studio_routine_runs(routine_id, started_at);
    CREATE TABLE IF NOT EXISTS studio_routine_claims (
      routine_id TEXT NOT NULL REFERENCES studio_routines(id) ON DELETE CASCADE, slot_at INTEGER NOT NULL,
      PRIMARY KEY (routine_id, slot_at)
    );`);
  if (!(db.prepare('PRAGMA table_info(studio_routines)').all() as Array<{ name: string }>).some((column) => column.name === 'template_id')) {
    db.exec('ALTER TABLE studio_routines ADD COLUMN template_id TEXT');
  }
  if (!(db.prepare('PRAGMA table_info(studio_routines)').all() as Array<{ name: string }>).some((column) => column.name === 'connector_ids_json')) {
    db.exec("ALTER TABLE studio_routines ADD COLUMN connector_ids_json TEXT NOT NULL DEFAULT '[]'");
  }
  if (!(db.prepare('PRAGMA table_info(studio_routines)').all() as Array<{ name: string }>).some((column) => column.name === 'mcp_server_ids_json')) {
    db.exec("ALTER TABLE studio_routines ADD COLUMN mcp_server_ids_json TEXT NOT NULL DEFAULT '[]'");
  }

}
