import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, expect, it } from 'vitest';
import { cleanupIsolatedDataRoot, loadIsolatedServerModule, multiUserOptions, startMultiUserDaemon, type StartedMultiUserDaemon } from './multiuser-harness.js';

let daemon: StartedMultiUserDaemon | undefined;
afterAll(async () => { await daemon?.close(); cleanupIsolatedDataRoot(); });

// A deployment from before #62/#63 has the two-source CHECK. Startup widens it
// once, keeping every row and the binding triggers.
it('widens the execution source constraint of an existing run table in place', async () => {
  const { dataRoot } = await loadIsolatedServerModule();
  mkdirSync(dataRoot, { recursive: true });
  const db = new Database(path.join(dataRoot, 'app.sqlite'));
  db.pragma('foreign_keys = OFF');
  db.exec(`CREATE TABLE multiuser_runs (
    id TEXT PRIMARY KEY, owner_account_id TEXT NOT NULL CHECK (length(owner_account_id) > 0),
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('queued','active','succeeded','failed','canceled')),
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, output TEXT, request_json TEXT, queue_seq INTEGER,
    execution_source TEXT NOT NULL DEFAULT 'company_pool' CHECK (execution_source IN ('company_pool','personal_subscription')),
    personal_account_id TEXT, credential_version INTEGER, started_at INTEGER, ended_at INTEGER);
    INSERT INTO multiuser_runs (id, owner_account_id, project_id, conversation_id, status, created_at, updated_at, execution_source)
      VALUES ('legacy-run', 'acct', 'p', 'c', 'succeeded', 1, 2, 'personal_subscription');`);
  db.close();
  daemon = await startMultiUserDaemon(multiUserOptions());
  const after = new Database(path.join(dataRoot, 'app.sqlite'));
  try {
    const sql = (after.prepare("SELECT sql FROM sqlite_master WHERE name = 'multiuser_runs'").get() as { sql: string }).sql;
    expect(sql).toContain("'personal_api_key'");
    expect(after.prepare('SELECT id, execution_source, updated_at FROM multiuser_runs').all())
      .toEqual([{ id: 'legacy-run', execution_source: 'personal_subscription', updated_at: 2 }]);
    expect(() => after.prepare("UPDATE multiuser_runs SET owner_account_id = 'other' WHERE id = 'legacy-run'").run()).toThrow(/immutable/);
    expect(() => after.prepare("UPDATE multiuser_runs SET execution_source = 'company_pool' WHERE id = 'legacy-run'").run()).toThrow(/immutable/);
  } finally { after.close(); }
});
