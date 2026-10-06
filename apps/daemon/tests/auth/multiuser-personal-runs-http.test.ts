// Issue #18 — personal-subscription run lane. Personal runs execute through the
// owner's own CODEX_HOME (repository mock app-server), use a separate queue,
// never consume company-pool slots or the 30h company ledger, and never fall
// back to the company pool.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  cleanupIsolatedDataRoot, loadIsolatedServerModule, login, multiUserOptions, provisionAccounts,
  startMultiUserDaemon, type Principal, type StartedMultiUserDaemon,
} from './multiuser-harness.js';
import * as personalCodexAccounts from '../../src/services/personal-codex-accounts.js';
import { PERSONAL_CODEX_MOCK, RUN_MOCK, actorDir, codexHome, linkCodex, looseModes, setTurnMode, summary, until } from './personal-codex-helpers.js';

let daemon: StartedMultiUserDaemon;
let dataRoot: string;
let admin: Principal;
let alice: Principal;
let bob: Principal;
let carol: Principal;
let dave: Principal;
let clock = Date.now();
const projects = new Map<string, { id: string; conversationId: string }>();
/** Company-pool runs use their own conversations: a personal run pins its conversation's source. */
const companyProjects = new Map<string, { id: string; conversationId: string }>();
const options = () => multiUserOptions({ testMockAgentScript: RUN_MOCK, testPersonalCodexAppServer: PERSONAL_CODEX_MOCK,
  poolClock: () => clock });

async function newProject(user: Principal) {
  const id = randomUUID();
  const res = await daemon.request({ method: 'POST', path: '/api/projects', cookie: user.cookie, body: { id, name: id } });
  expect(res.status, res.text).toBe(200);
  return { id, conversationId: res.json.conversationId as string };
}
function personal(user: Principal, message: string, project = projects.get(user.id)!) {
  return daemon.request({ method: 'POST', path: '/api/runs', cookie: user.cookie, body: {
    projectId: project.id, conversationId: project.conversationId, agentId: 'codex', executionSource: 'personal_subscription', message } });
}
function company(user: Principal, message: string, delayMs = 0, project = companyProjects.get(user.id)!) {
  return daemon.request({ method: 'POST', path: '/api/runs', cookie: user.cookie, body: {
    projectId: project.id, conversationId: project.conversationId, agentId: 'test-mock', message, delayMs } });
}
async function detail(user: Principal, id: string) {
  const res = await daemon.request({ path: `/api/runs/${id}`, cookie: user.cookie });
  expect(res.status, res.text).toBe(200);
  return res.json;
}
const finished = (user: Principal, id: string) => until(() => detail(user, id), (run) => !['queued', 'running'].includes(run.status), `run ${id}`);
async function personalCapacity(capacity: number) {
  const res = await daemon.request({ method: 'PUT', path: '/api/admin/agent-accounts/personal-capacity', cookie: admin.cookie, body: { capacity } });
  expect(res.status, res.text).toBe(200);
}
async function companyCapacity(capacity: number) {
  const res = await daemon.request({ method: 'PUT', path: '/api/admin/pool/providers/test-mock', cookie: admin.cookie, body: { capacity } });
  expect(res.status, res.text).toBe(200);
}
function ledgerRow(runId: string) {
  const db = new Database(path.join(dataRoot, 'worker-quota', 'worker-quota.sqlite'));
  try { return db.prepare('SELECT * FROM quota_runs WHERE run_id = ?').get(runId); } finally { db.close(); }
}

beforeAll(async () => {
  delete process.env.OD_API_TOKEN;
  delete process.env.OD_DISABLE_API_AUTH;
  ({ dataRoot } = await loadIsolatedServerModule());
  daemon = await startMultiUserDaemon(options());
  const accounts = await provisionAccounts(daemon, ['prun-alice', 'prun-bob', 'prun-carol', 'prun-dave']);
  admin = accounts.admin;
  [alice, bob, carol, dave] = accounts.users as [Principal, Principal, Principal, Principal];
  for (const [user, email] of [[alice, 'alice@example.com'], [bob, 'bob@example.com'], [carol, 'carol@example.com']] as const) {
    await linkCodex(daemon, dataRoot, user, email);
  }
  for (const user of [alice, bob, carol, dave]) {
    projects.set(user.id, await newProject(user));
    companyProjects.set(user.id, await newProject(user));
  }
}, 120_000);

