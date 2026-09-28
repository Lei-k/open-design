import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import Database from 'better-sqlite3';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkerQuotaLedger as Ledger } from '../../src/storage/worker-quota-ledger.js';

const MINUTE = 60_000;
const WINDOW = 7 * 24 * 60 * MINUTE;
const BUDGET = 120 * MINUTE;
const EPOCH = 1_800_000_000_000;
const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'od-quota-ledger-tests-'));
const modulePath = new URL('../../src/storage/worker-quota-ledger.ts', import.meta.url).href;
let WorkerQuotaLedger: typeof Ledger;
let dataRoot: string;
let now: number;
let ledger: Ledger;
let stores: Ledger[];
let workers: Worker[];

function open() {
  const store = new WorkerQuotaLedger({ dataRoot, clock: () => now });
  stores.push(store);
  return store;
}

function input(actorId = 'alice', runId = 'run-1') {
  return { actorId, runId, projectId: 'project-1', providerId: 'synthetic-provider' };
}

beforeEach(async () => {
  stores = [];
  workers = [];
  // Runtime import keeps the RED phase observable per test when capability is absent.
  ({ WorkerQuotaLedger } = await import(modulePath));
  mkdirSync(fixtureRoot, { recursive: true });
  dataRoot = mkdtempSync(path.join(fixtureRoot, 'case-'));
  now = EPOCH;
  ledger = open();
});

afterEach(async () => {
  await Promise.all(workers.map(worker => worker.terminate()));
  for (const store of stores.reverse()) store.close();
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true });
});
afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));

