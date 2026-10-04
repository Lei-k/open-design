// Issue #18 — personal Codex subscription linking over the real daemon HTTP
// boundary, against the repository mock app-server. Two users + admin, plus a
// third user for the identity-binding rule.
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  cleanupIsolatedDataRoot, loadIsolatedServerModule, multiUserOptions, provisionAccounts,
  startMultiUserDaemon, type Principal, type StartedMultiUserDaemon,
} from './multiuser-harness.js';
import {
  PERSONAL_CODEX_MOCK, RUN_MOCK, codexHome, decide, linkCodex, loginHomes, mode, readAttempt, readTree,
  setTurnMode, settle, startLogin, summary, until,
} from './personal-codex-helpers.js';

let daemon: StartedMultiUserDaemon;
let dataRoot: string;
let admin: Principal;
let alice: Principal;
let bob: Principal;
let carol: Principal;
let clock = Date.now();
const secrets = new Set<string>();
const captured: string[] = [];
const options = () => multiUserOptions({ testMockAgentScript: RUN_MOCK, testPersonalCodexAppServer: PERSONAL_CODEX_MOCK,
  poolClock: () => clock });

function remember(attempt: { userCode?: string; verificationUrl?: string }) {
  if (attempt.userCode) secrets.add(attempt.userCode);
  if (attempt.verificationUrl) secrets.add(attempt.verificationUrl);
}

beforeAll(async () => {
  delete process.env.OD_API_TOKEN;
  delete process.env.OD_DISABLE_API_AUTH;
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const original = console[method].bind(console);
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { captured.push(args.map(String).join(' ')); original(...args); });
  }
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream);
    vi.spyOn(stream, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
      captured.push(String(chunk));
      return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof stream.write);
  }
  ({ dataRoot } = await loadIsolatedServerModule());
  daemon = await startMultiUserDaemon(options());
  const accounts = await provisionAccounts(daemon, ['link-alice', 'link-bob', 'link-carol']);
  admin = accounts.admin;
  [alice, bob, carol] = accounts.users as [Principal, Principal, Principal];
}, 120_000);

afterAll(async () => {
  await daemon?.close();
  vi.restoreAllMocks();
  cleanupIsolatedDataRoot();
});

