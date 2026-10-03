// Issue #18 — personal account lifecycle races found in review: unlink fencing,
// same-identity re-authorization keeping native sessions, the login deadline at
// completion, and restart with queued personal work at nonzero capacity.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppServerAccountClient } from '../../src/integrations/codex-app-server-account.js';
import {
  cleanupIsolatedDataRoot, loadIsolatedServerModule, multiUserOptions, provisionAccounts,
  startMultiUserDaemon, type Principal, type StartedMultiUserDaemon,
} from './multiuser-harness.js';
import {
  PERSONAL_CODEX_MOCK, RUN_MOCK, actorDir, codexHome, decide, linkCodex, looseModes, readAttempt, settle, startLogin, summary, until,
} from './personal-codex-helpers.js';

let daemon: StartedMultiUserDaemon | null = null;
let dataRoot: string;
let admin: Principal;
let reauthUser: Principal;
let unlinkUser: Principal;
let expiryUser: Principal;
let restartUser: Principal;
let switchUser: Principal;
let rollbackUser: Principal;
let ambiguousUser: Principal;
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
function withDb<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(path.join(dataRoot, 'app.sqlite'));
  try { return fn(db); } finally { db.close(); }
}
const accountRow = (user: Principal) => withDb((db) => db.prepare(
  "SELECT id, identity_hash, credential_version, verified_at FROM multiuser_agent_accounts WHERE owner_account_id = ?").get(user.id) as
  { id: string; identity_hash: string; credential_version: number; verified_at: number | null });
async function reauthorize(user: Principal, email: string) {
  const attempt = await startLogin(live(), user);
  await decide(dataRoot, user, attempt.userCode, { outcome: 'approve', email });
  return settle(live(), user, attempt.id);
}

