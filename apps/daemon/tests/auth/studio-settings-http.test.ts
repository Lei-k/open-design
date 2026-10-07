import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { STUDIO_DEFAULT_ACCENT_COLOR, STUDIO_DEFAULT_NOTIFICATIONS, STUDIO_DEFAULT_CODEX_MODEL } from '@open-design/contracts';
import { cleanupIsolatedDataRoot, loadIsolatedServerModule, multiUserOptions, provisionAccounts,
  startMultiUserDaemon, type Principal, type StartedMultiUserDaemon } from './multiuser-harness.js';
import { PERSONAL_CODEX_MOCK, codexHome, linkCodex, setTurnMode, until } from './personal-codex-helpers.js';

let daemon: StartedMultiUserDaemon;
let root: string;
let a: Principal;
let b: Principal;
let admin: Principal;
beforeAll(async () => {
  ({ dataRoot: root } = await loadIsolatedServerModule());
  writeFileSync(path.join(root, 'app-config.json'), JSON.stringify({ customInstructions: 'HOST_PRIVATE_INSTRUCTIONS', agentCliEnv: { SECRET: 'HOST_SECRET' } }));
  daemon = await startMultiUserDaemon(multiUserOptions({ testPersonalCodexAppServer: PERSONAL_CODEX_MOCK }));
  const accounts = await provisionAccounts(daemon, ['settings-a', 'settings-b']);
  [a, b] = accounts.users as [Principal, Principal]; admin = accounts.admin;
  await linkCodex(daemon, root, a, 'settings-a@example.test');
}, 120_000);
afterAll(async () => { await daemon?.close(); cleanupIsolatedDataRoot(); });

async function instructions(value: string, user = a) {
  const current = await daemon.request({ path: '/api/app-config', cookie: user.cookie });
  const response = await daemon.request({ method: 'PUT', path: '/api/app-config', cookie: user.cookie,
    body: { revision: current.json.revision, customInstructions: value } });
  expect(response.status, response.text).toBe(200);
  return response.json;
}
async function memory(name: string, body: string, user = a) {
  const response = await daemon.request({ method: 'POST', path: '/api/memory', cookie: user.cookie,
    body: { name, description: '', type: 'user', body } });
  expect(response.status, response.text).toBe(200);
  return response.json.entry.id as string;
}
async function project() {
  const projectId = randomUUID();
  const response = await daemon.request({ method: 'POST', path: '/api/projects', cookie: a.cookie, body: { id: projectId, name: 'Private settings' } });
  expect(response.status).toBe(200);
  return { projectId, conversationId: response.json.conversationId as string };
}
async function run(target: Awaited<ReturnType<typeof project>>, message: string, extra: Record<string, unknown> = {}) {
  return daemon.request({ method: 'POST', path: '/api/runs', cookie: a.cookie,
    body: { ...target, message, agentId: 'codex', executionSource: 'personal_subscription', ...extra } });
}
async function finish(id: string) {
  const response = await daemon.request({ path: `/api/runs/${id}/events`, cookie: a.cookie });
  expect(response.text).toContain('"status":"succeeded"');
}

it('isolates config, rejects host fields and stale revisions, and persists only actor preferences', async () => {
  for (const user of [a, b, admin]) {
    const response = await daemon.request({ path: '/api/app-config', cookie: user.cookie });
    expect(response.json).toEqual({ config: { customInstructions: '', accentColor: STUDIO_DEFAULT_ACCENT_COLOR, notifications: STUDIO_DEFAULT_NOTIFICATIONS, codexModel: STUDIO_DEFAULT_CODEX_MODEL }, revision: 0 });
    expect(response.text).not.toContain('HOST_');
  }
  const saved = await instructions('A_INSTRUCTION_MARKER');
  expect(saved.revision).toBe(1);
  const stale = await daemon.request({ method: 'PUT', path: '/api/app-config', cookie: a.cookie, body: { revision: 0, customInstructions: 'overwrite' } });
  expect(stale.status).toBe(409);
  for (const extra of [{ ownerId: b.id }, { agentCliEnv: {} }, { projectLocations: [] }, { apiKey: 'secret' }]) {
    expect((await daemon.request({ method: 'PUT', path: '/api/app-config', cookie: a.cookie,
      body: { revision: 1, customInstructions: 'bad', ...extra } })).status).toBe(400);
  }
  expect((await daemon.request({ path: '/api/app-config', cookie: b.cookie })).json.config.customInstructions).toBe('');
  expect((await daemon.request({ path: '/api/multiuser/settings/config', cookie: a.cookie })).json).toEqual(saved);
});

