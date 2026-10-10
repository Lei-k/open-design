// S58 repair 1 (#62): connectors authority is re-established immediately
// before every provider-side or local binding effect, and a successful cancel
// means the authorization can never complete. Each case holds the Composio fake
// at a chosen request, invalidates authority (session revoke, account disable,
// company key clear/rotate, concurrent disconnect, cancel, expiry) and then
// releases it: the held flow must make no further provider call and change no
// local binding.
import Database from 'better-sqlite3';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  cleanupIsolatedDataRoot, loadIsolatedServerModule, login, multiUserOptions, provisionAccounts,
  startMultiUserDaemon, MU_TEST_ORIGIN, type Principal, type StartedMultiUserDaemon,
} from './multiuser-harness.js';

const KEY_ONE = 'ak_race_company_key_ONE_1111';
const KEY_TWO = 'ak_race_company_key_TWO_2222';

interface Call { method: string; path: string; apiKey: string | null; body: Record<string, unknown> }
interface FakeAccount { id: string; userId: string; callback: string }
let calls: Call[] = [];
const accounts = new Map<string, FakeAccount>();
let nextAccount = 1;

/** One pending barrier: the next request matching `when` waits until released. */
interface Barrier { entered: Promise<void>; release: () => void; when: (call: Call) => boolean; enter: () => void; wait: Promise<void> }
let barrier: Barrier | null = null;
/** Wait until the held request reached the provider; fail fast if the request finished without reaching it. */
async function reached(held: Barrier, pending: Promise<{ status: number; text: string }>): Promise<void> {
  const finished = pending.then((res) => { throw new Error(`request finished before the held provider call: ${res.status} ${res.text}`); });
  finished.catch(() => {});
  await Promise.race([held.entered, finished]);
}
function hold(when: (call: Call) => boolean): Barrier {
  let enter!: () => void; let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const wait = new Promise<void>((resolve) => { release = resolve; });
  barrier = { entered, release, when, enter, wait };
  return barrier;
}
const isGetAccount = (call: Call) => call.method === 'GET' && call.path.startsWith('/api/v3/connected_accounts/');
const isAuthConfigList = (call: Call) => call.method === 'GET' && call.path === '/api/v3/auth_configs';
const isLink = (call: Call) => call.path === '/api/v3.1/connected_accounts/link';

const composio: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {};
  const call: Call = { method: init?.method ?? 'GET', path: url.pathname, apiKey: new Headers(init?.headers).get('x-api-key'), body };
  calls.push(call);
  const active = barrier;
  if (active?.when(call)) { barrier = null; active.enter(); await active.wait; }
  if (url.pathname === '/api/v3/auth_configs') {
    const slug = url.searchParams.get('toolkit_slug') ?? '';
    // notion has no existing auth config: the daemon creates a managed one (a provider-side write).
    return Response.json({ items: slug === 'notion' ? [] : [{ id: `ac_${slug}`, toolkit: { slug }, status: 'ENABLED' }] });
  }
  if (url.pathname === '/api/v3.1/auth_configs') {
    const slug = String((body.toolkit as { slug?: string } | undefined)?.slug);
    return Response.json({ id: `ac_created_${slug}`, toolkit: { slug } }, { status: 201 });
  }
  if (isLink(call)) {
    const id = `ca_race_${nextAccount++}`;
    accounts.set(id, { id, userId: String(body.user_id), callback: String(body.callback_url) });
    return Response.json({ id, redirect_url: 'https://backend.composio.dev/oauth/opaque' });
  }
  const id = decodeURIComponent(url.pathname.split('/').at(-1)!);
  const account = accounts.get(id);
  if (!account) return Response.json({ error: 'missing' }, { status: 404 });
  if (call.method === 'DELETE') { accounts.delete(id); return Response.json({}); }
  return Response.json({ id, user_id: account.userId, auth_config: { id: 'ac_github' }, toolkit: { slug: 'github' }, status: 'ACTIVE', email: 'race@apps.example' });
};

let daemon: StartedMultiUserDaemon;
let dataRoot: string;
let admin: Principal;
let clock = Date.now();

const appDb = <T>(read: (db: Database.Database) => T): T => {
  const db = new Database(path.join(dataRoot, 'app.sqlite'));
  try { return read(db); } finally { db.close(); }
};
const mutate = (user: Principal, method: string, route: string, body?: unknown) =>
  daemon.request({ method, path: route, cookie: user.cookie, headers: { origin: MU_TEST_ORIGIN }, ...(body === undefined ? {} : { body }) });
