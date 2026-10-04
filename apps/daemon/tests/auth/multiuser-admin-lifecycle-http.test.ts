// Issue #10 — admin-user lifecycle through the REAL multi-user daemon.
//
// `startServer` with the test-only multi-user option: the gate, the auth
// registrar, the company-pool mock run lane and the personal-subscription mock
// lane are all live. Proves recipient onboarding end to end through the gate,
// and that an admin-issued reset or role change invalidates the target's
// session on the next request and cancels the target's queued and active
// company AND personal mock work through the existing cancellation callback,
// leaving another owner's work untouched.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupIsolatedDataRoot, loadIsolatedServerModule, login, multiUserOptions, provisionAccounts,
  startMultiUserDaemon, type Principal, type StartedMultiUserDaemon,
} from './multiuser-harness.js';
import { PERSONAL_CODEX_MOCK, RUN_MOCK, linkCodex, until } from './personal-codex-helpers.js';

let daemon: StartedMultiUserDaemon;
let dataRoot: string;
let admin: Principal;
let alice: Principal;
let bob: Principal;

async function newProject(user: Principal) {
  const id = randomUUID();
  const res = await daemon.request({ method: 'POST', path: '/api/projects', cookie: user.cookie, body: { id, name: id } });
  expect(res.status, res.text).toBe(200);
  return { projectId: id, conversationId: res.json.conversationId as string };
}
async function company(user: Principal, message: string, delayMs: number) {
  const res = await daemon.request({ method: 'POST', path: '/api/runs', cookie: user.cookie,
    body: { ...(await newProject(user)), agentId: 'test-mock', message, delayMs } });
  expect(res.status, res.text).toBe(202);
  return res.json.run.id as string;
}
async function personal(user: Principal, message: string) {
  const res = await daemon.request({ method: 'POST', path: '/api/runs', cookie: user.cookie,
    body: { ...(await newProject(user)), agentId: 'codex', executionSource: 'personal_subscription', message } });
  expect(res.status, res.text).toBe(202);
  return res.json.run.id as string;
}
async function detail(user: Principal, id: string) {
  const res = await daemon.request({ path: `/api/runs/${id}`, cookie: user.cookie });
  expect(res.status, res.text).toBe(200);
  return res.json as { status: string };
}
const running = (user: Principal, id: string) => until(() => detail(user, id), (r) => r.status === 'running', `run ${id} running`);
/**
 * Wait for the run's completion signal, then prove it was canceled. The
 * revocation callback SIGTERMs an active run's child and the run becomes
 * `canceled` only when the child exits, after the admin response; the event
 * stream ends exactly then (it replays and ends at once if already finished).
 */