describe('per-user active worker-time quota', () => {
  it('charges only time between explicit worker start and stop, aggregating projects/providers', () => {
    now += WINDOW; // Waiting before dispatch is free.
    expect(ledger.balance('alice')).toEqual({
      usedMs: 0, remainingMs: BUDGET, budgetMs: BUDGET, windowMs: WINDOW, activeRunId: null,
    });
    expect(ledger.start(input()).status).toBe('started');
    now += 30 * MINUTE;
    expect(ledger.finish('alice', 'run-1')).toMatchObject({ status: 'finished', chargedMs: 30 * MINUTE });
    now += 20 * MINUTE;
    ledger.start({ ...input('alice', 'run-2'), projectId: 'project-2', providerId: 'another-provider' });
    now += 90 * MINUTE;
    ledger.finish('alice', 'run-2');
    expect(ledger.balance('alice')).toMatchObject({ usedMs: BUDGET, remainingMs: 0, activeRunId: null });
    expect(ledger.start(input('alice', 'run-3'))).toEqual({ status: 'denied', reason: 'quota_exhausted' });
  });

  it('admits below the exact boundary, charges overshoot in full, and never cuts an active run', () => {
    ledger.start(input());
    now += BUDGET - 1;
    ledger.finish('alice', 'run-1');
    expect(ledger.start(input('alice', 'run-2')).status).toBe('started');
    now += 40 * MINUTE;
    expect(ledger.balance('alice')).toMatchObject({ usedMs: BUDGET - 1 + 40 * MINUTE, remainingMs: 0, activeRunId: 'run-2' });
    expect(ledger.start(input('alice', 'run-3'))).toEqual({ status: 'denied', reason: 'active_run' });
    expect(ledger.finish('alice', 'run-2')).toMatchObject({ chargedMs: 40 * MINUTE });
    expect(ledger.start(input('alice', 'run-3'))).toEqual({ status: 'denied', reason: 'quota_exhausted' });
  });

  it('cannot borrow another actor\'s unused budget or share their concurrency slot', () => {
    ledger.start(input());
    expect(ledger.start(input('bob', 'bob-run')).status).toBe('started');
    now += BUDGET;
    ledger.finish('alice', 'run-1');
    expect(ledger.balance('ALICE')).toMatchObject({ usedMs: 0, activeRunId: null });
    expect(ledger.start(input('alice', 'next'))).toEqual({ status: 'denied', reason: 'quota_exhausted' });
    expect(ledger.balance('bob')).toMatchObject({ usedMs: BUDGET, activeRunId: 'bob-run' });
    expect(ledger.start(input('carol', 'carol-run')).status).toBe('started');
  });

  it('uses opaque exact identifiers without normalization or SQL interpolation', () => {
    const actorId = "../alice'; DROP TABLE quota_runs; --";
    ledger.start(input(actorId));
    now += 17;
    ledger.finish(actorId, 'run-1');
    expect(ledger.balance(actorId).usedMs).toBe(17);
    expect(ledger.balance('alice').usedMs).toBe(0);
    expect(readdirSync(dataRoot)).toEqual(['worker-quota']);
    expect(readdirSync(path.join(dataRoot, 'worker-quota')).every(name => name.startsWith('worker-quota.sqlite'))).toBe(true);
  });

  it('replays starts without resetting time or admitting a second execution, including terminal runs', () => {
    const started = ledger.start(input());
    now += MINUTE;
    expect(ledger.start(input())).toEqual({ ...started, status: 'replayed' });
    const ended = ledger.finish('alice', 'run-1');
    now += MINUTE;
    expect(ledger.start(input())).toEqual({ status: 'replayed', run: ended });
    expect(ledger.balance('alice').usedMs).toBe(MINUTE);
  });

  it.each(['finish', 'cancel'] as const)('%s is idempotent and the first terminal result wins', method => {
    ledger.start(input());
    now += 37;
    const ended = ledger[method]('alice', 'run-1');
    expect(ended).toMatchObject({ status: method === 'finish' ? 'finished' : 'cancelled', chargedMs: 37 });
    now += MINUTE;
    expect(ledger.finish('alice', 'run-1')).toEqual(ended);
    expect(ledger.cancel('alice', 'run-1')).toEqual(ended);
    expect(ledger.balance('alice')).toMatchObject({ usedMs: 37, activeRunId: null });
    expect(ledger.start(input('alice', 'next')).status).toBe('started');
  });

  it.each(['actorId', 'projectId', 'providerId'] as const)('rejects rebinding an existing run\'s %s', field => {
    ledger.start(input());
    expect(() => ledger.start({ ...input(), [field]: 'different' })).toThrow('run_conflict');
    expect(ledger.balance('alice').activeRunId).toBe('run-1');
    expect(ledger.balance('different').usedMs).toBe(0);
  });

  it.each(['finish', 'cancel'] as const)('%s rejects unknown runs and another actor without mutation', method => {
    ledger.start(input());
    now += MINUTE;
    expect(() => ledger[method]('bob', 'run-1')).toThrow('run_not_found');
    expect(() => ledger[method]('alice', 'missing')).toThrow('run_not_found');
    expect(ledger.balance('alice')).toMatchObject({ usedMs: MINUTE, activeRunId: 'run-1' });
    expect(ledger.balance('bob').usedMs).toBe(0);
  });

  it('clips a completed span at the moving left boundary, including exact expiration', () => {
    ledger.start(input());
    now += BUDGET;
    ledger.finish('alice', 'run-1');
    now = EPOCH + WINDOW;
    expect(ledger.start(input('alice', 'next'))).toEqual({ status: 'denied', reason: 'quota_exhausted' });
    now += 1;
    expect(ledger.balance('alice').usedMs).toBe(BUDGET - 1);
    now = EPOCH + WINDOW + BUDGET - 1;
    expect(ledger.balance('alice').usedMs).toBe(1);
    now += 1;
    expect(ledger.balance('alice').usedMs).toBe(0);
    expect(ledger.start(input('alice', 'next')).status).toBe('started');
  });

  it('counts rolling overlap of spans longer than seven days while retaining full lifetime charge', () => {
    ledger.start(input());
    now += WINDOW * 2;
    expect(ledger.balance('alice')).toMatchObject({ usedMs: WINDOW, remainingMs: 0, activeRunId: 'run-1' });
    expect(ledger.finish('alice', 'run-1')).toMatchObject({ chargedMs: WINDOW * 2 });
    now += WINDOW / 2;
    expect(ledger.balance('alice').usedMs).toBe(WINDOW / 2);
    now += WINDOW / 2;
    expect(ledger.balance('alice').usedMs).toBe(0);
  });

  it('persists active ownership, completed charge, and idempotency across reopen', () => {
    ledger.start(input());
    now += MINUTE;
    ledger.close();
    ledger = open();
    expect(ledger.balance('alice')).toMatchObject({ usedMs: MINUTE, activeRunId: 'run-1' });
    expect(ledger.start(input('alice', 'next'))).toEqual({ status: 'denied', reason: 'active_run' });
    const ended = ledger.cancel('alice', 'run-1');
    ledger.close();
    ledger = open();
    now += MINUTE;
    expect(ledger.finish('alice', 'run-1')).toEqual(ended);
    expect(ledger.start(input())).toEqual({ status: 'replayed', run: ended });
    expect(ledger.balance('alice').usedMs).toBe(MINUTE);
  });

  it('keeps balance read-only and counts active time from a consistent snapshot', () => {
    ledger.start(input());
    const directory = path.join(dataRoot, 'worker-quota');
    const snapshot = () => readdirSync(directory).filter(name => !name.endsWith('-shm'))
      .map(name => [name, readFileSync(path.join(directory, name)).toString('hex')]);
    const before = snapshot();
    now += MINUTE;
    expect(ledger.balance('alice').usedMs).toBe(MINUTE);
    expect(snapshot()).toEqual(before);
  });

  it.each([NaN, Infinity, -Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])('fails closed on clock %s', invalid => {
    ledger.start(input());
    now = invalid;
    expect(() => ledger.start(input('bob', 'other'))).toThrow('invalid_clock');
    expect(() => ledger.finish('alice', 'run-1')).toThrow('invalid_clock');
    expect(() => ledger.cancel('alice', 'run-1')).toThrow('invalid_clock');
    expect(() => ledger.balance('alice')).toThrow('invalid_clock');
    now = EPOCH + 10;
    expect(ledger.balance('bob')).toMatchObject({ usedMs: 0, activeRunId: null });
    expect(ledger.finish('alice', 'run-1').chargedMs).toBe(10);
  });

  it('rejects rollback across actors, denied admissions, two connections, and restart', () => {
    ledger.start(input());
    now += MINUTE;
    ledger.start(input('alice', 'blocked')); // Valid denial still observes the clock.
    const second = open();
    now -= 1;
    expect(() => second.start(input('bob', 'other'))).toThrow('clock_rollback');
    expect(() => ledger.finish('alice', 'run-1')).toThrow('clock_rollback');
    ledger.close();
    ledger = open();
    expect(() => ledger.cancel('alice', 'run-1')).toThrow('clock_rollback');
    expect(() => ledger.balance('alice')).toThrow('clock_rollback');
    now += 1;
    expect(ledger.finish('alice', 'run-1').chargedMs).toBe(MINUTE);
  });

  it('rejects local clock rollback after a read without writing the balance snapshot', () => {
    ledger.start(input());
    now += MINUTE;
    ledger.balance('alice');
    now -= 1;
    expect(() => ledger.balance('alice')).toThrow('clock_rollback');
    expect(() => ledger.finish('alice', 'run-1')).toThrow('clock_rollback');
    now += 1;
    expect(ledger.finish('alice', 'run-1').chargedMs).toBe(MINUTE);
  });

  it('rejects malformed Unicode instead of letting SQLite merge distinct opaque identities', () => {
    expect(() => ledger.start(input('\ud800'))).toThrow('invalid_identifier');
    expect(ledger.start(input('\ufffd')).status).toBe('started');
    expect(() => ledger.finish('\ud800', 'run-1')).toThrow('invalid_identifier');
    expect(ledger.balance('\ufffd').activeRunId).toBe('run-1');
  });

  it('rolls back a failed database write without leaving an admission or a partial clock advance', () => {
    const db = new Database(path.join(dataRoot, 'worker-quota', 'worker-quota.sqlite'));
    try {
      db.exec("CREATE TRIGGER reject_start BEFORE INSERT ON quota_runs BEGIN SELECT RAISE(ABORT, 'test_write_failure'); END");
      expect(() => ledger.start(input())).toThrow('test_write_failure');
      expect(ledger.balance('alice').activeRunId).toBeNull();
      expect(db.prepare('SELECT observed_at FROM quota_clock').get()).toEqual({ observed_at: 0 });
      db.exec('DROP TRIGGER reject_start');
      expect(ledger.start(input()).status).toBe('started');
    } finally { db.close(); }
  });

  it('accepts zero epoch and zero duration without rounding or negative balance', () => {
    now = 0;
    ledger.start(input());
    expect(ledger.finish('alice', 'run-1').chargedMs).toBe(0);
    expect(ledger.balance('alice').usedMs).toBe(0);
  });

  it.each(['actorId', 'runId', 'projectId', 'providerId'] as const)('rejects invalid %s without reserving a slot', field => {
    for (const invalid of ['', '  ', 'x'.repeat(257), 'a\0b', null, 12, {}, undefined]) {
      expect(() => ledger.start({ ...input(), [field]: invalid } as ReturnType<typeof input>)).toThrow('invalid_identifier');
    }
    expect(ledger.balance('alice').activeRunId).toBeNull();
    expect(ledger.start(input()).status).toBe('started');
  });

  it('validates identifiers on reads and both terminal operations', () => {
    for (const invalid of ['', '  ', 'a\0b', 'x'.repeat(257)]) {
      expect(() => ledger.balance(invalid)).toThrow('invalid_identifier');
      for (const method of ['finish', 'cancel'] as const) {
        expect(() => ledger[method](invalid, 'run-1')).toThrow('invalid_identifier');
        expect(() => ledger[method]('alice', invalid)).toThrow('invalid_identifier');
      }
    }
  });

  it.each(['', 'relative-root'])('requires an explicit absolute data root (%s)', dataRoot => {
    expect(() => new WorkerQuotaLedger({ dataRoot })).toThrow('invalid_data_root');
  });

  it('fails closed on an unsupported stored schema version', () => {
    ledger.close();
    const db = new Database(path.join(dataRoot, 'worker-quota', 'worker-quota.sqlite'));
    try { db.pragma('user_version = 999'); } finally { db.close(); }
    expect(() => open()).toThrow('unsupported_quota_schema');
  });

  it('persists audited budget overrides atomically and rejects invalid values', () => {
    ledger.setBudgetMs('alice', MINUTE, 'admin-1');
    expect(ledger.balance('alice').budgetMs).toBe(MINUTE);
    expect(() => ledger.setBudgetMs('alice', -1, 'admin-1')).toThrow('invalid_budget');
    const db = new Database(path.join(dataRoot, 'worker-quota', 'worker-quota.sqlite'));
    try {
      expect(db.prepare('SELECT admin_actor_id, actor_id, budget_ms FROM quota_audit').all())
        .toEqual([{ admin_actor_id: 'admin-1', actor_id: 'alice', budget_ms: MINUTE }]);
      expect(() => db.prepare('DELETE FROM quota_audit').run()).toThrow(/append only/);
    } finally { db.close(); }
    ledger.close();
    ledger = open();
    expect(ledger.balance('alice').budgetMs).toBe(MINUTE);
  });

  it('migrates the original unwired ledger schema without losing runs', () => {
    ledger.start(input());
    ledger.close();
    const db = new Database(path.join(dataRoot, 'worker-quota', 'worker-quota.sqlite'));
    try {
      db.exec('DROP TABLE quota_audit; DROP TABLE quota_overrides; PRAGMA user_version = 1;');
    } finally { db.close(); }
    ledger = open();
    expect(ledger.start(input()).status).toBe('replayed');
    ledger.setBudgetMs('alice', MINUTE, 'admin-1');
    expect(ledger.balance('alice').budgetMs).toBe(MINUTE);
  });
});