async function setKey(apiKey: string | null) {
  const current = await daemon.request({ path: '/api/connectors/composio/config', cookie: admin.cookie });
  const res = await mutate(admin, 'PUT', '/api/connectors/composio/config', { revision: current.json.revision, apiKey });
  expect(res.status, res.text).toBe(200);
}
async function newUser(): Promise<Principal> {
  const username = `race-${Math.random().toString(36).slice(2, 10)}`;
  const password = `${username}-password-battery-staple`;
  const created = await mutate(admin, 'POST', '/api/auth/users', { username, password, role: 'user' });
  expect(created.status, created.text).toBe(201);
  return { id: created.json.account.id, username, password, cookie: await login(daemon, username, password) };
}
async function start(user: Principal, connector = 'github') {
  const res = await mutate(user, 'POST', `/api/connectors/${connector}/connect`, {});
  expect(res.status, res.text).toBe(200);
  return [...accounts.values()].at(-1)!;
}
function callback(account: FakeAccount) {
  const url = new URL(account.callback);
  return daemon.request({ path: `${url.pathname}${url.search}&status=success` });
}
async function connected(user: Principal, connector = 'github') {
  const account = await start(user, connector);
  expect((await callback(account)).status).toBe(200);
  return account;
}
const row = (user: Principal, connector = 'github') => appDb((db) => db.prepare(
  'SELECT status, provider_connection_id FROM studio_connector_connections WHERE owner_account_id = ? AND connector_id = ?').get(user.id, connector)) as
  { status: string; provider_connection_id: string | null } | undefined;
const pendingStates = (user: Principal) => appDb((db) => (db.prepare(
  'SELECT COUNT(*) AS n FROM studio_connector_states WHERE owner_account_id = ? AND used_at IS NULL AND cancelled IS NULL').get(user.id) as { n: number }).n);
const detailStatus = async (user: Principal, connector = 'github') =>
  (await daemon.request({ path: `/api/connectors/${connector}`, cookie: user.cookie })).json?.connector?.status;
function expectAuthorityRefusal(res: { status: number; json: any; text: string }, reason: string) {
  expect(res.status, res.text).toBe(409);
  expect(res.json?.error, res.text).toMatchObject({ code: 'MULTIUSER_CONNECTOR_AUTHORITY_CHANGED', details: { reason } });
}

beforeAll(async () => {
  delete process.env.OD_API_TOKEN;
  delete process.env.OD_DISABLE_API_AUTH;
  ({ dataRoot } = await loadIsolatedServerModule());
  daemon = await startMultiUserDaemon(multiUserOptions({ testComposioFetch: composio, poolClock: () => clock }));
  ({ admin } = await provisionAccounts(daemon, []));
  await setKey(KEY_ONE);
}, 120_000);
beforeEach(async () => {
  barrier = null; clock = Date.now();
  // Every case starts from the company key KEY_ONE, whatever an earlier case left behind.
  const current = await daemon.request({ path: '/api/connectors/composio/config', cookie: admin.cookie });
  if (!current.json.configured || current.json.apiKeyTail !== KEY_ONE.slice(-4)) await setKey(KEY_ONE);
  calls = [];
});
afterAll(async () => { await daemon?.close(); cleanupIsolatedDataRoot(); });

describe('disconnect re-establishes authority before the provider DELETE and before the local change', () => {
  it.each([
    ['session revoke', 'session'],
    ['account disable', 'account'],
    ['key clear', 'key-changed'],
    ['key rotate', 'key-changed'],
  ])('after %s while the provider check is in flight: no DELETE, no local change, typed refusal', async (change, reason) => {
    const user = await newUser();
    const account = await connected(user);
    const held = hold(isGetAccount);
    const pending = mutate(user, 'DELETE', '/api/connectors/github/connection');
    await reached(held, pending);
    if (change === 'session revoke') expect((await mutate(admin, 'POST', `/api/auth/users/${user.id}/sessions/revoke`, {})).status).toBe(200);
    if (change === 'account disable') expect((await mutate(admin, 'PATCH', `/api/auth/users/${user.id}`, { active: false })).status).toBe(200);
    if (change === 'key clear') await setKey(null);
    if (change === 'key rotate') await setKey(KEY_TWO);
    const before = calls.length;
    held.release();
    const res = await pending;
    expect(calls.slice(before).filter((call) => call.method === 'DELETE')).toEqual([]);
    expect(accounts.has(account.id)).toBe(true);
    expectAuthorityRefusal(res, reason);
    expect(row(user)).toEqual({ status: 'connected', provider_connection_id: account.id });
  });

  it('a concurrent disconnect of the same connection deletes the provider account once', async () => {
    const user = await newUser();
    const account = await connected(user);
    const held = hold(isGetAccount);
    const first = mutate(user, 'DELETE', '/api/connectors/github/connection');
    await reached(held, first);
    const second = await mutate(user, 'DELETE', '/api/connectors/github/connection');
    expect(second.status, second.text).toBe(200);
    const before = calls.length;
    held.release();
    const res = await first;
    expect(calls.slice(before).filter((call) => call.method === 'DELETE')).toEqual([]);
    expect(calls.filter((call) => call.method === 'DELETE').map((call) => call.path)).toEqual([`/api/v3/connected_accounts/${account.id}`]);
    expectAuthorityRefusal(res, 'connection-changed');
    expect(row(user)).toEqual({ status: 'disconnected', provider_connection_id: null });
  });
});

