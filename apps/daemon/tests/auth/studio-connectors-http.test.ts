// S58 (#62): account connectors control plane. A company Composio key only
// administrators set, rotate or clear; each account connects its own apps with
// its own server-derived Composio entity; OAuth callbacks bind identity from a
// single-use server-side state. Composio is a recorded in-process fake.
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanupIsolatedDataRoot, loadIsolatedServerModule, login, multiUserOptions, provisionAccounts,
  startMultiUserDaemon, MU_TEST_ORIGIN, type Principal, type StartedMultiUserDaemon,
} from './multiuser-harness.js';

const KEY_ONE = 'ak_company_composio_key_ONE_1111';
const KEY_TWO = 'ak_company_composio_key_TWO_2222';
const HOST_USER_ID = 'open-design-local-user';

interface Call { method: string; url: URL; apiKey: string | null; redirect: RequestInit['redirect']; body: Record<string, unknown> | null }
interface FakeAccount { id: string; userId: string; authConfigId: string; toolkit: string; status: string; email: string }
let calls: Call[] = [];
let accounts = new Map<string, FakeAccount>();
let nextAccount = 1;
let rejectKeys = new Set<string>();
const keyTag = (key: string | null) => key === KEY_ONE ? 'one' : key === KEY_TWO ? 'two' : 'other';
const composio: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const headers = new Headers(init?.headers);
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null;
  const apiKey = headers.get('x-api-key');
  calls.push({ method: init?.method ?? 'GET', url, apiKey, redirect: init?.redirect, body });
  if (url.origin !== 'https://backend.composio.dev') return new Response('{}', { status: 599 });
  if (apiKey && rejectKeys.has(apiKey)) return new Response('{"error":"bad key SECRET_PROVIDER_BODY"}', { status: 401 });
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
  if (url.pathname === '/api/v3/auth_configs' && init?.method === 'GET') {
    const slug = url.searchParams.get('toolkit_slug') ?? '';
    return json({ items: slug === 'notion' ? [] : [{ id: `ac_${keyTag(apiKey)}_${slug}`, toolkit: { slug }, status: 'ENABLED' }] });
  }
  if (url.pathname === '/api/v3.1/auth_configs' && init?.method === 'POST') {
    const slug = String((body?.toolkit as { slug?: string } | undefined)?.slug);
    return json({ id: `ac_created_${keyTag(apiKey)}_${slug}`, toolkit: { slug } }, 201);
  }
  if (url.pathname === '/api/v3.1/connected_accounts/link' && init?.method === 'POST') {
    const id = `ca_${nextAccount++}`;
    const authConfigId = String(body?.auth_config_id);
    accounts.set(id, { id, userId: String(body?.user_id), authConfigId, toolkit: authConfigId.split('_').pop()!, status: 'INITIATED', email: `${id}@apps.example` });
    return json({ id, redirect_url: `https://backend.composio.dev/oauth/start/${randomUUID()}`, status: 'INITIATED' });
  }
  const match = /^\/api\/v3\/connected_accounts\/([^/]+)$/.exec(url.pathname);
  if (match) {
    const account = accounts.get(decodeURIComponent(match[1]!));
    if (!account) return json({ error: 'missing' }, 404);
    if (init?.method === 'DELETE') { accounts.delete(account.id); return json({}); }
    return json({ id: account.id, user_id: account.userId, auth_config: { id: account.authConfigId }, toolkit: { slug: account.toolkit },
      status: account.status, email: account.email });
  }
  return json({ error: 'unexpected' }, 400);
};

let daemon: StartedMultiUserDaemon;
let dataRoot: string;
let admin: Principal;
let alice: Principal;
let bob: Principal;
let carol: Principal;
let clock = Date.now();
const logs: string[] = [];

const appDb = <T>(read: (db: Database.Database) => T): T => {
  const db = new Database(path.join(dataRoot, 'app.sqlite'));
  try { return read(db); } finally { db.close(); }
};
const config = (user: Principal) => daemon.request({ path: '/api/connectors/composio/config', cookie: user.cookie });
const setKey = (user: Principal, body: unknown) => daemon.request({ method: 'PUT', path: '/api/connectors/composio/config', cookie: user.cookie,
  headers: { origin: MU_TEST_ORIGIN }, body });
