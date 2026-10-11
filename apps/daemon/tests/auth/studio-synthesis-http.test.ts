import { currentAccountRevision } from './helpers.js';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { cleanupIsolatedDataRoot, loadIsolatedServerModule, multiUserOptions, provisionAccounts,
  startMultiUserDaemon, login, type Principal, type StartedMultiUserDaemon } from './multiuser-harness.js';

let daemon: StartedMultiUserDaemon;
let root: string;
let a: Principal; let b: Principal; let admin: Principal;
const ownKey = 'sk-s71-own-key-private-0123456789';
const companyKey = 'sk-s71-company-key-private-9876543210';
const calls: Array<{ authorization: string; model: string; url: string }> = [];
let fail = false;
let pause: (() => Promise<void>) | null = null;
const provider: typeof fetch = async (url, init) => {
  const body = JSON.parse(String(init?.body));
  calls.push({ authorization: new Headers(init?.headers).get('authorization') ?? '', model: body.model, url: String(url) });
  if (pause) await pause();
  init?.signal?.throwIfAborted();
  if (fail) return new Response(`${ownKey} ${companyKey}`, { status: 401 });
  return Response.json({ choices: [{ message: { content: '# Design\n\n## Context\nContinue the design.' } }],
    usage: { prompt_tokens: 11, completion_tokens: 7 } });
};
const call = (user: Principal, method: string, route: string, body?: unknown) =>
  daemon.request({ cookie: user.cookie, method, path: route, ...(body === undefined ? {} : { body }) });
async function target(user = a) {
  const id = randomUUID();
  const made = await call(user, 'POST', '/api/projects', { id, name: 'Synthesis' });
  expect(made.status, made.text).toBe(200);
  const cid = made.json.conversationId as string;
  expect((await call(user, 'POST', `/api/projects/${id}/files`, { name: 'index.html', content: '<h1>Design</h1>' })).status).toBe(200);
  // Run admission creates transcript rows; message PUT only edits existing rows.
  // Use the isolated mock worker so setup never reaches the OpenAI fixture.
  const admitted = await call(user, 'POST', '/api/runs', {
    projectId: id, conversationId: cid, agentId: 'test-mock', message: 'Make a calm landing page',
  });
  expect(admitted.status, admitted.text).toBe(202);
  const finished = await call(user, 'GET', `/api/runs/${admitted.json.runId}/events`);
  expect(finished.status, finished.text).toBe(200);
  expect(finished.text).toContain('"status":"succeeded"');
  const transcript = await call(user, 'GET', `/api/projects/${id}/conversations/${cid}/messages`);
  expect(transcript.status, transcript.text).toBe(200);
  expect(transcript.json.messages).toContainEqual(expect.objectContaining({ role: 'user', content: 'Make a calm landing page' }));
  return { id, cid };
}
const run = (action: string, project: { id: string; cid: string }, source: string | undefined = 'personal_api_key', user = a, extra = {}) =>
  call(user, 'POST', `/api/projects/${project.id}/${action === 'finalize' ? 'finalize/openai' : 'handoff'}`,
    { ...(action === 'handoff' ? { conversationId: project.cid } : {}), ...(source ? { executionSource: source } : {}), ...extra });
beforeAll(async () => {
  ({ dataRoot: root } = await loadIsolatedServerModule());
  daemon = await startMultiUserDaemon(multiUserOptions({ testCompanyOpenAIFetch: provider,
    testMockAgentScript: path.resolve('../..', 'mocks/run-isolation-agent.ts') }));
  const users = await provisionAccounts(daemon, ['synthesis-a', 'synthesis-b']);
  [a, b] = users.users as [Principal, Principal]; admin = users.admin;
  for (const user of [a, b]) {
    expect((await call(admin, 'PUT', `/api/admin/users/${user.id}/studio-pilot`, { studioPilot: true, revision: 0 })).status).toBe(200);
    expect((await call(user, 'PUT', '/api/multiuser/settings/provider-keys/openai', { revision: 0, apiKey: ownKey, model: 'gpt-own-s71' })).status).toBe(200);
  }
  expect((await call(admin, 'PUT', '/api/admin/pool/openai', { revision: 0, enabled: true, capacity: 2, model: 'gpt-company-s71', apiKey: companyKey })).status).toBe(200);
}, 120_000);
beforeEach(() => { calls.length = 0; fail = false; pause = null; });
afterAll(async () => { await daemon?.close(); cleanupIsolatedDataRoot(); });

