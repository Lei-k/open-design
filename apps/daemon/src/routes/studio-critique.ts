import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { Express, Request, Response } from 'express';
import { defaultCritiqueConfig, isPanelEvent, type CritiqueSseEvent } from '@open-design/contracts/critique';
import type { StudioCritiqueResponse, StudioCritiqueRunsResponse, StudioCritiqueTranscriptResponse } from '@open-design/contracts';
import { getCritiqueRun, reconcileStaleRuns, updateCritiqueRun } from '../critique/persistence.js';
import { mimeForExtension } from '../critique/artifact-writer.js';
import { STUDIO_CRITIQUE_MAX_BYTES, studioCritiqueDirectory } from '../critique/studio.js';
import { sendApiError } from '../http/api-errors.js';
import { bindMultiUserStream, multiUserStreamAllowed } from '../http/multiuser-stream.js';
import { multiUserActorOf } from '../http/multiuser-gate.js';

type Run = { id: string; owner_account_id: string; project_id: string; status: 'queued' | 'active' | 'succeeded' | 'failed' | 'canceled'; request_json: string | null };
export function registerStudioCritiqueRoutes(app: Express, input: {
  db: Database.Database; dataRoot: string;
  owned(req: Request, res: Response, id: string): Run | null;
  canView(projectId: string, accountId: string): boolean;
  start(body: Record<string, unknown>, res: Response): Promise<unknown>;
  interrupt(run: Run, res: Response): void;
}) {
  const { db } = input;
  db.exec(`CREATE TABLE IF NOT EXISTS studio_critique_events (
    run_id TEXT NOT NULL REFERENCES multiuser_runs(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL, event TEXT NOT NULL, data TEXT NOT NULL,
    PRIMARY KEY(run_id, seq))`);
  const stale = db.prepare(`SELECT c.id FROM critique_runs c JOIN multiuser_runs r ON r.id = c.id
    WHERE c.status IN ('running', 'interrupted') AND r.status NOT IN ('active', 'queued')
    AND json_valid(r.request_json) AND json_extract(r.request_json, '$.critique') = 1`).all() as Array<{ id: string }>;
  if (stale.length) reconcileStaleRuns(db, { staleAfterMs: 0, now: Date.now() + 1, runIds: stale.map((row) => row.id) });
  const listeners = new Map<string, Set<Response>>();
  const isCritique = (run: Run) => { try { return JSON.parse(run.request_json ?? '{}').critique === true; } catch { return false; } };
  const resolve = (req: Request, res: Response) => {
    if (!multiUserStreamAllowed(res)) return null;
    const run = input.owned(req, res, String(req.params.runId));
    if (!run) return null;
    const critique = getCritiqueRun(db, run.id);
    if (run.project_id !== req.params.projectId || !isCritique(run) || critique && critique.projectId !== run.project_id) { sendApiError(res, 404, 'NOT_FOUND', 'run not found'); return null; }
    return run;
  };
  const frames = (id: string, after = 0) => db.prepare('SELECT seq, event, data FROM studio_critique_events WHERE run_id = ? AND seq > ? ORDER BY seq')
    .all(id, after) as Array<{ seq: number; event: string; data: string }>;
  const terminal = (id: string) => Boolean(db.prepare(`SELECT 1 FROM studio_critique_events WHERE run_id = ?
    AND event IN ('critique.ship', 'critique.interrupted', 'critique.failed', 'critique.degraded') LIMIT 1`).get(id));
  const prefix = '/api/multiuser/projects/:projectId/critique';
  app.post(prefix, async (req, res) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || req.body.projectId !== undefined && req.body.projectId !== req.params.projectId) {
      sendApiError(res, 400, 'BAD_REQUEST', 'invalid critique request'); return;
    }
    await input.start({ ...req.body, projectId: req.params.projectId, critique: true }, res);
  });
  app.get(prefix, (req, res) => {
    const owner = multiUserActorOf(res)?.accountId ?? '';
    if (!input.canView(String(req.params.projectId), owner)) { sendApiError(res, 404, 'NOT_FOUND', 'run not found'); return; }
    const runs = db.prepare(`SELECT id FROM multiuser_runs WHERE project_id = ? AND owner_account_id = ?
      AND json_valid(request_json) AND json_extract(request_json, '$.critique') = 1 ORDER BY created_at DESC, id DESC LIMIT 50`)
      .all(req.params.projectId, owner) as Array<{ id: string }>;
    res.json({ runs } satisfies StudioCritiqueRunsResponse);
  });
  app.get(`${prefix}/:runId`, (req, res) => {
    const run = resolve(req, res); if (!run) return;
    const critique = getCritiqueRun(db, run.id);
    res.json({ runId: run.id, status: run.status, critique: critique ? {
      status: critique.status, score: critique.score, rounds: critique.rounds, protocolVersion: critique.protocolVersion,
      artifactAvailable: critique.artifactPath !== null,
    } : null } satisfies StudioCritiqueResponse);
  });
  app.get(`${prefix}/:runId/transcript`, (req, res) => {
    const run = resolve(req, res); if (!run) return;
    res.setHeader('Cache-Control', 'no-store');
    res.json({ events: frames(run.id).map((frame) => ({ ...JSON.parse(frame.data), type: frame.event.slice('critique.'.length) }))
      .filter(isPanelEvent) } satisfies StudioCritiqueTranscriptResponse);
  });
  app.get(`${prefix}/:runId/events`, (req, res) => {
    const run = resolve(req, res); if (!run) return;
    const cursor = req.get('Last-Event-ID') ?? req.query.after ?? '0';
    const last = frames(run.id).at(-1)?.seq ?? 0;
    if (typeof cursor !== 'string' || !/^\d{1,15}$/.test(cursor) || Number(cursor) > last) {
      sendApiError(res, 400, 'BAD_REQUEST', 'invalid event cursor'); return;
    }
    res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Accel-Buffering', 'no'); bindMultiUserStream(res);
    for (const frame of frames(run.id, Number(cursor))) {
      if (!multiUserStreamAllowed(res)) return;
      res.write(`id: ${frame.seq}\nevent: ${frame.event}\ndata: ${frame.data}\n\n`);
    }
    if (!['active', 'queued'].includes(run.status)) { res.end(); return; }
    const set = listeners.get(run.id) ?? new Set<Response>(); set.add(res); listeners.set(run.id, set);
    res.on('close', () => { set.delete(res); if (!set.size) listeners.delete(run.id); });
  });
  app.post(`${prefix}/:runId/interrupt`, (req, res) => { const run = resolve(req, res); if (!run) return;
    if (!['active', 'queued'].includes(run.status) || terminal(run.id) || getCritiqueRun(db, run.id)?.status && getCritiqueRun(db, run.id)?.status !== 'running') {
      sendApiError(res, 409, 'CONFLICT', 'critique is already terminal'); return;
    }
    input.interrupt(run, res); });
  app.get(`${prefix}/:runId/artifact`, async (req, res) => {
    const run = resolve(req, res); if (!run) return;
    const refusal = () => { if (!res.headersSent) sendApiError(res, 404, 'NOT_FOUND', 'run not found'); else res.destroy(); };
    const file = getCritiqueRun(db, run.id)?.artifactPath;
    if (!file) { refusal(); return; }
    const directory = studioCritiqueDirectory(input.dataRoot, run.owner_account_id, run.project_id, run.id);
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      if (path.dirname(file) !== directory || await fs.realpath(directory) !== directory) { refusal(); return; }
      if (!resolve(req, res)) return;
      handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const stat = await handle.stat();
      if (!resolve(req, res)) return;
      if (!stat.isFile() || stat.size > STUDIO_CRITIQUE_MAX_BYTES) { refusal(); return; }
      res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Type', mimeForExtension(path.extname(file)));
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox");
      // Bounded reads from one no-follow fd; a file growing after stat cannot
      // exceed the cap. Recheck cookie/project/run authority after every await.
      let offset = 0;
      while (offset < stat.size) {
        if (!resolve(req, res)) return;
        const buffer = Buffer.alloc(Math.min(64 * 1024, stat.size - offset));
        const read = await handle.read(buffer, 0, buffer.length, offset);
        if (!multiUserStreamAllowed(res) || !resolve(req, res)) return;
        if (!read.bytesRead) break;
        offset += read.bytesRead;
        if (!res.write(buffer.subarray(0, read.bytesRead))) await new Promise<void>((done) => {
          res.once('drain', done); res.once('close', done);
        });
      }
      res.end();
    } catch { refusal(); } finally { await handle?.close().catch(() => {}); }
  });
  const emit = (id: string, event: CritiqueSseEvent) => {
      const seq = (db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM studio_critique_events WHERE run_id = ?').get(id) as { n: number }).n;
      const data = JSON.stringify(event.data);
      db.prepare('INSERT INTO studio_critique_events VALUES (?, ?, ?, ?)').run(id, seq, event.event, data);
      for (const res of listeners.get(id) ?? []) if (multiUserStreamAllowed(res)) res.write(`id: ${seq}\nevent: ${event.event}\ndata: ${data}\n\n`);
  };
  const closeReplay = (id: string, status: 'failed' | 'canceled') => {
    if (terminal(id)) return;
    const run = db.prepare('SELECT * FROM multiuser_runs WHERE id = ?').get(id) as Run | undefined;
    if (!run || !isCritique(run)) return;
    const saved = frames(id);
    // A queued cancellation or crash before orchestration has no protocol
    // header yet. The Theater reducer needs one to accept a terminal frame.
    if (!saved.some((frame) => frame.event === 'critique.run_started')) {
      const cfg = defaultCritiqueConfig();
      emit(id, { event: 'critique.run_started', data: { runId: id, protocolVersion: cfg.protocolVersion,
        cast: cfg.cast, maxRounds: cfg.maxRounds, threshold: cfg.scoreThreshold, scale: cfg.scoreScale } });
    }
    const rounds = saved.filter((frame) => frame.event === 'critique.round_end')
      .map((frame) => JSON.parse(frame.data) as { round: number; composite: number });
    const best = rounds.reduce<{ round: number; composite: number } | null>((current, round) =>
      !current || round.composite > current.composite ? round : current, null);
    emit(id, status === 'canceled'
      ? { event: 'critique.interrupted', data: { runId: id, bestRound: best?.round ?? 0, composite: best?.composite ?? 0 } }
      : { event: 'critique.failed', data: { runId: id, cause: 'orchestrator_internal' } });
  };
  // Boot recovery also closes the private replay, including rows already
  // reconciled by the daemon's earlier age-based scan. Never publish handles
  // from unfinished artifact/transcript writes after a crash.
  for (const { id } of stale) if (!terminal(id)) {
    updateCritiqueRun(db, id, { artifactPath: null, transcriptPath: null });
    closeReplay(id, 'canceled');
  }
  // Parent recovery may finish a turn that crashed before its critique row
  // existed. Close that actor's private replay too, without starting a source.
  for (const run of db.prepare(`SELECT * FROM multiuser_runs WHERE status IN ('failed', 'canceled')
    AND json_valid(request_json) AND json_extract(request_json, '$.critique') = 1`).all() as Run[]) {
    closeReplay(run.id, run.status === 'canceled' ? 'canceled' : 'failed');
  }
  return { emit, terminal, finish(id: string, status: 'succeeded' | 'failed' | 'canceled') {
    const critique = getCritiqueRun(db, id);
    if (critique?.status === 'running' && status !== 'succeeded') {
      updateCritiqueRun(db, id, { status: status === 'canceled' ? 'interrupted' : 'failed', artifactPath: null, transcriptPath: null });
    }
    // The orchestrator may already have finalized metadata after losing
    // effect authority. Persist the outcome independently of that row state.
    if (status !== 'succeeded') closeReplay(id, status);
    for (const res of listeners.get(id) ?? []) res.end(); listeners.delete(id);
  } };
}