async function expectCanceled(user: Principal, id: string) {
  const stream = await daemon.request({ path: `/api/runs/${id}/events`, cookie: user.cookie });
  expect(stream.status, id).toBe(200);
  expect(stream.text, id).toMatch(/event: end\ndata: \{"status":"canceled"/);
  expect(stream.text, id).not.toContain('event: agent');
  expect((await detail(user, id)).status, id).toBe('canceled');
}

beforeAll(async () => {
  delete process.env.OD_API_TOKEN;
  delete process.env.OD_DISABLE_API_AUTH;
  ({ dataRoot } = await loadIsolatedServerModule());
  daemon = await startMultiUserDaemon(multiUserOptions({ testMockAgentScript: RUN_MOCK, testPersonalCodexAppServer: PERSONAL_CODEX_MOCK }));
  const accounts = await provisionAccounts(daemon, ['life-alice', 'life-bob']);
  admin = accounts.admin;
  [alice, bob] = accounts.users as [Principal, Principal];
  await linkCodex(daemon, dataRoot, alice, 'life-alice@example.com');
  const capacity = await daemon.request({ method: 'PUT', path: '/api/admin/pool/providers/test-mock', cookie: admin.cookie, body: { capacity: 2 } });
  expect(capacity.status, capacity.text).toBe(200);
}, 120_000);

afterAll(async () => {
  await daemon?.close();
  cleanupIsolatedDataRoot();
});

describe('recipient onboarding through the multi-user gate', () => {
  it('provisions without a password; only the recipient can activate the account', async () => {
    const created = await daemon.request({ method: 'POST', path: '/api/auth/users', cookie: admin.cookie,
      body: { username: 'life-carol', role: 'user' } });
    expect(created.status, created.text).toBe(201);
    expect(created.json.account.passwordState).toBe('setup_required');
    const token = created.json.setup.token as string;

    // The pending account can neither log in nor reach a project route.
    const early = await daemon.request({ method: 'POST', path: '/api/auth/login', body: { username: 'life-carol', password: 'carol-password-123' } });
    expect(early.status).toBe(401);
    // Ordinary users cannot read the account list or audit.
    expect((await daemon.request({ path: '/api/auth/users?q=life', cookie: bob.cookie })).status).toBe(403);
    expect((await daemon.request({ path: '/api/auth/audit', cookie: bob.cookie })).status).toBe(403);
    expect((await daemon.request({ path: '/api/auth/audit' })).status).toBe(401);

    // Redemption is anonymous at the gate; forged identity headers change nothing.
    const done = await daemon.request({ method: 'POST', path: '/api/auth/setup',
      headers: { 'x-od-user': 'root-admin', authorization: 'Bearer x' }, body: { token, password: 'carol-password-123' } });
    expect(done.status, done.text).toBe(200);
    expect(done.setCookies).toEqual([]);
    const replay = await daemon.request({ method: 'POST', path: '/api/auth/setup', body: { token, password: 'carol-password-456' } });
    expect(replay.status).toBe(401);

    const carol: Principal = { id: created.json.account.id, username: 'life-carol', password: 'carol-password-123',
      cookie: await login(daemon, 'life-carol', 'carol-password-123') };
    await newProject(carol);

    const search = await daemon.request({ path: '/api/auth/users?q=LIFE-C', cookie: admin.cookie });
    expect(search.status, search.text).toBe(200);
    expect(search.json.accounts).toEqual([expect.objectContaining({ username: 'life-carol', passwordState: 'set' })]);
    expect(search.text).not.toContain(token);
    const audit = await daemon.request({ path: '/api/auth/audit?limit=3', cookie: admin.cookie });
    expect(audit.json.events.map((e: { action: string }) => e.action)).toEqual(['password_setup', 'credential_issue', 'account_create']);
    expect(audit.text).not.toContain(token);
  });
});

describe('admin lifecycle actions cancel the target owner\'s work only', () => {
  it('an issued reset invalidates the session and cancels queued/active company and personal work', async () => {
    const companyActive = await company(alice, 'alice-company-active', 2000);
    const companyQueued = await company(alice, 'alice-company-queued', 0);
    const personalActive = await personal(alice, 'alice-personal-active [mock-delay-ms=3000]');
    const personalQueued = await personal(alice, 'alice-personal-queued');
    const bobRun = await company(bob, 'bob-keeps-running', 600);
    await running(alice, companyActive);
    await running(alice, personalActive);
    expect((await detail(alice, companyQueued)).status).toBe('queued');
    expect((await detail(alice, personalQueued)).status).toBe('queued');

    const reset = await daemon.request({ method: 'POST', path: `/api/auth/users/${alice.id}/password`, cookie: admin.cookie, body: {} });
    expect(reset.status, reset.text).toBe(201);
    expect(reset.json.setup.purpose).toBe('reset');

    // The very next request on the old session is refused.
    expect((await daemon.request({ path: `/api/runs/${companyActive}`, cookie: alice.cookie })).status).toBe(401);
    expect((await daemon.request({ method: 'POST', path: '/api/auth/login', body: { username: alice.username, password: alice.password } })).status).toBe(401);
    // Another owner is unaffected: its stream ends normally and it succeeds.
    const bobEvents = await daemon.request({ path: `/api/runs/${bobRun}/events`, cookie: bob.cookie });
    expect(bobEvents.status).toBe(200);
    expect(bobEvents.text).toContain('bob-keeps-running');
    expect((await detail(bob, bobRun)).status).toBe('succeeded');
    expect((await daemon.request({ path: '/api/auth/me', cookie: bob.cookie })).status).toBe(200);

    // The admin sees no run content of the target.
    expect((await daemon.request({ path: `/api/runs/${companyActive}`, cookie: admin.cookie })).status).toBe(404);

    alice.password = 'alice-new-password-after-reset';
    const redeemed = await daemon.request({ method: 'POST', path: '/api/auth/setup', body: { token: reset.json.setup.token, password: alice.password } });
    expect(redeemed.status, redeemed.text).toBe(200);
    alice.cookie = await login(daemon, alice.username, alice.password);
    for (const id of [companyActive, companyQueued, personalActive, personalQueued]) await expectCanceled(alice, id);
  });

  it('a role change invalidates the session on the next request and cancels the target\'s active company and personal work', async () => {
    const companyActive = await company(alice, 'alice-role-company', 2000);
    const personalActive = await personal(alice, 'alice-role-personal [mock-delay-ms=3000]');
    const bobRun = await company(bob, 'bob-role-keeps', 600);
    await running(alice, companyActive);
    await running(alice, personalActive);
    const promoted = await daemon.request({ method: 'PATCH', path: `/api/auth/users/${alice.id}`, cookie: admin.cookie, body: { role: 'admin' } });
    expect(promoted.status, promoted.text).toBe(200);
    expect((await daemon.request({ path: '/api/auth/me', cookie: alice.cookie })).status).toBe(401);
    alice.cookie = await login(daemon, alice.username, alice.password);
    await expectCanceled(alice, companyActive);
    await expectCanceled(alice, personalActive);
    await daemon.request({ path: `/api/runs/${bobRun}/events`, cookie: bob.cookie });
    expect((await detail(bob, bobRun)).status).toBe('succeeded');
    const demoted = await daemon.request({ method: 'PATCH', path: `/api/auth/users/${alice.id}`, cookie: admin.cookie, body: { role: 'user' } });
    expect(demoted.status).toBe(200);
  });
});
