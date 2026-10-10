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
  calls = []; holdMetadata = true; releaseMetadata = undefined; metadataAborted = false; ignoreAbort = false; holdExecute = false; releaseExecutes.length = 0;
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
