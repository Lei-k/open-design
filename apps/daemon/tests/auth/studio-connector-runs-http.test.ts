import { randomUUID } from 'node:crypto';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { PERSONAL_CODEX_MOCK, linkCodex, setTurnMode, until } from './personal-codex-helpers.js';
import { toolTokenRegistry } from '../../src/tool-tokens.js';
import { StudioConnectorRuntime } from '../../src/connectors/studio-runtime.js';
import { AuthStore } from '../../src/storage/auth-store.js';
import { CompanyComposioStore, StudioConnectorStore } from '../../src/storage/studio-connectors.js';
import { cleanupIsolatedDataRoot, loadIsolatedServerModule, login, multiUserOptions, provisionAccounts, startMultiUserDaemon,
  MU_TEST_ORIGIN, type Principal, type StartedMultiUserDaemon } from './multiuser-harness.js';
const KEY = 's59_company_key_SECRET_12345678';
const ARGUMENT = 'S59_PRIVATE_TOOL_ARGUMENT';
const RESULT = 'S59_PRIVATE_TOOL_RESULT';
const OAUTH = 'S59_PRIVATE_OAUTH_TOKEN';
let daemon: StartedMultiUserDaemon; let root: string; let admin: Principal; let a: Principal; let b: Principal;
let db: Database.Database; let auth: AuthStore; let runtime: StudioConnectorRuntime; let store: StudioConnectorStore; let company: CompanyComposioStore;
let rejectProvider = false;
let holdMetadata = false; let releaseMetadata: (() => void) | undefined;
let calls: Array<{ url: string; body: Record<string, unknown> }> = [];
let providerRequests: Record<string, unknown>[] = [];
const logs: string[] = [];
const composio: typeof fetch = async (url, init) => {
  const body = JSON.parse(String(init?.body ?? '{}')); calls.push({ url: String(url), body });
  if (rejectProvider) return new Response(`${KEY} ${OAUTH} ${ARGUMENT} ${RESULT}`, { status: 401 });
  if (String(url).includes('/api/v3.1/tools?') && holdMetadata) await new Promise<void>((resolve) => { releaseMetadata = resolve; });
  if (String(url).includes('/api/v3.1/tools?')) return Response.json({ items: [
    { slug: 'HUBSPOT_GET_CONTACT', name: 'Get contact', description: KEY, oauth_token: OAUTH, toolkit: { slug: 'hubspot' }, scopes: ['read'], input_parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false } },
    { slug: 'HUBSPOT_DELETE_CONTACT', name: 'Delete contact', toolkit: { slug: 'hubspot' }, scopes: ['write'] },
    { slug: 'GITHUB_GET_REPOSITORY', scopes: ['read'] },
  ] });
  return Response.json({ successful: true, data: { title: RESULT, oauth_token: OAUTH, apiKey: KEY, raw: ARGUMENT } });
};
const openai: typeof fetch = async (_url, init) => {
  const body = JSON.parse(String(init?.body)); providerRequests.push(body);
  const history = body.input as Array<Record<string, unknown>>;
  const called = history.some((item) => item.type === 'function_call_output');
  const tools = body.tools as Array<{ name: string }>;
  const granted = tools.some((tool) => tool.name === 'connectors_execute');
  const output = called || !granted ? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done' }] }]
    : [{ type: 'function_call', call_id: 'connector-call', name: 'connectors_execute', arguments: JSON.stringify({ connectorId: 'github', toolName: 'github.github_search_repositories', input: { query: ARGUMENT } }) }];
  return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { output, usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
};
const mutate = (user: Principal, method: string, route: string, body?: unknown) => daemon.request({ method, path: route, cookie: user.cookie,
  headers: { origin: MU_TEST_ORIGIN }, ...(body === undefined ? {} : { body }) });
async function user(): Promise<Principal> {
  const username = `s59-${randomUUID().slice(0, 8)}`; const password = `${username}-battery-staple-password`;
  const made = await mutate(admin, 'POST', '/api/auth/users', { username, password, role: 'user' });
  expect(made.status, made.text).toBe(201);
  return { id: made.json.account.id, username, password, cookie: await login(daemon, username, password) };
}
function grant(user: Principal, ids = ['github']) {
  const bound = runtime.capture({ accountId: user.id, username: user.username, role: 'user', sessionId: `routine:${user.id}`, sessionExpiresAt: Date.now() + 60_000 }, ids);
  return toolTokenRegistry.mint({ runId: randomUUID(), projectId: 's59-fixture-project', studioConnectors: bound! });
}
const tool = (token: string, args?: unknown, query = '') => daemon.request({ method: args === undefined ? 'GET' : 'POST',
  path: args === undefined ? `/api/tools/connectors/list${query}` : '/api/tools/connectors/execute', headers: { authorization: `Bearer ${token}` }, ...(args === undefined ? {} : { body: args }) });
const args = { connectorId: 'github', toolName: 'github.github_search_repositories', input: { query: ARGUMENT } };
beforeAll(async () => {
  ({ dataRoot: root } = await loadIsolatedServerModule());
  for (const level of ['log', 'warn', 'error', 'info'] as const) vi.spyOn(console, level).mockImplementation((...values) => { logs.push(values.map(String).join(' ')); });
  daemon = await startMultiUserDaemon(multiUserOptions({ testComposioFetch: composio, testCompanyOpenAIFetch: openai, testPersonalCodexAppServer: PERSONAL_CODEX_MOCK }));
  ({ admin } = await provisionAccounts(daemon, []));
  db = new Database(path.join(root, 'app.sqlite'));
  auth = AuthStore.open({ dataRoot: root });
  runtime = new StudioConnectorRuntime({ db, dataRoot: root, auth, sessionCurrent: () => true, fetch: composio });
  store = new StudioConnectorStore(db); company = new CompanyComposioStore(db, root);
  const cfg = await daemon.request({ path: '/api/admin/pool/openai', cookie: admin.cookie });
  expect((await mutate(admin, 'PUT', '/api/admin/pool/openai', { revision: cfg.json.provider.revision, apiKey: 'sk-S59-openai-fixture', model: 'fixture', enabled: true, capacity: 2 })).status).toBe(200);
}, 120_000);
beforeEach(async () => {
  a = await user(); b = await user();
  company.update(admin.id, { revision: company.read().revision, apiKey: KEY });
  for (const user of [a, b]) store.saveConnection(user.id, 'github', { providerConnectionId: `ca_${user.id}`, accountLabel: user.username, credentialRevision: company.read().credentialRevision });
  store.saveConnection(b.id, 'notion', { providerConnectionId: 'ca_B_notion', accountLabel: b.username, credentialRevision: company.read().credentialRevision });
  calls = []; providerRequests = []; rejectProvider = false; holdMetadata = false; releaseMetadata = undefined; logs.length = 0;
});
afterAll(async () => { toolTokenRegistry.clear(); runtime?.close(); auth?.close(); db?.close(); await daemon?.close(); vi.restoreAllMocks(); cleanupIsolatedDataRoot(); });

it('S59 account grant lists selected apps and executes with A entity and binding, redacted results and metadata-only audit', async () => {
  const g = grant(a);
  expect((await tool(g.token)).json.connectors.map((item: { id: string }) => item.id)).toEqual(['github']);
  const result = await tool(g.token, args);
  expect(result.status, result.text).toBe(200);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.body).toMatchObject({ user_id: store.entityFor(a.id), connected_account_id: `ca_${a.id}`, arguments: args.input });
  expect(result.text).not.toMatch(new RegExp(`${KEY}|${OAUTH}|${ARGUMENT}`));
  const audit = JSON.stringify(db.prepare('SELECT * FROM studio_connector_tool_audit').all());
  expect(audit).toContain(g.runId); expect(audit).toContain(a.id);
  expect(audit + logs.join(' ')).not.toMatch(new RegExp(`${KEY}|${OAUTH}|${ARGUMENT}|${RESULT}`));
});
it.each(['notion', 'unknown', 'slack'])('S59 ungranted, foreign and missing %s are indistinguishable', async (id) => {
  const g = grant(a); const denied = await tool(g.token, { ...args, connectorId: id });
  expect(denied.status).toBe(403); expect(denied.json.error.code).toBe('CONNECTOR_NOT_GRANTED'); expect(calls).toEqual([]);
});
it.each([{ entity: 'foreign' }, { user_id: 'foreign' }, { connected_account_id: 'ca_B_notion' }, { projectId: 'foreign' }])('S59 body identity override %j is refused', async (extra) => {
  const result = await tool(grant(a).token, { ...args, ...extra });
  expect(result.status).toBe(400); expect(calls).toEqual([]);
});
it('S59 list cannot select a foreign connector through query and desktop grants cannot enter Studio', async () => {
  expect((await tool(grant(a).token, undefined, '?connectorId=notion&entity=foreign')).status).toBe(400);
  const desktop = toolTokenRegistry.mint({ runId: randomUUID(), projectId: 'host' });
  expect((await tool(desktop.token)).json.error.code).toBe('CONNECTOR_NOT_GRANTED'); expect(calls).toEqual([]);
});
it.each(['disable', 'clear', 'rotate', 'disconnect', 'replace', 'pilot', 'logout', 'sessions-revoke', 'password-reset', 'role-change'])('S59 authority table: %s refuses subsequent calls without provider I/O', async (change) => {
  const g = grant(a);
  if (change === 'disable') await mutate(admin, 'PATCH', `/api/auth/users/${a.id}`, { active: false });
  if (change === 'clear' || change === 'rotate') company.update(admin.id, { revision: company.read().revision, apiKey: change === 'clear' ? null : 'S59_ROTATED_COMPOSIO_KEY' });
  if (change === 'disconnect') store.markDisconnected(a.id, 'github');
  if (change === 'replace') store.saveConnection(a.id, 'github', { providerConnectionId: 'replacement', accountLabel: 'replacement', credentialRevision: company.read().credentialRevision });
  if (change === 'pilot') await mutate(admin, 'PUT', `/api/admin/users/${a.id}/studio-pilot`, { revision: 0, studioPilot: false });
  if (change === 'logout') await mutate(a, 'POST', '/api/auth/logout', {});
  if (change === 'sessions-revoke') await mutate(admin, 'POST', `/api/auth/users/${a.id}/sessions/revoke`, {});
  if (change === 'password-reset') await mutate(admin, 'POST', `/api/auth/users/${a.id}/password`, { password: 'S59-new-battery-staple-password' });
  if (change === 'role-change') await mutate(admin, 'PATCH', `/api/auth/users/${a.id}`, { role: 'admin' });
  for (const body of [undefined, args]) {
    const result = await tool(g.token, body); expect(result.status, result.text).toBe(409);
    expect(result.json.error.code).toBe('MULTIUSER_CONNECTOR_AUTHORITY_CHANGED');
  }
  expect(calls).toEqual([]);
});

