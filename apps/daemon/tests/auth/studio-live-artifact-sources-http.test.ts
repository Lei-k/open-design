// S62 Part B (#63): Live Artifact refresh from the REFRESHING account's own
// connectors and remote MCP servers — actor-only, read-only source. Fixtures are
// programmatic loopback/fake providers only (testComposioFetch, testMcpOutbound,
// testCompanyOpenAIFetch); no real Composio, MCP server or OpenAI is contacted.
import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { cleanupIsolatedDataRoot, loadIsolatedServerModule, login, multiUserOptions, provisionAccounts, startMultiUserDaemon, MU_TEST_ORIGIN,
  type Principal, type StartedMultiUserDaemon } from './multiuser-harness.js';
import { encodedForms, MCP_HEADER_SENTINEL, startMcpFixture, type McpFixture } from './studio-mcp-fixture.js';
import { PERSONAL_CODEX_MOCK, linkCodex, setTurnMode, until } from './personal-codex-helpers.js';
import { toolTokenRegistry } from '../../src/tool-tokens.js';
import { CompanyComposioStore, StudioConnectorStore } from '../../src/storage/studio-connectors.js';
import { StudioMcpRuntime, studioMcpToolName } from '../../src/mcp-client/studio-runtime.js';
import { AuthStore } from '../../src/storage/auth-store.js';

