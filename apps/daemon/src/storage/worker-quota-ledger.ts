import { chmodSync, lstatSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const WINDOW_MS = 7 * 24 * 60 * 60_000;
const BUDGET_MS = 120 * 60_000;

export interface WorkerQuotaStart {
  actorId: string;
  runId: string;
  projectId: string;
  providerId: string;
}

export interface WorkerQuotaRun extends WorkerQuotaStart {
  status: 'active' | 'finished' | 'cancelled';
  startedAt: number;
  endedAt: number | null;
  /** Full lifetime duration; null until explicitly stopped, never capped at quota. */
  chargedMs: number | null;
}

export type WorkerQuotaAdmission =
  | { status: 'started' | 'replayed'; run: WorkerQuotaRun }
  | { status: 'denied'; reason: 'active_run' | 'quota_exhausted' };

export interface WorkerQuotaBalance {
  usedMs: number;
  remainingMs: number;
  budgetMs: number;
  windowMs: number;
  activeRunId: string | null;
}

function identifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || value.includes('\0')
    || Buffer.from(value, 'utf8').toString('utf8') !== value) {
    throw new Error('invalid_identifier');
  }
}

function privateQuotaFile(dataRoot: string): string {
  mkdirSync(dataRoot, { recursive: true });
  const directory = path.join(dataRoot, 'worker-quota');
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  // dataRoot is trusted. Refuse a redirected or foreign-owned child before
  // chmod or SQLite can follow it. This is not a sandbox against the same UID.
  const owner = process.getuid?.();
  const info = lstatSync(directory);
  if (!info.isDirectory() || (owner !== undefined && info.uid !== owner)) {
    throw new Error('invalid_quota_directory');
  }
  chmodSync(directory, 0o700);
  const file = path.join(directory, 'worker-quota.sqlite');
  // Reopen/recovery may encounter existing permissive sidecars. Secure them
  // before SQLite reads any persisted state, including a rollback journal.
  for (const candidate of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) {
    const entry = lstatSync(candidate, { throwIfNoEntry: false });
    if (!entry) continue;
    if (!entry.isFile() || (owner !== undefined && entry.uid !== owner)) {
      throw new Error('invalid_quota_file');
    }
    try {
      chmodSync(candidate, 0o600);
    } catch (error) {
      // A closing connection can remove a sidecar after lstat. SQLite recreates
      // it using the DB's mode. Never ignore loss of the database itself.
      if (candidate === file || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return file;
}

/**
 * Private admission/accounting primitive, wired only to the test-mock
 * multi-user pool. All IDs and the clock are trusted server inputs, not auth
 * claims: callers must verify actor identity and access before invoking this.
 *
 * Call start at actual dispatch, not enqueue. Only `started` grants a new
 * admission; `replayed` must never launch another worker. Finish/cancel record
 * the actual worker stop, not the time a cancellation was merely requested.
 * Scheduler, provider access, role checks and watchdogs live outside this store.
 *
 * Unfinished runs retain their slot across restarts and accrue elapsed time
 * until explicitly stopped. Recovery must reconcile the worker before doing so;
 * this store cannot infer process liveness or unobserved downtime. Terminal rows
 * are retained for replay protection; retention/compaction is a later concern.
 *
 * Data paths follow the root AGENTS.md "Daemon data directory contract".
 */
export class WorkerQuotaLedger {
  private readonly db: Database.Database;
  private readonly clock: () => number;
  private observedAt = 0;

  constructor(options: { dataRoot: string; clock?: () => number }) {
    if (typeof options.dataRoot !== 'string' || !path.isAbsolute(options.dataRoot) || options.dataRoot.includes('\0')) {
      throw new Error('invalid_data_root');
    }
    this.clock = options.clock ?? Date.now;
    const file = privateQuotaFile(options.dataRoot);
    this.db = new Database(file, { timeout: 5_000 });
    try {
      // The private directory protects a newly created DB until chmod. Set its
      // mode BEFORE WAL activation so SQLite creates WAL/SHM with mode 0600.
      chmodSync(file, 0o600);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = FULL');
      this.db.transaction(() => {
        const version = this.db.pragma('user_version', { simple: true });
        if (version !== 0 && version !== 1 && version !== 2 && version !== 3) throw new Error('unsupported_quota_schema');
        if (version === 3) return;
        if (version === 0) this.db.exec(`
          CREATE TABLE quota_clock (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            observed_at INTEGER NOT NULL CHECK (observed_at BETWEEN 0 AND 9007199254740991)
          ) STRICT;
          INSERT INTO quota_clock VALUES (1, 0);
          CREATE TABLE quota_runs (
            run_id TEXT PRIMARY KEY NOT NULL CHECK (length(run_id) BETWEEN 1 AND 256),
            actor_id TEXT NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 256),
            project_id TEXT NOT NULL CHECK (length(project_id) BETWEEN 1 AND 256),
            provider_id TEXT NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 256),
            status TEXT NOT NULL CHECK (status IN ('active', 'finished', 'cancelled')),
            started_at INTEGER NOT NULL CHECK (started_at BETWEEN 0 AND 9007199254740991),
            ended_at INTEGER CHECK (ended_at BETWEEN started_at AND 9007199254740991),
            CHECK ((status = 'active' AND ended_at IS NULL)
              OR (status != 'active' AND ended_at IS NOT NULL))
          ) STRICT;
          CREATE UNIQUE INDEX quota_one_active_actor ON quota_runs(actor_id) WHERE status = 'active';
          CREATE INDEX quota_actor_spans ON quota_runs(actor_id, ended_at);
        `);
        if (version <= 1) this.db.exec(`CREATE TABLE quota_overrides (
          actor_id TEXT PRIMARY KEY NOT NULL,
          budget_ms INTEGER NOT NULL CHECK (budget_ms BETWEEN 0 AND 604800000)
        ) STRICT;`);
        this.db.exec(`CREATE TABLE quota_audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT, admin_actor_id TEXT NOT NULL,
            actor_id TEXT NOT NULL, budget_ms INTEGER NOT NULL, created_at INTEGER NOT NULL
          ) STRICT;
          CREATE TRIGGER quota_audit_immutable BEFORE UPDATE ON quota_audit
            BEGIN SELECT RAISE(ABORT, 'quota audit is append only'); END;
          CREATE TRIGGER quota_audit_no_delete BEFORE DELETE ON quota_audit
            BEGIN SELECT RAISE(ABORT, 'quota audit is append only'); END;
          PRAGMA user_version = 3;`);
      }).immediate();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  start(input: WorkerQuotaStart): WorkerQuotaAdmission {
    identifier(input?.actorId);
    identifier(input?.runId);
    identifier(input?.projectId);
    identifier(input?.providerId);
    return this.mutate(now => {
      const existing = this.run(input.runId);
      if (existing) {
        if (existing.actorId !== input.actorId || existing.projectId !== input.projectId || existing.providerId !== input.providerId) {
          throw new Error('run_conflict');
        }
        return { status: 'replayed', run: existing };
      }
      const balance = this.balanceAt(input.actorId, now);
      if (balance.activeRunId !== null) return { status: 'denied', reason: 'active_run' };
      if (balance.remainingMs === 0) return { status: 'denied', reason: 'quota_exhausted' };
      this.db.prepare(`INSERT INTO quota_runs
        (run_id, actor_id, project_id, provider_id, status, started_at)
        VALUES (?, ?, ?, ?, 'active', ?)`)
        .run(input.runId, input.actorId, input.projectId, input.providerId, now);
      return { status: 'started', run: this.run(input.runId)! };
    });
  }

  finish(actorId: string, runId: string): WorkerQuotaRun {
    return this.stop(actorId, runId, 'finished');
  }

  cancel(actorId: string, runId: string): WorkerQuotaRun {
    return this.stop(actorId, runId, 'cancelled');
  }

  /**
   * Read-only snapshot, not permission to start. Checks against the last committed
   * mutation's clock watermark and this connection's observations. Reads advance
   * only the in-memory watermark, so read-only observations do not survive reopen
   * or synchronize other connections. Admission always rechecks persisted state.
   */
  balance(actorId: string): WorkerQuotaBalance {
    identifier(actorId);
    return this.db.transaction(() => this.balanceAt(actorId, this.checkedNow()))();
  }

  /** Startup reconciliation for the daemon-owned scheduler only. */
  activeRuns(): Array<{ actorId: string; runId: string }> {
    return this.db.prepare("SELECT actor_id AS actorId, run_id AS runId FROM quota_runs WHERE status = 'active'")
      .all() as Array<{ actorId: string; runId: string }>;
  }

  /** Scheduler-only lookup for reconciling an immutable run id. */
  entry(runId: string): WorkerQuotaRun | undefined {
    identifier(runId);
    return this.run(runId);
  }

  setBudgetMs(actorId: string, budgetMs: number, adminActorId: string): void {
    identifier(actorId);
    identifier(adminActorId);
    if (!Number.isSafeInteger(budgetMs) || budgetMs < 0 || budgetMs > WINDOW_MS) throw new Error('invalid_budget');
    this.mutate(now => {
      this.db.prepare('INSERT INTO quota_overrides (actor_id, budget_ms) VALUES (?, ?) ON CONFLICT(actor_id) DO UPDATE SET budget_ms = excluded.budget_ms')
        .run(actorId, budgetMs);
      this.db.prepare('INSERT INTO quota_audit (admin_actor_id, actor_id, budget_ms, created_at) VALUES (?, ?, ?, ?)')
        .run(adminActorId, actorId, budgetMs, now);
    });
  }

  close(): void {
    if (this.db.open) this.db.close();
  }

  private stop(actorId: string, runId: string, status: 'finished' | 'cancelled'): WorkerQuotaRun {
    identifier(actorId);
    identifier(runId);
    return this.mutate(now => {
      const existing = this.run(runId);
      // No other actor's run details escape through this operation.
      if (!existing || existing.actorId !== actorId) throw new Error('run_not_found');
      if (existing.status !== 'active') return existing;
      this.db.prepare('UPDATE quota_runs SET status = ?, ended_at = ? WHERE run_id = ? AND actor_id = ?')
        .run(status, now, runId, actorId);
      return this.run(runId)!;
    });
  }

  private mutate<T>(operation: (now: number) => T): T {
    // Acquire the database write lock BEFORE sampling time and checking usage.
    // An in-process mutex or a deferred read/check/write transaction is not enough
    // for competing connections. Busy/error paths throw; they never grant a slot.
    return this.db.transaction(() => {
      const now = this.checkedNow();
      this.db.prepare('UPDATE quota_clock SET observed_at = ? WHERE singleton = 1').run(now);
      return operation(now);
    }).immediate();
  }

  private checkedNow(): number {
    const row = this.db.prepare('SELECT observed_at FROM quota_clock WHERE singleton = 1').get() as { observed_at: number } | undefined;
    if (!row || !Number.isSafeInteger(row.observed_at) || row.observed_at < 0) throw new Error('invalid_quota_clock');
    const now = this.clock();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('invalid_clock');
    if (now < Math.max(row.observed_at, this.observedAt)) throw new Error('clock_rollback');
    this.observedAt = now;
    return now;
  }

  private run(runId: string): WorkerQuotaRun | undefined {
    return this.db.prepare(`SELECT actor_id AS actorId, run_id AS runId,
      project_id AS projectId, provider_id AS providerId, status,
      started_at AS startedAt, ended_at AS endedAt, ended_at - started_at AS chargedMs
      FROM quota_runs WHERE run_id = ?`).get(runId) as WorkerQuotaRun | undefined;
  }

  private balanceAt(actorId: string, now: number): WorkerQuotaBalance {
    // Half-open interval intersection: [start, stop) ∩ [now - window, now).
    // Include spans that STARTED before the window, and unfinished spans at now.
    const { usedMs } = this.db.prepare(`SELECT COALESCE(SUM(
        MAX(0, MIN(COALESCE(ended_at, @now), @now) - MAX(started_at, @left))
      ), 0) AS usedMs FROM quota_runs
      WHERE actor_id = @actorId AND (ended_at IS NULL OR ended_at > @left)`)
      .get({ actorId, now, left: now - WINDOW_MS }) as { usedMs: number };
    if (!Number.isSafeInteger(usedMs) || usedMs < 0 || usedMs > WINDOW_MS) throw new Error('invalid_quota_usage');
    const active = this.db.prepare("SELECT run_id FROM quota_runs WHERE actor_id = ? AND status = 'active'")
      .get(actorId) as { run_id: string } | undefined;
    const override = this.db.prepare('SELECT budget_ms FROM quota_overrides WHERE actor_id = ?').get(actorId) as { budget_ms: number } | undefined;
    const budgetMs = override?.budget_ms ?? BUDGET_MS;
    return {
      usedMs,
      remainingMs: Math.max(0, budgetMs - usedMs),
      budgetMs,
      windowMs: WINDOW_MS,
      activeRunId: active?.run_id ?? null,
    };
  }
}
