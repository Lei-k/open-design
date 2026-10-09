import fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { Express, Request, Response } from 'express';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openDatabase, closeDatabase } from '../../src/db.js';
import { internalMultiUserResponse } from '../../src/http/multiuser-internal.js';
import { registerStudioLiveArtifactRoutes } from '../../src/routes/studio-live-artifacts.js';
import { StudioLiveArtifacts } from '../../src/storage/studio-live-artifacts.js';
import { AuthStore } from '../../src/storage/auth-store.js';
import { ProjectAccessStore } from '../../src/storage/project-access.js';
import { projectDir } from '../../src/projects.js';
import { matchMultiUserRoute } from '../../src/http/multiuser-route-classes.js';
import { multiUserBodyAllowed } from '../../src/http/multiuser-gate.js';
import { createStudioLiveArtifactTools } from '../../src/live-artifacts/studio-tools.js';
import { CompanyOpenAIWorker, runCompanyOpenAITurn } from '../../src/runtimes/company-openai.js';
import { PersonalRunEvents } from '../../src/runtimes/personal-run-events.js';
import { runSseEventToPersistedAgentEvent } from '../../src/runtimes/chat-run-messages.js';

let root: string; let projects: string; let directory: string; let db: Database.Database; let access: ProjectAccessStore;
let store: StudioLiveArtifacts; let closeService: () => void; let auth: AuthStore; let clock: number; let inactive: Set<string>; let events: unknown[];
const routes = new Map<string, (req: Request, res: Response) => unknown>();
const draft = () => ({ input: { title: 'Sales', preview: { type: 'html', entry: 'index.html' },
  document: { format: 'html_template_v1', templatePath: 'template.html', generatedPreviewPath: 'index.html', dataPath: 'data.json',
    dataJson: { total: 3 }, sourceJson: { type: 'local_file', input: { path: 'sales.json' }, refreshPermission: 'manual_refresh_granted_for_read_only' } } },
  templateHtml: '<h1>{{data.total}}</h1>' });
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-live-artifact-')); projects = path.join(root, 'projects'); fs.mkdirSync(projects);
  db = openDatabase(root, { dataDir: root }); clock = Date.now(); auth = AuthStore.open({ dataRoot: root });
  for (const id of ['A', 'B', 'admin']) {
    auth.insertAccount({ id, username: id.toLowerCase(), passwordHash: '', passwordState: 'set', active: true, role: id === 'admin' ? 'admin' : 'user', createdAt: clock, updatedAt: clock });
    auth.insertSession({ id: id + '-session', accountId: id, tokenHash: id + '-digest', createdAt: clock, lastSeenAt: clock, expiresAt: clock + 3600_000 });
  }
  inactive = new Set(); events = []; routes.clear();
  access = new ProjectAccessStore(db, { accountActive: (id) => !inactive.has(id) });
  for (const [id, owner] of [['project', 'A'], ['foreign', 'B']]) {
    db.prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(id, id, 1, 1);
    access.ownership.bindOwner(id!, owner!, 1);
  }
  directory = projectDir(projects, 'project'); fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, 'sales.json'), '{"total":8}');
  const app = Object.fromEntries(['get', 'post', 'patch', 'delete'].map((method) => [method,
    (url: string, handler: (req: Request, res: Response) => unknown) => routes.set(`${method.toUpperCase()} ${url}`, handler)])) as unknown as Express;
  const service = registerStudioLiveArtifactRoutes(app, { db, projectsRoot: projects, dataRoot: root, previewOrigin: 'https://preview.test', allowedOrigins: ['https://app.test'], clock: () => clock, accountActive: (id) => !inactive.has(id),
    onChanged: (...event) => { events.push(event); } }); store = service; closeService = () => service.close();
});
afterEach(() => { closeService?.(); auth?.close(); closeDatabase(); fs.rmSync(root, { recursive: true, force: true }); });
async function call(method: string, suffix = '', body?: unknown, actor = 'A', projectId = 'project', id = '', query = {}) {
  const response = internalMultiUserResponse({ accountId: actor, username: actor, role: actor === 'admin' ? 'admin' : 'user',
    sessionId: actor + '-session', sessionExpiresAt: clock + 3600_000 }, () => !inactive.has(actor));
  const headers: Record<string, string> = {};
  response.res.set = ((name: string | Record<string, string>, value?: string) => {
    for (const [key, item] of typeof name === 'string' ? [[name, value!]] : Object.entries(name)) headers[key!.toLowerCase()] = item!;
    return response.res;
  }) as Response['set'];
  const endpoint = suffix === '/capability' ? 'GET /api/multiuser/live-artifact-preview/:scope' : `${method} /api/multiuser/live-artifacts${suffix}`;
  await routes.get(endpoint)!({ params: { artifactId: id, scope: id }, query: { projectId, ...query }, body } as unknown as Request, response.res);
  return { ...response.result()!, headers } as { status: number; body: any; headers: Record<string, string> };
}
const create = async () => (await call('POST', '', draft())).body.artifact;