it.each(['finalize', 'handoff'].flatMap((action) => ['personal_api_key', 'company_pool'].map((source) => [action, source])))('%s on %s records digest-bound output and usage', async (action, source) => {
  const project = await target();
  const response = await run(action, project, source);
  expect(response.status, response.text).toBe(200);
  expect(response.json).toMatchObject({ executionSource: source, model: source === 'company_pool' ? 'gpt-company-s71' : 'gpt-own-s71', inputTokens: 11, outputTokens: 7, current: true });
  expect(response.json.digest).toMatch(/^[a-f0-9]{64}$/);
  expect(calls).toEqual([{ authorization: `Bearer ${source === 'company_pool' ? companyKey : ownKey}`, model: source === 'company_pool' ? 'gpt-company-s71' : 'gpt-own-s71', url: 'https://api.openai.com/v1/chat/completions' }]);
  expect(response.text).not.toContain(root);
  expect(response.text).not.toContain(ownKey);
  const state = await call(a, 'GET', `/api/projects/${project.id}/synthesis`);
  expect(state.status, state.text).toBe(200);
  expect(state.json.results[action]).toMatchObject({ current: true, digest: response.json.digest });
  expect(readFileSync(path.join(root, 'projects', project.id, action === 'finalize' ? 'DESIGN.md' : 'HANDOFF.md'), 'utf8')).toContain('Continue the design');
  const db = new Database(path.join(root, 'app.sqlite'));
  try { expect(db.prepare('SELECT input_tokens, output_tokens FROM studio_synthesis_jobs WHERE project_id = ?').get(project.id))
    .toEqual({ input_tokens: 11, output_tokens: 7 }); } finally { db.close(); }
  await call(a, 'POST', `/api/projects/${project.id}/files`, { name: 'index.html', content: '<h1>Changed</h1>' });
  expect((await call(a, 'GET', `/api/projects/${project.id}/synthesis`)).json.results[action].current).toBe(false);
});
it.each(['finalize', 'handoff'])('%s refuses personal Codex with a typed reason', async (action) => {
  const response = await run(action, await target(), 'personal_subscription');
  expect(response.status, response.text).toBe(409);
  expect(response.json.error).toMatchObject({ code: 'MULTIUSER_CAPABILITY_UNAVAILABLE', details: { capability: 'deploy-synthesis', reason: 'personal-codex' } });
  expect(calls).toHaveLength(0);
});
it.each(['finalize', 'handoff'])('%s has indistinguishable foreign, missing, admin and viewer refusals; editor uses their own source', async (action) => {
  const project = await target();
  const foreign = await run(action, project, 'personal_api_key', b);
  const missing = await run(action, { ...project, id: randomUUID() }, 'personal_api_key', b);
  expect(foreign.status).toBe(404); expect(foreign.text).toBe(missing.text);
  expect((await run(action, project, 'personal_api_key', admin)).text).toBe(missing.text);
  expect((await call(a, 'PUT', `/api/multiuser/projects/${project.id}/shares`, { username: b.username, role: 'view' })).status).toBe(200);
  expect((await run(action, project, 'personal_api_key', b)).text).toBe(missing.text);
  expect((await call(a, 'PUT', `/api/multiuser/projects/${project.id}/shares`, { username: b.username, role: 'edit' })).status).toBe(200);
  expect((await run(action, project, 'personal_api_key', b)).status).toBe(200);
});
it.each(['apiKey', 'baseUrl', 'protocol', 'model'])('rejects client %s before any provider work', async (field) => {
  const project = await target();
  for (const action of ['finalize', 'handoff']) expect((await run(action, project, 'personal_api_key', a, { [field]: 'forbidden' })).status).toBe(400);
  expect(calls).toHaveLength(0);
});
it.each(['finalize', 'handoff'])('%s preserves existing project lock contention', async (action) => {
  const project = await target();
  const lock = path.join(root, 'projects', project.id, action === 'finalize' ? '.finalize.lock' : '.transcript.lock');
  writeFileSync(lock, 'busy');
  try { expect((await run(action, project)).status).toBe(409); expect(calls).toHaveLength(0); }
  finally { unlinkSync(lock); }
});
it.each(['finalize', 'handoff'])('%s errors never reflect provider secrets', async (action) => {
  fail = true;
  const response = await run(action, await target());
  expect(response.status, response.text).toBe(502);
  expect(response.text).not.toContain(ownKey); expect(response.text).not.toContain(companyKey);
  expect(response.text).not.toContain('private');
});
it.each(['finalize', 'handoff'])('%s refuses changed project bytes without writing a result', async (action) => {
  const project = await target();
  pause = async () => { await call(a, 'POST', `/api/projects/${project.id}/files`, { name: 'index.html', content: '<h1>Raced</h1>' }); };
  const response = await run(action, project);
  expect(response.status, response.text).toBe(409);
  expect(response.json.error.code).toBe('MULTIUSER_SYNTHESIS_STALE');
  expect(existsSync(path.join(root, 'projects', project.id, action === 'finalize' ? 'DESIGN.md' : 'HANDOFF.md'))).toBe(false);
});

