import { mkdirSync, rmSync } from 'node:fs';
import http, { type IncomingMessage } from 'node:http';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { WorkerQuotaLedger } from '../../src/storage/worker-quota-ledger.js';
import {
  cleanupIsolatedDataRoot, loadIsolatedServerModule, multiUserOptions, provisionAccounts,
  startMultiUserDaemon, type Principal, type StartedMultiUserDaemon,
} from './multiuser-harness.js';

let daemon: StartedMultiUserDaemon;
let admin: Principal;
let alice: Principal;
let bob: Principal;
let carol: Principal;
let dataRoot: string;
let poolTime = Date.now();
const projects = new Map<string, { id: string; conversationId: string }>();
const options = () => multiUserOptions({ testMockAgentScript: path.resolve('../..', 'mocks/run-isolation-agent.ts'), poolClock: () => poolTime });

async function capacity(slots: number) {
  const res = await daemon.request({ method: 'PUT', path: '/api/admin/pool/providers/test-mock', cookie: admin.cookie, body: { capacity: slots } });
  expect(res.status, res.text).toBe(200);
}

async function run(user: Principal, label: string, delayMs = 2000) {
  const project = projects.get(user.id)!;
  const res = await daemon.request({ method: 'POST', path: '/api/runs', cookie: user.cookie,
    body: { projectId: project.id, conversationId: project.conversationId, agentId: 'test-mock', message: label, delayMs } });
  expect(res.status, res.text).toBe(202);
  return res.json.run.id as string;
}

async function status(user: Principal, id: string): Promise<string> {
  const res = await daemon.request({ path: `/api/runs/${id}`, cookie: user.cookie });
  expect(res.status, res.text).toBe(200);
  return res.json.status;
}

async function events(user: Principal, id: string) {
  return daemon.request({ path: `/api/runs/${id}/events`, cookie: user.cookie });
}

function terminalLedgerRow(user: Principal, runId: string) {
  const ledger = new WorkerQuotaLedger({ dataRoot, clock: () => poolTime });
  try {
    expect(ledger.start({ actorId: user.id, runId, projectId: projects.get(user.id)!.id, providerId: 'test-mock' }).status).toBe('started');
    ledger.finish(user.id, runId);
  } finally { ledger.close(); }
}

beforeAll(async () => {
  delete process.env.OD_API_TOKEN;
  delete process.env.OD_DISABLE_API_AUTH;
  ({ dataRoot } = await loadIsolatedServerModule());
  daemon = await startMultiUserDaemon(options());
  const accounts = await provisionAccounts(daemon, ['review-alice', 'review-bob', 'review-carol']);
  admin = accounts.admin;
  [alice, bob, carol] = accounts.users as [Principal, Principal, Principal];
  for (const user of [alice, bob, carol]) {
    const id = crypto.randomUUID();
    const res = await daemon.request({ method: 'POST', path: '/api/projects', cookie: user.cookie, body: { id, name: id } });
    expect(res.status, res.text).toBe(200);
    projects.set(user.id, { id, conversationId: res.json.conversationId });
  }
}, 120_000);

afterEach(async () => {
  await capacity(0);
  for (const user of [alice, bob, carol]) {
    const list = await daemon.request({ path: '/api/runs', cookie: user.cookie });
    for (const run of list.json.runs as Array<{ id: string; status: string }>) {
      if (run.status === 'queued' || run.status === 'running') {
        await daemon.request({ method: 'POST', path: `/api/runs/${run.id}/cancel`, cookie: user.cookie });
      }
    }
  }
  const db = new Database(path.join(dataRoot, 'app.sqlite'));
  try {
    db.prepare("DELETE FROM multiuser_pool_config WHERE key = 'last-actor'").run();
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'multiuser_pool_turns'").get()) {
      db.prepare('DELETE FROM multiuser_pool_turns').run();
    }
  } finally { db.close(); }
});

afterAll(async () => { await daemon?.close(); cleanupIsolatedDataRoot(); });

