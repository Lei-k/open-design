import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, deleteConversation, getMessage, insertConversation, insertProject, listMessages, openDatabase, upsertMessage } from '../../src/db.js';
import { ProjectOwnershipStore } from '../../src/storage/project-ownership.js';
import { MultiUserStudioMessages, type StudioRunMessageInput } from '../../src/storage/multiuser-studio-messages.js';

let root: string;
let db: Database.Database;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'od-studio-migration-'));
  db = openDatabase(root, { dataDir: root });
  const owners = new ProjectOwnershipStore(db);
  for (const [pid, cid, owner] of [['p-a', 'c-a', 'a'], ['p-b', 'c-b', 'b'], ['p-legacy', 'c-legacy', null]] as const) {
    insertProject(db, { id: pid, name: 'Same title', createdAt: 1, updatedAt: 1 });
    insertConversation(db, { id: cid, projectId: pid, title: 'Same title', createdAt: 1, updatedAt: 1 });
    if (owner) owners.bindOwner(pid, owner, 1);
  }
  // Minimal legacy run fixture; production migration reads these columns.
  db.exec(`CREATE TABLE multiuser_runs (
    id TEXT PRIMARY KEY, owner_account_id TEXT, project_id TEXT, conversation_id TEXT,
    status TEXT, created_at INTEGER, updated_at INTEGER, started_at INTEGER, ended_at INTEGER,
    execution_source TEXT, request_json TEXT, output TEXT, queue_seq INTEGER
  )`);
});
afterEach(() => { closeDatabase(); rmSync(root, { recursive: true, force: true }); });

function run(id: string, patch: Partial<StudioRunMessageInput> = {}) {
  const input: StudioRunMessageInput = {
    id, owner_account_id: 'a', project_id: 'p-a', conversation_id: 'c-a',
    status: 'succeeded', created_at: 1, updated_at: 3, started_at: 2, ended_at: 3,
    execution_source: 'personal_subscription', request_json: JSON.stringify({ message: 'User prompt' }),
    output: JSON.stringify({ text: 'Assistant result' }), ...patch,
  };
  const keys = Object.keys(input);
  db.prepare(`INSERT INTO multiuser_runs (${keys.join(',')}, queue_seq) VALUES (${keys.map(() => '?').join(',')}, 1)`)
    .run(...Object.values(input));
  return input;
}

describe('additive Studio transcript migration (#54/#55)', () => {
  it('projects newly durable events into an already active assistant message', () => {
    run('active', { status: 'active', output: null });
    db.exec('CREATE TABLE multiuser_run_events (run_id TEXT, seq INTEGER, event TEXT, data TEXT, PRIMARY KEY(run_id, seq))');
    const store = new MultiUserStudioMessages(db);
    db.prepare('INSERT INTO multiuser_run_events VALUES (?, ?, ?, ?)').run('active', 1, 'agent', JSON.stringify({ type: 'text_delta', delta: 'In progress' }));
    store.reconcile(db.prepare('SELECT * FROM multiuser_runs WHERE id = ?').get('active') as StudioRunMessageInput);
    expect(getMessage(db, store.ids('active').assistantMessageId, 'c-a')).toMatchObject({
      runStatus: 'running', content: 'In progress', lastRunEventId: '1', events: [{ kind: 'text', text: 'In progress' }],
    });
  });
  it('rebuilds standard events and the durable cursor identically after reopening twice', () => {
    run('streamed', { output: null });
    db.exec('CREATE TABLE multiuser_run_events (run_id TEXT, seq INTEGER, event TEXT, data TEXT, PRIMARY KEY(run_id, seq))');
    const frames = [
      ['start', { bin: 'codex' }],
      ['agent', { type: 'text_delta', delta: 'Visible result' }],
      ['agent', { type: 'tool_result', toolUseId: 'cmd', content: '[omitted]', redacted: { policy: 'personal-subscription', fields: ['content'] } }],
      ['end', { code: 0, status: 'succeeded' }],
    ];
    frames.forEach(([event, data], index) => db.prepare('INSERT INTO multiuser_run_events VALUES (?, ?, ?, ?)').run('streamed', index + 1, event, JSON.stringify(data)));
    const store = new MultiUserStudioMessages(db);
    const before = listMessages(db, 'c-a');
    expect(getMessage(db, store.ids('streamed').assistantMessageId, 'c-a')).toMatchObject({ content: 'Visible result', lastRunEventId: '4' });
    for (let n = 0; n < 2; n++) {
      closeDatabase(); db = openDatabase(root, { dataDir: root }); new MultiUserStudioMessages(db);
      expect(listMessages(db, 'c-a')).toEqual(before);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    }
  });
  it('can rerun after reopen and preserves user edits and immutable bindings', () => {
    run('run-a');
    const initial = new MultiUserStudioMessages(db);
    const ids = initial.ids('run-a');
    expect(listMessages(db, 'c-a')).toHaveLength(2);
    upsertMessage(db, 'c-a', { ...getMessage(db, ids.userMessageId, 'c-a')!, content: 'User edited prompt' });
    expect(() => db.prepare('UPDATE multiuser_studio_turns SET user_message_id = ? WHERE run_id = ?')
      .run(ids.assistantMessageId, 'run-a')).toThrow(/immutable/);
    closeDatabase();
    db = openDatabase(root, { dataDir: root });
    new MultiUserStudioMessages(db);
    new MultiUserStudioMessages(db);
    expect(listMessages(db, 'c-a')).toHaveLength(2);
    expect(getMessage(db, ids.userMessageId, 'c-a')?.content).toBe('User edited prompt');
    expect(getMessage(db, ids.assistantMessageId, 'c-a')).toMatchObject({ content: 'Assistant result', runId: 'run-a', runStatus: 'succeeded' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM multiuser_runs').get()).toEqual({ n: 1 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('does not claim unowned legacy projects or mismatched parent and owner rows', () => {
    run('unowned', { project_id: 'p-legacy', conversation_id: 'c-legacy' });
    run('wrong-owner', { owner_account_id: 'b' });
    run('wrong-parent', { conversation_id: 'c-b' });
    new MultiUserStudioMessages(db);
    for (const cid of ['c-a', 'c-b', 'c-legacy']) expect(listMessages(db, cid)).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM multiuser_runs').get()).toEqual({ n: 3 });
  });

  it('rolls back the entire backfill when a restored message namespace conflicts', () => {
    const store = new MultiUserStudioMessages(db);
    run('valid-first');
    run('conflict-last', { created_at: 2 });
    const conflictId = store.ids('conflict-last').userMessageId;
    upsertMessage(db, 'c-b', { id: conflictId, role: 'user', content: 'Other actor' });
    expect(() => new MultiUserStudioMessages(db)).toThrow(/binding conflict/);
    expect(listMessages(db, 'c-a')).toEqual([]);
    expect(getMessage(db, conflictId, 'c-b')?.content).toBe('Other actor');
    expect(db.prepare('SELECT COUNT(*) AS n FROM multiuser_studio_turns').get()).toEqual({ n: 0 });
  });

  it('removes turn bindings with their conversation without changing another owner', () => {
    run('run-a');
    run('run-b', { project_id: 'p-b', conversation_id: 'c-b', owner_account_id: 'b' });
    new MultiUserStudioMessages(db);
    deleteConversation(db, 'c-a');
    expect(db.prepare('SELECT run_id FROM multiuser_studio_turns').all()).toEqual([{ run_id: 'run-b' }]);
    expect(listMessages(db, 'c-b')).toHaveLength(2);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});
