import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { Express, Request, Response } from 'express';
import type { MultiUserRun, MultiUserRunEvent, MultiUserRunStatus, MultiUserRunsResponse } from '@open-design/contracts';
import { getConversation, getProject } from '../db.js';
import { sendApiError } from '../http/api-errors.js';
import { multiUserActorOf } from '../http/multiuser-gate.js';
import { PROJECT_OWNERS_TABLE, ProjectOwnershipStore } from '../storage/project-ownership.js';
import { WorkerQuotaLedger } from '../storage/worker-quota-ledger.js';
import { AuthStore } from '../storage/auth-store.js';
import { isSafeId } from '../projects.js';
import { PROBLEM_ERRORS, runPersonalCodexTurn, type PersonalCodexAccounts } from '../services/personal-codex-accounts.js';
import type { PersonalRunLaneControls } from './multiuser-agent-accounts.js';

type RunRow = {
  id: string; owner_account_id: string; project_id: string; conversation_id: string;
  status: 'queued' | 'active' | 'succeeded' | 'failed' | 'canceled'; created_at: number; updated_at: number; output: string | null;
  request_json: string | null; queue_seq: number | null;
  execution_source: 'company_pool' | 'personal_subscription'; personal_account_id: string | null;
  credential_version: number | null; started_at: number | null; ended_at: number | null;
};

const table = 'multiuser_runs';
/** Personal-subscription lane defaults (#18): host-wide worker ceiling and per-user queue. */
const PERSONAL_DEFAULT_CAPACITY = 4;
const PERSONAL_QUEUE_LIMIT = 3;
const RUN_PAGE_DEFAULT = 50;
const RUN_PAGE_MAX = 100;
/** The API names an active row `running`; every other status is stored as served. */
const STORED_STATUS: Record<MultiUserRunStatus, RunRow['status']> = {
  queued: 'queued', running: 'active', succeeded: 'succeeded', failed: 'failed', canceled: 'canceled',
};

/** Stored JSON is projected, never trusted: a damaged value reads as null instead of failing the owner's reads. */
function storedJson(text: string | null): unknown {
  if (!text) return null;
  try { return JSON.parse(text) as unknown; } catch { return null; }
}
/**
 * The stored request's string `message`, or null when the request is damaged
 * (missing, not JSON, or not an object with a string message). Personal
 * dispatch refuses a null before it changes any state, never running an empty prompt.
 */
function storedMessage(requestJson: string | null): string | null {
  const request = storedJson(requestJson);
  const message = request && typeof request === 'object' ? (request as { message?: unknown }).message : null;
  return typeof message === 'string' ? message : null;
}

type RunListQuery = {
  limit: number; cursor: { createdAt: number; id: string } | null;
  projectId?: string; conversationId?: string; status?: RunRow['status'];
};
/**
 * Strict `GET /api/runs` query. Repeated or non-string parameters, a malformed
 * limit/cursor and an unknown status are refused rather than silently widening
 * the list. Id filters accept any single string (an unowned id matches nothing);
 * unknown names are ignored.
 */
function parseRunListQuery(query: Request['query']): RunListQuery | null {
  const one = (name: string): string | undefined | null => {
    const value = query[name];
    return value === undefined ? undefined : typeof value === 'string' ? value : null;
  };
  const [limit, cursor, projectId, conversationId, status] = ['limit', 'cursor', 'projectId', 'conversationId', 'status'].map(one);
  if ([limit, cursor, projectId, conversationId, status].includes(null)) return null;
  const parsed: RunListQuery = { limit: RUN_PAGE_DEFAULT, cursor: null };
  if (limit !== undefined) {
    if (!/^[1-9]\d{0,2}$/.test(limit!) || Number(limit) > RUN_PAGE_MAX) return null;
    parsed.limit = Number(limit);
  }
  if (cursor !== undefined) {
    // Opaque to clients: `<createdAt>:<id>` of the last row served.
    const match = /^(0|[1-9]\d{0,15}):([A-Za-z0-9-]{1,64})$/.exec(cursor!);
    if (!match || !Number.isSafeInteger(Number(match[1]))) return null;
    parsed.cursor = { createdAt: Number(match[1]), id: match[2]! };
  }
  if (status !== undefined) {
    if (!Object.hasOwn(STORED_STATUS, status!)) return null;
    parsed.status = STORED_STATUS[status as MultiUserRunStatus];
  }
  if (projectId !== undefined) parsed.projectId = projectId!;
  if (conversationId !== undefined) parsed.conversationId = conversationId!;
  return parsed;
}

/**
 * Separate test-only execution plane. The normal run/agent stack is never reached.
 * Company-pool rows run the repository test mock; personal-subscription rows
 * run through the owner's own CODEX_HOME on a separate queue and ceiling, never
 * the company slots or the company worker-time ledger.
 */
