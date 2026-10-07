import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { cleanupIsolatedDataRoot, loadIsolatedServerModule, multiUserOptions, provisionAccounts,
  startMultiUserDaemon, type Principal, type StartedMultiUserDaemon } from './multiuser-harness.js';
import { PERSONAL_CODEX_MOCK, linkCodex, setTurnMode } from './personal-codex-helpers.js';

// S4 (#56/#57): the shared Studio's standard ChatRequest admits a personal run
// with the actor's own transcript ids, idempotently, under an explicit policy.
let daemon: StartedMultiUserDaemon;
let root: string;
let a: Principal;
let b: Principal;
let admin: Principal;
const prefixes = new Map<string, string>();
type Target = { projectId: string; conversationId: string };

async function pilot(user: Principal) {
  const current = await daemon.request({ path: `/api/admin/users/${user.id}/studio-pilot`, cookie: admin.cookie });
  const set = await daemon.request({ method: 'PUT', path: `/api/admin/users/${user.id}/studio-pilot`, cookie: admin.cookie,
    body: { studioPilot: true, revision: current.json.revision } });
  expect(set.status).toBe(200);
  const me = await daemon.request({ path: '/api/auth/me', cookie: user.cookie });
  expect(me.json.studio.features.execution.status).toBe('pilot');
  expect(me.json.studio.features.composer.status).toBe('pilot');
  expect(me.json.studioMessageIdPrefix).toMatch(/^mua_[0-9a-f]{24}_$/);
  prefixes.set(user.id, me.json.studioMessageIdPrefix);
}
async function project(user = a): Promise<Target> {
  const id = randomUUID();
  const result = await daemon.request({ method: 'POST', path: '/api/projects', cookie: user.cookie, body: { id, name: id } });
  expect(result.status).toBe(200);
  return { projectId: id, conversationId: result.json.conversationId as string };
}
/** The body ProjectView's streamViaDaemon sends for a plain text turn (no capability chosen). */
function studioRequest(target: Target, prompt: string, user = a, extra: Record<string, unknown> = {}) {
  const prefix = prefixes.get(user.id)!;
  return {
    agentId: 'codex', message: `## user\n${prompt}`, currentPrompt: prompt, priorTranscript: '', ...target,
    sessionMode: 'design', userMessageId: `${prefix}${randomUUID()}`, assistantMessageId: `${prefix}${randomUUID()}`,
    clientRequestId: randomUUID(), skillId: null, skillIds: [], designSystemId: null, attachments: [], commentAttachments: [],
    model: null, reasoning: null, serviceTier: null, locale: 'en', titleGeneration: { enabled: true },
    analyticsHints: { hasExistingArtifact: false, runtimeType: 'local_cli', taskExecutionId: randomUUID() }, ...extra,
  };
}
const send = (body: Record<string, unknown>, user = a) => daemon.request({ method: 'POST', path: '/api/runs', cookie: user.cookie, body });
const finished = async (id: string, user = a) => (await daemon.request({ path: `/api/runs/${id}/events`, cookie: user.cookie })).text;
const transcript = async (target: Target, user = a) => (await daemon.request({
  path: `/api/projects/${target.projectId}/conversations/${target.conversationId}/messages`, cookie: user.cookie })).json.messages as Array<Record<string, any>>;
const runCount = async (target: Target, user = a) => (await daemon.request({
  path: `/api/runs?conversationId=${target.conversationId}`, cookie: user.cookie })).json.runs.length as number;

beforeAll(async () => {
  ({ dataRoot: root } = await loadIsolatedServerModule());
  daemon = await startMultiUserDaemon(multiUserOptions({ testPersonalCodexAppServer: PERSONAL_CODEX_MOCK }));
  const accounts = await provisionAccounts(daemon, ['admission-a', 'admission-b']);
  [a, b] = accounts.users as [Principal, Principal]; admin = accounts.admin;
  for (const user of [a, b]) { await linkCodex(daemon, root, user, `${user.username}@example.test`); await pilot(user); }
}, 120_000);
afterAll(async () => { await daemon?.close(); cleanupIsolatedDataRoot(); });

