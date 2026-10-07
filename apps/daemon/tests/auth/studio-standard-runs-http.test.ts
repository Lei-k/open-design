import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { runSseEventToPersistedAgentEvent } from '../../src/runtimes/chat-run-messages.js';
import { MultiUserStudioMessages } from '../../src/storage/multiuser-studio-messages.js';
import { cleanupIsolatedDataRoot, loadIsolatedServerModule, multiUserOptions, provisionAccounts,
  startMultiUserDaemon, type Principal, type StartedMultiUserDaemon } from './multiuser-harness.js';
import { PERSONAL_CODEX_MOCK, codexHome, linkCodex, setTurnMode } from './personal-codex-helpers.js';

let daemon: StartedMultiUserDaemon;
let root: string;
let a: Principal;
let b: Principal;
let admin: Principal;
const options = () => multiUserOptions({ testPersonalCodexAppServer: PERSONAL_CODEX_MOCK });
const question = '<question-form id="brief" title="Brief">{"questions":[{"id":"color","label":"Color","type":"text"}]}</question-form>';
type Frame = { id: string; event: string; data: Record<string, any> };
const frames = (text: string): Frame[] => text.split('\n\n').filter((s) => s.includes('data:')).map((s) => ({
  id: /^id: (.*)$/m.exec(s)![1]!, event: /^event: (.*)$/m.exec(s)![1]!, data: JSON.parse(/^data: (.*)$/m.exec(s)![1]!),
}));
async function project(user = a) {
  const id = randomUUID();
  const result = await daemon.request({ method: 'POST', path: '/api/projects', cookie: user.cookie, body: { id, name: id } });
  expect(result.status).toBe(200);
  return { projectId: id, conversationId: result.json.conversationId as string };
}
async function start(target: Awaited<ReturnType<typeof project>>, message: string, extra = {}, user = a) {
  return daemon.request({ method: 'POST', path: '/api/runs', cookie: user.cookie,
    body: { ...target, agentId: 'codex', executionSource: 'personal_subscription', message, ...extra } });
}
async function events(id: string, cursor?: string, user = a) {
  return daemon.request({ path: `/api/runs/${id}/events`, cookie: user.cookie,
    ...(cursor ? { headers: { 'last-event-id': cursor } } : {}) });
}
beforeAll(async () => {
  ({ dataRoot: root } = await loadIsolatedServerModule());
  daemon = await startMultiUserDaemon(options());
  const accounts = await provisionAccounts(daemon, ['standard-a', 'standard-b']);
  [a, b] = accounts.users as [Principal, Principal]; admin = accounts.admin;
  for (const user of [a, b]) await linkCodex(daemon, root, user, `${user.username}@example.test`);
}, 120_000);
afterAll(async () => { await daemon?.close(); cleanupIsolatedDataRoot(); });

it('records normalized events once, redacts hostile command output, and reloads the identical transcript', async () => {
  const target = await project();
  const made = await start(target, '[mock-progress]');
  expect(made.status).toBe(202);
  const stream = await events(made.json.runId);
  const all = frames(stream.text);
  expect(all.some((e) => e.event === 'agent' && e.data.type === 'tool_use')).toBe(true);
  expect(all.some((e) => e.event === 'progress' || (e.event === 'agent' && 'text' in e.data))).toBe(false);
  expect(all.filter((e) => e.event === 'end')).toHaveLength(1);
  const forbidden = ['PRIVATE_COMMAND_OUTPUT', 'FAKE_S3_SECRET', '/host/private/s3', root];
  const db = new Database(path.join(root, 'app.sqlite'));
  try {
    const durable = JSON.stringify(db.prepare('SELECT * FROM multiuser_run_events WHERE run_id = ?').all(made.json.runId));
    for (const token of forbidden) expect(stream.text.includes(token) || durable.includes(token)).toBe(false);
  } finally { db.close(); }
  const transcript = await daemon.request({ path: `/api/projects/${target.projectId}/conversations/${target.conversationId}/messages`, cookie: a.cookie });
  const assistant = transcript.json.messages.find((m: any) => m.role === 'assistant');
  expect(assistant.events).toEqual(all.map((e) => runSseEventToPersistedAgentEvent(e.event, e.data)).filter(Boolean));
  expect(assistant.content).toBe(all.filter((e) => e.event === 'agent' && e.data.type === 'text_delta').map((e) => e.data.delta).join(''));
  for (const cursor of all.slice(0, -1)) expect(frames((await events(made.json.runId, cursor.id)).text)).toEqual(all.filter((e) => Number(e.id) > Number(cursor.id)));
});

