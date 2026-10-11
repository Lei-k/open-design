import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Express, Request, Response } from 'express';
import {
  STUDIO_DEPLOY_MISSING_REASON,
  STUDIO_DEPLOY_DOMAIN_REASON,
  type StudioDeployConfig,
  type StudioDeployment,
} from '@open-design/contracts';
import { multiUserActorOf } from '../http/multiuser-gate.js';
import { sendApiError } from '../http/api-errors.js';
import { OutboundAuthorityRefused, OutboundRequestRefused } from '../http/safe-outbound-fetch.js';
import { getProject } from '../db.js';
import { ProjectAccessStore } from '../storage/project-access.js';
import { StudioDeployStore, studioDeployProvider, StudioDeployInputError } from '../storage/studio-deploy.js';
import { captureStudioProject } from '../projects/studio-snapshot.js';
import { buildDeployFilePlan, cloudflarePagesProjectNameForProject } from '../deploy.js';
import { studioProvider, type StudioDeployOutboundInjection } from '../deploy/studio-provider.js';
import type { AuthActor } from '../services/auth-service.js';
class AuthorityChanged extends Error {}
class CaptureRefused extends Error {}
class TokenMissing extends Error {}
/** Account deploy routes are separate from the desktop registrar and never read host deploy config. */
export interface RegisterStudioDeployRoutesDeps {
  db: Database.Database;
  dataRoot: string;
  projectsRoot: string;
  sessionCurrent: (actor: AuthActor) => boolean;
  accountActive: (id: string) => boolean;
  outbound?: StudioDeployOutboundInjection;
}
export function registerStudioDeployRoutes(app: Express, deps: RegisterStudioDeployRoutesDeps): void {
  const store = new StudioDeployStore(deps.db, deps.dataRoot);
  const access = new ProjectAccessStore(deps.db, { accountActive: deps.accountActive });
  const notFound = (res: Response) => sendApiError(res, 404, 'NOT_FOUND', 'not found');
  const owner = (req: Request, res: Response) => {
    const actor = multiUserActorOf(res);
    const project = String(req.params.id ?? '');
    if (!actor || !getProject(deps.db, project) || access.roleOf(project, actor.accountId) !== 'owner') {
      notFound(res);
      return null;
    }
    return { actor, project };
  };
  const check = (actor: AuthActor, project: string, config: StudioDeployConfig) => {
    if (
      !deps.accountActive(actor.accountId) ||
      !deps.sessionCurrent(actor) ||
      !getProject(deps.db, project) ||
      access.roleOf(project, actor.accountId) !== 'owner' ||
      store.read(actor.accountId, config.providerId).revision !== config.revision ||
      !store.read(actor.accountId, config.providerId).configured
    )
      throw new AuthorityChanged();
  };
  const failed = (res: Response, error: unknown) => {
    if (error instanceof TokenMissing)
      return sendApiError(res, 409, 'MULTIUSER_DEPLOY_TOKEN_MISSING', STUDIO_DEPLOY_MISSING_REASON);
    if (
      error instanceof AuthorityChanged ||
      (error instanceof OutboundAuthorityRefused && error.cause instanceof AuthorityChanged)
    )
      return sendApiError(
        res,
        409,
        'MULTIUSER_DEPLOY_AUTHORITY_CHANGED',
        'Account, session, token or project authority changed; further deployment effects were refused.',
      );
    if (error instanceof StudioDeployInputError)
      return sendApiError(
        res,
        error.status,
        error.status === 409 ? 'CONFLICT' : 'BAD_REQUEST',
        'Invalid or stale deploy settings.',
      );
    if (error instanceof CaptureRefused)
      return sendApiError(
        res,
        409,
        'MULTIUSER_DEPLOY_CAPTURE_REFUSED',
        'The project could not be captured safely within deployment limits.',
      );
    if (error instanceof OutboundRequestRefused)
      return sendApiError(
        res,
        400,
        'MULTIUSER_DEPLOY_OUTBOUND_REFUSED',
        'Provider address, redirect or response refused.',
      );
    return sendApiError(
      res,
      502,
      'MULTIUSER_DEPLOY_PROVIDER_FAILED',
      'The deployment provider did not complete the request.',
    );
  };
  const base = '/api/multiuser/deploy/config';
  app.get(base, (req, res) => {
    try {
      const actor = multiUserActorOf(res)!;
      res.setHeader('Cache-Control', 'no-store');
      res.json(store.read(actor.accountId, studioDeployProvider(req.query.providerId ?? 'vercel')));
    } catch (error) {
      failed(res, error);
    }
  });
  app.put(base, (req, res) => {
    try {
      const actor = multiUserActorOf(res)!;
      if (!deps.accountActive(actor.accountId) || !deps.sessionCurrent(actor)) throw new AuthorityChanged();
      const body = req.body as Record<string, unknown>;
      const config = store.update(actor.accountId, studioDeployProvider(body.providerId), body);
      res.setHeader('Cache-Control', 'no-store');
      res.json(config);
    } catch (error) {
      failed(res, error);
    }
  });
  const projectBase = '/api/multiuser/projects/:id';
  const capture = async (project: string, fileName: unknown) => {
    if (typeof fileName !== 'string' || fileName.length > 512) throw new StudioDeployInputError(400);
    try {
      const files = new Map(captureStudioProject(deps.projectsRoot, project).map((f) => [f.name, f.bytes]));
      const digest = createHash('sha256');
      for (const [name, bytes] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
        digest.update(JSON.stringify([name, bytes.length])).update(bytes);
      const plan = await buildDeployFilePlan(deps.projectsRoot, project, fileName, {
        capturedFiles: files,
        includeProjectFiles: true,
        hookScriptUrl: '',
      });
      if (
        plan.files.length > 500 ||
        plan.files.reduce((sum, file) => sum + Buffer.byteLength(file.data), 0) > 64 * 1024 * 1024 ||
        plan.missing.length ||
        plan.invalid.length
      )
        throw new CaptureRefused();
      return { plan, digest: digest.digest('hex') };
    } catch (error) {
      if (error instanceof StudioDeployInputError) throw error;
      throw new CaptureRefused();
    }
  };
  const configuration = (actor: AuthActor, project: string, provider: unknown): StudioDeployConfig => {
    const config = store.read(actor.accountId, studioDeployProvider(provider ?? 'vercel'));
    if (!config.configured) throw new TokenMissing();
    if (config.providerId === 'cloudflare-pages') {
      if (!config.accountId) throw new StudioDeployInputError(400);
      config.projectName = cloudflarePagesProjectNameForProject(
        project,
        config.projectName || getProject(deps.db, project)?.name || '',
      );
    }
    check(actor, project, config);
    return config;
  };
  const remote = (actor: AuthActor, project: string, config: StudioDeployConfig) =>
    studioProvider({
      provider: config.providerId,
      config,
      ...(deps.outbound ? { outbound: deps.outbound } : {}),
      authorize: () => {
        check(actor, project, config);
        const token = store.token(actor.accountId, config.providerId);
        if (!token) throw new AuthorityChanged();
        return token;
      },
    });
  app.get(`${projectBase}/deployments`, (req, res) => {
    const target = owner(req, res);
    if (!target) return;
    res.setHeader('Cache-Control', 'no-store');
    res.json({ deployments: store.list(target.actor.accountId, target.project) });
  });
  const running = new Set<string>();
  const run = async (req: Request, res: Response, redeploy = false, preflight = false) => {
    const target = owner(req, res);
    if (!target) return;
    if (running.has(target.actor.accountId) || running.size >= 2)
      return sendApiError(res, 409, 'CONFLICT', 'Deployment slots are busy; try again shortly.');
    running.add(target.actor.accountId);
    try {
      const previous = redeploy
        ? store.get(target.actor.accountId, target.project, String(req.params.deploymentId))
        : null;
      if (redeploy && !previous) return notFound(res);
      if (req.body?.cloudflarePages)
        return sendApiError(res, 403, 'MULTIUSER_CAPABILITY_UNAVAILABLE', STUDIO_DEPLOY_DOMAIN_REASON);
      const body = previous
        ? { fileName: previous.fileName, providerId: previous.providerId, target: previous.target }
        : req.body;
      const config = configuration(target.actor, target.project, body.providerId);
      const captured = await capture(target.project, body.fileName);
      check(target.actor, target.project, config);
      if (preflight)
        return res.json({
          available: true,
          fileCount: captured.plan.files.length,
          totalBytes: captured.plan.files.reduce((n, f) => n + Buffer.byteLength(f.data), 0),
          digest: captured.digest,
          missing: [],
          invalid: [],
        });
      if (store.list(target.actor.accountId, target.project).length >= 100) throw new StudioDeployInputError(409);
      const deployTarget = body.target ?? (config.providerId === 'cloudflare-pages' ? 'production' : 'preview');
      const result = await remote(target.actor, target.project, config).deploy(
        captured.plan.files,
        target.project,
        deployTarget,
      );
      check(target.actor, target.project, config);
      const now = Date.now();
      const row: StudioDeployment = {
        id: randomUUID(),
        projectId: target.project,
        fileName: captured.plan.entryPath,
        providerId: config.providerId,
        target: deployTarget,
        ...result,
        digest: captured.digest,
        createdAt: now,
        updatedAt: now,
        lastLinkCheck: null,
      };
      store.save(target.actor.accountId, row, {
        teamId: config.teamId,
        teamSlug: config.teamSlug,
        accountId: config.accountId,
        projectName: config.projectName,
      });
      res.setHeader('Cache-Control', 'no-store');
      res.json(row);
    } catch (error) {
      failed(res, error);
    } finally {
      running.delete(target.actor.accountId);
    }
  };
  app.post(`${projectBase}/deploy`, (req, res) => run(req, res));
  app.post(`${projectBase}/deploy/preflight`, (req, res) => run(req, res, false, true));
  app.post(`${projectBase}/deployments/:deploymentId/redeploy`, (req, res) => run(req, res, true));
  app.get(`${projectBase}/deployments/:deploymentId`, (req, res) => {
    const target = owner(req, res);
    if (!target) return;
    const row = store.get(target.actor.accountId, target.project, String(req.params.deploymentId));
    if (!row) return notFound(res);
    res.setHeader('Cache-Control', 'no-store');
    res.json(row);
  });
  for (const action of ['status', 'check-link'] as const)
    app.post(`${projectBase}/deployments/:deploymentId/${action}`, async (req, res) => {
      const target = owner(req, res);
      if (!target) return;
      const row = store.get(target.actor.accountId, target.project, String(req.params.deploymentId));
      if (!row) return notFound(res);
      try {
        const config = {
          ...configuration(target.actor, target.project, row.providerId),
          ...store.locator(target.actor.accountId, target.project, row.id),
        };
        const provider = remote(target.actor, target.project, config);
        const result =
          action === 'status'
            ? await provider.status(row.deploymentId)
            : { lastLinkCheck: await provider.checkLink(row.url) };
        check(target.actor, target.project, config);
        const updated = { ...row, ...result, updatedAt: Date.now() };
        store.save(target.actor.accountId, updated);
        res.json(updated);
      } catch (error) {
        failed(res, error);
      }
    });
  app.delete(`${projectBase}/deployments/:deploymentId`, (req, res) => {
    const target = owner(req, res);
    if (!target) return;
    const row = store.get(target.actor.accountId, target.project, String(req.params.deploymentId));
    if (!row) return notFound(res);
    // Record deletion only. No provider deletion request is made or implied.
    store.delete(target.actor.accountId, target.project, row.id);
    res.json({ ok: true, externalDeleted: false });
  });
}