it('admits the standard Studio request with the actor\'s ids and reloads the same turn', async () => {
  const target = await project();
  const body = studioRequest(target, 'hello studio');
  const made = await send(body);
  expect(made.status).toBe(202);
  expect(made.json.run).toMatchObject({ userMessageId: body.userMessageId, assistantMessageId: body.assistantMessageId, agentId: 'codex' });
  await finished(made.json.runId);
  const messages = await transcript(target);
  expect(messages.map((m) => [m.id, m.role])).toEqual([[body.userMessageId, 'user'], [body.assistantMessageId, 'assistant']]);
  // The turn text is currentPrompt; the stitched transcript is not replayed into the native thread.
  expect(messages[0]!.content).toBe('hello studio');
  expect(messages[1]).toMatchObject({ runId: made.json.runId, runStatus: 'succeeded' });
});

it('returns the first run for a replayed clientRequestId and never starts a second one', async () => {
  const target = await project();
  const body = studioRequest(target, 'once');
  const first = await send(body);
  const again = await send(body);
  expect(first.status).toBe(202);
  expect(again.status).toBe(200);
  expect(again.json.runId).toBe(first.json.runId);
  await finished(first.json.runId);
  expect(await runCount(target)).toBe(1);
});

it('accepts ids only in the actor\'s own namespace and refuses reused ids', async () => {
  const target = await project();
  const foreignPrefix = prefixes.get(b.id)!;
  for (const ids of [
    { userMessageId: `${foreignPrefix}${randomUUID()}`, assistantMessageId: `${foreignPrefix}${randomUUID()}` },
    { userMessageId: randomUUID(), assistantMessageId: randomUUID() },
    { userMessageId: `${prefixes.get(a.id)}${randomUUID()}`, assistantMessageId: null },
  ]) {
    const refused = await send(studioRequest(target, 'x', a, ids));
    expect(refused.status).toBe(400);
    expect(refused.json.error.code).toBe('BAD_REQUEST');
  }
  const body = studioRequest(target, 'first');
  await finished((await send(body)).json.runId);
  const reused = await send(studioRequest(target, 'second', a, { assistantMessageId: body.assistantMessageId }));
  expect(reused.status).toBe(409);
  // A succeeded turn is not retryable: its user id cannot back another run.
  const notRetry = await send(studioRequest(target, 'first', a, { userMessageId: body.userMessageId }));
  expect(notRetry.status).toBe(409);
  expect(await runCount(target)).toBe(1);
});

it('refuses capabilities the personal lane does not apply instead of dropping them', async () => {
  const target = await project();
  for (const extra of [{ model: 'gpt-5' }, { reasoning: 'high' },
    { sessionMode: 'plan' }, { research: { enabled: true } }, { context: { files: [] } }, { taskExecutionId: randomUUID() },
    { byokProvider: { kind: 'openai' } }, { commentAttachments: [{ id: 'c' }] }, { appliedPluginSnapshotId: 'snap' }]) {
    const refused = await send(studioRequest(target, 'x', a, extra));
    expect([Object.keys(extra)[0], refused.status, refused.json.error.code])
      .toEqual([Object.keys(extra)[0], 403, 'MULTIUSER_CAPABILITY_UNAVAILABLE']);
  }
  const named = await send(studioRequest(target, 'x', a, { designSystemId: 'some-system' }));
  expect(named.status).toBe(404);
  expect(await runCount(target)).toBe(0);
});

it('retries a failed turn on the same user message and lists every attempt', async () => {
  const target = await project();
  setTurnMode(root, a, { turn: 'usage-limit' });
  const body = studioRequest(target, 'try me');
  const failed = await send(body);
  await finished(failed.json.runId);
  setTurnMode(root, a, {});
  const retry = studioRequest(target, 'try me', a, { userMessageId: body.userMessageId });
  const second = await send(retry);
  expect(second.status).toBe(202);
  await finished(second.json.runId);
  expect((await transcript(target)).map((m) => [m.id, m.role, m.runStatus ?? null])).toEqual([
    [body.userMessageId, 'user', null], [body.assistantMessageId, 'assistant', 'failed'], [retry.assistantMessageId, 'assistant', 'succeeded'],
  ]);
});