it('projects active frames incrementally with identical mid-run and final transcripts (#76)', async () => {
  const target = await project();
  const rebuilds = vi.spyOn(MultiUserStudioMessages.prototype, 'reconcile');
  try {
    const made = await start(target, '[mock-delay-ms=600] [mock-parity]');
    const id = made.json.runId as string;
    const response = await fetch(`${daemon.baseUrl}/api/runs/${id}/events`, { headers: { cookie: a.cookie }, signal: AbortSignal.timeout(8000) });
    const reader = response.body!.getReader(); let text = '';
    try { while (!text.includes('sessionId')) { const next = await reader.read(); if (next.done) break; text += new TextDecoder().decode(next.value); } }
    finally { await reader.cancel(); }
    const read = async () => (await daemon.request({ path: `/api/projects/${target.projectId}/conversations/${target.conversationId}/messages`, cookie: a.cookie }))
      .json.messages.find((m: any) => m.role === 'assistant');
    const mid = await read();
    expect(mid.runStatus).toBe('running');
    const all = frames((await events(id)).text);
    const project = (until: number) => all.filter((e) => Number(e.id) <= until).map((e) => runSseEventToPersistedAgentEvent(e.event, e.data)).filter(Boolean);
    expect(mid.events).toEqual(project(Number(mid.lastRunEventId)));
    const done = await read();
    expect(done.lastRunEventId).toBe(all.at(-1)!.id);
    expect(done.events).toEqual(project(Infinity));
    expect(done.content).toBe(all.filter((e) => e.event === 'agent' && e.data.type === 'text_delta').map((e) => e.data.delta).join(''));
    // Full re-projection is reserved for lifecycle edges (queued, start, terminal), never per frame.
    expect(all.length).toBeGreaterThan(10);
    expect(rebuilds.mock.calls.filter(([run]) => run.id === id).length).toBeLessThanOrEqual(3);
  } finally { rebuilds.mockRestore(); }
});

it('answers an owned question exactly once on the same thread and rejects foreign and stale answers', async () => {
  setTurnMode(root, a, { reply: question });
  const target = await project();
  const made = await start(target, 'ask');
  await events(made.json.runId);
  setTurnMode(root, a, {});
  const list = await daemon.request({ path: '/api/runs', cookie: a.cookie });
  expect(list.json.awaitingInputProjectIds).toContain(target.projectId);
  for (const user of [b, admin]) {
    expect((await daemon.request({ path: '/api/runs', cookie: user.cookie })).json.awaitingInputProjectIds).not.toContain(target.projectId);
    const foreign = await start(target, 'answer', { analyticsHints: { entryFrom: 'question_answer', sourceRunId: made.json.runId } }, user);
    const missing = await start({ projectId: randomUUID(), conversationId: randomUUID() }, 'answer', { analyticsHints: { entryFrom: 'question_answer', sourceRunId: randomUUID() } }, user);
    expect(foreign.status).toBe(404); expect(foreign.json).toEqual(missing.json);
    const ownedTarget = await project(user);
    const invalidAnswer = { analyticsHints: { entryFrom: 'question_answer', sourceRunId: made.json.runId, forbidden: true }, cwd: '/' };
    const foreignSource = await start(ownedTarget, 'answer', invalidAnswer, user);
    const missingSource = await start(ownedTarget, 'answer', { ...invalidAnswer,
      analyticsHints: { ...invalidAnswer.analyticsHints, sourceRunId: randomUUID() } }, user);
    expect(foreignSource.status).toBe(404); expect(foreignSource.json).toEqual(missingSource.json);
  }
  const extra = { analyticsHints: { entryFrom: 'question_answer', sourceRunId: made.json.runId } };
  const answer = await start(target, '[form answers — brief]\nColor: blue', extra);
  expect(answer.status).toBe(202);
  await events(answer.json.runId);
  const first = await daemon.request({ path: `/api/runs/${made.json.runId}`, cookie: a.cookie });
  const second = await daemon.request({ path: `/api/runs/${answer.json.runId}`, cookie: a.cookie });
  expect(second.json.output.threadId).toBe(first.json.output.threadId);
  expect((await start(target, 'again', extra)).status).toBe(409);
  expect((await daemon.request({ path: '/api/runs', cookie: a.cookie })).json.awaitingInputProjectIds).not.toContain(target.projectId);
});