async function configureKey(apiKey: string | null) {
  const current = await config(admin);
  const res = await setKey(admin, { revision: current.json.revision, apiKey });
  expect(res.status, res.text).toBe(200);
  return res.json;
}
const connect = (user: Principal, id = 'github') => daemon.request({ method: 'POST', path: `/api/connectors/${id}/connect`, cookie: user.cookie,
  headers: { origin: MU_TEST_ORIGIN }, body: {} });
const detail = (user: Principal, id = 'github') => daemon.request({ path: `/api/connectors/${id}`, cookie: user.cookie });
const disconnect = (user: Principal, id = 'github') => daemon.request({ method: 'DELETE', path: `/api/connectors/${id}/connection`, cookie: user.cookie,
  headers: { origin: MU_TEST_ORIGIN } });
/** Start a connect and return the state the server put in the callback it handed to Composio. */
async function start(user: Principal, id = 'github') {
  const before = calls.length;
  const res = await connect(user, id);
  expect(res.status, res.text).toBe(200);
  expect(res.json.auth).toMatchObject({ kind: 'redirect_required', redirectUrl: expect.stringMatching(/^https:\/\/backend\.composio\.dev\//) });
  const link = calls.slice(before).find((call) => call.url.pathname === '/api/v3.1/connected_accounts/link')!;
  const callback = new URL(String(link.body!.callback_url));
  const providerId = [...accounts.keys()].at(-1)!;
  return { res, link, callback, providerId, entity: String(link.body!.user_id) };
}
/** Composio redirects the browser back: no session cookie travels on this cross-site navigation. */
function callback(started: { callback: URL; providerId: string }, extra: Record<string, string> = { status: 'success' }, cookie?: string) {
  const url = new URL(started.callback);
  for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, value);
  return daemon.request({ path: `${url.pathname}${url.search}`, ...(cookie ? { cookie } : {}) });
}
const authorize = (providerId: string) => { accounts.get(providerId)!.status = 'ACTIVE'; };
const connections = () => appDb((db) => db.prepare("SELECT owner_account_id, connector_id, status FROM studio_connector_connections WHERE status = 'connected' ORDER BY owner_account_id").all());

beforeAll(async () => {
  delete process.env.OD_API_TOKEN;
  delete process.env.OD_DISABLE_API_AUTH;
  ({ dataRoot } = await loadIsolatedServerModule());
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const original = console[level].bind(console);
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logs.push(args.map((arg) => typeof arg === 'string' ? arg : JSON.stringify(arg) ?? String(arg)).join(' ')); void original; });
  }
  daemon = await startMultiUserDaemon(multiUserOptions({ testComposioFetch: composio, poolClock: () => clock }));
  const provisioned = await provisionAccounts(daemon, ['conn-alice', 'conn-bob', 'conn-carol']);
  admin = provisioned.admin;
  [alice, bob, carol] = provisioned.users as [Principal, Principal, Principal];
}, 120_000);

beforeEach(() => { calls = []; rejectKeys = new Set(); clock = Date.now(); });
afterEach(() => {
  // No request to Composio may ever carry the host user, an account id or another project's key.
  for (const call of calls) {
    expect(call.redirect).toBe('error');
    expect(JSON.stringify(call.body ?? {})).not.toContain(HOST_USER_ID);
    for (const user of [admin, alice, bob, carol]) {
      expect(JSON.stringify(call.body ?? {})).not.toContain(user.id);
      expect(call.url.href).not.toContain(user.id);
    }
  }
});
afterAll(async () => { await daemon?.close(); vi.restoreAllMocks(); cleanupIsolatedDataRoot(); });

