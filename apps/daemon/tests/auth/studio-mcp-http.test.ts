// S60 (#62, owner decision 2A): account remote MCP servers on multi-user Web.
// stdio is refused everywhere; each account owns its remote servers (sealed
// header values and OAuth tokens, redacted reads, same-404 isolation, no admin
// bypass); every outbound request is SSRF-guarded; OAuth state is single-use
// and bound to account, session and server; run-time use stays refused.
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { STUDIO_MCP_LIMITS, STUDIO_MCP_NOT_IN_RUNS_REASON, STUDIO_MCP_STDIO_UNAVAILABLE_REASON } from '@open-design/contracts';
import { until } from './personal-codex-helpers.js';
import {
  cleanupIsolatedDataRoot, loadIsolatedServerModule, login, multiUserOptions, provisionAccounts, startMultiUserDaemon,
  MU_TEST_ORIGIN, type Principal, type StartedMultiUserDaemon,
} from './multiuser-harness.js';
import { MCP_CLIENT_SECRET_SENTINEL, MCP_HEADER_SENTINEL, MCP_REFRESH_SENTINEL, MCP_TOKEN_SENTINEL, startMcpFixture, type McpFixture } from './studio-mcp-fixture.js';

let daemon: StartedMultiUserDaemon; let dataRoot: string; let fixture: McpFixture;
let admin: Principal; let alice: Principal; let bob: Principal;
let clock = Date.now();
const logs: string[] = [];

const call = (user: Principal | null, method: string, route: string, body?: unknown) => daemon.request({ method, path: route,
  ...(user ? { cookie: user.cookie } : {}), headers: { origin: MU_TEST_ORIGIN }, ...(body === undefined ? {} : { body }) });
const asAdmin = (method: string, route: string, body?: unknown) => call(admin, method, route, body);
async function freshUser(): Promise<Principal> {
  const username = `mcp-${randomUUID().slice(0, 8)}`; const password = `${username}-battery-staple-password`;
  const made = await asAdmin('POST', '/api/auth/users', { username, password, role: 'user' });
  expect(made.status, made.text).toBe(201);
  return { id: made.json.account.id, username, password, cookie: await login(daemon, username, password) };
}
const create = (user: Principal, body: Record<string, unknown>) => call(user, 'POST', '/api/multiuser/mcp/servers', body);
async function remote(user: Principal, id: string, extra: Record<string, unknown> = {}) {
  const res = await create(user, { id, url: fixture.url(), headers: { 'X-Api-Key': MCP_HEADER_SENTINEL }, ...extra });
  expect(res.status, res.text).toBe(201);
  return res.json.server;
}
function appDb<T>(read: (db: Database.Database) => T): T {
  const db = new Database(path.join(dataRoot, 'app.sqlite'), { readonly: true });
  try { return read(db); } finally { db.close(); }
}
const tokenRows = (owner: string) => appDb((db) => db.prepare('SELECT server_id FROM studio_mcp_oauth_tokens WHERE owner_account_id = ?').all(owner) as Array<{ server_id: string }>);
function filesUnder(root: string): string[] {
  return readdirSync(root).flatMap((entry) => {
    const full = path.join(root, entry); const stat = statSync(full, { throwIfNoEntry: false });
    return !stat ? [] : stat.isDirectory() ? filesUnder(full) : stat.isFile() && stat.size < 64 * 1024 * 1024 ? [full] : [];
  });
}
async function startAuth(user: Principal, id: string) {
  const res = await call(user, 'POST', '/api/mcp/oauth/start', { serverId: id });
  expect(res.status, res.text).toBe(200);
  const authorize = new URL(res.json.authorizeUrl);
  return { res, state: authorize.searchParams.get('state')!, authorize };
}
const callback = (state: string, extra: Record<string, string> = { code: 'good-code' }, cookie?: string) =>
  daemon.request({ path: `/api/mcp/oauth/callback?${new URLSearchParams({ state, ...extra })}`, ...(cookie ? { cookie } : {}) });

