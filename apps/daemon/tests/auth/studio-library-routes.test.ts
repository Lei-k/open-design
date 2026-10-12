import express from 'express';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { openDatabase, closeDatabase, insertProject } from '../../src/db.js';
import { ProjectAccessStore } from '../../src/storage/project-access.js';
import { bindMultiUserActor, createMultiUserGate, createMultiUserBodyErrorHandler } from '../../src/http/multiuser-gate.js';
import { setMultiUserStreamAuthority } from '../../src/http/multiuser-stream.js';
import { registerStudioLibraryRoutes } from '../../src/routes/studio-library.js';
import { toolTokenRegistry } from '../../src/tool-tokens.js';
import { AuthStore } from '../../src/storage/auth-store.js';
import { AuthService } from '../../src/services/auth-service.js';
import { registerAuthRoutes, type AuthSessionRevocationReason } from '../../src/routes/auth.js';
import { FAST_TEST_SCRYPT_PARAMS } from './helpers.js';
let app: express.Express; let runtime: ReturnType<typeof registerStudioLibraryRoutes>; let root: string; let access: ProjectAccessStore;
let db: ReturnType<typeof openDatabase>; const active = new Set(['a', 'b', 'admin']); const origin = 'chrome-extension://abc';
/** Runs Express's actual HTTP handlers with Node request/response objects. No listener or socket is opened. */
function request(method: string, url: string, actor?: string, body?: unknown, headers: Record<string, string> = {}, streaming = false, server: express.Express = app, raw?: string) {
  const req = new IncomingMessage(new Socket()); req.complete = true; req.method = method; req.url = url; req.headers = { host: 'test.invalid', ...headers };
  if (actor) req.headers['test-actor'] = actor;
  const payload = raw ?? (body === undefined ? '' : JSON.stringify(body)); if (payload) { req.headers['content-type'] = 'application/json'; req.headers['content-length'] = String(Buffer.byteLength(payload)); }
  const res = new ServerResponse(req); const chunks: string[] = [];
  return new Promise<{ status: number; json: any; text: string; req: IncomingMessage; res: ServerResponse; chunks: string[] }>((resolve, reject) => {
    const result = () => { const text = chunks.join(''); let json = null; try { json = JSON.parse(text); } catch {} return { status: res.statusCode, json, text, req, res, chunks }; };
    res.write = ((data: unknown) => { chunks.push(String(data)); if (streaming) resolve(result()); return true; }) as typeof res.write;
    res.end = ((data?: unknown) => { if (data) chunks.push(String(data)); resolve(result()); res.emit('finish'); return res; }) as typeof res.end;
    res.flushHeaders = () => {};
    (server as unknown as (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void) => void)(req, res, (error?: unknown) => error ? reject(error) : resolve(result()));
    if (payload) req.push(payload); req.push(null);
  });
}
beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'library-routes-')); db = openDatabase(root, { dataDir: root });
  app = express(); app.use((req, res, next) => {
    const actor = String(req.headers['test-actor'] ?? ''); if (actor) bindMultiUserActor(res, { accountId: actor, username: actor, role: actor === 'admin' ? 'admin' : 'user', sessionId: actor, sessionExpiresAt: Infinity });
    setMultiUserStreamAuthority(res, () => active.has(actor)); next();
  }); app.use(express.json({ limit: '128mb' }));
  runtime = registerStudioLibraryRoutes(app, { db, dataRoot: root, projectsRoot: path.join(root, 'projects'), accountActive: (id) => active.has(id), sessionCurrent: (actor) => active.has(actor.accountId) });
  access = new ProjectAccessStore(db, { accountActive: (id) => active.has(id) });
  db.exec('CREATE TABLE multiuser_runs (id TEXT PRIMARY KEY, owner_account_id TEXT, project_id TEXT, status TEXT)');
});
afterAll(() => { toolTokenRegistry.clear(); closeDatabase(); rmSync(root, { recursive: true, force: true }); });
const asset = async (actor: string, text: string) => {
  const result = await request('POST', '/api/library/ingest', actor, { text, sourceTitle: text, mime: 'text/html', kind: 'html', elementHtml: '<div>sidecar</div>', figmaCapture: '{}' });
  expect(result.status, result.text).toBe(200); return result.json.asset.id as string;
};
it('enforces identical non-enumerating HTTP responses on all foreign asset routes', async () => {
  const id = await asset('a', '<html>A_ONLY</html>'); const other = await asset('b', '<html>A_ONLY</html>'); expect(other).not.toBe(id);
  for (const actor of ['b', 'admin']) for (const [method, suffix, body] of [['GET', '', undefined], ['GET', '/raw', undefined], ['GET', '/element', undefined], ['GET', '/figma', undefined], ['DELETE', '', {}], ['POST', '/apply', { projectId: 'x' }], ['POST', '/edit-as-page', {}]] as const) {
    const foreign = await request(method, `/api/library/assets/${id}${suffix}`, actor, body);
    const missing = await request(method, `/api/library/assets/absent${suffix}`, actor, body);
    expect(foreign.status, foreign.text).toBe(404); expect(foreign.json).toEqual(missing.json);
  }
  for (const suffix of ['', '/raw', '/figma', '/element']) expect((await request('GET', `/api/library/assets/${id}${suffix}`, 'a')).status).toBe(200);
});
it('binds pairing/token exchange to the code account, not an accompanying cookie actor', async () => {
  const pending = await request('POST', '/api/library/pair', 'a', {}); expect(pending.status, pending.text).toBe(200);
  const paired = await request('POST', '/api/library/pair/confirm', undefined, { code: pending.json.code, extensionOrigin: origin }, { origin }); expect(paired.status, paired.text).toBe(200);
  const captured = await request('POST', '/api/library/ingest', 'b', { text: 'TOKEN_A' }, { origin, authorization: `Bearer ${paired.json.token}` }); expect(captured.status, captured.text).toBe(200);
  expect((await request('GET', `/api/library/assets/${captured.json.asset.id}`, 'b')).status).toBe(404);
  expect((await request('POST', '/api/library/ingest', undefined, { text: 'NO_TOKEN' }, { origin })).status).toBe(401);
  const tokens = await request('GET', '/api/library/connection', 'a'); expect(tokens.text).not.toContain(paired.json.token);
  const id = tokens.json.tokens[0].id; expect((await request('DELETE', `/api/library/tokens/${id}`, 'b')).status).toBe(404);
  expect((await request('DELETE', `/api/library/tokens/${id}`, 'a')).status).toBe(200);
  expect((await request('POST', '/api/library/ingest', undefined, { text: 'REVOKED' }, { origin, authorization: `Bearer ${paired.json.token}` })).status).toBe(401);
});
it('keeps event feeds account-private and releases listeners on close', async () => {
  const a = await request('GET', '/api/library/events', 'a', undefined, {}, true); const b = await request('GET', '/api/library/events', 'b', undefined, {}, true);
  const id = await asset('a', 'EVENT_A'); expect(a.chunks.join('')).toContain(id); expect(b.chunks.join('')).not.toContain(id);
  a.res.emit('close'); b.res.emit('close');
});
it('refuses foreign/read-only projects and writes only to editable targets', async () => {
  const id = await asset('a', 'apply'); const projectId = randomUUID(); const now = Date.now();
  insertProject(db, { id: projectId, name: 'B', skillId: null, designSystemId: null, metadata: {}, pendingPrompt: null, createdAt: now, updatedAt: now });
  access.ownership.bindOwner(projectId, 'b', now); mkdirSync(path.join(root, 'projects', projectId), { recursive: true });
  const route = `/api/library/assets/${id}/apply`;
  expect((await request('POST', route, 'a', { projectId })).status).toBe(404);
  access.setGrant(projectId, 'a', 'view', now); expect((await request('POST', route, 'a', { projectId })).status).toBe(404);
  access.setGrant(projectId, 'a', 'edit', now); expect((await request('POST', route, 'a', { projectId })).status).toBe(200);
  expect((await request('POST', route, 'a', { projectId, dir: '../escape' })).status).toBe(400);
});
it('binds in-process tools to the run owner, bounds search, and refuses foreign scope and cancellation', async () => {
  const id = await asset('a', 'TOOL_A'); const foreign = await asset('b', 'TOOL_B'); const projectId = randomUUID(); const now = Date.now();
  insertProject(db, { id: projectId, name: 'run', skillId: null, designSystemId: null, metadata: {}, pendingPrompt: null, createdAt: now, updatedAt: now });
  access.ownership.bindOwner(projectId, 'a', now); mkdirSync(path.join(root, 'projects', projectId), { recursive: true });
  let current = true; const tools = runtime.tools('a', projectId, () => current);
  const search = await tools.execute('library_search', { query: 'TOOL', limit: 100 });
  expect(JSON.stringify(search)).toContain(id); expect(JSON.stringify(search)).not.toContain(foreign);
  for (const limit of [101, 0, -1, 1.5, '100']) await expect(tools.execute('library_search', { limit })).rejects.toMatchObject({ status: 400 });
  await expect(tools.execute('library_apply', { assetId: foreign })).rejects.toMatchObject({ status: 404 });
  await expect(tools.execute('library_apply', { assetId: id, projectId: 'b' })).rejects.toMatchObject({ status: 400 });
  expect(await tools.execute('library_apply', { assetId: id })).toHaveProperty('relPath');
  current = false; await expect(tools.execute('library_search', {})).rejects.toMatchObject({ status: 404 });
  const grant = toolTokenRegistry.mint({ runId: 'run-a', projectId });
  for (const operation of ['search', 'apply']) expect((await request('POST', `/api/tools/library/${operation}`, 'a', {}, { authorization: `Bearer ${grant.token}` })).status).toBe(403);
});
it('creates an atomically owned editable page and leaves another actor no read authority', async () => {
  const id = await asset('a', '<html>PAGE_A</html>'); const created = await request('POST', `/api/library/assets/${id}/edit-as-page`, 'a', {});
  expect(created.status, created.text).toBe(200); expect(access.ownership.ownerOf(created.json.projectId)).toBe('a'); expect(access.canWrite(created.json.projectId, 'b')).toBe(false);
});
it('offers the same owner library functions to both OpenAI sources without injecting another account’s content', async () => {
  const { CompanyOpenAIWorker, runCompanyOpenAITurn } = await import('../../src/runtimes/company-openai.js');
  const id = await asset('a', 'NATIVE_OWNER_A'); const foreign = await asset('b', 'FOREIGN_PROMPT_INJECT');
  const projectId = randomUUID(); const now = Date.now();
  insertProject(db, { id: projectId, name: 'native', skillId: null, designSystemId: null, metadata: {}, pendingPrompt: null, createdAt: now, updatedAt: now });
  access.ownership.bindOwner(projectId, 'a', now); mkdirSync(path.join(root, 'projects', projectId), { recursive: true });
  let calls = 0; const sent: string[] = [];
  const result = await runCompanyOpenAITurn({ apiKey: 'fake-account-key', model: 'fake', projectsRoot: path.join(root, 'projects'), projectId,
    worker: new CompanyOpenAIWorker(), history: [], prompt: 'use library', authorized: () => true, onAgentEvent: () => {},
    library: runtime.tools('a', projectId, () => true), fetch: async (_url, init) => {
      sent.push(String(init?.body)); const output = calls++ === 0 ? [
        { type: 'function_call', name: 'library_search', call_id: 'search', arguments: '{"query":"NATIVE"}' },
        { type: 'function_call', name: 'library_apply', call_id: 'foreign', arguments: JSON.stringify({ assetId: foreign }) },
        { type: 'function_call', name: 'library_apply', call_id: 'own', arguments: JSON.stringify({ assetId: id }) },
      ] : [];
      return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { output } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    } });
  expect(result.ok).toBe(true); expect(sent[0]).toContain('library_search'); expect(sent[0]).toContain('library_apply');
  expect(sent.at(-1)).toContain('NATIVE_OWNER_A'); expect(sent.join('')).not.toContain('FOREIGN_PROMPT_INJECT');
});