describe('company Composio key', () => {
  it('only an administrator sets, rotates and clears it; no response, log, audit or row carries it', async () => {
    const initial = await config(alice);
    expect(initial.status, initial.text).toBe(200);
    expect(initial.json).toEqual({ configured: false, apiKeyTail: '', revision: 0, credentialRevision: 0, canManage: false });
    for (const path of ['/api/connectors/composio/config', '/api/multiuser/connectors/company-key']) {
      const refused = await daemon.request({ method: 'PUT', path, cookie: alice.cookie, headers: { origin: MU_TEST_ORIGIN }, body: { revision: 0, apiKey: KEY_ONE } });
      expect(refused.status, refused.text).toBe(403);
      expect(refused.json.error.code).toBe('FORBIDDEN');
    }
    expect((await setKey(admin, { apiKey: KEY_ONE })).status).toBe(400);
    expect((await setKey(admin, { revision: 0, apiKey: KEY_ONE, authConfigIds: {} })).status).toBe(400);
    const saved = await setKey(admin, { revision: 0, apiKey: KEY_ONE });
    expect(saved.status, saved.text).toBe(200);
    expect(saved.json).toEqual({ configured: true, apiKeyTail: '1111', revision: 1, credentialRevision: 1, canManage: true });
    expect((await config(admin)).json.apiKeyTail).toBe('1111');
    expect((await config(alice)).json).toEqual({ configured: true, apiKeyTail: '', revision: 1, credentialRevision: 1, canManage: false });
    const stale = await setKey(admin, { revision: 0, apiKey: KEY_TWO });
    expect(stale.status).toBe(409);
    const rotated = await setKey(admin, { revision: 1, apiKey: KEY_TWO });
    expect(rotated.json).toMatchObject({ configured: true, apiKeyTail: '2222', credentialRevision: 2 });
    const cleared = await setKey(admin, { revision: 2, apiKey: null });
    expect(cleared.json).toMatchObject({ configured: false, apiKeyTail: '', credentialRevision: 3 });
    for (const text of [initial.text, saved.text, rotated.text, cleared.text, stale.text]) {
      expect(text).not.toContain(KEY_ONE); expect(text).not.toContain(KEY_TWO);
    }
    const rows = appDb((db) => ({
      config: db.prepare('SELECT * FROM company_composio_config').all(),
      audit: db.prepare('SELECT action, revision, credential_revision FROM company_composio_audit ORDER BY id').all(),
      events: db.prepare('SELECT action, outcome FROM studio_connector_audit ORDER BY id').all(),
    }));
    expect(rows.audit).toEqual([{ action: 'set', revision: 1, credential_revision: 1 }, { action: 'rotate', revision: 2, credential_revision: 2 },
      { action: 'clear', revision: 3, credential_revision: 3 }]);
    expect(rows.events).toEqual([{ action: 'company_key_set', outcome: 'ok' }, { action: 'company_key_rotate', outcome: 'ok' }, { action: 'company_key_clear', outcome: 'ok' }]);
    const raw = JSON.stringify(rows) + readFileSync(path.join(dataRoot, 'app.sqlite')).toString('latin1') + logs.join('\n');
    expect(raw).not.toContain(KEY_ONE); expect(raw).not.toContain(KEY_TWO);
    // The desktop host config path never ran for a cookie actor.
    expect(existsSync(path.join(dataRoot, 'connectors', 'composio-config.json'))).toBe(false);
    expect(calls).toEqual([]);
  });

  it('without a company key the catalog shows the unavailable state and connect is refused before any provider call', async () => {
    expect((await config(carol)).json.configured).toBe(false);
    const list = await daemon.request({ path: '/api/connectors', cookie: carol.cookie });
    expect(list.status, list.text).toBe(200);
    expect(list.json.connectors.length).toBeGreaterThan(0);
    for (const connector of list.json.connectors) expect(connector).toMatchObject({ status: 'available', auth: { provider: 'composio', configured: false } });
    const refused = await connect(carol);
    expect(refused.status).toBe(409);
    expect(refused.json.error.code).toBe('MULTIUSER_CONNECTORS_NOT_CONFIGURED');
    const prepare = await daemon.request({ method: 'POST', path: '/api/connectors/auth-configs/prepare', cookie: carol.cookie,
      headers: { origin: MU_TEST_ORIGIN }, body: { connectorIds: ['github'] } });
    expect(prepare.json.error.code).toBe('MULTIUSER_CONNECTORS_NOT_CONFIGURED');
    expect(calls).toEqual([]);
  });
});