it.each(['finalize', 'handoff'])('%s refuses quota before provider admission and keeps own key uncharged', async (action) => {
  const project = await target();
  expect((await call(admin, 'PUT', `/api/admin/pool/users/${a.id}/quota`, { budgetMinutes: 0 })).status).toBe(200);
  try {
    const response = await run(action, project, 'company_pool');
    expect(response.status, response.text).toBe(429); expect(response.json.error.code).toBe('MULTIUSER_QUOTA_EXHAUSTED');
    expect(calls).toHaveLength(0); expect((await run(action, project)).status).toBe(200);
  } finally { await call(admin, 'PUT', `/api/admin/pool/users/${a.id}/quota`, { budgetMinutes: 120 }); }
});
it.each(['finalize', 'handoff'])('%s refuses deactivated actors before provider admission', async (action) => {
  const project = await target();
  expect((await call(admin, 'PATCH', `/api/auth/users/${a.id}`, { active: false, revision: await currentAccountRevision(daemon.request, a.id, admin.cookie) })).status).toBe(200);
  try { expect((await run(action, project)).status).toBe(401); expect(calls).toHaveLength(0); }
  finally {
    await call(admin, 'PATCH', `/api/auth/users/${a.id}`, { active: true, revision: await currentAccountRevision(daemon.request, a.id, admin.cookie) });
    a = { ...a, cookie: await login(daemon, a.username, a.password) };
  }
});
it.each(['finalize', 'handoff'])('%s stops an admitted job after source revocation', async (action) => {
  const project = await target();
  const keys = await call(a, 'GET', '/api/multiuser/settings/provider-keys');
  expect(keys.status, keys.text).toBe(200);
  const current = keys.json.keys.find((key: { provider: string }) => key.provider === 'openai');
  expect(current).toBeDefined();
  pause = async () => { expect((await call(a, 'PUT', '/api/multiuser/settings/provider-keys/openai', { revision: current.revision, apiKey: null })).status).toBe(200); };
  try {
    const response = await run(action, project);
    expect(response.status, response.text).toBe(409); expect(response.json.error.code).toBe('MULTIUSER_SYNTHESIS_AUTHORITY_CHANGED');
    expect(existsSync(path.join(root, 'projects', project.id, action === 'finalize' ? 'DESIGN.md' : 'HANDOFF.md'))).toBe(false);
  } finally { await call(a, 'PUT', '/api/multiuser/settings/provider-keys/openai', { revision: current.revision + 1, apiKey: ownKey }); }
});
