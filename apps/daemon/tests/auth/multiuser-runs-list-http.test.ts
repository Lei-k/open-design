// #28 — owner run history: bounded keyset pages, API status mapping, guarded
// row projection, and the owner-only stale personal pin signal.
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupIsolatedDataRoot, loadIsolatedServerModule, multiUserOptions, provisionAccounts,
  startMultiUserDaemon, type Principal, type StartedMultiUserDaemon,
} from './multiuser-harness.js';
import { PERSONAL_CODEX_MOCK, RUN_MOCK, linkCodex, summary, until } from './personal-codex-helpers.js';

let daemon: StartedMultiUserDaemon;
let dataRoot: string;
let alice: Principal;
let bob: Principal;
let carol: Principal;
let dave: Principal;
// A fixed pool clock gives runs identical timestamps, so pages must break ties by id.
let clock = 1_800_000_000_000;

type ListedRun = { id: string; status: string; createdAt: number; message: string | null; output: unknown; executionSource?: string };
type RunList = { runs: ListedRun[]; nextCursor: string | null; personalPinStale?: boolean };

async function newProject(user: Principal) {
  const id = randomUUID();
  const res = await daemon.request({ method: 'POST', path: '/api/projects', cookie: user.cookie, body: { id, name: id } });
  expect(res.status, res.text).toBe(200);
  return { id, conversationId: res.json.conversationId as string };
}
async function list(user: Principal, query: string) {
  return daemon.request({ path: `/api/runs${query ? `?${query}` : ''}`, cookie: user.cookie });
}
async function companyRun(user: Principal, target: { id: string; conversationId: string }, message: string, delayMs = 0) {
  const res = await daemon.request({ method: 'POST', path: '/api/runs', cookie: user.cookie,
    body: { projectId: target.id, conversationId: target.conversationId, agentId: 'test-mock', message, delayMs } });
  expect(res.status, res.text).toBe(202);
  return res.json.run.id as string;
}
const finished = (user: Principal, id: string) => until(async () => (await daemon.request({ path: `/api/runs/${id}`, cookie: user.cookie })).json,
  (run) => !['queued', 'running'].includes(run.status), `run ${id}`);