beforeAll(async () => {
  delete process.env.OD_API_TOKEN;
  delete process.env.OD_DISABLE_API_AUTH;
  ({ dataRoot } = await loadIsolatedServerModule());
  daemon = await startMultiUserDaemon(options());
  const accounts = await provisionAccounts(daemon, ['life-reauth', 'life-unlink', 'life-expiry', 'life-restart', 'life-switch', 'life-rollback', 'life-ambiguous']);
  admin = accounts.admin;
  [reauthUser, unlinkUser, expiryUser, restartUser, switchUser, rollbackUser, ambiguousUser] =
    accounts.users as [Principal, Principal, Principal, Principal, Principal, Principal, Principal];
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

  it('switches to a different subscription on the same account row and starts pinned conversations fresh', async () => {
    const { account } = await linkCodex(live(), dataRoot, switchUser, 'switch-one@example.com');
    const target = await newProject(switchUser);
    const first = await finished(switchUser, (await personal(switchUser, target, 'before-switch')).json.run.id);
    expect(first.status, JSON.stringify(first)).toBe('succeeded');
    const verified = await live().request({ method: 'POST', path: `/api/agent-accounts/codex/accounts/${account.id}/verify`,
      cookie: switchUser.cookie, body: { consentToUsePlan: true } });
    expect(verified.json.account.verifiedAt).toEqual(expect.any(Number));
    const before = accountRow(switchUser);
    const home = codexHome(dataRoot, switchUser.id);
    expect(existsSync(path.join(home, 'sessions'))).toBe(true);
    const active = (await personal(switchUser, target, 'active [mock-delay-ms=3000]')).json.run.id;
    const queued = (await personal(switchUser, target, 'queued')).json.run.id;
    await until(() => detail(switchUser, active), (r) => r.status === 'running', 'active run');

    expect(await reauthorize(switchUser, 'switch-two@example.org')).toMatchObject({ status: 'connected', failureCode: null });
    expect((await summary(live(), switchUser)).codex.account).toMatchObject({ id: account.id, status: 'connected',
      maskedIdentity: 's***@example.org', verifiedAt: null, lastProblem: null });
    const after = accountRow(switchUser);
    expect(after.id).toBe(before.id);
    expect(after.identity_hash).not.toBe(before.identity_hash);
    expect(after.credential_version).toBe(before.credential_version + 1);
    expect((await detail(switchUser, active)).status).toBe('canceled');
    expect((await detail(switchUser, queued)).status).toBe('canceled');
    // The home now holds only the new login: the old credential and native sessions are gone.
    expect(JSON.parse(readFileSync(path.join(home, 'auth.json'), 'utf8')).email).toBe('switch-two@example.org');
    expect(readdirSync(home).filter((name) => name === 'sessions' || name.startsWith('auth.json.'))).toEqual([]);
    expect(readdirSync(actorDir(dataRoot, switchUser.id)).filter((name) => name.startsWith('codex-home.'))).toEqual([]);
    expect(looseModes(home)).toEqual([]);

    const followUp = await personal(switchUser, target, 'after-switch');
    expect(followUp.status, followUp.text).toBe(202);
    const result = await finished(switchUser, followUp.json.run.id);
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'succeeded', executionSource: 'personal_subscription' });
    expect(result.output.threadId).not.toBe(first.output.threadId);
    expect(JSON.parse(result.output.text)).toMatchObject({ codexHome: home, turnsInThread: 1 });
  });

  it('restores the previous subscription intact when a switch fails to bind', async () => {
    await linkCodex(live(), dataRoot, rollbackUser, 'rollback-one@example.com');
    const target = await newProject(rollbackUser);
    const first = await finished(rollbackUser, (await personal(rollbackUser, target, 'before-failed-switch')).json.run.id);
    expect(first.status, JSON.stringify(first)).toBe('succeeded');
    const home = codexHome(dataRoot, rollbackUser.id);
    const auth = readFileSync(path.join(home, 'auth.json'), 'utf8');
    const before = accountRow(rollbackUser);
    const summaryBefore = (await summary(live(), rollbackUser)).codex.account;
    // Fail the bind transaction after the account row update, at the native-session reset.
    withDb((db) => db.exec(`CREATE TRIGGER test_fail_switch BEFORE UPDATE OF thread_id ON multiuser_personal_sessions
      WHEN OLD.owner_account_id = '${rollbackUser.id}' BEGIN SELECT RAISE(ABORT, 'injected switch failure'); END`));
    try {
      expect(await reauthorize(rollbackUser, 'rollback-two@example.org')).toMatchObject({ status: 'failed', failureCode: 'provider_error' });
    } finally { withDb((db) => db.exec('DROP TRIGGER test_fail_switch')); }
    expect(accountRow(rollbackUser)).toEqual(before);
    expect((await summary(live(), rollbackUser)).codex.account).toEqual(summaryBefore);
    expect(readFileSync(path.join(home, 'auth.json'), 'utf8')).toBe(auth);
    expect(existsSync(path.join(home, 'sessions'))).toBe(true);
    expect(readdirSync(actorDir(dataRoot, rollbackUser.id)).filter((name) => name.startsWith('codex-home.') || name.startsWith('codex-login-'))).toEqual([]);
    expect(looseModes(home)).toEqual([]);
    const followUp = await finished(rollbackUser, (await personal(rollbackUser, target, 'after-failed-switch')).json.run.id);
    expect(followUp, JSON.stringify(followUp)).toMatchObject({ status: 'succeeded', output: { threadId: first.output.threadId } });
  });

  it('re-authorizes out of ambiguous legacy state; the pinned follow-up starts a fresh thread', async () => {
    const { account } = await linkCodex(live(), dataRoot, ambiguousUser, 'ambiguous@example.com');
    const target = await newProject(ambiguousUser);
    const first = await finished(ambiguousUser, (await personal(ambiguousUser, target, 'before-legacy')).json.run.id);
    expect(first.status, JSON.stringify(first)).toBe('succeeded');
    const before = accountRow(ambiguousUser);
    // A database from before the retained-state record, with an active home beside a set-aside one.
    await live().close();
    daemon = null;
    const home = codexHome(dataRoot, ambiguousUser.id);
    const aside = path.join(actorDir(dataRoot, ambiguousUser.id), 'codex-home.previous');
    withDb((db) => {
      db.exec('DROP TABLE multiuser_agent_retained_state');
      db.prepare("UPDATE multiuser_agent_accounts SET status = 'requires_reauth', last_problem = 'reauth_required' WHERE id = ?").run(account.id);
    });
    renameSync(home, aside);
    mkdirSync(home, { mode: 0o700 });
    writeFileSync(path.join(home, 'auth.json'), 'mock-ambiguous-active-credential', { mode: 0o600 });
    daemon = await startMultiUserDaemon(options());
    expect((await summary(live(), ambiguousUser)).codex.account).toMatchObject({ id: account.id, status: 'requires_reauth' });
    const fenced = await personal(ambiguousUser, target, 'while-ambiguous');
    expect(fenced.status).toBe(409);
    expect(fenced.json.error.code).toBe('MULTIUSER_PERSONAL_UNAVAILABLE');
    expect(existsSync(path.join(aside, 'sessions'))).toBe(true);

    // Same identity as the account row: the commit still starts a fresh subscription home.
    expect(await reauthorize(ambiguousUser, 'ambiguous@example.com')).toMatchObject({ status: 'connected', failureCode: null });
    expect((await summary(live(), ambiguousUser)).codex.account).toMatchObject({ id: account.id, status: 'connected',
      verifiedAt: null, lastProblem: null });
    expect(accountRow(ambiguousUser).credential_version).toBe(before.credential_version + 1);
    expect(existsSync(aside)).toBe(false);
    expect(readdirSync(home).filter((name) => name === 'sessions' || name.startsWith('auth.json.'))).toEqual([]);
    expect(JSON.parse(readFileSync(path.join(home, 'auth.json'), 'utf8')).email).toBe('ambiguous@example.com');
    expect(looseModes(home)).toEqual([]);

    const followUp = await personal(ambiguousUser, target, 'after-legacy');
    expect(followUp.status, followUp.text).toBe(202);
    const result = await finished(ambiguousUser, followUp.json.run.id);
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'succeeded', executionSource: 'personal_subscription' });
    expect(result.output.threadId).not.toBe(first.output.threadId);
    expect(JSON.parse(result.output.text)).toMatchObject({ codexHome: home, turnsInThread: 1 });
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