beforeAll(async () => {
  delete process.env.OD_API_TOKEN; delete process.env.OD_DISABLE_API_AUTH;
  ({ dataRoot } = await loadIsolatedServerModule());
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logs.push(args.map((arg) => typeof arg === 'string' ? arg : JSON.stringify(arg) ?? String(arg)).join(' ')); });
  }
  fixture = await startMcpFixture();
  daemon = await startMultiUserDaemon(multiUserOptions({ poolClock: () => clock,
    testMcpOutbound: { resolve: fixture.resolve, allowAddress: fixture.allowAddress, timeoutMs: 1_500 } }));
  const provisioned = await provisionAccounts(daemon, ['mcp-alice', 'mcp-bob']);
  admin = provisioned.admin; [alice, bob] = provisioned.users as [Principal, Principal];
}, 120_000);
beforeEach(() => { clock = Date.now(); fixture.state.holdMcp = false; fixture.state.holdToken = false; fixture.state.tokenFails = false; fixture.state.issuer = null; fixture.state.authorizationEndpoint = null; });
afterAll(async () => { await daemon?.close(); await fixture?.close(); vi.restoreAllMocks(); cleanupIsolatedDataRoot(); });

describe('stdio is refused on multi-user Web', () => {
  it.each([
    ['create with transport stdio', 'POST', '/api/multiuser/mcp/servers', { id: 'stdio-a', transport: 'stdio', command: 'node', args: ['server.js'] }],
    ['create with a command only', 'POST', '/api/multiuser/mcp/servers', { id: 'stdio-b', url: 'https://mcp.example.com/mcp', command: '/bin/sh' }],
    ['import of a stdio entry (standard alias)', 'PUT', '/api/mcp/servers', { servers: [{ id: 'stdio-c', transport: 'stdio', command: 'npx', enabled: true }] }],
    ['import of an entry without transport (desktop default stdio)', 'PUT', '/api/multiuser/mcp/servers', { servers: [{ id: 'stdio-d', command: 'npx', enabled: true }] }],
    ['import mixing remote and stdio', 'PUT', '/api/mcp/servers', { servers: [{ id: 'ok-1', transport: 'http', url: 'https://mcp.example.com/mcp', enabled: true },
      { id: 'stdio-e', transport: 'stdio', command: 'npx', env: { KEY: MCP_HEADER_SENTINEL }, enabled: true }] }],
  ])('%s → typed capability refusal, nothing stored', async (_label, method, route, body) => {
    for (const user of [alice, admin]) {
      const res = await call(user, method, route, body);
      expect(res.status, res.text).toBe(403);
      expect(res.json.error).toMatchObject({ code: 'MULTIUSER_CAPABILITY_UNAVAILABLE', details: { capability: 'mcp-stdio', reason: STUDIO_MCP_STDIO_UNAVAILABLE_REASON } });
      expect(res.text).not.toContain(MCP_HEADER_SENTINEL);
    }
    expect(appDb((db) => db.prepare("SELECT COUNT(*) AS n FROM studio_mcp_servers WHERE server_id LIKE 'stdio-%' OR server_id = 'ok-1'").get())).toEqual({ n: 0 });
  });
  it('an update cannot turn a remote server into stdio', async () => {
    const server = await remote(alice, `to-stdio-${randomUUID().slice(0, 6)}`);
    const res = await call(alice, 'PATCH', `/api/multiuser/mcp/servers/${server.id}`, { revision: server.revision, transport: 'stdio', command: 'node' });
    expect(res.status).toBe(403);
    expect(res.json.error.details.capability).toBe('mcp-stdio');
  });
  it.each([['GET', '/api/mcp/install-info'], ['GET', '/api/mcp/install/codex/status'], ['POST', '/api/mcp/install/codex'], ['DELETE', '/api/mcp/install/codex']])(
    '%s %s (host Codex install) is refused for members and administrators', async (method, route) => {
      for (const user of [alice, admin]) {
        const res = await call(user, method, route, method === 'POST' ? {} : undefined);
        expect(res.status, res.text).toBe(403);
        expect(res.json.error).toMatchObject({ code: 'MULTIUSER_CAPABILITY_UNAVAILABLE', details: { capability: 'mcp-stdio' } });
        expect(res.json.error.details.reason).toMatch(/stdio MCP is not allowed on multi-user Web/);
      }
    });
});

