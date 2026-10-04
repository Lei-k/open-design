// Multi-user authorization gate (issues #3/#4) — installed only in multi-user mode.
//
// `installMultiUserFront` is the single entry server.ts uses. It is called
// right after the route-registration guard, BEFORE every body parser and
// route, and it:
//   1. opens the auth store under the resolved daemon data root and mounts the
//      auth registrar ahead of the global 4mb JSON parser (so the registrar's
//      own 16kb bounded parser always reads auth bodies);
//   2. installs the gate middleware, which for every request
//      - strips client-supplied identity (`x-od-*` headers, Authorization):
//        browser-asserted workspace/member/user headers are never authority;
//      - classifies `METHOD path` against the declarative registry
//        (`multiuser-route-classes.ts`); unclassified => fail closed;
//      - resolves the session ONLY from the `__Host-od_session` cookie through
//        AuthService (which re-reads account/role/active state every time, so
//        revocation and deactivation apply on the next request); the peer
//        address is never consulted, so loopback is not a bypass;
//      - refuses cross-origin state-changing requests;
//      - for owner-scoped-project routes, checks from the route param that the
//        actor owns the project BEFORE the handler runs, answering a
//        non-enumerating 404 otherwise (no admin override);
//   3. after the global JSON parser, enforces per-route body policies;
//   4. exposes the ownership hooks the project routes use for list filtering
//      and for binding the owner inside the create transaction.
//
// Startup refuses (`assertReady`) when the live inventory holds a route the
// registry does not classify, when an allowed registry entry is not actually
// registered, or when the body policy / ownership store was not wired.

import type Database from 'better-sqlite3';
import type { Express, Request, RequestHandler, Response } from 'express';
import { sendApiError } from './api-errors.js';
import { clearedSessionCookie, readSessionCookie, registerAuthRoutes } from '../routes/auth.js';
import { AuthService, type AuthActor } from '../services/auth-service.js';
import type { ResolvedMultiUserMode } from '../services/multiuser-mode.js';
import { AuthStore } from '../storage/auth-store.js';
import { ProjectOwnershipStore } from '../storage/project-ownership.js';
import { acknowledgePathlessUse } from '../route-registration-guard.js';
import {
  findStaleNonBlockedClassifications,
  findUnclassifiedRegistrations,
  matchMultiUserRoute,
  type MultiUserBodyPolicy,
  type MultiUserRouteMatch,
  type RouteRegistrationLike,
} from './multiuser-route-classes.js';

const ACTOR_LOCAL = 'multiUserActor';
const ROUTE_LOCAL = 'multiUserRoute';
const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// ---- decision ---------------------------------------------------------------

export type MultiUserAccessDecision =
  | { kind: 'pass-unauthenticated' }
  | { kind: 'unauthenticated' }
  | { kind: 'not-found' }
  | { kind: 'blocked' }
  | { kind: 'forbidden' }
  | { kind: 'project-not-found' }
  | { kind: 'run-not-found' }
  | { kind: 'agent-account-not-found' }
  | { kind: 'allow' };

/**
 * Pure access decision for one request. Fail-closed rules:
 * - public-probe / auth pass without a session only when EVERY match agrees;
 * - everything else needs a resolved actor (so anonymous callers learn
 *   nothing about which routes exist or are blocked);
 * - no match => not-found; matches of different classes => blocked;
 * - owner-scoped-project requires ownership of the declared param for every
 *   match; a missing param, a missing project and a foreign project are the
 *   same `project-not-found`. The admin role grants nothing here.
 */