describe('SQLite cross-connection admission', () => {
  async function race(actions: Array<{ method: 'start' | 'finish' | 'cancel'; runId: string }>) {
    const gate = new SharedArrayBuffer(4);
    const running = actions.map(action => {
      const worker = new Worker(new URL('./fixtures/worker-quota-racer.ts', import.meta.url), {
        workerData: { dataRoot, now, gate, action, input: input('alice', action.runId) },
        execArgv: ['--experimental-strip-types'],
      });
      workers.push(worker);
      return { worker, ready: once(worker, 'message') };
    });
    expect(await Promise.all(running.map(item => item.ready))).toEqual(actions.map(() => ['ready']));
    const results = running.map(({ worker }) => once(worker, 'message'));
    Atomics.store(new Int32Array(gate), 0, 1);
    Atomics.notify(new Int32Array(gate), 0);
    return (await Promise.all(results)).map(([result]) => result);
  }

  it('admits exactly one of two simultaneous distinct starts for one actor', async () => {
    const results = await race([{ method: 'start', runId: 'one' }, { method: 'start', runId: 'two' }]);
    expect(results.map(result => result.status).sort()).toEqual(['denied', 'started']);
    expect(results.find(result => result.status === 'denied')).toEqual({ status: 'denied', reason: 'active_run' });
    expect(['one', 'two']).toContain(ledger.balance('alice').activeRunId);
  });

  it('admits a simultaneous duplicate only once and returns a replay to the loser', async () => {
    const results = await race([{ method: 'start', runId: 'one' }, { method: 'start', runId: 'one' }]);
    expect(results.map(result => result.status).sort()).toEqual(['replayed', 'started']);
    expect(results[0].run).toEqual(results[1].run);
  });

  it('serializes competing finish/cancel without double charge or a changing terminal result', async () => {
    ledger.start(input());
    now += MINUTE;
    const results = await race([{ method: 'finish', runId: 'run-1' }, { method: 'cancel', runId: 'run-1' }]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0].chargedMs).toBe(MINUTE);
    expect(ledger.balance('alice')).toMatchObject({ usedMs: MINUTE, activeRunId: null });
  });
});

