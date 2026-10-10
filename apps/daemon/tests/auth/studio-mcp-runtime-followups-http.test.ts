// S62 Part A — S61 review follow-ups for the run-owner remote MCP runtime.
// Promoted from the immutable S61 reviewer probes (a scratch handoff outside git):
// A1 quadratic SSE parsing (CPU-bounded), A2 unbudgeted/unaudited discovery,
// A3 legacy SSE keep-alive comments, A5 tool results corrupted by shape filters.
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { cleanupIsolatedDataRoot, loadIsolatedServerModule, login, multiUserOptions, provisionAccounts, startMultiUserDaemon, MU_TEST_ORIGIN, type Principal, type StartedMultiUserDaemon } from './multiuser-harness.js';
import { startMcpFixture, encodedForms, MCP_HEADER_SENTINEL, type McpFixture } from './studio-mcp-fixture.js';
import { startSlowSseFixture, type SlowSseFixture } from './studio-mcp-slow-fixture.js';
import { until } from './personal-codex-helpers.js';
import { toolTokenRegistry } from '../../src/tool-tokens.js';
import { StudioMcpRuntime, studioMcpToolName } from '../../src/mcp-client/studio-runtime.js';
import { AuthStore } from '../../src/storage/auth-store.js';

let daemon: StartedMultiUserDaemon; let fixture: McpFixture; let slow: SlowSseFixture; let a: Principal; let admin: Principal; let root: string;
let db: Database.Database; let auth: AuthStore; let runtime: StudioMcpRuntime;
const active: Array<{ id: string; actor: Principal }> = [];
const call = (actor: Principal, method: string, p: string, body?: unknown) => daemon.request({ method, path: p, cookie: actor.cookie, headers: { origin: MU_TEST_ORIGIN }, ...(body ? { body } : {}) });
// The model never answers: the run stays active while the test drives the bearer tool endpoints.
const openai: typeof fetch = async (_url, init) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
const resolve = async (host: string) => (host.endsWith('.fixture.test') ? ['127.0.0.1'] : []);
const allowAddress = (address: string) => address === '127.0.0.1';

async function fresh(): Promise<Principal> {
  const username = `s62a-${randomUUID().slice(0, 8)}`; const password = `${username}-battery-staple-password`;
  const made = await call(admin, 'POST', '/api/auth/users', { username, password, role: 'user' }); expect(made.status).toBe(201);
  return { id: made.json.account.id, username, password, cookie: await login(daemon, username, password) };
}
async function grantFor(url: string, transport: 'http' | 'sse' = 'http') {
  const made = await call(a, 'POST', '/api/multiuser/mcp/servers', { id: 'mine', transport, url, headers: { 'X-Api-Key': MCP_HEADER_SENTINEL } });
  expect(made.status, made.text).toBe(201);
  const project = await call(a, 'POST', '/api/projects', { id: randomUUID(), name: 'S62 A' }); expect(project.status).toBe(200);
  const started = await call(a, 'POST', '/api/runs', { projectId: project.json.project.id, conversationId: project.json.conversationId, message: 'x', executionSource: 'company_pool', agentId: 'openai' });
  expect(started.status, started.text).toBe(202); active.push({ id: started.json.runId, actor: a });
  await until(() => call(a, 'GET', `/api/runs/${started.json.runId}`), (r) => r.json.status === 'running');
  const bound = runtime.capture({ accountId: a.id, username: a.username, role: 'user', sessionId: `routine:${a.id}`, sessionExpiresAt: Date.now() + 60_000 }, ['mine']);
  return toolTokenRegistry.mint({ runId: started.json.runId, projectId: started.json.run.projectId, studioMcp: bound! });
}
const tools = (token: string, args?: unknown) => daemon.request({ method: args ? 'POST' : 'GET', path: args ? '/api/tools/mcp/execute' : '/api/tools/mcp/list',
  headers: { authorization: `Bearer ${token}` }, ...(args ? { body: args } : {}) });
const args = { serverId: 'mine', toolName: studioMcpToolName('mine', 'lookup'), input: {} };
const cpuMs = (since: NodeJS.CpuUsage) => { const used = process.cpuUsage(since); return (used.user + used.system) / 1000; };