describe('account-owned remote servers', () => {
  it('creates, lists (standard alias too), updates and deletes with write-only header values', async () => {
    const id = `own-${randomUUID().slice(0, 6)}`;
    const made = await create(alice, { id, url: fixture.url(), transport: 'streamable-http', label: 'Fixture', headers: { 'X-Api-Key': MCP_HEADER_SENTINEL, 'X-Short': 'abc' } });
    expect(made.status, made.text).toBe(201);
    expect(made.json.server).toMatchObject({ id, transport: 'http', url: fixture.url(), enabled: true, authMode: 'none', label: 'Fixture',
      headers: [{ name: 'X-Api-Key', configured: true, tail: MCP_HEADER_SENTINEL.slice(-4) }, { name: 'X-Short', configured: true, tail: '' }],
      oauth: { status: 'not-required' } });
    for (const route of ['/api/multiuser/mcp/servers', '/api/mcp/servers']) {
      const listed = await call(alice, 'GET', route);
      expect(listed.status).toBe(200);
      expect(listed.json.servers.map((server: { id: string }) => server.id)).toContain(id);
      expect(listed.json.stdio).toEqual({ available: false, reason: STUDIO_MCP_STDIO_UNAVAILABLE_REASON });
      expect(listed.json.runs).toEqual({ available: false, reason: STUDIO_MCP_NOT_IN_RUNS_REASON });
      expect(listed.json.templates.every((template: { transport: string }) => template.transport !== 'stdio')).toBe(true);
      expect(listed.text).not.toContain(MCP_HEADER_SENTINEL);
    }
    const stale = await call(alice, 'PATCH', `/api/multiuser/mcp/servers/${id}`, { revision: 99, label: 'x' });
    expect(stale.status).toBe(409);
    const patched = await call(alice, 'PATCH', `/api/multiuser/mcp/servers/${id}`, { revision: made.json.server.revision, label: 'Renamed', headers: { 'X-Short': null } });
    expect(patched.status, patched.text).toBe(200);
    expect(patched.json.server.headers.map((header: { name: string }) => header.name)).toEqual(['X-Api-Key']);
    // The kept header still works: the connection test reaches the fixture with it.
    const tested = await call(alice, 'POST', `/api/multiuser/mcp/servers/${id}/test`, {});
    expect(tested.status, tested.text).toBe(200);
    expect(tested.json.result).toMatchObject({ ok: true, serverName: 'fixture-mcp', protocolVersion: '2025-06-18' });
    expect(tested.json.server.lastTest).toMatchObject({ ok: true, code: null });
    expect(fixture.requests.at(-1)?.apiKey).toBe(MCP_HEADER_SENTINEL);
    expect((await call(alice, 'DELETE', `/api/multiuser/mcp/servers/${id}`)).status).toBe(200);
    expect((await call(alice, 'DELETE', `/api/multiuser/mcp/servers/${id}`)).status).toBe(404);
    // History is kept: the audit still records the server's actions.
    expect(appDb((db) => db.prepare('SELECT action FROM studio_mcp_audit WHERE actor_account_id = ? AND server_id = ? ORDER BY id').all(alice.id, id)))
      .toEqual(expect.arrayContaining([{ action: 'server_create' }, { action: 'server_delete' }]));
  });
  it('imports remote entries in the desktop body (upsert) through the standard PUT alias', async () => {
    const id = `imp-${randomUUID().slice(0, 6)}`;
    const res = await call(alice, 'PUT', '/api/mcp/servers', { servers: [{ id, transport: 'sse', url: fixture.url('/sse'), enabled: true, headers: { Authorization: `Bearer ${MCP_HEADER_SENTINEL}` } }] });
    expect(res.status, res.text).toBe(200);
    expect(res.json.imported).toEqual([id]);
    expect(res.text).not.toContain(MCP_HEADER_SENTINEL);
    const tested = await call(alice, 'POST', `/api/multiuser/mcp/servers/${id}/test`, {});
    expect(tested.json.result).toMatchObject({ ok: true });
    await call(alice, 'DELETE', `/api/multiuser/mcp/servers/${id}`);
  });
  it('A\'s server is unaddressable for B and administrators — the same 404 as a server that never existed', async () => {
    const id = `iso-${randomUUID().slice(0, 6)}`;
    await remote(alice, id);
    const missing = `never-${randomUUID().slice(0, 6)}`;
    const probes = (serverId: string): Array<[string, string, unknown]> => [
      ['PATCH', `/api/multiuser/mcp/servers/${serverId}`, { revision: 1, label: 'stolen' }],
      ['DELETE', `/api/multiuser/mcp/servers/${serverId}`, undefined],
      ['POST', `/api/multiuser/mcp/servers/${serverId}/test`, {}],
      ['POST', '/api/mcp/oauth/start', { serverId }],
      ['GET', `/api/mcp/oauth/status?serverId=${serverId}`, undefined],
      ['POST', '/api/mcp/oauth/disconnect', { serverId }],
      ['POST', '/api/multiuser/mcp/oauth/refresh', { serverId }],
      ['POST', '/api/multiuser/mcp/oauth/cancel', { serverId }],
    ];
    for (const user of [bob, admin]) {
      expect((await call(user, 'GET', '/api/mcp/servers')).json.servers.map((server: { id: string }) => server.id)).not.toContain(id);
      const foreign = probes(id); const absent = probes(missing);
      for (let index = 0; index < foreign.length; index++) {
        const [method, route, body] = foreign[index]!;
        const a = await call(user, method, route, body);
        const b = await call(user, absent[index]![0], absent[index]![1], absent[index]![2]);
        expect([a.status, a.json], `${method} ${route}`).toEqual([b.status, b.json]);
        expect(a.status).toBe(404);
      }
    }
    // B may own a server with the same id; it is a different server.
    await remote(bob, id);
    expect((await call(alice, 'GET', '/api/mcp/servers')).json.servers.filter((server: { id: string }) => server.id === id)).toHaveLength(1);
    expect(appDb((db) => db.prepare('SELECT COUNT(*) AS n FROM studio_mcp_servers WHERE server_id = ?').get(id))).toEqual({ n: 2 });
  });
  it('bounds the number of servers and every field, with fixed messages that never echo a value', async () => {
    const user = await freshUser();
    for (let index = 0; index < STUDIO_MCP_LIMITS.maxServers; index++) expect((await create(user, { id: `n${index}`, url: 'https://mcp.example.com/mcp' })).status).toBe(201);
    const over = await create(user, { id: 'one-too-many', url: 'https://mcp.example.com/mcp' });
    expect(over.status).toBe(409);
    expect(over.json.error.code).toBe('MULTIUSER_MCP_LIMIT_REACHED');
    const other = await freshUser();
    const tooManyHeaders = Object.fromEntries(Array.from({ length: STUDIO_MCP_LIMITS.maxHeaders + 1 }, (_, index) => [`X-H${index}`, MCP_HEADER_SENTINEL]));
    for (const body of [
      { id: 'bad', url: 'https://mcp.example.com/mcp', headers: tooManyHeaders },
      { id: 'bad', url: 'https://mcp.example.com/mcp', headers: { 'X-Long': `${MCP_HEADER_SENTINEL}${'v'.repeat(STUDIO_MCP_LIMITS.maxHeaderValueLength)}` } },
      { id: 'bad', url: 'https://mcp.example.com/mcp', headers: { Host: MCP_HEADER_SENTINEL } },
      { id: 'bad', url: 'https://mcp.example.com/mcp', headers: { 'X-Bad\nName': MCP_HEADER_SENTINEL } },
      { id: 'bad', url: 'https://mcp.example.com/mcp', headers: { 'X-Crlf': `${MCP_HEADER_SENTINEL}\r\nX-Injected: 1` } },
      { id: 'bad', url: `https://mcp.example.com/${'p'.repeat(STUDIO_MCP_LIMITS.maxUrlLength)}` },
      { id: 'Bad Id', url: 'https://mcp.example.com/mcp' },
      { id: 'bad', url: 'https://mcp.example.com/mcp', label: 'x'.repeat(STUDIO_MCP_LIMITS.maxLabelLength + 1) },
      { id: 'bad', url: 'https://mcp.example.com/mcp', transport: 'websocket' },
    ]) {
      const res = await create(other, body);
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect(res.text).not.toContain(MCP_HEADER_SENTINEL);
    }
    expect((await call(other, 'GET', '/api/mcp/servers')).json.servers).toEqual([]);
  });
});

