// Issue #3 — persistent actor -> project owner binding.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectOwnershipStore } from '../../src/storage/project-ownership.js';

let dir: string;
let db: Database.Database;

function insertProjectRow(id: string): void {
  db.prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(id, id, 1, 1);
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'od-owner-store-'));
  db = new Database(path.join(dir, 'app.sqlite'));
  db.pragma('foreign_keys = ON');
  // Minimal shape of the daemon's projects table; the store only relies on
  // `projects(id)` existing in the same database.
  db.exec('CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)');
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('ProjectOwnershipStore', () => {
  it('binds an owner and answers ownership only for that account', () => {
    const store = new ProjectOwnershipStore(db);
    insertProjectRow('p1');
    store.bindOwner('p1', 'acct-a', 10);
    expect(store.ownerOf('p1')).toBe('acct-a');
    expect(store.isOwnedBy('p1', 'acct-a')).toBe(true);
    expect(store.isOwnedBy('p1', 'acct-b')).toBe(false);
    expect([...store.listOwnedProjectIds('acct-a')]).toEqual(['p1']);
    expect([...store.listOwnedProjectIds('acct-b')]).toEqual([]);
  });

  it('is immutable: no re-bind and no update', () => {
    const store = new ProjectOwnershipStore(db);
    insertProjectRow('p1');
    store.bindOwner('p1', 'acct-a', 10);
    expect(() => store.bindOwner('p1', 'acct-b', 11)).toThrow();
    expect(() => db.prepare('UPDATE multiuser_project_owners SET owner_account_id = ? WHERE project_id = ?').run('acct-b', 'p1'))
      .toThrow(/immutable/);
    expect(store.ownerOf('p1')).toBe('acct-a');
  });

  it('refuses empty owners and bindings for projects that do not exist', () => {
    const store = new ProjectOwnershipStore(db);
    insertProjectRow('p1');
    expect(() => store.bindOwner('p1', '', 10)).toThrow();
    expect(() => store.bindOwner('missing', 'acct-a', 10)).toThrow();
  });

  it('removes the binding together with the project row', () => {
    const store = new ProjectOwnershipStore(db);
    insertProjectRow('p1');
    store.bindOwner('p1', 'acct-a', 10);
    db.prepare('DELETE FROM projects WHERE id = ?').run('p1');
    expect(store.ownerOf('p1')).toBeNull();
    // A later project reusing the id starts unowned (no inherited authority).
    insertProjectRow('p1');
    expect(store.isOwnedBy('p1', 'acct-a')).toBe(false);
  });

  it('treats unbound rows as owned by nobody', () => {
    const store = new ProjectOwnershipStore(db);
    insertProjectRow('legacy');
    expect(store.ownerOf('legacy')).toBeNull();
    expect(store.isOwnedBy('legacy', 'acct-a')).toBe(false);
    expect(store.listOwnedProjectIds('acct-a').size).toBe(0);
  });

  it('commits or rolls back atomically with the project insert', () => {
    const store = new ProjectOwnershipStore(db);
    expect(() => db.transaction(() => {
      insertProjectRow('p-rollback');
      store.bindOwner('p-rollback', 'acct-a', 10);
      throw new Error('later step failed');
    })()).toThrow('later step failed');
    expect(db.prepare('SELECT 1 FROM projects WHERE id = ?').get('p-rollback')).toBeUndefined();
    expect(store.ownerOf('p-rollback')).toBeNull();
  });

  it('is idempotent to open twice on the same database', () => {
    new ProjectOwnershipStore(db);
    const again = new ProjectOwnershipStore(db);
    insertProjectRow('p1');
    again.bindOwner('p1', 'acct-a', 10);
    expect(again.ownerOf('p1')).toBe('acct-a');
  });
});
