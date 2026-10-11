import express from 'express';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { openDatabase, closeDatabase, insertProject } from '../../src/db.js';
import { ProjectAccessStore } from '../../src/storage/project-access.js';
import { bindMultiUserActor, createMultiUserGate } from '../../src/http/multiuser-gate.js';
import { setMultiUserStreamAuthority } from '../../src/http/multiuser-stream.js';
import { registerStudioLibraryRoutes } from '../../src/routes/studio-library.js';
import { toolTokenRegistry } from '../../src/tool-tokens.js';
let app: express.Express; let runtime: ReturnType<typeof registerStudioLibraryRoutes>; let root: string; let access: ProjectAccessStore;
let db: ReturnType<typeof openDatabase>; const active = new Set(['a', 'b', 'admin']); const origin = 'chrome-extension://abc';
/** Runs Express's actual HTTP handlers with Node request/response objects. No listener or socket is opened. */
function request(method: string, url: string, actor?: string, body?: unknown, headers: Record<string, string> = {}, streaming = false, server: express.Express = app) {
  const req = new IncomingMessage(new Socket()); req.method = method; req.url = url; req.headers = { host: 'test.invalid', ...headers };
  if (actor) req.headers['test-actor'] = actor;
  const payload = body === undefined ? '' : JSON.stringify(body); if (payload) { req.headers['content-type'] = 'application/json'; req.headers['content-length'] = String(Buffer.byteLength(payload)); }
  const res = new ServerResponse(req); const chunks: string[] = [];
  return new Promise<{ status: number; json: any; text: string; res: ServerResponse; chunks: string[] }>((resolve, reject) => {
    const result = () => { const text = chunks.join(''); let json = null; try { json = JSON.parse(text); } catch {} return { status: res.statusCode, json, text, res, chunks }; };
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
  runtime = registerStudioLibraryRoutes(app, { db, dataRoot: root, projectsRoot: path.join(root, 'projects'), accountActive: (id) => active.has(id) });
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
it('binds tool search/apply to the live run owner and refuses forged scope, cancellation and revocation', async () => {
  const id = await asset('a', 'TOOL_A'); const foreign = await asset('b', 'TOOL_B'); const projectId = randomUUID(); const now = Date.now();
  insertProject(db, { id: projectId, name: 'run', skillId: null, designSystemId: null, metadata: {}, pendingPrompt: null, createdAt: now, updatedAt: now });
  access.ownership.bindOwner(projectId, 'a', now); mkdirSync(path.join(root, 'projects', projectId), { recursive: true });
  db.prepare('INSERT INTO multiuser_runs VALUES (?, ?, ?, ?)').run('run-a', 'a', projectId, 'active');
  const grant = toolTokenRegistry.mint({ runId: 'run-a', projectId, studioLibrary: { ownerAccountId: 'a' } }); const headers = { authorization: `Bearer ${grant.token}` };
  const search = await request('POST', '/api/tools/library/search', 'b', { query: 'TOOL' }, headers); expect(search.status, search.text).toBe(200);
  expect(search.text).toContain(id); expect(search.text).not.toContain(foreign);
  expect((await request('POST', '/api/tools/library/apply', undefined, { assetId: foreign }, headers)).status).toBe(404);
  expect((await request('POST', '/api/tools/library/apply', undefined, { assetId: id, projectId: 'b' }, headers)).status).toBe(400);
  expect((await request('POST', '/api/tools/library/apply', undefined, { assetId: id }, headers)).status).toBe(200);
  db.prepare("UPDATE multiuser_runs SET status='canceled'").run(); expect((await request('POST', '/api/tools/library/search', undefined, {}, headers)).status).toBe(404);
  toolTokenRegistry.revokeToken(grant.token); expect((await request('POST', '/api/tools/library/search', undefined, {}, headers)).status).toBe(401);
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
    libraryTokenCurrent: (token, extensionOrigin) => runtime.store.tokenOwner(token, extensionOrigin) !== null }));
  gated.use((_req, _res, next) => { parsed++; next(); }); gated.use(express.json({ limit: '128mb' }));
  registerStudioLibraryRoutes(gated, { db, dataRoot: root, projectsRoot: path.join(root, 'projects'), accountActive: (id) => active.has(id) });
  const invalid = await request('POST', '/api/library/ingest', undefined, { text: 'never parsed' }, { origin, authorization: 'Bearer invalid' }, false, gated);
  expect(invalid.status).toBe(401); expect(parsed).toBe(0);
  const pair = runtime.store.pair('a'); const token = runtime.store.confirm({ code: pair.code, extensionOrigin: origin }).token;
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