/** Walk every page; returns the ids in the order served and each page size. */
async function walk(user: Principal, query: string, limit: number) {
  const ids: string[] = []; const sizes: number[] = [];
  let cursor: string | null = null;
  do {
    const res = await list(user, `${query}&limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    expect(res.status, res.text).toBe(200);
    const page = res.json as RunList;
    ids.push(...page.runs.map((run) => run.id)); sizes.push(page.runs.length);
    cursor = page.nextCursor;
  } while (cursor !== null && sizes.length < 20);
  return { ids, sizes };
}
function withDb<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(path.join(dataRoot, 'app.sqlite'));
  try { return fn(db); } finally { db.close(); }
}
function plant(owner: string, target: { id: string; conversationId: string }, createdAt: number, extra: { request?: string | null; output?: string | null; status?: string } = {}) {
  const id = randomUUID();
  withDb((db) => db.prepare(`INSERT INTO multiuser_runs (id, owner_account_id, project_id, conversation_id, status, created_at, updated_at,
    output, request_json, queue_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`)
    .run(id, owner, target.id, target.conversationId, extra.status ?? 'succeeded', createdAt, createdAt,
      extra.output === undefined ? null : extra.output, extra.request === undefined ? JSON.stringify({ message: 'planted' }) : extra.request));
  return id;
}

beforeAll(async () => {
  delete process.env.OD_API_TOKEN;
  delete process.env.OD_DISABLE_API_AUTH;
  ({ dataRoot } = await loadIsolatedServerModule());
  daemon = await startMultiUserDaemon(multiUserOptions({ testMockAgentScript: RUN_MOCK, testPersonalCodexAppServer: PERSONAL_CODEX_MOCK,
    poolClock: () => clock }));
  const accounts = await provisionAccounts(daemon, ['list-alice', 'list-bob', 'list-carol', 'list-dave']);
  [alice, bob, carol, dave] = accounts.users as [Principal, Principal, Principal, Principal];
}, 120_000);

afterAll(async () => { await daemon?.close(); cleanupIsolatedDataRoot(); });

describe('GET /api/runs pagination and filters', () => {
  it('pages newest first by keyset, filtering ownership in SQL before the limit', async () => {
    const mine = await newProject(alice);
    const theirs = await newProject(bob);
    const created: string[] = [];
    for (const [index, message] of ['one', 'two', 'three', 'four'].entries()) {
      if (index === 2) clock += 1_000; // two timestamps, each shared by two runs
      created.push(await companyRun(alice, mine, message));
      await finished(alice, created.at(-1)!);
      await finished(bob, await companyRun(bob, theirs, `bob-${message}`));
    }
    // Newer rows that name alice but sit in a project she does not own never count toward a page.
    const foreignRows = [plant(alice.id, theirs, clock + 5_000), plant(alice.id, theirs, clock + 6_000)];
    const expected = withDb((db) => (db.prepare(`SELECT id FROM multiuser_runs WHERE conversation_id = ?
      ORDER BY created_at DESC, id DESC`).all(mine.conversationId) as Array<{ id: string }>).map((row) => row.id));
    expect(new Set(expected)).toEqual(new Set(created));

    const query = `projectId=${mine.id}&conversationId=${mine.conversationId}`;
    expect(await walk(alice, query, 2)).toEqual({ ids: expected, sizes: [2, 2] });
    expect(await walk(alice, query, 3)).toEqual({ ids: expected, sizes: [3, 1] });
    expect(await walk(alice, query, 4)).toEqual({ ids: expected, sizes: [4] });

    const everything = await walk(alice, 'x=1', 1);
    expect(everything.ids).toEqual(expected);
    const text = JSON.stringify(everything) + (await list(alice, '')).text;
    for (const id of foreignRows) expect(text).not.toContain(id);
    for (const user of [bob, carol]) {
      const other = await list(user, 'limit=100');
      for (const id of created) expect(other.text).not.toContain(id);
    }
  });

  it('defaults to 50 rows, caps at 100 and refuses malformed paging parameters', async () => {
    const target = await newProject(dave);
    const planted = Array.from({ length: 51 }, (_, index) => plant(dave.id, target, 1_000 + index));
    const first = await list(dave, `conversationId=${target.conversationId}`);
    expect(first.status).toBe(200);
    expect(first.json.runs).toHaveLength(50);
    expect(first.json.nextCursor).toEqual(expect.any(String));
    const second = await list(dave, `conversationId=${target.conversationId}&cursor=${encodeURIComponent(first.json.nextCursor)}`);
    expect(second.json.runs.map((run: ListedRun) => run.id)).toEqual([planted[0]]);
    expect(second.json.nextCursor).toBeNull();
    expect((await list(dave, `conversationId=${target.conversationId}&limit=100`)).json.runs).toHaveLength(51);
    for (const bad of ['limit=0', 'limit=101', 'limit=-1', 'limit=1.5', 'limit=abc', 'limit=', 'limit=1&limit=2',
      'cursor=', 'cursor=abc', 'cursor=12', 'cursor=-1:x', 'cursor=1:', `cursor=1:${'a'.repeat(200)}`, 'cursor=a&cursor=b',
      'projectId=a&projectId=b', 'conversationId=a&conversationId=b']) {
      const res = await list(dave, bad);
      expect(res.status, bad).toBe(400);
      expect(res.json.error.code, bad).toBe('BAD_REQUEST');
    }
  });

  it('maps API run status to stored status and refuses unknown status values', async () => {
    const target = await newProject(alice);
    const done = await companyRun(alice, target, 'done');
    await finished(alice, done);
    const active = await companyRun(alice, target, 'still running', 2_000);
    await until(async () => (await daemon.request({ path: `/api/runs/${active}`, cookie: alice.cookie })).json.status,
      (status) => status === 'running', 'running run');
    const query = `conversationId=${target.conversationId}`;
    expect((await list(alice, `${query}&status=running`)).json.runs.map((run: ListedRun) => run.id)).toEqual([active]);
    expect((await list(alice, `${query}&status=succeeded`)).json.runs.map((run: ListedRun) => run.id)).toEqual([done]);
    expect((await list(alice, `${query}&status=queued`)).json.runs).toEqual([]);
    for (const bad of ['active', 'RUNNING', 'bogus', '']) {
      const res = await list(alice, `${query}&status=${bad}`);
      expect(res.status, bad).toBe(400);
      expect(res.json.error.code).toBe('BAD_REQUEST');
    }
    await daemon.request({ method: 'POST', path: `/api/runs/${active}/cancel`, cookie: alice.cookie });
  });

  it('projects a malformed stored row without failing the owner list or detail', async () => {
    const target = await newProject(bob);
    const good = plant(bob.id, target, 10, { output: JSON.stringify({ message: 'fine' }) });
    const broken = plant(bob.id, target, 20, { request: '{"message": RAW-PRIVATE-REQUEST', output: 'RAW-PRIVATE-OUTPUT {' });
    const nullRequest = plant(bob.id, target, 30, { request: 'null', output: '[1,' });
    const listed = await list(bob, `conversationId=${target.conversationId}`);
    expect(listed.status, listed.text).toBe(200);
    expect(listed.text).not.toContain('RAW-PRIVATE');
    const byId = new Map((listed.json.runs as ListedRun[]).map((run) => [run.id, run]));
    expect(byId.get(good)).toMatchObject({ message: 'planted', output: { message: 'fine' } });
    expect(byId.get(broken)).toMatchObject({ message: null, output: null });
    expect(byId.get(nullRequest)).toMatchObject({ message: null, output: null });
    for (const id of [broken, nullRequest]) {
      const detail = await daemon.request({ path: `/api/runs/${id}`, cookie: bob.cookie });
      expect(detail.status, detail.text).toBe(200);
      expect(detail.json).toMatchObject({ id, message: null, output: null });
    }
  });
});

describe('owner-only personal pin signal', () => {
  it('reports a pin to an unlinked or replaced account, and nothing for foreign or company conversations', async () => {
    const { account } = await linkCodex(daemon, dataRoot, carol, 'carol-list@example.com');
    const pinned = await newProject(carol);
    const personal = await daemon.request({ method: 'POST', path: '/api/runs', cookie: carol.cookie, body: {
      projectId: pinned.id, conversationId: pinned.conversationId, agentId: 'codex', executionSource: 'personal_subscription', message: 'pin' } });
    expect(personal.status, personal.text).toBe(202);
    await finished(carol, personal.json.run.id);
    const companyConversation = await newProject(carol);
    await finished(carol, await companyRun(carol, companyConversation, 'company'));
    const pin = async (user: Principal, conversationId: string) => (await list(user, `conversationId=${conversationId}`)).json as RunList;

    expect((await pin(carol, pinned.conversationId)).personalPinStale).toBe(false);
    expect((await pin(carol, companyConversation.conversationId)).personalPinStale).toBe(false);
    expect((await list(carol, '')).json).not.toHaveProperty('personalPinStale');

    // Re-authorizing keeps the same account row, so the pin stays usable.
    await linkCodex(daemon, dataRoot, carol, 'carol-list@example.com');
    expect((await summary(daemon, carol)).codex.account.id).toBe(account.id);
    expect((await pin(carol, pinned.conversationId)).personalPinStale).toBe(false);

    const unlink = await daemon.request({ method: 'DELETE', path: `/api/agent-accounts/codex/accounts/${account.id}`, cookie: carol.cookie });
    expect(unlink.status, unlink.text).toBe(200);
    expect((await pin(carol, pinned.conversationId)).personalPinStale).toBe(true);
    await linkCodex(daemon, dataRoot, carol, 'carol-list@example.com');
    expect((await summary(daemon, carol)).codex.account.id).not.toBe(account.id);
    expect((await pin(carol, pinned.conversationId)).personalPinStale).toBe(true);
    // The signal names exactly the refusal the composer would otherwise hit.
    const refused = await daemon.request({ method: 'POST', path: '/api/runs', cookie: carol.cookie, body: {
      projectId: pinned.id, conversationId: pinned.conversationId, agentId: 'codex', executionSource: 'personal_subscription', message: 'again' } });
    expect(refused.status).toBe(409);
    expect(refused.json.error.code).toBe('MULTIUSER_EXECUTION_SOURCE_MISMATCH');
    expect((await pin(carol, companyConversation.conversationId)).personalPinStale).toBe(false);

    // Another user learns nothing: the foreign conversation looks like a missing one.
    const foreign = await list(bob, `conversationId=${pinned.conversationId}`);
    const missing = await list(bob, `conversationId=${randomUUID()}`);
    expect(foreign.status).toBe(200);
    expect(foreign.json).toEqual(missing.json);
    expect(foreign.json).toEqual({ runs: [], nextCursor: null, awaitingInputProjectIds: [], personalPinStale: false });
  });
});
