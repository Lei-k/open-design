// Issue #18 — personal account lifecycle races found in review: unlink fencing,
// same-identity re-authorization keeping native sessions, the login deadline at
// completion, and restart with queued personal work at nonzero capacity.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppServerAccountClient } from '../../src/integrations/codex-app-server-account.js';
import {
  cleanupIsolatedDataRoot, loadIsolatedServerModule, multiUserOptions, provisionAccounts,
  startMultiUserDaemon, type Principal, type StartedMultiUserDaemon,
} from './multiuser-harness.js';
import {
  PERSONAL_CODEX_MOCK, RUN_MOCK, codexHome, decide, linkCodex, looseModes, readAttempt, startLogin, summary, until,
} from './personal-codex-helpers.js';

let daemon: StartedMultiUserDaemon | null = null;
let dataRoot: string;
let admin: Principal;
let reauthUser: Principal;
let unlinkUser: Principal;
let expiryUser: Principal;
let restartUser: Principal;
let clock = Date.now();
const options = () => multiUserOptions({ testMockAgentScript: RUN_MOCK, testPersonalCodexAppServer: PERSONAL_CODEX_MOCK,
  poolClock: () => clock });
const live = () => daemon!;

async function newProject(user: Principal) {
  const id = randomUUID();
  const res = await live().request({ method: 'POST', path: '/api/projects', cookie: user.cookie, body: { id, name: id } });
  expect(res.status, res.text).toBe(200);
  return { projectId: id, conversationId: res.json.conversationId as string };
}
function personal(user: Principal, target: { projectId: string; conversationId: string }, message: string) {
  return live().request({ method: 'POST', path: '/api/runs', cookie: user.cookie,
    body: { ...target, agentId: 'codex', executionSource: 'personal_subscription', message } });
}
async function detail(user: Principal, id: string) {
  const res = await live().request({ path: `/api/runs/${id}`, cookie: user.cookie });
  expect(res.status, res.text).toBe(200);
  return res.json;
}
const finished = (user: Principal, id: string) => until(() => detail(user, id), (run) => !['queued', 'running'].includes(run.status), `run ${id}`);

beforeAll(async () => {
  delete process.env.OD_API_TOKEN;
  delete process.env.OD_DISABLE_API_AUTH;
  ({ dataRoot } = await loadIsolatedServerModule());
  daemon = await startMultiUserDaemon(options());
  const accounts = await provisionAccounts(daemon, ['life-reauth', 'life-unlink', 'life-expiry', 'life-restart']);
  admin = accounts.admin;
  [reauthUser, unlinkUser, expiryUser, restartUser] = accounts.users as [Principal, Principal, Principal, Principal];
}, 120_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await daemon?.close();
  cleanupIsolatedDataRoot();
});