afterEach(async () => {
  await personalCapacity(4);
  for (const user of [alice, bob, carol, dave]) {
    const list = await daemon.request({ path: '/api/runs', cookie: user.cookie });
    for (const run of (list.json?.runs ?? []) as Array<{ id: string; status: string }>) {
      if (run.status === 'queued' || run.status === 'running') {
        await daemon.request({ method: 'POST', path: `/api/runs/${run.id}/cancel`, cookie: user.cookie });
      }
    }
  }
});

afterAll(async () => { await daemon?.close(); cleanupIsolatedDataRoot(); });

describe('personal subscription run lane', () => {
  it('pins built-in design inputs, sends the stable prompt once, and reports artifact diffs', async () => {
    const project = await newProject(alice);
    const catalog = await daemon.request({ path: '/api/multiuser/design-catalog', cookie: alice.cookie });
    expect(catalog.status, catalog.text).toBe(200);
    const skill = catalog.json.skills[0] as { id: string; name: string };
    const system = catalog.json.designSystems[0] as { id: string; title: string };
    const conversation = await daemon.request({
      method: 'POST', path: `/api/multiuser/projects/${project.id}/conversations`, cookie: alice.cookie,
      body: { title: 'Design flow', skillId: skill.id, designSystemId: system.id, locale: 'en' },
    });
    expect(conversation.status, conversation.text).toBe(201);
    const conversationId = conversation.json.conversation.id as string;
    const request = (message: string, skillId = skill.id) => daemon.request({
      method: 'POST', path: '/api/runs', cookie: alice.cookie,
      body: { projectId: project.id, conversationId, agentId: 'codex', executionSource: 'personal_subscription',
        message, skillId, designSystemId: system.id },
    });

    const mismatch = await request('must not start', 'user:private');
    expect(mismatch.status).toBe(400);
    const companyMismatch = await daemon.request({
      method: 'POST', path: '/api/runs', cookie: alice.cookie,
      body: { projectId: project.id, conversationId, agentId: 'test-mock', executionSource: 'company_pool', message: 'must not use company' },
    });
    expect(companyMismatch.status).toBe(409);
    expect(companyMismatch.json.error.code).toBe('MULTIUSER_EXECUTION_SOURCE_MISMATCH');
    const firstRun = await request('create the page [mock-write=generated/result.html] [mock-progress]');
    expect(firstRun.status, firstRun.text).toBe(202);
    const first = await finished(alice, firstRun.json.run.id);
    expect(first.status, JSON.stringify(first)).toBe('succeeded');
    expect(first.output.files).toContain('generated/result.html');
    const firstReply = JSON.parse(first.output.text);
    expect(firstReply.message).toContain('# User request');
    expect(firstReply.message).toContain('create the page [mock-write=generated/result.html]');
    expect(firstReply.message).toContain(skill.name);
    expect(firstReply.message).toContain(system.title);
    const events = await daemon.request({ path: `/api/runs/${firstRun.json.run.id}/events`, cookie: alice.cookie });
    expect(events.status, events.text).toBe(200);
    expect(events.text).toContain('"kind":"todo"');
    expect(events.text).toContain('"kind":"command","name":"Bash","status":"started"');
    expect(events.text).toContain('"kind":"command","name":"Bash","status":"completed"');
    expect(events.text).toContain('"kind":"file","path":"generated/result.html","status":"changed"');
    expect(events.text).not.toContain('PRIVATE_COMMAND_OUTPUT');

    const followUpRun = await request('make the heading shorter');
    expect(followUpRun.status, followUpRun.text).toBe(202);
    const followUp = await finished(alice, followUpRun.json.run.id);
    const followUpReply = JSON.parse(followUp.output.text);
    expect(followUpReply.threadId).toBe(firstReply.threadId);
    expect(followUpReply.message).toBe('make the heading shorter');
  });

  it('runs each user only through their own CODEX_HOME with an explicit environment', async () => {
    process.env.MULTIUSER_TEST_API_KEY = 'PLANTED_HOST_SECRET';
    try {
      const [a, b] = await Promise.all([personal(alice, 'alice-private [mock-delay-ms=200]'), personal(bob, 'bob-private [mock-delay-ms=200]')]);
      expect(a.status, a.text).toBe(202);
      expect(b.status, b.text).toBe(202);
      expect(a.json.run).toMatchObject({ agentId: 'codex', executionSource: 'personal_subscription' });
      for (const [user, res, home, other] of [[alice, a, codexHome(dataRoot, alice.id), 'bob-private'], [bob, b, codexHome(dataRoot, bob.id), 'alice-private']] as const) {
        const run = await finished(user, res.json.run.id);
        expect(run.status, JSON.stringify(run)).toBe('succeeded');
        const reply = JSON.parse(run.output.text);
        expect(reply.codexHome).toBe(home);
        expect(reply.cwd).toBe(path.join(dataRoot, 'projects', projects.get(user.id)!.id));
        expect(reply.envKeys).toEqual(['CODEX_HOME', 'HOME', 'OD_DATA_DIR', 'TEMP', 'TMP', 'TMPDIR']);
        expect(reply.home).not.toBe(home);
        const events = await daemon.request({ path: `/api/runs/${res.json.run.id}/events`, cookie: user.cookie });
        expect(events.text).not.toContain(other);
        // Files the provider child wrote into the home are re-locked to 0600 / 0700.
        expect(existsSync(path.join(home, 'sessions'))).toBe(true);
        expect(looseModes(home)).toEqual([]);
      }
    } finally { delete process.env.MULTIUSER_TEST_API_KEY; }
  });

  it('bounds oversized UTF-8 final text and reports truncation explicitly', async () => {
    const accepted = await personal(alice, '[mock-large-output]');
    expect(accepted.status, accepted.text).toBe(202);
    const run = await finished(alice, accepted.json.run.id);
    expect(run.status, JSON.stringify(run)).toBe('succeeded');
    expect(run.output.textTruncated).toBe(true);
    expect(Buffer.byteLength(run.output.text, 'utf8')).toBeLessThanOrEqual(512 * 1024);
    expect(run.output.text.at(-1)).toBe('界');
  });

  it('is not charged to the company ledger and does not consume company slots or quota', async () => {
    await companyCapacity(0);
    const quota = await daemon.request({ method: 'PUT', path: `/api/admin/pool/users/${alice.id}/quota`, cookie: admin.cookie, body: { budgetMinutes: 0 } });
    expect(quota.status).toBe(200);
    const exhausted = await company(alice, 'company-blocked');
    expect(exhausted.status).toBe(429);
    const before = (await daemon.request({ path: '/api/admin/pool', cookie: admin.cookie })).json;
    const run = await personal(alice, 'personal-while-company-exhausted');
    expect(run.status, run.text).toBe(202);
    expect((await finished(alice, run.json.run.id)).status).toBe('succeeded');
    expect(ledgerRow(run.json.run.id)).toBeUndefined();
    const after = (await daemon.request({ path: '/api/admin/pool', cookie: admin.cookie })).json;
    expect(after.users[alice.id].usedMs).toBe(before.users[alice.id].usedMs);
    expect(after.providers['test-mock']).toEqual(before.providers['test-mock']);
    const personalView = (await daemon.request({ path: '/api/admin/agent-accounts', cookie: admin.cookie })).json;
    expect(personalView.users[alice.id].personalWorkerMs).toBeGreaterThanOrEqual(0);
    expect((await daemon.request({ method: 'PUT', path: `/api/admin/pool/users/${alice.id}/quota`, cookie: admin.cookie,
      body: { budgetMinutes: 1_800 } })).status).toBe(200);

    // The same user may hold one company run and one personal run at once.
    await companyCapacity(1);
    const c = await company(alice, 'company-concurrent', 1500);
    const p = await personal(alice, 'personal-concurrent [mock-delay-ms=800]');
    expect((await until(() => detail(alice, p.json.run.id), (r) => r.status === 'running', 'personal running')).status).toBe('running');
    expect((await detail(alice, c.json.run.id)).status).toBe('running');
    expect((await finished(alice, p.json.run.id)).status).toBe('succeeded');
  });

  it('enforces per-user personal limits independently of the company queue', async () => {
    await personalCapacity(0);
    await companyCapacity(0);
    const queued: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const res = await personal(alice, `personal-q${i}`);
      expect(res.status, res.text).toBe(202);
      expect(res.json.run).toMatchObject({ status: 'queued', queuePosition: i + 1 });
      queued.push(res.json.run.id);
    }
    const full = await personal(alice, 'personal-q3');
    expect(full.status).toBe(409);
    expect(full.json.error.code).toBe('MULTIUSER_PERSONAL_QUEUE_LIMIT');
    const companyRun = await company(alice, 'company-still-accepted');
    expect(companyRun.status).toBe(202);
    expect(companyRun.json.run.executionSource).toBeUndefined();
    await personalCapacity(4);
    const first = await until(() => detail(alice, queued[0]!), (r) => r.status !== 'queued', 'first dispatch');
    expect(['running', 'succeeded']).toContain(first.status);
    // One active personal run per user even with free host capacity.
    if (first.status === 'running') expect((await detail(alice, queued[1]!)).status).toBe('queued');
  });

  it('applies the host-wide ceiling and dispatches round-robin across users', async () => {
    await personalCapacity(0);
    // Start from an empty rotation so the expected order is fully determined.
    const db = new Database(path.join(dataRoot, 'app.sqlite'));
    try { db.prepare('DELETE FROM multiuser_personal_turns').run(); } finally { db.close(); }
    const a1 = (await personal(alice, 'A1 [mock-delay-ms=300]')).json.run.id;
    const a2 = (await personal(alice, 'A2 [mock-delay-ms=300]')).json.run.id;
    const b1 = (await personal(bob, 'B1 [mock-delay-ms=300]')).json.run.id;
    const c1 = (await personal(carol, 'C1 [mock-delay-ms=300]')).json.run.id;
    await personalCapacity(1);
    expect((await detail(alice, a1)).status).toBe('running');
    expect((await detail(bob, b1)).status).toBe('queued');
    await finished(alice, a1);
    expect((await until(() => detail(bob, b1), (r) => r.status !== 'queued', 'B1')).status).not.toBe('queued');
    expect((await detail(carol, c1)).status).toBe('queued');
    await finished(bob, b1);
    expect((await until(() => detail(carol, c1), (r) => r.status !== 'queued', 'C1')).status).not.toBe('queued');
    expect((await detail(alice, a2)).status).toBe('queued');
    const view = (await daemon.request({ path: '/api/admin/agent-accounts', cookie: admin.cookie })).json;
    expect(view.personalWorkerCapacity).toBe(1);
  });

  it('never falls back to the company pool when the personal account is unusable', async () => {
    await companyCapacity(1);
    const before = (await daemon.request({ path: '/api/runs', cookie: dave.cookie })).json.runs.length;
    const none = await personal(dave, 'no-account');
    expect(none.status).toBe(409);
    expect(none.json.error.code).toBe('MULTIUSER_PERSONAL_UNAVAILABLE');
    expect((await daemon.request({ path: '/api/runs', cookie: dave.cookie })).json.runs).toHaveLength(before);
    const wrongAgent = await daemon.request({ method: 'POST', path: '/api/runs', cookie: dave.cookie, body: {
      projectId: projects.get(dave.id)!.id, conversationId: projects.get(dave.id)!.conversationId, agentId: 'test-mock',
      executionSource: 'personal_subscription', message: 'x' } });
    expect(wrongAgent.status).toBe(403);
    expect(wrongAgent.json.error.code).toBe('MULTIUSER_AGENT_FORBIDDEN');
    const realCompany = await daemon.request({ method: 'POST', path: '/api/runs', cookie: dave.cookie, body: {
      projectId: projects.get(dave.id)!.id, conversationId: projects.get(dave.id)!.conversationId, agentId: 'codex',
      executionSource: 'company_pool', message: 'x' } });
    expect(realCompany.status).toBe(403);
    expect(realCompany.json.error.code).toBe('MULTIUSER_AGENT_FORBIDDEN');
  });

  it('keeps follow-ups on the same native session and refuses a source or account switch', async () => {
    const convo = await newProject(alice);
    const one = await personal(alice, 'turn-one', convo);
    const first = JSON.parse((await finished(alice, one.json.run.id)).output.text);
    expect(first.turnsInThread).toBe(1);
    const two = await personal(alice, 'turn-two', convo);
    const second = JSON.parse((await finished(alice, two.json.run.id)).output.text);
    expect(second.threadId).toBe(first.threadId);
    expect(second.turnsInThread).toBe(2);
    const switched = await company(alice, 'switch-source', 0, convo);
    expect(switched.status).toBe(409);
    expect(switched.json.error.code).toBe('MULTIUSER_EXECUTION_SOURCE_MISMATCH');
    // Bob cannot address alice's personal run.
    for (const suffix of ['', '/events']) {
      const hidden = await daemon.request({ path: `/api/runs/${two.json.run.id}${suffix}`, cookie: bob.cookie });
      const missing = await daemon.request({ path: `/api/runs/${randomUUID()}${suffix}`, cookie: bob.cookie });
      expect(hidden.status).toBe(404);
      expect(hidden.json).toEqual(missing.json);
    }
  });

  it('maps usage limit and expired auth on a run without switching source', async () => {
    setTurnMode(dataRoot, bob, { turn: 'usage-limit' });
    const limited = await personal(bob, 'limited');
    expect(await finished(bob, limited.json.run.id)).toMatchObject({ status: 'failed', output: { reason: 'MULTIUSER_PERSONAL_USAGE_LIMIT' } });
    expect((await summary(daemon, bob)).codex.account).toMatchObject({ status: 'connected', lastProblem: 'usage_limit_reached' });
    expect(ledgerRow(limited.json.run.id)).toBeUndefined();
    setTurnMode(dataRoot, bob, { turn: 'auth-invalid' });
    const invalid = await personal(bob, 'invalid');
    expect(await finished(bob, invalid.json.run.id)).toMatchObject({ status: 'failed', output: { reason: 'MULTIUSER_PERSONAL_REAUTH_REQUIRED' } });
    expect((await summary(daemon, bob)).codex.account).toMatchObject({ status: 'requires_reauth' });
    const next = await personal(bob, 'after-reauth-needed');
    expect(next.status).toBe(409);
    expect(next.json.error.code).toBe('MULTIUSER_PERSONAL_UNAVAILABLE');
    const runs = (await daemon.request({ path: '/api/runs', cookie: bob.cookie })).json.runs as Array<{ agentId: string }>;
    expect(runs.filter((run) => run.agentId === 'test-mock')).toHaveLength(0);
  });

  it('cancels a user\'s personal runs on unlink and revocation, leaving others intact', async () => {
    await personalCapacity(4);
    await companyCapacity(1);
    const active = (await personal(carol, 'carol-active [mock-delay-ms=3000]')).json.run.id;
    const queued = (await personal(carol, 'carol-queued')).json.run.id;
    const carolCompany = (await company(carol, 'carol-company', 1500)).json.run.id;
    const alicePersonal = (await personal(alice, 'alice-keeps [mock-delay-ms=600]')).json.run.id;
    await until(() => detail(carol, active), (r) => r.status === 'running', 'carol active');
    const account = (await summary(daemon, carol)).codex.account;
    const unlink = await daemon.request({ method: 'DELETE', path: `/api/agent-accounts/codex/accounts/${account.id}`, cookie: carol.cookie });
    expect(unlink.status, unlink.text).toBe(200);
    expect((await detail(carol, active)).status).toBe('canceled');
    expect((await detail(carol, queued)).status).toBe('canceled');
    expect(existsSync(codexHome(dataRoot, carol.id))).toBe(false);
    expect(existsSync(path.join(codexHome(dataRoot, alice.id), 'auth.json'))).toBe(true);
    expect((await finished(alice, alicePersonal)).status).toBe('succeeded');
    expect(['running', 'succeeded']).toContain((await detail(carol, carolCompany)).status);

    // Relinking gives a new account: the old native session is not reused.
    await linkCodex(daemon, dataRoot, carol, 'carol@example.com');
    const convo = projects.get(carol.id)!;
    const blocked = await personal(carol, 'old-thread', convo);
    expect(blocked.status).toBe(409);
    expect(blocked.json.error.code).toBe('MULTIUSER_EXECUTION_SOURCE_MISMATCH');

    const fresh = await newProject(carol);
    const pending = (await personal(carol, 'revoke-me [mock-delay-ms=3000]', fresh)).json.run.id;
    await until(() => detail(carol, pending), (r) => r.status === 'running', 'carol running');
    const revoked = await daemon.request({ method: 'POST', path: `/api/auth/users/${carol.id}/sessions/revoke`, cookie: admin.cookie, body: {} });
    expect(revoked.status).toBe(200);
    carol.cookie = await login(daemon, carol.username, carol.password);
    expect((await detail(carol, pending)).status).toBe('canceled');
  });

  it('cancels active personal runs on clean restart and keeps queued ones', async () => {
    await personalCapacity(1);
    const active = (await personal(alice, 'restart-active [mock-delay-ms=3000]')).json.run.id;
    const queued = (await personal(alice, 'restart-queued')).json.run.id;
    await until(() => detail(alice, active), (r) => r.status === 'running', 'active');
    await personalCapacity(0);
    await daemon.close();
    daemon = await startMultiUserDaemon(options());
    expect(await detail(alice, active)).toMatchObject({ status: 'canceled', output: { reason: 'daemon_shutdown' } });
    expect((await detail(alice, queued)).status).toBe('queued');
    await personalCapacity(1);
    expect((await finished(alice, queued)).status).toBe('succeeded');
  });

  it('fails a personal row left active by a crash without creating a ledger entry', async () => {
    await personalCapacity(0);
    const id = (await personal(alice, 'crash-active')).json.run.id;
    await daemon.close();
    const db = new Database(path.join(dataRoot, 'app.sqlite'));
    try { db.prepare("UPDATE multiuser_runs SET status = 'active', started_at = ? WHERE id = ?").run(clock, id); }
    finally { db.close(); }
    daemon = await startMultiUserDaemon(options());
    expect((await detail(alice, id)).status).toBe('failed');
    expect(ledgerRow(id)).toBeUndefined();
  });
});