it('resumes with ?after= exactly like Last-Event-ID and hides foreign runs identically', async () => {
  const target = await project();
  const made = await send(studioRequest(target, 'cursor'));
  const all = await finished(made.json.runId);
  const ids = [...all.matchAll(/^id: (\d+)$/gm)].map((match) => match[1]!);
  expect(ids.length).toBeGreaterThan(2);
  const viaQuery = await daemon.request({ path: `/api/runs/${made.json.runId}/events?after=${ids[1]}`, cookie: a.cookie });
  const viaHeader = await daemon.request({ path: `/api/runs/${made.json.runId}/events`, cookie: a.cookie, headers: { 'last-event-id': ids[1]! } });
  expect(viaQuery.text).toBe(viaHeader.text);
  expect([...viaQuery.text.matchAll(/^id: (\d+)$/gm)].map((match) => match[1])).toEqual(ids.slice(2));
  const mismatch = await daemon.request({ path: `/api/runs/${made.json.runId}/events?after=1`, cookie: a.cookie, headers: { 'last-event-id': '2' } });
  expect(mismatch.status).toBe(400);
  const foreign = await daemon.request({ path: `/api/runs/${made.json.runId}/events?after=1`, cookie: b.cookie });
  const missing = await daemon.request({ path: `/api/runs/${randomUUID()}/events?after=1`, cookie: b.cookie });
  expect(foreign.status).toBe(404);
  expect(foreign.json).toEqual(missing.json);
});

it('persists owner feedback on the assistant turn only and keeps the run engine the content writer', async () => {
  const target = await project();
  const body = studioRequest(target, 'rate me');
  const made = await send(body);
  await finished(made.json.runId);
  const url = (id: string, t = target) => `/api/projects/${t.projectId}/conversations/${t.conversationId}/messages/${id}`;
  const feedback = { rating: 'negative', reasonCodes: ['weak_visual'], customReason: 'flat', createdAt: 1, updatedAt: 2 };
  const rated = await daemon.request({ method: 'PUT', path: url(body.assistantMessageId), cookie: a.cookie,
    body: { id: body.assistantMessageId, role: 'assistant', content: 'forged', feedback } });
  expect(rated.status).toBe(200);
  expect(rated.json.message).toMatchObject({ feedback, runId: made.json.runId });
  expect(rated.json.message.content).not.toBe('forged');
  const cleared = await daemon.request({ method: 'PUT', path: url(body.assistantMessageId), cookie: a.cookie,
    body: { id: body.assistantMessageId, role: 'assistant', content: '', feedback: null } });
  expect(cleared.json.message.feedback).toBeUndefined();
  for (const invalid of [{ ...feedback, rating: 'meh' }, { ...feedback, reasonCodes: ['nope'] }, { ...feedback, extra: true }]) {
    const refused = await daemon.request({ method: 'PUT', path: url(body.assistantMessageId), cookie: a.cookie,
      body: { id: body.assistantMessageId, role: 'assistant', content: '', feedback: invalid } });
    expect(refused.status).toBe(400);
  }
  const onUser = await daemon.request({ method: 'PUT', path: url(body.userMessageId), cookie: a.cookie,
    body: { id: body.userMessageId, role: 'user', content: 'rate me', feedback } });
  expect(onUser.status).toBe(400);
  const foreignWrite = await daemon.request({ method: 'PUT', path: url(body.assistantMessageId), cookie: b.cookie,
    body: { id: body.assistantMessageId, role: 'assistant', content: '', feedback } });
  expect(foreignWrite.status).toBe(404);
  const telemetry = await daemon.request({ method: 'POST', path: `/api/runs/${made.json.runId}/feedback`, cookie: a.cookie,
    body: { rating: 'positive', reasonCodes: [], hasCustomReason: false, customReason: '' } });
  expect(telemetry.status).toBe(202);
  expect(telemetry.json).toEqual({ status: 'skipped_no_sink' });
  const retarget = await daemon.request({ method: 'POST', path: `/api/runs/${made.json.runId}/feedback`, cookie: a.cookie,
    body: { rating: 'positive', projectId: target.projectId } });
  expect(retarget.status).toBe(400);
  const foreign = await daemon.request({ method: 'POST', path: `/api/runs/${made.json.runId}/feedback`, cookie: b.cookie, body: { rating: 'positive' } });
  const missing = await daemon.request({ method: 'POST', path: `/api/runs/${randomUUID()}/feedback`, cookie: b.cookie, body: { rating: 'positive' } });
  expect(foreign.status).toBe(404);
  expect(foreign.json).toEqual(missing.json);
});