describe('per-account connections', () => {
  it('A connects on its own entity; B and the admin see none of it and cannot disconnect it', async () => {
    await configureKey(KEY_ONE);
    const prepared = await daemon.request({ method: 'POST', path: '/api/connectors/auth-configs/prepare', cookie: alice.cookie,
      headers: { origin: MU_TEST_ORIGIN }, body: { connectorIds: ['github'] } });
    expect(prepared.json).toEqual({ results: { github: { status: 'ready', authConfigId: 'ac_one_github' } } });
    const a = await start(alice);
    expect(a.entity).toMatch(/^od-acct-[0-9a-f]{32}$/);
    expect(a.link.apiKey).toBe(KEY_ONE);
    expect(a.callback.origin + a.callback.pathname).toBe(`${MU_TEST_ORIGIN}/api/connectors/oauth/callback/github`);
    expect(a.res.text).not.toContain(a.providerId);
    expect(a.res.text).not.toContain(a.entity);
    authorize(a.providerId);
    const done = await callback(a);
    expect(done.status, done.text).toBe(200);
    expect(done.headers['content-type']).toContain('text/html');
    expect(done.text).not.toContain(a.providerId);
    const own = await detail(alice);
    expect(own.json.connector).toMatchObject({ id: 'github', status: 'connected', accountLabel: `${a.providerId}@apps.example` });

    // B and the admin read their own (unconnected) view, identical to an account that never connected.
    const bobView = await detail(bob); const adminView = await detail(admin); const carolView = await detail(carol);
    expect(bobView.json).toEqual(carolView.json); expect(adminView.json).toEqual(carolView.json);
    expect(bobView.json.connector.status).toBe('available');
    for (const user of [bob, admin]) {
      for (const route of ['/api/connectors', '/api/connectors/status', '/api/connectors/discovery', '/api/connectors/github']) {
        const text = (await daemon.request({ path: route, cookie: user.cookie })).text;
        expect(text).not.toContain(a.providerId); expect(text).not.toContain(a.entity);
      }
    }
    // Disconnecting A's connector is the same refusal as one never connected or an unknown connector.
    const missing = await disconnect(carol, 'nope');
    for (const user of [bob, admin, carol]) {
      const refused = await disconnect(user);
      expect(refused.status).toBe(404);
      expect(refused.json).toEqual(missing.json);
    }
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
    expect((await detail(alice)).json.connector.status).toBe('connected');

    // B connects the same app on a different, stable entity; A's entity is stable too.
    const b = await start(bob);
    expect(b.entity).toMatch(/^od-acct-[0-9a-f]{32}$/);
    expect(b.entity).not.toBe(a.entity);
    const a2 = await start(alice);
    expect(a2.entity).toBe(a.entity);
    // A's state cannot bind B's provider account (and vice versa).
    authorize(b.providerId);
    const crossed = await callback(a2, { status: 'success', connected_account_id: b.providerId });
    expect(crossed.status).toBe(403);
    expect(crossed.json.error).toMatchObject({ code: 'MULTIUSER_CONNECTOR_AUTHORIZATION_INVALID', details: { reason: 'provider' } });
    expect((await callback(b)).status).toBe(200);
    expect(connections()).toEqual([alice.id, bob.id].sort().map((owner) => ({ owner_account_id: owner, connector_id: 'github', status: 'connected' })));

    // A provider account claiming another entity (or the host user) is refused.
    const a3 = await start(alice, 'slack');
    authorize(a3.providerId); accounts.get(a3.providerId)!.userId = HOST_USER_ID;
    const forged = await callback(a3);
    expect(forged.json.error.details.reason).toBe('provider');
    expect((await detail(alice, 'slack')).json.connector.status).toBe('available');

    // A disconnects its own: the provider deletes exactly A's account on A's entity.
    const before = calls.length;
    const gone = await disconnect(alice);
    expect(gone.status, gone.text).toBe(200);
    expect(gone.json.connector.status).toBe('available');
    const deletes = calls.slice(before).filter((call) => call.method === 'DELETE');
    expect(deletes.map((call) => call.url.pathname)).toEqual([`/api/v3/connected_accounts/${a.providerId}`]);
    expect(accounts.has(b.providerId)).toBe(true);
    expect((await detail(bob)).json.connector.status).toBe('connected');
    expect(appDb((db) => db.prepare('SELECT status FROM studio_connector_connections WHERE owner_account_id = ? AND connector_id = ?').get(alice.id, 'github')))
      .toEqual({ status: 'disconnected' });
    expect(appDb((db) => db.prepare("SELECT action, outcome FROM studio_connector_audit WHERE actor_account_id = ? AND action = 'disconnect'").all(alice.id)))
      .toEqual([{ action: 'disconnect', outcome: 'provider' }]);
    await disconnect(bob);
  });
});

