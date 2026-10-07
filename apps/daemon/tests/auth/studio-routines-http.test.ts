// #64: account-owned Automations. Routines are private to their owner and
// dispatch through the standard run admission as that owner, re-checking the
// account, Studio pilot and target project on every run.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { cleanupIsolatedDataRoot, loadIsolatedServerModule, multiUserOptions, provisionAccounts,
  startMultiUserDaemon, type Principal, type StartedMultiUserDaemon } from './multiuser-harness.js';
import { PERSONAL_CODEX_MOCK, codexHome, linkCodex, until } from './personal-codex-helpers.js';

let daemon: StartedMultiUserDaemon; let root: string; let a: Principal; let b: Principal; let admin: Principal;
const pilotRevision = new Map<string, number>();
async function pilot(user: Principal, studioPilot: boolean) {
  const revision = pilotRevision.get(user.id) ?? 0;
  const result = await daemon.request({ method: 'PUT', path: `/api/admin/users/${user.id}/studio-pilot`, cookie: admin.cookie, body: { studioPilot, revision } });
  expect(result.status, result.text).toBe(200);
  pilotRevision.set(user.id, revision + 1);
}
beforeAll(async () => {
  ({ dataRoot: root } = await loadIsolatedServerModule());
  daemon = await startMultiUserDaemon(multiUserOptions({ testPersonalCodexAppServer: PERSONAL_CODEX_MOCK }));
  const accounts = await provisionAccounts(daemon, ['routine-a', 'routine-b']);
  [a, b] = accounts.users as [Principal, Principal]; admin = accounts.admin;
  await linkCodex(daemon, root, a, 'routine-a@example.test');
  await pilot(a, true); await pilot(b, true);
}, 120_000);
afterAll(async () => { await daemon?.close(); cleanupIsolatedDataRoot(); });

const daily = { kind: 'daily', time: '09:30', timezone: 'UTC' };
async function routine(user: Principal, extra: Record<string, unknown> = {}) {
  return daemon.request({ method: 'POST', path: '/api/routines', cookie: user.cookie,
    body: { name: 'Morning brief', prompt: 'ROUTINE_PROMPT_MARKER summarize the board', schedule: daily, target: { mode: 'create_each_run' }, ...extra } });
}
async function runs(user: Principal, id: string) {
  return daemon.request({ path: `/api/routines/${encodeURIComponent(id)}/runs`, cookie: user.cookie });
}

