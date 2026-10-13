import { currentAccountRevision } from './helpers.js';
// S60 Part A (#62/#63/#64): promoted from the immutable S59 reviewer reproducer
// (`s59-cancel-window.test.ts`) plus the grant-lifetime and parallel-limit
// follow-ups. A grant revoked, or a run cancelled, while tool discovery is in
// flight must never reach the provider; discovery itself is aborted on cancel.
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { until } from './personal-codex-helpers.js';
import { DEFAULT_TOOL_TOKEN_TTL_MS, toolTokenRegistry } from '../../src/tool-tokens.js';
import { StudioConnectorRuntime } from '../../src/connectors/studio-runtime.js';
import { AuthStore } from '../../src/storage/auth-store.js';
import { CompanyComposioStore, StudioConnectorStore } from '../../src/storage/studio-connectors.js';
import { cleanupIsolatedDataRoot, loadIsolatedServerModule, login, multiUserOptions, provisionAccounts, startMultiUserDaemon,
  MU_TEST_ORIGIN, type Principal, type StartedMultiUserDaemon } from './multiuser-harness.js';

const KEY = 's60_company_key_12345678';
let daemon: StartedMultiUserDaemon; let root: string; let admin: Principal; let a: Principal;
let db: Database.Database; let auth: AuthStore; let runtime: StudioConnectorRuntime; let store: StudioConnectorStore; let company: CompanyComposioStore;
let holdMetadata = false; let releaseMetadata: (() => void) | undefined; let metadataAborted = false; let ignoreAbort = false;
let holdExecute = false; const releaseExecutes: Array<() => void> = [];
let metadataStatus = 200;
let calls: Array<{ url: string; at: number }> = [];
let openaiOnFirstCall: (() => void) | undefined;
let modelSawToolOutput: string[] = [];