it('uses one session route for the viewer and CLI while refusing host worker tokens', () => {
  for (const prefix of ['/api/live-artifacts', '/api/multiuser/live-artifacts']) {
    expect(matchMultiUserRoute('GET', prefix)[0]?.entry.routeClass).toBe('actor-scoped');
    expect(matchMultiUserRoute('POST', prefix)[0]?.entry.bodyPolicy).toBe('studio-live-artifact');
  }
  expect(matchMultiUserRoute('POST', '/api/tools/live-artifacts/create')[0]?.entry.routeClass).toBe('blocked-in-multiuser');
  expect(multiUserBodyAllowed('studio-live-artifact', draft())).toBe(true);
  expect(multiUserBodyAllowed('studio-live-artifact', { ...draft(), projectId: 'foreign' })).toBe(false);
});
it('creates, lists, edits, previews and deletes a database-backed document', async () => {
  const artifact = await create(); expect(artifact.projectId).toBe('project'); expect(artifact.refreshStatus).toBe('never');
  expect((await call('GET')).body.artifacts).toEqual([expect.objectContaining({ id: artifact.id, hasDocument: true })]);
  expect((await call('PATCH', '/:artifactId', { title: 'Renamed', pinned: true }, 'A', 'project', artifact.id)).body.artifact.title).toBe('Renamed');
  expect(store.code('project', artifact.id, 'rendered')).toBe('<h1>3</h1>');
  expect(fs.existsSync(path.join(directory, '.live-artifacts'))).toBe(false);
  expect((await call('DELETE', '/:artifactId', undefined, 'A', 'project', artifact.id)).status).toBe(200);
  expect((await call('GET', '/:artifactId', undefined, 'A', 'project', artifact.id)).status).toBe(404);
  expect(events).toHaveLength(3);
});
it.each(['B', 'admin'])('keeps missing and foreign documents indistinguishable for %s', async (actor) => {
  const artifact = await create();
  for (const [method, suffix, body] of [['GET', '/:artifactId'], ['GET', '/:artifactId/preview'], ['GET', '/:artifactId/refreshes'],
    ['PATCH', '/:artifactId', { title: 'Stolen' }], ['DELETE', '/:artifactId'], ['POST', '/:artifactId/refresh']] as const) {
    expect(await call(method, suffix, body, actor, 'project', artifact.id)).toEqual(await call(method, suffix, body, actor, 'missing', artifact.id));
    expect((await call(method, suffix, body, actor, 'project', artifact.id)).status).toBe(404);
  }
  expect(store.read('project', artifact.id).title).toBe('Sales');
});
it.each(['view', 'comment', 'edit'] as const)('enforces shared %s access at every operation', async (role) => {
  const artifact = await create(); access.setGrant('project', 'B', role, 1);
  expect((await call('GET', '/:artifactId', undefined, 'B', 'project', artifact.id)).status).toBe(200);
  expect((await call('POST', '/:artifactId/refresh', undefined, 'B', 'project', artifact.id)).status).toBe(role === 'edit' ? 200 : 404);
  expect((await call('POST', '', draft(), 'B')).status).toBe(role === 'edit' ? 201 : 404);
  access.removeGrant('project', 'B'); expect((await call('GET', '', undefined, 'B')).status).toBe(404);
});
it.each(['A', 'B'])('withdraws all reads when account %s is disabled', async (id) => {
  const artifact = await create(); access.setGrant('project', 'B', 'edit', 1); inactive.add(id);
  expect((await call('GET', '/:artifactId', undefined, 'B', 'project', artifact.id)).status).toBe(404);
  expect((await call('POST', '/:artifactId/refresh', undefined, 'B', 'project', artifact.id)).status).toBe(404);
});
it('refreshes canonical data and retains documents/history across a store restart', async () => {
  const artifact = await create(); const result = await call('POST', '/:artifactId/refresh', undefined, 'A', 'project', artifact.id);
  expect(result.status).toBe(200); expect(result.body.artifact.document.dataJson).toEqual({ total: 8 });
  store = new StudioLiveArtifacts(db, projects);
  expect(store.code('project', artifact.id, 'rendered')).toBe('<h1>8</h1>');
  expect(store.history('project', artifact.id)).toEqual([expect.objectContaining({ status: 'succeeded', artifactId: artifact.id })]);
  store.delete('project', artifact.id);
  expect(db.prepare('SELECT count(*) AS n FROM studio_live_artifact_refreshes').get()).toEqual({ n: 0 });
});
it.each(['symlink', 'hardlink', 'invalid-json', 'invalid-utf8', 'sensitive-data', 'oversized', 'missing'])('retains the previous snapshot on %s refresh refusal', async (kind) => {
  const artifact = await create(); const source = path.join(directory, 'sales.json'); fs.unlinkSync(source);
  const outside = path.join(root, 'private.json'); fs.writeFileSync(outside, '{"total":1234}');
  if (kind === 'symlink') fs.symlinkSync(outside, source);
  else if (kind === 'hardlink') fs.linkSync(outside, source);
  else if (kind === 'invalid-json') fs.writeFileSync(source, 'invalid');
  else if (kind === 'invalid-utf8') fs.writeFileSync(source, Buffer.concat([Buffer.from('{"total":"'), Buffer.from([0xff]), Buffer.from('"}')]));
  else if (kind === 'sensitive-data') fs.writeFileSync(source, '{"authorization":"PRIVATE"}');
  else if (kind === 'oversized') fs.writeFileSync(source, ' '.repeat(256 * 1024 + 1));
  const result = await call('POST', '/:artifactId/refresh', undefined, 'A', 'project', artifact.id);
  expect(result.status).toBe(409); expect(JSON.stringify(result)).not.toContain('1234'); expect(JSON.stringify(result)).not.toContain(root);
  expect(store.read('project', artifact.id).document.dataJson).toEqual({ total: 3 });
  expect(store.code('project', artifact.id, 'rendered')).toBe('<h1>3</h1>'); expect(store.history('project', artifact.id)[0]?.status).toBe('failed');
});
it('refuses unsupported host sources, escaped paths, executable templates and forged ownership before storage', async () => {
  const variants = [ { ...draft(), templateHtml: '<script>alert(1)</script>' }, { ...draft(), templateHtml: 'x'.repeat(64 * 1024 + 1) },
    { ...draft(), input: { ...draft().input, projectId: 'foreign' } },
    ...['../private.json', '.secrets/config.json', '/tmp/private.json'].map((file) => { const value = draft(); value.input.document.sourceJson.input.path = file; return value; }),
    ...['daemon_tool', 'connector_tool'].map((type) => { const value = draft(); value.input.document.sourceJson.type = type; return value; }) ];
  for (const value of variants) expect([400, 413]).toContain((await call('POST', '', value)).status);
  expect(store.list('project')).toEqual([]);
});
it('refuses oversized rendered output during create and retains the last good snapshot during refresh', async () => {
  const value = draft(); value.templateHtml = '{{data.total}}'.repeat(132);
  const large = '字'.repeat(5500);
  const tooLarge = { ...value, input: { ...value.input, document: { ...value.input.document, dataJson: { total: large } } } };
  expect((await call('POST', '', tooLarge)).status).toBe(413);
  expect(store.list('project')).toEqual([]);
  const artifact = (await call('POST', '', value)).body.artifact;
  fs.writeFileSync(path.join(directory, 'sales.json'), JSON.stringify({ total: large }));
  expect((await call('POST', '/:artifactId/refresh', undefined, 'A', 'project', artifact.id)).status).toBe(409);
  expect(store.read('project', artifact.id).document.dataJson).toEqual({ total: 3 });
  expect(store.code('project', artifact.id, 'rendered')).toBe('3'.repeat(132));
  expect(store.history('project', artifact.id)).toEqual([expect.objectContaining({ status: 'failed' })]);
});
it('renders escaped data with a network-denying opaque-origin CSP and plaintext source', async () => {
  const value = draft(); value.input.document.dataJson.total = '<img src=x onerror=alert(1)>' as unknown as number;
  const artifact = (await call('POST', '', value)).body.artifact;
  const preview = await call('GET', '/:artifactId/preview', undefined, 'A', 'project', artifact.id);
  expect(preview.status).toBe(302); expect(preview.headers.location).toMatch(/^https:\/\/preview.test\/api\/multiuser\/live-artifact-preview\//);
  const scope = preview.headers.location!.split('/').pop()!;
  const rendered = await call('GET', '/capability', undefined, 'A', 'project', scope);
  expect(rendered.status).toBe(200); expect(rendered.body).toBe('<h1>&lt;img src=x onerror=alert(1)&gt;</h1>');
  expect(rendered.headers['content-security-policy']).toContain("sandbox; default-src 'none'");
  expect(rendered.headers['content-security-policy']).not.toContain('allow-scripts');
  const code = await call('GET', '/:artifactId/preview', undefined, 'A', 'project', artifact.id, { variant: 'template' });
  expect(code.headers['content-type']).toContain('text/plain'); expect(code.body).toBe(value.templateHtml);
});
it('bounds history and cascades project deletion without leaving worker-readable files', async () => {
  const artifact = await create(); for (let i = 0; i < 105; i++) store.refresh('project', artifact.id);
  expect(store.history('project', artifact.id)).toHaveLength(100);
  db.prepare('DELETE FROM projects WHERE id = ?').run('project');
  expect(db.prepare('SELECT count(*) AS n FROM studio_live_artifacts').get()).toEqual({ n: 0 });
  expect(db.prepare('SELECT count(*) AS n FROM studio_live_artifact_refreshes').get()).toEqual({ n: 0 });
});

it.each(['logout', 'session-expiry', 'scope-expiry', 'disable-owner', 'revoke-grant', 'delete-artifact', 'restart'])(
  'revokes cookie-free preview capabilities on %s', async (change) => {
    const artifact = await create(); access.setGrant('project', 'B', 'view', 1);
    const redirect = await call('GET', '/:artifactId/preview', undefined, 'B', 'project', artifact.id);
    const scope = redirect.headers.location!.split('/').pop()!;
    // The opaque preview never needs the holder's cookie; the persisted issuing session owns it.
    expect((await call('GET', '/capability', undefined, 'admin', 'missing', scope)).status).toBe(200);
    if (change === 'logout') auth.deleteSession('B-session');
    if (change === 'session-expiry') { clock += 3600_000; }
    if (change === 'scope-expiry') { clock += 5 * 60_000; }
    if (change === 'disable-owner') inactive.add('A');
    if (change === 'revoke-grant') access.removeGrant('project', 'B');
    if (change === 'delete-artifact') store.delete('project', artifact.id);
    if (change === 'restart') closeService();
    expect((await call('GET', '/capability', undefined, 'B', 'project', scope)).status).toBe(404);
  });

it('refuses an invalid edit atomically and enforces the per-project document quota', async () => {
  const artifact = await create();
  expect((await call('PATCH', '/:artifactId', { input: { title: 'Rejected' }, expectedRevision: artifact.studioRevision, templateHtml: '<script>unsafe</script>' }, 'A', 'project', artifact.id)).status).toBe(400);
  expect(store.read('project', artifact.id).title).toBe('Sales');
  expect(store.code('project', artifact.id, 'template')).toBe(draft().templateHtml);
  for (let i = 1; i < 100; i++) store.create('project', draft());
  expect((await call('POST', '', draft())).status).toBe(409); expect(store.list('project')).toHaveLength(100);
});

it('refuses stale document edits after a manual refresh even within the same timestamp', async () => {
  const artifact = await create();
  const edit = { input: { document: { ...artifact.document, dataJson: { total: 99 } } }, templateHtml: '<h1>{{data.total}}</h1>', expectedRevision: artifact.studioRevision };
  store.refresh('project', artifact.id);
  expect((await call('PATCH', '/:artifactId', edit, 'A', 'project', artifact.id)).status).toBe(409);
  expect(store.read('project', artifact.id).document.dataJson).toEqual({ total: 8 });
  expect((await call('PATCH', '/:artifactId', { ...edit, expectedRevision: 2 }, 'A', 'project', artifact.id)).status).toBe(200);
  expect(store.read('project', artifact.id).studioRevision).toBe(3);
});

it('binds agent tools to their admitted project and lineage and rechecks authority before calls', async () => {
  let allowed = true;
  const tools = createStudioLiveArtifactTools({ store, projectId: 'project', conversationId: 'admitted-conversation', runId: 'admitted-run',
    authorized: () => allowed && access.canWrite('project', 'A'), onChanged: () => {} });
  const foreign = store.create('foreign', draft());
  expect(() => tools.execute('live_artifacts_read', { artifactId: foreign.id })).toThrow('resource not found');
  expect(() => tools.execute('live_artifacts_list', { projectId: 'foreign' })).toThrow('tool refused');
  const request = draft(); const input = { ...request.input, sessionId: 'foreign-conversation' };
  const saved = tools.execute('live_artifacts_create', { requestJson: JSON.stringify({ ...request, input }) }) as { artifact: any };
  expect(saved.artifact).toMatchObject({ projectId: 'project', sessionId: 'admitted-conversation', createdByRunId: 'admitted-run' });
  allowed = false; expect(() => tools.execute('live_artifacts_list', {})).toThrow('authority changed');
  expect(store.list('project')).toHaveLength(1);
});

it.each(['identity', 'compact_table', 'metric_summary'] as const)('refreshes with bounded %s output mapping and daemon-stamped source provenance', async (transform) => {
  const source = { type: 'local_file' as const, input: { path: 'sales.json' }, refreshPermission: 'manual_refresh_granted_for_read_only' as const,
    outputMapping: { dataPaths: [{ from: 'report', to: 'result' }], transform } };
  const value = { ...draft(), templateHtml: '<h1>Report</h1>', input: { ...draft().input, document: { ...draft().input.document, sourceJson: source } } };
  const artifact = (await call('POST', '', value)).body.artifact;
  expect(artifact.studioProvenance).toMatchObject({ origin: 'user' });
  const bytes = Buffer.from('{"report":{"label":"Sales","total":8}}'); fs.writeFileSync(path.join(directory, 'sales.json'), bytes);
  const refreshed = (await call('POST', '/:artifactId/refresh', undefined, 'A', 'project', artifact.id)).body.artifact;
  const expected = transform === 'identity' ? { result: { label: 'Sales', total: 8 } }
    : transform === 'compact_table' ? { columns: [], rows: [{}], count: 1, truncated: false }
    : { label: 'Sales', value: 8, source: { label: 'Sales', total: 8 } };
  expect(refreshed.document.dataJson).toEqual(expected);
  expect(refreshed.document.dataJson.total).toBeUndefined();
  expect(refreshed.studioProvenance).toMatchObject({ origin: 'project_file', source: { path: 'sales.json', bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') } });
  store = new StudioLiveArtifacts(db, projects);
  expect(store.read('project', artifact.id).studioProvenance).toEqual(refreshed.studioProvenance);
  fs.writeFileSync(path.join(directory, 'sales.json'), 'invalid');
  expect((await call('POST', '/:artifactId/refresh', undefined, 'A', 'project', artifact.id)).status).toBe(409);
  expect(store.read('project', artifact.id).studioProvenance).toEqual(refreshed.studioProvenance);
});

it('refuses forged provenance, prototype paths and sparse-array mappings before replacing accepted documents', async () => {
  const artifact = await create();
  for (const from of ['__proto__.value', 'constructor.prototype.value', 'rows.500.value', 'rows.4294967294.value']) {
    const document = { ...artifact.document, sourceJson: { ...artifact.document.sourceJson, outputMapping: { dataPaths: [{ from: 'total', to: from }] } } };
    expect((await call('PATCH', '/:artifactId', { input: { document }, expectedRevision: artifact.studioRevision }, 'A', 'project', artifact.id)).status).toBe(400);
  }
  for (const input of [{ ...draft().input, studioProvenance: { origin: 'project_file' } }, { ...draft().input, studioRevision: 123 }]) {
    expect((await call('POST', '', { ...draft(), input })).status).toBe(400);
  }
  expect(store.read('project', artifact.id)).toEqual(artifact);
});

it('retains provenance for metadata edits and stamps the admitted agent on document edits', async () => {
  const artifact = await create();
  const metadata = store.update('project', artifact.id, { input: { title: 'Renamed' } });
  expect(metadata.studioProvenance).toEqual(artifact.studioProvenance);
  const tools = createStudioLiveArtifactTools({ store, projectId: 'project', conversationId: 'conversation', runId: 'next-run', authorized: () => true, onChanged: () => {} });
  tools.execute('live_artifacts_update', { artifactId: artifact.id, requestJson: JSON.stringify({ input: {}, templateHtml: '<h1>Updated</h1>', expectedRevision: metadata.studioRevision }) });
  expect(store.read('project', artifact.id).studioProvenance).toMatchObject({ origin: 'agent', conversationId: 'conversation', runId: 'next-run' });
  expect(store.read('project', artifact.id).createdByRunId).toBeUndefined();
  expect(store.update('project', artifact.id, { input: {}, templateHtml: '<h1>Manual</h1>', expectedRevision: 3 }).studioProvenance).toMatchObject({ origin: 'user' });
});

it.each(['company_pool', 'personal_api_key'])('completes create/read/update/refresh and durable artifact cards on %s function calls', async (source) => {
  const persisted: unknown[] = []; let stage = 0; let id = '';
  const projection = new PersonalRunEvents(directory, [root], (event) => {
    const saved = runSseEventToPersistedAgentEvent(event.event, event.data); if (saved) persisted.push(saved);
  });
  const tools = createStudioLiveArtifactTools({ store, projectId: 'project', conversationId: 'conversation', runId: 'run', authorized: () => true,
    onChanged: (action, artifact) => projection.accept({ type: 'live_artifact', action, projectId: 'project', artifactId: artifact.id, title: artifact.title, refreshStatus: artifact.refreshStatus }) });
  const fn = (name: string, args: unknown) => ({ type: 'function_call', name, call_id: `call-${stage}-${name}`, arguments: JSON.stringify(args) });
  const completed = (output: unknown[]) => new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { output } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  const fetcher: typeof fetch = async (_url, init) => {
    expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${source}-fixture`);
    const body = JSON.parse(String(init?.body));
    expect(body.tools.filter((tool: any) => tool.name.startsWith('live_artifacts_'))).toHaveLength(5);
    if (stage++ === 0) return completed([fn('live_artifacts_create', { requestJson: JSON.stringify(draft()) })]);
    if (stage === 2) {
      const created = body.input.findLast((item: any) => item.type === 'function_call_output'); id = JSON.parse(created.output).artifact.id;
      return completed([fn('live_artifacts_read', { artifactId: id }), fn('live_artifacts_list', {}),
        fn('live_artifacts_update', { artifactId: id, requestJson: JSON.stringify({ input: { title: 'Updated by agent' }, expectedRevision: 1 }) })]);
    }
    if (stage === 3) return completed([fn('live_artifacts_refresh', { artifactId: id })]);
    return completed([]);
  };
  const result = await runCompanyOpenAITurn({ apiKey: `${source}-fixture`, model: 'fixture-model', prompt: 'Create a sales report', history: [],
    projectsRoot: projects, projectId: 'project', worker: new CompanyOpenAIWorker(), authorized: () => true, onAgentEvent: (event) => projection.accept(event),
    liveArtifacts: tools, fetch: fetcher });
  expect(result.ok).toBe(true); expect(store.read('project', id)).toMatchObject({ title: 'Updated by agent', studioRevision: 3,
    document: { dataJson: { total: 8 } }, refreshStatus: 'succeeded', createdByRunId: 'run' });
  expect(persisted.filter((event: any) => event.kind === 'live_artifact')).toEqual([
    expect.objectContaining({ action: 'created', artifactId: id }), expect.objectContaining({ action: 'updated', artifactId: id }),
    expect.objectContaining({ action: 'updated', artifactId: id, refreshStatus: 'succeeded' }),
  ]);
  expect(JSON.stringify(persisted)).not.toContain(`${source}-fixture`);
});
