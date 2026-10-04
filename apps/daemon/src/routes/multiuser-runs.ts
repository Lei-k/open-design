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
import { isSafeId } from '../projects.js';

type RunRow = {
  id: string; owner_account_id: string; project_id: string; conversation_id: string;
  status: string; created_at: number; updated_at: number; output: string | null;
};

const table = 'multiuser_runs';

/** Separate test-only execution plane. The normal run/agent stack is never reached. */
export function registerMultiUserRunRoutes(app: Express, input: {
  db: Database.Database;
  dataRoot: string;
  projectsRoot: string;
  mockAgentScript?: string;
  repositoryRoot: string;
}): { cancelAccountRuns(accountId: string): void; isRunOwner(runId: string, accountId: string): boolean; shutdown(): void } {
  const { db, dataRoot, projectsRoot } = input;
  const expected = fs.realpathSync(path.join(input.repositoryRoot, 'mocks/run-isolation-agent.ts'));
  const mockAgentScript = input.mockAgentScript ? fs.realpathSync(input.mockAgentScript) : null;
  if (mockAgentScript && mockAgentScript !== expected) throw new Error('multi-user mode refused: only the repository test mock may run');
  const owners = new ProjectOwnershipStore(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${table} (
      id TEXT PRIMARY KEY,
      owner_account_id TEXT NOT NULL CHECK (length(owner_account_id) > 0),
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('active','succeeded','failed','canceled')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      output TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_${table}_owner ON ${table}(owner_account_id, created_at DESC);
    CREATE TRIGGER IF NOT EXISTS ${table}_binding_immutable BEFORE UPDATE OF owner_account_id, project_id, conversation_id ON ${table}
      BEGIN SELECT RAISE(ABORT, 'run binding is immutable'); END;
    CREATE TABLE IF NOT EXISTS multiuser_run_events (
      run_id TEXT NOT NULL REFERENCES ${table}(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      event TEXT NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (run_id, seq)
    );
  `);
  // A process restart only changes runs that were still active. Terminal rows stay untouched.
  db.prepare(`UPDATE ${table} SET status = 'failed', updated_at = ? WHERE status = 'active'`).run(Date.now());
  const children = new Map<string, ChildProcessWithoutNullStreams>();
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
  const body = (run: RunRow) => ({
    id: run.id, projectId: run.project_id, conversationId: run.conversation_id,
    agentId: 'test-mock', status: run.status, createdAt: run.created_at,
    updatedAt: run.updated_at, output: run.output ? JSON.parse(run.output) : null,
  });
  const emit = (id: string, event: string, data: unknown) => {
    const seq = (db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM multiuser_run_events WHERE run_id = ?').get(id) as { seq: number }).seq;
    const payload = JSON.stringify(data);
    db.prepare('INSERT INTO multiuser_run_events (run_id, seq, event, data) VALUES (?, ?, ?, ?)').run(id, seq, event, payload);
    for (const res of listeners.get(id) ?? []) res.write(`id: ${seq}\nevent: ${event}\ndata: ${payload}\n\n`);
  };
  const finish = (id: string, status: 'succeeded' | 'failed' | 'canceled', output?: unknown) => {
    const existing = row(id);
    if (!existing || existing.status !== 'active') return;
    db.prepare(`UPDATE ${table} SET status = ?, output = ?, updated_at = ? WHERE id = ?`)
      .run(status, output === undefined ? null : JSON.stringify(output), Date.now(), id);
    emit(id, 'end', { status, ...(output === undefined ? {} : { output }) });
    for (const res of listeners.get(id) ?? []) res.end();
    listeners.delete(id);
    children.delete(id);
  };
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
    const id = randomUUID();
    const now = Date.now();
    const actorDir = createHash('sha256').update(actor(res)).digest('hex');
    const runHome = path.join(dataRoot, 'multiuser-runtime', actorDir, id);
    const temp = path.join(runHome, 'tmp');
    fs.mkdirSync(temp, { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(runHome), 0o700);
    fs.chmodSync(runHome, 0o700);
    fs.chmodSync(temp, 0o700);
    // The DB insert atomically binds the immutable actor/project/conversation triple.
    db.prepare(`INSERT INTO ${table} (id, owner_account_id, project_id, conversation_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)`)
      .run(id, actor(res), projectId, conversationId, now, now);
    emit(id, 'start', { runId: id });
    const child = spawn(process.execPath, [mockAgentScript], {
      cwd: realCwd,
      env: { HOME: runHome, TMPDIR: temp, TMP: temp, TEMP: temp, OD_DATA_DIR: dataRoot },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    children.set(id, child);
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', () => {});
    // A cancelled child may close its pipe while a write is still pending.
    // Handle EPIPE instead of letting a stream error terminate the daemon.
    child.stdin.on('error', () => { child.kill('SIGTERM'); finish(id, 'failed'); });
    child.on('error', () => finish(id, 'failed'));
    child.on('close', (code) => {
      if (code !== 0) return finish(id, 'failed');
      try {
        const output = JSON.parse(stdout.trim()) as unknown;
        emit(id, 'agent', output);
        finish(id, 'succeeded', output);
      } catch { finish(id, 'failed'); }
    });
    child.stdin.end(mockRequest);
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
    if (run.status !== 'active') { res.end(); return; }
    const set = listeners.get(run.id) ?? new Set<Response>();
    set.add(res);
    listeners.set(run.id, set);
    res.on('close', () => { set.delete(res); if (set.size === 0) listeners.delete(run.id); });
  });
  app.post('/api/runs/:id/cancel', (req, res) => {
    const run = owned(req, res);
    if (!run) return;
    children.get(run.id)?.kill('SIGTERM');
    finish(run.id, 'canceled');
    res.json(body(row(run.id)!));
  });
  return {
    isRunOwner(runId, accountId) {
      const found = row(runId);
      return !!found && found.owner_account_id === accountId && owners.isOwnedBy(found.project_id, accountId);
    },
    cancelAccountRuns(accountId) {
      const active = db.prepare(`SELECT id FROM ${table} WHERE owner_account_id = ? AND status = 'active'`).all(accountId) as Array<{ id: string }>;
      for (const run of active) { children.get(run.id)?.kill('SIGTERM'); finish(run.id, 'canceled'); }
    },
    shutdown() { for (const child of children.values()) child.kill('SIGTERM'); },
  };
}