it('reconnects during an active turn without dropping or duplicating durable events', async () => {
  const made = await start(await project(), '[mock-delay-ms=1000] [mock-parity]');
  const response = await fetch(`${daemon.baseUrl}/api/runs/${made.json.runId}/events`, { headers: { cookie: a.cookie }, signal: AbortSignal.timeout(8000) });
  const reader = response.body!.getReader();
  let text = '';
  try {
    while (!text.includes('sessionId')) { const next = await reader.read(); if (next.done) break; text += new TextDecoder().decode(next.value); }
  } finally { await reader.cancel(); }
  const complete = text.slice(0, text.lastIndexOf('\n\n') + 2);
  const before = frames(complete);
  expect((await daemon.request({ path: `/api/runs/${made.json.runId}`, cookie: a.cookie })).json.status).toBe('running');
  const after = frames((await events(made.json.runId, before.at(-1)!.id)).text);
  expect([...before, ...after]).toEqual(frames((await events(made.json.runId)).text));
  expect(new Set([...before, ...after].map((e) => e.id)).size).toBe(before.length + after.length);
});

it('rejects a question superseded by a newer turn or a changed native thread', async () => {
  for (const changed of ['newer-turn', 'thread'] as const) {
    setTurnMode(root, a, { reply: question });
    const target = await project();
    const made = await start(target, 'ask');
    await events(made.json.runId);
    setTurnMode(root, a, {});
    if (changed === 'newer-turn') {
      const newer = await start(target, 'continue without answering');
      await events(newer.json.runId);
    } else {
      const db = new Database(path.join(root, 'app.sqlite'));
      try { db.prepare('UPDATE multiuser_personal_sessions SET thread_id = ? WHERE conversation_id = ?').run('other-thread', target.conversationId); }
      finally { db.close(); }
    }
    const answer = await start(target, 'stale answer', { analyticsHints: { entryFrom: 'question_answer', sourceRunId: made.json.runId } });
    expect(answer.status).toBe(409);
    expect(answer.json.error.code).toBe('CONFLICT');
  }
});

it('cancels queued work idempotently without creating a native turn', async () => {
  await daemon.request({ method: 'PUT', path: '/api/admin/agent-accounts/personal-capacity', cookie: admin.cookie, body: { capacity: 0 } });
  try {
    const made = await start(await project(), 'queued cancel');
    for (let n = 0; n < 2; n++) expect((await daemon.request({ method: 'POST', path: `/api/runs/${made.json.runId}/cancel`, cookie: a.cookie })).json.status).toBe('canceled');
    expect(frames((await events(made.json.runId)).text).map((e) => e.event)).toEqual(['queued', 'end']);
  } finally {
    await daemon.request({ method: 'PUT', path: '/api/admin/agent-accounts/personal-capacity', cookie: admin.cookie, body: { capacity: 4 } });
  }
});

it('reports a model failure as a safe typed terminal error without changing the pinned source', async () => {
  setTurnMode(root, a, { turn: 'model-error' });
  const target = await project();
  try {
    const made = await start(target, 'model failure');
    const stream = await events(made.json.runId);
    expect(frames(stream.text)).toContainEqual(expect.objectContaining({ event: 'error', data: expect.objectContaining({
      error: expect.objectContaining({ code: 'MULTIUSER_PERSONAL_RUN_FAILED' }), codexErrorInfo: { reason: 'badRequest' },
    }) }));
    expect(stream.text.includes('FAKE_S3_SECRET')).toBe(false);
    expect((await daemon.request({ path: `/api/runs/${made.json.runId}`, cookie: a.cookie })).json).toMatchObject({
      status: 'failed', executionSource: 'personal_subscription', agentId: 'codex',
    });
  } finally { setTurnMode(root, a, {}); }
  const next = await start(target, 'retry same source');
  expect(frames((await events(next.json.runId)).text).at(-1)?.data.status).toBe('succeeded');
});

