import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { cleanupIsolatedDataRoot, loadIsolatedServerModule, multiUserOptions, provisionAccounts, startMultiUserDaemon, type Principal, type StartedMultiUserDaemon } from './multiuser-harness.js';

let daemon: StartedMultiUserDaemon;
let admin: Principal;
let alice: Principal;
let bob: Principal;
let projectA: { id: string; conversationId: string };
let projectB: { id: string; conversationId: string };
let poolTime = Date.now();
let dataRoot: string;

async function project(user: Principal) {
  const id = crypto.randomUUID();
  const response = await daemon.request({ method: 'POST', path: '/api/projects', cookie: user.cookie, body: { id, name: `secret-${id}` } });
  expect(response.status).toBe(200);
  return { id, conversationId: response.json.conversationId as string };
}
async function run(user: Principal, p: { id: string; conversationId: string }, message: string, delayMs = 0) {
  return daemon.request({ method: 'POST', path: '/api/runs', cookie: user.cookie,
    body: { projectId: p.id, conversationId: p.conversationId, agentId: 'test-mock', message, delayMs } });
}
async function capacity(slots: number) {
  return daemon.request({ method: 'PUT', path: '/api/admin/pool/providers/test-mock', cookie: admin.cookie, body: { capacity: slots } });
}

beforeAll(async () => {
  delete process.env.OD_API_TOKEN;
  delete process.env.OD_DISABLE_API_AUTH;
  ({ dataRoot } = await loadIsolatedServerModule());
  daemon = await startMultiUserDaemon(multiUserOptions({ testMockAgentScript: path.resolve('../..', 'mocks/run-isolation-agent.ts'), poolClock: () => poolTime }));
  const accounts = await provisionAccounts(daemon, ['pool-alice', 'pool-bob']);
  admin = accounts.admin;
  [alice, bob] = accounts.users as [Principal, Principal];
  projectA = await project(alice);
  projectB = await project(bob);
}, 120_000);
afterAll(async () => { await daemon?.close(); cleanupIsolatedDataRoot(); });

it('keeps a durable queue, bounds it, and dispatches round-robin on a free slot', async () => {
  expect((await capacity(0)).status).toBe(200);
  const a1 = await run(alice, projectA, 'private-a1', 2000);
  const a2 = await run(alice, projectA, 'private-a2', 2000);
  const a3 = await run(alice, projectA, 'private-a3');
  expect([a1.status, a2.status, a3.status]).toEqual([202, 202, 202]);
  expect(a1.json.run.status).toBe('queued');
  expect(a2.json.run.queuePosition).toBe(2);
  expect(a3.json.run.queuePosition).toBe(3);
  const full = await run(alice, projectA, 'private-a4');
  expect(full.status).toBe(409);
  expect(full.json.error.code).toBe('MULTIUSER_QUEUE_LIMIT');
  const b1 = await run(bob, projectB, 'private-b1', 2000);
  expect(b1.json.run.status).toBe('queued');
  expect((await capacity(1)).status).toBe(200);
  const a4 = await run(alice, projectA, 'private-a4');
  expect(a4.json.run.status).toBe('queued');
  const stillFull = await run(alice, projectA, 'private-a5');
  expect(stillFull.status).toBe(409);
  expect(stillFull.json.error.code).toBe('MULTIUSER_QUEUE_LIMIT');
  const first = await daemon.request({ path: `/api/runs/${a1.json.run.id}/events`, cookie: alice.cookie });
  expect(first.text).toContain('event: queued');
  expect(first.text).toContain('event: start');
  expect((await daemon.request({ path: `/api/runs/${b1.json.run.id}`, cookie: bob.cookie })).json.status).toBe('running');
  expect((await daemon.request({ path: `/api/runs/${a2.json.run.id}`, cookie: alice.cookie })).json.status).toBe('queued');
  const second = await daemon.request({ path: `/api/runs/${b1.json.run.id}/events`, cookie: bob.cookie });
  expect(second.text).toContain('event: start');
  const cancel = await daemon.request({ method: 'POST', path: `/api/runs/${a3.json.run.id}/cancel`, cookie: alice.cookie });
  expect(cancel.json.status).toBe('canceled');
  expect((await daemon.request({ method: 'POST', path: `/api/runs/${a4.json.run.id}/cancel`, cookie: alice.cookie })).json.status).toBe('canceled');
  const ledgerDb = new Database(path.join(dataRoot, 'worker-quota', 'worker-quota.sqlite'));
  try { expect(ledgerDb.prepare('SELECT run_id FROM quota_runs WHERE run_id = ?').get(a3.json.run.id)).toBeUndefined(); }
  finally { ledgerDb.close(); }
  expect((await daemon.request({ path: `/api/runs/${a2.json.run.id}/events`, cookie: alice.cookie })).text).toContain('event: start');
});

