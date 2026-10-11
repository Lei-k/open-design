import { randomUUID } from 'node:crypto';
import { existsSync, renameSync, symlinkSync, readdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { syntheticGoodTranscript } from '../../src/critique/__fixtures__/adapters/synthetic-good.js';
import { cleanupIsolatedDataRoot, loadIsolatedServerModule, login, multiUserOptions, provisionAccounts,
  startMultiUserDaemon, type Principal, type StartedMultiUserDaemon } from './multiuser-harness.js';
const note = (line: string) => console.info(line);
const limits = vi.hoisted(() => ({ totalTimeoutMs: 120000, perRoundTimeoutMs: 120000 }));
vi.mock('@open-design/contracts/critique', async (original) => {
  const module = await original<typeof import('@open-design/contracts/critique')>();
  return { ...module, defaultCritiqueConfig: () => ({ ...module.defaultCritiqueConfig(), ...limits }) };
});

let daemon: StartedMultiUserDaemon; let root: string; let a: Principal; let admin: Principal;
let mode: 'good' | 'limit' | 'total_timeout' | 'per_round_timeout' = 'good';
const fixture: typeof fetch = async (_url, init) => {
  const text = syntheticGoodTranscript();
  if (mode !== 'good') {
    const second = text.indexOf('<ROUND n="2">');
    const first = text.slice(0, text.indexOf('</PANELIST>', second) + '</PANELIST>'.length);
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({ async start(controller) {
      controller.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: first })}\n\n`));
      if (mode === 'limit') {
        await new Promise((r) => setTimeout(r, 800));
        try { controller.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'x'.repeat(9 * 1024 * 1024) })}\n\n`)); } catch {}
      }
      init?.signal?.addEventListener('abort', () => { try { controller.error(new Error('aborted')); } catch {} }, { once: true });
    } });
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  }
  const output = [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }];
  return new Response([{ type: 'response.output_text.delta', delta: text },
    { type: 'response.completed', response: { output, usage: { input_tokens: 1, output_tokens: 1 } } }]
    .map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
};
async function settle(base: string) {
  for (let i = 0; i < 400; i++) {
    const s = await daemon.request({ path: base, cookie: a.cookie });
    if (s.status !== 200 || !['active', 'queued'].includes(s.json.status)) return s;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('run did not settle');
}
async function jury() {
  const id = randomUUID();
  const made = await daemon.request({ method: 'POST', path: '/api/projects', cookie: a.cookie, body: { id, name: 'P' } });
  const run = await daemon.request({ method: 'POST', path: `/api/projects/${id}/critique`, cookie: a.cookie,
    body: { conversationId: made.json.conversationId, agentId: 'openai-byok', message: 'Review' } });
  expect(run.status, run.text).toBe(202);
  return { projectId: id, conversationId: made.json.conversationId as string, runId: run.json.runId as string, base: `/api/projects/${id}/critique/${run.json.runId}` };
}
beforeAll(async () => {
  ({ dataRoot: root } = await loadIsolatedServerModule());
  daemon = await startMultiUserDaemon(multiUserOptions({ testCompanyOpenAIFetch: fixture }));
  const accounts = await provisionAccounts(daemon, ['p-a']); a = accounts.users[0]!; admin = accounts.admin;
  expect((await daemon.request({ method: 'PUT', path: '/api/multiuser/settings/provider-keys/openai', cookie: a.cookie,
    body: { revision: 0, apiKey: 'sk-probe-a-0123456789abcdef' } })).status).toBe(200);
}, 120_000);
afterAll(async () => { await daemon?.close(); cleanupIsolatedDataRoot(); });

it('R7 output-limit abort after round 1: parent status vs Jury status vs replay', async () => {
  mode = 'limit';
  try {
    const run = await jury();
    const s = await settle(run.base);
    const t = await daemon.request({ path: `${run.base}/transcript`, cookie: a.cookie });
    const tail = (t.json.events as Array<{ type: string; status?: string }>).slice(-2).map((e) => `${e.type}${e.status ? `(${e.status})` : ''}`);
    const art = await daemon.request({ path: `${run.base}/artifact`, cookie: a.cookie });
    const parent = await daemon.request({ path: `/api/runs/${run.runId}`, cookie: a.cookie });
    note(`[R7] parent=${s.json.status} output=${JSON.stringify(parent.json.output)} critique=${s.json.critique?.status} artifactAvailable=${s.json.critique?.artifactAvailable} replayTail=${tail.join(',')} artifact=${art.status}`);
    // A non-SHIP Jury outcome must not be reported as a succeeded run.
    expect(s.json.critique.status).toBe('interrupted');
    expect(s.json.status).toBe('canceled');
    expect(t.json.events.filter((e: { type: string }) => ['ship', 'interrupted', 'failed', 'degraded'].includes(e.type)).map((e: { type: string }) => e.type)).toEqual(['interrupted']);
    expect(s.json.critique.artifactAvailable).toBe(false); expect(art.status).toBe(404);
  } finally { mode = 'good'; }
}, 120_000);

it('R8 artifact route and run-directory creation refuse .. and symlink escapes', async () => {
  const one = await jury(); await settle(one.base);
  const two = await jury(); await settle(two.base);
  const db = new Database(path.join(root, 'app.sqlite'));
  const dir = (r: { projectId: string; runId: string }) => path.join(root, 'critique-artifacts', 'studio', a.id, r.projectId, r.runId);
  const orig = (db.prepare('SELECT artifact_path f FROM critique_runs WHERE id = ?').get(one.runId) as { f: string }).f;
  const results: Record<string, number> = {};
  try {
    for (const [label, file] of [
      ['dotdot-same', path.join(dir(one), '..', one.runId, 'artifact.html').replace(path.join(dir(one), '..', one.runId), `${dir(one)}/../${one.runId}`)],
      ['dotdot-other', `${dir(one)}/../../${two.projectId}/${two.runId}/artifact.html`],
      ['other-run', path.join(dir(two), 'artifact.html')],
      ['relative', `artifact.html`],
    ] as const) {
      db.prepare('UPDATE critique_runs SET artifact_path = ? WHERE id = ?').run(file, one.runId);
      results[label] = (await daemon.request({ path: `${one.base}/artifact`, cookie: a.cookie })).status;
    }
    db.prepare('UPDATE critique_runs SET artifact_path = ? WHERE id = ?').run(orig, one.runId);
    results.restored = (await daemon.request({ path: `${one.base}/artifact`, cookie: a.cookie })).status;
    // Swap run one's directory for a symlink to run two's directory.
    renameSync(dir(one), `${dir(one)}.moved`); symlinkSync(dir(two), dir(one));
    results['run-dir-symlink'] = (await daemon.request({ path: `${one.base}/artifact`, cookie: a.cookie })).status;
  } finally { db.close(); }
  // New Jury in a project whose private dir is pre-planted as a symlink to another project's dir.
  const id = randomUUID();
  const made = await daemon.request({ method: 'POST', path: '/api/projects', cookie: a.cookie, body: { id, name: 'Planted' } });
  const planted = path.join(root, 'critique-artifacts', 'studio', a.id, id);
  symlinkSync(path.join(root, 'critique-artifacts', 'studio', a.id, two.projectId), planted);
  const before = readdirSync(path.join(root, 'critique-artifacts', 'studio', a.id, two.projectId));
  const run = await daemon.request({ method: 'POST', path: `/api/projects/${id}/critique`, cookie: a.cookie,
    body: { conversationId: made.json.conversationId, agentId: 'openai-byok', message: 'Review' } });
  const s = await settle(`/api/projects/${id}/critique/${run.json.runId}`);
  const after = readdirSync(path.join(root, 'critique-artifacts', 'studio', a.id, two.projectId));
  const leaked = after.filter((x) => !before.includes(x));
  const leakedFiles = leaked.flatMap((x) => existsSync(path.join(root, 'critique-artifacts', 'studio', a.id, two.projectId, x)) ? readdirSync(path.join(root, 'critique-artifacts', 'studio', a.id, two.projectId, x)) : []);
  note(`[R8] ${JSON.stringify(results)} planted-project jury parent=${s.json.status} critique=${s.json.critique?.status ?? null} newEntriesInOtherProject=${JSON.stringify(leaked)} files=${JSON.stringify(leakedFiles)}`);
  for (const k of ['dotdot-same', 'dotdot-other', 'other-run', 'relative', 'run-dir-symlink']) expect(results[k]).toBe(404);
  expect(results.restored).toBe(200);
  expect(leakedFiles).toEqual([]);
}, 120_000);

it('R9 restart after a committed SHIP (parent still active) and before any terminal frame', async () => {
  const shipped = await jury(); await settle(shipped.base);
  const pending = await jury(); await settle(pending.base);
  await daemon.close();
  const db = new Database(path.join(root, 'app.sqlite'));
  try {
    // Crash right after the SHIP transaction: Jury row + replay committed, parent run still active.
    db.prepare("UPDATE multiuser_runs SET status = 'active', ended_at = NULL WHERE id = ?").run(shipped.runId);
    // Crash before SHIP: parent active, Jury running, no terminal frame, marker pending.
    db.prepare("UPDATE multiuser_runs SET status = 'active', ended_at = NULL, critique_reconciled = 0 WHERE id = ?").run(pending.runId);
    db.prepare("UPDATE critique_runs SET status = 'running', artifact_path = NULL WHERE id = ?").run(pending.runId);
    db.prepare("DELETE FROM studio_critique_events WHERE run_id = ? AND event IN ('critique.ship','critique.interrupted','critique.failed','critique.degraded')").run(pending.runId);
  } finally { db.close(); }
  daemon = await startMultiUserDaemon(multiUserOptions({ testCompanyOpenAIFetch: fixture }));
  a.cookie = await login(daemon, a.username, a.password);
  for (const [label, r] of [['shipped', shipped], ['pending', pending]] as const) {
    const s = await daemon.request({ path: r.base, cookie: a.cookie });
    const t = await daemon.request({ path: `${r.base}/transcript`, cookie: a.cookie });
    const terminals = (t.json.events as Array<{ type: string }>).filter((e) => ['ship', 'interrupted', 'failed', 'degraded'].includes(e.type)).map((e) => e.type);
    const art = await daemon.request({ path: `${r.base}/artifact`, cookie: a.cookie });
    note(`[R9 ${label}] parent=${s.json.status} critique=${s.json.critique?.status} terminals=${terminals.join(',')} artifact=${art.status}`);
    expect(terminals).toEqual([label === 'shipped' ? 'ship' : 'interrupted']);
    expect(s.json.status).toBe(label === 'shipped' ? 'succeeded' : 'canceled');
    expect(s.json.critique.status).toBe(label === 'shipped' ? 'shipped' : 'interrupted');
    expect(art.status).toBe(label === 'shipped' ? 200 : 404);
  }
}, 180_000);


it.each(['total_timeout', 'per_round_timeout'] as const)('R7 %s after round 1 fails with one terminal and no artifact', async (cause) => {
  mode = cause; limits.totalTimeoutMs = cause === 'total_timeout' ? 1500 : 120000;
  limits.perRoundTimeoutMs = cause === 'per_round_timeout' ? 1500 : 120000;
  try {
    const run = await jury(); const s = await settle(run.base);
    const t = await daemon.request({ path: `${run.base}/transcript`, cookie: a.cookie });
    expect(s.json.critique.rounds.length).toBeGreaterThanOrEqual(1);
    expect(s.json.status).toBe('failed'); expect(s.json.critique.status).toBe('timed_out');
    expect(t.json.events.filter((e: { type: string }) => ['ship', 'interrupted', 'failed', 'degraded'].includes(e.type)))
      .toEqual([{ type: 'failed', runId: run.runId, cause }]);
    expect(s.json.critique.artifactAvailable).toBe(false);
    expect((await daemon.request({ path: `${run.base}/artifact`, cookie: a.cookie })).status).toBe(404);
  } finally { mode = 'good'; limits.totalTimeoutMs = limits.perRoundTimeoutMs = 120000; }
});

it.each([['interrupted', 'active'], ['timed_out', 'active'], ['interrupted', 'succeeded'], ['timed_out', 'succeeded']] as const)('restart repairs legacy fallback SHIP %s / parent %s, end time and terminal replay', async (status, parentStatus) => {
  const run = await jury(); await settle(run.base); await daemon.close();
  const db = new Database(path.join(root, 'app.sqlite'));
  try {
    const frame = db.prepare("SELECT data FROM studio_critique_events WHERE run_id = ? AND event = 'critique.ship'").get(run.runId) as { data: string };
    db.prepare("UPDATE studio_critique_events SET data = ? WHERE run_id = ? AND event = 'critique.ship'").run(JSON.stringify({ ...JSON.parse(frame.data), status }), run.runId);
    db.prepare("UPDATE multiuser_runs SET status = ?, ended_at = NULL, critique_reconciled = 1 WHERE id = ?").run(parentStatus, run.runId);
    db.prepare('UPDATE critique_runs SET status = ?, artifact_path = NULL WHERE id = ?').run(status, run.runId);
  } finally { db.close(); }
  daemon = await startMultiUserDaemon(multiUserOptions({ testCompanyOpenAIFetch: fixture }));
  a.cookie = await login(daemon, a.username, a.password);
  const s = await daemon.request({ path: run.base, cookie: a.cookie });
  const t = await daemon.request({ path: `${run.base}/transcript`, cookie: a.cookie });
  expect(s.json.status, JSON.stringify(s.json)).toBe(status === 'interrupted' ? 'canceled' : 'failed');
  expect(s.json.critique.status).toBe(status); expect(s.json.critique.artifactAvailable).toBe(false);
  expect(t.json.events.filter((e: { type: string }) => ['ship', 'interrupted', 'failed', 'degraded'].includes(e.type)).map((e: { type: string }) => e.type))
    .toEqual([status === 'interrupted' ? 'interrupted' : 'failed']);
  const parent = await daemon.request({ path: `/api/runs/${run.runId}/events`, cookie: a.cookie });
  expect(parent.text.match(/^event: end$/gm)).toHaveLength(1);
  const check = new Database(path.join(root, 'app.sqlite'), { readonly: true });
  try { expect((check.prepare('SELECT ended_at FROM multiuser_runs WHERE id = ?').get(run.runId) as { ended_at: number | null }).ended_at).toBeTypeOf('number'); } finally { check.close(); }
});


it('boot recovery finalizes a published result through the normal finish path and closes company usage', async () => {
  admin.cookie = await login(daemon, admin.username, admin.password);
  const current = await daemon.request({ path: '/api/admin/pool/openai', cookie: admin.cookie });
  expect((await daemon.request({ method: 'PUT', path: '/api/admin/pool/openai', cookie: admin.cookie, body: {
    revision: current.json.provider.revision, enabled: true, capacity: 1, model: 'fixture-model', apiKey: 'sk-r2-company-fixture-0123456789',
  } })).status).toBe(200);
  const projectId = randomUUID();
  const made = await daemon.request({ method: 'POST', path: '/api/projects', cookie: a.cookie, body: { id: projectId, name: 'Company Jury' } });
  const started = await daemon.request({ method: 'POST', path: `/api/projects/${projectId}/critique`, cookie: a.cookie,
    body: { conversationId: made.json.conversationId, agentId: 'openai', message: 'Review' } });
  expect(started.status).toBe(202);
  const runId = started.json.runId as string; const base = `/api/projects/${projectId}/critique/${runId}`;
  await settle(base); await daemon.close();
  const db = new Database(path.join(root, 'app.sqlite'));
  try {
    // A previous writer repaired the parent status directly, leaving finish metadata pending.
    db.prepare("UPDATE multiuser_runs SET status = 'failed', ended_at = NULL, critique_reconciled = 0 WHERE id = ?").run(runId);
  } finally { db.close(); }
  const ledgerDb = new Database(path.join(root, 'worker-quota', 'worker-quota.sqlite'));
  try { ledgerDb.prepare("UPDATE quota_runs SET status = 'active', ended_at = NULL WHERE run_id = ?").run(runId); } finally { ledgerDb.close(); }
  daemon = await startMultiUserDaemon(multiUserOptions({ testCompanyOpenAIFetch: fixture }));
  a.cookie = await login(daemon, a.username, a.password);
  expect((await daemon.request({ path: base, cookie: a.cookie })).json.status).toBe('succeeded');
  const check = new Database(path.join(root, 'app.sqlite'), { readonly: true });
  try { expect((check.prepare('SELECT ended_at FROM multiuser_runs WHERE id = ?').get(runId) as { ended_at: number | null }).ended_at).toBeTypeOf('number'); } finally { check.close(); }
  const ledgerCheck = new Database(path.join(root, 'worker-quota', 'worker-quota.sqlite'), { readonly: true });
  try { expect(ledgerCheck.prepare('SELECT status, ended_at FROM quota_runs WHERE run_id = ?').get(runId)).toMatchObject({ status: 'finished', ended_at: expect.any(Number) }); } finally { ledgerCheck.close(); }
  const parentEvents = await daemon.request({ path: `/api/runs/${runId}/events`, cookie: a.cookie });
  expect(parentEvents.text).toContain('"status":"succeeded"');
  expect(parentEvents.text.match(/^event: end$/gm)).toHaveLength(1);
});