describe('SSRF guard on every outbound request', () => {
  it.each([
    ['cloud metadata literal', 'http://169.254.169.254/latest/meta-data/', 'address'],
    ['EC2 IPv6 metadata literal', 'http://[fd00:ec2::254]/', 'address'],
    ['loopback literal', 'http://127.0.0.2:9/mcp', 'address'],
    ['IPv4-mapped loopback', 'http://[::ffff:7f00:1]/mcp', 'address'],
    ['RFC 1918 literal', 'https://10.1.2.3/mcp', 'address'],
    ['localhost name', 'http://localhost:9/mcp', 'address'],
    ['non-http scheme', 'ftp://mcp.example.com/mcp', 'scheme'],
    ['file scheme', 'file:///etc/passwd', 'scheme'],
    ['URL credentials', 'https://user:pass@mcp.example.com/mcp', 'credentials'],
  ])('refuses to save %s', async (_label, url, reason) => {
    const res = await create(alice, { id: `ssrf-${randomUUID().slice(0, 6)}`, url });
    expect(res.status, res.text).toBe(400);
    expect(res.json.error).toMatchObject({ code: 'MULTIUSER_MCP_OUTBOUND_REFUSED', details: { reason } });
  });
  it.each([
    ['a name resolving into RFC 1918', 'http://private.blocked.test/mcp', 'address'],
    ['a name resolving to the metadata address', 'http://meta.blocked.test/mcp', 'address'],
    ['a name with one private answer among public ones', 'http://mixed.blocked.test/mcp', 'address'],
    ['a name resolving to IPv4-mapped loopback', 'http://mapped.blocked.test/mcp', 'address'],
    ['an unresolvable name', 'http://nowhere.invalid/mcp', 'host'],
  ])('a connection test refuses %s after DNS resolution', async (_label, url, reason) => {
    const id = `dns-${randomUUID().slice(0, 6)}`;
    expect((await create(alice, { id, url })).status).toBe(201);
    const res = await call(alice, 'POST', `/api/multiuser/mcp/servers/${id}/test`, {});
    expect(res.status, res.text).toBe(400);
    expect(res.json.error).toMatchObject({ code: 'MULTIUSER_MCP_OUTBOUND_REFUSED', details: { reason } });
    await call(alice, 'DELETE', `/api/multiuser/mcp/servers/${id}`);
  });
  it.each([
    ['a POST redirect', '/redirect', 'http', 'redirect'],
    ['a GET redirect into the metadata address', '/redirect-get', 'sse', 'address'],
    ['an oversized response', '/huge', 'http', 'size'],
    ['a server that never answers', '/hang', 'http', 'timeout'],
  ])('a connection test refuses %s', async (_label, route, transport, reason) => {
    const id = `out-${randomUUID().slice(0, 6)}`;
    expect((await create(alice, { id, url: fixture.url(route), transport })).status).toBe(201);
    const res = await call(alice, 'POST', `/api/multiuser/mcp/servers/${id}/test`, {});
    expect(res.status, res.text).toBe(400);
    expect(res.json.error).toMatchObject({ code: 'MULTIUSER_MCP_OUTBOUND_REFUSED', details: { reason } });
    await call(alice, 'DELETE', `/api/multiuser/mcp/servers/${id}`);
  });
  it('OAuth discovery refuses an authorization server in private space', async () => {
    const id = `oauth-ssrf-${randomUUID().slice(0, 6)}`;
    await remote(alice, id, { authMode: 'oauth', headers: {} });
    fixture.state.issuer = 'http://meta.blocked.test';
    const res = await call(alice, 'POST', '/api/mcp/oauth/start', { serverId: id });
    expect(res.status, res.text).toBe(400);
    expect(res.json.error).toMatchObject({ code: 'MULTIUSER_MCP_OUTBOUND_REFUSED', details: { reason: 'address' } });
    expect(appDb((db) => db.prepare('SELECT COUNT(*) AS n FROM studio_mcp_oauth_states WHERE owner_account_id = ?').get(alice.id))).toMatchObject({ n: expect.any(Number) });
  });
  it('OAuth refuses an authorization endpoint that is not http(s)', async () => {
    const id = `oauth-js-${randomUUID().slice(0, 6)}`;
    await remote(alice, id, { authMode: 'oauth', headers: {} });
    fixture.state.authorizationEndpoint = 'javascript:alert(1)';
    const res = await call(alice, 'POST', '/api/mcp/oauth/start', { serverId: id });
    expect(res.status).toBe(502);
    expect(res.json.error).toMatchObject({ code: 'MULTIUSER_MCP_PROVIDER_FAILED' });
  });
});

