// #62: automatic memory for Studio accounts. Extraction runs after a turn on
// that turn's own OpenAI source (company pool or the account's own key) and
// writes only the turn owner's memory; personal Codex turns are skipped
// explicitly. Verification checks the owner's own rules. History, deletes and
// the event stream are per account; prompts inject only the actor's memory.
import { existsSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { cleanupIsolatedDataRoot, loadIsolatedServerModule, multiUserOptions, provisionAccounts,
  startMultiUserDaemon, type Principal, type StartedMultiUserDaemon } from './multiuser-harness.js';
import { PERSONAL_CODEX_MOCK, linkCodex, until } from './personal-codex-helpers.js';

const companyKey = 'sk-company-memory-fixture-key-0123456789';
const ownKey = 'sk-account-a-memory-own-key-9876543210';
type Call = { authorization: string; model: unknown; extraction: boolean; developer: string };
const calls: Call[] = [];
const sse = (events: unknown[]) => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
const openai: typeof fetch = async (_url, init) => {
  const body = JSON.parse(String(init?.body)) as { model: unknown; input: Array<Record<string, unknown>> };
  const developer = String(body.input.find((item) => item.role === 'developer')?.content ?? '');
  const extraction = developer.startsWith('You are a memory extractor');
  calls.push({ authorization: new Headers(init?.headers).get('authorization') ?? '', model: body.model, extraction, developer });
  if (extraction) {
    const json = JSON.stringify({ entries: [{ type: 'feedback', name: 'Prefers dense dashboards', description: 'Layout preference',
      body: 'MEMORY_EXTRACTED_MARKER likes dense dashboards with small type.' }] });
    return sse([{ type: 'response.output_text.delta', delta: json },
      { type: 'response.completed', response: { output: [], usage: { input_tokens: 40, output_tokens: 20 } } }]);
  }
  const wrote = body.input.some((item) => item.type === 'function_call_output');
  const output = wrote ? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Dashboard saved.' }] }]
    : [{ type: 'function_call', call_id: 'w1', name: 'write_project_file', arguments: JSON.stringify({ path: 'dash.html', content: '<!doctype html><h1>Dash</h1>' }) }];
  return sse([...(wrote ? [{ type: 'response.output_text.delta', delta: 'Dashboard saved.' }] : []), { type: 'response.completed', response: { output } }]);
};

let daemon: StartedMultiUserDaemon; let root: string; let a: Principal; let b: Principal; let admin: Principal;
beforeAll(async () => {
  ({ dataRoot: root } = await loadIsolatedServerModule());
  daemon = await startMultiUserDaemon(multiUserOptions({ testCompanyOpenAIFetch: openai, testPersonalCodexAppServer: PERSONAL_CODEX_MOCK }));
  const accounts = await provisionAccounts(daemon, ['memory-a', 'memory-b']);
  [a, b] = accounts.users as [Principal, Principal]; admin = accounts.admin;
  for (const user of [a, b]) {
    expect((await daemon.request({ method: 'PUT', path: `/api/admin/users/${user.id}/studio-pilot`, cookie: admin.cookie,
      body: { studioPilot: true, revision: 0 } })).status).toBe(200);
  }
  const current = await daemon.request({ path: '/api/admin/pool/openai', cookie: admin.cookie });
  expect((await daemon.request({ method: 'PUT', path: '/api/admin/pool/openai', cookie: admin.cookie, body: {
    revision: current.json.provider.revision, model: 'company-model', enabled: true, capacity: 2, apiKey: companyKey } })).status).toBe(200);
  await linkCodex(daemon, root, a, 'memory-a@example.test');
}, 120_000);
afterAll(async () => { await daemon?.close(); cleanupIsolatedDataRoot(); });

const get = (user: Principal, route: string) => daemon.request({ path: route, cookie: user.cookie });
const send = (user: Principal, method: string, route: string, body: unknown = {}) => daemon.request({ method, path: route, cookie: user.cookie, body });
async function turn(user: Principal, source: 'company_pool' | 'personal_api_key' | 'personal_subscription', message: string) {
  const projectId = randomUUID();
  const made = await send(user, 'POST', '/api/projects', { id: projectId, name: `Memory ${source}` });
  const agentId = source === 'company_pool' ? 'openai' : source === 'personal_api_key' ? 'openai-byok' : 'codex';
  const started = await send(user, 'POST', '/api/runs', { projectId, conversationId: made.json.conversationId, agentId, executionSource: source, message });
  expect(started.status, started.text).toBe(202);
  await until(() => get(user, `/api/runs/${started.json.runId}`), (r) => ['succeeded', 'failed', 'canceled'].includes(r.json.status), 'memory turn', 15_000);
  return started.json.runId as string;
}
const extractions = async (user: Principal) => (await get(user, '/api/memory/extractions')).json.extractions as Array<Record<string, any>>;

it('keeps extraction opt-in, closes the host provider override and refuses chat-provider fields', async () => {
  const before = await get(a, '/api/memory');
  expect(before.json).toMatchObject({ chatExtractionEnabled: false, verifyEnabled: true, rewriteEnabled: true, extraction: null });
  expect((await send(a, 'PATCH', '/api/memory/config', { extraction: { provider: 'openai', apiKey: 'sk-host-override-0000' } })).status).toBe(400);
  const on = await send(a, 'PATCH', '/api/memory/config', { chatExtractionEnabled: true });
  expect(on.json).toMatchObject({ chatExtractionEnabled: true, extraction: null });
  expect((await get(b, '/api/memory')).json.chatExtractionEnabled).toBe(false);
  expect((await send(a, 'POST', '/api/memory/extract', { userMessage: 'x', chatProvider: { provider: 'openai', apiKey: 'k' } })).status).toBe(400);
  expect((await send(a, 'POST', '/api/memory/rules/suggest', { annotations: [{ note: 'x' }], chatModel: 'gpt' })).status).toBe(400);
});

it('extracts after a company turn on the company key into the owner memory only, and injects it for the owner only', async () => {
  calls.length = 0;
  const runId = await turn(a, 'company_pool', 'Build me a dashboard; I like it dense.');
  const record = (await until(() => extractions(a), (list) => list.some((item) => item.runId === runId && item.phase === 'success'), 'company extraction'))
    .find((item) => item.runId === runId && item.phase === 'success')!;
  expect(record).toMatchObject({ kind: 'llm', provider: { kind: 'openai', model: 'company-model', credentialSource: 'company-pool' },
    writtenCount: 1, usage: { inputTokens: 40, outputTokens: 20 } });
  const extractionCall = calls.find((call) => call.extraction)!;
  expect(extractionCall).toMatchObject({ authorization: `Bearer ${companyKey}`, model: 'company-model' });
  const memoryId = record.writtenIds[0] as string;
  expect((await get(a, `/api/memory/${memoryId}`)).json.entry.body).toContain('MEMORY_EXTRACTED_MARKER');
  expect((await get(b, `/api/memory/${memoryId}`)).status).toBe(404);
  for (const other of [b, admin]) expect(await extractions(other)).toEqual([]);
  // The host-global memory store and history never see account text.
  const hostMemory = path.join(root, 'memory');
  expect(existsSync(hostMemory) ? readdirSync(hostMemory).filter((file) => file.includes('dense')) : []).toEqual([]);

  // The next turn of A carries A's extracted memory; B's never does.
  calls.length = 0;
  const second = await turn(a, 'company_pool', 'Another screen please.');
  expect(calls.find((call) => !call.extraction)!.developer).toContain('MEMORY_EXTRACTED_MARKER');
  // A's background extraction for that turn settles before B's turn is observed.
  await until(() => extractions(a), (list) => list.some((item) => item.runId === second && item.phase !== 'running'), 'second extraction');
  calls.length = 0;
  await turn(b, 'company_pool', 'B screen.');
  expect(calls.every((call) => !call.developer.includes('MEMORY_EXTRACTED_MARKER'))).toBe(true);
  expect(calls.some((call) => call.extraction)).toBe(false);
}, 60_000);

it('extracts own-key turns on the account key and skips personal Codex turns explicitly', async () => {
  const keyRead = await get(a, '/api/multiuser/settings/provider-keys');
  expect((await send(a, 'PUT', '/api/multiuser/settings/provider-keys/openai', { revision: keyRead.json.keys[0].revision, apiKey: ownKey, model: 'own-model' })).status).toBe(200);
  calls.length = 0;
  const own = await turn(a, 'personal_api_key', 'Own key dashboard.');
  await until(() => extractions(a), (list) => list.some((item) => item.runId === own && item.phase !== 'running'), 'own-key extraction');
  expect(calls.filter((call) => call.extraction).map((call) => [call.authorization, call.model])).toEqual([[`Bearer ${ownKey}`, 'own-model']]);
  expect((await extractions(a)).find((item) => item.runId === own)).toMatchObject({ provider: { credentialSource: 'account-key', model: 'own-model' } });

  calls.length = 0;
  const codex = await turn(a, 'personal_subscription', 'Codex turn, remember: always add a skip link');
  const skipped = (await until(() => extractions(a), (list) => list.some((item) => item.runId === codex), 'codex skip')).find((item) => item.runId === codex);
  expect(skipped).toMatchObject({ kind: 'llm', phase: 'skipped', reason: 'source-has-no-extraction' });
  expect(calls).toEqual([]);
  // The opt-in regex pack ran before the turn on the user's own text, with no provider.
  const heuristic = (await extractions(a)).find((item) => item.kind === 'heuristic' && item.phase === 'success');
  expect(heuristic?.writtenIds?.length).toBe(1);
  expect((await get(a, `/api/memory/${heuristic!.writtenIds[0]}`)).json.entry.body).toContain('always add a skip link');
}, 60_000);

it('verifies turns against the owner rules and keeps history and deletes per account', async () => {
  expect((await send(a, 'POST', '/api/memory', { type: 'rule', name: 'Skip link rule', description: 'a11y',
    body: 'Assertion: Every page has a skip link\nCheck: The first focusable element is a skip link' })).status).toBe(200);
  const runId = await turn(a, 'company_pool', 'Make a landing page.');
  const verifications = (await until(() => get(a, '/api/memory/verifications'), (r) => r.json.verifications.some((item: { runId: string }) => item.runId === runId),
    'verification')).json.verifications as Array<Record<string, any>>;
  expect(verifications.find((item) => item.runId === runId)).toMatchObject({ status: 'missing', rulesActive: 1, hadArtifact: true, uncoveredRules: ['Skip link rule'] });
  await until(() => extractions(a), (list) => list.some((item) => item.runId === runId && item.phase !== 'running'), 'landing extraction');
  for (const other of [b, admin]) expect((await get(other, '/api/memory/verifications')).json.verifications).toEqual([]);
  const id = verifications[0]!.id as string;
  expect((await send(b, 'DELETE', `/api/memory/verifications/${id}`)).json).toEqual({ removed: 0 });
  expect((await send(admin, 'DELETE', '/api/memory/verifications')).json).toEqual({ removed: 0 });
  expect((await get(a, '/api/memory/verifications')).json.verifications.length).toBeGreaterThan(0);
  expect((await send(a, 'DELETE', `/api/memory/verifications/${id}`)).json).toEqual({ removed: 1 });
  const extractionId = (await extractions(a))[0]!.id as string;
  expect((await send(b, 'DELETE', `/api/memory/extractions/${extractionId}`)).json).toEqual({ removed: 0 });
  expect((await send(a, 'DELETE', '/api/memory/extractions')).json.removed).toBeGreaterThan(0);
  expect(await extractions(a)).toEqual([]);

  // Rule proposals are the deterministic distiller only: no provider call.
  calls.length = 0;
  const proposals = await send(a, 'POST', '/api/memory/rules/suggest', { annotations: [{ note: 'Always keep the CTA above the fold', targetLabel: 'Hero' }] });
  expect(proposals.json).toMatchObject({ attemptedLLM: false, source: 'heuristic' });
  expect(proposals.json.proposals[0].assertion).toContain('CTA above the fold');
  const extracted = await send(a, 'POST', '/api/memory/extract', { userMessage: 'remember: invoices go to finance@example.test', assistantMessage: 'ok' });
  expect(extracted.json).toMatchObject({ attemptedLLM: false });
  expect(extracted.json.changed).toHaveLength(1);
  expect((await send(b, 'POST', '/api/memory/extract', { userMessage: 'remember: b note here' })).json.changed).toEqual([]);
  expect(calls).toEqual([]);
}, 60_000);