export function decideMultiUserAccess(input: {
  matches: readonly MultiUserRouteMatch[];
  actor: AuthActor | null;
  isProjectOwner: (projectId: string, accountId: string) => boolean;
  isRunOwner?: (runId: string, accountId: string) => boolean;
  isAgentAccountOwner?: (param: 'attemptId' | 'accountId', id: string, accountId: string) => boolean;
}): MultiUserAccessDecision {
  const { matches, actor, isProjectOwner, isRunOwner, isAgentAccountOwner } = input;
  const classes = new Set(matches.map((match) => match.entry.routeClass));
  if (classes.size === 1 && (classes.has('public-probe') || classes.has('auth'))) {
    return { kind: 'pass-unauthenticated' };
  }
  if (!actor) return { kind: 'unauthenticated' };
  if (matches.length === 0) return { kind: 'not-found' };
  if (classes.size !== 1) return { kind: 'blocked' };
  const routeClass = matches[0]!.entry.routeClass;
  switch (routeClass) {
    case 'admin-only':
      return actor.role === 'admin' ? { kind: 'allow' } : { kind: 'forbidden' };
    case 'owner-scoped-project':
      for (const match of matches) {
        const param = match.entry.projectParam;
        const projectId = param ? match.params[param] : undefined;
        if (!projectId || !isProjectOwner(projectId, actor.accountId)) return { kind: 'project-not-found' };
      }
      return { kind: 'allow' };
    case 'owner-scoped-run':
      for (const match of matches) {
        const param = match.entry.runParam;
        const runId = param ? match.params[param] : undefined;
        if (!runId || !isRunOwner?.(runId, actor.accountId)) return { kind: 'run-not-found' };
      }
      return { kind: 'allow' };
    case 'owner-scoped-agent-account':
      for (const match of matches) {
        const param = match.entry.agentAccountParam;
        const id = param ? match.params[param] : undefined;
        if (!param || !id || !isAgentAccountOwner?.(param, id, actor.accountId)) return { kind: 'agent-account-not-found' };
      }
      return { kind: 'allow' };
    case 'actor-scoped':
      return { kind: 'allow' };
    default:
      return { kind: 'blocked' };
  }
}

// ---- request helpers --------------------------------------------------------

function isClientIdentityHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith('x-od-') || lower === 'authorization' || lower === 'proxy-authorization';
}

/** Remove every client-asserted identity header before any handler can read it. */
export function stripClientIdentityHeaders(req: Request): void {
  for (const name of Object.keys(req.headers)) {
    if (isClientIdentityHeader(name)) delete req.headers[name];
  }
  const raw = req.rawHeaders;
  if (Array.isArray(raw)) {
    for (let i = raw.length - 2; i >= 0; i -= 2) {
      if (isClientIdentityHeader(String(raw[i]))) raw.splice(i, 2);
    }
  }
}

function isCrossOriginMutation(req: Request, allowedOrigins: ReadonlySet<string>): boolean {
  if (!STATE_CHANGING_METHODS.has(req.method)) return false;
  const origin = req.get('origin');
  if (origin !== undefined) return !allowedOrigins.has(origin);
  const fetchSite = req.get('sec-fetch-site');
  return fetchSite === 'cross-site' || fetchSite === 'same-site';
}

export function multiUserActorOf(res: Response): AuthActor | null {
  return (res.locals[ACTOR_LOCAL] as AuthActor | undefined) ?? null;
}

// ---- gate -------------------------------------------------------------------

export interface MultiUserGateDeps {
  auth: Pick<AuthService, 'resolveSession'>;
  allowedOrigins: readonly string[];
  isProjectOwner: (projectId: string, accountId: string) => boolean;
  isRunOwner?: (runId: string, accountId: string) => boolean;
  isAgentAccountOwner?: (param: 'attemptId' | 'accountId', id: string, accountId: string) => boolean;
}

export function createMultiUserGate(deps: MultiUserGateDeps): RequestHandler {
  const allowedOrigins = new Set(deps.allowedOrigins);
  return (req, res, next) => {
    stripClientIdentityHeaders(req);
    const matches = matchMultiUserRoute(req.method, req.path);
    const cookie = readSessionCookie(req.headers.cookie);
    const needsSession = decideMultiUserAccess({ matches, actor: null, isProjectOwner: () => false }).kind
      !== 'pass-unauthenticated';
    const actor = needsSession && cookie.token ? deps.auth.resolveSession(cookie.token) : null;
    const decision = decideMultiUserAccess({ matches, actor, isProjectOwner: deps.isProjectOwner,
      ...(deps.isRunOwner ? { isRunOwner: deps.isRunOwner } : {}),
      ...(deps.isAgentAccountOwner ? { isAgentAccountOwner: deps.isAgentAccountOwner } : {}) });
    if (decision.kind === 'pass-unauthenticated') {
      next();
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    if (decision.kind === 'unauthenticated') {
      if (cookie.present) res.setHeader('Set-Cookie', clearedSessionCookie());
      sendApiError(res, 401, 'UNAUTHORIZED', 'authentication required');
      return;
    }
    if (isCrossOriginMutation(req, allowedOrigins)) {
      sendApiError(res, 403, 'FORBIDDEN', 'cross-origin request rejected');
      return;
    }
    switch (decision.kind) {
      case 'not-found':
        sendApiError(res, 404, 'NOT_FOUND', 'not found');
        return;
      case 'blocked':
        sendApiError(res, 403, 'FORBIDDEN', 'this route is not available in multi-user mode');
        return;
      case 'forbidden':
        sendApiError(res, 403, 'FORBIDDEN', 'admin role required');
        return;
      case 'project-not-found':
        sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'not found');
        return;
      case 'run-not-found':
        sendApiError(res, 404, 'NOT_FOUND', 'run not found');
        return;
      case 'agent-account-not-found':
        sendApiError(res, 404, 'NOT_FOUND', 'not found');
        return;
      case 'allow':
        res.locals[ACTOR_LOCAL] = actor;
        res.locals[ROUTE_LOCAL] = matches;
        next();
        return;
    }
  };
}