describe('OAuth bound to account, session and server', () => {
  it('connects through discovery, dynamic registration and PKCE; tokens are sealed, refreshable and per account', async () => {
    const id = `oauth-${randomUUID().slice(0, 6)}`;
    await remote(alice, id, { authMode: 'oauth', headers: {} });
    expect((await call(alice, 'GET', `/api/mcp/oauth/status?serverId=${id}`)).json).toMatchObject({ connected: false, status: 'needs-auth' });
    const { authorize, state, res } = await startAuth(alice, id);
    expect(res.json.redirectUri).toBe(`${MU_TEST_ORIGIN}/api/mcp/oauth/callback`);
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('client_id')).toMatch(/^fixture-client-/);
    expect(authorize.searchParams.get('redirect_uri')).toBe(`${MU_TEST_ORIGIN}/api/mcp/oauth/callback`);
    // The callback carries no cookie; identity comes from the state. Another account's cookie gains nothing.
    const done = await callback(state, { code: 'good-code' }, bob.cookie);
    expect(done.status, done.text).toBe(200);
    expect(done.headers['content-security-policy']).toMatch(/script-src 'nonce-/);
    expect(done.text).not.toContain(MCP_TOKEN_SENTINEL);
    expect(tokenRows(alice.id).map((row) => row.server_id)).toContain(id);
    expect(tokenRows(bob.id).map((row) => row.server_id)).not.toContain(id);
    const status = await call(alice, 'GET', `/api/mcp/oauth/status?serverId=${id}`);
    expect(status.json).toMatchObject({ connected: true, status: 'connected', scope: 'mcp:read' });
    const tested = await call(alice, 'POST', `/api/multiuser/mcp/servers/${id}/test`, {});
    expect(tested.json.result).toMatchObject({ ok: true });
    expect(fixture.requests.at(-1)?.authorization).toBe(`Bearer ${MCP_TOKEN_SENTINEL}`);
    const replay = await callback(state);
    expect(replay.json.error).toMatchObject({ code: 'MULTIUSER_MCP_AUTHORIZATION_INVALID', details: { reason: 'replayed' } });
    const refreshed = await call(alice, 'POST', '/api/multiuser/mcp/oauth/refresh', { serverId: id });
    expect(refreshed.status, refreshed.text).toBe(200);
    expect(refreshed.json.connected).toBe(true);
    for (const text of [status.text, tested.text, refreshed.text, (await call(alice, 'GET', '/api/mcp/servers')).text]) {
      for (const secret of [MCP_TOKEN_SENTINEL, MCP_REFRESH_SENTINEL, MCP_CLIENT_SECRET_SENTINEL]) expect(text).not.toContain(secret);
    }
    expect((await call(alice, 'POST', '/api/mcp/oauth/disconnect', { serverId: id })).status).toBe(200);
    expect((await call(alice, 'GET', `/api/mcp/oauth/status?serverId=${id}`)).json).toMatchObject({ connected: false, status: 'needs-auth' });
    // No secret in logs, the audit or any data file (raw SQLite bytes included).
    for (const secret of [MCP_TOKEN_SENTINEL, MCP_REFRESH_SENTINEL, MCP_CLIENT_SECRET_SENTINEL, MCP_HEADER_SENTINEL]) {
      expect(logs.filter((line) => line.includes(secret))).toEqual([]);
      for (const file of filesUnder(dataRoot)) expect(readFileSync(file).toString('latin1').includes(secret), file).toBe(false);
    }
  });
  it('refuses unknown, malformed, expired and provider-refused callbacks without storing a token', async () => {
    const id = `oauth-bad-${randomUUID().slice(0, 6)}`;
    await remote(alice, id, { authMode: 'oauth', headers: {} });
    expect((await callback('x'.repeat(43))).json.error.details.reason).toBe('state');
    expect((await callback('short')).json.error.details.reason).toBe('state');
    const expired = await startAuth(alice, id);
    clock += 11 * 60_000;
    expect((await callback(expired.state)).json.error.details.reason).toBe('expired');
    clock = Date.now();
    const declined = await startAuth(alice, id);
    expect((await callback(declined.state, { error: 'access_denied' })).json.error.details.reason).toBe('not-completed');
    fixture.state.tokenFails = true;
    const rejected = await startAuth(alice, id);
    const res = await callback(rejected.state);
    expect(res.json.error.details.reason).toBe('provider');
    expect(res.text).not.toContain('good-code');
    expect(tokenRows(alice.id).map((row) => row.server_id)).not.toContain(id);
  });
  it.each([
    ['logout', 'session'], ['session rotation', 'session'], ['admin session revoke', 'session'], ['password reset', 'session'],
    ['account disabled', 'account'], ['pilot change', 'session'], ['user cancel', 'state'], ['server URL changed', 'server-changed'],
    ['server disabled', 'server-changed'], ['server deleted', 'server-changed'],
  ])('refuses a callback after %s and stores no token for anyone', async (change, reason) => {
    const user = await freshUser();
    const id = 'bound';
    const server = await remote(user, id, { authMode: 'oauth', headers: {} });
    const { state } = await startAuth(user, id);
    if (change === 'logout') await call(user, 'POST', '/api/auth/logout', {});
    if (change === 'session rotation') expect((await call(user, 'POST', '/api/auth/session/rotate', {})).status).toBe(200);
    if (change === 'admin session revoke') expect((await asAdmin('POST', `/api/auth/users/${user.id}/sessions/revoke`, {})).status).toBe(200);
    if (change === 'password reset') expect((await asAdmin('POST', `/api/auth/users/${user.id}/password`, { password: `${user.password}-reset` })).status).toBe(204);
    if (change === 'account disabled') expect((await asAdmin('PATCH', `/api/auth/users/${user.id}`, { active: false })).status).toBe(200);
    if (change === 'pilot change') {
      const pilot = await asAdmin('GET', `/api/admin/users/${user.id}/studio-pilot`);
      expect((await asAdmin('PUT', `/api/admin/users/${user.id}/studio-pilot`, { studioPilot: false, revision: pilot.json.revision })).status).toBe(200);
    }
    if (change === 'user cancel') expect((await call(user, 'POST', '/api/multiuser/mcp/oauth/cancel', { serverId: id })).status).toBe(200);
    if (change === 'server URL changed') expect((await call(user, 'PATCH', `/api/multiuser/mcp/servers/${id}`, { revision: server.revision, url: fixture.url('/mcp', 'other.fixture.test') })).status).toBe(200);
    if (change === 'server disabled') expect((await call(user, 'PATCH', `/api/multiuser/mcp/servers/${id}`, { revision: server.revision, enabled: false })).status).toBe(200);
    if (change === 'server deleted') expect((await call(user, 'DELETE', `/api/multiuser/mcp/servers/${id}`)).status).toBe(200);
    const res = await callback(state, { code: 'good-code' }, bob.cookie);
    expect(res.json?.error, res.text).toMatchObject({ code: 'MULTIUSER_MCP_AUTHORIZATION_INVALID' });
    if (['admin session revoke', 'password reset'].includes(change)) expect(['session', 'account']).toContain(res.json.error.details.reason);
    else if (change === 'account disabled') expect(['session', 'account']).toContain(res.json.error.details.reason);
    else expect(res.json.error.details.reason).toBe(reason);
    expect(tokenRows(user.id)).toEqual([]);
    expect(tokenRows(bob.id).map((row) => row.server_id)).not.toContain(id);
  });
  it('a session revoked while the token exchange is in flight stores nothing', async () => {
    const user = await freshUser();
    await remote(user, 'inflight', { authMode: 'oauth', headers: {} });
    const { state } = await startAuth(user, 'inflight');
    fixture.state.holdToken = true;
    const pending = callback(state);
    await until(() => fixture.state.releases.length, (n) => n > 0, 'token exchange entered');
    await call(user, 'POST', '/api/auth/logout', {});
    for (const release of fixture.state.releases.splice(0)) release();
    const res = await pending;
    expect(res.json?.error, res.text).toMatchObject({ code: 'MULTIUSER_MCP_AUTHORIZATION_INVALID' });
    expect(['session', 'state']).toContain(res.json.error.details.reason);
    expect(tokenRows(user.id)).toEqual([]);
  });
});

