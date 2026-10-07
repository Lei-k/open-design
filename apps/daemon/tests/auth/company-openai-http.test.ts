import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { cleanupIsolatedDataRoot, loadIsolatedServerModule, multiUserOptions, provisionAccounts,
  startMultiUserDaemon, type Principal, type StartedMultiUserDaemon } from './multiuser-harness.js';
import { until } from './personal-codex-helpers.js';

let daemon: StartedMultiUserDaemon;
let root: string; let a: Principal; let b: Principal; let admin: Principal;
const secret = 'sk-company-fixture-private-12345678901234567890';
let turnMode: 'write' | 'delay' | 'error' | 'question' = 'write';
const observed: Array<{ url: string; authorization: string; body: Record<string, unknown> }> = [];
const fixtureFetch: typeof fetch = async (url, init) => {
  const body = JSON.parse(String(init?.body));
  observed.push({ url: String(url), authorization: new Headers(init?.headers).get('authorization') ?? '', body });
  if (turnMode === 'delay') await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, 5000);
    init?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('fixture aborted')); }, { once: true });
  });
  if (turnMode === 'error') return new Response(secret + ' upstream private error', { status: 401 });
  const input = body.input as Array<Record<string, unknown>>;
  const wrote = input.some((item) => item.type === 'function_call_output');
  const question = '<question-form id="company-brief">{"questions":[{"id":"color","label":"Color","type":"text"}]}</question-form>';
  const reply = turnMode === 'question' ? question : 'Company design complete.\n';
  const output = turnMode === 'question' ? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: question }] }] : wrote ? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Company design complete.' }] }]
    : [{ type: 'function_call', call_id: 'write-1', name: 'write_project_file', arguments: JSON.stringify({ path: 'company.html', content: '<!doctype html><html><body><h1>Owner company design</h1></body></html>' }) }];
  const events = [ ...(wrote || turnMode === 'question' ? [{ type: 'response.output_text.delta', delta: reply }] : []),
    { type: 'response.completed', response: { output, usage: { input_tokens: 12, output_tokens: 7 } } } ];
  return new Response(events.map((event) => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } });
};
beforeAll(async () => {
  ({ dataRoot: root } = await loadIsolatedServerModule());
  daemon = await startMultiUserDaemon(multiUserOptions({ testCompanyOpenAIFetch: fixtureFetch }));
  const accounts = await provisionAccounts(daemon, ['company-a', 'company-b']);
  [a, b] = accounts.users as [Principal, Principal]; admin = accounts.admin;
}, 120_000);
afterAll(async () => { await daemon?.close(); cleanupIsolatedDataRoot(); });
async function config(extra: Record<string, unknown> = {}) {
  const current = await daemon.request({ path: '/api/admin/pool/openai', cookie: admin.cookie });
  return daemon.request({ method: 'PUT', path: '/api/admin/pool/openai', cookie: admin.cookie, body: {
    revision: current.json.provider.revision, model: 'fixture-model', enabled: true, capacity: 1, ...extra,
  } });
}
async function target(user = a) {
  const projectId = randomUUID();
  const made = await daemon.request({ method: 'POST', path: '/api/projects', cookie: user.cookie, body: { id: projectId, name: 'Company project' } });
  expect(made.status).toBe(200); return { projectId, conversationId: made.json.conversationId as string };
}
async function run(project: Awaited<ReturnType<typeof target>>, user = a, extra: Record<string, unknown> = {}) {
  return daemon.request({ method: 'POST', path: '/api/runs', cookie: user.cookie, body: {
    ...project, agentId: 'openai', executionSource: 'company_pool', message: 'Create an owner design', ...extra,
  } });
}

it('keeps company configuration admin-only, revision checked and credential reads redacted and encrypted', async () => {
  for (const user of [a, b]) {
    expect((await daemon.request({ path: '/api/admin/pool/openai', cookie: user.cookie })).status).toBe(403);
    expect((await daemon.request({ method: 'PUT', path: '/api/admin/pool/openai', cookie: user.cookie, body: {} })).status).toBe(403);
  }
  const set = await config({ apiKey: secret }); expect(set.status, set.text).toBe(200);
  expect(set.json.provider).toMatchObject({ configured: true, enabled: true, revision: 1, credentialRevision: 1 });
  expect(set.text).not.toContain(secret);
  expect((await daemon.request({ method: 'PUT', path: `/api/admin/users/${a.id}/studio-pilot`, cookie: admin.cookie,
    body: { studioPilot: true, revision: 0 } })).status).toBe(200);
  const capabilities = await daemon.request({ path: '/api/auth/me', cookie: a.cookie });
  expect(capabilities.json.studio.executionSources).toEqual([{ source: 'company_pool', agentId: 'openai' }]);
  expect(capabilities.json.studio.features.execution.status).toBe('pilot');
  expect((await daemon.request({ method: 'PUT', path: '/api/admin/pool/openai', cookie: admin.cookie, body: {
    enabled: true, model: 'fixture-model', capacity: 1, revision: 0,
  } })).status).toBe(409);
  expect((await config({ apiKey: secret, baseUrl: 'http://private.invalid' })).status).toBe(400);
  const db = new Database(path.join(root, 'app.sqlite'));
  try {
    const row = db.prepare('SELECT credential FROM company_openai_config').get() as { credential: string };
    expect(row.credential).not.toContain(secret);
    expect(Buffer.from(row.credential, 'base64').includes(Buffer.from(secret))).toBe(false);
    expect(JSON.stringify(db.prepare('SELECT * FROM company_openai_audit').all())).not.toContain(secret);
  } finally { db.close(); }
  expect(statSync(path.join(root, 'company-providers/encryption.key')).mode & 0o777).toBe(0o600);
});

