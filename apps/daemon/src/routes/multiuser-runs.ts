import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { Express, Request, Response } from 'express';
import { getConversation, getProject } from '../db.js';
import { sendApiError } from '../http/api-errors.js';
import { multiUserActorOf } from '../http/multiuser-gate.js';
import { ProjectOwnershipStore } from '../storage/project-ownership.js';
import { WorkerQuotaLedger } from '../storage/worker-quota-ledger.js';
import { AuthStore } from '../storage/auth-store.js';
import { isSafeId } from '../projects.js';

type RunRow = {
  id: string; owner_account_id: string; project_id: string; conversation_id: string;
  status: string; created_at: number; updated_at: number; output: string | null;
  request_json: string | null; queue_seq: number | null;
};

const table = 'multiuser_runs';

/** Separate test-only execution plane. The normal run/agent stack is never reached. */
export function registerMultiUserRunRoutes(app: Express, input: {
  db: Database.Database;
  dataRoot: string;
  projectsRoot: string;
  mockAgentScript?: string;
  repositoryRoot: string;
  clock?: () => number;
}): { cancelAccountRuns(accountId: string): void; isRunOwner(runId: string, accountId: string): boolean; shutdown(): void } {
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
  const recovery = db.prepare(`SELECT * FROM ${table} WHERE status = 'active'`).all() as RunRow[];
  const ledgerActive = ledger.activeRuns();
  for (const run of recovery) {
    if (ledgerActive.some((entry) => entry.runId === run.id && entry.actorId === run.owner_account_id)) {
      ledger.finish(run.owner_account_id, run.id);
    }
    db.prepare(`UPDATE ${table} SET status = 'failed', updated_at = ? WHERE id = ?`).run(now(), run.id);
  }
  for (const entry of ledgerActive) {
    if (!recovery.some((run) => run.id === entry.runId)) {
      ledger.finish(entry.actorId, entry.runId);
      // A crash between ledger admission and the run-row update is the only
      // queued row that cannot safely replay the same immutable ledger run id.
      db.prepare(`UPDATE ${table} SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'queued'`)
        .run(now(), entry.runId);
    }
  }
  const children = new Map<string, ChildProcessWithoutNullStreams>();
  const cancelPending = new Set<string>();
  const failurePending = new Set<string>();
  let shuttingDown = false;
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
    WHERE status = 'queued' AND owner_account_id = ? AND queue_seq <= ?`).get(run.owner_account_id, run.queue_seq) as { n: number }).n : null;
  const body = (run: RunRow) => ({
    id: run.id, projectId: run.project_id, conversationId: run.conversation_id,
    agentId: 'test-mock', status: run.status === 'active' ? 'running' : run.status,
    queuePosition: queuePosition(run), createdAt: run.created_at,
    updatedAt: run.updated_at, output: run.output ? JSON.parse(run.output) : null,
  });
  const emit = (id: string, event: string, data: unknown) => {
    const seq = (db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM multiuser_run_events WHERE run_id = ?').get(id) as { seq: number }).seq;
    const payload = JSON.stringify(data);
    db.prepare('INSERT INTO multiuser_run_events (run_id, seq, event, data) VALUES (?, ?, ?, ?)').run(id, seq, event, payload);
    for (const res of listeners.get(id) ?? []) res.write(`id: ${seq}\nevent: ${event}\ndata: ${payload}\n\n`);
  };
  let dispatching = false;
  let suspendDispatch = false;
  let retryTimer: NodeJS.Timeout | null = null;
  let dispatch = () => {};
  const finish = (id: string, status: 'succeeded' | 'failed' | 'canceled', output?: unknown) => {
    if (shuttingDown) return;
    const existing = row(id);
    if (!existing || (existing.status !== 'active' && existing.status !== 'queued')) return;
    if (existing.status === 'active') {
      if (status === 'canceled') ledger.cancel(existing.owner_account_id, id);
      else ledger.finish(existing.owner_account_id, id);
    }
    db.prepare(`UPDATE ${table} SET status = ?, output = ?, updated_at = ? WHERE id = ?`)
      .run(status, output === undefined ? null : JSON.stringify(output), now(), id);
    emit(id, 'end', { status, ...(output === undefined ? {} : { output }) });
    for (const res of listeners.get(id) ?? []) res.end();
    listeners.delete(id);
    children.delete(id);
    cancelPending.delete(id);
    failurePending.delete(id);
    if (!suspendDispatch) dispatch();
  };
  const capacity = () => Number((db.prepare("SELECT value FROM multiuser_pool_config WHERE key = 'test-mock-capacity'").get() as { value: string } | undefined)?.value ?? '2');
  dispatch = () => {
    if (dispatching || shuttingDown || !mockAgentScript) return;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    dispatching = true;
    try {
      while ((db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE status = 'active'`).get() as { n: number }).n < capacity()) {
        const queued = db.prepare(`SELECT * FROM ${table} WHERE status = 'queued' ORDER BY queue_seq`).all() as RunRow[];
        const lastActor = (db.prepare("SELECT value FROM multiuser_pool_config WHERE key = 'last-actor'").get() as { value: string } | undefined)?.value;
        const eligible = queued.filter((run) => ledger.balance(run.owner_account_id).remainingMs > 0 &&
          !(db.prepare(`SELECT 1 FROM ${table} WHERE owner_account_id = ? AND status = 'active'`).get(run.owner_account_id)));
        const next = eligible.find((run) => run.owner_account_id !== lastActor) ?? eligible[0];
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
        if (admission.status !== 'started') break;
        db.prepare(`UPDATE ${table} SET status = 'active', updated_at = ? WHERE id = ?`).run(now(), next.id);
        db.prepare("INSERT INTO multiuser_pool_config (key, value) VALUES ('last-actor', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
          .run(next.owner_account_id);
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
      const waiting = db.prepare(`SELECT 1 FROM ${table} WHERE status = 'queued' LIMIT 1`).get();
      const active = (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE status = 'active'`).get() as { n: number }).n;
      if (waiting && active < capacity() && capacity() > 0) {
        retryTimer = setTimeout(() => { retryTimer = null; dispatch(); }, 60_000);
        retryTimer.unref();
      }
    }
  };
  app.get('/api/admin/pool', (_req, res) => {
    const active = (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE status = 'active'`).get() as { n: number }).n;
    const queued = (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE status = 'queued'`).get() as { n: number }).n;
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
  app.post('/api/runs', (req, res) => {
    const inputBody = req.body as Record<string, unknown> | null;
    if (!inputBody || typeof inputBody !== 'object' || Array.isArray(inputBody)) return sendApiError(res, 400, 'BAD_REQUEST', 'invalid run request');
    if (inputBody.agentId !== 'test-mock' || inputBody.model !== undefined || inputBody.provider !== undefined ||
        Object.keys(inputBody).some((key) => !['projectId', 'conversationId', 'agentId', 'message', 'delayMs'].includes(key))) {
      return sendApiError(res, 403, 'MULTIUSER_AGENT_FORBIDDEN', 'only the test mock is available');
    }
    if (!mockAgentScript) return sendApiError(res, 403, 'MULTIUSER_AGENT_FORBIDDEN', 'test mock is unavailable');
    const projectId = inputBody.projectId;
    const conversationId = inputBody.conversationId;
    if (typeof projectId !== 'string' || typeof conversationId !== 'string' ||
        !owners.isOwnedBy(projectId, actor(res))) return sendApiError(res, 404, 'NOT_FOUND', 'not found');
    const project = getProject(db, projectId);
    const conversation = getConversation(db, conversationId);
    if (!project || !conversation || conversation.projectId !== projectId) return sendApiError(res, 404, 'NOT_FOUND', 'not found');
    const metadata = project.metadata as Record<string, unknown> | null | undefined;
    if (metadata?.baseDir || metadata?.linkedDirs || metadata?.imported) return sendApiError(res, 403, 'MULTIUSER_IMPORTED_PROJECT_FORBIDDEN', 'managed projects only');
    if (!isSafeId(projectId)) return sendApiError(res, 404, 'NOT_FOUND', 'not found');
    const cwd = path.join(projectsRoot, projectId);
    const realRoot = fs.realpathSync(projectsRoot);
    // Project creation may leave the managed directory lazy until its first run.
    fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
    let realCwd: string;
    try { realCwd = fs.realpathSync(cwd); } catch { return sendApiError(res, 404, 'NOT_FOUND', 'not found'); }
    if (path.dirname(realCwd) !== realRoot) return sendApiError(res, 403, 'MULTIUSER_IMPORTED_PROJECT_FORBIDDEN', 'managed projects only');
    fs.chmodSync(realCwd, 0o700);
    if (typeof inputBody.message !== 'string' || inputBody.message.length > 64_000 ||
        (inputBody.delayMs !== undefined && (!Number.isInteger(inputBody.delayMs) || Number(inputBody.delayMs) < 0 || Number(inputBody.delayMs) > 2000))) {
      return sendApiError(res, 400, 'BAD_REQUEST', 'invalid mock request');
    }
    const mockRequest = JSON.stringify({ message: inputBody.message, delayMs: inputBody.delayMs });
    if (Buffer.byteLength(mockRequest, 'utf8') > 64 * 1024) {
      return sendApiError(res, 400, 'BAD_REQUEST', 'mock request is too large');
    }
    if (ledger.balance(actor(res)).remainingMs === 0) return sendApiError(res, 429, 'MULTIUSER_QUOTA_EXHAUSTED', 'worker quota exhausted');
    const queuedCount = (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE owner_account_id = ? AND status = 'queued'`)
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
  app.get('/api/runs', (req, res) => {
    const rows = db.prepare(`SELECT * FROM ${table} WHERE owner_account_id = ? ORDER BY created_at DESC`)
      .all(actor(res)) as RunRow[];
    res.json({ runs: rows.filter((run) =>
      owners.isOwnedBy(run.project_id, actor(res)) &&
      (typeof req.query.projectId !== 'string' || run.project_id === req.query.projectId) &&
      (typeof req.query.conversationId !== 'string' || run.conversation_id === req.query.conversationId) &&
      (typeof req.query.status !== 'string' || run.status === req.query.status),
    ).map(body), awaitingInputProjectIds: [] });
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
    },
    shutdown() {
      shuttingDown = true;
      if (retryTimer) clearTimeout(retryTimer);
      for (const child of children.values()) child.kill('SIGTERM');
      for (const set of listeners.values()) for (const res of set) res.end();
      listeners.clear();
      ledger.close();
      accounts.close();
    },
  };
}