it('charges elapsed worker time once, permits overshoot, and blocks later requests', async () => {
  expect((await capacity(0)).status).toBe(200);
  const quota = await daemon.request({ method: 'PUT', path: `/api/admin/pool/users/${alice.id}/quota`, cookie: admin.cookie,
    body: { budgetMinutes: 1 } });
  expect(quota.status).toBe(200);
  const auditDb = new Database(path.join(dataRoot, 'worker-quota', 'worker-quota.sqlite'));
  try {
    expect(auditDb.prepare('SELECT admin_actor_id, actor_id, budget_ms FROM quota_audit ORDER BY id DESC LIMIT 1').get())
      .toEqual({ admin_actor_id: admin.id, actor_id: alice.id, budget_ms: 60_000 });
    expect(() => auditDb.prepare('DELETE FROM quota_audit').run()).toThrow(/append only/);
  } finally { auditDb.close(); }
  const started = await run(alice, projectA, 'quota-overshoot', 500);
  expect(started.json.run.status).toBe('queued');
  expect((await capacity(1)).status).toBe(200);
  poolTime += 2 * 60_000;
  const during = await daemon.request({ path: `/api/runs/${started.json.run.id}`, cookie: alice.cookie });
  expect(during.json.status).toBe('running');
  expect((await daemon.request({ path: `/api/runs/${started.json.run.id}/events`, cookie: alice.cookie })).text).toContain('event: end');
  const summary = await daemon.request({ path: '/api/admin/pool', cookie: admin.cookie });
  expect(summary.json.users[alice.id].usedMs).toBe(120_000);
  const rejected = await run(alice, projectA, 'after-budget');
  expect(rejected.status).toBe(429);
  expect(rejected.json.error.code).toBe('MULTIUSER_QUOTA_EXHAUSTED');
  const again = await daemon.request({ method: 'POST', path: `/api/runs/${started.json.run.id}/cancel`, cookie: alice.cookie });
  expect(again.status).toBe(200);
  expect((await daemon.request({ path: '/api/admin/pool', cookie: admin.cookie })).json.users[alice.id].usedMs).toBe(120_000);
});

it('rechecks queued quota at dispatch and resumes after an admin override', async () => {
  expect((await capacity(0)).status).toBe(200);
  const pending = await run(bob, projectB, 'quota-recheck');
  expect(pending.json.run.status).toBe('queued');
  expect((await daemon.request({ method: 'PUT', path: `/api/admin/pool/users/${bob.id}/quota`, cookie: admin.cookie,
    body: { budgetMinutes: 0 } })).status).toBe(200);
  expect((await capacity(1)).status).toBe(200);
  expect((await daemon.request({ path: `/api/runs/${pending.json.run.id}`, cookie: bob.cookie })).json.status).toBe('queued');
  expect((await daemon.request({ method: 'PUT', path: `/api/admin/pool/users/${bob.id}/quota`, cookie: admin.cookie,
    body: { budgetMinutes: 1_800 } })).status).toBe(200);
  expect((await daemon.request({ path: '/api/admin/pool', cookie: admin.cookie })).json.users[bob.id].budgetMs)
    .toBe(1_800 * 60_000);
  expect((await daemon.request({ path: `/api/runs/${pending.json.run.id}/events`, cookie: bob.cookie })).text).toContain('event: start');
});