describe('OAuth callback binding', () => {
  const refusedFor = async (response: Promise<{ status: number; json: any; text: string }>, reason: string) => {
    const res = await response;
    expect(res.json?.error, res.text).toMatchObject({ code: 'MULTIUSER_CONNECTOR_AUTHORIZATION_INVALID', details: { reason } });
  };
  beforeEach(async () => { if (!(await config(admin)).json.configured) await configureKey(KEY_ONE); });

  it('refuses unknown, malformed, replayed, mismatched, expired and incomplete states without recording anything', async () => {
    const started = await start(carol);
    authorize(started.providerId);
    await refusedFor(daemon.request({ path: `/api/connectors/oauth/callback/github?state=${'A'.repeat(43)}&status=success` }), 'state');
    await refusedFor(daemon.request({ path: '/api/connectors/oauth/callback/github?state=short' }), 'state');
    await refusedFor(daemon.request({ path: `/api/connectors/oauth/callback/notion${started.callback.search}&status=success` }), 'state');
    // A wrong-connector attempt does not burn the state; the right callback still completes once.
    expect((await callback(started)).status).toBe(200);
    await refusedFor(callback(started), 'replayed');
    const failed = await start(carol, 'notion');
    await refusedFor(callback(failed, { status: 'failed' }), 'not-completed');
    await refusedFor(callback(failed), 'replayed');
    const late = await start(carol, 'slack');
    authorize(late.providerId);
    clock += 11 * 60 * 1000;
    await refusedFor(callback(late), 'expired');
    expect(connections().filter((row: any) => row.owner_account_id === carol.id)).toEqual([{ owner_account_id: carol.id, connector_id: 'github', status: 'connected' }]);
    await disconnect(carol);
  });

  it.each([
    ['logout', 'session'], ['session rotation', 'session'], ['admin session revoke', 'session'], ['password reset', 'session'],
    ['account disabled', 'session'], ['pilot change', 'session'], ['key rotated', 'key-changed'], ['key cleared', 'key-changed'],
  ])('refuses a callback after %s and records no connection for anyone', async (change, reason) => {
    const username = `conn-${randomUUID().slice(0, 8)}`;
    const password = `${username}-password-battery-staple`;
    const created = await daemon.request({ method: 'POST', path: '/api/auth/users', cookie: admin.cookie, headers: { origin: MU_TEST_ORIGIN },
      body: { username, password, role: 'user' } });
    expect(created.status, created.text).toBe(201);
    const user: Principal = { id: created.json.account.id, username, password, cookie: await login(daemon, username, password) };
    const started = await start(user);
    authorize(started.providerId);
    const asAdmin = (method: string, route: string, body?: unknown) =>
      daemon.request({ method, path: route, cookie: admin.cookie, headers: { origin: MU_TEST_ORIGIN }, ...(body === undefined ? {} : { body }) });
    if (change === 'logout') await daemon.request({ method: 'POST', path: '/api/auth/logout', cookie: user.cookie, headers: { origin: MU_TEST_ORIGIN }, body: {} });
    if (change === 'session rotation') expect((await daemon.request({ method: 'POST', path: '/api/auth/session/rotate', cookie: user.cookie,
      headers: { origin: MU_TEST_ORIGIN }, body: {} })).status).toBe(200);
    if (change === 'admin session revoke') expect((await asAdmin('POST', `/api/auth/users/${user.id}/sessions/revoke`, {})).status).toBe(200);
    if (change === 'password reset') expect((await asAdmin('POST', `/api/auth/users/${user.id}/password`, { password: `${password}-reset` })).status).toBe(204);
    if (change === 'account disabled') expect((await asAdmin('PATCH', `/api/auth/users/${user.id}`, { active: false })).status).toBe(200);
    if (change === 'pilot change') {
      const pilot = await asAdmin('GET', `/api/admin/users/${user.id}/studio-pilot`);
      expect((await asAdmin('PUT', `/api/admin/users/${user.id}/studio-pilot`, { studioPilot: false, revision: pilot.json.revision })).status).toBe(200);
    }
    if (change === 'key rotated') await configureKey(KEY_TWO);
    if (change === 'key cleared') await configureKey(null);
    // Another account signed in on the same browser gains nothing from the old state.
    const res = await callback(started, { status: 'success' }, bob.cookie);
    expect(res.json?.error, res.text).toMatchObject({ code: 'MULTIUSER_CONNECTOR_AUTHORIZATION_INVALID' });
    if (['logout', 'session rotation', 'pilot change', 'account disabled', 'key rotated', 'key cleared'].includes(change)) expect(res.json.error.details.reason).toBe(reason);
    else expect(['session', 'replayed']).toContain(res.json.error.details.reason);
    expect(connections().filter((row: any) => row.owner_account_id === user.id || row.owner_account_id === bob.id)).toEqual([]);
    if (change.startsWith('key')) await configureKey(KEY_ONE);
  });
});

