import { StudioConnectorRuntime } from '../../src/connectors/studio-runtime.js';
import { CompanyComposioStore, StudioConnectorStore } from '../../src/storage/studio-connectors.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Express, Request, Response } from 'express';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { closeDatabase, openDatabase } from '../../src/db.js';
import { AuthStore } from '../../src/storage/auth-store.js';
import { internalMultiUserResponse } from '../../src/http/multiuser-internal.js';
import { registerStudioRoutineRoutes } from '../../src/routes/studio-routines.js';
import { StudioAutomationTemplates } from '../../src/storage/studio-automation-templates.js';

// Registrar + real scheduler/SQLite, without a listener. Admission is injected:
// real cookie/provider authority remains covered by studio-routines-http.
let root: string;
let db: ReturnType<typeof openDatabase>;
let auth: AuthStore;
let service: ReturnType<typeof registerStudioRoutineRoutes>;
const routes = new Map<string, (req: Request, res: Response) => Promise<void>>();
const requests: Array<{ owner: string; source: unknown }> = [];
let configured: boolean;
let connectors: StudioConnectorRuntime;
let connectorSelections: unknown[];
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-09T12:59:59Z'));
  root = mkdtempSync(path.join(tmpdir(), 'studio-routine-dispatch-'));
  db = openDatabase(root, { dataDir: root });
  auth = AuthStore.open({ dataRoot: root });
  for (const id of ['A', 'B']) {
    auth.insertAccount({ id, username: id.toLowerCase(), passwordHash: 'fixture', passwordState: 'set', role: 'user', active: true, createdAt: 1, updatedAt: 1 });
    auth.setStudioPilot(id, { studioPilot: true, revision: 1 });
  }
  routes.clear(); requests.length = 0; configured = true;
  const app = Object.fromEntries(['get', 'post', 'patch', 'delete'].map((method) => [method,
    (url: string, handler: (req: Request, res: Response) => Promise<void>) => routes.set(`${method.toUpperCase()} ${url}`, handler),
  ])) as unknown as Express;
  connectors = new StudioConnectorRuntime({ db, dataRoot: root, sessionCurrent: () => true });
  connectorSelections = [];
  service = registerStudioRoutineRoutes(app, { db, dataRoot: root, projectsRoot: path.join(root, 'projects'), connectors, runs: {
    async admitInternal(actor, request, allowed) {
      expect(allowed()).toBe(true);
      connectorSelections.push(request.context);
      requests.push({ owner: actor.accountId, source: request.executionSource });
      return configured ? { status: 202, body: { runId: 'admitted' } }
        : { status: 409, body: { error: { code: 'MULTIUSER_PROVIDER_KEY_MISSING' } } };
    },
    runState: () => ({ status: 'succeeded', text: 'Routine done', reason: null }),
  } });
});
afterEach(() => { service?.stop(); connectors?.close(); auth?.close(); closeDatabase(); rmSync(root, { recursive: true, force: true }); vi.useRealTimers(); });

async function api(method: string, suffix = '', body: unknown = {}, owner = 'A', id = '') {
  const actor = { accountId: owner, username: owner.toLowerCase(), role: 'user' as const, sessionId: `fixture-${owner}`, sessionExpiresAt: Date.now() + 60_000 };
  const response = internalMultiUserResponse(actor, () => auth.getAccountById(owner)?.active === true);
  await routes.get(`${method} /api/multiuser/routines${suffix}`)!({ body, params: { id }, query: {} } as unknown as Request, response.res);
  return response.result() as { status: number; body: any };
}
async function create(agentId: string) {
  const response = await api('POST', '', { name: 'Routine', prompt: 'Use my source', agentId,
    schedule: { kind: 'hourly', minute: 0, timezone: 'UTC' }, enabled: true });
  expect(response.status).toBe(201);
  expect(response.body.routine.agentId).toBe(agentId);
  return response.body.routine.id as string;
}
it.each([['codex', 'personal_subscription'], ['openai', 'company_pool'], ['openai-byok', 'personal_api_key']])(
  'dispatches %s manual and timer runs on exactly %s', async (agent, source) => {
    const id = await create(agent);
    expect((await api('POST', '/:id/run', {}, 'A', id)).status).toBe(202);
    await vi.advanceTimersByTimeAsync(1100);
    expect(requests.length).toBeGreaterThanOrEqual(1);
    expect(requests.every((request) => request.owner === 'A' && request.source === source)).toBe(true);
    // An already-running manual turn may claim the first tick without another
    // worker. The next hourly slot must dispatch once on the captured source.
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(requests.length).toBeGreaterThanOrEqual(2);
    expect(requests.every((request) => request.source === source)).toBe(true);
    expect((await api('GET', '/:id/runs', {}, 'B', id)).status).toBe(404);
  });