const KEY = 's62_company_composio_key_0123456789';
let daemon: StartedMultiUserDaemon; let fixture: McpFixture; let root: string; let admin: Principal;
let owner: Principal; let editor: Principal; let viewer: Principal; let lonely: Principal;
let db: Database.Database; let connections: StudioConnectorStore; let company: CompanyComposioStore;
const logs: string[] = [];
type ComposioCall = { url: string; body: Record<string, unknown> };
const composioCalls: ComposioCall[] = [];
const composio = { holdExecute: false, releases: [] as Array<() => void>, data: null as unknown, writeTool: false };
const composioFetch: typeof fetch = async (url, init) => {
  const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
  composioCalls.push({ url: String(url), body });
  if (String(url).includes('/api/v3.1/tools?')) return Response.json({ items: [
    composio.writeTool ? { slug: 'HUBSPOT_CREATE_CONTACT', name: 'Create contact', toolkit: { slug: 'hubspot' }, tags: ['create'],
      input_parameters: { type: 'object', properties: {}, additionalProperties: true } }
      : { slug: 'HUBSPOT_GET_CONTACT', name: 'Get contact', toolkit: { slug: 'hubspot' }, scopes: ['read'],
        input_parameters: { type: 'object', properties: { id: { type: 'string' } }, additionalProperties: false } } ] });
  if (String(url).includes('/tools/execute/')) {
    if (composio.holdExecute) await new Promise<void>((resolve) => { composio.releases.push(resolve); });
    // The fixture answers with whose connection it was called (never a credential the daemon sent).
    return Response.json({ successful: true, data: composio.data ?? { total: 41, rows: [{ name: 'alpha' }], connection: body.connected_account_id, echoedKey: `x ${KEY} y` } });
  }
  return Response.json({ items: [] });
};
let openaiPlan: { artifactId: string | null; outputs: string[] } = { artifactId: null, outputs: [] };
const openai: typeof fetch = async (_url, init) => {
  const body = JSON.parse(String(init?.body));
  const outputs = (body.input as Array<Record<string, unknown>>).filter((item) => item.type === 'function_call_output');
  openaiPlan.outputs.push(...outputs.map((item) => String(item.output)));
  const output = !outputs.length && openaiPlan.artifactId
    ? [{ type: 'function_call', call_id: 'refresh', name: 'live_artifacts_refresh', arguments: JSON.stringify({ artifactId: openaiPlan.artifactId }) }]
    : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done' }] }];
  return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { output, usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`,
    { headers: { 'content-type': 'text/event-stream' } });
};
const call = (actor: Principal, method: string, p: string, body?: unknown) => daemon.request({ method, path: p, cookie: actor.cookie, headers: { origin: MU_TEST_ORIGIN }, ...(body !== undefined ? { body } : {}) });
async function fresh(prefix: string): Promise<Principal> {
  const username = `${prefix}-${randomUUID().slice(0, 8)}`; const password = `${username}-battery-staple-password`;
  const made = await call(admin, 'POST', '/api/auth/users', { username, password, role: 'user' }); expect(made.status).toBe(201);
  return { id: made.json.account.id, username, password, cookie: await login(daemon, username, password) };
}
const connect = (who: Principal, id = 'github') => connections.saveConnection(who.id, id, { providerConnectionId: `ca_${id}_${who.id}`, accountLabel: who.username,
  credentialRevision: company.read().credentialRevision });
const lookupTools = [{ name: 'lookup', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: { q: { type: 'string' } }, additionalProperties: false } }];
async function server(who: Principal, host: string, extra: Record<string, unknown> = {}) {
  const made = await call(who, 'POST', '/api/multiuser/mcp/servers', { id: 'mine', url: fixture.url('/runtime', host), headers: { 'X-Api-Key': MCP_HEADER_SENTINEL }, ...extra });
  expect(made.status, made.text).toBe(201);
}
let projectId = '';
const base = (suffix = '') => `/api/live-artifacts${suffix}?projectId=${encodeURIComponent(projectId)}`;
const document = (sourceJson: unknown) => ({ input: { title: 'Pipeline', preview: { type: 'html', entry: 'index.html' },
  document: { format: 'html_template_v1', templatePath: 'template.html', generatedPreviewPath: 'index.html', dataPath: 'data.json',
    dataJson: { total: 0 }, sourceJson } }, templateHtml: '<h1>{{data.total}}</h1>' });
const connectorSource = (tool = 'github.github_search_repositories', input: Record<string, unknown> = { query: 'open design' }) => ({ type: 'connector_tool',
  connector: { connectorId: tool.split('.')[0], toolName: tool }, input, refreshPermission: 'manual_refresh_granted_for_read_only',
  outputMapping: { dataPaths: [{ from: 'total', to: 'total' }] } });
const mcpSource = (extra: Record<string, unknown> = {}) => ({ type: 'mcp_tool', mcp: { serverId: 'mine', toolName: 'lookup', readOnlyConfirmed: true },
  input: { q: 'pipeline' }, refreshPermission: 'manual_refresh_granted_for_read_only', outputMapping: { dataPaths: [{ from: 'structuredContent.total', to: 'total' }] }, ...extra });
async function create(sourceJson: unknown, who = owner) {
  const made = await call(who, 'POST', base(), document(sourceJson)); expect(made.status, made.text).toBe(201); return made.json.artifact as { id: string; studioRevision: number };
}
const refresh = (who: Principal, id: string) => call(who, 'POST', base(`/${id}/refresh`));
const read = async (id: string) => (await call(owner, 'GET', base(`/${id}`))).json.artifact;
const history = async (id: string) => (await call(owner, 'GET', base(`/${id}/refreshes`))).json.refreshes as Array<Record<string, any>>;
const executes = () => composioCalls.filter((item) => item.url.includes('/tools/execute/'));
const mcpCalls = () => fixture.requests.filter((request) => request.body.includes('"tools/call"'));
const sourceAudit = (artifactId: string) => db.prepare('SELECT actor_account_id, source_kind, source_id, tool, outcome, duration_ms FROM studio_live_artifact_source_audit WHERE artifact_id = ? ORDER BY id').all(artifactId) as Array<Record<string, any>>;

beforeAll(async () => {
  ({ dataRoot: root } = await loadIsolatedServerModule()); fixture = await startMcpFixture();
  for (const level of ['log', 'info', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation((...values) => { logs.push(values.map(String).join(' ')); });
  daemon = await startMultiUserDaemon(multiUserOptions({ testComposioFetch: composioFetch, testCompanyOpenAIFetch: openai, testLiveArtifactSourceDeadlineMs: 1_500, testPersonalCodexAppServer: PERSONAL_CODEX_MOCK,
    testMcpOutbound: { resolve: fixture.resolve, allowAddress: fixture.allowAddress, timeoutMs: 10_000 } }));
  ({ admin } = await provisionAccounts(daemon, []));
  db = new Database(path.join(root, 'app.sqlite')); connections = new StudioConnectorStore(db); company = new CompanyComposioStore(db, root);
  company.update(admin.id, { revision: company.read().revision, apiKey: KEY });
  const cfg = await call(admin, 'GET', '/api/admin/pool/openai');
  expect((await call(admin, 'PUT', '/api/admin/pool/openai', { revision: cfg.json.provider.revision, apiKey: 'sk-S62-company-fixture-0123456789', model: 'fixture', enabled: true, capacity: 3 })).status).toBe(200);
}, 120_000);
beforeEach(async () => {
  owner = await fresh('s62o'); editor = await fresh('s62e'); viewer = await fresh('s62v'); lonely = await fresh('s62l');
  const made = await call(owner, 'POST', '/api/projects', { id: randomUUID(), name: 'S62' }); expect(made.status).toBe(200);
  projectId = made.json.project.id;
  for (const [who, role] of [[editor, 'edit'], [viewer, 'view'], [lonely, 'edit']] as const) {
    expect((await call(owner, 'PUT', `/api/multiuser/projects/${projectId}/shares`, { username: who.username, role })).status).toBe(200);
  }
  connect(owner); connect(editor);
  composioCalls.length = 0; fixture.requests.length = 0; logs.length = 0; openaiPlan = { artifactId: null, outputs: [] };
  Object.assign(composio, { holdExecute: false, data: null, writeTool: false });
  Object.assign(fixture.state, { tools: lookupTools, callJson: { content: [{ type: 'text', text: 'ok' }], structuredContent: { total: 7 } }, callText: null,
    echoSecrets: false, holdDiscovery: false, holdCall: false, sseComment: false });
});
afterEach(async () => {
  composio.holdExecute = false; for (const release of composio.releases.splice(0)) release();
  Object.assign(fixture.state, { holdDiscovery: false, holdCall: false });
  for (const release of fixture.state.releases.splice(0)) release();
});
afterAll(async () => { toolTokenRegistry.clear(); db?.close(); await daemon?.close(); await fixture?.close(); vi.restoreAllMocks(); cleanupIsolatedDataRoot(); });

// ---- connectors ----------------------------------------------------------------

it('S62 owner refresh reads the owner\'s own connector connection and stamps provenance, history and audit', async () => {
  const tokensBefore = toolTokenRegistry.activeTokenCount();
  const artifact = await create(connectorSource());
  const result = await refresh(owner, artifact.id); expect(result.status, result.text).toBe(200);
  expect(result.json.artifact.document.dataJson).toEqual({ total: 41 });
  expect(executes()).toHaveLength(1); expect(executes()[0]!.body.connected_account_id).toBe(`ca_github_${owner.id}`);
  const provenance = result.json.artifact.studioProvenance;
  expect(provenance).toMatchObject({ origin: 'connector', toolSource: { kind: 'connector', id: 'github', tool: 'github.github_search_repositories', actorAccountId: owner.id } });
  expect(provenance.toolSource.sha256).toMatch(/^[0-9a-f]{64}$/); expect(provenance.toolSource.bytes).toBeGreaterThan(0);
  expect((await history(artifact.id)).at(-1)).toMatchObject({ status: 'succeeded', studioSource: { kind: 'connector', id: 'github', tool: 'github.github_search_repositories' } });
  expect(sourceAudit(artifact.id)).toEqual([expect.objectContaining({ actor_account_id: owner.id, source_kind: 'connector', source_id: 'github', outcome: 'ok' })]);
  // The company key a provider echoes is never kept, and the descriptor stores ids only.
  const stored = JSON.stringify(db.prepare('SELECT artifact_json FROM studio_live_artifacts WHERE id = ?').get(artifact.id));
  expect(stored).not.toContain(KEY); expect(stored).not.toContain(`ca_github_${owner.id}`); expect(stored).not.toContain(owner.username);
  // Provenance hashes exactly the scrubbed output that was mapped (the echoed company key is already redacted).
  const mapped = JSON.stringify({ total: 41, rows: [{ name: 'alpha' }], connection: `ca_github_${owner.id}`, echoedKey: 'x [redacted] y' });
  expect(provenance.toolSource).toMatchObject({ bytes: Buffer.byteLength(mapped), sha256: createHash('sha256').update(mapped).digest('hex') });
  expect(() => db.prepare('DELETE FROM studio_live_artifact_source_audit').run()).toThrow('immutable');
  expect(toolTokenRegistry.activeTokenCount()).toBe(tokensBefore);
});

it('S62 a collaborator\'s refresh uses the collaborator\'s own connection, never the creator\'s', async () => {
  const artifact = await create(connectorSource());
  const result = await refresh(editor, artifact.id); expect(result.status, result.text).toBe(200);
  expect(executes().map((item) => item.body.connected_account_id)).toEqual([`ca_github_${editor.id}`]);
  expect(result.json.artifact.studioProvenance.toolSource.actorAccountId).toBe(editor.id);
});

it('S62 viewers cannot refresh, and an actor without a usable connection gets one non-enumerating refusal with data unchanged', async () => {
  const artifact = await create(connectorSource());
  const viewed = await refresh(viewer, artifact.id); expect(viewed.status).toBe(404);
  const refusals = [];
  refusals.push(await refresh(lonely, artifact.id)); // never connected
  connect(lonely, 'notion'); refusals.push(await refresh(lonely, artifact.id)); // connected to a different app only
  connect(lonely); connections.markDisconnected(lonely.id, 'github'); refusals.push(await refresh(lonely, artifact.id)); // disconnected
  for (const refused of refusals) { expect(refused.status, refused.text).toBe(409); expect(refused.json.error.code).toBe('LIVE_ARTIFACT_SOURCE_UNAVAILABLE'); }
  expect(new Set(refusals.map((refused) => JSON.stringify(refused.json.error))).size).toBe(1);
  expect(executes()).toHaveLength(0);
  const after = await read(artifact.id);
  expect(after.document.dataJson).toEqual({ total: 0 }); expect(after.studioRevision).toBe(artifact.studioRevision); expect(await history(artifact.id)).toEqual([]);
  expect(sourceAudit(artifact.id).map((row) => row.outcome)).toEqual(Array(3).fill('LIVE_ARTIFACT_SOURCE_UNAVAILABLE'));
});

it('S62 a connector tool that is not classified read-only is refused before execution', async () => {
  connect(owner, 'hubspot'); composio.writeTool = true;
  const artifact = await create(connectorSource('hubspot.hubspot_create_contact', {}));
  const result = await refresh(owner, artifact.id); expect(result.status, result.text).toBe(403);
  expect(result.json.error.code).toBe('LIVE_ARTIFACT_SOURCE_NOT_READ_ONLY'); expect(executes()).toHaveLength(0);
  expect((await read(artifact.id)).document.dataJson).toEqual({ total: 0 });
});

it.each(['logout', 'account-disable', 'disconnect', 'project-access', 'key-rotate'])('S62 a connector refresh racing %s writes nothing', async (kind) => {
  const artifact = await create(connectorSource());
  const who = kind === 'project-access' ? editor : owner;
  composio.holdExecute = true; const pending = refresh(who, artifact.id);
  await until(() => composio.releases.length, (n) => n > 0, 'execute held');
  if (kind === 'logout') await call(who, 'POST', '/api/auth/logout', {});
  if (kind === 'account-disable') await call(admin, 'PATCH', `/api/auth/users/${who.id}`, { active: false });
  if (kind === 'disconnect') connections.markDisconnected(who.id, 'github');
  if (kind === 'project-access') expect((await call(owner, 'DELETE', `/api/multiuser/projects/${projectId}/shares/${who.id}`)).status).toBe(200);
  if (kind === 'key-rotate') company.update(admin.id, { revision: company.read().revision, apiKey: `${KEY}-rotated` });
  const sent = composioCalls.length; composio.holdExecute = false; for (const release of composio.releases.splice(0)) release();
  const result = await pending; expect(result.status).toBeGreaterThanOrEqual(400);
  if (result.json?.error?.code) expect(result.json.error.code).toBe('LIVE_ARTIFACT_REFRESH_AUTHORITY_CHANGED');
  expect(composioCalls.length).toBe(sent);
  const stored = JSON.parse((db.prepare('SELECT artifact_json FROM studio_live_artifacts WHERE id = ?').get(artifact.id) as { artifact_json: string }).artifact_json);
  expect(stored.document.dataJson).toEqual({ total: 0 }); expect(stored.studioRevision).toBe(artifact.studioRevision); expect(stored.refreshStatus).toBe('never');
  expect((db.prepare('SELECT COUNT(*) AS n FROM studio_live_artifact_refreshes WHERE artifact_id = ?').get(artifact.id) as { n: number }).n).toBe(0);
  if (kind === 'key-rotate') company.update(admin.id, { revision: company.read().revision, apiKey: KEY });
});

it('S62 a refresh racing a concurrent edit of the source writes nothing', async () => {
  const artifact = await create(connectorSource());
  composio.holdExecute = true; const pending = refresh(owner, artifact.id);
  await until(() => composio.releases.length, (n) => n > 0, 'execute held');
  const edited = await call(owner, 'PATCH', base(`/${artifact.id}`), { ...document(connectorSource('github.github_search_repositories', { query: 'other' })), expectedRevision: artifact.studioRevision });
  expect(edited.status, edited.text).toBe(200);
  composio.holdExecute = false; for (const release of composio.releases.splice(0)) release();
  const result = await pending; expect(result.status).toBe(409); expect(result.json.error.code).toBe('LIVE_ARTIFACT_REFRESH_AUTHORITY_CHANGED');
  expect((await read(artifact.id)).document.dataJson).toEqual({ total: 0 });
});

// ---- account remote MCP --------------------------------------------------------

it('S62 MCP: owner and collaborator each refresh with their own server; provenance names the actor', async () => {
  await server(owner, 'owner.fixture.test'); await server(editor, 'editor.fixture.test');
  const artifact = await create(mcpSource());
  const mine = await refresh(owner, artifact.id); expect(mine.status, mine.text).toBe(200);
  expect(mine.json.artifact.document.dataJson).toEqual({ total: 7 });
  expect(mine.json.artifact.studioProvenance).toMatchObject({ origin: 'mcp', toolSource: { kind: 'mcp', id: 'mine', tool: 'lookup', actorAccountId: owner.id } });
  expect(mcpCalls().map((request) => request.host.split(':')[0])).toEqual(['owner.fixture.test']);
  const theirs = await refresh(editor, artifact.id); expect(theirs.status, theirs.text).toBe(200);
  expect(mcpCalls().map((request) => request.host.split(':')[0])).toEqual(['owner.fixture.test', 'editor.fixture.test']);
  expect(theirs.json.artifact.studioProvenance.toolSource.actorAccountId).toBe(editor.id);
  expect((await history(artifact.id)).map((entry) => entry.studioSource)).toEqual([{ kind: 'mcp', id: 'mine', tool: 'lookup' }, { kind: 'mcp', id: 'mine', tool: 'lookup' }]);
  // One audited tools/call per refresh, under its own short-lived refresh grant.
  const audited = db.prepare("SELECT run_id, tool_name, outcome FROM studio_mcp_tool_audit WHERE run_id LIKE 'live-artifact-refresh:%'").all() as Array<{ run_id: string; outcome: string }>;
  expect(audited).toHaveLength(2); expect(new Set(audited.map((row) => row.run_id)).size).toBe(2); expect(audited.every((row) => row.outcome === 'ok')).toBe(true);
});

it('S62 MCP: missing, disabled, signed-out and foreign servers give the same refusal and send nothing', async () => {
  await server(owner, 'owner.fixture.test'); const artifact = await create(mcpSource());
  const errors = [];
  errors.push(await refresh(lonely, artifact.id)); // no server at all (the owner's "mine" is not addressable)
  await server(lonely, 'lonely.fixture.test', { enabled: false }); errors.push(await refresh(lonely, artifact.id));
  await call(lonely, 'DELETE', '/api/multiuser/mcp/servers/mine'); await server(lonely, 'lonely.fixture.test', { authMode: 'oauth', headers: {} });
  errors.push(await refresh(lonely, artifact.id));
  for (const refused of errors) { expect(refused.status, refused.text).toBe(409); expect(refused.json.error.code).toBe('LIVE_ARTIFACT_SOURCE_UNAVAILABLE'); }
  expect(new Set(errors.map((refused) => JSON.stringify(refused.json.error))).size).toBe(1);
  expect(fixture.requests).toEqual([]);
  expect((await read(artifact.id)).document.dataJson).toEqual({ total: 0 });
});

it('S62 MCP: a tool without readOnlyHint is refused, and creation needs the read-only confirmation', async () => {
  await server(owner, 'owner.fixture.test');
  const unconfirmed = await call(owner, 'POST', base(), document(mcpSource({ mcp: { serverId: 'mine', toolName: 'lookup', readOnlyConfirmed: false } })));
  expect(unconfirmed.status).toBe(400);
  fixture.state.tools = [{ name: 'lookup', inputSchema: lookupTools[0]!.inputSchema }];
  const artifact = await create(mcpSource());
  const result = await refresh(owner, artifact.id); expect(result.status, result.text).toBe(403);
  expect(result.json.error.code).toBe('LIVE_ARTIFACT_SOURCE_NOT_READ_ONLY'); expect(mcpCalls()).toHaveLength(0);
  fixture.state.tools = [{ ...lookupTools[0]!, annotations: { readOnlyHint: 'true', destructiveHint: false } }];
  expect((await refresh(owner, artifact.id)).json.error.code).toBe('LIVE_ARTIFACT_SOURCE_NOT_READ_ONLY'); expect(mcpCalls()).toHaveLength(0);
});

it.each(['logout', 'account-disable', 'server-disable', 'header-change', 'project-access'])('S62 MCP refresh racing %s during discovery sends no tools/call and writes nothing', async (kind) => {
  const who = kind === 'project-access' ? editor : owner;
  await server(who, 'race.fixture.test'); const artifact = await create(mcpSource());
  fixture.state.holdDiscovery = true; const pending = refresh(who, artifact.id);
  await until(() => fixture.requests.some((request) => request.body.includes('tools/list')), Boolean, 'discovery held');
  if (kind === 'logout') await call(who, 'POST', '/api/auth/logout', {});
  if (kind === 'account-disable') await call(admin, 'PATCH', `/api/auth/users/${who.id}`, { active: false });
  if (kind === 'server-disable' || kind === 'header-change') {
    const row = (await call(who, 'GET', '/api/multiuser/mcp/servers')).json.servers.find((item: { id: string }) => item.id === 'mine');
    await call(who, 'PATCH', '/api/multiuser/mcp/servers/mine', { revision: row.revision, ...(kind === 'server-disable' ? { enabled: false } : { headers: { 'X-Api-Key': 'changed-S62-value-0123' } }) });
  }
  if (kind === 'project-access') await call(owner, 'DELETE', `/api/multiuser/projects/${projectId}/shares/${who.id}`);
  const sent = fixture.requests.length; fixture.state.holdDiscovery = false; for (const release of fixture.state.releases.splice(0)) release();
  const result = await pending; expect(result.status).toBeGreaterThanOrEqual(400);
  if (result.json?.error?.code) expect(result.json.error.code).toBe('LIVE_ARTIFACT_REFRESH_AUTHORITY_CHANGED');
  expect(fixture.requests).toHaveLength(sent); expect(mcpCalls()).toHaveLength(0);
  const stored = JSON.parse((db.prepare('SELECT artifact_json FROM studio_live_artifacts WHERE id = ?').get(artifact.id) as { artifact_json: string }).artifact_json);
  expect(stored.document.dataJson).toEqual({ total: 0 }); expect(stored.refreshStatus).toBe('never');
});

it('S62 MCP credential echoes are scrubbed before mapping and absent from SQLite/WAL, data files, logs and history', async () => {
  await server(owner, 'owner.fixture.test'); fixture.state.echoSecrets = true;
  fixture.state.callJson = { structuredContent: { total: 9, note: 'ordinary text' } };
  const artifact = await create({ ...mcpSource(), outputMapping: { dataPaths: [{ from: 'structuredContent.total', to: 'total' }, { from: 'echoed', to: 'echoed' }] } });
  const result = await refresh(owner, artifact.id); expect(result.status, result.text).toBe(200);
  expect(result.json.artifact.document.dataJson.total).toBe(9); expect(result.json.artifact.document.dataJson.echoed).toContain('[redacted]');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
  const columns = tables.map(({ name }) => JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all())).join('');
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => { const file = path.join(dir, name); const stat = statSync(file, { throwIfNoEntry: false });
    return stat?.isDirectory() ? walk(file) : stat?.isFile() && stat.size < 64 * 1024 * 1024 ? [file] : []; });
  const rendered = (await call(owner, 'GET', base(`/${artifact.id}/preview`) + '&variant=rendered-source')).text;
  for (const form of encodedForms(MCP_HEADER_SENTINEL)) {
    expect(result.text + columns + logs.join('') + JSON.stringify(await history(artifact.id)) + rendered).not.toContain(form);
    for (const file of walk(root)) expect(readFileSync(file).toString('latin1'), file).not.toContain(form);
  }
});

it('S62 MCP deadline and output-size caps keep the previous data and record a failed refresh', async () => {
  const tokensBefore = toolTokenRegistry.activeTokenCount();
  await server(owner, 'owner.fixture.test'); const artifact = await create(mcpSource());
  fixture.state.holdCall = true;
  const slow = await refresh(owner, artifact.id); expect(slow.status, slow.text).toBe(502);
  expect(slow.json.error).toMatchObject({ code: 'LIVE_ARTIFACT_SOURCE_FAILED', details: { reason: 'deadline' } });
  fixture.state.holdCall = false; for (const release of fixture.state.releases.splice(0)) release();
  fixture.state.callJson = { structuredContent: { total: 1, padding: 'p'.repeat(300 * 1024) } };
  const large = await refresh(owner, artifact.id); expect(large.status, large.text).toBe(502);
  expect(large.json.error).toMatchObject({ code: 'LIVE_ARTIFACT_SOURCE_FAILED', details: { reason: 'output' } });
  const after = await read(artifact.id); expect(after.document.dataJson).toEqual({ total: 0 }); expect(after.refreshStatus).toBe('failed');
  expect((await history(artifact.id)).map((entry) => entry.status)).toEqual(['failed', 'failed']);
  expect((await history(artifact.id)).map((entry) => entry.error?.code)).toEqual(['SOURCE_TIMEOUT', 'SOURCE_OUTPUT_REFUSED']);
  expect(toolTokenRegistry.activeTokenCount()).toBe(tokensBefore);
}, 30_000);

it('S62 a refresh grant carries a one-call budget: a second execute on the same grant is refused', async () => {
  await server(owner, 'owner.fixture.test');
  const auth = AuthStore.open({ dataRoot: root });
  const runtime = new StudioMcpRuntime({ db, dataRoot: root, auth, sessionCurrent: () => true, outbound: { resolve: fixture.resolve, allowAddress: fixture.allowAddress } });
  try {
    const bound = runtime.capture({ accountId: owner.id, username: owner.username, role: 'user', sessionId: `routine:${owner.id}`, sessionExpiresAt: Date.now() + 60_000 }, ['mine']);
    const grant = toolTokenRegistry.mint({ runId: `live-artifact-refresh:${randomUUID()}`, projectId, studioMcp: bound!, callLimit: 1 });
    runtime.registerEphemeral(grant.runId);
    const args = { serverId: 'mine', toolName: studioMcpToolName('mine', 'lookup'), input: {} };
    await expect(runtime.execute(grant, args)).resolves.toMatchObject({ serverId: 'mine' });
    await expect(runtime.execute(grant, args)).rejects.toMatchObject({ code: 'CONNECTOR_RATE_LIMITED' });
    runtime.releaseEphemeral(grant.runId);
    await expect(runtime.execute(grant, args)).rejects.toMatchObject({ code: 'TOOL_TOKEN_INVALID' });
    expect(mcpCalls()).toHaveLength(1);
    toolTokenRegistry.revokeToken(grant.token);
  } finally { runtime.close(); auth.close(); }
});

// ---- agent runs and background refresh ----------------------------------------

it.each(['company_pool', 'personal_api_key', 'personal_subscription'])('S62 an interactive %s agent turn refreshes within its owner\'s authority with the owner\'s own connection', async (source) => {
  const artifact = await create(connectorSource());
  openaiPlan.artifactId = artifact.id;
  if (source === 'personal_api_key') expect((await call(editor, 'PUT', '/api/multiuser/settings/provider-keys/openai', { revision: 0, apiKey: 'sk-S62-own-fixture' })).status).toBe(200);
  if (source === 'personal_subscription') { await linkCodex(daemon, root, editor, 's62@example.test'); setTurnMode(root, editor, { reply: 'Done' }); }
  const started = await call(editor, 'POST', '/api/runs', { projectId, conversationId: (await call(editor, 'POST', `/api/projects/${projectId}/conversations`, { title: 'agent' })).json.conversation.id,
    message: source === 'personal_subscription' ? `[mock-live-artifact-refresh=${artifact.id}]` : 'refresh it', executionSource: source,
    agentId: source === 'personal_subscription' ? 'codex' : source === 'personal_api_key' ? 'openai-byok' : 'openai' });
  expect(started.status, started.text).toBe(202);
  const settled = await until(() => call(editor, 'GET', `/api/runs/${started.json.runId}`), (r) => ['succeeded', 'failed', 'canceled'].includes(r.json.status), 'run settled', 15_000);
  expect(settled.json.status).toBe('succeeded');
  expect(executes().map((item) => item.body.connected_account_id)).toEqual([`ca_github_${editor.id}`]);
  const after = await read(artifact.id);
  expect(after.document.dataJson).toEqual({ total: 41 }); expect(after.studioProvenance.toolSource.actorAccountId).toBe(editor.id);
  expect(openaiPlan.outputs.join('')).not.toContain(KEY);
});

it('S62 a routine-dispatched (background) turn cannot refresh connector or MCP sources', async () => {
  const artifact = await create(connectorSource());
  openaiPlan.artifactId = artifact.id;
  const routine = await call(owner, 'POST', '/api/routines', { name: 'S62 refresh', prompt: 'Refresh the pipeline', agentId: 'openai',
    schedule: { kind: 'daily', time: '09:30', timezone: 'UTC' }, target: { mode: 'reuse', projectId } });
  expect(routine.status, routine.text).toBe(201);
  const dispatched = await call(owner, 'POST', `/api/routines/${routine.json.routine.id}/run`, {}); expect(dispatched.status, dispatched.text).toBe(202);
  await until(() => call(owner, 'GET', `/api/routines/${routine.json.routine.id}/runs`), (r) => ['succeeded', 'failed'].includes(r.json.runs[0]?.status), 'routine settled', 15_000);
  expect(executes()).toHaveLength(0);
  expect(openaiPlan.outputs.join('')).toContain('MULTIUSER_CAPABILITY_UNAVAILABLE');
  expect((await read(artifact.id)).document.dataJson).toEqual({ total: 0 });
});

// ---- editor surfaces -------------------------------------------------------------

it('S62 the source catalog shows only the actor\'s own usable sources, with reasons, and tool discovery uses the actor\'s server', async () => {
  const tokensBefore = toolTokenRegistry.activeTokenCount();
  await server(owner, 'owner.fixture.test'); await server(editor, 'editor.fixture.test', { id: 'theirs', enabled: false });
  const mine = await call(owner, 'GET', `/api/multiuser/live-artifact-sources?projectId=${projectId}`); expect(mine.status, mine.text).toBe(200);
  expect(mine.json.connectors.find((item: { connectorId: string }) => item.connectorId === 'github')).toMatchObject({ available: true,
    tools: expect.arrayContaining([expect.objectContaining({ name: 'github.github_search_repositories', readOnly: true })]) });
  expect(mine.json.connectors.find((item: { connectorId: string }) => item.connectorId === 'notion')).toMatchObject({ available: false, reason: 'not_connected' });
  expect(mine.json.mcpServers).toEqual([{ serverId: 'mine', label: null, available: true }]);
  const theirs = await call(editor, 'GET', `/api/multiuser/live-artifact-sources?projectId=${projectId}`);
  expect(theirs.json.mcpServers).toEqual([{ serverId: 'theirs', label: null, available: false, reason: 'disabled' }]);
  expect((await call(viewer, 'GET', `/api/multiuser/live-artifact-sources?projectId=${projectId}`)).status).toBe(404);
  fixture.state.tools = [...lookupTools, { name: 'write_row', inputSchema: { type: 'object' } }];
  const tools = await call(owner, 'POST', `/api/multiuser/live-artifact-sources/mcp/mine/tools?projectId=${projectId}`);
  expect(tools.status, tools.text).toBe(200); expect(tools.json.tools).toEqual([{ name: 'lookup', readOnly: true }, { name: 'write_row', readOnly: false }]);
  expect(fixture.requests.every((request) => request.host.startsWith('owner.fixture.test'))).toBe(true);
  expect((await call(lonely, 'POST', `/api/multiuser/live-artifact-sources/mcp/mine/tools?projectId=${projectId}`)).json.error.code).toBe('LIVE_ARTIFACT_SOURCE_UNAVAILABLE');
  const github = await call(owner, 'POST', `/api/multiuser/live-artifact-sources/connector/github/tools?projectId=${projectId}`);
  expect(github.status, github.text).toBe(200); expect(github.json.tools.every((tool: { readOnly: boolean }) => tool.readOnly)).toBe(true);
  // Every discovery grant is revoked when it settles.
  expect(toolTokenRegistry.activeTokenCount()).toBe(tokensBefore);
});

it('S62 descriptors store ids only and legacy MCP sources stay refused', async () => {
  const withLabel = await call(owner, 'POST', base(), document({ ...connectorSource(), connector: { connectorId: 'github', toolName: 'github.github_search_repositories', accountLabel: 'me' } }));
  expect(withLabel.status).toBe(400);
  const unknown = await call(owner, 'POST', base(), document(connectorSource('nope.nope_tool')));
  expect(unknown.status).toBe(400);
  const legacy = await call(owner, 'POST', base(), document({ type: 'daemon_tool', toolName: 'mcp_execute', input: {}, refreshPermission: 'manual_refresh_granted_for_read_only' }));
  expect(legacy.status).toBe(403); expect(legacy.json.error.message).toContain('refreshing-actor');
  const created = await create(mcpSource());
  expect(Object.keys((await read(created.id)).document.sourceJson.mcp).sort()).toEqual(['readOnlyConfirmed', 'serverId', 'toolName']);
});
