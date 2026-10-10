import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { cleanupIsolatedDataRoot, loadIsolatedServerModule, login, multiUserOptions, provisionAccounts, startMultiUserDaemon, MU_TEST_ORIGIN, type Principal, type StartedMultiUserDaemon } from './multiuser-harness.js';
import { startMcpFixture, encodedForms, MCP_HEADER_SENTINEL, MCP_TOKEN_SENTINEL, type McpFixture } from './studio-mcp-fixture.js';
import { PERSONAL_CODEX_MOCK, linkCodex, setTurnMode, until } from './personal-codex-helpers.js';
import { toolTokenRegistry } from '../../src/tool-tokens.js';
import { StudioMcpRuntime, studioMcpToolName } from '../../src/mcp-client/studio-runtime.js';
import { StudioMcpStore } from '../../src/storage/studio-mcp.js';
import { AuthStore } from '../../src/storage/auth-store.js';
let daemon: StartedMultiUserDaemon; let fixture: McpFixture; let a: Principal; let b: Principal; let admin: Principal; let root: string;
let db: Database.Database; let auth: AuthStore; let runtime: StudioMcpRuntime; let store: StudioMcpStore;
let holdOpenai = false; const active: Array<{ id: string; actor: Principal }> = []; const providerRequests: string[] = []; const logs: string[] = [];
const call = (actor: Principal, method: string, path: string, body?: unknown) => daemon.request({ method, path, cookie: actor.cookie, headers: { origin: MU_TEST_ORIGIN }, ...(body ? { body } : {}) });
const openai: typeof fetch = async (_url, init) => {
  if (holdOpenai) return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  const body = JSON.parse(String(init?.body)); providerRequests.push(String(init?.body));
  const outputs = (body.input as Array<Record<string, unknown>>).filter((item) => item.type === 'function_call_output');
  let output: unknown[] = [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done' }] }];
  if (body.tools.some((tool: { name: string }) => tool.name === 'mcp_list')) {
    if (!outputs.length) output = [{ type: 'function_call', call_id: 'list', name: 'mcp_list', arguments: '{}' }];
    else if (outputs.length === 1) {
      const server = JSON.parse(String(outputs[0]!.output)).servers?.[0];
      if (server) output = [{ type: 'function_call', call_id: 'execute', name: 'mcp_execute', arguments: JSON.stringify({ serverId: server.serverId, toolName: server.tools[0].name, input: {} }) }];
    }
  }
  return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { output } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
};
async function fresh(): Promise<Principal> {
  const username = `s61-${randomUUID().slice(0, 8)}`; const password = `${username}-battery-staple-password`;
  const made = await call(admin, 'POST', '/api/auth/users', { username, password, role: 'user' }); expect(made.status).toBe(201);
  return { id: made.json.account.id, username, password, cookie: await login(daemon, username, password) };
}
async function remote(actor = a, extra: Record<string, unknown> = {}) {
  const result = await call(actor, 'POST', '/api/multiuser/mcp/servers', { id: 'mine', url: fixture.url('/runtime'), headers: { 'X-Api-Key': MCP_HEADER_SENTINEL }, ...extra }); expect(result.status, result.text).toBe(201); return result.json.server;
}
async function target(actor = a) {
  const result = await call(actor, 'POST', '/api/projects', { id: randomUUID(), name: 'S61 project' }); expect(result.status, result.text).toBe(200);
  return { projectId: result.json.project.id, conversationId: result.json.conversationId };
}
async function run(actor = a, context?: unknown, project?: Awaited<ReturnType<typeof target>>, source = 'company_pool') {
  const result = await call(actor, 'POST', '/api/runs', { ...(project ?? await target(actor)), message: source === 'personal_subscription' ? '[mock-mcp]' : 'Read my MCP', executionSource: source,
    agentId: source === 'personal_subscription' ? 'codex' : source === 'personal_api_key' ? 'openai-byok' : 'openai', ...(context ? { context } : {}) });
  if (result.status === 202) active.push({ id: result.json.runId, actor }); return result;
}
const tools = (token: string, args?: unknown) => daemon.request({ method: args ? 'POST' : 'GET', path: args ? '/api/tools/mcp/execute' : '/api/tools/mcp/list', headers: { authorization: `Bearer ${token}` }, ...(args ? { body: args } : {}) });
async function heldGrant() {
  holdOpenai = true; const started = await run(); expect(started.status, started.text).toBe(202);
  await until(() => call(a, 'GET', `/api/runs/${started.json.runId}`), (r) => r.json.status === 'running');
  const bound = runtime.capture({ accountId: a.id, username: a.username, role: 'user', sessionId: `routine:${a.id}`, sessionExpiresAt: Date.now() + 60_000 }, ['mine']);
  return toolTokenRegistry.mint({ runId: started.json.runId, projectId: started.json.run.projectId, studioMcp: bound! });
}
const args = { serverId: 'mine', toolName: studioMcpToolName('mine', 'lookup'), input: {} };
beforeAll(async () => {
  ({ dataRoot: root } = await loadIsolatedServerModule()); fixture = await startMcpFixture();
  for (const level of ['log', 'info', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation((...values) => { logs.push(values.map(String).join(' ')); });
  daemon = await startMultiUserDaemon(multiUserOptions({ testCompanyOpenAIFetch: openai, testPersonalCodexAppServer: PERSONAL_CODEX_MOCK,
    testMcpOutbound: { resolve: fixture.resolve, allowAddress: fixture.allowAddress, timeoutMs: 10_000 } }));
  ({ admin } = await provisionAccounts(daemon, []));
  db = new Database(path.join(root, 'app.sqlite')); auth = AuthStore.open({ dataRoot: root }); store = new StudioMcpStore(db, root);
  runtime = new StudioMcpRuntime({ db, dataRoot: root, auth, sessionCurrent: () => true, outbound: { resolve: fixture.resolve, allowAddress: fixture.allowAddress, timeoutMs: 10_000 } });
  expect((await call(admin, 'PUT', '/api/admin/pool/openai', { revision: 0, apiKey: 'sk-S61-company-fixture-0123456789', model: 'fixture', enabled: true, capacity: 3 })).status).toBe(200);
}, 120_000);
beforeEach(async () => {
  a = await fresh(); b = await fresh(); fixture.requests.length = 0; logs.length = 0; providerRequests.length = 0; holdOpenai = false;
  Object.assign(fixture.state, { holdDiscovery: false, holdCall: false, holdDns: false, holdDnsAfterDiscovery: false, tools: null, resultBytes: 0, echoSecrets: false });
});
afterEach(async () => {
  Object.assign(fixture.state, { holdDiscovery: false, holdCall: false, holdDns: false });
  for (const release of [...fixture.state.releases.splice(0), ...fixture.state.dnsReleases.splice(0)]) release();
  for (const item of active.splice(0)) await call(item.actor, 'POST', `/api/runs/${item.id}/cancel`, {});
  toolTokenRegistry.clear();
});
afterAll(async () => { runtime?.close(); auth?.close(); db?.close(); await daemon?.close(); await fixture?.close(); vi.restoreAllMocks(); cleanupIsolatedDataRoot(); });
it('S61 own remote servers advertise run availability', async () => { expect((await call(a, 'GET', '/api/mcp/servers')).json.runs.available).toBe(true); });
it.each(['company_pool', 'personal_api_key', 'personal_subscription'].flatMap((source) => ['header', 'oauth'].map((credential) => [source, credential])))('S61 %s with %s calls a fixture tool end to end', async (source, credential) => {
  await remote(a, credential === 'oauth' ? { authMode: 'oauth', headers: {} } : {}); fixture.state.echoSecrets = true;
  if (credential === 'oauth') {
    const row = store.get(a.id, 'mine')!;
    store.saveToken(a.id, { serverId: 'mine', instanceId: row.instance_id, generation: row.generation },
      { accessToken: MCP_TOKEN_SENTINEL, tokenType: 'Bearer', clientId: 'fixture', tokenEndpoint: fixture.url('/token') }, { scope: null, expiresAt: Date.now() + 60_000 }, () => null);
  }
  if (source === 'personal_api_key') expect((await call(a, 'PUT', '/api/multiuser/settings/provider-keys/openai', { revision: 0, apiKey: 'sk-S61-own-fixture' })).status).toBe(200);
  if (source === 'personal_subscription') { await linkCodex(daemon, root, a, 's61@example.test'); setTurnMode(root, a, { reply: 'Done' }); }
  const result = await run(a, { mcpServerIds: ['mine'] }, undefined, source); expect(result.status, result.text).toBe(202);
  const events = await daemon.request({ path: `/api/runs/${result.json.runId}/events`, cookie: a.cookie }); expect(events.text).toContain('"status":"succeeded"');
  expect(fixture.requests.filter((request) => JSON.parse(request.body || '{}').method === 'tools/call')).toHaveLength(1);
  const forms = [MCP_HEADER_SENTINEL, MCP_TOKEN_SENTINEL, `Bearer ${MCP_TOKEN_SENTINEL}`].flatMap(encodedForms);
  for (const form of forms) expect(events.text + providerRequests.join('') + logs.join('')).not.toContain(form);
  const audit = JSON.stringify(db.prepare('SELECT * FROM studio_mcp_tool_audit WHERE run_id = ?').all(result.json.runId)); expect(audit).toContain('"outcome":"ok"'); expect(audit).toContain('duration_ms');
  for (const form of forms) expect(audit).not.toContain(form);
  expect(() => db.prepare('UPDATE studio_mcp_tool_audit SET outcome = ? WHERE run_id = ?').run('changed', result.json.runId)).toThrow('immutable');
  expect(() => db.prepare('DELETE FROM studio_mcp_tool_audit WHERE run_id = ?').run(result.json.runId)).toThrow('immutable');
});
it('S61 admission gives the same 404 for foreign, disabled, deleted, not-connected and missing servers', async () => {
  await remote(b, { id: 'foreign' }); await remote(a, { id: 'disabled', enabled: false }); await remote(a, { id: 'not-connected', authMode: 'oauth' });
  await remote(a, { id: 'deleted' }); await call(a, 'DELETE', '/api/multiuser/mcp/servers/deleted');
  const errors: unknown[] = [];
  for (const id of ['foreign', 'disabled', 'deleted', 'not-connected', 'missing']) { const result = await run(a, { mcpServerIds: [id] }); expect(result.status, result.text).toBe(404); errors.push(result.json.error); }
  expect(errors.every((error) => JSON.stringify(error) === JSON.stringify(errors[0]))).toBe(true); expect(fixture.requests).toEqual([]);
  expect((await run(admin, { mcpServerIds: ['foreign'] })).status).toBe(404);
});
it('S61 project collaborators select their own server, never the project owner’s', async () => {
  const project = await target(a); await remote(a, { id: 'owner' }); await remote(b, { id: 'editor' });
  expect((await call(a, 'PUT', `/api/multiuser/projects/${project.projectId}/shares`, { username: b.username, role: 'edit' })).status).toBe(200);
  const conversation = await call(b, 'POST', `/api/projects/${project.projectId}/conversations`, { title: 'Editor thread' });
  expect(conversation.status).toBe(200); project.conversationId = conversation.json.conversation.id;
  expect((await run(b, { mcpServerIds: ['owner'] }, project)).status).toBe(404);
  const result = await run(b, { mcpServerIds: ['editor'] }, project); expect(result.status, result.text).toBe(202);
  const events = await daemon.request({ path: `/api/runs/${result.json.runId}/events`, cookie: b.cookie }); expect(events.text).toContain('"status":"succeeded"');
});
it.each(['http', 'sse', 'events'])('S61 %s guarded transport completes and closes its stream', async (transport) => {
  await remote(a, { transport: transport === 'sse' ? 'sse' : 'http', url: fixture.url(transport === 'sse' ? '/runtime-sse' : transport === 'events' ? '/runtime-events' : '/runtime') });
  const grant = await heldGrant(); const listed = await tools(grant.token); expect(listed.status, listed.text).toBe(200);
  expect(listed.json.servers[0].tools[0].name).toBe(args.toolName);
  const result = await tools(grant.token, args); expect(result.status, result.text).toBe(200); expect(result.json.output.content[0].text).toBe('fixture result');
});
it.each(['update_plan', 'connectors_execute', 'mcp_execute', 'bad.name', 'lookup lookup'])('S61 remote tool name %s cannot shadow built-ins or namespaces', async (name) => {
  await remote(); fixture.state.tools = [{ name, inputSchema: { type: 'object' } }];
  expect((await tools((await heldGrant()).token)).status).toBe(502); expect(fixture.requests.some((request) => request.body.includes('tools/call'))).toBe(false);
});
async function change(kind: string, grant: Awaited<ReturnType<typeof heldGrant>>) {
  if (kind === 'cancel') await call(a, 'POST', `/api/runs/${grant.runId}/cancel`, {});
  if (kind === 'finish') db.prepare("UPDATE multiuser_runs SET status = 'succeeded' WHERE id = ?").run(grant.runId);
  if (kind === 'logout') await call(a, 'POST', '/api/auth/logout', {});
  if (kind === 'account-disable') await call(admin, 'PATCH', `/api/auth/users/${a.id}`, { active: false });
  const row = store.get(a.id, 'mine')!;
  if (kind === 'server-disable' || kind === 'endpoint-change' || kind === 'header-change') await call(a, 'PATCH', '/api/multiuser/mcp/servers/mine', { revision: row.revision,
    ...(kind === 'server-disable' ? { enabled: false } : kind === 'endpoint-change' ? { url: fixture.url('/other') } : { headers: { 'X-Api-Key': 'changed-S61-value' } }) });
  if (kind === 'server-delete') await call(a, 'DELETE', '/api/multiuser/mcp/servers/mine');
  if (kind === 'oauth-disconnect') await call(a, 'POST', '/api/mcp/oauth/disconnect', { serverId: 'mine' });
}
it.each(['cancel', 'finish', 'logout', 'account-disable', 'server-disable', 'server-delete', 'endpoint-change', 'header-change', 'oauth-disconnect'].flatMap((kind) => ['discovery', 'call', 'dns', 'call-dns'].map((stage) => [kind, stage])))('S61 %s during %s sends no further requests', async (kind, stage) => {
  await remote(a, kind === 'oauth-disconnect' ? { authMode: 'oauth', headers: {} } : {});
  if (kind === 'oauth-disconnect') {
    const row = store.get(a.id, 'mine')!; store.saveToken(a.id, { serverId: 'mine', instanceId: row.instance_id, generation: row.generation },
      { accessToken: fixture.state.accessToken, tokenType: 'Bearer', clientId: 'fixture', tokenEndpoint: fixture.url('/token') }, { scope: null, expiresAt: Date.now() + 60_000 }, () => null);
  }
  const grant = await heldGrant(); fixture.state.holdDiscovery = stage === 'discovery'; fixture.state.holdCall = stage === 'call'; fixture.state.holdDns = stage === 'dns';
  fixture.state.holdDnsAfterDiscovery = stage === 'call-dns'; const dnsBefore = fixture.state.dnsWaiting;
  const pending = tools(grant.token, args);
  await until(() => stage === 'dns' || stage === 'call-dns' ? fixture.state.dnsWaiting > dnsBefore : fixture.requests.some((request) => request.body.includes(stage === 'call' ? 'tools/call' : 'tools/list')), Boolean);
  const sent = fixture.requests.length; await change(kind!, grant);
  for (const release of [...fixture.state.releases.splice(0), ...fixture.state.dnsReleases.splice(0)]) release();
  const result = await pending; expect(result.status, result.text).toBeGreaterThanOrEqual(400); expect(fixture.requests).toHaveLength(sent);
});
it.each(['sse', 'events'])('S61 idle %s stream aborts on revoke', async (transport) => {
  await remote(a, { transport: transport === 'sse' ? 'sse' : 'http', url: fixture.url(transport === 'sse' ? '/runtime-sse' : '/runtime-events') });
  const grant = await heldGrant(); fixture.state.holdDiscovery = true; const before = fixture.state.closedStreams;
  const pending = tools(grant.token, args); await until(() => fixture.requests.some((request) => request.body.includes('tools/list')), Boolean);
  await change('cancel', grant); expect((await pending).status).toBeGreaterThanOrEqual(400);
  await until(() => fixture.state.closedStreams, (n) => n > before, 'inbound SSE socket closed');
});
it('S61 tool-token revoke while discovery is awaited never reaches tools/call', async () => {
  await remote(); const grant = await heldGrant(); fixture.state.holdDiscovery = true;
  const pending = tools(grant.token, args);
  await until(() => fixture.requests.some((request) => request.body.includes('tools/list')), Boolean);
  const sent = fixture.requests.length; toolTokenRegistry.revokeToken(grant.token);
  for (const release of fixture.state.releases.splice(0)) release();
  expect((await pending).status).toBe(401); expect(fixture.requests).toHaveLength(sent);
});
it('S61 grants cannot outlive six hours even with a longer token TTL', async () => {
  await remote(); const current = await heldGrant();
  const old = toolTokenRegistry.mint({ runId: current.runId, projectId: current.projectId, studioMcp: current.studioMcp!,
    nowMs: Date.now() - 6 * 60 * 60 * 1000, ttlMs: 8 * 60 * 60 * 1000 });
  expect((await tools(old.token)).status).toBe(401); expect(fixture.requests).toEqual([]);
});
it('S61 per-run reservations enforce the limit under parallel calls', async () => {
  await remote(); const grant = await heldGrant();
  const results = await Promise.all(Array.from({ length: 65 }, () => tools(grant.token, args)));
  expect(results.filter((r) => r.status === 200)).toHaveLength(60); expect(results.filter((r) => r.status === 429)).toHaveLength(5);
  expect(fixture.requests.filter((request) => request.body.includes('tools/call'))).toHaveLength(60);
}, 30_000);
it.each(['deadline', 'size', 'tools', 'schema'])('S61 %s ceiling refuses boundedly', async (kind) => {
  await remote(); const grant = await heldGrant();
  if (kind === 'deadline') fixture.state.holdCall = true;
  if (kind === 'size') fixture.state.resultBytes = 2 * 1024 * 1024;
  if (kind === 'tools') fixture.state.tools = Array.from({ length: 65 }, (_, i) => ({ name: `tool${i}`, inputSchema: { type: 'object' } }));
  if (kind === 'schema') fixture.state.tools = [{ name: 'lookup', inputSchema: { type: 'object', description: 'x'.repeat(20_000) } }];
  const result = await tools(grant.token, args); expect(result.status).toBeGreaterThanOrEqual(400);
  if (kind === 'tools' || kind === 'schema') expect(fixture.requests.some((request) => request.body.includes('tools/call'))).toBe(false);
});
it('S61 credential echoes are scrubbed before model, SQLite/WAL, data files or logs', async () => {
  await remote(); fixture.state.echoSecrets = true; const started = await run(a, { mcpServerIds: ['mine'] }); expect(started.status).toBe(202);
  const events = await daemon.request({ path: `/api/runs/${started.json.runId}/events`, cookie: a.cookie }); expect(events.text).toContain('"status":"succeeded"');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
  const columns = tables.map(({ name }) => JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all())).join('');
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => { const file = path.join(dir, name); const stat = statSync(file, { throwIfNoEntry: false });
    return stat?.isDirectory() ? walk(file) : stat?.isFile() && stat.size < 64 * 1024 * 1024 ? [file] : []; });
  for (const form of encodedForms(MCP_HEADER_SENTINEL)) {
    expect(events.text + columns + logs.join('') + providerRequests.join('')).not.toContain(form);
    for (const file of walk(root)) expect(readFileSync(file).toString('latin1'), file).not.toContain(form);
  }
});
it('S61 routines retain selections, permit disable/clear after disconnect, and revalidate manual dispatch', async () => {
  await remote();
  const result = await call(a, 'POST', '/api/routines', { name: 'S61 routine', prompt: 'Read my server', agentId: 'openai', schedule: { kind: 'daily', time: '09:30', timezone: 'UTC' }, context: { mcpServerIds: ['mine'] } });
  expect(result.status, result.text).toBe(201); expect(result.json.routine.context.mcpServerIds).toEqual(['mine']); const id = result.json.routine.id;
  expect((await call(b, 'GET', `/api/routines/${id}`)).status).toBe(404);
  const started = await call(a, 'POST', `/api/routines/${id}/run`, {}); expect(started.status, started.text).toBe(202);
  await until(() => call(a, 'GET', `/api/routines/${id}/runs`), (r) => r.json.runs[0]?.status === 'succeeded');
  await call(a, 'PATCH', '/api/multiuser/mcp/servers/mine', { revision: 1, enabled: false });
  const denied = await call(a, 'POST', `/api/routines/${id}/run`, {}); expect(denied.status).toBe(202);
  await until(() => call(a, 'GET', `/api/routines/${id}/runs`), (r) => r.json.runs[0]?.status === 'failed');
  expect((await call(a, 'PATCH', `/api/routines/${id}`, { enabled: false, name: 'Disabled' })).status).toBe(200);
  expect((await call(a, 'PATCH', `/api/routines/${id}`, { enabled: true })).status).toBe(404);
  expect((await call(a, 'PATCH', `/api/routines/${id}`, { context: { mcpServerIds: [] } })).status).toBe(200);
});
