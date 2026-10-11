import type Database from 'better-sqlite3';
import type { Express, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { isStudioLibraryIngestRequest, isStudioLibraryApplyRequest, type LibraryAssetFilter } from '@open-design/contracts';
import { multiUserActorOf, applyUntrustedContentPolicy, multiUserLibraryIngestAdmitted } from '../http/multiuser-gate.js';
import { bindMultiUserStream } from '../http/multiuser-stream.js';
import { sendApiError } from '../http/api-errors.js';
import { StudioLibrary, StudioLibraryError, studioLibraryExtensionOrigin } from '../services/studio-library.js';
import { ProjectAccessStore } from '../storage/project-access.js';
import { insertProject, insertConversation, setTabs } from '../db.js';
import type { AuthActor } from '../services/auth-service.js';
import { STUDIO_LIBRARY_TOOL_DESCRIPTORS } from '../services/studio-library-tools.js';
import { projectDir } from '../projects.js';

const tokenOf = (req: Request) => /^Bearer\s+(.+)$/i.exec(req.get('authorization') ?? '')?.[1];
const fieldsOnly = (body: unknown, fields: string[]) => body !== null && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).every((key) => fields.includes(key));
export function registerStudioLibraryRoutes(app: Express, input: { db: Database.Database; dataRoot: string; projectsRoot: string; accountActive(id: string): boolean; sessionCurrent(actor: AuthActor): boolean }) {
  const store = new StudioLibrary(input); const projects = new ProjectAccessStore(input.db, { accountActive: input.accountActive });
  const missing = (res: Response) => sendApiError(res, 404, 'NOT_FOUND', 'asset not found');
  const handle = (operation: (req: Request, res: Response, owner: string, current: () => boolean) => Promise<unknown> | unknown) => async (req: Request, res: Response) => {
    try {
      const actor = multiUserActorOf(res); const connected = () => !req.aborted && !res.destroyed;
      let owner = actor?.accountId; let current = () => connected() && Boolean(actor && input.sessionCurrent(actor));
      if (['/api/library/ingest', '/api/library/clipper-probe'].includes(req.route?.path) && (tokenOf(req) || studioLibraryExtensionOrigin(req.get('origin')))) {
        const token = tokenOf(req); const resolved = store.tokenOwner(token, req.get('origin'));
        if (!resolved || !token) return sendApiError(res, 401, 'UNAUTHORIZED', 'extension token required');
        owner = resolved; current = () => connected() && store.tokenOwner(token, req.get('origin')) === resolved;
      }
      if (!owner || !input.accountActive(owner) || !current()) return sendApiError(res, 401, 'UNAUTHORIZED', 'authentication required');
      await operation(req, res, owner, current);
    } catch (error) {
      const safe = error instanceof StudioLibraryError ? error : new StudioLibraryError(500, 'INTERNAL_ERROR');
      if (!res.headersSent && !res.writableEnded && !res.destroyed) sendApiError(res, safe.status, safe.code, safe.code === 'MULTIUSER_LIBRARY_LIMIT_REACHED' ? 'account library storage limit reached' : 'account library request refused');
    }
  };
  const cors = (req: Request, res: Response) => {
    const origin = studioLibraryExtensionOrigin(req.get('origin')); if (!origin) return false;
    res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization'); res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS'); return true;
  };
  app.post('/api/library/pair', handle((req, res, owner) => {
    if (!fieldsOnly(req.body ?? {}, [])) return sendApiError(res, 400, 'BAD_REQUEST', 'invalid pairing request');
    res.setHeader('Cache-Control', 'no-store'); res.json(store.pair(owner, multiUserActorOf(res)!));
  }));
  for (const route of ['/api/library/pair/confirm', '/api/library/ingest']) app.options(route, (req, res) => {
    if (!cors(req, res)) return sendApiError(res, 403, 'FORBIDDEN', 'extension origin required'); res.status(204).end();
  });
  app.post('/api/library/pair/confirm', (req, res) => {
    if (req.get('origin') !== undefined && (!cors(req, res) || req.get('origin') !== req.body?.extensionOrigin)) return sendApiError(res, 403, 'FORBIDDEN', 'extension origin required');
    try {
      if (!fieldsOnly(req.body, ['code', 'extensionOrigin', 'label'])) throw new StudioLibraryError(400, 'BAD_REQUEST');
      res.setHeader('Cache-Control', 'no-store'); res.json(store.confirm(req.body));
    } catch (error) { const safe = error instanceof StudioLibraryError ? error : new StudioLibraryError(500, 'INTERNAL_ERROR'); sendApiError(res, safe.status, safe.code, 'pairing refused'); }
  });
  app.post('/api/library/sync', (_req, res) => sendApiError(res, 403, 'MULTIUSER_CAPABILITY_UNAVAILABLE', 'host library sync is unavailable to Web accounts'));
  app.get('/api/library/connection', handle((_req, res, owner) => res.json(store.connection(owner))));
  app.delete('/api/library/tokens/:id', handle((req, res, owner) => store.revoke(owner, String(req.params.id)) ? res.json({ ok: true }) : missing(res)));
  app.post('/api/library/ingest', handle(async (req, res, owner, current) => {
    cors(req, res);
    const body = req.body;
    if (!isStudioLibraryIngestRequest(body)) return sendApiError(res, 400, 'BAD_REQUEST', 'invalid capture');
    const token = tokenOf(req); const result = await store.ingest(owner, body, current, Boolean(token), multiUserLibraryIngestAdmitted(res));
    // Successful ingest has committed. Revocation after commit cannot turn it into a refusal.
    if (token) store.touch(token); res.json(result);
  }));
  app.get('/api/library/clipper-probe', handle((_req, res) => res.json({ ok: true })));
  app.get('/api/library/assets', handle(async (req, res, owner, current) => {
    const filter: LibraryAssetFilter = {};
    for (const key of ['kind', 'tag', 'domain', 'date', 'q', 'source', 'projectId', 'designSystemId'] as const) if (typeof req.query[key] === 'string') Object.assign(filter, { [key]: req.query[key] });
    if (typeof req.query.limit === 'string') filter.limit = Number(req.query.limit);
    const assets = await store.list(owner, filter); if (!current()) throw new StudioLibraryError(401, 'UNAUTHORIZED'); res.json({ assets });
  }));
  app.get('/api/library/assets/:id', handle(async (req, res, owner, current) => {
    const asset = await store.get(owner, String(req.params.id)); if (!current()) throw new StudioLibraryError(401, 'UNAUTHORIZED'); return asset ? res.json({ asset }) : missing(res);
  }));
  app.delete('/api/library/assets/:id', handle(async (req, res, owner, current) => {
    const removed = await store.remove(owner, String(req.params.id), current); if (!current()) throw new StudioLibraryError(401, 'UNAUTHORIZED'); return removed ? res.json({ ok: true }) : missing(res);
  }));
  for (const kind of ['raw', 'figma', 'element'] as const) app.get(`/api/library/assets/:id/${kind}`, handle(async (req, res, owner, current) => {
    const result = await store.bytes(owner, String(req.params.id), kind); if (!current()) throw new StudioLibraryError(401, 'UNAUTHORIZED'); if (!result) return missing(res);
    applyUntrustedContentPolicy(res); res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Type', result.mime);
    if (kind === 'figma') res.setHeader('Content-Disposition', 'attachment; filename="capture.od-figma.json"'); res.send(result.bytes);
  }));
  const canWrite = (owner: string, projectId: string, current: () => boolean) => () => current() && projects.canWrite(projectId, owner);
  app.post('/api/library/assets/:id/apply', handle(async (req, res, owner, current) => {
    const id = String(req.params.id); if (!await store.get(owner, id)) return missing(res);
    if (!isStudioLibraryApplyRequest(req.body)) return sendApiError(res, 400, 'BAD_REQUEST', 'invalid project target');
    const check = canWrite(owner, req.body.projectId, current); if (!check()) return missing(res);
    const result = await store.apply(owner, id, req.body.projectId, input.projectsRoot, check, req.body.dir, req.body.includeElement === true);
    if (!check()) throw new StudioLibraryError(404, 'NOT_FOUND'); res.json(result);
  }));
  app.post('/api/library/assets/:id/edit-as-page', handle(async (req, res, owner, current) => {
    if (!fieldsOnly(req.body ?? {}, [])) return sendApiError(res, 400, 'BAD_REQUEST', 'invalid page request');
    const id = String(req.params.id); const asset = await store.get(owner, id); if (!asset) return missing(res);
    if (asset.kind !== 'html') return sendApiError(res, 400, 'BAD_REQUEST', 'HTML capture required');
    const raw = await store.bytes(owner, id); if (!raw) return missing(res);
    const projectId = randomUUID(); const conversationId = randomUUID(); const staging = path.join(input.dataRoot, 'studio-library-staging', randomUUID());
    const target = projectDir(input.projectsRoot, projectId); let published = false; let committed = false;
    try {
      await mkdir(staging, { recursive: true, mode: 0o700 }); if (!current()) throw new StudioLibraryError(401, 'UNAUTHORIZED'); await writeFile(path.join(staging, 'index.html'), raw.bytes, { flag: 'wx', mode: 0o600 });
      if (!current()) throw new StudioLibraryError(401, 'UNAUTHORIZED'); await mkdir(input.projectsRoot, { recursive: true }); if (!current()) throw new StudioLibraryError(401, 'UNAUTHORIZED'); await rename(staging, target); published = true;
      if (!current()) throw new StudioLibraryError(401, 'UNAUTHORIZED');
      input.db.transaction(() => {
        if (!current()) throw new StudioLibraryError(401, 'UNAUTHORIZED'); const now = Date.now();
        insertProject(input.db, { id: projectId, name: (asset.sourceTitle || 'Captured page').slice(0, 80), skillId: null, designSystemId: null,
          metadata: { kind: 'prototype', odLibraryAssetId: id }, pendingPrompt: null, createdAt: now, updatedAt: now });
        insertConversation(input.db, { id: conversationId, projectId, title: null, sessionMode: 'design', createdAt: now, updatedAt: now });
        projects.ownership.bindOwner(projectId, owner, now); projects.bindConversationAuthor(conversationId, owner); setTabs(input.db, projectId, ['index.html'], 'index.html');
      }).immediate(); committed = true;
      await store.link(owner, id, projectId, current);
      if (!current()) throw new StudioLibraryError(401, 'UNAUTHORIZED'); res.json({ projectId, conversationId, relPath: 'index.html' });
    } finally { await rm(staging, { recursive: true, force: true }); if (published && !committed) await rm(target, { recursive: true, force: true }); }
  }));
  app.get('/api/library/events', handle((_req, res, owner, current) => {
    res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-store'); res.flushHeaders(); bindMultiUserStream(res);
    const send = (event: string, data: unknown) => { if (current()) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    send('ready', { ok: true }); const unsubscribe = store.subscribe(owner, send); res.once('close', unsubscribe);
  }));
  const tools = (owner: string, projectId: string, current: () => boolean) => ({
    async execute(name: string, args: Record<string, unknown>) {
      const check = canWrite(owner, projectId, current); if (!check()) throw new StudioLibraryError(404, 'NOT_FOUND');
      if (name === 'library_search' && fieldsOnly(args, ['query', 'kind', 'date', 'limit'])) {
        if (args.limit !== undefined && (typeof args.limit !== 'number' || !Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 100)) throw new StudioLibraryError(400, 'BAD_REQUEST');
        const results = await store.list(owner, { q: typeof args.query === 'string' ? args.query : '', limit: typeof args.limit === 'number' ? args.limit : 20,
          ...(typeof args.kind === 'string' ? { kind: args.kind as NonNullable<LibraryAssetFilter['kind']> } : {}), ...(typeof args.date === 'string' ? { date: args.date } : {}) });
        if (!check()) throw new StudioLibraryError(404, 'NOT_FOUND'); return { results: results.map((asset) => ({ asset, score: 0 })), semantic: false };
      }
      if (name === 'library_apply' && fieldsOnly(args, ['assetId', 'dir', 'includeElement']) && typeof args.assetId === 'string' && (args.dir === undefined || typeof args.dir === 'string')) {
        if (!isStudioLibraryApplyRequest({ projectId, ...(args.dir === undefined ? {} : { dir: args.dir }), ...(args.includeElement === undefined ? {} : { includeElement: args.includeElement }) })) throw new StudioLibraryError(400, 'BAD_REQUEST');
        return store.apply(owner, args.assetId, projectId, input.projectsRoot, check, args.dir as string | undefined, args.includeElement === true, 'agent-task');
      }
      throw new StudioLibraryError(400, 'BAD_REQUEST');
    },
  });
  for (const operation of ['search', 'apply'] as const) app.post(`/api/tools/library/${operation}`, (_req, res) => sendApiError(res, 403, 'FORBIDDEN', 'library tools are available only within an owned run'));
  return { store, tools, descriptors: STUDIO_LIBRARY_TOOL_DESCRIPTORS };
}
export type StudioLibraryRuntime = ReturnType<typeof registerStudioLibraryRoutes>;
