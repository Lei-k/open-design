import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { cleanupIsolatedDataRoot, loadIsolatedServerModule, multiUserOptions, provisionAccounts,
  startMultiUserDaemon, type Principal, type StartedMultiUserDaemon } from './multiuser-harness.js';
import { PERSONAL_CODEX_MOCK, RUN_MOCK, linkCodex, until } from './personal-codex-helpers.js';

// #78: a controllable barrier inside the personal onDone artifact snapshot —
// the window where the child has already closed but the run is not terminal.
const barrier = vi.hoisted(() => ({ hold: false, entered: 0, release: [] as Array<() => void> }));
vi.mock('../../src/run-artifact-fs.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/run-artifact-fs.js')>();
  return { ...original, snapshotProjectArtifactsAsync: async (root: string) => {
    if (barrier.hold) { barrier.entered++; await new Promise<void>((resolve) => barrier.release.push(resolve)); }
    return original.snapshotProjectArtifactsAsync(root);
  } };
});

let daemon: StartedMultiUserDaemon;
let a: Principal;
let admin: Principal;
type Frame = { event: string; data: Record<string, any> };
const frames = (text: string): Frame[] => text.split('\n\n').filter((s) => s.includes('data:')).map((s) => ({
  event: /^event: (.*)$/m.exec(s)![1]!, data: JSON.parse(/^data: (.*)$/m.exec(s)![1]!),
}));
async function project() {
  const id = randomUUID();
  const result = await daemon.request({ method: 'POST', path: '/api/projects', cookie: a.cookie, body: { id, name: id } });
  return { projectId: id, conversationId: result.json.conversationId as string };
}
/** Bounded: a hung cancel fails the test instead of the suite. */
async function cancel(id: string) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([daemon.request({ method: 'POST', path: `/api/runs/${id}/cancel`, cookie: a.cookie }),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('cancel request hung')), 3_000); })]);
  } finally { clearTimeout(timer); }
}
beforeAll(async () => {
  const { dataRoot } = await loadIsolatedServerModule();
  daemon = await startMultiUserDaemon(multiUserOptions({ testPersonalCodexAppServer: PERSONAL_CODEX_MOCK, testMockAgentScript: RUN_MOCK }));
  const accounts = await provisionAccounts(daemon, ['cancel-a']);
  [a] = accounts.users as [Principal]; admin = accounts.admin;
  await linkCodex(daemon, dataRoot, a, 'cancel-a@example.test');
}, 120_000);
afterAll(async () => {
  barrier.hold = false; for (const release of barrier.release.splice(0)) release();
  await daemon?.close(); cleanupIsolatedDataRoot();
});

it('answers a cancel that arrives after child close but before the personal run settles, once and idempotently (#78)', async () => {
  barrier.hold = true;
  const made = await daemon.request({ method: 'POST', path: '/api/runs', cookie: a.cookie,
    body: { ...await project(), agentId: 'codex', executionSource: 'personal_subscription', message: 'settling' } });
  expect(made.status).toBe(202);
  const id = made.json.runId as string;
  await until(() => barrier.entered, (n) => n > 0, 'artifact snapshot entered');
  try {
    const first = await cancel(id);
    const second = await cancel(id);
    expect([first.status, first.json.status]).toEqual([200, 'canceled']);
    expect(second.json).toEqual(first.json);
  } finally { barrier.hold = false; for (const release of barrier.release.splice(0)) release(); }
  // The settling handler must not overwrite the canceled terminal state afterwards.
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect((await daemon.request({ path: `/api/runs/${id}`, cookie: a.cookie })).json.status).toBe('canceled');
  const all = frames((await daemon.request({ path: `/api/runs/${id}/events`, cookie: a.cookie })).text);
  expect(all.filter((e) => e.event === 'end').map((e) => e.data.status)).toEqual(['canceled']);
  expect(all.some((e) => e.event === 'error')).toBe(false);
});

it('answers repeated cancels of an active company/test-mock run boundedly with one terminal (#78)', async () => {
  await daemon.request({ method: 'PUT', path: '/api/admin/pool/providers/test-mock', cookie: admin.cookie, body: { capacity: 1 } });
  const made = await daemon.request({ method: 'POST', path: '/api/runs', cookie: a.cookie,
    body: { ...await project(), agentId: 'test-mock', message: 'company', delayMs: 2000 } });
  const id = made.json.run.id as string;
  await until(async () => (await daemon.request({ path: `/api/runs/${id}`, cookie: a.cookie })).json.status, (s) => s === 'running', 'running');
  const [first, second] = await Promise.all([cancel(id), cancel(id)]);
  const third = await cancel(id);
  for (const response of [first, second, third]) expect(response.json.status).toBe('canceled');
  const all = frames((await daemon.request({ path: `/api/runs/${id}/events`, cookie: a.cookie })).text);
  expect(all.filter((e) => e.event === 'end')).toHaveLength(1);
});