// ---- body policy ------------------------------------------------------------

const PROJECT_CREATE_FIELDS = new Set([
  'id',
  'name',
  'metadata',
  'pendingPrompt',
  'customInstructions',
  'skipDiscoveryBrief',
  'conversationMode',
  'sessionMode',
  'automaticStrategyTaskProfile',
]);
const PROJECT_PATCH_FIELDS = new Set(['name', 'metadata', 'pendingPrompt', 'customInstructions']);
/**
 * Descriptive metadata only. Everything that reaches host paths (baseDir,
 * linkedDirs, project locations, orchestrator workspace), global catalogs
 * (templates, plugins, skills, design systems) or daemon-owned bindings is
 * refused in multi-user mode.
 */
const PROJECT_METADATA_FIELDS = new Set([
  'kind',
  'intent',
  'fidelity',
  'speakerNotes',
  'slideCount',
  'animations',
  'includeLandingPage',
  'includeOsWidgets',
  'platform',
  'nameSource',
]);
const PROJECT_KINDS = new Set(['prototype', 'deck', 'other', 'image', 'video', 'audio']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function metadataAllowed(value: unknown, allowNull: boolean): boolean {
  if (value === undefined) return true;
  if (value === null) return allowNull;
  if (!isPlainObject(value)) return false;
  for (const key of Object.keys(value)) {
    if (!PROJECT_METADATA_FIELDS.has(key)) return false;
  }
  return value.kind === undefined || (typeof value.kind === 'string' && PROJECT_KINDS.has(value.kind));
}

export function multiUserBodyAllowed(policy: MultiUserBodyPolicy, body: unknown): boolean {
  if (!isPlainObject(body)) return false;
  const fields = policy === 'project-create' ? PROJECT_CREATE_FIELDS : PROJECT_PATCH_FIELDS;
  for (const key of Object.keys(body)) {
    if (!fields.has(key)) return false;
  }
  return metadataAllowed(body.metadata, policy === 'project-patch');
}

export function createMultiUserBodyPolicy(): RequestHandler {
  return (req, res, next) => {
    const matches = res.locals[ROUTE_LOCAL] as MultiUserRouteMatch[] | undefined;
    if (!matches) {
      next();
      return;
    }
    for (const match of matches) {
      const policy = match.entry.bodyPolicy;
      if (policy && !multiUserBodyAllowed(policy, req.body)) {
        sendApiError(res, 400, 'BAD_REQUEST', 'request contains fields that are not available in multi-user mode');
        return;
      }
    }
    next();
  };
}

// ---- project ownership hooks --------------------------------------------------

/** Hooks the project routes call in multi-user mode (null/absent otherwise). */
export interface ProjectOwnershipRouteHooks {
  /** Keep only projects the request's actor owns; no actor => nothing. */
  filterVisibleProjects<T extends { id: string }>(res: Response, projects: readonly T[]): T[];
  /**
   * Bind the actor as immutable owner. Call INSIDE the create transaction;
   * throws (rolling the create back) when there is no actor or store.
   */
  bindCreatedProject(res: Response, projectId: string, createdAt: number): void;
}

// ---- installer ----------------------------------------------------------------

export interface MultiUserFront {
  projectOwnershipHooks: ProjectOwnershipRouteHooks;
  /** Attach the ownership store to the main daemon database once it is open. */
  attachProjectOwnership: (db: Database.Database) => void;
  setCancelAccountRuns: (cancel: (accountId: string) => void) => void;
  setIsRunOwner: (check: (runId: string, accountId: string) => boolean) => void;
  setIsAgentAccountOwner: (check: (param: 'attemptId' | 'accountId', id: string, accountId: string) => boolean) => void;
  /** Install the post-parse body policy; call right after the global JSON parser. */
  installBodyPolicy: (app: Express) => void;
  /** Refuse to listen unless every registration is classified and wiring is complete. */
  assertReady: (registrations: readonly RouteRegistrationLike[]) => void;
  close: () => void;
}

export function installMultiUserFront(
  app: Express,
  options: { mode: ResolvedMultiUserMode; dataRoot: string },
): MultiUserFront {
  const { mode } = options;
  const store = AuthStore.open({ dataRoot: options.dataRoot });
  const auth = new AuthService({
    store,
    ...(mode.auth.passwordParams ? { passwordParams: mode.auth.passwordParams } : {}),
    ...(mode.auth.now ? { now: mode.auth.now } : {}),
    ...(mode.auth.sessionTtlMs ? { sessionTtlMs: mode.auth.sessionTtlMs } : {}),
    ...(mode.auth.sessionIdleTtlMs ? { sessionIdleTtlMs: mode.auth.sessionIdleTtlMs } : {}),
  });
  let ownership: ProjectOwnershipStore | null = null;
  let cancelAccountRuns: ((accountId: string) => void) | null = null;
  let isRunOwner: ((runId: string, accountId: string) => boolean) | null = null;
  let isAgentAccountOwner: ((param: 'attemptId' | 'accountId', id: string, accountId: string) => boolean) | null = null;
  let bodyPolicyInstalled = false;

  app.use(acknowledgePathlessUse(createMultiUserGate({
    auth,
    allowedOrigins: mode.allowedOrigins,
    isProjectOwner: (projectId, accountId) => ownership?.isOwnedBy(projectId, accountId) ?? false,
    isRunOwner: (runId, accountId) => isRunOwner?.(runId, accountId) ?? false,
    isAgentAccountOwner: (param, id, accountId) => isAgentAccountOwner?.(param, id, accountId) ?? false,
  }), 'authorization-gate'));
  // Mounted before any global body parser (resolves the parser-order residual
  // risk documented in routes/auth.ts).
  registerAuthRoutes(app, {
    auth,
    bootstrapSecret: mode.bootstrapSecret,
    allowedOrigins: mode.allowedOrigins,
    onAccountSessionsRevoked: (accountId) => cancelAccountRuns?.(accountId),
  });

  const projectOwnershipHooks: ProjectOwnershipRouteHooks = {
    filterVisibleProjects(res, projects) {
      const actor = multiUserActorOf(res);
      if (!actor || !ownership) return [];
      const owned = ownership.listOwnedProjectIds(actor.accountId);
      return projects.filter((project) => owned.has(project.id));
    },
    bindCreatedProject(res, projectId, createdAt) {
      const actor = multiUserActorOf(res);
      if (!actor || !ownership) throw new Error('multi-user project creation requires a resolved actor');
      ownership.bindOwner(projectId, actor.accountId, createdAt);
    },
  };

  return {
    projectOwnershipHooks,
    attachProjectOwnership(db) {
      ownership = new ProjectOwnershipStore(db);
    },
    setCancelAccountRuns(cancel) { cancelAccountRuns = cancel; },
    setIsRunOwner(check) { isRunOwner = check; },
    setIsAgentAccountOwner(check) { isAgentAccountOwner = check; },
    installBodyPolicy(target) {
      target.use(acknowledgePathlessUse(createMultiUserBodyPolicy(), 'body-policy'));
      bodyPolicyInstalled = true;
    },
    assertReady(registrations) {
      const unclassified = findUnclassifiedRegistrations(registrations);
      if (unclassified.length > 0) {
        throw new Error(`multi-user mode refused: unclassified routes: ${unclassified.join(', ')}`);
      }
      const staleAllowed = findStaleNonBlockedClassifications(registrations);
      if (staleAllowed.length > 0) {
        throw new Error(`multi-user mode refused: allowed classifications without a registered route: ${staleAllowed.join(', ')}`);
      }
      if (!bodyPolicyInstalled) throw new Error('multi-user mode refused: body policy middleware was not installed');
      if (!ownership) throw new Error('multi-user mode refused: project ownership store was not attached');
      if (!cancelAccountRuns) throw new Error('multi-user mode refused: isolated run service was not attached');
      if (!isRunOwner) throw new Error('multi-user mode refused: run ownership lookup was not attached');
      if (!isAgentAccountOwner) throw new Error('multi-user mode refused: personal account ownership lookup was not attached');
    },
    close() {
      store.close();
    },
  };
}
