import type { Express } from 'express';
import { createApiError, type ActiveContextReadResponse, type ActiveContextWriteResponse } from '@open-design/contracts';
import { ACTIVE_CONTEXT_TTL_MS } from '../constants.js';
import type { RouteDeps } from '../server-context.js';
import { defineJsonRoute, err, mountJsonRoute, ok, rawInput, type Result } from '../http/index.js';
import { multiUserActorOf, type ProjectOwnershipRouteHooks } from '../http/multiuser-gate.js';
import { sendApiError, sendJson, statusForError } from '../http/response.js';

export interface RegisterActiveContextRoutesDeps extends RouteDeps<'db' | 'http' | 'projectStore'> {
  projectOwnership?: ProjectOwnershipRouteHooks | null;
}

// Soft "what is the user looking at right now in OpenDesign?" channel. The
// web UI POSTs the current project + file on every route change; the MCP
// surface reads it so a coding agent in another repo can resolve "the design
// I have open" without the user typing the project id. In-memory only —
// daemon restart clears it.
interface ActiveContext {
  projectId: string;
  fileName: string | null;
  ts: number;
}

interface ActiveContextStore {
  current: ActiveContext | null;
}

type PostActiveInput =
  | { kind: 'clear' }
  | { kind: 'set'; projectId: string; fileName: string | null };

type PostActiveOutput = ActiveContextWriteResponse;
type GetActiveOutput = ActiveContextReadResponse;

interface ActiveContextDomainDeps {
  store: ActiveContextStore;
  db: unknown;
  getProject: (db: unknown, projectId: string) => { name?: string | null } | null | undefined;
  now: () => number;
  canReadProject?: (projectId: string) => boolean;
}

function parsePostActive(raw: { body: unknown }): Result<PostActiveInput> {
  const body = (raw.body ?? {}) as Record<string, unknown>;
  if (body.active === false) {
    return ok({ kind: 'clear' });
  }
  const projectId = typeof body.projectId === 'string' ? body.projectId : '';
  if (!projectId) {
    return err(createApiError('BAD_REQUEST', 'projectId is required'));
  }
  const fileName =
    typeof body.fileName === 'string' && body.fileName.length > 0 ? body.fileName : null;
  return ok({ kind: 'set', projectId, fileName });
}

function handlePostActive(
  input: PostActiveInput,
  deps: ActiveContextDomainDeps,
): Result<PostActiveOutput> {
  if (input.kind === 'clear') {
    deps.store.current = null;
    return ok({ active: false });
  }
  if (deps.canReadProject && !deps.canReadProject(input.projectId)) {
    return err(createApiError('PROJECT_NOT_FOUND', 'not found'));
  }
  const next: ActiveContext = {
    projectId: input.projectId,
    fileName: input.fileName,
    ts: deps.now(),
  };
  deps.store.current = next;
  return ok({ active: true, ...next });
}

function handleGetActive(
  _input: void,
  deps: ActiveContextDomainDeps,
): Result<GetActiveOutput> {
  const current = deps.store.current;
  if (!current || deps.now() - current.ts > ACTIVE_CONTEXT_TTL_MS
    || (deps.canReadProject && !deps.canReadProject(current.projectId))) {
    deps.store.current = null;
    return ok({ active: false });
  }
  const project = deps.getProject(deps.db, current.projectId);
  return ok({
    active: true,
    projectId: current.projectId,
    projectName: project?.name ?? null,
    fileName: current.fileName,
    ts: current.ts,
    ageMs: deps.now() - current.ts,
  });
}

export const postActiveRoute = defineJsonRoute<PostActiveInput, PostActiveOutput, ActiveContextDomainDeps>({
  method: 'post',
  path: '/api/active',
  requireSameOrigin: true,
  parse: parsePostActive,
  handle: handlePostActive,
});

export const getActiveRoute = defineJsonRoute<void, GetActiveOutput, ActiveContextDomainDeps>({
  method: 'get',
  path: '/api/active',
  requireSameOrigin: true,
  parse: () => ok(undefined),
  handle: handleGetActive,
});

export function registerActiveContextRoutes(app: Express, ctx: RegisterActiveContextRoutesDeps): void {
  const store: ActiveContextStore = { current: null };
  const domainDeps: ActiveContextDomainDeps = {
    store,
    db: ctx.db,
    getProject: ctx.projectStore.getProject,
    now: () => Date.now(),
  };
  const adapter = { resolvedPortRef: ctx.http.resolvedPortRef };
  if (ctx.projectOwnership) {
    // Do not reuse the local MCP/global focus store for authenticated clients.
    // Explicit session keys also prevent a new login from inheriting stale focus.
    const stores = new Map<string, ActiveContextStore>();
    const ownership = ctx.projectOwnership;
    for (const spec of [postActiveRoute, getActiveRoute] as const) {
      app[spec.method](spec.path, (req, res) => {
        const actor = multiUserActorOf(res);
        if (!actor) { sendApiError(res, 401, createApiError('UNAUTHORIZED', 'authentication required')); return; }
        const now = Date.now();
        for (const [key, value] of stores) {
          if (!value.current || now - value.current.ts > ACTIVE_CONTEXT_TTL_MS) stores.delete(key);
        }
        let actorStore = stores.get(actor.sessionId);
        if (!actorStore) {
          // Bounded transient state, not a durable catalog. Eviction only drops focus.
          if (stores.size >= 4096) stores.delete(stores.keys().next().value!);
          actorStore = { current: null };
          stores.set(actor.sessionId, actorStore);
        }
        const scopedDeps: ActiveContextDomainDeps = { ...domainDeps, store: actorStore,
          canReadProject: (projectId) => ownership.filterVisibleProjects(res, [{ id: projectId }]).length === 1 };
        const input = postActiveRoute.parse(rawInput(req));
        // The gate owns HTTPS origin checks and the bounded body policy. Avoid
        // the single-user adapter's loopback-only origin policy for remote Web.
        const result = spec.method === 'get'
          ? handleGetActive(undefined, scopedDeps)
          : input.ok ? handlePostActive(input.value, scopedDeps) : input;
        if (!result.ok) { sendApiError(res, statusForError(result.error), result.error); return; }
        sendJson(res, 200, result.value);
      });
    }
    return;
  }
  mountJsonRoute(app, postActiveRoute, domainDeps, adapter);
  mountJsonRoute(app, getActiveRoute, domainDeps, adapter);
}