describe('lifecycle and authority at every effect', () => {
  it('a disabled server is unusable for new operations; re-enabling restores it; deletion keeps history', async () => {
    const user = await freshUser();
    const server = await remote(user, 'life');
    const disabled = await call(user, 'PATCH', '/api/multiuser/mcp/servers/life', { revision: server.revision, enabled: false });
    expect(disabled.json.server.enabled).toBe(false);
    expect((await call(user, 'POST', '/api/multiuser/mcp/servers/life/test', {})).status).toBe(409);
    const enabled = await call(user, 'PATCH', '/api/multiuser/mcp/servers/life', { revision: disabled.json.server.revision, enabled: true });
    expect((await call(user, 'POST', '/api/multiuser/mcp/servers/life/test', {})).json.result.ok).toBe(true);
    expect(enabled.status).toBe(200);
    await call(user, 'DELETE', '/api/multiuser/mcp/servers/life');
    expect((await call(user, 'POST', '/api/multiuser/mcp/servers/life/test', {})).status).toBe(404);
    expect(appDb((db) => db.prepare('SELECT COUNT(*) AS n FROM studio_mcp_audit WHERE actor_account_id = ? AND server_id = ?').get(user.id, 'life'))).toMatchObject({ n: expect.any(Number) });
  });
  it.each([['logout'], ['server deleted'], ['server disabled']])('%s while a connection test is in flight answers a typed authority refusal and records nothing', async (change) => {
    const user = await freshUser();
    const server = await remote(user, 'race');
    fixture.state.holdMcp = true;
    const pending = call(user, 'POST', '/api/multiuser/mcp/servers/race/test', {});
    await until(() => fixture.state.releases.length, (n) => n > 0, 'test entered');
    if (change === 'logout') await daemon.request({ method: 'POST', path: '/api/auth/logout', cookie: user.cookie, headers: { origin: MU_TEST_ORIGIN }, body: {} });
    if (change === 'server deleted') await call(user, 'DELETE', '/api/multiuser/mcp/servers/race');
    if (change === 'server disabled') await call(user, 'PATCH', '/api/multiuser/mcp/servers/race', { revision: server.revision, enabled: false });
    for (const release of fixture.state.releases.splice(0)) release();
    const res = await pending;
    // The request passed the gate before the change; the effect-boundary recheck refuses it.
    expect(res.status, res.text).toBe(409);
    expect(res.json.error).toMatchObject({ code: 'MULTIUSER_MCP_AUTHORITY_CHANGED', details: { reason: change === 'logout' ? 'session' : 'server-changed' } });
    const row = appDb((db) => db.prepare('SELECT last_test_json FROM studio_mcp_servers WHERE owner_account_id = ? AND server_id = ?')
      .get(user.id, 'race') as { last_test_json: string | null } | undefined);
    expect(row?.last_test_json ?? null).toBeNull();
  });
});

