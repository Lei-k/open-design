import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { cleanupIsolatedDataRoot, loadIsolatedServerModule, multiUserOptions, provisionAccounts,
  startMultiUserDaemon, type Principal, type StartedMultiUserDaemon } from './multiuser-harness.js';
import { until } from './personal-codex-helpers.js';

// Account-private provider keys (#62/#63): write-only, sealed per account,
// billed to the account's own provider account and never a company fallback.
let daemon: StartedMultiUserDaemon;
let root: string; let a: Principal; let b: Principal; let admin: Principal;
const keyA = 'sk-account-a-private-key-0123456789abcdef';
const keyB = 'sk-account-b-private-key-fedcba9876543210';
let mode: 'write' | 'delay' | 'reject' | 'limit' = 'write';
const observed: Array<{ authorization: string; model: unknown }> = [];
const fixtureFetch: typeof fetch = async (_url, init) => {
  const body = JSON.parse(String(init?.body)) as { model: unknown; input: Array<Record<string, unknown>> };
  observed.push({ authorization: new Headers(init?.headers).get('authorization') ?? '', model: body.model });
  if (mode === 'delay') await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, 5000);
    init?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('fixture aborted')); }, { once: true });
  });
  if (mode === 'reject') return new Response(`${keyA} invalid api key detail`, { status: 401 });
  if (mode === 'limit') return new Response('rate limited', { status: 429 });
  const wrote = body.input.some((item) => item.type === 'function_call_output');
  const output = wrote ? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Own key design complete.' }] }]
    : [{ type: 'function_call', call_id: 'w1', name: 'write_project_file', arguments: JSON.stringify({ path: 'own.html', content: '<!doctype html><h1>Own key</h1>' }) }];
  const events = [...(wrote ? [{ type: 'response.output_text.delta', delta: 'Own key design complete.' }] : []),
    { type: 'response.completed', response: { output, usage: { input_tokens: 5, output_tokens: 3 } } }];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
};

beforeAll(async () => {
  ({ dataRoot: root } = await loadIsolatedServerModule());
  daemon = await startMultiUserDaemon(multiUserOptions({ testCompanyOpenAIFetch: fixtureFetch }));
  const accounts = await provisionAccounts(daemon, ['keys-a', 'keys-b']);
  [a, b] = accounts.users as [Principal, Principal]; admin = accounts.admin;
  for (const user of [a, b]) {
    expect((await daemon.request({ method: 'PUT', path: `/api/admin/users/${user.id}/studio-pilot`, cookie: admin.cookie,
      body: { studioPilot: true, revision: 0 } })).status).toBe(200);
  }
}, 120_000);
afterAll(async () => { await daemon?.close(); cleanupIsolatedDataRoot(); });

const keys = (user: Principal) => daemon.request({ path: '/api/multiuser/settings/provider-keys', cookie: user.cookie });
const save = (user: Principal, body: Record<string, unknown>) =>
  daemon.request({ method: 'PUT', path: '/api/multiuser/settings/provider-keys/openai', cookie: user.cookie, body });
async function target(user = a) {
  const projectId = randomUUID();
  const made = await daemon.request({ method: 'POST', path: '/api/projects', cookie: user.cookie, body: { id: projectId, name: 'Own key project' } });
  expect(made.status).toBe(200); return { projectId, conversationId: made.json.conversationId as string };
}
const run = (project: { projectId: string; conversationId: string }, user = a, extra: Record<string, unknown> = {}) =>
  daemon.request({ method: 'POST', path: '/api/runs', cookie: user.cookie,
    body: { ...project, agentId: 'openai-byok', executionSource: 'personal_api_key', message: 'Design with my key', ...extra } });

it('stores each account key write-only, encrypted per account, and never shows it to anyone', async () => {
  const me = await daemon.request({ path: '/api/auth/me', cookie: a.cookie });
  expect(me.json.studio.executionSources).toContainEqual({ source: 'personal_api_key', agentId: 'openai-byok' });
  expect(me.json.studio.features.execution.status).toBe('pilot');
  expect((await keys(a)).json.keys).toEqual([expect.objectContaining({ provider: 'openai', configured: false, last4: null, revision: 0 }),
    expect.objectContaining({ provider: 'tavily', configured: false, last4: null, revision: 0 })]);
  expect((await save(a, { revision: 0, apiKey: 'short' })).status).toBe(400);
  expect((await save(a, { revision: 0, apiKey: keyA, baseUrl: 'http://evil.invalid' })).status).toBe(400);
  expect((await save(a, { revision: 0, apiKey: keyA, model: 'bad model name' })).status).toBe(400);
  const saved = await save(a, { revision: 0, apiKey: keyA, model: 'gpt-own-a' });
  expect(saved.status, saved.text).toBe(200);
  expect(saved.json.key).toMatchObject({ configured: true, last4: 'cdef', model: 'gpt-own-a', revision: 1, credentialRevision: 1 });
  expect(saved.text).not.toContain(keyA);
  expect(saved.headers['cache-control']).toBe('no-store');
  expect((await save(a, { revision: 0, model: 'other' })).status).toBe(409);
  expect((await save(b, { revision: 0, apiKey: keyB })).status).toBe(200);
  // Each account sees only its own summary; admins get no route to any key.
  expect((await keys(b)).json.keys[0]).toMatchObject({ last4: '3210' });
  expect((await keys(a)).text).not.toContain(keyB);
  for (const path of ['/api/admin/pool', '/api/admin/pool/openai', '/api/admin/users']) {
    const read = await daemon.request({ path, cookie: admin.cookie });
    expect(read.text).not.toContain(keyA); expect(read.text).not.toContain('cdef"');
  }
  const db = new Database(path.join(root, 'app.sqlite'));
  try {
    const rows = db.prepare('SELECT account_id, credential FROM multiuser_personal_provider_keys').all() as Array<{ account_id: string; credential: string }>;
    expect(rows).toHaveLength(2);
    for (const row of rows) for (const secret of [keyA, keyB]) {
      expect(row.credential).not.toContain(secret);
      expect(Buffer.from(row.credential, 'base64').includes(Buffer.from(secret))).toBe(false);
    }
    expect(JSON.stringify(db.prepare('SELECT * FROM multiuser_personal_provider_audit').all())).not.toContain(keyA);
    // A sealed row copied onto another account does not open there.
    const own = rows.find((row) => row.account_id === a.id)!;
    db.prepare('UPDATE multiuser_personal_provider_keys SET credential = ? WHERE account_id = ?').run(own.credential, b.id);
  } finally { db.close(); }
  expect(statSync(path.join(root, 'personal-providers/master.key')).mode & 0o777).toBe(0o600);
  const stolen = await run(await target(b), b);
  expect(stolen.status, stolen.text).toBe(202);
  const events = await daemon.request({ path: `/api/runs/${stolen.json.runId}/events`, cookie: b.cookie });
  expect(events.text).toContain('MULTIUSER_PROVIDER_KEY_MISSING');
  expect(observed.some((call) => call.authorization.includes(keyA))).toBe(false);
  expect((await save(b, { revision: 1, apiKey: keyB })).status).toBe(200);
});