describe.skipIf(process.platform === 'win32')('quota ledger filesystem privacy', () => {
  const filenames = ['worker-quota.sqlite', 'worker-quota.sqlite-wal', 'worker-quota.sqlite-shm'];
  const privateDir = () => path.join(dataRoot, 'worker-quota');
  const modes = () => filenames.map(name => lstatSync(path.join(privateDir(), name)).mode & 0o777);

  function resetRoot() {
    ledger.close();
    rmSync(dataRoot, { recursive: true, force: true });
    mkdirSync(dataRoot, { mode: 0o755 });
    chmodSync(dataRoot, 0o755);
  }

  it('creates a 0700 child and 0600 DB/WAL/SHM under umask 022 and a traversable root', () => {
    resetRoot();
    const previousUmask = process.umask(0o022);
    try {
      ledger = open();
      ledger.start(input());
      // Inspect every actual file so RED exposes the old 0644 modes, too.
      const files = readdirSync(dataRoot, { recursive: true }).map(String)
        .filter(name => filenames.includes(path.basename(name)));
      expect(files.map(name => lstatSync(path.join(dataRoot, name)).mode & 0o777)).toEqual([0o600, 0o600, 0o600]);
      expect(lstatSync(privateDir()).mode & 0o777).toBe(0o700);
      expect(lstatSync(privateDir()).uid).toBe(process.getuid!());
      expect(lstatSync(dataRoot).mode & 0o777).toBe(0o755);
      expect(modes()).toEqual([0o600, 0o600, 0o600]);
    } finally { process.umask(previousUmask); }
  });

  it('repairs a pre-created 0755 child and 0644 DB before SQLite creates its sidecars', () => {
    resetRoot();
    mkdirSync(privateDir(), { mode: 0o755 });
    chmodSync(privateDir(), 0o755);
    const file = path.join(privateDir(), filenames[0]!);
    writeFileSync(file, '');
    chmodSync(file, 0o644);
    ledger = open();
    ledger.start(input());
    expect(lstatSync(privateDir()).mode & 0o777).toBe(0o700);
    expect(modes()).toEqual([0o600, 0o600, 0o600]);
  });

  it('repairs existing DB/WAL/SHM on a second connection without losing active ownership', () => {
    ledger.start(input());
    for (const name of filenames) chmodSync(path.join(privateDir(), name), 0o644);
    chmodSync(privateDir(), 0o755);
    const second = open();
    expect(lstatSync(privateDir()).mode & 0o777).toBe(0o700);
    expect(modes()).toEqual([0o600, 0o600, 0o600]);
    expect(second.start(input('alice', 'next'))).toEqual({ status: 'denied', reason: 'active_run' });
    now += MINUTE;
    expect(second.finish('alice', 'run-1').chargedMs).toBe(MINUTE);
    expect(ledger.balance('alice').usedMs).toBe(MINUTE);
  });

  it('recovers an uncheckpointed WAL snapshot while repairing all persisted file modes', () => {
    ledger.start(input());
    // No writes are in flight: copy the live DB/WAL/SHM bytes before close can
    // checkpoint them, then restore that crash-like snapshot in this test root.
    const snapshot = filenames.map(name => readFileSync(path.join(privateDir(), name)));
    resetRoot();
    mkdirSync(privateDir(), { mode: 0o755 });
    filenames.forEach((name, index) => {
      const file = path.join(privateDir(), name);
      writeFileSync(file, snapshot[index]!);
      chmodSync(file, 0o644);
    });
    ledger = open();
    expect(lstatSync(privateDir()).mode & 0o777).toBe(0o700);
    expect(modes()).toEqual([0o600, 0o600, 0o600]);
    expect(ledger.start(input()).status).toBe('replayed');
    now += MINUTE;
    expect(ledger.finish('alice', 'run-1').chargedMs).toBe(MINUTE);
    ledger.close();
    ledger = open();
    expect(modes()).toEqual([0o600, 0o600, 0o600]);
    expect(ledger.balance('alice').usedMs).toBe(MINUTE);
  });

  it.each(['symlink', 'file'] as const)('rejects a pre-existing %s child without modifying its target', kind => {
    resetRoot();
    const target = path.join(dataRoot, 'unrelated-directory');
    mkdirSync(target, { mode: 0o755 });
    chmodSync(target, 0o755);
    if (kind === 'symlink') symlinkSync(target, privateDir(), 'dir');
    else writeFileSync(privateDir(), 'untouched');
    expect(() => open()).toThrow('invalid_quota_directory');
    expect(lstatSync(target).mode & 0o777).toBe(0o755);
    expect(readdirSync(target)).toEqual([]);
    if (kind === 'file') expect(readFileSync(privateDir(), 'utf8')).toBe('untouched');
  });

  it.each([...filenames, 'worker-quota.sqlite-journal'])('rejects a pre-created %s symlink without changing its target', name => {
    resetRoot();
    mkdirSync(privateDir(), { mode: 0o700 });
    const target = path.join(dataRoot, 'unrelated-file');
    writeFileSync(target, 'untouched');
    chmodSync(target, 0o644);
    symlinkSync(target, path.join(privateDir(), name));
    expect(() => open()).toThrow('invalid_quota_file');
    expect(readFileSync(target, 'utf8')).toBe('untouched');
    expect(lstatSync(target).mode & 0o777).toBe(0o644);
  });
});