describe('run-time use stays refused (S61 opens it)', () => {
  it('runs and routines refuse mcpServerIds with the precise reason', async () => {
    const id = `run-${randomUUID().slice(0, 6)}`;
    await remote(alice, id);
    const projectId = randomUUID();
    const project = await call(alice, 'POST', '/api/projects', { id: projectId, name: 'mcp-run' });
    const run = await call(alice, 'POST', '/api/runs', { projectId, conversationId: project.json.conversationId, message: 'use it', agentId: 'openai',
      context: { mcpServerIds: [id] } });
    expect(run.status, run.text).toBe(403);
    expect(run.json.error).toMatchObject({ code: 'MULTIUSER_CAPABILITY_UNAVAILABLE', message: STUDIO_MCP_NOT_IN_RUNS_REASON, details: { capability: 'mcp', reason: STUDIO_MCP_NOT_IN_RUNS_REASON } });
    const routine = await call(alice, 'POST', '/api/routines', { name: 'r', prompt: 'p', schedule: { kind: 'daily', time: '09:00', timezone: 'UTC' },
      target: { mode: 'create_each_run' }, context: { mcpServerIds: [id] } });
    expect(routine.status, routine.text).toBe(403);
    expect(routine.json.error).toMatchObject({ code: 'MULTIUSER_CAPABILITY_UNAVAILABLE', details: { capability: 'mcp', reason: STUDIO_MCP_NOT_IN_RUNS_REASON } });
  });
});