describe('personal account lifecycle', () => {
  it('keeps the native session across a same-identity re-authorization', async () => {
    await linkCodex(live(), dataRoot, reauthUser, 'life-reauth@example.com');
    const target = await newProject(reauthUser);
    const first = await finished(reauthUser, (await personal(reauthUser, target, 'turn-one')).json.run.id);
    expect(first.status, JSON.stringify(first)).toBe('succeeded');
    const authBefore = readFileSync(path.join(codexHome(dataRoot, reauthUser.id), 'auth.json'), 'utf8');

    await linkCodex(live(), dataRoot, reauthUser, 'life-reauth@example.com');
    const home = codexHome(dataRoot, reauthUser.id);
    // Only the credential was replaced; the home stays private.
    expect(readFileSync(path.join(home, 'auth.json'), 'utf8')).not.toBe(authBefore);
    expect(looseModes(home)).toEqual([]);

    const second = await personal(reauthUser, target, 'turn-two');
    expect(second.status, second.text).toBe(202);
    const result = await finished(reauthUser, second.json.run.id);
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'succeeded', output: { threadId: first.output.threadId } });
    expect(JSON.parse(result.output.text).turnsInThread).toBe(2);
  });

  it('fences admission, verification and linking from the moment unlink begins', async () => {
    const { account } = await linkCodex(live(), dataRoot, unlinkUser, 'life-unlink@example.com');
    const target = await newProject(unlinkUser);
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const called = new Promise<void>((resolve) => { entered = resolve; });
    const original = AppServerAccountClient.prototype.initialize;
    // Hold unlink inside its best-effort logout, after cancellation and before deletion.
    const spy = vi.spyOn(AppServerAccountClient.prototype, 'initialize').mockImplementation(async function (this: AppServerAccountClient) {
      entered();
      await blocked;
      return original.call(this);
    });
    const unlinking = live().request({ method: 'DELETE', path: `/api/agent-accounts/codex/accounts/${account.id}`, cookie: unlinkUser.cookie });
    let admitted: Awaited<ReturnType<typeof personal>>;
    let verify: Awaited<ReturnType<typeof personal>>;
    let relink: ReturnType<typeof personal>;
    try {
      await called;
      admitted = await personal(unlinkUser, target, 'during unlink [mock-delay-ms=3000]');
      verify = await live().request({ method: 'POST', path: `/api/agent-accounts/codex/accounts/${account.id}/verify`,
        cookie: unlinkUser.cookie, body: { consentToUsePlan: true } });
      relink = live().request({ method: 'POST', path: '/api/agent-accounts/codex/logins', cookie: unlinkUser.cookie, body: {} });
    } finally {
      release();
      spy.mockRestore();
    }
    const unlinked = await unlinking;
    const relinked = await relink;
    expect(unlinked.status, unlinked.text).toBe(200);
    const leftover = admitted.json?.run ? await detail(unlinkUser, admitted.json.run.id) : null;
    expect(admitted.status, JSON.stringify({ admitted: admitted.json, leftover })).toBe(409);
    expect(admitted.json.error.code).toBe('MULTIUSER_PERSONAL_UNAVAILABLE');
    expect(verify.status, verify.text).toBe(409);
    expect(verify.json.error.code).toBe('MULTIUSER_PERSONAL_BUSY');
    expect(relinked.status, relinked.text).toBe(409);
    expect(relinked.json.error.code).toBe('MULTIUSER_PERSONAL_BUSY');
    const runs = (await live().request({ path: '/api/runs', cookie: unlinkUser.cookie })).json.runs as Array<{ status: string }>;
    expect(runs.filter((run) => run.status === 'running' || run.status === 'queued')).toEqual([]);
    expect(existsSync(codexHome(dataRoot, unlinkUser.id))).toBe(false);
    expect((await summary(live(), unlinkUser)).codex).toEqual({ account: null, pendingAttempt: null });
  });

  it('expires a completion that arrives after the deadline, without a prior status read', async () => {
    const attempt = await startLogin(live(), expiryUser);
    clock = attempt.expiresAt + 1;
    await decide(dataRoot, expiryUser, attempt.userCode, { outcome: 'approve', email: 'life-expiry@example.com' });
    // The summary does not finalize an expired attempt itself; only the completion handler does.
    await until(() => summary(live(), expiryUser), (s) => s.codex.pendingAttempt === null, 'completion handled');
    expect((await readAttempt(live(), expiryUser, attempt.id)).json.attempt).toMatchObject({ status: 'expired' });
    expect((await summary(live(), expiryUser)).codex.account).toBeNull();
    expect(existsSync(codexHome(dataRoot, expiryUser.id))).toBe(false);
  });

  it('restarts with active and queued personal work at nonzero capacity', async () => {
    await linkCodex(live(), dataRoot, restartUser, 'life-restart@example.com');
    const target = await newProject(restartUser);
    const capacity = await live().request({ method: 'PUT', path: '/api/admin/agent-accounts/personal-capacity',
      cookie: admin.cookie, body: { capacity: 1 } });
    expect(capacity.status, capacity.text).toBe(200);
    const active = (await personal(restartUser, target, 'active [mock-delay-ms=3000]')).json.run;
    const queued = (await personal(restartUser, target, 'queued')).json.run;
    expect((await until(() => detail(restartUser, active.id), (r) => r.status === 'running', 'active run')).status).toBe('running');
    expect((await detail(restartUser, queued.id)).status).toBe('queued');
    await live().close();
    daemon = null;
    daemon = await startMultiUserDaemon(options());
    expect(await detail(restartUser, active.id)).toMatchObject({ status: 'canceled', output: { reason: 'daemon_shutdown' } });
    expect((await finished(restartUser, queued.id)).status).toBe('succeeded');
  });
});