beforeAll(async () => {
  ({ dataRoot: root } = await loadIsolatedServerModule()); fixture = await startMcpFixture(); slow = await startSlowSseFixture();
  daemon = await startMultiUserDaemon(multiUserOptions({ testCompanyOpenAIFetch: openai, testMcpOutbound: { resolve, allowAddress, timeoutMs: 10_000 } }));
  ({ admin } = await provisionAccounts(daemon, []));
  db = new Database(path.join(root, 'app.sqlite')); auth = AuthStore.open({ dataRoot: root });
  runtime = new StudioMcpRuntime({ db, dataRoot: root, auth, sessionCurrent: () => true, outbound: { resolve, allowAddress, timeoutMs: 10_000 } });
  expect((await call(admin, 'PUT', '/api/admin/pool/openai', { revision: 0, apiKey: 'sk-S62-company-fixture-0123456789', model: 'fixture', enabled: true, capacity: 3 })).status).toBe(200);
}, 120_000);
beforeEach(async () => {
  a = await fresh(); fixture.requests.length = 0;
  Object.assign(fixture.state, { sseComment: false, callText: null, callJson: null, echoSecrets: false, tools: null });
});
afterEach(async () => { for (const item of active.splice(0)) await call(item.actor, 'POST', `/api/runs/${item.id}/cancel`, {}); toolTokenRegistry.clear(); });
afterAll(async () => { runtime?.close(); auth?.close(); db?.close(); await daemon?.close(); await fixture?.close(); await slow?.close(); cleanupIsolatedDataRoot(); });

// A1: CPU (not wall clock) is bounded by a budget proportional to the bytes the daemon could have read.
it.each([['http', 'drip'], ['sse', 'drip'], ['http', 'bulk'], ['sse', 'bulk'], ['http', 'notes']] as const)(
  'S62 A1 a %s tools/call stream of many %s frames costs CPU proportional to its bytes', async (transport, kind) => {
    const grant = await grantFor(slow.url(`/${transport}/${kind}`), transport);
    const bytesBefore = await slow.streamBytes();
    const since = process.cpuUsage();
    const result = await tools(grant.token, args);
    const used = cpuMs(since); const kib = (await slow.streamBytes() - bytesBefore) / 1024;
    if (kind === 'drip') expect(result.status, result.text).toBeGreaterThanOrEqual(400); // never answers; refused at the frame cap
    else { expect(result.status, result.text).toBe(200); expect(result.json.output.content[0].text).toBe('bulk done'); }
    process.stderr.write(`S62 A1 ${transport}/${kind}: status ${result.status}, cpu ${Math.round(used)} ms for ${Math.round(kib)} KiB\n`);
    // Linear parsing is well under 1 ms per KiB; the S61 quadratic parser burned whole seconds.
    expect(used, `cpu ${Math.round(used)} ms for ${Math.round(kib)} KiB`).toBeLessThan(2000 + 2 * kib);
  }, 60_000);

// S62 Repair 1 (P1): ONE frame that grows a byte at a time and never ends must also cost
// CPU proportional to its bytes — on streamable HTTP, legacy SSE and the connection test.
// Promoted from the S62 reviewer's large-frame probes (a scratch handoff outside git).
it.each(['http', 'sse'] as const)('S62 R1 a %s tools/call answered by one ever-growing unfinished frame costs CPU proportional to its bytes', async (transport) => {
  const grant = await grantFor(slow.url(`/${transport}/grow`), transport);
  const bytesBefore = await slow.streamBytes();
  const since = process.cpuUsage();
  const result = await tools(grant.token, args);
  const used = cpuMs(since); const kib = (await slow.streamBytes() - bytesBefore) / 1024;
  expect(result.status, result.text).toBeGreaterThanOrEqual(400); // never completes: refused at the deadline
  process.stderr.write(`S62 R1 ${transport}/grow: status ${result.status}, cpu ${Math.round(used)} ms for ${Math.round(kib)} KiB\n`);
  expect(kib).toBeGreaterThan(900);
  expect(used, `cpu ${Math.round(used)} ms for ${Math.round(kib)} KiB`).toBeLessThan(2000 + 2 * kib);
}, 60_000);
it('S62 R1 the connection test answered by one ever-growing unfinished frame costs CPU proportional to its bytes', async () => {
  const made = await call(a, 'POST', '/api/multiuser/mcp/servers', { id: 'probe', transport: 'http', url: slow.url('/probe/grow'), headers: { 'X-Api-Key': MCP_HEADER_SENTINEL } });
  expect(made.status, made.text).toBe(201);
  const bytesBefore = await slow.streamBytes();
  const since = process.cpuUsage();
  const result = await call(a, 'POST', '/api/multiuser/mcp/servers/probe/test', {});
  const used = cpuMs(since); const kib = (await slow.streamBytes() - bytesBefore) / 1024;
  process.stderr.write(`S62 R1 probe/grow: status ${result.status}, cpu ${Math.round(used)} ms for ${Math.round(kib)} KiB\n`);
  expect(kib).toBeGreaterThan(900);
  expect(used, `cpu ${Math.round(used)} ms for ${Math.round(kib)} KiB`).toBeLessThan(2000 + 2 * kib);
}, 60_000);

