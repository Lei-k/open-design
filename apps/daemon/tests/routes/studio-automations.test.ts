import Database from 'better-sqlite3';
import type { Express, Request, Response } from 'express';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { internalMultiUserResponse } from '../../src/http/multiuser-internal.js';
import { registerStudioAutomationRoutes } from '../../src/routes/studio-automations.js';
import { StudioSettings } from '../../src/storage/studio-settings.js';

// Exercise the real registrar, proposal serialization and SQLite without a socket.
let db: Database.Database;
const routes = new Map<string, (req: Request, res: Response) => Promise<void>>();
const draft = { title: 'Private brief', description: 'Summarize a brief', purpose: 'Preserve context', triggerKinds: ['manual'], sourceKinds: ['chat'],
  stages: [{ id: 'propose', kind: 'propose', title: 'Review brief' }], outputSinks: ['memory'], reviewPolicy: 'always', tokenCompression: 'balanced' };
beforeEach(() => {
  db = new Database(':memory:');
  db.exec('CREATE TABLE projects (id TEXT PRIMARY KEY);');
  routes.clear();
  const app = Object.fromEntries(['get', 'post'].map((method) => [method,
    (url: string, handler: (req: Request, res: Response) => Promise<void>) => routes.set(`${method.toUpperCase()} ${url}`, handler),
  ])) as unknown as Express;
  registerStudioAutomationRoutes(app, { db, settings: new StudioSettings(db, 'unused-for-template-proposals') });
});
afterEach(() => db.close());
async function api(method: string, resource: string, body: unknown = {}, owner = 'A', id = '') {
  const actor = { accountId: owner, username: owner, role: owner === 'admin' ? 'admin' as const : 'user' as const,
    sessionId: `fixture-${owner}`, sessionExpiresAt: Date.now() + 60_000 };
  const response = internalMultiUserResponse(actor, () => true);
  await routes.get(`${method} /api/multiuser/${resource}`)!({ body, params: { id }, query: {} } as unknown as Request, response.res);
  return response.result() as { status: number; body: any };
}
const propose = (action = 'create', targetRef?: string, before?: string, after?: string) => api('POST', 'automation-proposals', {
  title: 'Template change', summary: 'Review the private template', targetKind: 'automation-template', action,
  ...(targetRef ? { targetRef } : {}), patch: { format: 'json', ...(before ? { before } : {}), ...(action !== 'delete' ? { after: after ?? JSON.stringify(draft) } : {}) },
});
const apply = (id: string, owner = 'A') => api('POST', 'automation-proposals/:id/apply', {}, owner, id);

it('keeps proposed and applied templates private and applies once, with no built-in override', async () => {
  const made = await propose(); expect(made.status).toBe(200);
  const id = made.body.proposal.id;
  expect((await api('GET', 'automation-templates')).body.templates.some((item: { studioOwned?: boolean }) => item.studioOwned)).toBe(false);
  for (const owner of ['B', 'admin']) expect((await apply(id, owner)).status).toBe(404);
  const applied = await apply(id); expect(applied.status).toBe(200);
  const templateId = applied.body.result.automationTemplateId;
  expect((await api('GET', 'automation-templates/:id', {}, 'A', templateId)).body.template).toMatchObject({ ...draft, studioOwned: true });
  for (const owner of ['B', 'admin']) expect((await api('GET', 'automation-templates/:id', {}, owner, templateId)).status).toBe(404);
  expect((await apply(id)).status).toBe(409);
  expect((await propose('update', 'ingest-source-memory-tree', '{}')).status).toBe(404);
});
it('refuses a stale reviewed update without marking it applied, and deletes only with a current snapshot', async () => {
  const made = await apply((await propose()).body.proposal.id);
  const id = made.body.result.automationTemplateId;
  const { studioOwned: _owned, ...template } = (await api('GET', 'automation-templates/:id', {}, 'A', id)).body.template;
  const before = JSON.stringify(template);
  const first = await propose('update', id, before, JSON.stringify({ ...template, title: 'First change' }));
  const stale = await propose('update', id, before, JSON.stringify({ ...template, title: 'Stale change' }));
  expect((await apply(first.body.proposal.id)).status).toBe(200);
  expect((await apply(stale.body.proposal.id)).status).toBe(409);
  expect((await api('GET', 'automation-proposals/:id', {}, 'A', stale.body.proposal.id)).body.proposal.status).toBe('pending-review');
  const { studioOwned: _flag, ...current } = (await api('GET', 'automation-templates/:id', {}, 'A', id)).body.template;
  const deletion = await propose('delete', id, JSON.stringify(current));
  expect((await apply(deletion.body.proposal.id)).status).toBe(200);
  expect((await api('GET', 'automation-templates/:id', {}, 'A', id)).status).toBe(404);
});
it('rejects invalid template patches at proposal creation rather than deferring them until apply', async () => {
  expect((await propose('create', undefined, undefined, '{}')).status).toBe(400);
  expect((await propose('create', undefined, undefined, JSON.stringify({ ...draft, context: { mcpServerIds: ['host'] } }))).status).toBe(400);
  expect((await api('GET', 'automation-proposals')).body.proposals).toEqual([]);
});