it('runs on the account key and model, owner-only, with no company pool or fallback', async () => {
  observed.length = 0;
  const project = await target();
  const started = await run(project);
  expect(started.status, started.text).toBe(202);
  const events = await daemon.request({ path: `/api/runs/${started.json.runId}/events`, cookie: a.cookie });
  expect(events.text).toContain('"status":"succeeded"');
  expect(events.text).not.toContain(keyA);
  const info = await daemon.request({ path: `/api/runs/${started.json.runId}`, cookie: a.cookie });
  expect(info.json).toMatchObject({ agentId: 'openai-byok', executionSource: 'personal_api_key', status: 'succeeded' });
  expect(observed.every((call) => call.authorization === `Bearer ${keyA}` && call.model === 'gpt-own-a')).toBe(true);
  expect((await daemon.request({ path: `/api/projects/${project.projectId}/files/own.html`, cookie: a.cookie })).text).toContain('Own key');
  const transcript = await daemon.request({ path: `/api/projects/${project.projectId}/conversations/${project.conversationId}/messages`, cookie: a.cookie });
  expect(transcript.json.messages.find((message: { role: string }) => message.role === 'assistant')).toMatchObject({ agentId: 'openai-byok' });
  expect((await daemon.request({ path: `/api/runs/${started.json.runId}`, cookie: b.cookie })).status).toBe(404);
  // The conversation is pinned: the company pool is a mismatch, never a fallback.
  const company = await daemon.request({ method: 'POST', path: '/api/runs', cookie: a.cookie,
    body: { ...project, agentId: 'openai', executionSource: 'company_pool', message: 'switch' } });
  expect(company.status).not.toBe(202);
  expect((await run(project, a, { agentId: 'openai' })).status).toBe(400);
  // Company worker quota is not charged for turns on an account's own key.
  const ledger = new Database(path.join(root, 'worker-quota/worker-quota.sqlite'));
  try { expect(ledger.prepare('SELECT 1 FROM quota_runs WHERE run_id = ?').get(started.json.runId)).toBeUndefined(); }
  finally { ledger.close(); }
});

it('refuses without a key, classifies provider rejections without echoing them, and stops turns when the key is removed', async () => {
  const none = await daemon.request({ path: '/api/multiuser/settings/provider-keys', cookie: admin.cookie });
  expect(none.json.keys[0]).toMatchObject({ configured: false });
  mode = 'reject';
  const rejected = await run(await target());
  const rejectedEvents = await daemon.request({ path: `/api/runs/${rejected.json.runId}/events`, cookie: a.cookie });
  expect(rejectedEvents.text).toContain('MULTIUSER_PROVIDER_KEY_REJECTED');
  expect(rejectedEvents.text).not.toContain('invalid api key detail'); expect(rejectedEvents.text).not.toContain(keyA);
  mode = 'limit';
  const limited = await run(await target());
  expect((await daemon.request({ path: `/api/runs/${limited.json.runId}/events`, cookie: a.cookie })).text).toContain('MULTIUSER_PROVIDER_RATE_LIMITED');
  mode = 'delay';
  const slow = await run(await target());
  await until(() => daemon.request({ path: `/api/runs/${slow.json.runId}`, cookie: a.cookie }), (r) => r.json.status === 'running');
  const current = (await keys(a)).json.keys[0];
  const removed = await save(a, { revision: current.revision, apiKey: null });
  expect(removed.json.key).toMatchObject({ configured: false, last4: null });
  await until(() => daemon.request({ path: `/api/runs/${slow.json.runId}`, cookie: a.cookie }), (r) => r.json.status === 'canceled');
  mode = 'write';
  const refused = await run(await target());
  expect(refused.status).toBe(403);
  expect(refused.json.error.code).toBe('MULTIUSER_PROVIDER_KEY_MISSING');
});
