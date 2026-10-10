import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { StudioAutomationTemplates } from '../../src/storage/studio-automation-templates.js';

let db: Database.Database;
let store: StudioAutomationTemplates;
const draft = { title: 'Private brief', description: 'Summarize the brief', purpose: 'Preserve useful context', triggerKinds: ['manual', 'schedule'],
  sourceKinds: ['chat'], stages: [{ id: 'propose', kind: 'propose', title: 'Propose changes' }], outputSinks: ['memory'], reviewPolicy: 'always', tokenCompression: 'balanced' };
beforeEach(() => { db = new Database(':memory:'); store = new StudioAutomationTemplates(db); });
afterEach(() => db.close());
const create = () => store.apply('A', 'create', undefined, undefined, JSON.stringify(draft));

it('creates server-assigned private templates, survives reopening and never shares with another account or admin', () => {
  const id = create(); expect(id).toMatch(/^studio-template-/);
  expect(store.read('A', id)).toMatchObject({ ...draft, id });
  for (const actor of ['B', 'admin']) { expect(store.list(actor)).toEqual([]); expect(store.read(actor, id)).toBeNull(); }
  expect(new StudioAutomationTemplates(db).read('A', id)).toEqual(store.read('A', id));
});
it('updates and deletes only the named account resource using the reviewed snapshot', () => {
  const id = create(); const before = JSON.stringify(store.read('A', id));
  const after = JSON.stringify({ ...store.read('A', id), title: 'Revised brief' });
  expect(() => store.apply('B', 'update', id, before, after)).toThrow('resource not found');
  store.apply('A', 'update', id, before, after);
  expect(store.read('A', id)?.title).toBe('Revised brief');
  expect(() => store.apply('A', 'delete', id, before, undefined)).toThrow('changed');
  store.apply('A', 'delete', id, JSON.stringify(store.read('A', id)), undefined);
  expect(store.read('A', id)).toBeNull();
  expect(() => store.apply('A', 'update', 'ingest-source-memory-tree', before, after)).toThrow();
});
it('rejects stale proposals and can roll back the mutation with the proposal verdict', () => {
  const id = create(); const before = JSON.stringify(store.read('A', id));
  expect(() => db.transaction(() => {
    store.apply('A', 'update', id, before, JSON.stringify({ ...store.read('A', id), title: 'Rollback' }));
    throw new Error('verdict conflict');
  })()).toThrow('verdict conflict');
  expect(JSON.stringify(store.read('A', id))).toBe(before);
  store.apply('A', 'update', id, before, JSON.stringify({ ...store.read('A', id), title: 'New' }));
  expect(() => store.apply('A', 'update', id, before, JSON.stringify(draft))).toThrow('changed');
  expect(store.read('A', id)?.title).toBe('New');
});
it.each([
  { id: 'host-id' }, { owner: 'B' }, { context: { mcpServerIds: ['host'] } }, { title: '' }, { triggerKinds: ['unknown'] },
  { stages: [{ id: 'propose', kind: 'propose', title: 'x', config: { command: 'host' } }] },
  { stages: [draft.stages[0], draft.stages[0]] }, { stages: Array.from({ length: 33 }, (_, i) => ({ ...draft.stages[0], id: `stage-${i}` })) },
])('refuses unsupported or malformed template fields without silently dropping them: %j', (patch) => {
  expect(() => store.apply('A', 'create', undefined, undefined, JSON.stringify({ ...draft, ...patch }))).toThrow('invalid');
  expect(store.list('A')).toEqual([]);
});
it('enforces the per-account cap without limiting other accounts', () => {
  for (let i = 0; i < 100; i++) create();
  expect(() => create()).toThrow('limit');
  expect(store.apply('B', 'create', undefined, undefined, JSON.stringify(draft))).toBeTruthy();
});