it('persists portable notification intent, preserves omitted fields and rejects device/host settings', async () => {
  const current = (await daemon.request({ path: '/api/app-config', cookie: a.cookie })).json;
  const notifications = { soundEnabled: true, successSoundId: 'chime', failureSoundId: 'thud', desktopEnabled: true };
  const saved = await daemon.request({ method: 'PUT', path: '/api/app-config', cookie: a.cookie,
    body: { revision: current.revision, accentColor: '#1A74FF', notifications } });
  expect(saved.status, saved.text).toBe(200);
  expect(saved.json.config).toEqual({ ...current.config, accentColor: '#1a74ff', notifications });
  expect((await daemon.request({ path: '/api/app-config', cookie: b.cookie })).json.config.notifications).toEqual(STUDIO_DEFAULT_NOTIFICATIONS);
  for (const extra of [{ locale: 'zh-TW' }, { theme: 'dark' }, { notificationPermission: 'granted' }, { accentColor: 'url(secret)' },
    { notifications: { ...notifications, apiKey: 'hidden' } }, { notifications: { ...notifications, successSoundId: 'private-file' } },
    { notifications: { soundEnabled: true } }, { notifications: [] }]) {
    expect((await daemon.request({ method: 'PUT', path: '/api/app-config', cookie: a.cookie,
      body: { revision: saved.json.revision, ...extra } })).status).toBe(400);
  }
  expect((await daemon.request({ method: 'PUT', path: '/api/app-config', cookie: a.cookie,
    body: { revision: current.revision, notifications: null } })).status).toBe(409);
  const reset = await daemon.request({ method: 'PUT', path: '/api/app-config', cookie: a.cookie,
    body: { revision: saved.json.revision, notifications: null, accentColor: null } });
  expect(reset.status).toBe(200);
  expect(reset.json.config).toEqual({ ...current.config, accentColor: STUDIO_DEFAULT_ACCENT_COLOR, notifications: STUDIO_DEFAULT_NOTIFICATIONS });
});

it('isolates manual entries, tree, index and profile; foreign equals missing including for admin', async () => {
  const id = await memory('Private fact', 'A_MEMORY_MARKER');
  for (const user of [b, admin]) for (const [method, body] of [['GET', undefined], ['PUT', { name: 'edit', description: '', type: 'user', body: 'edit' }], ['DELETE', {}]] as const) {
    const foreign = await daemon.request({ method, path: `/api/memory/${id}`, cookie: user.cookie, ...(body ? { body } : {}) });
    const missing = await daemon.request({ method, path: '/api/memory/absent_fact', cookie: user.cookie, ...(body ? { body } : {}) });
    expect(foreign.status).toBe(404); expect(foreign.json).toEqual(missing.json);
  }
  for (const endpoint of ['/api/memory', '/api/memory/tree', '/api/memory/system-prompt']) {
    const own = await daemon.request({ path: endpoint, cookie: a.cookie });
    expect(own.status).toBe(200); expect(own.text).not.toContain(root);
    for (const user of [b, admin]) {
      const response = await daemon.request({ path: endpoint, cookie: user.cookie });
      expect(response.status).toBe(200); expect(response.text).not.toMatch(/A_MEMORY_MARKER|Private fact|HOST_/);
    }
  }
  const profile = await daemon.request({ method: 'PUT', path: '/api/memory/user_profile', cookie: a.cookie,
    body: { name: 'Profile', description: '', type: 'profile', body: '- Role: A_PROFILE_MARKER' } });
  expect(profile.status, profile.text).toBe(200);
  expect((await daemon.request({ path: '/api/memory/system-prompt', cookie: a.cookie })).text).toContain('A_PROFILE_MARKER');
  expect((await daemon.request({ method: 'PATCH', path: '/api/memory/config', cookie: a.cookie, body: { profileEnabled: false } })).status).toBe(200);
  expect((await daemon.request({ path: '/api/memory/system-prompt', cookie: a.cookie })).text).not.toContain('A_PROFILE_MARKER');
  expect((await daemon.request({ method: 'PATCH', path: `/api/memory/tree/${id}`, cookie: a.cookie, body: { description: 'edited', type: 'reference' } })).status).toBe(200);
});