it('streams standard events, writes only its project, persists owner history and uses server key against the official API', async () => {
  const project = await target();
  const first = await run(project); expect(first.status, first.text).toBe(202);
  const events = await daemon.request({ path: `/api/runs/${first.json.runId}/events`, cookie: a.cookie });
  expect(events.text).toContain('"status":"succeeded"');
  expect(events.text).toContain('Company design complete.');
  expect(events.text).not.toContain(secret);
  const info = await daemon.request({ path: `/api/runs/${first.json.runId}`, cookie: a.cookie });
  expect(info.json).toMatchObject({ agentId: 'openai', executionSource: 'company_pool', status: 'succeeded', output: { usage: { inputTokens: 24, outputTokens: 14 } } });
  const file = await daemon.request({ path: `/api/projects/${project.projectId}/files/company.html`, cookie: a.cookie });
  expect(file.text).toContain('Owner company design');
  const transcript = await daemon.request({ path: `/api/projects/${project.projectId}/conversations/${project.conversationId}/messages`, cookie: a.cookie });
  expect(transcript.json.messages.find((message: { role: string }) => message.role === 'assistant')).toMatchObject({ agentId: 'openai', content: 'Company design complete.\n' });
  expect((await daemon.request({ path: `/api/runs/${first.json.runId}`, cookie: b.cookie })).status).toBe(404);
  expect((await daemon.request({ path: `/api/projects/${project.projectId}/files/company.html`, cookie: b.cookie })).status).toBe(404);
  const follow = await run(project); expect(follow.status).toBe(202);
  expect((await daemon.request({ path: `/api/runs/${follow.json.runId}/events`, cookie: a.cookie })).text).toContain('"status":"succeeded"');
  expect(observed.every((call) => call.url === 'https://api.openai.com/v1/responses' && call.authorization === `Bearer ${secret}`)).toBe(true);
  expect(observed.at(-1)?.body.store).toBe(false);
  expect(JSON.stringify(observed.at(-1)?.body.input)).toContain('Owner company design');
  expect((await run(project, a, { executionSource: 'personal_subscription', agentId: 'codex' })).status).not.toBe(202);
});

it('cancels active HTTP inference, charges one worker span, and never echoes a provider error body', async () => {
  turnMode = 'delay'; const project = await target(); const started = await run(project); expect(started.status).toBe(202);
  await until(() => daemon.request({ path: `/api/runs/${started.json.runId}`, cookie: a.cookie }), (r) => r.json.status === 'running');
  const canceled = await daemon.request({ method: 'POST', path: `/api/runs/${started.json.runId}/cancel`, cookie: a.cookie, body: {} });
  expect(canceled.json.status).toBe('canceled');
  const ledger = new Database(path.join(root, 'worker-quota/worker-quota.sqlite'));
  try { expect(ledger.prepare('SELECT status FROM quota_runs WHERE run_id = ?').get(started.json.runId)).toEqual({ status: 'cancelled' }); }
  finally { ledger.close(); }
  turnMode = 'error'; const failed = await run(await target());
  const events = await daemon.request({ path: `/api/runs/${failed.json.runId}/events`, cookie: a.cookie });
  expect(events.text).toContain('MULTIUSER_RUN_FAILED'); expect(events.text).not.toContain(secret); expect(events.text).not.toContain('upstream private error');
  turnMode = 'write';
});