// A2: discovery counts against the run budget, stops after exhaustion and is audited.
it('S62 A2 mcp_list after the run budget is exhausted sends nothing and writes an audit row', async () => {
  const grant = await grantFor(fixture.url('/runtime'));
  const insert = db.prepare('INSERT INTO studio_mcp_tool_audit (actor_account_id, server_id, tool_name, run_id, outcome, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (let i = 0; i < 60; i++) insert.run(a.id, 'mine', 'x', grant.runId, 'ok', 1, Date.now());
  expect((await tools(grant.token, args)).status).toBe(429);
  // The refused execute writes its own (pre-existing) audit row; count only the lists'.
  const lastId = (db.prepare('SELECT MAX(id) AS id FROM studio_mcp_tool_audit').get() as { id: number }).id;
  const before = fixture.requests.length;
  for (let i = 0; i < 5; i++) { const listed = await tools(grant.token); expect(listed.status, listed.text).toBe(429); expect(listed.json.error.code).toBe('CONNECTOR_RATE_LIMITED'); }
  expect(fixture.requests.length - before).toBe(0);
  const rows = db.prepare("SELECT tool_name, outcome, duration_ms FROM studio_mcp_tool_audit WHERE run_id = ? AND tool_name = '' AND id > ?").all(grant.runId, lastId) as Array<{ outcome: string; duration_ms: number }>;
  expect(rows).toHaveLength(5); expect(rows.every((row) => row.outcome === 'CONNECTOR_RATE_LIMITED' && Number.isInteger(row.duration_ms))).toBe(true);
});
it('S62 A2 discovery is budgeted and audited once, then served from the run cache', async () => {
  const grant = await grantFor(fixture.url('/runtime'));
  for (let i = 0; i < 4; i++) { const listed = await tools(grant.token); expect(listed.status, listed.text).toBe(200); expect(listed.json.servers[0].tools[0].name).toBe(args.toolName); }
  expect(fixture.requests.filter((request) => request.body.includes('tools/list'))).toHaveLength(1);
  const rows = db.prepare("SELECT outcome FROM studio_mcp_tool_audit WHERE run_id = ? AND tool_name = ''").all(grant.runId);
  expect(rows).toEqual([{ outcome: 'ok' }]);
  // The audited discovery counts: 59 executes remain.
  const results = await Promise.all(Array.from({ length: 62 }, () => tools(grant.token, args)));
  expect(results.filter((r) => r.status === 200)).toHaveLength(59); expect(results.filter((r) => r.status === 429)).toHaveLength(3);
}, 30_000);

// A3: SSE comment / keep-alive blocks (no data lines) are skipped, not parsed as messages.
it('S62 A3 a legacy SSE keep-alive comment before the endpoint is accepted', async () => {
  fixture.state.sseComment = true;
  const grant = await grantFor(fixture.url('/runtime-sse'), 'sse');
  const result = await tools(grant.token, args); expect(result.status, result.text).toBe(200); expect(result.json.output.content[0].text).toBe('fixture result');
});

// A5: tool results redact known credential representations only; readable base64 and scheme words stay.
it('S62 A5 tool results keep readable base64 and ordinary text but still scrub every known credential form', async () => {
  const readable = Buffer.from('hello, this is perfectly ordinary readable text').toString('base64');
  const text = `payload ${readable} Bearer abcdefghijklmnop basic internationalization`;
  fixture.state.callText = text; fixture.state.echoSecrets = true;
  const grant = await grantFor(fixture.url('/runtime'));
  const result = await tools(grant.token, args); expect(result.status, result.text).toBe(200);
  const output = String(result.json.output.content[0].text);
  expect(output.startsWith(text)).toBe(true);
  for (const form of encodedForms(MCP_HEADER_SENTINEL)) expect(output).not.toContain(form);
});