it('keeps automatic/provider memory closed and bounds manual content and identifiers', async () => {
  for (const body of [{ extraction: { provider: 'openai', apiKey: 'secret' } }, { chatExtractionEnabled: true }, { verifyEnabled: true }, { rewriteEnabled: true }, { ownerId: b.id }]) {
    expect((await daemon.request({ method: 'PATCH', path: '/api/memory/config', cookie: a.cookie, body })).status).toBe(400);
  }
  for (const extra of [{ id: '../escape' }, { id: 123 }, { id: 'events' }, { ownerId: b.id }, { path: '/host/private' }, { body: 'a'.repeat(65537) }]) {
    expect((await daemon.request({ method: 'POST', path: '/api/memory', cookie: a.cookie,
      body: { name: 'bad', description: '', type: 'user', body: 'text', ...extra } })).status).toBe(400);
  }
  for (const endpoint of ['/api/memory/extractions', '/api/memory/verifications']) {
    expect((await daemon.request({ path: endpoint, cookie: a.cookie })).status).toBe(403);
  }
});

function stream(user: Principal) {
  const url = new URL(daemon.baseUrl);
  let body = ''; let ended = false;
  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
  const request = http.get({ hostname: url.hostname, port: url.port, path: '/api/memory/events', headers: { Cookie: user.cookie } }, (response) => {
    expect(response.statusCode).toBe(200);
    response.on('data', (chunk) => { body += String(chunk); resolveReady(); });
    response.on('end', () => { ended = true; });
  });
  return { ready, body: () => body, ended: () => ended, close: () => request.destroy() };
}
it('partitions SSE and closes an idle stream after logout', async () => {
  const first = stream(a); const second = stream(b);
  try {
    await Promise.all([first.ready, second.ready]);
    const id = await memory('Stream fact', 'SSE_PRIVATE_BODY');
    await until(async () => first.body(), (body) => body.includes(id));
    expect(second.body()).not.toContain(id);
    expect(first.body()).not.toContain('SSE_PRIVATE_BODY');
    await daemon.request({ method: 'POST', path: '/api/auth/logout', cookie: b.cookie, body: {} });
    await until(async () => second.ended(), Boolean);
  } finally { first.close(); second.close(); }
});

it('captures instructions and memory before queue admission, despite later edits and deletion', async () => {
  await instructions('QUEUED_INSTRUCTIONS_ORIGINAL');
  const id = await memory('Queue fact', 'QUEUED_MEMORY_ORIGINAL');
  const first = await run(await project(), '[mock-delay-ms=5000] occupy worker');
  expect(first.status, first.text).toBe(202);
  await until(() => daemon.request({ path: `/api/runs/${first.json.runId}`, cookie: a.cookie }), (response) => response.json.status === 'running');
  const queued = await run(await project(), 'Use saved context');
  expect(queued.status, queued.text).toBe(202);
  expect((await daemon.request({ path: `/api/runs/${queued.json.runId}`, cookie: a.cookie })).json.status).toBe('queued');
  await instructions('QUEUED_INSTRUCTIONS_REPLACEMENT');
  expect((await daemon.request({ method: 'DELETE', path: `/api/memory/${id}`, cookie: a.cookie, body: {} })).status).toBe(200);
  await finish(first.json.runId); await finish(queued.json.runId);
  const evidence = JSON.parse(readFileSync(path.join(codexHome(root, a.id), 'mock-turn-evidence.json'), 'utf8'));
  expect(evidence.message).toContain('QUEUED_INSTRUCTIONS_ORIGINAL');
  expect(evidence.message).toContain('QUEUED_MEMORY_ORIGINAL');
  expect(evidence.message).not.toMatch(/QUEUED_INSTRUCTIONS_REPLACEMENT|HOST_PRIVATE/);
}, 20_000);

it('answers a question using the captured preferences after the settings have changed', async () => {
  await instructions('QUESTION_INSTRUCTION_ORIGINAL');
  const target = await project();
  setTurnMode(root, a, { reply: '<question-form id="brief">{"questions":[{"id":"color","label":"Color","type":"text"}]}</question-form>' });
  const source = await run(target, 'Ask about color');
  expect(source.status, source.text).toBe(202); await finish(source.json.runId);
  await instructions('QUESTION_INSTRUCTION_REPLACEMENT');
  setTurnMode(root, a, {});
  const answer = await run(target, '[form answers — brief]\nColor: blue', { analyticsHints: { entryFrom: 'question_answer', sourceRunId: source.json.runId } });
  expect(answer.status, answer.text).toBe(202); await finish(answer.json.runId);
  const first = await daemon.request({ path: `/api/runs/${source.json.runId}`, cookie: a.cookie });
  const next = await daemon.request({ path: `/api/runs/${answer.json.runId}`, cookie: a.cookie });
  expect(next.json.output.threadId).toBe(first.json.output.threadId);
});
