// Issue #18 — the personal-subscription switch defaults OFF. Without the
// test-only injected mock app-server the routes answer "not enabled", personal
// runs are refused without touching the company pool, and only the repository
// mock can ever be injected. Single-user mode registers none of these routes.
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  cleanupIsolatedDataRoot, loadIsolatedServerModule, multiUserOptions, provisionAccounts,
  startMultiUserDaemon, type Principal, type StartedMultiUserDaemon,
} from './multiuser-harness.js';
import { RUN_MOCK } from './personal-codex-helpers.js';

let daemon: StartedMultiUserDaemon;
let alice: Principal;
let project: { id: string; conversationId: string };

beforeAll(async () => {
  delete process.env.OD_API_TOKEN;
  delete process.env.OD_DISABLE_API_AUTH;
  await loadIsolatedServerModule();
  daemon = await startMultiUserDaemon(multiUserOptions({ testMockAgentScript: RUN_MOCK }));
  [alice] = (await provisionAccounts(daemon, ['off-alice'])).users as [Principal];
  const id = randomUUID();
  const res = await daemon.request({ method: 'POST', path: '/api/projects', cookie: alice.cookie, body: { id, name: id } });
  project = { id, conversationId: res.json.conversationId };
}, 120_000);

afterAll(async () => { await daemon?.close(); cleanupIsolatedDataRoot(); });

it('reports the feature as not enabled and refuses every personal action', async () => {
  const view = await daemon.request({ path: '/api/agent-accounts', cookie: alice.cookie });
  expect(view.status).toBe(200);
  expect(view.json).toMatchObject({ mode: 'multi-user', personalSubscriptionsEnabled: false,
    codex: { account: null, pendingAttempt: null } });
  const start = await daemon.request({ method: 'POST', path: '/api/agent-accounts/codex/logins', cookie: alice.cookie, body: {} });
  expect(start.status).toBe(403);
  expect(start.json.error.code).toBe('MULTIUSER_PERSONAL_DISABLED');
  const run = await daemon.request({ method: 'POST', path: '/api/runs', cookie: alice.cookie, body: {
    projectId: project.id, conversationId: project.conversationId, agentId: 'codex', executionSource: 'personal_subscription', message: 'x' } });
  expect(run.status).toBe(403);
  expect(run.json.error.code).toBe('MULTIUSER_PERSONAL_DISABLED');
  expect((await daemon.request({ path: '/api/runs', cookie: alice.cookie })).json.runs).toEqual([]);
  expect((await daemon.request({ path: '/api/agent-accounts' })).status).toBe(401);
  // The public version probe tells the Web client it is talking to a multi-user daemon.
  expect((await daemon.request({ path: '/api/version' })).json.version.capabilities.multiUser).toBe(true);
});

it('keeps company runs unchanged when executionSource is omitted or company_pool', async () => {
  for (const extra of [{}, { executionSource: 'company_pool' }]) {
    const res = await daemon.request({ method: 'POST', path: '/api/runs', cookie: alice.cookie, body: {
      projectId: project.id, conversationId: project.conversationId, agentId: 'test-mock', message: 'company', ...extra } });
    expect(res.status, res.text).toBe(202);
    expect(Object.keys(res.json.run).sort()).toEqual(
      ['agentId', 'conversationId', 'createdAt', 'id', 'output', 'projectId', 'queuePosition', 'status', 'updatedAt']);
  }
  const bogus = await daemon.request({ method: 'POST', path: '/api/runs', cookie: alice.cookie, body: {
    projectId: project.id, conversationId: project.conversationId, agentId: 'test-mock', message: 'x', executionSource: 'other' } });
  expect(bogus.status).toBe(400);
});

it('refuses to inject anything but the repository mock app-server', async () => {
  const { mod } = await loadIsolatedServerModule();
  for (const script of [RUN_MOCK, path.resolve('../..', 'mocks/bin/codex'), '/usr/bin/codex']) {
    await expect(mod.startServer({ port: 0, host: '127.0.0.1', returnServer: true,
      multiUser: multiUserOptions({ testMockAgentScript: RUN_MOCK, testPersonalCodexAppServer: script }) }))
      .rejects.toThrow(/refused/);
  }
});

it('registers no personal-account route in single-user mode', async () => {
  const { mod } = await loadIsolatedServerModule();
  const started = (await mod.startServer({ port: 0, host: '127.0.0.1', returnServer: true })) as import('../../src/server.js').StartServerResult;
  try {
    expect(started.routeInventory.filter((route) => route.path.includes('agent-accounts'))).toEqual([]);
    const version = await (await fetch(`${started.url}/api/version`)).json() as { version: { capabilities: Record<string, unknown> } };
    expect(Object.keys(version.version.capabilities)).toEqual(['slideRenderer']);
  } finally {
    await Promise.resolve(started.shutdown());
    await new Promise<void>((resolve) => started.server.close(() => resolve()));
  }
});
