import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { writeFileSync, symlinkSync, unlinkSync, promises as fs } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { PERSONAL_CODEX_MOCK, linkCodex, setTurnMode } from './personal-codex-helpers.js';
import { syntheticGoodTranscript } from '../../src/critique/__fixtures__/adapters/synthetic-good.js';
import { syntheticBadTranscript } from '../../src/critique/__fixtures__/adapters/synthetic-bad.js';
import { cleanupIsolatedDataRoot, loadIsolatedServerModule, login, multiUserOptions, provisionAccounts,
  startMultiUserDaemon, type Principal, type StartedMultiUserDaemon } from './multiuser-harness.js';

const transcriptGate = vi.hoisted(() => ({ wait: null as Promise<void> | null, entered: () => {} }));
vi.mock('../../src/critique/transcript.js', async (original) => {
  const module = await original<typeof import('../../src/critique/transcript.js')>();
  return { ...module, writeTranscript: async (...args: Parameters<typeof module.writeTranscript>) => {
    if (transcriptGate.wait) { transcriptGate.entered(); await transcriptGate.wait; }
    return module.writeTranscript(...args);
  } };
});

let daemon: StartedMultiUserDaemon;
let root: string;
let a: Principal; let b: Principal; let admin: Principal;
const keys = ['sk-jury-a-fixture-key-0123456789', 'sk-jury-b-fixture-key-0123456789'];
const calls: string[] = [];
let hold = false;
let heldResolve: () => void;
let transcriptOverride: string | null = null;
const fixture: typeof fetch = async (_url, init) => {
  calls.push(new Headers(init?.headers).get('authorization')!);
  const text = transcriptOverride ?? syntheticGoodTranscript();
  const output = [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }];
  if (hold) {
    const first = text.slice(0, text.indexOf('<ROUND n="2">'));
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: first })}\n\n`));
      heldResolve();
      init?.signal?.addEventListener('abort', () => { try { controller.error(new Error('fixture_aborted')); } catch {} }, { once: true });
    } });
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  }
  return new Response([{ type: 'response.output_text.delta', delta: text },
    { type: 'response.completed', response: { output, usage: { input_tokens: 17, output_tokens: 23 } } }]
    .map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
};
beforeAll(async () => {
  ({ dataRoot: root } = await loadIsolatedServerModule());
  daemon = await startMultiUserDaemon(multiUserOptions({ testCompanyOpenAIFetch: fixture, testPersonalCodexAppServer: PERSONAL_CODEX_MOCK }));
  const accounts = await provisionAccounts(daemon, ['jury-a', 'jury-b']);
  [a, b] = accounts.users as [Principal, Principal]; admin = accounts.admin;
  for (const [index, user] of [a, b].entries()) expect((await daemon.request({ method: 'PUT',
    path: '/api/multiuser/settings/provider-keys/openai', cookie: user.cookie,
    body: { revision: 0, apiKey: keys[index] } })).status).toBe(200);
}, 120_000);
afterAll(async () => { await daemon?.close(); cleanupIsolatedDataRoot(); });
async function start(user = a) {
  const projectId = randomUUID();
  const project = await daemon.request({ method: 'POST', path: '/api/projects', cookie: user.cookie,
    body: { id: projectId, name: 'Jury' } });
  expect(project.status).toBe(200);
  const run = await daemon.request({ method: 'POST', path: `/api/projects/${projectId}/critique`, cookie: user.cookie,
    body: { conversationId: project.json.conversationId, agentId: 'openai-byok', message: 'Review this design' } });
  expect(run.status, run.text).toBe(202);
  const base = `/api/projects/${projectId}/critique/${run.json.runId}`;
  const events = await daemon.request({ path: `${base}/events`, cookie: user.cookie });
  expect(events.status).toBe(200);
  return { projectId, base, runId: run.json.runId as string, events: events.text };
}
async function heldRun(user: Principal, projectId: string, conversationId: string) {
  hold = true;
  const held = new Promise<void>((resolve) => { heldResolve = resolve; });
  const made = await daemon.request({ method: 'POST', path: `/api/projects/${projectId}/critique`, cookie: user.cookie,
    body: { conversationId, agentId: 'openai-byok', message: 'Review' } });
  expect(made.status, made.text).toBe(202); await held; hold = false;
  const base = `/api/projects/${projectId}/critique/${made.json.runId}`;
  const response = await fetch(`${daemon.baseUrl}${base}/events`, { headers: { cookie: user.cookie }, signal: AbortSignal.timeout(15000) });
  const reader = response.body!.getReader(); let text = '';
  while (!text.includes('event: critique.round_end')) { const chunk = await reader.read(); if (chunk.done) break; text += new TextDecoder().decode(chunk.value); }
  expect(text).toContain('critique.round_end');
  return { base, reader, runId: made.json.runId as string, text };
}
it('starts on the actor key, streams scored rounds and serves the SHIP artifact and replay', async () => {
  const { base, events } = await start();
  expect(events).toContain('event: critique.run_started');
  expect(events).toContain('event: critique.ship');
  expect(events).not.toContain('<ARTIFACT');
  const status = await daemon.request({ path: base, cookie: a.cookie });
  expect(status.json.critique.status).toBe('shipped');
  expect(status.json.critique.rounds).toHaveLength(3);
  expect(status.text).not.toMatch(/artifactPath|transcriptPath/);
  const artifact = await daemon.request({ path: `${base}/artifact`, cookie: a.cookie });
  expect(artifact.status).toBe(200); expect(artifact.text).toContain('<html');
  expect(artifact.headers['cache-control']).toBe('no-store');
  const replay = await daemon.request({ path: `${base}/transcript`, cookie: a.cookie });
  expect(replay.json.events.at(-1).type).toBe('ship');
  expect(calls.at(-1)).toBe(`Bearer ${keys[0]}`);
});
it('refuses A↔B, admin, missing and cross-project reads and interrupts identically', async () => {
  for (const owner of [a, b]) {
    const { base } = await start(owner);
    expect((await daemon.request({ path: base.replace(/\/[^/]+$/, ''), cookie: owner.cookie })).json.runs.length).toBeGreaterThan(0);
    for (const user of [owner === a ? b : a, admin]) {
      for (const prefix of ['/api/projects', '/api/multiuser/projects']) for (const method of ['POST', 'GET']) {
        const body = method === 'POST' ? { conversationId: 'missing', agentId: 'openai-byok', message: 'Review' } : undefined;
        const foreign = await daemon.request({ method, path: base.replace('/api/projects', prefix).replace(/\/[^/]+$/, ''), cookie: user.cookie, body });
        const missing = await daemon.request({ method, path: `${prefix}/${randomUUID()}/critique`, cookie: user.cookie, body });
        expect(foreign.status).toBe(404); expect(foreign.json).toEqual(missing.json);
      }
    }
    for (const user of [owner === a ? b : a, admin]) for (const prefix of ['/api/projects', '/api/multiuser/projects']) for (const suffix of ['', '/artifact', '/transcript', '/events', '/interrupt']) {
      const method = suffix === '/interrupt' ? 'POST' : 'GET';
      const route = base.replace('/api/projects', prefix);
      const foreign = await daemon.request({ method, path: `${route}${suffix}`, cookie: user.cookie });
      const missing = await daemon.request({ method, path: `${route.replace(/[^/]+$/, randomUUID())}${suffix}`, cookie: user.cookie });
      expect(foreign.status).toBe(404); expect(foreign.json).toEqual(missing.json);
    }
    expect((await daemon.request({ path: base.replace(/\/projects\/[^/]+/, `/projects/${randomUUID()}`), cookie: owner.cookie })).status).toBe(404);
  }
});
it('degrades malformed provider output without publishing a SHIP or artifact', async () => {
  transcriptOverride = syntheticBadTranscript();
  try {
    const run = await start();
    expect(run.events).toContain('event: critique.degraded'); expect(run.events).not.toContain('event: critique.ship');
    expect((await daemon.request({ path: run.base, cookie: a.cookie })).json.critique.status).toBe('degraded');
    expect((await daemon.request({ path: `${run.base}/artifact`, cookie: a.cookie })).status).toBe(404);
  } finally { transcriptOverride = null; }
});
it('executes company and personal Codex critiques on their own pinned sources', async () => {
  const company = await daemon.request({ method: 'PUT', path: '/api/admin/pool/openai', cookie: admin.cookie,
    body: { revision: 0, enabled: true, capacity: 1, model: 'gpt-4.1', apiKey: 'sk-jury-company-fixture-key-0123456789' } });
  expect(company.status).toBe(200);
  for (const agent of ['openai', 'codex']) {
    if (agent === 'codex') { await linkCodex(daemon, root, a, 'jury-a@example.test'); setTurnMode(root, a, { reply: syntheticGoodTranscript() }); }
    const projectId = randomUUID();
    const project = await daemon.request({ method: 'POST', path: '/api/projects', cookie: a.cookie, body: { id: projectId, name: 'Jury source' } });
    const run = await daemon.request({ method: 'POST', path: `/api/projects/${projectId}/critique`, cookie: a.cookie,
      body: { conversationId: project.json.conversationId, agentId: agent, message: 'Review the layout' } });
    expect(run.status, run.text).toBe(202);
    const events = await daemon.request({ path: `/api/projects/${projectId}/critique/${run.json.runId}/events`, cookie: a.cookie });
    expect(events.text).toContain('event: critique.ship');
    const info = await daemon.request({ path: `/api/runs/${run.json.runId}`, cookie: a.cookie });
    expect(info.json.status).toBe('succeeded');
    if (agent === 'openai') { expect(calls.at(-1)).toBe('Bearer sk-jury-company-fixture-key-0123456789'); expect(info.json.output.usage).toEqual({ inputTokens: 17, outputTokens: 23 }); }
    const mismatch = await daemon.request({ method: 'POST', path: `/api/projects/${projectId}/critique`, cookie: a.cookie,
      body: { conversationId: project.json.conversationId, agentId: 'openai-byok', message: 'Again' } });
    expect(mismatch.status).toBe(409); expect(mismatch.json.error.code).toBe('MULTIUSER_EXECUTION_SOURCE_MISMATCH');
  }
});
it('interrupts one live run, closes its stream and preserves the terminal outcome on a race', async () => {
  const projectId = randomUUID();
  const project = await daemon.request({ method: 'POST', path: '/api/projects', cookie: a.cookie, body: { id: projectId, name: 'Interrupt' } });
  const run = await heldRun(a, projectId, project.json.conversationId);
  try {
    const interrupt = await daemon.request({ method: 'POST', path: `${run.base}/interrupt`, cookie: a.cookie });
    expect(interrupt.status).toBe(200); expect(interrupt.json.status).toBe('canceled');
    let remaining = '';
    for (;;) { const next = await run.reader.read(); if (next.done) break; remaining += new TextDecoder().decode(next.value); }
    expect(run.text + remaining).toContain('event: critique.interrupted');
    expect((await daemon.request({ path: `${run.base}/transcript`, cookie: a.cookie })).json.events.at(-1).type).toBe('interrupted');
    expect((await daemon.request({ method: 'POST', path: `${run.base}/interrupt`, cookie: a.cookie })).status).toBe(409);
    expect((await daemon.request({ path: `${run.base}/artifact`, cookie: a.cookie })).status).toBe(404);
  } finally { await run.reader.cancel(); }
  const completed = await start();
  expect((await daemon.request({ method: 'POST', path: `${completed.base}/interrupt`, cookie: a.cookie })).status).toBe(409);
  expect((await daemon.request({ path: completed.base, cookie: a.cookie })).json.critique.status).toBe('shipped');
});
it('saves a replayable terminal outcome when interrupted before dispatch', async () => {
  const current = await daemon.request({ path: '/api/admin/pool/openai', cookie: admin.cookie });
  const configured = await daemon.request({ method: 'PUT', path: '/api/admin/pool/openai', cookie: admin.cookie,
    body: { revision: current.json.provider.revision, enabled: true, capacity: 0, model: 'gpt-4.1', apiKey: 'sk-jury-company-fixture-key-0123456789' } });
  expect(configured.status).toBe(200);
  try {
    const projectId = randomUUID();
    const project = await daemon.request({ method: 'POST', path: '/api/projects', cookie: a.cookie, body: { id: projectId, name: 'Queued Jury' } });
    const run = await daemon.request({ method: 'POST', path: `/api/projects/${projectId}/critique`, cookie: a.cookie,
      body: { conversationId: project.json.conversationId, agentId: 'openai', message: 'Review' } });
    expect(run.status).toBe(202);
    const base = `/api/projects/${projectId}/critique/${run.json.runId}`;
    expect((await daemon.request({ path: base, cookie: a.cookie })).json.status).toBe('queued');
    const before = calls.length;
    expect((await daemon.request({ method: 'POST', path: `${base}/interrupt`, cookie: a.cookie })).status).toBe(200);
    const transcript = await daemon.request({ path: `${base}/transcript`, cookie: a.cookie });
    expect(transcript.json.events.map((event: { type: string }) => event.type)).toEqual(['run_started', 'interrupted']);
    expect((await daemon.request({ path: `${base}/events`, cookie: a.cookie })).text).toContain('critique.interrupted');
    expect((await daemon.request({ path: `${base}/artifact`, cookie: a.cookie })).status).toBe(404);
    expect(calls.length).toBe(before);
  } finally {
    expect((await daemon.request({ method: 'PUT', path: '/api/admin/pool/openai', cookie: admin.cookie,
      body: { revision: configured.json.provider.revision, enabled: true, capacity: 1, model: 'gpt-4.1' } })).status).toBe(200);
  }
});
it('lets an emitted SHIP win an interrupt racing with transcript persistence', async () => {
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { transcriptGate.entered = resolve; });
  transcriptGate.wait = new Promise<void>((resolve) => { release = resolve; });
  const projectId = randomUUID();
  try {
    const project = await daemon.request({ method: 'POST', path: '/api/projects', cookie: a.cookie, body: { id: projectId, name: 'SHIP race' } });
    const run = await daemon.request({ method: 'POST', path: `/api/projects/${projectId}/critique`, cookie: a.cookie,
      body: { conversationId: project.json.conversationId, agentId: 'openai-byok', message: 'Review' } });
    expect(run.status).toBe(202); await entered;
    for (const endpoint of [`/api/projects/${projectId}/critique/${run.json.runId}/interrupt`, `/api/runs/${run.json.runId}/cancel`]) {
      const response = await fetch(`${daemon.baseUrl}${endpoint}`, {
        method: 'POST', headers: { cookie: a.cookie }, signal: AbortSignal.timeout(2000),
      });
      expect(response.status).toBe(409);
    }
    release(); transcriptGate.wait = null;
    const events = await daemon.request({ path: `/api/projects/${projectId}/critique/${run.json.runId}/events`, cookie: a.cookie });
    expect(events.text).toContain('critique.ship'); expect(events.text).not.toContain('critique.interrupted');
  } finally { release(); transcriptGate.wait = null; }
});
it('revokes an edit member mid-stream; the member owns its run and no other member can control it', async () => {
  const projectId = randomUUID();
  await daemon.request({ method: 'POST', path: '/api/projects', cookie: a.cookie, body: { id: projectId, name: 'Shared Jury' } });
  await daemon.request({ method: 'PUT', path: `/api/multiuser/projects/${projectId}/shares`, cookie: a.cookie, body: { username: b.username, role: 'edit' } });
  const conversation = await daemon.request({ method: 'POST', path: `/api/projects/${projectId}/conversations`, cookie: b.cookie, body: { title: 'B Jury' } });
  const run = await heldRun(b, projectId, conversation.json.conversation.id);
  try {
    expect((await daemon.request({ method: 'POST', path: `${run.base}/interrupt`, cookie: a.cookie })).status).toBe(404);
    expect((await daemon.request({ method: 'DELETE', path: `/api/multiuser/projects/${projectId}/shares/${b.id}`, cookie: a.cookie })).status).toBe(200);
    let remaining = ''; for (;;) { const next = await run.reader.read(); if (next.done) break; remaining += new TextDecoder().decode(next.value); }
    expect(remaining).not.toContain('critique.ship');
    for (const suffix of ['', '/artifact', '/transcript', '/events']) expect((await daemon.request({ path: `${run.base}${suffix}`, cookie: b.cookie })).status).toBe(404);
    const db = new Database(path.join(root, 'app.sqlite'));
    try { expect(db.prepare('SELECT status FROM multiuser_runs WHERE id = ?').get(run.runId)).toEqual({ status: 'canceled' }); }
    finally { db.close(); }
  } finally { await run.reader.cancel(); }
});
it('refuses artifact traversal, foreign-run paths, symlinks and oversized files', async () => {
  const run = await start(); const other = await start(b);
  const db = new Database(path.join(root, 'app.sqlite'));
  const artifact = (db.prepare('SELECT artifact_path AS file FROM critique_runs WHERE id = ?').get(run.runId) as { file: string }).file;
  const foreign = (db.prepare('SELECT artifact_path AS file FROM critique_runs WHERE id = ?').get(other.runId) as { file: string }).file;
  try {
    for (const file of [path.join(root, 'app.sqlite'), foreign]) {
      db.prepare('UPDATE critique_runs SET artifact_path = ? WHERE id = ?').run(file, run.runId);
      expect((await daemon.request({ path: `${run.base}/artifact`, cookie: a.cookie })).status).toBe(404);
    }
    db.prepare('UPDATE critique_runs SET artifact_path = ? WHERE id = ?').run(artifact, run.runId);
    unlinkSync(artifact); symlinkSync(foreign, artifact);
    expect((await daemon.request({ path: `${run.base}/artifact`, cookie: a.cookie })).status).toBe(404);
    unlinkSync(artifact); writeFileSync(artifact, Buffer.alloc(4 * 1024 * 1024 + 1));
    expect((await daemon.request({ path: `${run.base}/artifact`, cookie: a.cookie })).status).toBe(404);
  } finally { db.close(); }
});

it.each(['logout', 'deactivate', 'delete-project'] as const)('%s stops a live Jury and refuses its further reads', async (action) => {
  const username = `jury-${action}`; const password = `${username}-fixture-password`;
  const account = await daemon.request({ method: 'POST', path: '/api/auth/users', cookie: admin.cookie, body: { username, password, role: 'user' } });
  const user = { id: account.json.account.id, username, password, cookie: await login(daemon, username, password) };
  await daemon.request({ method: 'PUT', path: '/api/multiuser/settings/provider-keys/openai', cookie: user.cookie, body: { revision: 0, apiKey: keys[0] } });
  const projectId = randomUUID();
  const project = await daemon.request({ method: 'POST', path: '/api/projects', cookie: user.cookie, body: { id: projectId, name: action } });
  const run = await heldRun(user, projectId, project.json.conversationId);
  try {
    const result = action === 'logout' ? await daemon.request({ method: 'POST', path: '/api/auth/logout', cookie: user.cookie, body: {} })
      : action === 'deactivate' ? await daemon.request({ method: 'PATCH', path: `/api/auth/users/${user.id}`, cookie: admin.cookie, body: { active: false } })
        : await daemon.request({ method: 'DELETE', path: `/api/projects/${projectId}`, cookie: user.cookie });
    expect(result.status).toBeLessThan(300);
    let remaining = ''; for (;;) { const next = await run.reader.read(); if (next.done) break; remaining += new TextDecoder().decode(next.value); }
    expect(remaining).not.toContain('critique.ship');
    for (const suffix of ['', '/artifact', '/transcript', '/events']) expect((await daemon.request({ path: `${run.base}${suffix}`, cookie: user.cookie })).status).toBe(action === 'delete-project' ? 404 : 401);
  } finally { await run.reader.cancel(); }
});

it('rechecks the session after asynchronous artifact I/O', async () => {
  const run = await start();
  let release!: () => void; let entered!: () => void;
  const holding = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const realpath = fs.realpath.bind(fs);
  const spy = vi.spyOn(fs, 'realpath').mockImplementation(async (...args: Parameters<typeof fs.realpath>) => {
    const result = await realpath(...args);
    if (String(args[0]).endsWith(run.runId)) { entered(); await held; }
    return result;
  });
  const reading = daemon.request({ path: `${run.base}/artifact`, cookie: a.cookie });
  try {
    await holding;
    expect((await daemon.request({ method: 'POST', path: '/api/auth/logout', cookie: a.cookie, body: {} })).status).toBe(204);
    release(); const response = await reading;
    expect(response.text).not.toContain('<html');
  } finally { release(); spy.mockRestore(); a.cookie = await login(daemon, a.username, a.password); }
});

it('reconciles recent stale Jury rows on restart without crossing owner boundaries', async () => {
  const run = await start(); const other = await start(b);
  await daemon.close();
  const db = new Database(path.join(root, 'app.sqlite'));
  try {
    for (const id of [run.runId, other.runId]) {
      db.prepare("UPDATE multiuser_runs SET status = 'active', critique_reconciled = 0 WHERE id = ?").run(id);
      db.prepare("UPDATE critique_runs SET status = 'running', updated_at = ? WHERE id = ?").run(Date.now(), id);
      db.prepare("DELETE FROM studio_critique_events WHERE run_id = ? AND event IN ('critique.ship', 'critique.interrupted', 'critique.failed', 'critique.degraded')").run(id);
    }
  } finally { db.close(); }
  daemon = await startMultiUserDaemon(multiUserOptions({ testCompanyOpenAIFetch: fixture, testPersonalCodexAppServer: PERSONAL_CODEX_MOCK }));
  for (const [record, user, foreign] of [[run, a, b], [other, b, a]] as const) {
    const result = await daemon.request({ path: record.base, cookie: user.cookie });
    expect(result.json.critique.status).toBe('interrupted');
    const replay = await daemon.request({ path: `${record.base}/events`, cookie: user.cookie });
    expect(replay.text).toContain('event: critique.interrupted');
    expect((await daemon.request({ path: `${record.base}/artifact`, cookie: user.cookie })).status).toBe(404);
    expect((await daemon.request({ path: record.base, cookie: foreign.cookie })).status).toBe(404);
  }
});

function cli(args: string[], stdin = ''): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve('dist/cli.js'), ...args], { timeout: 15000, env: { ...process.env, SHELL: '/bin/sh' } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (text) => { stdout += text; }); child.stderr.on('data', (text) => { stderr += text; });
    child.once('error', reject); child.once('close', (code) => resolve({ code, stdout, stderr })); child.stdin.end(stdin);
  });
}
it('runs CLI start/watch/artifact/transcript/interrupt over the same cookie endpoints', async () => {
  const session = path.join(root, 'jury-cli-session');
  const signin = await cli(['session', 'login', '--daemon-url', daemon.baseUrl, '--username', a.username, '--password-file', '-', '--session-file', session, '--json'], a.password);
  expect(signin.code, signin.stderr).toBe(0);
  const projectId = randomUUID(); const project = await daemon.request({ method: 'POST', path: '/api/projects', cookie: a.cookie, body: { id: projectId, name: 'CLI Jury' } });
  const made = await cli(['critique', 'start', projectId, '--conversation-id', project.json.conversationId, '--agent', 'openai-byok', '--prompt-file', '-', '--session-file', session, '--json'], 'Review via stdin');
  expect(made.code, made.stderr).toBe(0); const runId = JSON.parse(made.stdout).runId;
  for (const command of ['watch', 'artifact', 'transcript', 'status']) {
    const result = await cli(['critique', command, projectId, runId, '--session-file', session, '--json']);
    expect(result.code, result.stderr).toBe(0);
    if (command === 'watch') expect(result.stdout.trim().split('\n').map((line) => JSON.parse(line).event)).toContain('critique.ship');
    if (command === 'artifact') expect(JSON.parse(result.stdout).content).toContain('<html');
  }
  const interrupt = await cli(['critique', 'interrupt', projectId, runId, '--session-file', session, '--json']);
  expect(interrupt.code).toBe(1); expect(JSON.parse(interrupt.stderr).error.code).toBe('CONFLICT');
  expect(JSON.parse((await cli(['critique', 'list', projectId, '--session-file', session, '--json'])).stdout).runs).toContainEqual({ id: runId });
  const liveProject = await daemon.request({ method: 'POST', path: '/api/projects', cookie: a.cookie, body: { id: randomUUID(), name: 'CLI interrupt' } });
  const live = await heldRun(a, liveProject.json.project.id, liveProject.json.conversationId);
  try {
    const canceled = await cli(['critique', 'interrupt', liveProject.json.project.id, live.runId, '--session-file', session, '--json']);
    expect(canceled.code, canceled.stderr).toBe(0); expect(JSON.parse(canceled.stdout).status).toBe('canceled');
    while (!(await live.reader.read()).done) {}
  } finally { await live.reader.cancel(); }
  for (const user of [b, admin]) {
    const foreignSession = path.join(root, `${user.username}-jury-cli-session`);
    expect((await cli(['session', 'login', '--daemon-url', daemon.baseUrl, '--username', user.username, '--password-file', '-', '--session-file', foreignSession, '--json'], user.password)).code).toBe(0);
    for (const command of ['artifact', 'watch', 'interrupt']) {
      const refused = await cli(['critique', command, projectId, runId, '--session-file', foreignSession, '--json']);
      expect(refused.code).toBe(1); expect(JSON.parse(refused.stderr).error.code).toBe('NOT_FOUND');
    }
  }
}, 90_000);