// Issue #30 — a queued row whose stored request is damaged must fail before
// dispatch changes any state, instead of staying active with no child.
describe('damaged queued run requests', () => {
  const MARKER = 'damaged-request-marker';
  const INVALID_JSON = `{"message":"${MARKER}`;
  /** Overwrite a queued row's stored request, as a damaged database would hold it. */
  function damage(runId: string, requestJson: string) {
    const db = new Database(path.join(dataRoot, 'app.sqlite'));
    try { expect(db.prepare("UPDATE multiuser_runs SET request_json = ? WHERE id = ? AND status = 'queued'").run(requestJson, runId).changes).toBe(1); }
    finally { db.close(); }
  }
  function appDb<T>(read: (db: Database.Database) => T): T {
    const db = new Database(path.join(dataRoot, 'app.sqlite'));
    try { return read(db); } finally { db.close(); }
  }
  async function eventsOf(user: Principal, runId: string) {
    const res = await daemon.request({ path: `/api/runs/${runId}/events`, cookie: user.cookie });
    expect(res.status).toBe(200);
    return { names: [...res.text.matchAll(/^event: (\w+)$/gmu)].map((match) => match[1]), text: res.text };
  }
  async function expectRequestInvalid(user: Principal, runId: string) {
    const run = await finished(user, runId);
    expect(run).toMatchObject({ status: 'failed', message: null, output: { reason: 'MULTIUSER_RUN_REQUEST_INVALID' } });
    expect(run.output).toEqual({ reason: 'MULTIUSER_RUN_REQUEST_INVALID' });
    const events = await eventsOf(user, runId);
    // Never started: no start event, no worker time, no runtime home, no company ledger entry.
    expect(events.names).toEqual(['queued', 'end']);
    expect(events.text).not.toContain(MARKER);
    expect(JSON.stringify(run)).not.toContain(MARKER);
    expect(appDb((db) => db.prepare('SELECT started_at, ended_at FROM multiuser_runs WHERE id = ?').get(runId))).toEqual({ started_at: null, ended_at: null });
    expect(existsSync(path.join(actorDir(dataRoot, user.id), runId))).toBe(false);
    expect(ledgerRow(runId)).toBeUndefined();
  }
  const maxPersonalTurn = () => appDb((db) => (db.prepare('SELECT MAX(last_seq) AS n FROM multiuser_personal_turns').get() as { n: number | null }).n ?? 0);
  const personalTurn = (user: Principal) => appDb((db) => (db.prepare('SELECT last_seq FROM multiuser_personal_turns WHERE account_id = ?')
    .get(user.id) as { last_seq: number } | undefined)?.last_seq);

  it('fails damaged rows when a finishing run dispatches the lane, then runs the next valid row', async () => {
    const convo = await newProject(alice);
    const busy = (await personal(alice, 'busy [mock-delay-ms=5000]', convo)).json.run.id;
    await until(() => detail(alice, busy), (r) => r.status === 'running', 'busy running');
    const invalid = (await personal(alice, 'to-be-damaged-1', convo)).json.run.id;
    const nullRequest = (await personal(alice, 'to-be-damaged-2', convo)).json.run.id;
    const valid = (await personal(alice, 'valid-after-damaged', convo)).json.run.id;
    damage(invalid, INVALID_JSON);
    damage(nullRequest, 'null');
    const turnBefore = maxPersonalTurn();
    // Ending the busy run is what dispatches the queued rows.
    const canceled = await daemon.request({ method: 'POST', path: `/api/runs/${busy}/cancel`, cookie: alice.cookie });
    expect(canceled.status, canceled.text).toBe(200);
    await expectRequestInvalid(alice, invalid);
    await expectRequestInvalid(alice, nullRequest);
    const run = await finished(alice, valid);
    expect(run.status, JSON.stringify(run)).toBe('succeeded');
    expect(JSON.parse(run.output.text).message).toBe('valid-after-damaged');
    // Only the valid row took a personal dispatch turn.
    expect(personalTurn(alice)).toBe(turnBefore + 1);
  });

  it('fails damaged rows found at startup and still dispatches valid rows', async () => {
    await personalCapacity(0);
    const aliceConvo = await newProject(alice);
    const carolConvo = await newProject(carol);
    const rows = {
      invalid: (await personal(alice, 'startup-damaged-1', aliceConvo)).json.run.id,
      nullRequest: (await personal(alice, 'startup-damaged-2', aliceConvo)).json.run.id,
      aliceValid: (await personal(alice, 'startup-valid-alice', aliceConvo)).json.run.id,
      array: (await personal(carol, 'startup-damaged-3', carolConvo)).json.run.id,
      numeric: (await personal(carol, 'startup-damaged-4', carolConvo)).json.run.id,
      carolValid: (await personal(carol, 'startup-valid-carol', carolConvo)).json.run.id,
    };
    await daemon.close();
    damage(rows.invalid, INVALID_JSON);
    damage(rows.nullRequest, 'null');
    damage(rows.array, '[]');
    damage(rows.numeric, '{"message":7}');
    // The persisted ceiling lets the startup dispatch pick the rows up.
    appDb((db) => db.prepare("UPDATE multiuser_pool_config SET value = '4' WHERE key = 'personal-capacity'").run());
    daemon = await startMultiUserDaemon(options());
    for (const [user, id] of [[alice, rows.invalid], [alice, rows.nullRequest], [carol, rows.array], [carol, rows.numeric]] as const) {
      await expectRequestInvalid(user, id);
    }
    for (const [user, id, message] of [[alice, rows.aliceValid, 'startup-valid-alice'], [carol, rows.carolValid, 'startup-valid-carol']] as const) {
      const run = await finished(user, id);
      expect(run.status, JSON.stringify(run)).toBe('succeeded');
      expect(JSON.parse(run.output.text).message).toBe(message);
    }
  });

  it('fails a row whose start throws instead of leaving it active with no child', async () => {
    await personalCapacity(0);
    const convo = await newProject(alice);
    const broken = (await personal(alice, 'start-throws', convo)).json.run.id;
    const turnBefore = personalTurn(alice);
    const maxBefore = maxPersonalTurn();
    // Fault injection: persisting this row's start event fails.
    appDb((db) => db.exec(`CREATE TRIGGER test_start_fails BEFORE INSERT ON multiuser_run_events
      WHEN NEW.event = 'start' AND NEW.run_id = '${broken}' BEGIN SELECT RAISE(ABORT, 'planted start failure'); END`));
    try {
      await personalCapacity(1);
      expect(await finished(alice, broken)).toMatchObject({ status: 'failed', output: { reason: 'MULTIUSER_PERSONAL_RUN_FAILED' } });
      expect(personalTurn(alice)).toBe(turnBefore);
      expect(appDb((db) => db.prepare('SELECT started_at, ended_at FROM multiuser_runs WHERE id = ?').get(broken)))
        .toEqual({ started_at: null, ended_at: null });
      expect((await eventsOf(alice, broken)).names).toEqual(['queued', 'end']);
      expect(ledgerRow(broken)).toBeUndefined();
      const next = (await personal(alice, 'after-start-throws', convo)).json.run.id;
      expect((await finished(alice, next)).status).toBe('succeeded');
      expect(personalTurn(alice)).toBe(maxBefore + 1);
    } finally { appDb((db) => db.exec('DROP TRIGGER IF EXISTS test_start_fails')); }
  });

  it('keeps committed personal start accounting when the launcher throws before spawning', async () => {
    await personalCapacity(0);
    const convo = await newProject(alice);
    const broken = (await personal(alice, 'launcher-throws', convo)).json.run.id;
    const maxBefore = maxPersonalTurn();
    // Replace one launcher call at the existing module seam; no child is spawned.
    const launch = vi.spyOn(personalCodexAccounts, 'runPersonalCodexTurn').mockImplementationOnce(() => {
      throw new Error('planted launcher failure');
    });
    try {
      await personalCapacity(1);
      expect(await finished(alice, broken)).toMatchObject({ status: 'failed', output: { reason: 'MULTIUSER_PERSONAL_RUN_FAILED' } });
      expect(launch).toHaveBeenCalledTimes(1);
      expect(personalTurn(alice)).toBe(maxBefore + 1);
      expect(appDb((db) => db.prepare('SELECT started_at, ended_at FROM multiuser_runs WHERE id = ?').get(broken)))
        .toEqual({ started_at: clock, ended_at: clock });
      expect((await eventsOf(alice, broken)).names).toEqual(['queued', 'start', 'end']);
      expect(ledgerRow(broken)).toBeUndefined();
      const next = (await personal(alice, 'after-launcher-throws', convo)).json.run.id;
      expect((await finished(alice, next)).status).toBe('succeeded');
      expect(personalTurn(alice)).toBe(maxBefore + 2);
    } finally { launch.mockRestore(); }
  });

  const maxCompanyTurn = () => appDb((db) => (db.prepare('SELECT MAX(last_seq) AS n FROM multiuser_pool_turns').get() as { n: number | null }).n ?? 0);
  const companyTurn = (user: Principal) => appDb((db) => (db.prepare('SELECT last_seq FROM multiuser_pool_turns WHERE account_id = ?')
    .get(user.id) as { last_seq: number } | undefined)?.last_seq);

  it.each([
    ['invalid JSON', INVALID_JSON], ['null', 'null'], ['array', '[]'], ['primitive', '7'],
    ['missing message', JSON.stringify({ other: MARKER })], ['non-string message', JSON.stringify({ message: [MARKER] })],
  ])('fails a damaged company-pool %s before admission and dispatches the next valid row', async (_name, requestJson) => {
    await companyCapacity(0);
    const invalid = (await company(alice, 'company-damaged')).json.run.id;
    const valid = (await company(alice, 'company-valid', 100)).json.run.id;
    damage(invalid, requestJson);
    const turnBefore = maxCompanyTurn();
    await companyCapacity(1);
    await expectRequestInvalid(alice, invalid);
    const run = await finished(alice, valid);
    expect(run.status, JSON.stringify(run)).toBe('succeeded');
    expect(run.output.message).toBe('company-valid');
    expect(ledgerRow(valid)).toMatchObject({ status: 'finished' });
    expect(companyTurn(alice)).toBe(turnBefore + 1);
  });

  it('rolls back a company start failure and closes its admitted ledger entry before dispatching again', async () => {
    await companyCapacity(0);
    const broken = (await company(alice, 'company-start-throws')).json.run.id;
    const turnBefore = companyTurn(alice);
    const maxBefore = maxCompanyTurn();
    appDb((db) => db.exec(`CREATE TRIGGER test_company_start_fails BEFORE INSERT ON multiuser_run_events
      WHEN NEW.event = 'start' AND NEW.run_id = '${broken}' BEGIN SELECT RAISE(ABORT, 'planted start failure'); END`));
    try {
      await companyCapacity(1);
      expect(await finished(alice, broken)).toMatchObject({ status: 'failed', output: { reason: 'MULTIUSER_RUN_START_FAILED' } });
      expect(companyTurn(alice)).toBe(turnBefore);
      expect((await eventsOf(alice, broken)).names).toEqual(['queued', 'end']);
      expect(ledgerRow(broken)).toMatchObject({ status: 'finished', ended_at: clock });
      const next = (await company(alice, 'after-company-start-throws')).json.run.id;
      expect((await finished(alice, next)).status).toBe('succeeded');
      expect(companyTurn(alice)).toBe(maxBefore + 1);
      expect(ledgerRow(next)).toMatchObject({ status: 'finished' });
    } finally { appDb((db) => db.exec('DROP TRIGGER IF EXISTS test_company_start_fails')); }
  });
});