it('records missing-own-key refusal without retrying another source, and preserves source on unrelated edits', async () => {
  const id = await create('openai-byok');
  configured = false;
  expect((await api('POST', '/:id/run', {}, 'A', id)).status).toBe(202);
  await vi.advanceTimersByTimeAsync(1);
  expect(requests).toEqual([{ owner: 'A', source: 'personal_api_key' }]);
  const history = await api('GET', '/:id/runs', {}, 'A', id);
  expect(history.body.runs[0]).toMatchObject({ status: 'failed', errorCode: 'MULTIUSER_PROVIDER_KEY_MISSING' });
  expect((await api('PATCH', '/:id', { name: 'Renamed' }, 'A', id)).body.routine.agentId).toBe('openai-byok');
  expect((await api('PATCH', '/:id', { agentId: 'host-fallback' }, 'A', id)).status).toBe(403);
  expect((await api('PATCH', '/:id', { agentId: 'openai' }, 'B', id)).status).toBe(404);
  expect((await api('PATCH', '/:id', { agentId: 'openai' }, 'A', id)).body.routine.agentId).toBe('openai');
});
it('does not dispatch a scheduled routine while its owner is inactive', async () => {
  await create('openai-byok');
  auth.updateAccountFlags('A', { role: 'user', active: false }, Date.now());
  await vi.advanceTimersByTimeAsync(1100);
  expect(requests).toEqual([]);
});
it('uses only the owner\'s private template and refuses a later dispatch after its deletion', async () => {
  const templates = new StudioAutomationTemplates(db);
  const templateId = templates.apply('A', 'create', undefined, undefined, JSON.stringify({ title: 'Private brief', description: 'Private', purpose: 'Private purpose',
    triggerKinds: ['manual', 'schedule'], sourceKinds: ['chat'], stages: [{ id: 'propose', kind: 'propose', title: 'Draft a proposal' }],
    outputSinks: ['memory'], reviewPolicy: 'always', tokenCompression: 'balanced' }));
  const fields = { templateId, agentId: 'openai-byok', schedule: { kind: 'hourly', minute: 0, timezone: 'UTC' } };
  expect((await api('POST', '', fields, 'B')).status).toBe(404);
  const made = await api('POST', '', fields);
  expect(made.status).toBe(201);
  expect(made.body.routine).toMatchObject({ name: 'Private brief', templateId, agentId: 'openai-byok' });
  expect(made.body.routine.prompt).toContain('Private purpose');
  const id = made.body.routine.id;
  expect((await api('POST', '/:id/run', {}, 'A', id)).status).toBe(202);
  await vi.advanceTimersByTimeAsync(1100);
  expect(requests.length).toBeGreaterThanOrEqual(1);
  expect(requests.every((request) => request.owner === 'A' && request.source === 'personal_api_key')).toBe(true);
  const admittedCount = requests.length;
  templates.apply('A', 'delete', templateId, JSON.stringify(templates.read('A', templateId)), undefined);
  await vi.advanceTimersByTimeAsync(3_600_000);
  expect(requests).toHaveLength(admittedCount);
  const history = await api('GET', '/:id/runs', {}, 'A', id);
  expect(history.body.runs[0]).toMatchObject({ status: 'failed', errorCode: 'MULTIUSER_CAPABILITY_UNAVAILABLE' });
});

it('S59 routine connector context persists, dispatches as owner and fails typed after disconnect', async () => {
  const company = new CompanyComposioStore(db, root);
  company.update('A', { revision: 0, apiKey: 's59_fixture_composio_key' });
  const store = new StudioConnectorStore(db);
  store.saveConnection('A', 'github', { providerConnectionId: 'ca_A', accountLabel: 'A', credentialRevision: company.read().credentialRevision });
  const fields = { name: 'Connected routine', prompt: 'Read the selected app', agentId: 'openai',
    context: { connectorIds: ['github'] }, schedule: { kind: 'hourly', minute: 0, timezone: 'UTC' } };
  expect((await api('POST', '', fields, 'B')).body.error.code).toBe('CONNECTOR_NOT_GRANTED');
  const made = await api('POST', '', fields);
  expect(made.status).toBe(201);
  expect(made.body.routine.context.connectorIds).toEqual(['github']);
  const id = made.body.routine.id;
  expect((await api('POST', '/:id/run', {}, 'A', id)).status).toBe(202);
  await vi.advanceTimersByTimeAsync(1100);
  expect(connectorSelections).toContainEqual({ connectorIds: ['github'] });
  store.markDisconnected('A', 'github');
  await api('POST', '/:id/run', {}, 'A', id);
  await vi.advanceTimersByTimeAsync(1100);
  expect((await api('GET', '/:id/runs', {}, 'A', id)).body.runs[0]).toMatchObject({ status: 'failed', errorCode: 'CONNECTOR_NOT_GRANTED' });
});