it('keeps routines private and runs them as the owner on a fresh owned project', async () => {
  const made = await routine(a);
  expect(made.status, made.text).toBe(201);
  const id = made.json.routine.id as string;
  expect(made.json.routine).toMatchObject({ name: 'Morning brief', enabled: true, agentId: 'codex', schedule: daily, lastRun: null });
  expect(typeof made.json.routine.nextRunAt).toBe('number');
  expect((await daemon.request({ path: '/api/routines', cookie: a.cookie })).json.routines.map((item: { id: string }) => item.id)).toEqual([id]);
  expect((await daemon.request({ path: '/api/routines', cookie: b.cookie })).json.routines).toEqual([]);
  for (const [method, suffix] of [['GET', ''], ['PATCH', ''], ['DELETE', ''], ['POST', '/run'], ['GET', '/runs']] as const) {
    const foreign = await daemon.request({ method, path: `/api/routines/${encodeURIComponent(id)}${suffix}`, cookie: b.cookie,
      ...(method === 'PATCH' ? { body: { enabled: false } } : method === 'GET' ? {} : { body: {} }) });
    expect([method, suffix, foreign.status]).toEqual([method, suffix, 404]);
  }

  const started = await daemon.request({ method: 'POST', path: `/api/routines/${encodeURIComponent(id)}/run`, cookie: a.cookie, body: {} });
  expect(started.status, started.text).toBe(202);
  const projectId = started.json.run.projectId as string;
  const finished = await until(() => runs(a, id), (result) => ['succeeded', 'failed', 'canceled'].includes(result.json.runs[0]?.status), 'routine run');
  expect(finished.json.runs[0]).toMatchObject({ status: 'succeeded', trigger: 'manual', projectId });
  expect(finished.json.runs[0].agentRunId).toMatch(/^[0-9a-f-]{36}$/);
  const evidence = JSON.parse(readFileSync(path.join(codexHome(root, a.id), 'mock-turn-evidence.json'), 'utf8'));
  expect(evidence.message).toContain('ROUTINE_PROMPT_MARKER');
  expect(evidence.message).toContain('unattended scheduled routine');
  // The instruction reaches the agent but the visible user turn is the routine prompt only.
  const conversation = finished.json.runs[0].conversationId as string;
  const transcript = await daemon.request({ path: `/api/projects/${projectId}/conversations/${conversation}/messages`, cookie: a.cookie });
  expect(transcript.json.messages[0]).toMatchObject({ role: 'user', content: 'ROUTINE_PROMPT_MARKER summarize the board' });
  expect((await daemon.request({ path: `/api/projects/${projectId}`, cookie: a.cookie })).status).toBe(200);
  expect((await daemon.request({ path: `/api/projects/${projectId}`, cookie: b.cookie })).status).toBe(404);
  expect((await daemon.request({ path: `/api/runs/${finished.json.runs[0].agentRunId}`, cookie: b.cookie })).status).toBe(404);
  expect((await daemon.request({ path: `/api/routines/${encodeURIComponent(id)}`, cookie: a.cookie })).json.routine.lastRun)
    .toMatchObject({ status: 'succeeded', projectId });

  const paused = await daemon.request({ method: 'PATCH', path: `/api/routines/${encodeURIComponent(id)}`, cookie: a.cookie, body: { enabled: false } });
  expect(paused.json.routine).toMatchObject({ enabled: false, nextRunAt: null });
  expect((await daemon.request({ method: 'DELETE', path: `/api/routines/${encodeURIComponent(id)}`, cookie: a.cookie, body: {} })).status).toBe(200);
  expect((await daemon.request({ path: `/api/routines/${encodeURIComponent(id)}`, cookie: a.cookie })).status).toBe(404);
}, 30_000);

it('revalidates the owner on dispatch and refuses foreign targets and host-scoped context', async () => {
  const foreignProject = randomUUID();
  expect((await daemon.request({ method: 'POST', path: '/api/projects', cookie: b.cookie, body: { id: foreignProject, name: 'B private' } })).status).toBe(200);
  expect((await routine(a, { target: { mode: 'reuse', projectId: foreignProject } })).status).toBe(404);
  expect((await routine(a, { context: { pluginIds: ['host-plugin'] } })).status).toBe(403);
  expect((await routine(a, { agentId: 'claude' })).status).toBe(403);
  expect((await routine(a, { schedule: { kind: 'daily', time: '25:99', timezone: 'UTC' } })).status).toBe(400);
  expect((await routine(a, { ownerAccountId: b.id })).status).toBe(400);

  const own = await routine(a, { name: 'Pilot check' });
  const id = own.json.routine.id as string;
  await pilot(a, false);
  try {
    const refused = await daemon.request({ method: 'POST', path: `/api/routines/${encodeURIComponent(id)}/run`, cookie: a.cookie, body: {} });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect((await runs(a, id)).json.runs).toEqual([]);
  } finally { await pilot(a, true); }
  // B has no linked personal account: the run is recorded as failed, never routed to another source.
  const bRoutine = await routine(b, { name: 'B routine' });
  const bRun = await daemon.request({ method: 'POST', path: `/api/routines/${encodeURIComponent(bRoutine.json.routine.id)}/run`, cookie: b.cookie, body: {} });
  expect(bRun.status, bRun.text).toBe(202);
  const failed = await until(() => runs(b, bRoutine.json.routine.id), (result) => result.json.runs[0]?.status === 'failed', 'refused routine run');
  expect(failed.json.runs[0].errorCode).toBe('MULTIUSER_PERSONAL_UNAVAILABLE');
}, 30_000);
