import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { studioRoutineAgentId, studioRoutineExecutionSource } from '@open-design/contracts';
import { migrateStudioRoutines } from '../../src/storage/studio-routines.js';

let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); db.pragma('foreign_keys = ON'); });
afterEach(() => db.close());
function legacy(withTemplate: boolean, extraSource = '') {
  db.exec(`CREATE TABLE studio_routines (
    id TEXT PRIMARY KEY, owner_account_id TEXT NOT NULL, name TEXT NOT NULL, prompt TEXT NOT NULL,
    schedule_json TEXT NOT NULL, target_json TEXT NOT NULL, skill_ids_json TEXT NOT NULL DEFAULT '[]',
    execution_source TEXT NOT NULL CHECK(execution_source IN ('personal_subscription','company_pool'${extraSource})),
    enabled INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL${withTemplate ? ', template_id TEXT' : ''});
    CREATE TABLE studio_routine_runs (id TEXT PRIMARY KEY, routine_id TEXT NOT NULL REFERENCES studio_routines(id) ON DELETE CASCADE,
      owner_account_id TEXT NOT NULL, trigger TEXT NOT NULL, status TEXT NOT NULL, project_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL, agent_run_id TEXT NOT NULL, started_at INTEGER NOT NULL, completed_at INTEGER,
      summary TEXT, error TEXT, error_code TEXT);
    CREATE TABLE studio_routine_claims (routine_id TEXT NOT NULL REFERENCES studio_routines(id) ON DELETE CASCADE,
      slot_at INTEGER NOT NULL, PRIMARY KEY (routine_id, slot_at));
    INSERT INTO studio_routines VALUES ('old', 'A', 'Saved', 'PROMPT', '{}', '{}', '[]', 'company_pool', 1, 10, 11${withTemplate ? ", 'compress-project-context'" : ''});
    INSERT INTO studio_routine_runs VALUES ('history', 'old', 'A', 'schedule', 'succeeded', 'project', 'chat', 'agent', 12, 13, 'SUMMARY', NULL, NULL);
    INSERT INTO studio_routine_claims VALUES ('old', 12);`);
}
it.each([false, true])('widens the legacy source CHECK and preserves history, claims and template data (template=%s)', (withTemplate) => {
  legacy(withTemplate);
  const history = db.prepare('SELECT * FROM studio_routine_runs').all();
  const claims = db.prepare('SELECT * FROM studio_routine_claims').all();
  migrateStudioRoutines(db);
  migrateStudioRoutines(db);
  expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  expect(db.pragma('foreign_key_check')).toEqual([]);
  expect(db.prepare('SELECT * FROM studio_routine_runs').all()).toEqual(history);
  expect(db.prepare('SELECT * FROM studio_routine_claims').all()).toEqual(claims);
  expect(db.prepare('SELECT template_id FROM studio_routines').get()).toEqual({ template_id: withTemplate ? 'compress-project-context' : null });
  expect(() => db.prepare('INSERT INTO studio_routine_claims VALUES (?, ?)').run('old', 12)).toThrow();
  db.prepare('UPDATE studio_routines SET execution_source = ? WHERE id = ?').run('personal_api_key', 'old');
  expect(db.prepare('SELECT execution_source FROM studio_routines').get()).toEqual({ execution_source: 'personal_api_key' });
  expect(() => db.prepare('UPDATE studio_routines SET execution_source = ? WHERE id = ?').run('host-fallback', 'old')).toThrow();
  // The rebuilt parent still owns its children with the original CASCADE.
  db.prepare('DELETE FROM studio_routines WHERE id = ?').run('old');
  expect(db.prepare('SELECT * FROM studio_routine_runs').all()).toEqual([]);
  expect(db.prepare('SELECT * FROM studio_routine_claims').all()).toEqual([]);
});
it('rolls back the entire rebuild and restores foreign keys if existing data cannot satisfy the new contract', () => {
  legacy(true, ",'invalid'");
  db.prepare('UPDATE studio_routines SET execution_source = ?').run('invalid');
  const rows = db.prepare('SELECT * FROM studio_routines').all();
  expect(() => migrateStudioRoutines(db)).toThrow();
  expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  expect(db.prepare('SELECT * FROM studio_routines').all()).toEqual(rows);
  expect(db.prepare('SELECT id FROM studio_routine_runs').all()).toEqual([{ id: 'history' }]);
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'studio_routines_next'").get()).toBeUndefined();
});
it('keeps a caller\'s disabled FK setting, and refuses a legacy rebuild inside an existing transaction', () => {
  legacy(false);
  expect(() => db.transaction(() => migrateStudioRoutines(db))()).toThrow('standalone transaction');
  db.pragma('foreign_keys = OFF'); migrateStudioRoutines(db);
  expect(db.pragma('foreign_keys', { simple: true })).toBe(0);
});
it('maps every Studio routine agent to exactly its own source, with no unknown/default fallback', () => {
  for (const [agent, source] of [['codex', 'personal_subscription'], ['openai', 'company_pool'], ['openai-byok', 'personal_api_key']] as const) {
    expect(studioRoutineExecutionSource(agent)).toBe(source);
    expect(studioRoutineAgentId(source)).toBe(agent);
  }
  for (const id of [null, '', 'claude', 'toString', 'constructor', {}]) expect(studioRoutineExecutionSource(id)).toBeNull();
});
