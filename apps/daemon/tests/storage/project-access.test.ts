import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ProjectAccessStore } from '../../src/storage/project-access.js';

let db: Database.Database;
let active: Set<string>;
const open = () => new ProjectAccessStore(db, { accountActive: (id: string) => active.has(id) });
beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY);
    CREATE TABLE conversations (id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id) ON DELETE CASCADE);
    INSERT INTO projects VALUES ('shared'), ('private'), ('legacy');
    INSERT INTO conversations VALUES ('owner-thread', 'shared'), ('editor-thread', 'shared');`);
  active = new Set(['owner', 'viewer', 'commenter', 'editor', 'admin']);
  const store = open();
  store.ownership.bindOwner('shared', 'owner', 1);
  store.ownership.bindOwner('private', 'owner', 1);
  store.setGrant('shared', 'viewer', 'view', 1);
  store.setGrant('shared', 'commenter', 'comment', 1);
  store.setGrant('shared', 'editor', 'edit', 1);
  store.bindConversationAuthor('editor-thread', 'editor');
});
afterEach(() => db.close());

it('suspends all shared access while the owner is inactive, preserving grants for reactivation', () => {
  const store = open();
  expect(store.canView('shared', 'viewer')).toBe(true);
  expect(store.canComment('shared', 'commenter')).toBe(true);
  expect(store.canWriteConversation('shared', 'editor-thread', 'editor')).toBe(true);
  expect(store.readableProjectIds('editor')).toEqual(['shared']);
  active.delete('owner');
  for (const id of active) {
    expect(store.roleOf('shared', id)).toBeNull();
    expect(store.canView('shared', id)).toBe(false);
    expect(store.canComment('shared', id)).toBe(false);
    expect(store.canWrite('shared', id)).toBe(false);
    expect(store.canWriteConversation('shared', 'editor-thread', id)).toBe(false);
    expect([...store.shareSummaries(id)]).toEqual([]);
    expect(store.readableProjectIds(id)).toEqual([]);
  }
  expect(store.listGrants('shared')).toHaveLength(3);
  // Reopening does not cache an active account or erase its suspended grants.
  expect(open().canView('shared', 'viewer')).toBe(false);
  active.add('owner');
  expect(store.roleOf('shared', 'viewer')).toBe('view');
  expect(store.roleOf('shared', 'commenter')).toBe('comment');
  expect(store.roleOf('shared', 'editor')).toBe('edit');
  expect(store.shareSummaries('editor').get('shared')?.role).toBe('edit');
  expect(store.readableProjectIds('editor')).toEqual(['shared']);
});

it('suspends a deactivated or deleted grantee without granting an admin access', () => {
  const store = open();
  active.delete('editor');
  expect(store.canWriteConversation('shared', 'editor-thread', 'editor')).toBe(false);
  expect(store.shareSummaries('editor').size).toBe(0);
  expect(store.readableProjectIds('editor')).toEqual([]);
  expect(store.canView('shared', 'viewer')).toBe(true);
  expect(store.roleOf('shared', 'admin')).toBeNull();
  expect(store.roleOf('private', 'viewer')).toBeNull();
  expect(store.roleOf('legacy', 'owner')).toBeNull();
  expect(store.roleOf('missing', 'owner')).toBeNull();
  active.add('editor');
  expect(store.canWriteConversation('shared', 'editor-thread', 'editor')).toBe(true);
  expect(store.canWriteConversation('shared', 'owner-thread', 'editor')).toBe(false);
});

it('preserves stored membership counts but refuses new grants with an inactive endpoint', () => {
  const store = open();
  expect(store.shareSummaries('viewer').get('shared')?.memberCount).toBe(4);
  active.delete('editor');
  expect(store.shareSummaries('viewer').get('shared')?.memberCount).toBe(4);
  expect(() => store.setGrant('shared', 'editor', 'view', 2)).toThrow();
  active.delete('owner');
  expect(() => store.setGrant('shared', 'viewer', 'edit', 2)).toThrow();
  active.add('owner'); active.add('editor');
  expect(store.listGrants('shared').find((grant) => grant.accountId === 'editor')?.role).toBe('edit');
  expect(store.listGrants('shared').find((grant) => grant.accountId === 'viewer')?.role).toBe('view');
});

it('removes grants on project deletion and never restores them for a reused project id', () => {
  const store = open();
  db.prepare('DELETE FROM projects WHERE id = ?').run('shared');
  expect(store.roleOf('shared', 'editor')).toBeNull();
  expect(store.listGrants('shared')).toEqual([]);
  db.prepare('INSERT INTO projects VALUES (?)').run('shared');
  store.ownership.bindOwner('shared', 'owner', 2);
  expect(store.roleOf('shared', 'editor')).toBeNull();
});