export function registerMultiUserRunRoutes(app: Express, input: {
  db: Database.Database;
  dataRoot: string;
  projectsRoot: string;
  mockAgentScript?: string;
  repositoryRoot: string;
  clock?: () => number;
  personal?: PersonalCodexAccounts;
}): { cancelAccountRuns(accountId: string): void; isRunOwner(runId: string, accountId: string): boolean;
  cancelPersonalRuns(accountId: string): Promise<void>; forgetNativeSessions(accountId: string): void; personalLane: PersonalRunLaneControls; listAccountIds(): string[];
  beginShutdown(): void; shutdown(): Promise<void> } {
  const { db, dataRoot, projectsRoot } = input;
  const expected = fs.realpathSync(path.join(input.repositoryRoot, 'mocks/run-isolation-agent.ts'));
  const mockAgentScript = input.mockAgentScript ? fs.realpathSync(input.mockAgentScript) : null;
  if (mockAgentScript && mockAgentScript !== expected) throw new Error('multi-user mode refused: only the repository test mock may run');
  const owners = new ProjectOwnershipStore(db);
  const ledger = new WorkerQuotaLedger({ dataRoot, ...(input.clock ? { clock: input.clock } : {}) });
  const accounts = AuthStore.open({ dataRoot });
  const now = input.clock ?? Date.now;
  const legacy = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string } | undefined;
  if (legacy && !legacy.sql.includes("'queued'")) {
    db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        db.exec(`CREATE TABLE multiuser_runs_next (
          id TEXT PRIMARY KEY, owner_account_id TEXT NOT NULL CHECK (length(owner_account_id) > 0),
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          status TEXT NOT NULL CHECK (status IN ('queued','active','succeeded','failed','canceled')),
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, output TEXT,
          request_json TEXT, queue_seq INTEGER
        );
        INSERT INTO multiuser_runs_next (id, owner_account_id, project_id, conversation_id, status, created_at, updated_at, output)
          SELECT id, owner_account_id, project_id, conversation_id, status, created_at, updated_at, output FROM multiuser_runs;
        DROP TABLE multiuser_runs;
        ALTER TABLE multiuser_runs_next RENAME TO multiuser_runs;`);
      }).immediate();
    } finally { db.pragma('foreign_keys = ON'); }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${table} (
      id TEXT PRIMARY KEY,
      owner_account_id TEXT NOT NULL CHECK (length(owner_account_id) > 0),
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('queued','active','succeeded','failed','canceled')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      output TEXT,
      request_json TEXT,
      queue_seq INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_${table}_owner ON ${table}(owner_account_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_${table}_queue ON ${table}(status, queue_seq);
    CREATE TRIGGER IF NOT EXISTS ${table}_binding_immutable BEFORE UPDATE OF owner_account_id, project_id, conversation_id ON ${table}
      BEGIN SELECT RAISE(ABORT, 'run binding is immutable'); END;
    CREATE TABLE IF NOT EXISTS multiuser_run_events (
      run_id TEXT NOT NULL REFERENCES ${table}(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      event TEXT NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (run_id, seq)
    );
    CREATE TABLE IF NOT EXISTS multiuser_pool_config (
      key TEXT PRIMARY KEY, value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS multiuser_pool_turns (
      account_id TEXT PRIMARY KEY, last_seq INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS multiuser_pool_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, actor_account_id TEXT NOT NULL,
      action TEXT NOT NULL, target_id TEXT NOT NULL, value INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS multiuser_pool_audit_immutable BEFORE UPDATE ON multiuser_pool_audit
      BEGIN SELECT RAISE(ABORT, 'pool audit is append only'); END;
    CREATE TRIGGER IF NOT EXISTS multiuser_pool_audit_no_delete BEFORE DELETE ON multiuser_pool_audit
      BEGIN SELECT RAISE(ABORT, 'pool audit is append only'); END;
  `);
  const runColumns = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name));
  for (const [name, ddl] of [
    ['execution_source', "TEXT NOT NULL DEFAULT 'company_pool' CHECK (execution_source IN ('company_pool','personal_subscription'))"],
    ['personal_account_id', 'TEXT'], ['credential_version', 'INTEGER'], ['started_at', 'INTEGER'], ['ended_at', 'INTEGER'],
  ] as const) {
    if (!runColumns.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
  }
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS ${table}_source_immutable BEFORE UPDATE OF execution_source, personal_account_id, credential_version ON ${table}
      BEGIN SELECT RAISE(ABORT, 'run binding is immutable'); END;
    CREATE TABLE IF NOT EXISTS multiuser_personal_turns (
      account_id TEXT PRIMARY KEY, last_seq INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS multiuser_personal_sessions (
      conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
      owner_account_id TEXT NOT NULL, personal_account_id TEXT NOT NULL, thread_id TEXT, updated_at INTEGER NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS multiuser_personal_sessions_binding_immutable
      BEFORE UPDATE OF owner_account_id, personal_account_id ON multiuser_personal_sessions
      BEGIN SELECT RAISE(ABORT, 'personal session binding is immutable'); END;
  `);
  const personal = input.personal ?? null;
  const company = "execution_source = 'company_pool'";
  const personalRows = "execution_source = 'personal_subscription'";
  const recovery = db.prepare(`SELECT * FROM ${table} WHERE status = 'active'`).all() as RunRow[];
  const ledgerActive = ledger.activeRuns();
  const reconciled = new Set<string>();
  for (const run of recovery) {
    const entry = ledger.entry(run.id);
    if (entry?.status === 'active') {
      ledger.finish(entry.actorId, run.id);
      reconciled.add(run.id);
    }
    db.prepare(`UPDATE ${table} SET status = 'failed', updated_at = ? WHERE id = ?`).run(now(), run.id);
  }
  const queuedRecovery = db.prepare(`SELECT * FROM ${table} WHERE status = 'queued'`).all() as RunRow[];
  for (const run of queuedRecovery) {
    const entry = ledger.entry(run.id);
    if (!entry) continue;
    if (entry.status === 'active') {
      ledger.finish(entry.actorId, run.id);
      reconciled.add(run.id);
    }
    db.prepare(`UPDATE ${table} SET status = 'failed', output = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify({ reason: 'ledger_admission_replayed' }), now(), run.id);
  }
  for (const entry of ledgerActive) {
    if (!reconciled.has(entry.runId)) {
      ledger.finish(entry.actorId, entry.runId);
    }
  }
  const children = new Map<string, ChildProcessWithoutNullStreams>();
  const cancelPending = new Set<string>();
  const failurePending = new Set<string>();
  let shuttingDown = false;
  let storesClosed = false;
  const listeners = new Map<string, Set<Response>>();
  const row = (id: string) => db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as RunRow | undefined;
  const actor = (res: Response) => multiUserActorOf(res)?.accountId ?? '';
  const owned = (req: Request, res: Response): RunRow | null => {
    const id = String(req.params.id ?? '');
    const found = row(id);
    if (!found || found.owner_account_id !== actor(res) || !owners.isOwnedBy(found.project_id, actor(res))) {
      sendApiError(res, 404, 'NOT_FOUND', 'run not found');
      return null;
    }
    return found;
  };
  const queuePosition = (run: RunRow) => run.status === 'queued' ? (db.prepare(`SELECT COUNT(*) AS n FROM ${table}
    WHERE status = 'queued' AND owner_account_id = ? AND queue_seq <= ? AND execution_source = ?`)
    .get(run.owner_account_id, run.queue_seq, run.execution_source) as { n: number }).n : null;
  const isPersonal = (run: RunRow) => run.execution_source === 'personal_subscription';
  const body = (run: RunRow): MultiUserRun => ({
    id: run.id, projectId: run.project_id, conversationId: run.conversation_id,
    agentId: isPersonal(run) ? 'codex' : 'test-mock', status: run.status === 'active' ? 'running' : run.status,
    queuePosition: queuePosition(run), createdAt: run.created_at,
    updatedAt: run.updated_at, output: storedJson(run.output),
    message: storedMessage(run.request_json),
    ...(isPersonal(run) ? { executionSource: 'personal_subscription' as const } : {}),
  });
  const emit = <E extends MultiUserRunEvent['event']>(id: string, event: E, data: Extract<MultiUserRunEvent, { event: E }>['data']) => {
    const seq = (db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM multiuser_run_events WHERE run_id = ?').get(id) as { seq: number }).seq;
    const payload = JSON.stringify(data);
    db.prepare('INSERT INTO multiuser_run_events (run_id, seq, event, data) VALUES (?, ?, ?, ?)').run(id, seq, event, payload);
    for (const res of listeners.get(id) ?? []) res.write(`id: ${seq}\nevent: ${event}\ndata: ${payload}\n\n`);
  };
  let dispatching = false;
  let suspendDispatch = false;
  let retryTimer: NodeJS.Timeout | null = null;
  let dispatch = () => {};
  let dispatchPersonal = () => {};
  const finish = (id: string, status: 'succeeded' | 'failed' | 'canceled', output?: unknown) => {
    if (storesClosed) return;
    const existing = row(id);
    if (!existing || (existing.status !== 'active' && existing.status !== 'queued')) return;
    if (existing.status === 'active' && !isPersonal(existing)) {
      if (status === 'canceled') ledger.cancel(existing.owner_account_id, id);
      else ledger.finish(existing.owner_account_id, id);
    }
    // Personal worker time is recorded for visibility only; it has no budget.
    if (existing.status === 'active' && isPersonal(existing)) db.prepare(`UPDATE ${table} SET ended_at = ? WHERE id = ?`).run(now(), id);
    db.prepare(`UPDATE ${table} SET status = ?, output = ?, updated_at = ? WHERE id = ?`)
      .run(status, output === undefined ? null : JSON.stringify(output), now(), id);
    emit(id, 'end', { status, ...(output === undefined ? {} : { output }) });
    for (const res of listeners.get(id) ?? []) res.end();
    listeners.delete(id);
    children.delete(id);
    cancelPending.delete(id);
    failurePending.delete(id);
    if (!shuttingDown && !suspendDispatch) { dispatch(); dispatchPersonal(); }
  };
  const capacity = () => Number((db.prepare("SELECT value FROM multiuser_pool_config WHERE key = 'test-mock-capacity'").get() as { value: string } | undefined)?.value ?? '2');
  dispatch = () => {
    if (dispatching || shuttingDown || !mockAgentScript) return;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    dispatching = true;
    try {
      while ((db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE status = 'active' AND ${company}`).get() as { n: number }).n < capacity()) {
        const queued = db.prepare(`SELECT * FROM ${table} WHERE status = 'queued' AND ${company} ORDER BY queue_seq`).all() as RunRow[];
        const turns = new Map((db.prepare('SELECT account_id, last_seq FROM multiuser_pool_turns').all() as Array<{ account_id: string; last_seq: number }>)
          .map((turn) => [turn.account_id, turn.last_seq]));
        const eligible = queued.filter((run) => ledger.balance(run.owner_account_id).remainingMs > 0 &&
          !(db.prepare(`SELECT 1 FROM ${table} WHERE owner_account_id = ? AND status = 'active' AND ${company}`).get(run.owner_account_id)));
        const next = eligible.sort((a, b) => (turns.get(a.owner_account_id) ?? 0) - (turns.get(b.owner_account_id) ?? 0)
          || Number(a.queue_seq) - Number(b.queue_seq))[0];
        if (!next) break;
        const project = getProject(db, next.project_id);
        const conversation = getConversation(db, next.conversation_id);
        const cwd = path.join(projectsRoot, next.project_id);
        let realCwd: string | null = null;
        try { realCwd = fs.realpathSync(cwd); } catch { /* fail the queued run below */ }
        const metadata = project?.metadata as Record<string, unknown> | null | undefined;
        if (!accounts.getAccountById(next.owner_account_id)?.active) {
          finish(next.id, 'canceled');
          continue;
        }
        if (!owners.isOwnedBy(next.project_id, next.owner_account_id) ||
            conversation?.projectId !== next.project_id || metadata?.baseDir || metadata?.linkedDirs || metadata?.imported ||
            !realCwd || path.dirname(realCwd) !== fs.realpathSync(projectsRoot)) {
          finish(next.id, 'failed');
          continue;
        }
        const actorDir = createHash('sha256').update(next.owner_account_id).digest('hex');
        const runHome = path.join(dataRoot, 'multiuser-runtime', actorDir, next.id);
        const temp = path.join(runHome, 'tmp');
        fs.mkdirSync(temp, { recursive: true, mode: 0o700 });
        fs.chmodSync(path.dirname(runHome), 0o700);
        fs.chmodSync(runHome, 0o700);
        fs.chmodSync(temp, 0o700);
        const admission = ledger.start({ actorId: next.owner_account_id, runId: next.id, projectId: next.project_id, providerId: 'test-mock' });
        if (admission.status === 'replayed') {
          if (admission.run.status === 'active') ledger.finish(next.owner_account_id, next.id);
          finish(next.id, 'failed', { reason: 'ledger_admission_replayed' });
          continue;
        }
        if (admission.status !== 'started') break;
        db.prepare(`UPDATE ${table} SET status = 'active', updated_at = ? WHERE id = ?`).run(now(), next.id);
        db.prepare(`INSERT INTO multiuser_pool_turns (account_id, last_seq)
          VALUES (?, (SELECT COALESCE(MAX(last_seq), 0) + 1 FROM multiuser_pool_turns))
          ON CONFLICT(account_id) DO UPDATE SET last_seq = excluded.last_seq`).run(next.owner_account_id);
        emit(next.id, 'start', { runId: next.id });
        const child = spawn(process.execPath, [mockAgentScript], {
          cwd: realCwd, env: { HOME: runHome, TMPDIR: temp, TMP: temp, TEMP: temp, OD_DATA_DIR: dataRoot },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        children.set(next.id, child);
        let stdout = '';
        child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
        child.stderr.on('data', () => {});
        child.stdin.on('error', () => { failurePending.add(next.id); child.kill('SIGTERM'); });
        child.on('error', () => { failurePending.add(next.id); });
        child.on('close', (code) => {
          if (shuttingDown) return finish(next.id, 'canceled', { reason: 'daemon_shutdown' });
          if (cancelPending.has(next.id)) return finish(next.id, 'canceled');
          if (code !== 0 || failurePending.has(next.id)) return finish(next.id, 'failed');
          try {
            const output = JSON.parse(stdout.trim()) as unknown;
            if (row(next.id)?.status !== 'active') return;
            emit(next.id, 'agent', output);
            finish(next.id, 'succeeded', output);
          } catch { finish(next.id, 'failed'); }
        });
        child.stdin.end(next.request_json ?? '{}');
      }
    } finally {
      dispatching = false;
      const waiting = db.prepare(`SELECT 1 FROM ${table} WHERE status = 'queued' AND ${company} LIMIT 1`).get();
      const active = (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE status = 'active' AND ${company}`).get() as { n: number }).n;
      if (waiting && active < capacity() && capacity() > 0) {
        retryTimer = setTimeout(() => { retryTimer = null; dispatch(); }, 60_000);
        retryTimer.unref();
      }
    }
  };
  const personalCapacity = () => Number((db.prepare("SELECT value FROM multiuser_pool_config WHERE key = 'personal-capacity'")
    .get() as { value: string } | undefined)?.value ?? String(PERSONAL_DEFAULT_CAPACITY));
  let personalDispatching = false;
  // Declared before the startup dispatch below, which may already need it.
  const personalSession = (conversationId: string) => db.prepare('SELECT * FROM multiuser_personal_sessions WHERE conversation_id = ?')
    .get(conversationId) as { owner_account_id: string; personal_account_id: string; thread_id: string | null } | undefined;
  /**
   * Personal lane: its own host-wide ceiling, one active run per user, FIFO per
   * user and round-robin across users by their last personal dispatch turn.
   * The company ledger and company slots are never touched.
   */
  dispatchPersonal = () => {
    const command = personal?.appServerCommand();
    if (personalDispatching || shuttingDown || !personal || !command) return;
    personalDispatching = true;
    try {
      while ((db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE status = 'active' AND ${personalRows}`).get() as { n: number }).n < personalCapacity()) {
        const queued = db.prepare(`SELECT * FROM ${table} WHERE status = 'queued' AND ${personalRows} ORDER BY queue_seq`).all() as RunRow[];
        const turns = new Map((db.prepare('SELECT account_id, last_seq FROM multiuser_personal_turns').all() as Array<{ account_id: string; last_seq: number }>)
          .map((turn) => [turn.account_id, turn.last_seq]));
        const next = queued.filter((run) => !db.prepare(`SELECT 1 FROM ${table} WHERE owner_account_id = ? AND status = 'active' AND ${personalRows}`)
          .get(run.owner_account_id))
          .sort((a, b) => (turns.get(a.owner_account_id) ?? 0) - (turns.get(b.owner_account_id) ?? 0) || Number(a.queue_seq) - Number(b.queue_seq))[0];
        if (!next) break;
        if (!accounts.getAccountById(next.owner_account_id)?.active) { finish(next.id, 'canceled'); continue; }
        const project = getProject(db, next.project_id);
        const conversation = getConversation(db, next.conversation_id);
        const metadata = project?.metadata as Record<string, unknown> | null | undefined;
        let realCwd: string | null = null;
        try { realCwd = fs.realpathSync(path.join(projectsRoot, next.project_id)); } catch { /* failed below */ }
        if (!owners.isOwnedBy(next.project_id, next.owner_account_id) || conversation?.projectId !== next.project_id ||
            metadata?.baseDir || metadata?.linkedDirs || metadata?.imported || !realCwd || path.dirname(realCwd) !== fs.realpathSync(projectsRoot)) {
          finish(next.id, 'failed');
          continue;
        }
        // Re-validate the binding at dispatch: same account, same credential version, still usable.
        const account = personal.usableAccount(next.owner_account_id);
        const session = personalSession(next.conversation_id);
        if (!account || account.id !== next.personal_account_id || account.credentialVersion !== next.credential_version ||
            !session || session.personal_account_id !== next.personal_account_id) {
          personal.audit(next.owner_account_id, next.owner_account_id, 'run_rejected', 'MULTIUSER_PERSONAL_UNAVAILABLE', next.id);
          finish(next.id, 'failed', { reason: 'MULTIUSER_PERSONAL_UNAVAILABLE' });
          continue;
        }
        // A damaged request never starts: no runtime home, active mark, personal turn or start event.
        const prompt = storedMessage(next.request_json);
        if (prompt === null) {
          finish(next.id, 'failed', { reason: 'MULTIUSER_RUN_REQUEST_INVALID' });
          continue;
        }
        const runHome = path.join(dataRoot, 'multiuser-runtime', createHash('sha256').update(next.owner_account_id).digest('hex'), next.id);
        const temp = path.join(runHome, 'tmp');
        fs.mkdirSync(temp, { recursive: true, mode: 0o700 });
        for (const dir of [path.dirname(runHome), runHome, temp]) fs.chmodSync(dir, 0o700);
        const runId = next.id;
        try {
          db.prepare(`UPDATE ${table} SET status = 'active', started_at = ?, updated_at = ? WHERE id = ?`).run(now(), now(), next.id);
          db.prepare(`INSERT INTO multiuser_personal_turns (account_id, last_seq)
            VALUES (?, (SELECT COALESCE(MAX(last_seq), 0) + 1 FROM multiuser_personal_turns))
            ON CONFLICT(account_id) DO UPDATE SET last_seq = excluded.last_seq`).run(next.owner_account_id);
          emit(next.id, 'start', { runId: next.id });
          const owner = next.owner_account_id;
          const accountId = account.id;
          const turn = runPersonalCodexTurn({
            command, codexHome: account.codexHome, home: runHome, temp, cwd: realCwd, dataRoot,
            prompt, resumeThreadId: session.thread_id, sandboxMode: 'workspace-write',
            onThread: (threadId) => db.prepare(`UPDATE multiuser_personal_sessions SET thread_id = ?, updated_at = ?
              WHERE conversation_id = ? AND personal_account_id = ?`).run(threadId, now(), next.conversation_id, accountId),
            onDone: (result) => {
              personal.secureHome(owner);
              if (shuttingDown) return finish(runId, 'canceled', { reason: 'daemon_shutdown' });
              if (cancelPending.has(runId)) return finish(runId, 'canceled');
              if (row(runId)?.status !== 'active') return;
              if (result.ok) {
                emit(runId, 'agent', { text: result.text });
                return finish(runId, 'succeeded', { text: result.text, threadId: result.threadId });
              }
              if (result.problem) personal.recordProblem(owner, accountId, result.problem);
              finish(runId, 'failed', { reason: result.problem ? PROBLEM_ERRORS[result.problem].code : 'MULTIUSER_PERSONAL_RUN_FAILED' });
            },
          });
          children.set(runId, turn.child);
        } catch {
          // Never leave a row holding the owner's slot and a host slot with no child; dispatch moves on.
          if (!children.has(runId)) finish(runId, 'failed', { reason: 'MULTIUSER_PERSONAL_RUN_FAILED' });
        }
      }
    } finally {
      personalDispatching = false;
    }
  };
  const cancelPersonalRuns = async (accountId: string): Promise<void> => {
    const rows = db.prepare(`SELECT id FROM ${table} WHERE owner_account_id = ? AND status IN ('active','queued') AND ${personalRows}`)
      .all(accountId) as Array<{ id: string }>;
    const exits: Array<Promise<void>> = [];
    suspendDispatch = true;
    try {
      for (const run of rows) {
        const child = children.get(run.id);
        if (child) {
          cancelPending.add(run.id);
          exits.push(new Promise<void>((resolve) => child.once('close', () => resolve())));
          child.kill('SIGTERM');
        } else finish(run.id, 'canceled');
      }
    } finally { suspendDispatch = false; }
    await Promise.all(exits);
    dispatchPersonal();
  };
  const personalLane: PersonalRunLaneControls = {
    stats() {
      const count = (status: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE status = ? AND ${personalRows}`)
        .get(status) as { n: number }).n;
      const workerMsByOwner = new Map((db.prepare(`SELECT owner_account_id AS id,
          SUM(COALESCE(ended_at, CASE WHEN status = 'active' THEN NULL ELSE updated_at END, ?) - started_at) AS ms
        FROM ${table} WHERE ${personalRows} AND started_at IS NOT NULL GROUP BY owner_account_id`).all(now()) as Array<{ id: string; ms: number }>)
        .map((entry) => [entry.id, Math.max(0, Number(entry.ms))]));
      return { active: count('active'), queued: count('queued'), capacity: personalCapacity(), workerMsByOwner };
    },
    setCapacity(value, adminId) {
      db.transaction(() => {
        db.prepare("INSERT INTO multiuser_pool_config (key, value) VALUES ('personal-capacity', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
          .run(String(value));
        db.prepare('INSERT INTO multiuser_pool_audit (actor_account_id, action, target_id, value, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(adminId, 'capacity', 'personal-subscription', value, now());
      })();
      dispatchPersonal();
    },
  };
  app.get('/api/admin/pool', (_req, res) => {
    const active = (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE status = 'active' AND ${company}`).get() as { n: number }).n;
    const queued = (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE status = 'queued' AND ${company}`).get() as { n: number }).n;
    const users: Record<string, { usedMs: number; budgetMs: number; remainingMs: number }> = {};
    for (const account of accounts.listAccounts()) {
      const balance = ledger.balance(account.id);
      users[account.id] = { usedMs: balance.usedMs, budgetMs: balance.budgetMs,
        remainingMs: balance.remainingMs };
    }
    res.json({ providers: { 'test-mock': { capacity: capacity(), active, queued },
      claude: { capacity: 0, active: 0, queued: 0 }, codex: { capacity: 0, active: 0, queued: 0 } }, users });
  });
  app.put('/api/admin/pool/providers/:providerId', (req, res) => {
    const providerId = String(req.params.providerId);
    const value = (req.body as { capacity?: unknown } | undefined)?.capacity;
    if (!['test-mock', 'claude', 'codex'].includes(providerId) || !Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 16) {
      return sendApiError(res, 400, 'BAD_REQUEST', 'invalid provider capacity');
    }
    if (providerId !== 'test-mock' && value !== 0) return sendApiError(res, 403, 'MULTIUSER_PROVIDER_DISABLED', 'real provider slots are disabled');
    if (providerId === 'test-mock') {
      db.transaction(() => {
        db.prepare("INSERT INTO multiuser_pool_config (key, value) VALUES ('test-mock-capacity', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
          .run(String(value));
        db.prepare('INSERT INTO multiuser_pool_audit (actor_account_id, action, target_id, value, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(actor(res), 'capacity', providerId, value, now());
      })();
      dispatch();
    }
    res.json({ providerId, capacity: value });
  });
  app.put('/api/admin/pool/users/:id/quota', (req, res) => {
    const accountId = String(req.params.id);
    const budgetMinutes = (req.body as { budgetMinutes?: unknown } | undefined)?.budgetMinutes;
    if (!accounts.getAccountById(accountId)) return sendApiError(res, 404, 'NOT_FOUND', 'account not found');
    if (!Number.isSafeInteger(budgetMinutes) || Number(budgetMinutes) < 0 || Number(budgetMinutes) > 10_080) {
      return sendApiError(res, 400, 'BAD_REQUEST', 'invalid quota');
    }
    ledger.setBudgetMs(accountId, Number(budgetMinutes) * 60_000, actor(res));
    dispatch();
    res.json({ accountId, budgetMinutes });
  });
  dispatch();
  dispatchPersonal();
  /** Owned managed project + conversation for a new run, or null after answering the error. */
  const managedTarget = (inputBody: Record<string, unknown>, res: Response): { projectId: string; conversationId: string } | null => {
    const fail = (status: number, code: 'NOT_FOUND' | 'MULTIUSER_IMPORTED_PROJECT_FORBIDDEN', message: string) => {
      sendApiError(res, status, code, message);
      return null;
    };
    const projectId = inputBody.projectId;
    const conversationId = inputBody.conversationId;
    if (typeof projectId !== 'string' || typeof conversationId !== 'string' ||
        !owners.isOwnedBy(projectId, actor(res))) return fail(404, 'NOT_FOUND', 'not found');
    const project = getProject(db, projectId);
    const conversation = getConversation(db, conversationId);
    if (!project || !conversation || conversation.projectId !== projectId) return fail(404, 'NOT_FOUND', 'not found');
    const metadata = project.metadata as Record<string, unknown> | null | undefined;
    if (metadata?.baseDir || metadata?.linkedDirs || metadata?.imported) return fail(403, 'MULTIUSER_IMPORTED_PROJECT_FORBIDDEN', 'managed projects only');
    if (!isSafeId(projectId)) return fail(404, 'NOT_FOUND', 'not found');
    const cwd = path.join(projectsRoot, projectId);
    const realRoot = fs.realpathSync(projectsRoot);
    // Project creation may leave the managed directory lazy until its first run.
    fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
    let realCwd: string;
    try { realCwd = fs.realpathSync(cwd); } catch { return fail(404, 'NOT_FOUND', 'not found'); }
    if (path.dirname(realCwd) !== realRoot) return fail(403, 'MULTIUSER_IMPORTED_PROJECT_FORBIDDEN', 'managed projects only');
    fs.chmodSync(realCwd, 0o700);
    return { projectId, conversationId };
  };
  const createPersonalRun = (inputBody: Record<string, unknown>, res: Response) => {
    if (inputBody.agentId !== 'codex' || inputBody.model !== undefined || inputBody.provider !== undefined ||
        Object.keys(inputBody).some((key) => !['projectId', 'conversationId', 'agentId', 'executionSource', 'message'].includes(key))) {
      return sendApiError(res, 403, 'MULTIUSER_AGENT_FORBIDDEN', 'personal subscription runs use the linked Codex account only');
    }
    if (!personal?.enabled) return sendApiError(res, 403, 'MULTIUSER_PERSONAL_DISABLED', 'personal subscriptions are not enabled on this server');
    const target = managedTarget(inputBody, res);
    if (!target) return;
    if (typeof inputBody.message !== 'string' || inputBody.message.length > 64_000) return sendApiError(res, 400, 'BAD_REQUEST', 'invalid run request');
    const request = JSON.stringify({ message: inputBody.message });
    if (Buffer.byteLength(request, 'utf8') > 64 * 1024) return sendApiError(res, 400, 'BAD_REQUEST', 'run request is too large');
    const owner = actor(res);
    // Never fall back: an unusable personal account is an error, not a company run.
    const account = personal.usableAccount(owner);
    if (!account) {
      personal.audit(owner, owner, 'run_rejected', 'MULTIUSER_PERSONAL_UNAVAILABLE');
      return sendApiError(res, 409, 'MULTIUSER_PERSONAL_UNAVAILABLE', 'no usable personal Codex account; link or re-authorize it');
    }
    const session = personalSession(target.conversationId);
    const companyHistory = db.prepare(`SELECT 1 FROM ${table} WHERE conversation_id = ? AND ${company} LIMIT 1`).get(target.conversationId);
    if ((session && session.personal_account_id !== account.id) || companyHistory) {
      personal.audit(owner, owner, 'run_rejected', 'MULTIUSER_EXECUTION_SOURCE_MISMATCH');
      return sendApiError(res, 409, 'MULTIUSER_EXECUTION_SOURCE_MISMATCH', 'this conversation continues on another execution source or account');
    }
    const queuedCount = (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE owner_account_id = ? AND status = 'queued' AND ${personalRows}`)
      .get(owner) as { n: number }).n;
    if (queuedCount >= PERSONAL_QUEUE_LIMIT) return sendApiError(res, 409, 'MULTIUSER_PERSONAL_QUEUE_LIMIT', 'personal queue limit reached');
    const id = randomUUID();
    const createdAt = now();
    db.transaction(() => {
      db.prepare(`INSERT INTO ${table} (id, owner_account_id, project_id, conversation_id, status, created_at, updated_at, request_json,
        queue_seq, execution_source, personal_account_id, credential_version)
        VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, (SELECT COALESCE(MAX(queue_seq), 0) + 1 FROM ${table}), 'personal_subscription', ?, ?)`)
        .run(id, owner, target.projectId, target.conversationId, createdAt, createdAt, request, account.id, account.credentialVersion);
      // The first personal run pins the conversation to this account and its native session.
      db.prepare(`INSERT OR IGNORE INTO multiuser_personal_sessions (conversation_id, owner_account_id, personal_account_id, updated_at)
        VALUES (?, ?, ?, ?)`).run(target.conversationId, owner, account.id, createdAt);
    })();
    personal.audit(owner, owner, 'run_routed', 'personal_subscription', id);
    emit(id, 'queued', { runId: id });
    dispatchPersonal();
    res.status(202).json({ run: body(row(id)!) });
  };
  app.post('/api/runs', (req, res) => {
    const inputBody = req.body as Record<string, unknown> | null;
    if (!inputBody || typeof inputBody !== 'object' || Array.isArray(inputBody)) return sendApiError(res, 400, 'BAD_REQUEST', 'invalid run request');
    const source = inputBody.executionSource;
    if (source !== undefined && source !== 'company_pool' && source !== 'personal_subscription') {
      return sendApiError(res, 400, 'BAD_REQUEST', 'invalid execution source');
    }
    if (source === 'personal_subscription') return createPersonalRun(inputBody, res);
    if (inputBody.agentId !== 'test-mock' || inputBody.model !== undefined || inputBody.provider !== undefined ||
        Object.keys(inputBody).some((key) => !['projectId', 'conversationId', 'agentId', 'message', 'delayMs', 'executionSource'].includes(key))) {
      return sendApiError(res, 403, 'MULTIUSER_AGENT_FORBIDDEN', 'only the test mock is available');
    }
    if (!mockAgentScript) return sendApiError(res, 403, 'MULTIUSER_AGENT_FORBIDDEN', 'test mock is unavailable');
    const target = managedTarget(inputBody, res);
    if (!target) return;
    const { projectId, conversationId } = target;
    if (personalSession(conversationId)) {
      return sendApiError(res, 409, 'MULTIUSER_EXECUTION_SOURCE_MISMATCH', 'this conversation continues on a personal subscription');
    }
    if (typeof inputBody.message !== 'string' || inputBody.message.length > 64_000 ||
        (inputBody.delayMs !== undefined && (!Number.isInteger(inputBody.delayMs) || Number(inputBody.delayMs) < 0 || Number(inputBody.delayMs) > 2000))) {
      return sendApiError(res, 400, 'BAD_REQUEST', 'invalid mock request');
    }
    const mockRequest = JSON.stringify({ message: inputBody.message, delayMs: inputBody.delayMs });
    if (Buffer.byteLength(mockRequest, 'utf8') > 64 * 1024) {
      return sendApiError(res, 400, 'BAD_REQUEST', 'mock request is too large');
    }
    if (ledger.balance(actor(res)).remainingMs === 0) return sendApiError(res, 429, 'MULTIUSER_QUOTA_EXHAUSTED', 'worker quota exhausted');
    const queuedCount = (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE owner_account_id = ? AND status = 'queued' AND ${company}`)
      .get(actor(res)) as { n: number }).n;
    if (queuedCount >= 3) return sendApiError(res, 409, 'MULTIUSER_QUEUE_LIMIT', 'queue limit reached');
    const id = randomUUID();
    const createdAt = now();
    db.prepare(`INSERT INTO ${table} (id, owner_account_id, project_id, conversation_id, status, created_at, updated_at, request_json, queue_seq)
      VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, (SELECT COALESCE(MAX(queue_seq), 0) + 1 FROM ${table}))`)
      .run(id, actor(res), projectId, conversationId, createdAt, createdAt, mockRequest);
    emit(id, 'queued', { runId: id });
    dispatch();
    res.status(202).json({ run: body(row(id)!) });
  });
  /**
   * Owner-only: the conversation is pinned to a personal account that is no
   * longer the owner's linked account. Re-authorization keeps the account row,
   * so only unlink (and any later new link) makes a pin stale. Foreign, missing
   * and unpinned conversations all answer false.
   */
  const personalPinStale = (owner: string, conversationId: string): boolean => {
    const pin = personalSession(conversationId);
    const projectId = pin ? getConversation(db, conversationId)?.projectId : undefined;
    if (!pin || !personal || pin.owner_account_id !== owner || !projectId || !owners.isOwnedBy(projectId, owner)) return false;
    return !personal.isOwner('accountId', pin.personal_account_id, owner);
  };
  app.get('/api/runs', (req, res) => {
    const query = parseRunListQuery(req.query);
    if (!query) return sendApiError(res, 400, 'BAD_REQUEST', 'invalid run list query');
    const owner = actor(res);
    // Ownership and filters apply in SQL before the limit, so a page is never short of the owner's rows.
    const where = ['r.owner_account_id = ?', 'o.owner_account_id = ?'];
    const args: Array<string | number> = [owner, owner];
    if (query.projectId !== undefined) { where.push('r.project_id = ?'); args.push(query.projectId); }
    if (query.conversationId !== undefined) { where.push('r.conversation_id = ?'); args.push(query.conversationId); }
    if (query.status !== undefined) { where.push('r.status = ?'); args.push(query.status); }
    if (query.cursor) {
      where.push('(r.created_at < ? OR (r.created_at = ? AND r.id < ?))');
      args.push(query.cursor.createdAt, query.cursor.createdAt, query.cursor.id);
    }
    const rows = db.prepare(`SELECT r.* FROM ${table} r JOIN ${PROJECT_OWNERS_TABLE} o ON o.project_id = r.project_id
      WHERE ${where.join(' AND ')} ORDER BY r.created_at DESC, r.id DESC LIMIT ?`).all(...args, query.limit + 1) as RunRow[];
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    const response: MultiUserRunsResponse = {
      runs: page.map(body), awaitingInputProjectIds: [],
      nextCursor: rows.length > query.limit && last ? `${last.created_at}:${last.id}` : null,
      ...(query.conversationId === undefined ? {} : { personalPinStale: personalPinStale(owner, query.conversationId) }),
    };
    res.json(response);
  });
  app.get('/api/runs/:id', (req, res) => { const run = owned(req, res); if (run) res.json(body(run)); });
  app.get('/api/runs/:id/events', (req, res) => {
    const run = owned(req, res);
    if (!run) return;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-store');
    const events = db.prepare('SELECT seq, event, data FROM multiuser_run_events WHERE run_id = ? ORDER BY seq').all(run.id) as Array<{ seq: number; event: string; data: string }>;
    for (const event of events) res.write(`id: ${event.seq}\nevent: ${event.event}\ndata: ${event.data}\n\n`);
    if (run.status !== 'active' && run.status !== 'queued') { res.end(); return; }
    const set = listeners.get(run.id) ?? new Set<Response>();
    set.add(res);
    listeners.set(run.id, set);
    res.on('close', () => { set.delete(res); if (set.size === 0) listeners.delete(run.id); });
  });
  app.post('/api/runs/:id/cancel', (req, res) => {
    const run = owned(req, res);
    if (!run) return;
    if (run.status === 'active') {
      const child = children.get(run.id);
      if (child) {
        cancelPending.add(run.id);
        child.once('close', () => res.json(body(row(run.id)!)));
        child.kill('SIGTERM');
        return;
      }
    }
    finish(run.id, 'canceled');
    res.json(body(row(run.id)!));
  });
  const beginShutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    for (const set of listeners.values()) for (const res of set) res.end();
    listeners.clear();
  };
  let shutdownPromise: Promise<void> | null = null;
  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    beginShutdown();
    shutdownPromise = (async () => {
      const exits = [...children.values()].map((child) => new Promise<void>((resolve) => child.once('close', () => resolve())));
      const wait = async (ms: number) => {
        if (children.size === 0) return;
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([Promise.all(exits), new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); })]);
        if (timer) clearTimeout(timer);
      };
      for (const child of children.values()) child.kill('SIGTERM');
      await wait(2_000);
      if (children.size > 0) {
        for (const child of children.values()) child.kill('SIGKILL');
        await wait(1_000);
      }
      for (const id of children.keys()) finish(id, 'failed', { reason: 'shutdown_timeout' });
      storesClosed = true;
      ledger.close();
      accounts.close();
    })();
    return shutdownPromise;
  };
  return {
    isRunOwner(runId, accountId) {
      const found = row(runId);
      return !!found && found.owner_account_id === accountId && owners.isOwnedBy(found.project_id, accountId);
    },
    cancelAccountRuns(accountId) {
      const active = db.prepare(`SELECT id FROM ${table} WHERE owner_account_id = ? AND status IN ('active','queued')`).all(accountId) as Array<{ id: string }>;
      suspendDispatch = true;
      try {
        for (const run of active) {
          const child = children.get(run.id);
          if (child) { cancelPending.add(run.id); child.kill('SIGTERM'); }
          else finish(run.id, 'canceled');
        }
      } finally { suspendDispatch = false; }
      dispatch();
      dispatchPersonal();
    },
    cancelPersonalRuns,
    // A subscription switch: pinned conversations keep their account but start a fresh native thread.
    forgetNativeSessions(accountId) {
      db.prepare('UPDATE multiuser_personal_sessions SET thread_id = NULL, updated_at = ? WHERE owner_account_id = ?').run(now(), accountId);
    },
    personalLane,
    listAccountIds: () => accounts.listAccounts().map((account) => account.id),
    beginShutdown,
    shutdown,
  };
}