describe('lifecycle', () => {
  it('rotating or clearing the key marks connections for re-check without deleting them or binding another project', async () => {
    await configureKey(KEY_ONE);
    const a = await start(alice, 'notion');
    expect(calls.some((call) => call.url.pathname === '/api/v3.1/auth_configs' && call.method === 'POST')).toBe(true);
    authorize(a.providerId);
    expect((await callback(a)).status).toBe(200);
    expect((await detail(alice, 'notion')).json.connector.status).toBe('connected');
    await configureKey(KEY_TWO);
    const recheck = (await detail(alice, 'notion')).json.connector;
    expect(recheck).toMatchObject({ status: 'error', lastError: 'MULTIUSER_CONNECTOR_RECHECK_REQUIRED' });
    await configureKey(null);
    expect((await detail(alice, 'notion')).json.connector).toMatchObject({ status: 'error', lastError: 'MULTIUSER_CONNECTOR_RECHECK_REQUIRED', auth: { configured: false } });
    await configureKey(KEY_ONE);
    expect((await detail(alice, 'notion')).json.connector.status).toBe('error');
    // Disconnecting a connection made under another key is local only: no other project is called.
    const before = calls.length;
    expect((await disconnect(alice, 'notion')).status).toBe(200);
    expect(calls.slice(before)).toEqual([]);
    expect(accounts.has(a.providerId)).toBe(true);
    // Reconnecting uses the current key's own auth config.
    const again = await start(alice, 'notion');
    expect(again.link.apiKey).toBe(KEY_ONE);
    expect(again.link.body!.auth_config_id).toBe('ac_created_one_notion');
    authorize(again.providerId);
    expect((await callback(again)).status).toBe(200);
    expect((await detail(alice, 'notion')).json.connector.status).toBe('connected');
    await disconnect(alice, 'notion');
  });

  it('disabling an account keeps its connection history and makes it unusable until it is active again', async () => {
    await configureKey(KEY_ONE);
    const username = `conn-${randomUUID().slice(0, 8)}`; const password = `${username}-password-battery-staple`;
    const created = await daemon.request({ method: 'POST', path: '/api/auth/users', cookie: admin.cookie, headers: { origin: MU_TEST_ORIGIN }, body: { username, password, role: 'user' } });
    const user: Principal = { id: created.json.account.id, username, password, cookie: await login(daemon, username, password) };
    const a = await start(user);
    authorize(a.providerId);
    expect((await callback(a)).status).toBe(200);
    const pending = await start(user, 'slack');
    authorize(pending.providerId);
    expect((await daemon.request({ method: 'PATCH', path: `/api/auth/users/${user.id}`, cookie: admin.cookie, headers: { origin: MU_TEST_ORIGIN }, body: { active: false } })).status).toBe(200);
    expect((await detail(user)).status).toBe(401);
    expect((await callback(pending)).json.error.code).toBe('MULTIUSER_CONNECTOR_AUTHORIZATION_INVALID');
    expect(connections().filter((row: any) => row.owner_account_id === user.id)).toEqual([{ owner_account_id: user.id, connector_id: 'github', status: 'connected' }]);
    expect((await daemon.request({ method: 'PATCH', path: `/api/auth/users/${user.id}`, cookie: admin.cookie, headers: { origin: MU_TEST_ORIGIN }, body: { active: true } })).status).toBe(200);
    user.cookie = await login(daemon, username, password);
    expect((await detail(user)).json.connector.status).toBe('connected');
    expect((await detail(user, 'slack')).json.connector.status).toBe('available');
  });

  it('a rejected company key is a typed provider failure that never echoes the provider body', async () => {
    await configureKey(KEY_ONE);
    rejectKeys.add(KEY_ONE);
    const res = await connect(carol, 'linear');
    expect(res.status).toBe(502);
    expect(res.json.error.code).toBe('MULTIUSER_CONNECTOR_PROVIDER_FAILED');
    expect(res.text).not.toContain('SECRET_PROVIDER_BODY');
    expect(logs.join('\n')).not.toContain('SECRET_PROVIDER_BODY');
    expect(appDb((db) => db.prepare('SELECT COUNT(*) AS n FROM studio_connector_states WHERE owner_account_id = ? AND used_at IS NULL').get(carol.id))).toEqual({ n: 0 });
  });
});