it('checks A/B/admin ownership before cursor and steering body validation and honestly refuses steering', async () => {
  for (const [owner, other] of [[a, b], [b, a]] as const) {
    const target = await project(owner);
    const made = await start(target, 'hello', {}, owner);
    await events(made.json.runId, undefined, owner);
    for (const user of [other, admin]) for (const suffix of ['events', 'cancel', 'steer']) {
      const request = (id: string) => daemon.request({ path: `/api/runs/${id}/${suffix}`, cookie: user.cookie,
        method: suffix === 'events' ? 'GET' : 'POST', headers: { 'last-event-id': 'bad' },
        ...(suffix === 'events' ? {} : { body: { forbidden: true } }) });
      const foreign = await request(made.json.runId); const absent = await request(randomUUID());
      expect(foreign.status).toBe(404); expect(foreign.json).toEqual(absent.json);
    }
    const refusal = await daemon.request({ method: 'POST', path: `/api/runs/${made.json.runId}/steer`, cookie: owner.cookie, body: { text: 'adjust' } });
    expect(refusal.status).toBe(409);
    expect(refusal.json.error).toMatchObject({ code: 'RUN_STEERING_UNSUPPORTED', details: { refusal: 'runtime_unsupported' } });
    expect((await daemon.request({ method: 'POST', path: `/api/runs/${made.json.runId}/steer`, cookie: owner.cookie, body: { text: 'adjust', cwd: '/' } })).status).toBe(400);
  }
});

it('interrupts the native turn and preserves its thread for the next run', async () => {
  const target = await project();
  const made = await start(target, '[mock-delay-ms=5000]');
  // A status/session event is a deterministic barrier: the turn has opened.
  const response = await fetch(`${daemon.baseUrl}/api/runs/${made.json.runId}/events`, { headers: { cookie: a.cookie }, signal: AbortSignal.timeout(8000) });
  const reader = response.body!.getReader(); let text = '';
  try { while (!text.includes('sessionId')) { const next = await reader.read(); if (next.done) break; text += new TextDecoder().decode(next.value); } }
  finally { await reader.cancel(); }
  const canceled = await daemon.request({ method: 'POST', path: `/api/runs/${made.json.runId}/cancel`, cookie: a.cookie });
  expect(canceled.json.status).toBe('canceled');
  const proof = path.join(codexHome(root, a.id), 'mock-interrupt.json');
  expect(existsSync(proof)).toBe(true);
  expect(readFileSync(proof, 'utf8')).toContain('threadId');
  const next = await start(target, 'continue'); await events(next.json.runId);
  const interruptedThread = JSON.parse(readFileSync(proof, 'utf8')).threadId;
  expect((await daemon.request({ path: `/api/runs/${next.json.runId}`, cookie: a.cookie })).json.output.threadId).toBe(interruptedThread);
  expect(frames((await events(made.json.runId)).text).at(-1)?.data.status).toBe('canceled');
});

it('recovers interrupted durable runs with error/end once and dispatches queued work on reopen', async () => {
  const target = await project();
  await daemon.request({ method: 'PUT', path: '/api/admin/agent-accounts/personal-capacity', cookie: admin.cookie, body: { capacity: 0 } });
  const crashed = await start(target, 'crashed'); const queued = await start(target, 'queued');
  await daemon.close();
  const db = new Database(path.join(root, 'app.sqlite'));
  try {
    db.prepare("UPDATE multiuser_runs SET status = 'active' WHERE id = ?").run(crashed.json.runId);
    db.prepare("UPDATE multiuser_pool_config SET value = '1' WHERE key = 'personal-capacity'").run();
  } finally { db.close(); }
  daemon = await startMultiUserDaemon(options());
  const recovered = frames((await events(crashed.json.runId)).text);
  expect(recovered.some((e) => e.event === 'error' && e.data.error.code === 'DAEMON_RESTARTED')).toBe(true);
  expect(recovered.filter((e) => e.event === 'end')).toHaveLength(1);
  expect(frames((await events(queued.json.runId)).text).at(-1)?.data.status).toBe('succeeded');
  await daemon.close(); daemon = await startMultiUserDaemon(options());
  expect(frames((await events(crashed.json.runId)).text)).toEqual(recovered);
});