it('S59 client identity headers cannot replace the owner and another account logout preserves the grant', async () => {
  const g = grant(a);
  await mutate(b, 'POST', '/api/auth/logout', {});
  const result = await daemon.request({ method: 'POST', path: '/api/tools/connectors/execute', body: args,
    headers: { authorization: `Bearer ${g.token}`, 'x-od-account-id': b.id, 'x-composio-entity': store.entityFor(b.id) } });
  expect(result.status, result.text).toBe(200);
  expect(calls[0]!.body.user_id).toBe(store.entityFor(a.id));
});
it('S59 provider error payload never enters responses logs or audit', async () => {
  rejectProvider = true;
  const result = await tool(grant(a).token, args);
  expect(result.status).toBe(502); expect(result.json.error.code).toBe('MULTIUSER_CONNECTOR_PROVIDER_FAILED');
  const audit = JSON.stringify(db.prepare('SELECT * FROM studio_connector_tool_audit').all());
  expect(result.text + logs.join(' ') + audit).not.toMatch(new RegExp(`${KEY}|${OAUTH}|${ARGUMENT}|${RESULT}`));
});
async function target() {
  const projectId = randomUUID(); const made = await mutate(a, 'POST', '/api/projects', { id: projectId, name: 'S59 project' });
  expect(made.status, made.text).toBe(200); return { projectId, conversationId: made.json.conversationId };
}
it.each(['company_pool', 'personal_api_key'])('S59 %s admission captures selection and exposes tools only for granted turns', async (source) => {
  if (source === 'personal_api_key') expect((await mutate(a, 'PUT', '/api/multiuser/settings/provider-keys/openai', { revision: 0, apiKey: 'sk-S59-own-fixture', model: 'fixture' })).status).toBe(200);
  const project = await target();
  const run = await mutate(a, 'POST', '/api/runs', { ...project, message: 'Read my app', executionSource: source,
    agentId: source === 'company_pool' ? 'openai' : 'openai-byok', context: { connectorIds: ['github'] } });
  expect(run.status, run.text).toBe(202); expect(run.json.run.connectorIds).toEqual(['github']);
  const events = await daemon.request({ path: `/api/runs/${run.json.runId}/events`, cookie: a.cookie });
  expect(events.text).toContain('"status":"succeeded"'); expect(calls).toHaveLength(1);
  expect(calls[0]!.body.user_id).toBe(store.entityFor(a.id));
  expect(events.text).not.toMatch(new RegExp(`${KEY}|${OAUTH}|${ARGUMENT}|${RESULT}`));
  const next = await mutate(a, 'POST', '/api/runs', { ...project, message: 'No apps selected', executionSource: source,
    agentId: source === 'company_pool' ? 'openai' : 'openai-byok' });
  expect(next.status).toBe(202); await daemon.request({ path: `/api/runs/${next.json.runId}/events`, cookie: a.cookie });
  const lastTools = providerRequests.at(-1)!.tools as Array<{ name: string }>;
  expect(lastTools.some((tool) => tool.name.startsWith('connectors_'))).toBe(false);
});
it('S59 run admission foreign, not-connected and unknown connector refusals match', async () => {
  const refusals = [];
  for (const id of ['notion', 'slack', 'unknown']) {
    const result = await mutate(a, 'POST', '/api/runs', { ...await target(), message: 'Read app', agentId: 'openai', context: { connectorIds: [id] } });
    expect(result.status).toBe(403); refusals.push(result.json.error);
  }
  expect(refusals[0]).toEqual(refusals[1]); expect(refusals[1]).toEqual(refusals[2]); expect(calls).toEqual([]);
});
it('S59 unlinked personal source refuses connector admission typed without dropping selection', async () => {
  const result = await mutate(a, 'POST', '/api/runs', { ...await target(), message: 'Read app', agentId: 'codex', context: { connectorIds: ['github'] } });
  expect(result.status).toBe(409); expect(result.json.error.code).toBe('MULTIUSER_PERSONAL_UNAVAILABLE'); expect(calls).toEqual([]);
});