const composio: typeof fetch = async (url, init) => {
  calls.push({ url: String(url), at: Date.now() });
  if (String(url).includes('/api/v3.1/tools?') && holdMetadata) {
    await new Promise<void>((resolve, reject) => {
      releaseMetadata = resolve;
      const signal = init?.signal;
      signal?.addEventListener('abort', () => {
        metadataAborted = true;
        if (!ignoreAbort) reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
      }, { once: true });
    });
  }
  if (String(url).includes('/api/v3.1/tools?') && metadataStatus !== 200) return new Response('unavailable', { status: metadataStatus });
  if (String(url).includes('/api/v3.1/tools?')) return Response.json({ items: [
    { slug: 'HUBSPOT_GET_CONTACT', name: 'Get contact', toolkit: { slug: 'hubspot' }, scopes: ['read'],
      input_parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false } } ] });
  if (String(url).includes('/tools/execute/') && holdExecute) await new Promise<void>((resolve) => { releaseExecutes.push(resolve); });
  return Response.json({ successful: true, data: { title: 'private' } });
};
const openai: typeof fetch = async (_url, init) => {
  const body = JSON.parse(String(init?.body));
  const outputs = (body.input as Array<Record<string, unknown>>).filter((item) => item.type === 'function_call_output');
  modelSawToolOutput.push(...outputs.map((item) => String(item.output)));
  if (!outputs.length) { openaiOnFirstCall?.(); openaiOnFirstCall = undefined; }
  const output = outputs.length ? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done' }] }]
    : [{ type: 'function_call', call_id: 'c1', name: 'connectors_execute', arguments: JSON.stringify({ connectorId: 'hubspot', toolName: 'hubspot.hubspot_get_contact', input: { id: 'x' } }) }];
  return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { output, usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
};
const mutate = (user: Principal, method: string, route: string, body?: unknown) => daemon.request({ method, path: route, cookie: user.cookie,
  headers: { origin: MU_TEST_ORIGIN }, ...(body === undefined ? {} : { body }) });
const executes = () => calls.filter((call) => call.url.includes('/tools/execute/'));
const routineActor = (user: Principal) => ({ accountId: user.id, username: user.username, role: 'user' as const, sessionId: `routine:${user.id}`, sessionExpiresAt: Date.now() + 60_000 });
const execute = (token: string, body: unknown) => daemon.request({ method: 'POST', path: '/api/tools/connectors/execute', headers: { authorization: `Bearer ${token}` }, body });
async function companyRun(user: Principal) {
  const projectId = randomUUID(); const made = await mutate(user, 'POST', '/api/projects', { id: projectId, name: 's60' });
  const run = await mutate(user, 'POST', '/api/runs', { projectId, conversationId: made.json.conversationId, message: 'read', agentId: 'openai', context: { connectorIds: ['hubspot'] } });
  expect(run.status, run.text).toBe(202);
  return run.json.runId as string;
}

beforeAll(async () => {
  ({ dataRoot: root } = await loadIsolatedServerModule());
  daemon = await startMultiUserDaemon(multiUserOptions({ testComposioFetch: composio, testCompanyOpenAIFetch: openai }));
  ({ admin } = await provisionAccounts(daemon, []));
  db = new Database(path.join(root, 'app.sqlite'));
  auth = AuthStore.open({ dataRoot: root });
  runtime = new StudioConnectorRuntime({ db, dataRoot: root, auth, sessionCurrent: () => true, fetch: composio });
  store = new StudioConnectorStore(db); company = new CompanyComposioStore(db, root);
  const cfg = await daemon.request({ path: '/api/admin/pool/openai', cookie: admin.cookie });
  expect((await mutate(admin, 'PUT', '/api/admin/pool/openai', { revision: cfg.json.provider.revision, apiKey: 'sk-S60-openai-fixture', model: 'fixture', enabled: true, capacity: 2 })).status).toBe(200);
}, 120_000);
beforeEach(async () => {
  const username = `s60-${randomUUID().slice(0, 8)}`; const password = `${username}-battery-staple-password`;
  const made = await mutate(admin, 'POST', '/api/auth/users', { username, password, role: 'user' });
  a = { id: made.json.account.id, username, password, cookie: await login(daemon, username, password) };
  company.update(admin.id, { revision: company.read().revision, apiKey: KEY });
  for (const id of ['hubspot', 'github']) store.saveConnection(a.id, id, { providerConnectionId: `ca_${id}_${a.id}`, accountLabel: 'A', credentialRevision: company.read().credentialRevision });
  calls = []; holdMetadata = true; releaseMetadata = undefined; metadataAborted = false; ignoreAbort = false; holdExecute = false; releaseExecutes.length = 0; metadataStatus = 200;
  openaiOnFirstCall = undefined; modelSawToolOutput = [];
});
afterAll(async () => { toolTokenRegistry.clear(); runtime?.close(); auth?.close(); db?.close(); await daemon?.close(); vi.restoreAllMocks(); cleanupIsolatedDataRoot(); });

it('S60 A1 (REPRO-1): a grant revoked while discovery is in flight gets a typed refusal and never reaches the provider', async () => {
  const bound = runtime.capture(routineActor(a), ['hubspot']);
  const g = toolTokenRegistry.mint({ runId: randomUUID(), projectId: 'p', studioConnectors: bound! });
  const pending = execute(g.token, { connectorId: 'hubspot', toolName: 'hubspot.hubspot_get_contact', input: { id: 'x' } });
  await until(() => releaseMetadata, (r) => !!r, 'metadata entered');
  toolTokenRegistry.revokeToken(g.token);
  releaseMetadata!();
  const result = await pending;
  expect(result.status, result.text).toBe(401);
  expect(result.json.error.code).toBe('TOOL_TOKEN_INVALID');
  expect(executes()).toHaveLength(0);
});

it('S60 A1 (REPRO-2): cancelling a company run aborts in-flight discovery and the provider is never called', async () => {
  const runId = await companyRun(a);
  await until(() => releaseMetadata, (r) => !!r, 'metadata entered', 15_000);
  const settled = await mutate(a, 'POST', `/api/runs/${runId}/cancel`, {});
  expect(settled.json.status ?? settled.json.run?.status).toBe('canceled');
  // Discovery is aborted by the cancel itself, without the provider answering.
  await until(() => metadataAborted, Boolean, 'discovery aborted', 5_000);
  releaseMetadata?.();
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(executes()).toHaveLength(0);
});

it('S60 A1: a still-valid grant whose run was cancelled is refused at the provider boundary even when discovery is not abortable', async () => {
  ignoreAbort = true;
  const runId = await companyRun(a);
  await until(() => releaseMetadata, (r) => !!r, 'metadata entered', 15_000);
  const cancel = mutate(a, 'POST', `/api/runs/${runId}/cancel`, {});
  await new Promise((resolve) => setTimeout(resolve, 300));
  releaseMetadata!();
  const settled = await cancel;
  expect(settled.json.status ?? settled.json.run?.status).toBe('canceled');
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(executes()).toHaveLength(0);
});

it('S60 A2: a run grant lives with the run (beyond the default tool-token TTL, bounded) and dies at its terminal state', async () => {
  holdMetadata = false;
  const mint = vi.spyOn(toolTokenRegistry, 'mint');
  let validLater: boolean | undefined;
  openaiOnFirstCall = () => {
    const minted = mint.mock.results.at(-1)?.value as { token: string; runId: string } | undefined;
    if (minted) validLater = toolTokenRegistry.validate(minted.token, { nowMs: Date.now() + DEFAULT_TOOL_TOKEN_TTL_MS + 60_000 }).ok;
  };
  const runId = await companyRun(a);
  await until(async () => (await daemon.request({ path: `/api/runs/${runId}`, cookie: a.cookie })).json?.status, (s) => s === 'succeeded' || s === 'failed', 'run settled', 20_000);
  const call = mint.mock.calls.find(([options]) => options.runId === runId)?.[0];
  mint.mockRestore();
  expect(call?.ttlMs).toBeGreaterThan(DEFAULT_TOOL_TOKEN_TTL_MS);
  expect(call?.ttlMs).toBeLessThanOrEqual(6 * 60 * 60 * 1000);
  expect(validLater).toBe(true);
  expect(toolTokenRegistry.activeRunTokenCount(runId)).toBe(0);
  expect(executes()).toHaveLength(1);
});

it('S60 A5: the per-run call limit reserves its slot synchronously, so parallel calls cannot overshoot', async () => {
  holdMetadata = false; holdExecute = true;
  const runId = randomUUID();
  const g = toolTokenRegistry.mint({ runId, projectId: 'p', studioConnectors: runtime.capture(routineActor(a), ['github'])! });
  const insert = db.prepare(`INSERT INTO studio_connector_tool_audit (actor_account_id, connector_id, tool_slug, run_id, outcome, created_at) VALUES (?, 'github', 'GITHUB_SEARCH_REPOSITORIES', ?, 'ok', ?)`);
  for (let i = 0; i < 58; i++) insert.run(a.id, runId, Date.now());
  const args = { connectorId: 'github', toolName: 'github.github_search_repositories', input: { query: 'x' } };
  const pending = Array.from({ length: 5 }, () => execute(g.token, args));
  await until(() => releaseExecutes.length, (n) => n >= 2, 'two provider calls entered', 5_000);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const entered = releaseExecutes.length;
  for (const release of releaseExecutes.splice(0)) release();
  const results = await Promise.all(pending);
  expect(entered).toBe(2);
  expect(executes()).toHaveLength(2);
  expect(results.filter((result) => result.status === 200)).toHaveLength(2);
  expect(results.filter((result) => result.status === 429).map((result) => result.json.error.code)).toEqual(Array(3).fill('CONNECTOR_RATE_LIMITED'));
});

it('S60 A3 (REPRO-3): after the owner disconnects a routine app, the routine can still be disabled and its connectors cleared, not re-enabled', async () => {
  holdMetadata = false;
  const made = await mutate(a, 'POST', '/api/routines', { name: 'r', prompt: 'p', schedule: { kind: 'daily', time: '09:00', timezone: 'UTC' },
    target: { mode: 'create_each_run' }, context: { connectorIds: ['hubspot'] } });
  expect(made.status, made.text).toBe(201);
  const id = made.json.routine.id;
  store.markDisconnected(a.id, 'hubspot');
  const disabled = await mutate(a, 'PATCH', `/api/routines/${id}`, { enabled: false });
  expect(disabled.status, disabled.text).toBe(200);
  expect(disabled.json.routine.enabled).toBe(false);
  const enable = await mutate(a, 'PATCH', `/api/routines/${id}`, { enabled: true });
  expect(enable.status).toBe(403);
  expect(enable.json.error.code).toBe('CONNECTOR_NOT_GRANTED');
  const cleared = await mutate(a, 'PATCH', `/api/routines/${id}`, { context: { connectorIds: [] } });
  expect(cleared.status, cleared.text).toBe(200);
  expect(cleared.json.routine.context?.connectorIds ?? []).toEqual([]);
  expect((await mutate(a, 'PATCH', `/api/routines/${id}`, { enabled: true })).status).toBe(200);
});

it('S60 A1: the in-process company tool path refuses a call whose run was cancelled during discovery and tells the model nothing private', async () => {
  ignoreAbort = true;
  const runId = await companyRun(a);
  await until(() => releaseMetadata, (r) => !!r, 'metadata entered', 15_000);
  const cancel = mutate(a, 'POST', `/api/runs/${runId}/cancel`, {});
  await new Promise((resolve) => setTimeout(resolve, 300));
  releaseMetadata!();
  await cancel;
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(executes()).toHaveLength(0);
  expect(modelSawToolOutput.join('\n')).not.toContain('private');
});

// S60 Repair 1 regression guard: the S59 reviewer's run-time connector liveness
// cases (revoked grant, cancelled run — above) keep refusing, and so do the
// other authority losses that can land while discovery is in flight.
it.each([['account disabled'], ['connection replaced'], ['grant revoked']])(
  'S60 Repair 1 regression: %s while discovery is in flight → typed refusal, zero provider executes', async (change) => {
    const bound = runtime.capture(routineActor(a), ['hubspot']);
    const g = toolTokenRegistry.mint({ runId: randomUUID(), projectId: 'p', studioConnectors: bound! });
    const pending = execute(g.token, { connectorId: 'hubspot', toolName: 'hubspot.hubspot_get_contact', input: { id: 'x' } });
    await until(() => releaseMetadata, (r) => !!r, 'metadata entered');
    if (change === 'account disabled') expect((await mutate(admin, 'PATCH', `/api/auth/users/${a.id}`, { revision: await currentAccountRevision(daemon.request, a.id, admin.cookie), active: false })).status).toBe(200);
    if (change === 'connection replaced') store.saveConnection(a.id, 'hubspot', { providerConnectionId: `ca_other_${a.id}`, accountLabel: 'A', credentialRevision: company.read().credentialRevision });
    if (change === 'grant revoked') toolTokenRegistry.revokeToken(g.token);
    releaseMetadata!();
    const result = await pending;
    expect([401, 403, 409], result.text).toContain(result.status);
    expect(result.json.error.code).toMatch(/^(TOOL_TOKEN_INVALID|MULTIUSER_CONNECTOR_AUTHORITY_CHANGED)$/);
    expect(executes()).toHaveLength(0);
  });

// S62 Repair 1 (P2): Composio tool discovery is an outbound request like any other —
// budgeted, audited (empty tool slug, outcome, duration), negatively cached and coalesced.
// Promoted from the S62 reviewer's authority probe (80 provider requests, no audit rows;
// a scratch handoff outside git).
const list = (token: string) => daemon.request({ method: 'GET', path: '/api/tools/connectors/list', headers: { authorization: `Bearer ${token}` } });
const metadataCalls = () => calls.filter((call) => call.url.includes('/api/v3.1/tools?'));
const discoveryAudit = (runId: string) => (db.prepare("SELECT * FROM studio_connector_tool_audit WHERE run_id = ? AND tool_slug = '' ORDER BY id")
  .all(runId) as Array<{ outcome: string; duration_ms?: number }>).map(({ outcome, duration_ms }) => ({ outcome, duration_ms }));
it('S62 R1 connector discovery after the run budget is spent sends nothing and audits every refused attempt', async () => {
  holdMetadata = false;
  const runId = randomUUID();
  const g = toolTokenRegistry.mint({ runId, projectId: 'p', studioConnectors: runtime.capture(routineActor(a), ['hubspot'])! });
  const insert = db.prepare(`INSERT INTO studio_connector_tool_audit (actor_account_id, connector_id, tool_slug, run_id, outcome, created_at) VALUES (?, 'hubspot', 'HUBSPOT_GET_CONTACT', ?, 'ok', ?)`);
  for (let i = 0; i < 60; i++) insert.run(a.id, runId, Date.now());
  const results = await Promise.all(Array.from({ length: 20 }, () => list(g.token)));
  expect(results.map((result) => result.status)).toEqual(Array(20).fill(429));
  expect(results.every((result) => result.json.error.code === 'CONNECTOR_RATE_LIMITED')).toBe(true);
  expect(metadataCalls()).toHaveLength(0);
  const rows = discoveryAudit(runId);
  expect(rows).toHaveLength(20); expect(rows.every((row) => row.outcome === 'CONNECTOR_RATE_LIMITED' && Number.isInteger(row.duration_ms))).toBe(true);
  // An execute that needs discovery is refused the same way, before any provider request.
  const executed = await execute(g.token, { connectorId: 'hubspot', toolName: 'hubspot.hubspot_get_contact', input: { id: 'x' } });
  expect(executed.status, executed.text).toBe(429); expect(metadataCalls()).toHaveLength(0); expect(executes()).toHaveLength(0);
  toolTokenRegistry.revokeToken(g.token);
});
it('S62 R1 concurrent discovery misses share one provider request, a failure is cached briefly, and each attempt is audited once', async () => {
  metadataStatus = 503;
  const runId = randomUUID();
  const g = toolTokenRegistry.mint({ runId, projectId: 'p', studioConnectors: runtime.capture(routineActor(a), ['hubspot'])! });
  const first = Array.from({ length: 10 }, () => list(g.token));
  await until(() => releaseMetadata, (r) => !!r, 'metadata entered');
  await new Promise((resolve) => setTimeout(resolve, 300));
  releaseMetadata!();
  const failedNow = await Promise.all(first);
  expect(failedNow.map((result) => result.status)).toEqual(Array(10).fill(502));
  expect(metadataCalls()).toHaveLength(1);
  // Within the failure TTL nothing is sent again, by lists or executes.
  holdMetadata = false;
  for (let i = 0; i < 5; i++) expect((await list(g.token)).status).toBe(502);
  expect((await execute(g.token, { connectorId: 'hubspot', toolName: 'hubspot.hubspot_get_contact', input: { id: 'x' } })).status).toBe(502);
  expect(metadataCalls()).toHaveLength(1); expect(executes()).toHaveLength(0);
  expect(discoveryAudit(runId)).toEqual([{ outcome: 'MULTIUSER_CONNECTOR_PROVIDER_FAILED', duration_ms: expect.any(Number) }]);
  toolTokenRegistry.revokeToken(g.token);
});
it('S62 R1 a successful discovery is one budgeted, audited request; an execute covers its discovery and call with one slot', async () => {
  holdMetadata = false;
  const runId = randomUUID();
  const g = toolTokenRegistry.mint({ runId, projectId: 'p', studioConnectors: runtime.capture(routineActor(a), ['hubspot'])! });
  const listed = await Promise.all(Array.from({ length: 8 }, () => list(g.token)));
  expect(listed.every((result) => result.status === 200)).toBe(true);
  expect(metadataCalls()).toHaveLength(1); expect(discoveryAudit(runId)).toEqual([{ outcome: 'ok', duration_ms: expect.any(Number) }]);
  // A refresh-style grant with a one-call budget: discovery (fresh account, cold cache) and the call share the slot.
  const b = (await (async () => {
    const username = `s62r1-${randomUUID().slice(0, 8)}`; const password = `${username}-battery-staple-password`;
    const made = await mutate(admin, 'POST', '/api/auth/users', { username, password, role: 'user' });
    return { id: made.json.account.id as string, username, password, cookie: await login(daemon, username, password) };
  })());
  store.saveConnection(b.id, 'hubspot', { providerConnectionId: `ca_hubspot_${b.id}`, accountLabel: 'B', credentialRevision: company.read().credentialRevision });
  const one = toolTokenRegistry.mint({ runId: randomUUID(), projectId: 'p', callLimit: 1, studioConnectors: runtime.capture(routineActor(b), ['hubspot'])! });
  const done = await execute(one.token, { connectorId: 'hubspot', toolName: 'hubspot.hubspot_get_contact', input: { id: 'x' } });
  expect(done.status, done.text).toBe(200); expect(metadataCalls()).toHaveLength(2); expect(executes()).toHaveLength(1);
  expect(db.prepare('SELECT tool_slug, outcome FROM studio_connector_tool_audit WHERE run_id = ?').all(one.runId)).toEqual([{ tool_slug: 'HUBSPOT_GET_CONTACT', outcome: 'ok' }]);
  toolTokenRegistry.revokeToken(g.token); toolTokenRegistry.revokeToken(one.token);
});