it('cancels active rows on clean restart, retains queued rows, and revokes both states', async () => {
  const reset = await daemon.request({ method: 'PUT', path: `/api/admin/pool/users/${alice.id}/quota`, cookie: admin.cookie,
    body: { budgetMinutes: 1_800 } });
  expect(reset.status).toBe(200);
  expect((await capacity(0)).status).toBe(200);
  const active = await run(alice, projectA, 'restart-active', 2000);
  const queued = await run(alice, projectA, 'restart-queued', 2000);
  expect((await capacity(1)).status).toBe(200);
  expect((await daemon.request({ path: `/api/runs/${active.json.run.id}`, cookie: alice.cookie })).json.status).toBe('running');
  expect((await capacity(0)).status).toBe(200);
  await daemon.close();
  daemon = await startMultiUserDaemon(multiUserOptions({ testMockAgentScript: path.resolve('../..', 'mocks/run-isolation-agent.ts'), poolClock: () => poolTime }));
  expect((await daemon.request({ path: `/api/runs/${active.json.run.id}`, cookie: alice.cookie })).json.status).toBe('canceled');
  expect((await daemon.request({ path: `/api/runs/${queued.json.run.id}`, cookie: alice.cookie })).json.status).toBe('queued');
  expect((await capacity(1)).status).toBe(200);
  expect((await daemon.request({ path: `/api/runs/${queued.json.run.id}`, cookie: alice.cookie })).json.status).toBe('running');
  const next = await run(alice, projectA, 'revoke-queued', 2000);
  const revoked = await daemon.request({ method: 'POST', path: `/api/auth/users/${alice.id}/sessions/revoke`, cookie: admin.cookie, body: {} });
  expect(revoked.status).toBe(200);
  const { login } = await import('./multiuser-harness.js');
  alice.cookie = await login(daemon, alice.username, alice.password);
  expect((await daemon.request({ path: `/api/runs/${queued.json.run.id}`, cookie: alice.cookie })).json.status).toBe('canceled');
  expect((await daemon.request({ path: `/api/runs/${next.json.run.id}`, cookie: alice.cookie })).json.status).toBe('canceled');
});

it('revokes an all-queued account without dispatching a transient worker', async () => {
  expect((await capacity(0)).status).toBe(200);
  const one = await run(bob, projectB, 'queued-revoke-one');
  const two = await run(bob, projectB, 'queued-revoke-two');
  expect((await daemon.request({ method: 'POST', path: `/api/auth/users/${bob.id}/sessions/revoke`, cookie: admin.cookie,
    body: {} })).status).toBe(200);
  const { login } = await import('./multiuser-harness.js');
  bob.cookie = await login(daemon, bob.username, bob.password);
  for (const result of [one, two]) {
    expect((await daemon.request({ path: `/api/runs/${result.json.run.id}`, cookie: bob.cookie })).json.status).toBe('canceled');
    expect((await daemon.request({ path: `/api/runs/${result.json.run.id}/events`, cookie: bob.cookie })).text).not.toContain('event: start');
  }
});

it('provides content-free admin operations and refuses real provider slots', async () => {
  const denied = await daemon.request({ path: '/api/admin/pool', cookie: alice.cookie });
  expect(denied.status).toBe(403);
  const summary = await daemon.request({ path: '/api/admin/pool', cookie: admin.cookie });
  expect(summary.status).toBe(200);
  expect(JSON.stringify(summary.json)).not.toMatch(/private-a|private-b|secret-/);
  expect(summary.json.users[alice.id].usedMs).toBeGreaterThanOrEqual(0);
  const real = await daemon.request({ method: 'PUT', path: '/api/admin/pool/providers/claude', cookie: admin.cookie, body: { capacity: 1 } });
  expect(real.status).toBe(403);
  expect(real.json.error.code).toBe('MULTIUSER_PROVIDER_DISABLED');
  expect((await daemon.request({ method: 'PUT', path: '/api/admin/pool/providers/test-mock', cookie: admin.cookie,
    body: { capacity: -1 } })).status).toBe(400);
  expect((await daemon.request({ method: 'PUT', path: `/api/admin/pool/users/${alice.id}/quota`, cookie: admin.cookie,
    body: { budgetMinutes: 10_081 } })).status).toBe(400);
  const db = new Database(path.join(dataRoot, 'app.sqlite'));
  try {
    const audit = db.prepare('SELECT action, target_id FROM multiuser_pool_audit ORDER BY id').all() as Array<{ action: string; target_id: string }>;
    expect(audit.some((entry) => entry.action === 'capacity' && entry.target_id === 'test-mock')).toBe(true);
    expect(audit.some((entry) => entry.action === 'capacity' && entry.target_id === 'claude')).toBe(false);
    expect(() => db.prepare('DELETE FROM multiuser_pool_audit').run()).toThrow(/append only/);
  } finally { db.close(); }
});