describe('connect re-establishes authority before every provider write and local binding', () => {
  it('a key cleared while the auth config is resolved creates no auth config, no link and no state', async () => {
    const user = await newUser();
    const held = hold(isAuthConfigList);
    const pending = mutate(user, 'POST', '/api/connectors/notion/connect', {});
    await reached(held, pending);
    await setKey(null);
    const before = calls.length;
    held.release();
    const res = await pending;
    expect(calls.slice(before)).toEqual([]);
    expectAuthorityRefusal(res, 'key-changed');
    expect(pendingStates(user)).toBe(0);
    expect(appDb((db) => db.prepare("SELECT COUNT(*) AS n FROM studio_connector_auth_configs WHERE connector_id = 'notion'").get())).toEqual({ n: 0 });
  });

  it('a session revoked while the auth config is resolved starts no link', async () => {
    const user = await newUser();
    const held = hold(isAuthConfigList);
    const pending = mutate(user, 'POST', '/api/connectors/slack/connect', {});
    await reached(held, pending);
    expect((await mutate(admin, 'POST', `/api/auth/users/${user.id}/sessions/revoke`, {})).status).toBe(200);
    const before = calls.length;
    held.release();
    const res = await pending;
    expect(calls.slice(before)).toEqual([]);
    expectAuthorityRefusal(res, 'session');
    expect(pendingStates(user)).toBe(0);
  });

  it('a session revoked while the link is created keeps nothing pending and answers a typed refusal', async () => {
    const user = await newUser();
    const held = hold(isLink);
    const pending = mutate(user, 'POST', '/api/connectors/github/connect', {});
    await reached(held, pending);
    expect((await mutate(admin, 'POST', `/api/auth/users/${user.id}/sessions/revoke`, {})).status).toBe(200);
    held.release();
    const res = await pending;
    expectAuthorityRefusal(res, 'session');
    expect(pendingStates(user)).toBe(0);
  });

  it('prepare creates no auth config after the key is cleared mid-resolution', async () => {
    const user = await newUser();
    const held = hold(isAuthConfigList);
    const pending = mutate(user, 'POST', '/api/connectors/auth-configs/prepare', { connectorIds: ['notion'] });
    await reached(held, pending);
    await setKey(null);
    const before = calls.length;
    held.release();
    const res = await pending;
    expect(calls.slice(before)).toEqual([]);
    expectAuthorityRefusal(res, 'key-changed');
  });
});

describe('OAuth callback completion', () => {
  it('a successful cancel means the in-flight callback can never complete', async () => {
    const user = await newUser();
    const account = await start(user);
    const held = hold(isGetAccount);
    const completing = callback(account);
    await reached(held, completing);
    const cancelled = await mutate(user, 'POST', '/api/connectors/github/authorization/cancel', {});
    expect(cancelled.status, cancelled.text).toBe(200);
    held.release();
    const res = await completing;
    expect(res.json?.error, res.text).toMatchObject({ code: 'MULTIUSER_CONNECTOR_AUTHORIZATION_INVALID', details: { reason: 'state' } });
    expect(row(user)).toBeUndefined();
    expect(await detailStatus(user)).toBe('available');
  });

  it('a state that expires while the provider verifies is refused', async () => {
    const user = await newUser();
    const account = await start(user);
    clock += 599_000;
    const held = hold(isGetAccount);
    const completing = callback(account);
    await reached(held, completing);
    clock += 2_000;
    held.release();
    const res = await completing;
    expect(res.json?.error, res.text).toMatchObject({ code: 'MULTIUSER_CONNECTOR_AUTHORIZATION_INVALID', details: { reason: 'expired' } });
    expect(row(user)).toBeUndefined();
  });

  it('a session revoked while the provider verifies records no connection', async () => {
    const user = await newUser();
    const account = await start(user);
    const held = hold(isGetAccount);
    const completing = callback(account);
    await reached(held, completing);
    expect((await mutate(admin, 'POST', `/api/auth/users/${user.id}/sessions/revoke`, {})).status).toBe(200);
    held.release();
    const res = await completing;
    expect(res.json?.error, res.text).toMatchObject({ code: 'MULTIUSER_CONNECTOR_AUTHORIZATION_INVALID', details: { reason: 'session' } });
    expect(row(user)).toBeUndefined();
  });

  it('the same state delivered twice concurrently completes at most once', async () => {
    const user = await newUser();
    const account = await start(user);
    const held = hold(isGetAccount);
    const first = callback(account);
    await reached(held, first);
    const second = await callback(account);
    held.release();
    expect((await first).status).toBe(200);
    expect(second.json?.error).toMatchObject({ code: 'MULTIUSER_CONNECTOR_AUTHORIZATION_INVALID', details: { reason: 'replayed' } });
    expect(row(user)).toEqual({ status: 'connected', provider_connection_id: account.id });
  });
});