it('S59 personal Codex mock executes the granted app through the asynchronous native tool bridge', async () => {
  await linkCodex(daemon, root, a, 's59@example.com');
  setTurnMode(root, a, { reply: 'Done' });
  const run = await mutate(a, 'POST', '/api/runs', { ...await target(), message: '[mock-connector]', agentId: 'codex', context: { connectorIds: ['github'] } });
  expect(run.status, run.text).toBe(202);
  const events = await daemon.request({ path: `/api/runs/${run.json.runId}/events`, cookie: a.cookie });
  expect(events.text).toContain('"status":"succeeded"');
  expect(calls).toHaveLength(1);
  expect(calls[0]!.body.user_id).toBe(store.entityFor(a.id));
  expect(events.text).not.toMatch(new RegExp(`${KEY}|${OAUTH}|${ARGUMENT}|${RESULT}`));
});

it('S59 connected catalog-only apps hydrate read tools using the same safety classifier as desktop', async () => {
  store.saveConnection(a.id, 'hubspot', { providerConnectionId: 'ca_A_hubspot', accountLabel: 'A', credentialRevision: company.read().credentialRevision });
  const g = grant(a, ['hubspot']);
  const listed = await tool(g.token);
  expect(listed.status, listed.text).toBe(200);
  expect(listed.text).not.toMatch(new RegExp(`${KEY}|${OAUTH}`));
  expect(listed.json.connectors[0].tools.map((item: { name: string }) => item.name)).toEqual(['hubspot.hubspot_get_contact']);
  const result = await tool(g.token, { connectorId: 'hubspot', toolName: 'hubspot.hubspot_get_contact', input: { id: 'fixture' } });
  expect(result.status, result.text).toBe(200);
  expect(calls.at(-1)!.body).toMatchObject({ user_id: store.entityFor(a.id), connected_account_id: 'ca_A_hubspot' });
});

it('S59 discovery authority loss refuses the list and sends no subsequent tool execution', async () => {
  store.saveConnection(a.id, 'hubspot', { providerConnectionId: 'ca_discovery', accountLabel: 'A', credentialRevision: company.read().credentialRevision });
  holdMetadata = true;
  const pending = tool(grant(a, ['hubspot']).token);
  await until(() => releaseMetadata, (release) => !!release, 'metadata provider entered');
  company.update(admin.id, { revision: company.read().revision, apiKey: null });
  releaseMetadata!();
  const result = await pending;
  expect(result.status).toBe(409); expect(result.json.error.code).toBe('MULTIUSER_CONNECTOR_AUTHORITY_CHANGED');
  expect(calls).toHaveLength(1); expect(calls[0]!.url).toContain('/api/v3.1/tools?');
});
