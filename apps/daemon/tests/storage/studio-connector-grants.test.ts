// S60 A7: run-grant epochs and the tool audit are persisted by the storage
// layer, and the runtime reuses the daemon's existing auth store handle.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StudioConnectorRuntime } from '../../src/connectors/studio-runtime.js';
import { AuthStore } from '../../src/storage/auth-store.js';
import * as storage from '../../src/storage/studio-connectors.js';

let root: string; let db: Database.Database; let auth: AuthStore;
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 's60-grants-')); db = new Database(path.join(root, 'app.sqlite')); auth = AuthStore.open({ dataRoot: root }); });
afterEach(() => { vi.restoreAllMocks(); auth.close(); db.close(); rmSync(root, { recursive: true, force: true }); });

it('the storage layer owns the grant epoch and immutable tool audit schema', () => {
  const Grants = (storage as Record<string, unknown>).StudioConnectorGrantStore as (new (db: Database.Database) => {
    epoch(owner: string): number; invalidate(owner: string): void; toolCalls(runId: string): number;
    appendToolAudit(row: { owner: string; connectorId: string; toolSlug: string; runId: string; outcome: string }): void;
  }) | undefined;
  expect(Grants).toBeDefined();
  const grants = new Grants!(db);
  expect(grants.epoch('A')).toBe(0);
  grants.invalidate('A'); grants.invalidate('A');
  expect(grants.epoch('A')).toBe(2);
  grants.appendToolAudit({ owner: 'A', connectorId: 'github', toolSlug: 'GITHUB_X', runId: 'r1', outcome: 'ok' });
  expect(grants.toolCalls('r1')).toBe(1);
  expect(() => db.prepare('UPDATE studio_connector_tool_audit SET outcome = ?').run('x')).toThrow(/immutable/);
  expect(() => db.prepare('DELETE FROM studio_connector_tool_audit').run()).toThrow(/immutable/);
});

it('the runtime module holds no schema or SQL and opens no second auth store', () => {
  const source = readFileSync(fileURLToPath(new URL('../../src/connectors/studio-runtime.ts', import.meta.url)), 'utf8');
  expect(source).not.toMatch(/CREATE\s+(?:TABLE|TRIGGER|INDEX)|db\.(?:exec|prepare)\(|AuthStore\.open/);
  const open = vi.spyOn(AuthStore, 'open');
  const runtime = new StudioConnectorRuntime({ db, dataRoot: root, auth, sessionCurrent: () => true });
  expect(open).not.toHaveBeenCalled();
  runtime.invalidateAccount('A');
  runtime.close();
  // Closing the runtime leaves the shared handle usable.
  expect(auth.getAccountById('missing')).toBeNull();
});