describe('personal Codex linking', () => {
  it('links through the device-code flow into a private per-user CODEX_HOME', async () => {
    const before = await summary(daemon, alice);
    expect(before).toMatchObject({ mode: 'multi-user', personalSubscriptionsEnabled: true,
      codex: { account: null, pendingAttempt: null }, claude: { available: false } });
    const attempt = await startLogin(daemon, alice);
    remember(attempt);
    expect(attempt.status).toBe('pending');
    expect(attempt.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(attempt.userCode).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}$/);
    expect(attempt.verificationUrl).toMatch(/^https:\/\/auth\.openai\.com\/codex\/device/);
    expect(attempt.expiresAt).toBeGreaterThan(clock);
    const owner = await readAttempt(daemon, alice, attempt.id);
    expect(owner.json.attempt.userCode).toBe(attempt.userCode);
    const pendingSummary = await summary(daemon, alice);
    expect(pendingSummary.codex.pendingAttempt).toMatchObject({ id: attempt.id, status: 'pending' });
    expect(JSON.stringify(pendingSummary)).not.toContain(attempt.userCode);

    await decide(dataRoot, alice, attempt.userCode, { outcome: 'approve', email: 'Alice.Person@example.com', planType: 'plus' });
    const settled = await settle(daemon, alice, attempt.id);
    expect(settled).toMatchObject({ status: 'connected', failureCode: null });
    expect(settled.userCode).toBeUndefined();
    expect(settled.verificationUrl).toBeUndefined();

    const account = (await summary(daemon, alice)).codex.account;
    expect(account).toMatchObject({ provider: 'codex', status: 'connected', maskedIdentity: 'a***@example.com',
      planType: 'plus', verifiedAt: null, lastProblem: null });
    expect(account.rateLimits.primary).toEqual({ usedPercent: 42, windowDurationMins: 300, resetsAt: 1_900_000_000 });
    const home = codexHome(dataRoot, alice.id);
    expect(home.startsWith(path.join(dataRoot, 'multiuser-runtime') + path.sep)).toBe(true);
    expect(mode(home)).toBe(0o700);
    expect(mode(path.dirname(home))).toBe(0o700);
    expect(mode(path.join(home, 'auth.json'))).toBe(0o600);
    expect(loginHomes(dataRoot, alice.id)).toEqual([]);
  });

  it('gives a second user a distinct home and never touches the first', async () => {
    const aliceAuth = readFileSync(path.join(codexHome(dataRoot, alice.id), 'auth.json'));
    const { attempt } = await linkCodex(daemon, dataRoot, bob, 'bob@example.org', 'pro');
    remember(attempt);
    expect(codexHome(dataRoot, bob.id)).not.toBe(codexHome(dataRoot, alice.id));
    expect(JSON.parse(readFileSync(path.join(codexHome(dataRoot, bob.id), 'auth.json'), 'utf8')).email).toBe('bob@example.org');
    expect(readFileSync(path.join(codexHome(dataRoot, alice.id), 'auth.json'))).toEqual(aliceAuth);
  });

  it('answers every foreign or forged attempt/account id with the same 404', async () => {
    const pending = await startLogin(daemon, bob);
    remember(pending);
    const bobAccount = (await summary(daemon, bob)).codex.account;
    const aliceAccount = (await summary(daemon, alice)).codex.account;
    for (const user of [alice, admin]) {
      const pairs: Array<[string, string, string]> = [
        ['GET', `/api/agent-accounts/codex/logins/${pending.id}`, `/api/agent-accounts/codex/logins/${randomBytes(32).toString('base64url')}`],
        ['POST', `/api/agent-accounts/codex/logins/${pending.id}/cancel`, `/api/agent-accounts/codex/logins/${randomBytes(32).toString('base64url')}/cancel`],
        ['POST', `/api/agent-accounts/codex/accounts/${bobAccount.id}/verify`, `/api/agent-accounts/codex/accounts/${randomUUID()}/verify`],
        ['DELETE', `/api/agent-accounts/codex/accounts/${bobAccount.id}`, `/api/agent-accounts/codex/accounts/${randomUUID()}`],
      ];
      for (const [method, foreign, forged] of pairs) {
        const body = method === 'GET' || method === 'DELETE' ? undefined : { consentToUsePlan: true };
        const a = await daemon.request({ method, path: foreign, cookie: user.cookie, ...(body ? { body } : {}) });
        const b = await daemon.request({ method, path: forged, cookie: user.cookie, ...(body ? { body } : {}) });
        expect(a.status, `${method} ${foreign}`).toBe(404);
        expect(a.json).toEqual(b.json);
        expect(a.text).not.toContain(pending.userCode);
      }
    }
    // A forged body field cannot redirect an own-account action either.
    const forged = await daemon.request({ method: 'POST', path: `/api/agent-accounts/codex/accounts/${aliceAccount.id}/verify`,
      cookie: bob.cookie, body: { consentToUsePlan: true, accountId: aliceAccount.id } });
    expect(forged.status).toBe(404);
    const still = await readAttempt(daemon, bob, pending.id);
    expect(still.json.attempt.status).toBe('pending');
    expect((await summary(daemon, bob)).codex.account).toEqual(bobAccount);
    const canceled = await daemon.request({ method: 'POST', path: `/api/agent-accounts/codex/logins/${pending.id}/cancel`, cookie: bob.cookie, body: {} });
    expect(canceled.json.attempt.status).toBe('canceled');
  });

  it('keeps one pending attempt per user: a new start atomically cancels the prior one', async () => {
    const first = await startLogin(daemon, carol);
    remember(first);
    const second = await startLogin(daemon, carol);
    remember(second);
    expect(second.id).not.toBe(first.id);
    const prior = await readAttempt(daemon, carol, first.id);
    expect(prior.json.attempt).toMatchObject({ status: 'canceled' });
    expect(prior.json.attempt.userCode).toBeUndefined();
    expect(loginHomes(dataRoot, carol.id)).toHaveLength(1);
    const cancel = await daemon.request({ method: 'POST', path: `/api/agent-accounts/codex/logins/${second.id}/cancel`, cookie: carol.cookie, body: {} });
    expect(cancel.status).toBe(200);
    expect(cancel.json.attempt.status).toBe('canceled');
    const again = await daemon.request({ method: 'POST', path: `/api/agent-accounts/codex/logins/${second.id}/cancel`, cookie: carol.cookie, body: {} });
    expect(again.json.attempt.status).toBe('canceled');
    expect(loginHomes(dataRoot, carol.id)).toEqual([]);
    expect((await summary(daemon, carol)).codex).toEqual({ account: null, pendingAttempt: null });
  });

  it('maps denied, provider-expired, workspace refusal and server-side expiry to terminal states', async () => {
    for (const [outcome, status, failureCode] of [
      ['deny', 'denied', null], ['expire', 'expired', null], ['workspace', 'failed', 'workspace_not_allowed'],
    ] as const) {
      const attempt = await startLogin(daemon, carol);
      remember(attempt);
      await decide(dataRoot, carol, attempt.userCode, { outcome });
      expect(await settle(daemon, carol, attempt.id)).toMatchObject({ status, failureCode });
      await until(() => loginHomes(dataRoot, carol.id), (homes) => homes.length === 0, 'login home removal');
    }
    const attempt = await startLogin(daemon, carol);
    remember(attempt);
    clock = attempt.expiresAt + 1;
    const expired = await readAttempt(daemon, carol, attempt.id);
    expect(expired.json.attempt).toMatchObject({ status: 'expired' });
    expect(expired.json.attempt.userCode).toBeUndefined();
    expect(existsSync(codexHome(dataRoot, carol.id))).toBe(false);
  });

  it('ignores completion replay and completion that arrives after cancel or expiry', async () => {
    // Replay: two completions for the same login plus one for a foreign login id.
    const replay = await startLogin(daemon, carol);
    remember(replay);
    await decide(dataRoot, carol, replay.userCode, { outcome: 'approve-replay', email: 'carol@example.net' });
    expect((await settle(daemon, carol, replay.id)).status).toBe('connected');
    const first = (await summary(daemon, carol)).codex.account;
    expect((await summary(daemon, carol)).codex.account).toEqual(first);
    const db = new Database(path.join(dataRoot, 'app.sqlite'));
    try {
      const rows = db.prepare("SELECT COUNT(*) AS n FROM multiuser_agent_account_audit WHERE action = 'link_complete' AND target_account_id = ?").get(carol.id) as { n: number };
      expect(rows.n).toBe(1);
    } finally { db.close(); }
    const unlinked = await daemon.request({ method: 'DELETE', path: `/api/agent-accounts/codex/accounts/${first.id}`, cookie: carol.cookie });
    expect(unlinked.status).toBe(200);

    // Completion racing a cancel.
    const raced = await startLogin(daemon, carol);
    remember(raced);
    const control = await decide(dataRoot, carol, raced.userCode, { outcome: 'approve-after-cancel', email: 'carol@example.net' });
    await until(() => existsSync(control), (present) => !present, 'mock to consume control file');
    const cancel = await daemon.request({ method: 'POST', path: `/api/agent-accounts/codex/logins/${raced.id}/cancel`, cookie: carol.cookie, body: {} });
    expect(cancel.json.attempt.status).toBe('canceled');
    expect((await readAttempt(daemon, carol, raced.id)).json.attempt.status).toBe('canceled');
    expect((await summary(daemon, carol)).codex.account).toBeNull();
    expect(existsSync(codexHome(dataRoot, carol.id))).toBe(false);

    // Completion arriving at stdin EOF after a server-side expiry.
    const late = await startLogin(daemon, carol);
    remember(late);
    const lateControl = await decide(dataRoot, carol, late.userCode, { outcome: 'approve-on-close', email: 'carol@example.net' });
    await until(() => existsSync(lateControl), (present) => !present, 'mock to consume control file');
    clock = late.expiresAt + 1;
    expect((await readAttempt(daemon, carol, late.id)).json.attempt.status).toBe('expired');
    await until(() => loginHomes(dataRoot, carol.id), (homes) => homes.length === 0, 'login home removal');
    expect((await readAttempt(daemon, carol, late.id)).json.attempt.status).toBe('expired');
    expect((await summary(daemon, carol)).codex.account).toBeNull();
    expect(existsSync(codexHome(dataRoot, carol.id))).toBe(false);
  });

  it('lets one provider identity link to several platform accounts, each with its own isolated home', async () => {
    // One person may own several platform accounts; each links on its own device-code login.
    const aliceBefore = (await summary(daemon, alice)).codex.account;
    const aliceAuthFile = path.join(codexHome(dataRoot, alice.id), 'auth.json');
    const aliceAuth = readFileSync(aliceAuthFile);
    const attempt = await startLogin(daemon, carol);
    remember(attempt);
    await decide(dataRoot, carol, attempt.userCode, { outcome: 'approve', email: 'alice.person@EXAMPLE.com' });
    expect(await settle(daemon, carol, attempt.id)).toMatchObject({ status: 'connected', failureCode: null });
    const carolAccount = (await summary(daemon, carol)).codex.account;
    expect(carolAccount).toMatchObject({ status: 'connected', maskedIdentity: aliceBefore.maskedIdentity });
    expect(carolAccount.id).not.toBe(aliceBefore.id);
    const carolAuthFile = path.join(codexHome(dataRoot, carol.id), 'auth.json');
    expect(codexHome(dataRoot, carol.id)).not.toBe(codexHome(dataRoot, alice.id));
    for (const file of [aliceAuthFile, carolAuthFile]) expect(mode(file)).toBe(0o600);
    // Credentials are never shared: carol's came from her own login.
    expect(readFileSync(carolAuthFile)).not.toEqual(aliceAuth);
    expect(readFileSync(aliceAuthFile)).toEqual(aliceAuth);

    // Re-authorizing alice neither touches carol's home nor cancels carol's personal runs.
    const carolAuth = readFileSync(carolAuthFile);
    const projectId = randomUUID();
    const project = await daemon.request({ method: 'POST', path: '/api/projects', cookie: carol.cookie, body: { id: projectId, name: projectId } });
    expect(project.status, project.text).toBe(200);
    const run = await daemon.request({ method: 'POST', path: '/api/runs', cookie: carol.cookie, body: { projectId,
      conversationId: project.json.conversationId, agentId: 'codex', executionSource: 'personal_subscription', message: 'carol-run [mock-delay-ms=1500]' } });
    expect(run.status, run.text).toBe(202);
    const runState = () => daemon.request({ path: `/api/runs/${run.json.run.id}`, cookie: carol.cookie }).then((r) => r.json.status as string);
    await until(runState, (status) => status === 'running', 'carol run running');
    const reauth = await startLogin(daemon, alice);
    remember(reauth);
    await decide(dataRoot, alice, reauth.userCode, { outcome: 'approve', email: 'Alice.Person@example.com' });
    expect((await settle(daemon, alice, reauth.id)).status).toBe('connected');
    expect(readFileSync(aliceAuthFile)).not.toEqual(aliceAuth);
    expect(await runState()).toBe('running');
    expect(await until(runState, (status) => status !== 'running', 'carol run finished')).toBe('succeeded');
    expect(readFileSync(carolAuthFile)).toEqual(carolAuth);

    // Unlinking carol leaves alice connected with her home and credential intact.
    const aliceReauthed = readFileSync(aliceAuthFile);
    const unlinked = await daemon.request({ method: 'DELETE', path: `/api/agent-accounts/codex/accounts/${carolAccount.id}`, cookie: carol.cookie });
    expect(unlinked.status, unlinked.text).toBe(200);
    expect(existsSync(codexHome(dataRoot, carol.id))).toBe(false);
    expect((await summary(daemon, alice)).codex.account).toMatchObject({ id: aliceBefore.id, status: 'connected',
      maskedIdentity: aliceBefore.maskedIdentity });
    expect(readFileSync(aliceAuthFile)).toEqual(aliceReauthed);
    expect(mode(aliceAuthFile)).toBe(0o600);
  });

  it('keeps exactly one account per user: re-authorization may switch the subscription', async () => {
    const before = (await summary(daemon, alice)).codex.account;
    const other = await startLogin(daemon, alice);
    remember(other);
    await decide(dataRoot, alice, other.userCode, { outcome: 'approve', email: 'someone-else@example.com' });
    expect(await settle(daemon, alice, other.id)).toMatchObject({ status: 'connected', failureCode: null });
    expect((await summary(daemon, alice)).codex.account).toMatchObject({ id: before.id, status: 'connected', maskedIdentity: 's***@example.com' });
    expect(JSON.parse(readFileSync(path.join(codexHome(dataRoot, alice.id), 'auth.json'), 'utf8')).email).toBe('someone-else@example.com');
    // Switching back is another switch on the same account row.
    const same = await startLogin(daemon, alice);
    remember(same);
    await decide(dataRoot, alice, same.userCode, { outcome: 'approve', email: 'alice.person@example.com', planType: 'pro' });
    expect((await settle(daemon, alice, same.id)).status).toBe('connected');
    const after = (await summary(daemon, alice)).codex.account;
    expect(after.id).toBe(before.id);
    expect(after.planType).toBe('pro');
  });

  it('verifies with a minimal request only after explicit consent, in the owner home', async () => {
    const account = (await summary(daemon, alice)).codex.account;
    const url = `/api/agent-accounts/codex/accounts/${account.id}/verify`;
    for (const body of [{}, { consentToUsePlan: 'yes' }, { consentToUsePlan: false }]) {
      const refused = await daemon.request({ method: 'POST', path: url, cookie: alice.cookie, body });
      expect(refused.status).toBe(400);
      expect(refused.json.error.code).toBe('MULTIUSER_PERSONAL_CONSENT_REQUIRED');
    }
    expect(existsSync(path.join(codexHome(dataRoot, alice.id), 'sessions'))).toBe(false);
    const verified = await daemon.request({ method: 'POST', path: url, cookie: alice.cookie, body: { consentToUsePlan: true } });
    expect(verified.status, verified.text).toBe(200);
    expect(verified.json.account.verifiedAt).toEqual(expect.any(Number));
    expect(existsSync(path.join(codexHome(dataRoot, alice.id), 'sessions'))).toBe(true);
    expect(existsSync(path.join(codexHome(dataRoot, bob.id), 'sessions'))).toBe(false);
  });

  it('maps provider failures to stable states without switching source', async () => {
    const bobAccount = (await summary(daemon, bob)).codex.account;
    const verify = (user: Principal, id: string) => daemon.request({ method: 'POST', path: `/api/agent-accounts/codex/accounts/${id}/verify`,
      cookie: user.cookie, body: { consentToUsePlan: true } });
    setTurnMode(dataRoot, bob, { turn: 'usage-limit', rateLimits: 'unavailable' });
    const limited = await verify(bob, bobAccount.id);
    expect(limited.status).toBe(429);
    expect(limited.json.error.code).toBe('MULTIUSER_PERSONAL_USAGE_LIMIT');
    expect((await summary(daemon, bob)).codex.account).toMatchObject({ status: 'connected', lastProblem: 'usage_limit_reached' });
    setTurnMode(dataRoot, bob, { turn: 'workspace' });
    const workspace = await verify(bob, bobAccount.id);
    expect(workspace.status).toBe(403);
    expect(workspace.json.error.code).toBe('MULTIUSER_PERSONAL_WORKSPACE_NOT_ALLOWED');
    expect((await summary(daemon, bob)).codex.account).toMatchObject({ status: 'disabled', lastProblem: 'workspace_not_allowed' });
    const blocked = await verify(bob, bobAccount.id);
    expect(blocked.status).toBe(409);
    expect(blocked.json.error.code).toBe('MULTIUSER_PERSONAL_UNAVAILABLE');

    const aliceAccount = (await summary(daemon, alice)).codex.account;
    setTurnMode(dataRoot, alice, { turn: 'auth-invalid' });
    const expired = await verify(alice, aliceAccount.id);
    expect(expired.status).toBe(409);
    expect(expired.json.error.code).toBe('MULTIUSER_PERSONAL_REAUTH_REQUIRED');
    expect((await summary(daemon, alice)).codex.account).toMatchObject({ status: 'requires_reauth', lastProblem: 'reauth_required' });
    setTurnMode(dataRoot, alice, { turn: 'ok' });
    const reauth = await startLogin(daemon, alice);
    remember(reauth);
    await decide(dataRoot, alice, reauth.userCode, { outcome: 'approve', email: 'alice.person@example.com' });
    expect((await settle(daemon, alice, reauth.id)).status).toBe('connected');
    expect((await summary(daemon, alice)).codex.account).toMatchObject({ id: aliceAccount.id, status: 'connected', lastProblem: null });
  });

  it('shows admins non-sensitive metadata only and refuses non-admins', async () => {
    expect((await daemon.request({ path: '/api/admin/agent-accounts', cookie: alice.cookie })).status).toBe(403);
    const view = await daemon.request({ path: '/api/admin/agent-accounts', cookie: admin.cookie });
    expect(view.status).toBe(200);
    expect(view.json.users[alice.id].codex).toMatchObject({ linked: true, status: 'connected' });
    expect(view.json.users[carol.id].codex).toMatchObject({ linked: false, status: null });
    const text = view.text;
    for (const leak of ['example', '@', 'a***', 'plus', 'pro', 'auth.json', 'refresh']) expect(text).not.toContain(leak);
  });

  it('unlinks after stopping work and deletes only that user\'s auth', async () => {
    const bobAccount = (await summary(daemon, bob)).codex.account;
    const aliceAuth = readFileSync(path.join(codexHome(dataRoot, alice.id), 'auth.json'));
    const res = await daemon.request({ method: 'DELETE', path: `/api/agent-accounts/codex/accounts/${bobAccount.id}`, cookie: bob.cookie });
    expect(res.status, res.text).toBe(200);
    expect(existsSync(codexHome(dataRoot, bob.id))).toBe(false);
    expect((await summary(daemon, bob)).codex.account).toBeNull();
    expect(readFileSync(path.join(codexHome(dataRoot, alice.id), 'auth.json'))).toEqual(aliceAuth);
  });

  it('fails a pending attempt on restart, removes its login home and keeps linked accounts', async () => {
    const pending = await startLogin(daemon, bob);
    remember(pending);
    const aliceAccount = (await summary(daemon, alice)).codex.account;
    await daemon.close();
    daemon = await startMultiUserDaemon(options());
    const after = await readAttempt(daemon, bob, pending.id);
    expect(after.json.attempt).toMatchObject({ status: 'failed', failureCode: 'interrupted' });
    expect(after.json.attempt.userCode).toBeUndefined();
    expect(loginHomes(dataRoot, bob.id)).toEqual([]);
    expect((await summary(daemon, alice)).codex.account).toEqual(aliceAccount);
  });

  it('fails a pending attempt left by a crash and removes its stray login home', async () => {
    await daemon.close();
    const id = randomBytes(32).toString('base64url');
    const db = new Database(path.join(dataRoot, 'app.sqlite'));
    try {
      db.prepare(`INSERT INTO multiuser_agent_login_attempts (id, owner_account_id, provider, status, created_at, expires_at, updated_at)
        VALUES (?, ?, 'codex', 'pending', ?, ?, ?)`).run(id, carol.id, clock, clock + 60_000, clock);
    } finally { db.close(); }
    mkdirSync(path.join(path.dirname(codexHome(dataRoot, carol.id)), 'codex-login-crashed'), { recursive: true });
    daemon = await startMultiUserDaemon(options());
    expect((await readAttempt(daemon, carol, id)).json.attempt).toMatchObject({ status: 'failed', failureCode: 'interrupted' });
    expect(loginHomes(dataRoot, carol.id)).toEqual([]);
  });

  it('never writes a user code or verification URL to logs, audit rows, admin views or daemon data', async () => {
    expect(secrets.size).toBeGreaterThan(10);
    const admin1 = await daemon.request({ path: '/api/admin/agent-accounts', cookie: admin.cookie });
    const db = new Database(path.join(dataRoot, 'app.sqlite'));
    let audit: string;
    try {
      const rows = db.prepare('SELECT * FROM multiuser_agent_account_audit').all();
      expect(rows.length).toBeGreaterThan(5);
      audit = JSON.stringify(rows);
      expect(() => db.prepare('DELETE FROM multiuser_agent_account_audit').run()).toThrow(/append only/);
    } finally { db.close(); }
    const logs = captured.join('\n');
    const files = readTree(dataRoot);
    for (const secret of secrets) {
      expect(logs).not.toContain(secret);
      expect(audit).not.toContain(secret);
      expect(admin1.text).not.toContain(secret);
      for (const { file, bytes } of files) expect(bytes.includes(Buffer.from(secret)), file).toBe(false);
    }
  });
});