it('F1 rotates all three backlogged accounts before giving anyone a second turn', async () => {
  await capacity(0);
  const a1 = await run(alice, 'A1');
  const a2 = await run(alice, 'A2');
  const b1 = await run(bob, 'B1');
  await run(bob, 'B2');
  const c1 = await run(carol, 'C1');
  await capacity(1);
  await events(alice, a1);
  expect(await status(bob, b1)).toBe('running');
  await events(bob, b1);
  expect(await status(carol, c1)).toBe('running');
  expect(await status(alice, a2)).toBe('queued');
});

it('F1 preserves the three-account rotation over a restart', async () => {
  await capacity(0);
  const a1 = await run(alice, 'restart-A1');
  const a2 = await run(alice, 'restart-A2');
  const b1 = await run(bob, 'restart-B1');
  await run(bob, 'restart-B2');
  const c1 = await run(carol, 'restart-C1');
  await capacity(1);
  await events(alice, a1);
  expect(await status(bob, b1)).toBe('running');
  await capacity(0);
  await events(bob, b1);
  await daemon.close();
  daemon = await startMultiUserDaemon(options());
  await capacity(1);
  expect(await status(carol, c1)).toBe('running');
  expect(await status(alice, a2)).toBe('queued');
});

it('F2 closes a killed worker before downtime can be charged', async () => {
  await capacity(1);
  const id = await run(alice, 'clean-shutdown');
  expect(await status(alice, id)).toBe('running');
  await daemon.close();
  poolTime += 5 * 60_000;
  daemon = await startMultiUserDaemon(options());
  expect(await status(alice, id)).toBe('canceled');
  const summary = await daemon.request({ path: '/api/admin/pool', cookie: admin.cookie });
  expect(summary.json.users[alice.id].usedMs).toBe(0);
});

it('F2 still conservatively charges an unclosed crash entry through restart', async () => {
  await capacity(0);
  const id = await run(alice, 'simulated-crash');
  await daemon.close();
  const ledger = new WorkerQuotaLedger({ dataRoot, clock: () => poolTime });
  try {
    expect(ledger.start({ actorId: alice.id, runId: id, projectId: projects.get(alice.id)!.id,
      providerId: 'test-mock' }).status).toBe('started');
  } finally { ledger.close(); }
  const db = new Database(path.join(dataRoot, 'app.sqlite'));
  try { db.prepare("UPDATE multiuser_runs SET status = 'active' WHERE id = ?").run(id); }
  finally { db.close(); }
  poolTime += 5 * 60_000;
  daemon = await startMultiUserDaemon(options());
  expect(await status(alice, id)).toBe('failed');
  const summary = await daemon.request({ path: '/api/admin/pool', cookie: admin.cookie });
  expect(summary.json.users[alice.id].usedMs).toBe(5 * 60_000);
});

it('F3 drains a queued SSE stream before server close waits for it', async () => {
  await capacity(0);
  const id = await run(alice, 'queued-stream');
  const streamRequest = http.get(`${daemon.baseUrl}/api/runs/${id}/events`, { headers: { cookie: alice.cookie } });
  const stream = await new Promise<IncomingMessage>((resolve, reject) => {
    streamRequest.once('response', resolve);
    streamRequest.once('error', reject);
  });
  stream.resume();
  const closing = daemon.close();
  let timer: NodeJS.Timeout | undefined;
  const closedWithinBound = await Promise.race([
    closing.then(() => true),
    new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 1500); }),
  ]);
  if (timer) clearTimeout(timer);
  stream.destroy();
  streamRequest.destroy();
  await closing;
  daemon = await startMultiUserDaemon(options());
  expect(closedWithinBound).toBe(true);
});

it('F4 reconciles a queued row whose ledger entry was already closed before restart', async () => {
  await capacity(0);
  const id = await run(alice, 'reconcile-closed-ledger');
  await daemon.close();
  terminalLedgerRow(alice, id);
  daemon = await startMultiUserDaemon(options());
  expect(await status(alice, id)).toBe('failed');
  // #79: the startup replay settles like any other terminal — a company code, error then end, once.
  expect(terminalFrames((await events(alice, id)).text)).toEqual([['error', 'MULTIUSER_RUN_ADMISSION_REPLAYED'], ['end', 'failed']]);
  const transcript = await daemon.request({ path: `/api/projects/${projects.get(alice.id)!.id}/conversations/${projects.get(alice.id)!.conversationId}/messages`, cookie: alice.cookie });
  expect(transcript.json.messages.find((m: { runId?: string }) => m.runId === id)?.runStatus).toBe('failed');
});

