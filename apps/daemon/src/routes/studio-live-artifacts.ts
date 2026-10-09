import type Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import type { LiveArtifact } from '@open-design/contracts';
import { getConversation, updateProject } from '../db.js';
import { multiUserActorOf } from '../http/multiuser-gate.js';
import { sendApiError } from '../http/api-errors.js';
import { ProjectAccessStore, type ProjectAccessOptions } from '../storage/project-access.js';
import { StudioLiveArtifacts, StudioLiveArtifactRefusal } from '../storage/studio-live-artifacts.js';
import { AuthStore } from '../storage/auth-store.js';

/** Shared viewer and session CLI use the same project-authorized database store.
 * The legacy worker-token/host-connector routes remain closed in multi-user mode. */
export function registerStudioLiveArtifactRoutes(app: Express, input: {
  db: Database.Database; projectsRoot: string; dataRoot: string; previewOrigin: string; allowedOrigins: string[]; clock?: () => number;
  onChanged?: (projectId: string, action: 'created' | 'updated' | 'deleted', artifact: LiveArtifact) => void;
} & ProjectAccessOptions): StudioLiveArtifacts & { close(): void } {
  const store = new StudioLiveArtifacts(input.db, input.projectsRoot);
  const auth = AuthStore.open({ dataRoot: input.dataRoot });
  const now = input.clock ?? Date.now;
  const previews = new Map<string, { project: string; artifact: string; actor: string; session: string; expires: number }>();
  const access = new ProjectAccessStore(input.db, input);
  const base = '/api/multiuser/live-artifacts';
  const changed = (project: string, action: 'created' | 'updated' | 'deleted', artifact: LiveArtifact) => {
    updateProject(input.db, project, {});
    try { input.onChanged?.(project, action, artifact); } catch { /* best-effort signal */ }
  };
  const route = (write: boolean, work: (req: Request, res: Response, project: string, id: string) => unknown) =>
    (req: Request, res: Response) => {
      const project = typeof req.query.projectId === 'string' ? req.query.projectId : '';
      const actor = multiUserActorOf(res)?.accountId;
      if (!actor || !(write ? access.canWrite(project, actor) : access.canView(project, actor))) {
        return sendApiError(res, 404, 'NOT_FOUND', 'resource not found');
      }
      res.set('Cache-Control', 'no-store');
      try { return work(req, res, project, String(req.params.artifactId ?? '')); }
      catch (error) {
        const status = error instanceof StudioLiveArtifactRefusal ? error.status : 400;
        return sendApiError(res, status, status === 404 ? 'NOT_FOUND' : status === 409 ? 'CONFLICT'
          : status === 413 ? 'PAYLOAD_TOO_LARGE' : 'BAD_REQUEST', error instanceof StudioLiveArtifactRefusal ? error.message : 'invalid live artifact');
      }
    };
  app.get(base, route(false, (_req, res, project) => res.json({ artifacts: store.list(project) })));
  app.post(base, route(true, (req, res, project) => {
    const sessionId = req.body?.input?.sessionId;
    if (sessionId !== undefined && getConversation(input.db, sessionId)?.projectId !== project) {
      throw new StudioLiveArtifactRefusal(404, 'resource not found');
    }
    const artifact = store.create(project, req.body); changed(project, 'created', artifact);
    return res.status(201).json({ artifact });
  }));
  app.get(`${base}/:artifactId`, route(false, (_req, res, project, id) => res.json({ artifact: store.read(project, id) })));
  app.get(`${base}/:artifactId/refreshes`, route(false, (_req, res, project, id) => res.json({ refreshes: store.history(project, id) })));
  app.patch(`${base}/:artifactId`, route(true, (req, res, project, id) => {
    // The existing viewer sends a plain metadata update. The envelope also supports template editing.
    const value = req.body && Object.hasOwn(req.body, 'input') ? req.body : { input: req.body };
    const artifact = store.update(project, id, value); changed(project, 'updated', artifact); return res.json({ artifact });
  }));
  app.delete(`${base}/:artifactId`, route(true, (_req, res, project, id) => {
    const artifact = store.read(project, id); store.delete(project, id); changed(project, 'deleted', artifact); return res.json({ ok: true });
  }));
  app.post(`${base}/:artifactId/refresh`, route(true, (_req, res, project, id) => {
    try {
      const result = store.refresh(project, id); changed(project, 'updated', result.artifact); return res.json(result);
    } catch (error) {
      // Failed attempts persist their bounded status/history and also invalidate members' viewers.
      if (error instanceof StudioLiveArtifactRefusal && error.status === 409) changed(project, 'updated', store.read(project, id));
      throw error;
    }
  }));
  app.get(`${base}/:artifactId/preview`, route(false, (req, res, project, id) => {
    const variant = req.query.variant ?? 'rendered';
    if (!['rendered', 'template', 'rendered-source'].includes(String(variant))) throw new StudioLiveArtifactRefusal(400, 'invalid preview variant');
    if (variant === 'rendered') {
      store.read(project, id);
      const actor = multiUserActorOf(res)!;
      for (const [key, value] of previews) if (value.expires <= now()) previews.delete(key);
      const own = [...previews].filter(([, value]) => value.actor === actor.accountId);
      while (own.length >= 64) previews.delete(own.shift()![0]);
      // Bound deployment memory as well as each account's preview pool.
      while (previews.size >= 4096) previews.delete(previews.keys().next().value!);
      const scope = randomBytes(32).toString('base64url');
      previews.set(scope, { project, artifact: id, actor: actor.accountId, session: actor.sessionId,
        expires: Math.min(now() + 5 * 60_000, actor.sessionExpiresAt) });
      return res.status(302).set({ Location: `${input.previewOrigin}/api/multiuser/live-artifact-preview/${scope}`, 'Referrer-Policy': 'no-referrer' }).send('');
    }
    res.set({ 'Content-Security-Policy': "sandbox; default-src 'none'", 'X-Content-Type-Options': 'nosniff',
      'Content-Type': 'text/plain; charset=utf-8' });
    return res.send(store.code(project, id, variant === 'template' ? 'template' : 'rendered'));
  }));
  // Only the preview hostname can enter this capability route (enforced by the gate).
  // Cookies are ignored; account/session/project authority is checked again on every navigation.
  app.get('/api/multiuser/live-artifact-preview/:scope', (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    const key = String(req.params.scope); const scope = previews.get(key);
    const session = scope && auth.getSessionById(scope.session);
    const account = scope && auth.getAccountById(scope.actor);
    if (!scope || scope.expires <= now() || !session || session.accountId !== scope.actor || session.expiresAt <= now()
      || !account?.active || account.passwordState !== 'set' || !access.canView(scope.project, scope.actor)) {
      previews.delete(key); return sendApiError(res, 404, 'NOT_FOUND', 'resource not found');
    }
    try {
      const html = store.code(scope.project, scope.artifact, 'rendered');
      res.set({ 'Content-Security-Policy': `sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'; frame-ancestors ${input.allowedOrigins.join(' ')}`,
        'X-Content-Type-Options': 'nosniff', 'Content-Type': 'text/html; charset=utf-8' });
      return res.send(html);
    } catch { previews.delete(key); return sendApiError(res, 404, 'NOT_FOUND', 'resource not found'); }
  });
  return Object.assign(store, { close() { previews.clear(); auth.close(); } });
}