describe('run-time use stays refused (S59)', () => {
  it.each([
    ['GET', '/api/tools/connectors/list'], ['POST', '/api/tools/connectors/execute'],
    ['POST', '/api/memory/connectors/suggest'], ['POST', '/api/memory/connectors/extract'], ['GET', '/api/connectors/logos/github'],
  ])('%s %s is a typed connectors capability refusal', async (method, route) => {
    const res = await daemon.request({ method, path: route, cookie: alice.cookie, headers: { origin: MU_TEST_ORIGIN }, ...(method === 'POST' ? { body: {} } : {}) });
    expect(res.status).toBe(403);
    expect(res.json.error).toMatchObject({ code: 'MULTIUSER_CAPABILITY_UNAVAILABLE', details: { capability: 'connectors' } });
    if (!route.includes('logos')) expect(res.json.error.details.reason).toContain('not yet usable in runs');
  });

  it('run admission, routines and Live Artifact connector sources say connectors are connectable but not usable yet', async () => {
    const project = await daemon.request({ method: 'POST', path: '/api/projects', cookie: alice.cookie, headers: { origin: MU_TEST_ORIGIN }, body: { id: randomUUID(), name: 'connectors' } });
    expect(project.status, project.text).toBe(200);
    const run = await daemon.request({ method: 'POST', path: '/api/runs', cookie: alice.cookie, headers: { origin: MU_TEST_ORIGIN }, body: {
      projectId: project.json.project.id, conversationId: project.json.conversationId, agentId: 'codex', executionSource: 'personal_subscription',
      message: 'hello', context: { connectorIds: ['github'] } } });
    expect(run.status, run.text).toBe(403);
    expect(run.json.error.code).toBe('MULTIUSER_CAPABILITY_UNAVAILABLE');
    expect(run.json.error.message).toContain('not yet usable in runs');
    const routine = await daemon.request({ method: 'POST', path: '/api/routines', cookie: alice.cookie, headers: { origin: MU_TEST_ORIGIN }, body: {
      name: 'r', prompt: 'p', schedule: { kind: 'daily', time: '09:00', timezone: 'UTC' }, target: { mode: 'create_each_run' }, context: { connectorIds: ['github'] } } });
    expect(routine.status, routine.text).toBe(403);
    expect(routine.json.error.code).toBe('MULTIUSER_CAPABILITY_UNAVAILABLE');
    expect(routine.json.error.message).toContain('not yet usable in runs');
  });
});

it('keeps the account-connector tables free of entities in responses and the audit free of values', () => {
  const audit = appDb((db) => db.prepare('SELECT * FROM studio_connector_audit').all()) as Array<Record<string, unknown>>;
  expect(audit.length).toBeGreaterThan(0);
  const text = JSON.stringify(audit);
  expect(text).not.toMatch(/od-acct-|ca_\d|ak_company/);
  expect(readdirSync(dataRoot)).not.toContain('connectors');
});