it('captures private skills before queueing and answers company questions once using the captured prompt', async () => {
  expect((await config({ capacity: 0 })).status).toBe(200);
  expect((await daemon.request({ path: '/api/auth/me', cookie: a.cookie })).json.studio.executionSources).toEqual([{ source: 'company_pool', agentId: 'openai' }]);
  const skill = await daemon.request({ method: 'POST', path: '/api/skills/import', cookie: a.cookie,
    body: { name: 'Company private skill', body: 'COMPANY_PRIVATE_SKILL_MARKER' } });
  expect(skill.status, skill.text).toBe(201);
  const project = await target();
  const queued = await run(project, a, { skillIds: [skill.json.skill.id], clientRequestId: 'company-capture-1' });
  expect(queued.status, queued.text).toBe(202);
  const replay = await run(project, a, { skillIds: [skill.json.skill.id], clientRequestId: 'company-capture-1' });
  expect(replay.json.runId).toBe(queued.json.runId);
  expect((await daemon.request({ method: 'DELETE', path: `/api/skills/${skill.json.skill.id}`, cookie: a.cookie })).status).toBe(200);
  turnMode = 'question';
  expect((await config({ capacity: 1 })).status).toBe(200);
  const event = await daemon.request({ path: `/api/runs/${queued.json.runId}/events`, cookie: a.cookie });
  expect(event.text).toContain('question-form');
  expect(JSON.stringify(observed.at(-1)?.body.input)).toContain('COMPANY_PRIVATE_SKILL_MARKER');
  turnMode = 'write';
  const answered = await run(project, a, { message: 'blue', analyticsHints: { entryFrom: 'question_answer', sourceRunId: queued.json.runId } });
  expect(answered.status, answered.text).toBe(202);
  await daemon.request({ path: `/api/runs/${answered.json.runId}/events`, cookie: a.cookie });
  expect(JSON.stringify(observed.at(-1)?.body.input)).toContain('COMPANY_PRIVATE_SKILL_MARKER');
  expect((await run(project, a, { analyticsHints: { entryFrom: 'question_answer', sourceRunId: queued.json.runId } })).status).toBe(409);
  const foreignProject = await target(b);
  expect((await run(foreignProject, b, { analyticsHints: { entryFrom: 'question_answer', sourceRunId: queued.json.runId } })).status).toBe(404);
});

it('interrupts an active company request when its worker quota is revoked', async () => {
  turnMode = 'delay';
  const started = await run(await target());
  expect(started.status).toBe(202);
  await until(() => daemon.request({ path: `/api/runs/${started.json.runId}`, cookie: a.cookie }), (r) => r.json.status === 'running');
  expect((await daemon.request({ method: 'PUT', path: `/api/admin/pool/users/${a.id}/quota`, cookie: admin.cookie,
    body: { budgetMinutes: 0 } })).status).toBe(200);
  const ended = await daemon.request({ path: `/api/runs/${started.json.runId}/events`, cookie: a.cookie });
  expect(ended.text).toContain('MULTIUSER_QUOTA_EXHAUSTED');
  expect(ended.text).toContain('"status":"failed"');
  expect((await run(await target())).status).toBe(429);
  expect((await daemon.request({ method: 'PUT', path: `/api/admin/pool/users/${a.id}/quota`, cookie: admin.cookie,
    body: { budgetMinutes: 120 } })).status).toBe(200);
  turnMode = 'write';
});

it('revokes credentials, refuses old model/key bindings, and accepts no client-supplied credentials', async () => {
  const project = await target();
  const started = await run(project);
  await daemon.request({ path: `/api/runs/${started.json.runId}/events`, cookie: a.cookie });
  expect((await config({ apiKey: secret + 'rotated' })).status).toBe(200);
  expect((await run(project)).json.error.code).toBe('MULTIUSER_EXECUTION_SOURCE_MISMATCH');
  expect((await run(await target(), a, { provider: { apiKey: secret } })).status).toBe(403);
  expect((await config({ apiKey: null, enabled: false })).status).toBe(200);
  expect((await run(await target())).json.error.code).toBe('MULTIUSER_PROVIDER_DISABLED');
  expect(readFileSync(path.join(root, 'app.sqlite')).includes(Buffer.from(secret))).toBe(false);
});

it('uses the actor instructions and manual memory in the OpenAI developer prompt', async () => {
  expect((await config({ apiKey: secret, enabled: true })).status).toBe(200);
  const prefs = await daemon.request({ path: '/api/app-config', cookie: a.cookie });
  expect((await daemon.request({ method: 'PUT', path: '/api/app-config', cookie: a.cookie,
    body: { revision: prefs.json.revision, customInstructions: 'OPENAI_ACTOR_INSTRUCTIONS' } })).status).toBe(200);
  expect((await daemon.request({ method: 'POST', path: '/api/memory', cookie: a.cookie,
    body: { name: 'Company memory', description: '', type: 'user', body: 'OPENAI_ACTOR_MEMORY' } })).status).toBe(200);
  expect((await daemon.request({ method: 'POST', path: '/api/memory', cookie: b.cookie,
    body: { name: 'Other memory', description: '', type: 'user', body: 'OPENAI_FOREIGN_MEMORY' } })).status).toBe(200);
  const admitted = await run(await target()); expect(admitted.status, admitted.text).toBe(202);
  await daemon.request({ path: `/api/runs/${admitted.json.runId}/events`, cookie: a.cookie });
  const input = JSON.stringify(observed.at(-1)?.body.input);
  expect(input).toContain('OPENAI_ACTOR_INSTRUCTIONS'); expect(input).toContain('OPENAI_ACTOR_MEMORY');
  expect(input).not.toContain('OPENAI_FOREIGN_MEMORY');
});