it('F4 fails a replayed queued row and continues dispatching another account', async () => {
  await capacity(0);
  const poisoned = await run(alice, 'replayed-ledger');
  const healthy = await run(bob, 'healthy-next');
  terminalLedgerRow(alice, poisoned);
  await capacity(1);
  expect(await status(alice, poisoned)).toBe('failed');
  expect(await status(bob, healthy)).toBe('running');
  expect(terminalFrames((await events(alice, poisoned)).text)).toEqual([['error', 'MULTIUSER_RUN_ADMISSION_REPLAYED'], ['end', 'failed']]);
});

it('F6 reports a reasonless company/test-mock failure with a company code, never the personal one (#79)', async () => {
  await capacity(0);
  const id = await run(alice, 'reasonless-failure');
  rmSync(path.join(dataRoot, 'projects', projects.get(alice.id)!.id), { recursive: true, force: true });
  try {
    await capacity(1);
    expect(await status(alice, id)).toBe('failed');
    expect(terminalFrames((await events(alice, id)).text)).toEqual([['error', 'MULTIUSER_RUN_FAILED'], ['end', 'failed']]);
  } finally { mkdirSync(path.join(dataRoot, 'projects', projects.get(alice.id)!.id), { recursive: true, mode: 0o700 }); }
});

const sse = (text: string) => text.split('\n\n').filter((s) => s.includes('data:')).map((s) => ({
  event: /^event: (.*)$/m.exec(s)![1]!, data: JSON.parse(/^data: (.*)$/m.exec(s)![1]!) as Record<string, any>,
}));
const terminalFrames = (text: string) => sse(text).filter((e) => e.event === 'error' || e.event === 'end').map((e) => {
  if (e.event === 'error') expect(e.data.message).toBe(e.data.error.code);
  return [e.event, e.event === 'error' ? e.data.error.code : e.data.status];
});

it('F5 recovers an active row restored without its ledger entry; start, other accounts and billing are unaffected (#72)', async () => {
  await capacity(0);
  const damaged = await run(alice, 'restored-without-ledger');
  const healthy = await run(bob, 'healthy-after-restore');
  await daemon.close();
  const db = new Database(path.join(dataRoot, 'app.sqlite'));
  try {
    db.prepare("UPDATE multiuser_runs SET status = 'active' WHERE id = ?").run(damaged);
    db.prepare("UPDATE multiuser_pool_config SET value = '1' WHERE key = 'test-mock-capacity'").run();
  } finally { db.close(); }
  daemon = await startMultiUserDaemon(options());
  expect(await status(alice, damaged)).toBe('failed');
  expect(await status(bob, healthy)).toBe('running');
  const terminal = sse((await events(alice, damaged)).text).filter((e) => e.event === 'error' || e.event === 'end');
  expect(terminal.map((e) => [e.event, e.data.error?.code ?? e.data.status])).toEqual([['error', 'DAEMON_RESTARTED'], ['end', 'failed']]);
  const check = new Database(path.join(dataRoot, 'app.sqlite'), { readonly: true });
  try {
    expect(check.prepare('SELECT code FROM multiuser_recovery_issues WHERE run_id = ?').all(damaged)).toEqual([{ code: 'MULTIUSER_LEDGER_ENTRY_MISSING' }]);
  } finally { check.close(); }
  await capacity(0);
  await daemon.request({ method: 'POST', path: `/api/runs/${healthy}/cancel`, cookie: bob.cookie });
  await daemon.close();
  const ledger = new WorkerQuotaLedger({ dataRoot, clock: () => poolTime });
  try { expect(ledger.entry(damaged)).toBeUndefined(); } finally { ledger.close(); }
  daemon = await startMultiUserDaemon(options());
  expect(sse((await events(alice, damaged)).text).filter((e) => e.event === 'error' || e.event === 'end')).toHaveLength(2);
});