it('validates extension tokens before JSON parsing and refuses account deactivation immediately', async () => {
  const gated = express(); let parsed = 0;
  gated.use(createMultiUserGate({ auth: { resolveSession: () => null, isActorCurrent: () => false }, allowedOrigins: ['https://studio.example'], isProjectOwner: () => false,
    libraryTokenCurrent: (token, extensionOrigin) => runtime.store.tokenOwner(token, extensionOrigin) !== null,
    libraryIngestAdmission: (owner, token, extensionOrigin) => runtime.store.admitIngest(owner ?? runtime.store.tokenOwner(token, extensionOrigin)!),
    libraryPairAdmission: (source) => runtime.store.admitPair(source) }));
  gated.use((_req, _res, next) => { parsed++; next(); }); gated.use(express.json({ limit: '128mb' }));
  registerStudioLibraryRoutes(gated, { db, dataRoot: root, projectsRoot: path.join(root, 'projects'), accountActive: (id) => active.has(id), sessionCurrent: (actor) => active.has(actor.accountId) });
  const invalid = await request('POST', '/api/library/ingest', undefined, { text: 'never parsed' }, { origin, authorization: 'Bearer invalid' }, false, gated);
  expect(invalid.status).toBe(401); expect(parsed).toBe(0);
  const pair = runtime.store.pair('a', { accountId: 'a', username: 'a', role: 'user', sessionId: 'a', sessionExpiresAt: Date.now() + 100000 }); const token = runtime.store.confirm({ code: pair.code, extensionOrigin: origin }).token;
  const headers = { origin, authorization: `Bearer ${token}` };
  expect((await request('POST', '/api/library/ingest', undefined, { text: 'active token' }, headers, false, gated)).status).toBe(200); expect(parsed).toBe(1);
  active.delete('a');
  try { expect((await request('POST', '/api/library/ingest', undefined, { text: 'inactive' }, headers, false, gated)).status).toBe(401); expect(parsed).toBe(1); }
  finally { active.add('a'); }
});
it('rejects consumed and expired pairing codes over the HTTP handlers', async () => {
  const pair = await request('POST', '/api/library/pair', 'a', {}); const body = { code: pair.json.code, extensionOrigin: origin };
  expect((await request('POST', '/api/library/pair/confirm', undefined, body, { origin })).status).toBe(200);
  expect((await request('POST', '/api/library/pair/confirm', undefined, body, { origin })).status).toBe(401);
  const expired = await request('POST', '/api/library/pair', 'a', {}); db.prepare('UPDATE studio_library_pairing SET expires_at=0').run();
  expect((await request('POST', '/api/library/pair/confirm', undefined, { ...body, code: expired.json.code }, { origin })).status).toBe(401);
  expect((await request('POST', '/api/library/pair/confirm', undefined, body, { origin: 'https://studio.example' })).status).toBe(403);
});
it('enforces closed capture scope, decoded size and persistent account rate ceilings over HTTP', async () => {
  expect((await request('POST', '/api/library/ingest', 'a', { text: 'scope', ownerAccountId: 'b' })).status).toBe(400);
  expect((await request('POST', '/api/library/ingest', 'a', { text: 'metadata', sourceTitle: 'x'.repeat(4097) })).status).toBe(400);
  expect((await request('POST', '/api/library/ingest', 'a', { text: 'x'.repeat(3 * 1024 * 1024 + 1) })).status).toBe(413);
  let limited = false;
  for (let i = 0; i < 61; i++) {
    const response = await request('POST', '/api/library/ingest', 'a', { text: 'HTTP_RATE_A' });
    if (response.status === 429) { limited = true; break; }
    expect(response.status, response.text).toBe(200);
  }
  expect(limited).toBe(true);
  expect((await request('POST', '/api/library/ingest', 'b', { text: 'HTTP_RATE_B' })).status).toBe(200);
});
it('refuses oversized cookie captures before parsing or taking a rate slot', async () => {
  const gated = express(); let parsed = 0;
  const actor = { accountId: 'admin', username: 'admin', role: 'admin' as const, sessionId: 'admin', sessionExpiresAt: Infinity };
  gated.use(createMultiUserGate({ auth: { resolveSession: () => actor, isActorCurrent: () => true }, allowedOrigins: [], isProjectOwner: () => false,
    libraryIngestAdmission: (owner) => runtime.store.admitIngest(owner!) }));
  gated.use((_req, _res, next) => { parsed++; next(); }); gated.use(express.json({ limit: '128mb' }));
  gated.post('/api/library/ingest', (_req, res) => res.json({ reached: true }));
  const response = await request('POST', '/api/library/ingest', undefined, { text: 'x'.repeat(9 * 1024 * 1024) }, { cookie: `__Host-od_session=${'x'.repeat(43)}` }, false, gated);
  expect(response.status).toBe(413); expect(parsed).toBe(0);
  expect(db.prepare('SELECT * FROM studio_library_rate WHERE owner_account_id=?').get('admin')).toBeUndefined();
});
it('shares pre-parser rate and in-flight limits across cookie and token requests and releases every exit', async () => {
  const gated = express(); let parsed = 0;
  const actor = { accountId: 'admin', username: 'admin', role: 'admin' as const, sessionId: 'admin', sessionExpiresAt: Date.now() + 60000 };
  db.prepare('DELETE FROM studio_library_rate WHERE owner_account_id=?').run('admin');
  const token = runtime.store.confirm({ code: runtime.store.pair('admin', actor).code, extensionOrigin: origin }).token;
  gated.use(createMultiUserGate({ auth: { resolveSession: () => actor, isActorCurrent: () => true }, allowedOrigins: [], isProjectOwner: () => false,
    libraryTokenCurrent: (value, source) => runtime.store.tokenOwner(value, source) !== null,
    libraryIngestAdmission: (owner, value, source) => runtime.store.admitIngest(owner ?? runtime.store.tokenOwner(value, source)!) }));
  gated.use((_req, _res, next) => { parsed++; next(); }); gated.use(express.json({ limit: '8mb' })); gated.use(createMultiUserBodyErrorHandler());
  gated.post('/api/library/ingest', (req, res) => { if (req.body?.hold) res.write('holding'); else res.status(req.body?.fail ? 400 : 200).json({ reached: true }); });
  const cookie = { cookie: `__Host-od_session=${'x'.repeat(43)}` }; const extension = { origin, authorization: `Bearer ${token}` };
  for (const exit of ['finish', 'close', 'aborted']) {
    const first = await request('POST', '/api/LIBRARY/ingest', undefined, { hold: true }, cookie, true, gated);
    const second = await request('POST', '/api/library/ingest/', undefined, { hold: true }, extension, true, gated);
    expect(first.status).toBe(200); expect(second.status).toBe(200);
    const count = parsed;
    expect((await request('POST', '/api/library/ingest', undefined, {}, cookie, false, gated)).status).toBe(429); expect(parsed).toBe(count);
    if (exit === 'aborted') first.req.emit('aborted'); else first.res.emit(exit);
    expect((await request('POST', '/api/library/ingest', undefined, { fail: true }, cookie, false, gated)).status).toBe(400);
    first.res.end(); second.res.end();
  }
  expect((await request('POST', '/api/library/ingest', undefined, undefined, cookie, false, gated, '{broken')).status).toBe(400);
  const first = runtime.store.admitIngest('admin'); const second = runtime.store.admitIngest('admin'); first(); second();
  db.prepare('UPDATE studio_library_rate SET count=60 WHERE owner_account_id=?').run('admin'); const count = parsed;
  expect((await request('POST', '/api/library/ingest', undefined, { text: 'never parsed' }, cookie, false, gated)).status).toBe(429);
  expect(parsed).toBe(count); expect((db.prepare('SELECT count FROM studio_library_rate WHERE owner_account_id=?').get('admin') as { count: number }).count).toBe(60);
});
it('throttles pairing exchanges before parsing and before any token is minted', async () => {
  const gated = express(); let parsed = 0;
  gated.use(createMultiUserGate({ auth: { resolveSession: () => null, isActorCurrent: () => false }, allowedOrigins: [], isProjectOwner: () => false,
    libraryPairAdmission: (source) => runtime.store.admitPair(source) }));
  gated.use((_req, _res, next) => { parsed++; next(); }); gated.use(express.json());
  registerStudioLibraryRoutes(gated, { db, dataRoot: root, projectsRoot: path.join(root, 'projects'), accountActive: (id) => active.has(id), sessionCurrent: () => true });
  for (let i = 0; i < 60; i++) expect((await request('POST', ['/api/library/pair/confirm', '/api/LIBRARY/pair/confirm', '/api/library/pair/confirm/'][i % 3]!, undefined, { code: 'wrong', extensionOrigin: origin }, { origin }, false, gated)).status).toBe(401);
  expect((await request('POST', '/api/library/pair/confirm', undefined, { code: 'wrong', extensionOrigin: origin }, { origin }, false, gated)).status).toBe(429);
  expect(parsed).toBe(60); expect(runtime.store.connection('admin').tokens).toHaveLength(1);
});
it('answers token authority loss with 401 before commit and success after commit without hanging', async () => {
  const actor = { accountId: 'b', username: 'b', role: 'user' as const, sessionId: 'b', sessionExpiresAt: Date.now() + 60000 };
  const original = runtime.store.ingest.bind(runtime.store);
  for (const afterCommit of [false, true]) {
    const token = runtime.store.confirm({ code: runtime.store.pair('b', actor).code, extensionOrigin: origin }).token;
    const id = runtime.store.connection('b').tokens.at(-1)!.id;
    const text = `authority-race-${afterCommit}`;
    vi.spyOn(runtime.store, 'ingest').mockImplementationOnce(async (...args) => {
      if (!afterCommit) runtime.store.revoke('b', id);
      const committed = await original(...args);
      if (afterCommit) runtime.store.revoke('b', id);
      return committed;
    });
    try {
      const response = await request('POST', '/api/library/ingest', undefined, { text, sourceTitle: text }, { origin, authorization: `Bearer ${token}` });
      expect(response.status, response.text).toBe(afterCommit ? 200 : 401);
      expect((await runtime.store.list('b', { q: text })).length).toBe(afterCommit ? 1 : 0);
    } finally { vi.restoreAllMocks(); }
  }
});
it.each(['logout', 'rotate', 'own revoke', 'admin revoke', 'reset', 'setup reset', 'own password', 'deactivate'] as const)(
  'uses the real auth registrar and existing revocation hook for %s', async (action) => {
    const authRoot = mkdtempSync(path.join(root, 'auth-lifecycle-')); const authStore = AuthStore.open({ dataRoot: authRoot });
    const auth = new AuthService({ store: authStore, passwordParams: FAST_TEST_SCRYPT_PARAMS }); const server = express();
    let library: ReturnType<typeof registerStudioLibraryRoutes>; const reasons: AuthSessionRevocationReason[] = [];
    server.use(createMultiUserGate({ auth, allowedOrigins: ['https://studio.example'], isProjectOwner: () => false,
      libraryTokenCurrent: (value, source) => library.store.tokenOwner(value, source) !== null,
      libraryPairAdmission: (source) => library.store.admitPair(source),
      libraryIngestAdmission: (owner, value, source) => library.store.admitIngest(owner ?? library.store.tokenOwner(value, source)!) }));
    registerAuthRoutes(server, { auth, bootstrapSecret: 'fixture-bootstrap-secret-0123456789', allowedOrigins: ['https://studio.example'],
      onAccountSessionsRevoked: (id, reason) => { reasons.push(reason); library.store.invalidateAccount(id, reason === 'password-reset' || reason === 'sessions-revoked'); } });
    server.use(express.json({ limit: '8mb' }));
    library = registerStudioLibraryRoutes(server, { db, dataRoot: root, projectsRoot: path.join(root, 'projects'), accountActive: (id) => authStore.getAccountById(id)?.active === true, sessionCurrent: (actor) => auth.isActorCurrent(actor) });
    const call = (route: string, body?: unknown, cookie?: string, method = 'POST', token?: string) => request(method, route, undefined, body,
      token ? { origin, authorization: `Bearer ${token}` } : cookie ? { cookie } : {}, false, server);
    const cookieOf = (response: Awaited<ReturnType<typeof call>>) => String(response.res.getHeader('set-cookie')).split(';')[0];
    const exchange = (code: string) => call('/api/library/pair/confirm', { code, extensionOrigin: origin });
    try {
      expect((await call('/api/auth/bootstrap', { bootstrapToken: 'fixture-bootstrap-secret-0123456789', username: 'admin', password: 'fixture-admin-password-A1!' })).status).toBe(201);
      const adminCookie = cookieOf(await call('/api/auth/login', { username: 'admin', password: 'fixture-admin-password-A1!' }));
      const created = await call('/api/auth/users', { username: 'owner', password: 'fixture-owner-password-A1!', role: action === 'own revoke' ? 'admin' : 'user' }, adminCookie);
      expect(created.status, created.text).toBe(201); const accountId = created.json.account.id;
      const revisionOf = async () => {
        const users = await call('/api/auth/users', undefined, adminCookie, 'GET'); expect(users.status).toBe(200);
        const revision = users.json.accounts.find((entry: { id: string }) => entry.id === accountId).updatedAt; expect(Number.isSafeInteger(revision)).toBe(true); return revision as number;
      };
      let password = 'fixture-owner-password-A1!'; let cookie = cookieOf(await call('/api/auth/login', { username: 'owner', password }));
      const token = (await exchange((await call('/api/library/pair', {}, cookie)).json.code)).json.token;
      const pending = (await call('/api/library/pair', {}, cookie)).json.code; let setup: string | undefined;
      if (action === 'logout') expect((await call('/api/auth/logout', {}, cookie)).status).toBe(204);
      if (action === 'rotate') expect((await call('/api/auth/session/rotate', {}, cookie)).status).toBe(200);
      if (action === 'own revoke' || action === 'admin revoke') expect((await call(`/api/auth/users/${accountId}/sessions/revoke`, {}, action === 'own revoke' ? cookie : adminCookie)).status).toBe(200);
      if (action === 'reset' || action === 'setup reset') {
        password = 'fixture-reset-password-B2!'; const revision = await revisionOf();
        const reset = await call(`/api/auth/users/${accountId}/password`, { revision, ...(action === 'reset' ? { password } : {}) }, adminCookie);
        expect(reset.status, reset.text).toBe(action === 'reset' ? 204 : 201); setup = reset.json?.setup?.token;
      }
      if (action === 'own password') {
        password = 'fixture-own-password-C3!'; expect((await call('/api/auth/password', { currentPassword: 'fixture-owner-password-A1!', newPassword: password }, cookie)).status).toBe(200);
      }
      if (action === 'deactivate') expect((await call(`/api/auth/users/${accountId}`, { active: false, revision: await revisionOf() }, adminCookie, 'PATCH')).status).toBe(200);
      expect((await exchange(pending)).status).toBe(401);
      expect((await call('/api/library/ingest', { text: 'existing token' }, undefined, 'POST', token)).status).toBe(action === 'logout' || action === 'rotate' ? 200 : 401);
      expect(reasons.at(-1)).toBe(action === 'rotate' ? undefined : action === 'logout' ? 'logout' : action === 'own revoke' || action === 'admin revoke' ? 'sessions-revoked' : action === 'deactivate' ? 'account-changed' : 'password-reset');
      if (action === 'deactivate') {
        expect((await call(`/api/auth/users/${accountId}`, { active: true, revision: await revisionOf() }, adminCookie, 'PATCH')).status).toBe(200);
        expect((await call('/api/library/ingest', { text: 'reactivated token' }, undefined, 'POST', token)).status).toBe(200);
      }
      if (setup) expect((await call('/api/auth/setup', { token: setup, password })).status).toBe(200);
      cookie = cookieOf(await call('/api/auth/login', { username: 'owner', password })); expect((await exchange(pending)).status).toBe(401);
      expect((await call('/api/library/ingest', { text: 'old token after reauthentication' }, undefined, 'POST', token)).status).toBe(action === 'logout' || action === 'rotate' || action === 'deactivate' ? 200 : 401);
      const fresh = await exchange((await call('/api/library/pair', {}, cookie)).json.code); expect(fresh.status, fresh.text).toBe(200);
      expect((await call('/api/library/ingest', { text: 'fresh token' }, undefined, 'POST', fresh.json.token)).status).toBe(200);
      const connection = await call('/api/library/connection', undefined, cookie, 'GET'); expect(connection.text).not.toContain(fresh.json.token);
    } finally { authStore.close(); }
  },
);
