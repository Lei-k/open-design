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
import { STUDIO_AUTOMATION_INGESTION_FIELDS, STUDIO_AUTOMATION_PROPOSAL_FIELDS, STUDIO_MEMORY_CONFIG_FIELDS, STUDIO_MEMORY_EXTRACT_FIELDS, isStudioPluginApplyRequest, parseStudioMessageFeedback, parseStudioSettingsWrite, type StudioProjectShareSummary } from '@open-design/contracts';
import { sendApiError } from './api-errors.js';
import { setMultiUserStreamAuthority } from './multiuser-stream.js';
import { clearedSessionCookie, readSessionCookie, registerAuthRoutes } from '../routes/auth.js';
import { AuthService, type AuthActor } from '../services/auth-service.js';
import type { ResolvedMultiUserMode } from '../services/multiuser-mode.js';
import { AuthStore } from '../storage/auth-store.js';
import { ProjectAccessStore, projectRoleAtLeast, type ProjectAccessRole } from '../storage/project-access.js';
import { acknowledgePathlessUse } from '../route-registration-guard.js';
import {
  findPrecedenceOrderViolations,
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
 * - public-probe / public-web / auth pass without a session only when EVERY match agrees;
 * - everything else needs a resolved actor (so anonymous callers learn
 *   nothing about which routes exist or are blocked);
 * - no match => not-found; matches of different classes => blocked;
 * - owner-scoped-project requires ownership of the declared param for every
 *   match, or a project share grant (#65) of at least the entry's
 *   `sharedRole`; a missing param, a missing project, a foreign project and
 *   an insufficient grant are the same `project-not-found`. The admin role
 *   grants nothing here.
 */
export function decideMultiUserAccess(input: {
  matches: readonly MultiUserRouteMatch[];
  actor: AuthActor | null;
  isProjectOwner: (projectId: string, accountId: string) => boolean;
  /** The actor's share role on a project it does not own (#65); absent = owners only. */
  projectShareRole?: (projectId: string, accountId: string) => ProjectAccessRole | null;
  /** Whether the actor authored this conversation of the project (#65); absent = refuse such routes. */
  canWriteConversation?: (projectId: string, conversationId: string, accountId: string) => boolean;
  isRunOwner?: (runId: string, accountId: string) => boolean;
  isAgentAccountOwner?: (param: 'attemptId' | 'accountId', id: string, accountId: string) => boolean;
}): MultiUserAccessDecision {
  const { matches, actor, isProjectOwner, projectShareRole, canWriteConversation, isRunOwner, isAgentAccountOwner } = input;
  const classes = new Set(matches.map((match) => match.entry.routeClass));
  if (classes.size === 1 && (classes.has('public-probe') || classes.has('auth') || classes.has('public-web'))) {
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
        if (!projectId) return { kind: 'project-not-found' };
        const conversationParam = match.entry.conversationParam;
        if (conversationParam) {
          const conversationId = match.params[conversationParam];
          if (!conversationId || !canWriteConversation?.(projectId, conversationId, actor.accountId)) return { kind: 'project-not-found' };
        }
        if (isProjectOwner(projectId, actor.accountId)) continue;
        const required = match.entry.sharedRole;
        if (!required || !projectShareRole || !projectRoleAtLeast(projectShareRole(projectId, actor.accountId), required)) {
          return { kind: 'project-not-found' };
        }
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

/** Background work (routines) admitting through a request handler as a
 * server-resolved owner. Callers own the authority check for that actor. */
export function bindMultiUserActor(res: Response, actor: AuthActor): void {
  res.locals[ACTOR_LOCAL] = actor;
}

export function multiUserActorOf(res: Response): AuthActor | null {
  return (res.locals[ACTOR_LOCAL] as AuthActor | undefined) ?? null;
}

/**
 * Owner file bytes are untrusted generated content served on the app origin.
 * A sandboxed CSP gives any navigated document an opaque origin without
 * scripts, so it can never act with the session; embedding contexts that read
 * bytes (img/media/fetch) are unaffected. Handler attempts to widen CORS for
 * `null` origins are dropped.
 */
export function applyUntrustedContentPolicy(res: Response): void {
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'unsafe-inline'; font-src 'self' data:");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  // Same-origin framing stays possible for viewers; the frame is still sandboxed.
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  const setHeader = res.setHeader.bind(res);
  res.setHeader = ((name: string, value: unknown) => /^access-control-/i.test(name) || /^content-security-policy$/i.test(name) && value !== res.getHeader(name)
    ? res
    : setHeader(name, value as string)) as typeof res.setHeader;
}

// ---- gate -------------------------------------------------------------------

export interface MultiUserGateDeps {
  auth: Pick<AuthService, 'resolveSession' | 'isActorCurrent'>;
  allowedOrigins: readonly string[];
  previewOrigin?: string;
  isProjectOwner: (projectId: string, accountId: string) => boolean;
  projectShareRole?: (projectId: string, accountId: string) => ProjectAccessRole | null;
  canWriteConversation?: (projectId: string, conversationId: string, accountId: string) => boolean;
  isRunOwner?: (runId: string, accountId: string) => boolean;
  isAgentAccountOwner?: (param: 'attemptId' | 'accountId', id: string, accountId: string) => boolean;
}

export function createMultiUserGate(deps: MultiUserGateDeps): RequestHandler {
  const allowedOrigins = new Set(deps.allowedOrigins);
  const previewHost = deps.previewOrigin ? new URL(deps.previewOrigin).host : null;
  return (req, res, next) => {
    stripClientIdentityHeaders(req);
    const matches = matchMultiUserRoute(req.method, req.path);
    const requestHost = req.get('host') ?? '';
    const previewRoute = matches.length > 0 && matches.every((match) => match.entry.routeClass === 'preview-capability');
    // The preview origin is structurally incapable of serving the app/API,
    // and the main origin is structurally incapable of serving preview bytes.
    if ((previewHost && requestHost === previewHost && !previewRoute) || (previewRoute && requestHost !== previewHost)) {
      res.setHeader('Cache-Control', 'no-store');
      sendApiError(res, 404, 'NOT_FOUND', 'not found');
      return;
    }
    if (previewRoute) {
      next();
      return;
    }
    const cookie = readSessionCookie(req.headers.cookie);
    const needsSession = decideMultiUserAccess({ matches, actor: null, isProjectOwner: () => false }).kind
      !== 'pass-unauthenticated';
    const actor = needsSession && cookie.token ? deps.auth.resolveSession(cookie.token) : null;
    const decision = decideMultiUserAccess({ matches, actor, isProjectOwner: deps.isProjectOwner,
      ...(deps.projectShareRole ? { projectShareRole: deps.projectShareRole } : {}),
      ...(deps.canWriteConversation ? { canWriteConversation: deps.canWriteConversation } : {}),
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
      case 'blocked': {
        // A reviewed host capability (S41: plugin install, marketplace fetch,
        // doctor, trust, scripts) answers with its typed refusal when every
        // match names the same one; everything else keeps the generic refusal.
        const refusals = new Set(matches.map((match) => match.entry.routeClass === 'blocked-in-multiuser' ? match.entry.capabilityRefusal ?? '' : ''));
        const capability = refusals.size === 1 ? [...refusals][0]! : '';
        if (capability) {
          sendApiError(res, 403, 'MULTIUSER_CAPABILITY_UNAVAILABLE', 'this capability is not available to Web accounts',
            { details: { capability, reason: matches[0]!.entry.reason } });
          return;
        }
        sendApiError(res, 403, 'FORBIDDEN', 'this route is not available in multi-user mode');
        return;
      }
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
      case 'allow': {
        const limit = Math.min(...matches.map((match) => match.entry.maxBodyBytes ?? Infinity));
        if (Number.isFinite(limit)) {
          const length = Number(req.get('content-length'));
          // A bounded route needs a declared length within its ceiling (no chunked bodies).
          if (!req.get('content-length') || !Number.isSafeInteger(length) || length > limit) {
            sendApiError(res, 413, 'PAYLOAD_TOO_LARGE', 'request body is too large for multi-user mode');
            return;
          }
        }
        if (matches.some((match) => match.entry.untrustedContent)) applyUntrustedContentPolicy(res);
        const aliases = matches.filter((match) => match.entry.rewriteTo).map((match) =>
          match.entry.rewriteTo!.replace(/:([A-Za-z_]\w*)/g, (_all, name: string) => encodeURIComponent(match.params[name] ?? '')));
        // Route precedence already chose the most specific string route
        // (#81). Survivors that remain together (reviewed regex routes, static
        // mounts) must agree on one destination; skipping an ambiguous alias
        // would accidentally reach the host-global handler.
        if (aliases.length && (aliases.length !== matches.length || new Set(aliases).size !== 1)) {
          sendApiError(res, 404, 'NOT_FOUND', 'not found');
          return;
        }
        if (aliases.length) {
          const target = aliases[0]!;
          const query = req.url.indexOf('?');
          req.url = `${target}${query >= 0 ? req.url.slice(query) : ''}`;
        }
        res.locals[ACTOR_LOCAL] = actor;
        res.locals[ROUTE_LOCAL] = matches;
        setMultiUserStreamAuthority(res, () => actor !== null && deps.auth.isActorCurrent(actor)
          && decideMultiUserAccess({ matches, actor, isProjectOwner: deps.isProjectOwner,
            ...(deps.projectShareRole ? { projectShareRole: deps.projectShareRole } : {}),
      ...(deps.canWriteConversation ? { canWriteConversation: deps.canWriteConversation } : {}),
            ...(deps.isRunOwner ? { isRunOwner: deps.isRunOwner } : {}),
            ...(deps.isAgentAccountOwner ? { isAgentAccountOwner: deps.isAgentAccountOwner } : {}) }).kind === 'allow');
        next();
        return;
      }
    }
  };
}

// ---- body policy ------------------------------------------------------------

const PROJECT_CREATE_FIELDS = new Set([
  'id',
  'name',
  'skillId',
  'designSystemId',
  'metadata',
  'pendingPrompt',
  'customInstructions',
  'skipDiscoveryBrief',
  'conversationMode',
  'sessionMode',
  'automaticStrategyTaskProfile',
]);
// `updatedAt` is accepted as a touch only; the handler substitutes the server clock.
const PROJECT_PATCH_FIELDS = new Set(['name', 'metadata', 'pendingPrompt', 'customInstructions', 'updatedAt', 'designSystemId']);
/**
 * Descriptive metadata only. Everything that reaches host paths (baseDir,
 * linkedDirs, project locations, orchestrator workspace), global catalogs
 * (templates, plugins, skills) or daemon-owned bindings is
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
  'platformTargets',
  'nameSource',
  'templateId',
]);
const PROJECT_KINDS = new Set(['prototype', 'deck', 'template', 'other', 'image', 'video', 'audio']);

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
  const platforms = ['auto', 'responsive', 'web-desktop', 'mobile-ios', 'mobile-android', 'tablet', 'desktop-app'];
  return (value.templateId === undefined || !allowNull && value.kind === 'template' && typeof value.templateId === 'string' && /^studio-template:[a-f0-9-]{36}$/.test(value.templateId))
    && (value.kind === undefined || typeof value.kind === 'string' && PROJECT_KINDS.has(value.kind))
    && (value.fidelity === undefined || typeof value.fidelity === 'string' && ['wireframe', 'high-fidelity'].includes(value.fidelity))
    && (value.platform === undefined || typeof value.platform === 'string' && platforms.includes(value.platform))
    && (value.platformTargets === undefined || Array.isArray(value.platformTargets) && value.platformTargets.length <= 8
      && value.platformTargets.every((platform) => typeof platform === 'string' && platforms.includes(platform)))
    && ['speakerNotes', 'animations', 'includeLandingPage', 'includeOsWidgets'].every((key) => value[key] === undefined || typeof value[key] === 'boolean')
    && (value.slideCount === undefined || typeof value.slideCount === 'string' && value.slideCount.length <= 128 && !value.slideCount.includes('\0'))
    && (value.intent === undefined || typeof value.intent === 'string' && ['live-artifact', 'web-clone', 'document', 'webgl-experience', 'worker-visualizer', 'marketing', 'hyperframes'].includes(value.intent))
    && (value.nameSource === undefined || typeof value.nameSource === 'string' && ['user', 'generated', 'prompt', 'agent'].includes(value.nameSource));
}

const FILE_NAME_MAX = 1024;
const projectPathText = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= FILE_NAME_MAX && !value.includes('\0');

const COMMENT_STATUSES = ['open', 'attached', 'applying', 'needs_review', 'resolved', 'failed'];
const COMMENT_ANCHOR_STATES = ['anchored', 'reanchored', 'stale', 'lost'];
const finiteNumber = (value: unknown) => typeof value === 'number' && Number.isFinite(value);
const commentPosition = (value: unknown) => isPlainObject(value) && Object.keys(value).every((key) => ['x', 'y', 'width', 'height'].includes(key))
  && ['x', 'y', 'width', 'height'].every((key) => value[key] === undefined || finiteNumber(value[key]));
/** A comment image path: project-relative, no traversal, root, drive, backslash or NUL. */
const commentAttachmentPath = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= FILE_NAME_MAX
  && !value.includes('\0') && !value.startsWith('/') && !value.includes('\\') && !/^[A-Za-z]:/.test(value)
  && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
/**
 * Owner-only preview comments (#59). Shapes only: the db normalizer still
 * trims and bounds every field. Member identity (`authorMemberId`) is never
 * accepted from a Web client, and attachments must be project-relative paths.
 */
function studioCommentBodyAllowed(policy: 'comment-upsert' | 'comment-status' | 'comment-anchor' | 'comment-reorder', body: Record<string, unknown>): boolean {
  const only = (fields: readonly string[]) => Object.keys(body).every((key) => fields.includes(key));
  if (policy === 'comment-status') return only(['status']) && typeof body.status === 'string' && COMMENT_STATUSES.includes(body.status);
  if (policy === 'comment-reorder') return only(['sortKey']) && finiteNumber(body.sortKey);
  if (policy === 'comment-anchor') return only(['anchorState', 'lastGoodPosition', 'anchoredVersion'])
    && typeof body.anchorState === 'string' && COMMENT_ANCHOR_STATES.includes(body.anchorState)
    && (body.lastGoodPosition === undefined || commentPosition(body.lastGoodPosition))
    && (body.anchoredVersion === undefined || finiteNumber(body.anchoredVersion));
  const target = body.target;
  return only(['id', 'target', 'note', 'attachments'])
    && (body.id === undefined || typeof body.id === 'string' && body.id.length <= 128)
    && (body.note === undefined || typeof body.note === 'string' && body.note.length <= 10_000)
    && (body.attachments === undefined || Array.isArray(body.attachments) && body.attachments.length <= 20
      && body.attachments.every((item) => isPlainObject(item) && Object.keys(item).every((key) => key === 'path' || key === 'name')
        && commentAttachmentPath(item.path) && (item.name === undefined || typeof item.name === 'string' && item.name.length <= 256)))
    && isPlainObject(target) && projectPathText(target.filePath) && !('anchoredVersion' in target && !finiteNumber(target.anchoredVersion))
    && (target.position === undefined || commentPosition(target.position))
    && (target.podMembers === undefined || Array.isArray(target.podMembers) && target.podMembers.length <= 200)
    && JSON.stringify(target).length <= 48 * 1024;
}

export function multiUserBodyAllowed(policy: MultiUserBodyPolicy, body: unknown, contentType = ''): boolean {
  const multipart = /^multipart\/form-data(?:;|$)/i.test(contentType);
  // Multipart parts are parsed by the route's own bounded parser, after this
  // policy; nothing JSON-shaped may ride along with them.
  if (policy === 'multipart') return multipart && (body === undefined || (isPlainObject(body) && Object.keys(body).length === 0));
  if (policy === 'empty') return body === undefined || (isPlainObject(body) && Object.keys(body).length === 0);
  if (policy === 'file-write' && multipart) return body === undefined || (isPlainObject(body) && Object.keys(body).length === 0);
  if (!isPlainObject(body)) return false;
  const only = (fields: readonly string[]) => Object.keys(body).every((key) => fields.includes(key));
  const optionalText = (value: unknown, max: number) => value === undefined || value === null || (typeof value === 'string' && value.length <= max);
  const sessionMode = body.sessionMode === undefined || (typeof body.sessionMode === 'string' && ['design', 'chat', 'plan'].includes(body.sessionMode));
  // #61: a project, scalar inputs and an empty capability grant; the plugin and ownership are checked by the route.
  if (policy === 'studio-plugin-apply') return isStudioPluginApplyRequest(body);
  if (policy === 'studio-live-artifact') return Object.hasOwn(body, 'input')
    ? only(['input', 'templateHtml', 'expectedRevision']) && isPlainObject(body.input) && optionalText(body.templateHtml, 64 * 1024)
    : only(['title', 'slug', 'pinned', 'status', 'preview', 'document']);
  if (policy === 'archive-batch') return only(['files']) && Array.isArray(body.files) && body.files.length > 0
    && body.files.length <= 500 && body.files.every(projectPathText);
  // Field-level routine validation needs ownership checks and lives in the route.
  if (policy === 'studio-routine') return only(['name', 'prompt', 'schedule', 'target', 'skillId', 'agentId', 'context', 'enabled', 'templateId'])
    && (body.templateId === undefined || body.templateId === null || typeof body.templateId === 'string' && /^[a-z0-9][a-z0-9._-]{1,95}$/.test(body.templateId));
  // #64: closed automation fields; ownership and connector refusals live in the route.
  if (policy === 'automation-ingestion') return only(STUDIO_AUTOMATION_INGESTION_FIELDS) && typeof body.sourceKind === 'string';
  if (policy === 'automation-proposal') return only(STUDIO_AUTOMATION_PROPOSAL_FIELDS);
  if (policy === 'automation-proposal-reject') return only(['reason']) && optionalText(body.reason, 2000);
  // #63: a query and a bounded source count; the provider, depth and key are fixed by the server.
  if (policy === 'research-search') return only(['query', 'maxSources']) && typeof body.query === 'string' && body.query.length <= 1000
    && (body.maxSources === undefined || Number.isInteger(body.maxSources));
  // A historical versionId bundles that version's HTML with the project's current
  // same-project assets, exactly like the single-user export.
  if (policy === 'export-render') {
    const dimension = (value: unknown) => value === undefined || (typeof value === 'number' && Number.isInteger(value) && value >= 64 && value <= 8192);
    return only(['fileName', 'title', 'deck', 'editable', 'index', 'imageFormat', 'width', 'height', 'versionId'])
      && projectPathText(body.fileName) && optionalText(body.title, 200)
      && (body.deck === undefined || typeof body.deck === 'boolean') && (body.editable === undefined || typeof body.editable === 'boolean')
      && (body.index === undefined || (typeof body.index === 'number' && Number.isInteger(body.index) && body.index >= 0 && body.index < 1000))
      && (body.imageFormat === undefined || body.imageFormat === 'png' || body.imageFormat === 'jpeg')
      && dimension(body.width) && dimension(body.height)
      && (body.versionId === undefined || typeof body.versionId === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(body.versionId));
  }
  // #65: grantee by username (resolved server-side) and a role; nothing else.
  // #61/#65: grantee by username (resolved server-side); `use` is the only catalog role.
  if (policy === 'catalog-share') return only(['username', 'role']) && typeof body.username === 'string'
    && body.username.length > 0 && body.username.length <= 64 && body.role === 'use';
  if (policy === 'project-share') return only(['username', 'role']) && typeof body.username === 'string'
    && body.username.length > 0 && body.username.length <= 64 && typeof body.role === 'string' && ['view', 'comment', 'edit'].includes(body.role);
  // Presence identity comes from the session; a client names only its tab and the file it shows.
  const presenceClient = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
  if (policy === 'presence-heartbeat') return only(['clientId', 'filePath']) && presenceClient(body.clientId)
    && (body.filePath === undefined || body.filePath === null || projectPathText(body.filePath));
  if (policy === 'presence-leave') return only(['clientId']) && presenceClient(body.clientId);
  if (policy === 'export-html') return only(['fileName', 'title', 'versionId']) && projectPathText(body.fileName) && optionalText(body.title, 200)
    && (body.versionId === undefined || typeof body.versionId === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(body.versionId));
  if (policy === 'comment-upsert' || policy === 'comment-status' || policy === 'comment-anchor' || policy === 'comment-reorder') {
    return studioCommentBodyAllowed(policy, body);
  }
  if (policy === 'project-duplicate') return only(['name']) && (body.name === undefined
    || typeof body.name === 'string' && body.name.trim().length > 0 && body.name.length <= 100 && !body.name.includes('\0'));
  if (policy === 'template-save') return only(['name', 'description', 'sourceProjectId'])
    && typeof body.name === 'string' && body.name.trim().length > 0 && body.name.length <= 100 && !body.name.includes('\0')
    && optionalText(body.description, 2000) && typeof body.sourceProjectId === 'string' && body.sourceProjectId.length <= 128;
  if (policy === 'studio-settings') return parseStudioSettingsWrite(body) !== null;
  if (policy === 'studio-memory-entry') return only(['id', 'name', 'description', 'type', 'body']);
  if (policy === 'studio-memory-index') return only(['index']) && typeof body.index === 'string'
    && Buffer.byteLength(body.index) <= 64 * 1024 && !body.index.includes('\0');
  if (policy === 'studio-memory-config') return only(STUDIO_MEMORY_CONFIG_FIELDS)
    && Object.values(body).every((value) => typeof value === 'boolean');
  // #62: annotations only — no chat provider, agent or model can ride along.
  if (policy === 'studio-memory-rules-suggest') return only(['annotations']) && Array.isArray(body.annotations) && body.annotations.length <= 20
    && body.annotations.every((item) => isPlainObject(item)
      && Object.keys(item).every((key) => ['note', 'targetLabel', 'filePath', 'currentText', 'selectionKind', 'htmlHint'].includes(key))
      && typeof item.note === 'string' && Object.values(item).every((value) => typeof value === 'string' && value.length <= 4000 && !value.includes('\0')));
  if (policy === 'studio-memory-extract') return only(STUDIO_MEMORY_EXTRACT_FIELDS)
    && Object.values(body).every((value) => typeof value === 'string' && Buffer.byteLength(value) <= 64 * 1024 && !value.includes('\0'));
  if (policy === 'public-link-revoke') return only(['slug']) && (body.slug === undefined || typeof body.slug === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(body.slug));
  if (policy === 'provider-key') return only(['revision', 'apiKey', 'model']) && Number.isSafeInteger(body.revision)
    && (body.apiKey === undefined || body.apiKey === null || typeof body.apiKey === 'string' && body.apiKey.length <= 4096)
    && (body.model === undefined || typeof body.model === 'string' && body.model.length <= 128);
  if (policy === 'company-openai') return only(['revision', 'enabled', 'model', 'capacity', 'apiKey'])
    && Number.isSafeInteger(body.revision) && Number(body.revision) >= 0 && typeof body.enabled === 'boolean'
    && typeof body.model === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(body.model)
    && Number.isSafeInteger(body.capacity) && Number(body.capacity) >= 0 && Number(body.capacity) <= 16
    && (body.apiKey === undefined || body.apiKey === null || typeof body.apiKey === 'string' && body.apiKey.trim().length >= 16 && body.apiKey.length <= 4096);
  if (policy === 'design-system-document') return only(['title', 'summary', 'category', 'surface', 'status', 'body'])
    && Object.keys(body).length > 0
    && ['title', 'summary', 'category', 'body'].every((key) => body[key] === undefined
      || typeof body[key] === 'string' && !body[key].includes('\0')
        && Buffer.byteLength(body[key]) <= ({ title: 512, summary: 16_000, category: 128, body: 256_000 } as Record<string, number>)[key]!)
    && (body.surface === undefined || ['web', 'image', 'video', 'audio'].includes(String(body.surface)))
    && (body.status === undefined || ['draft', 'published'].includes(String(body.status)));
  if (policy === 'skill-write') {
    return only(['name', 'description', 'body', 'triggers'])
      && (body.name === undefined || (typeof body.name === 'string' && body.name.trim().length > 0 && body.name.length <= 120))
      && (body.description === undefined || (typeof body.description === 'string' && body.description.length <= 16_000))
      && typeof body.body === 'string' && body.body.trim().length > 0 && body.body.length <= 256_000
      && (body.triggers === undefined || (Array.isArray(body.triggers) && body.triggers.length <= 32
        && body.triggers.every((trigger) => typeof trigger === 'string' && trigger.length <= 128)));
  }
  if (policy === 'active-context') {
    if (body.active === false) return only(['active']);
    return only(['projectId', 'fileName']) && typeof body.projectId === 'string'
      && body.projectId.length > 0 && body.projectId.length <= 128 && optionalText(body.fileName, 1024);
  }
  if (policy === 'conversation-create' || policy === 'conversation-patch') {
    const fields = policy === 'conversation-create'
      ? ['title', 'sessionMode', 'seedFromConversationId', 'forkAfterMessageId']
      : ['title', 'sessionMode'];
    return only(fields) && optionalText(body.title, 512) && sessionMode
      && optionalText(body.seedFromConversationId, 128) && optionalText(body.forkAfterMessageId, 128);
  }
  if (policy === 'message-write') {
    return only(['id', 'role', 'content', 'createdAt', 'createOnly', 'feedback'])
      && optionalText(body.id, 128) && (body.role === 'user' || body.role === 'assistant')
      && (body.feedback === undefined || (body.role === 'assistant' && parseStudioMessageFeedback(body.feedback) !== undefined))
      && typeof body.content === 'string' && body.content.length <= 1_000_000
      && (body.createdAt === undefined || (typeof body.createdAt === 'number' && Number.isFinite(body.createdAt) && body.createdAt >= 0))
      && (body.createOnly === undefined || typeof body.createOnly === 'boolean');
  }
  if (policy === 'folder-create') return only(['name']) && projectPathText(body.name);
  if (policy === 'folder-delete') return only(['path']) && projectPathText(body.path);
  if (policy === 'file-rename') return only(['from', 'to']) && projectPathText(body.from) && projectPathText(body.to);
  if (policy === 'file-version') {
    return only(['prompt', 'source', 'label']) && optionalText(body.prompt, 64_000) && optionalText(body.source, 32) && optionalText(body.label, 256);
  }
  if (policy === 'file-write') {
    // `artifactManifest` is project-local metadata the handler validates (#59);
    // server-side artifact creation (`artifact: true`) stays unavailable.
    return only(['name', 'content', 'encoding', 'overwrite', 'versionLabel', 'versionPrompt', 'versionSource', 'parentVersionId', 'artifactManifest'])
      && (body.artifactManifest === undefined || body.artifactManifest === null || isPlainObject(body.artifactManifest))
      && projectPathText(body.name) && typeof body.content === 'string'
      && (body.encoding === undefined || body.encoding === 'utf8' || body.encoding === 'base64')
      && (body.overwrite === undefined || typeof body.overwrite === 'boolean')
      && optionalText(body.versionLabel, 256) && optionalText(body.versionPrompt, 64_000)
      && optionalText(body.versionSource, 32) && optionalText(body.parentVersionId, 128);
  }
  if (policy === 'project-tabs') {
    return only(['tabs', 'active', 'browserTabs', 'updatedAt', 'hasSavedState']) && Array.isArray(body.tabs) && body.tabs.length <= 100
      && (body.updatedAt === undefined || (typeof body.updatedAt === 'number' && Number.isFinite(body.updatedAt)))
      && (body.hasSavedState === undefined || typeof body.hasSavedState === 'boolean')
      && body.tabs.every((tab) => typeof tab === 'string' && tab.length > 0 && tab.length <= 1024)
      && optionalText(body.active, 1024)
      && (body.browserTabs === undefined || (Array.isArray(body.browserTabs) && body.browserTabs.length === 0));
  }
  const fields = policy === 'project-create' ? PROJECT_CREATE_FIELDS : PROJECT_PATCH_FIELDS;
  for (const key of Object.keys(body)) {
    if (!fields.has(key)) return false;
  }
  if (policy === 'project-create' && (typeof body.id !== 'string' || body.id.length > 128
    || typeof body.name !== 'string' || !body.name.trim() || body.name.length > 100 || body.name.includes('\0'))) return false;
  if (!optionalText(body.pendingPrompt, 64_000) || !optionalText(body.customInstructions, 5000)) return false;
  if (body.conversationMode !== undefined && (typeof body.conversationMode !== 'string' || !['design', 'chat', 'plan'].includes(body.conversationMode))) return false;
  if (!sessionMode || body.skipDiscoveryBrief !== undefined && typeof body.skipDiscoveryBrief !== 'boolean') return false;
  if (body.skillId !== undefined && body.skillId !== null
    && (typeof body.skillId !== 'string' || body.skillId.length === 0 || body.skillId.length > 256)) return false;
  if (body.designSystemId !== undefined && body.designSystemId !== null
    && (typeof body.designSystemId !== 'string' || body.designSystemId.length === 0 || body.designSystemId.length > 256)) return false;
  if (body.updatedAt !== undefined && (typeof body.updatedAt !== 'number' || !Number.isFinite(body.updatedAt))) return false;
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
      if (policy && !multiUserBodyAllowed(policy, req.body, req.get('content-type') ?? '')) {
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
  /** Keep only projects the request's actor owns or was granted (#65); no actor => nothing. */
  filterVisibleProjects<T extends { id: string }>(res: Response, projects: readonly T[]): T[];
  /**
   * Bind the actor as immutable owner. Call INSIDE the create transaction;
   * throws (rolling the create back) when there is no actor or store.
   */
  bindCreatedProject(res: Response, projectId: string, createdAt: number): void;
  /** Record the actor as the conversation's author (#65); call INSIDE the create transaction. */
  bindCreatedConversation(res: Response, conversationId: string): void;
  /** Server projection only; transcript mutation still rechecks in the gate. */
  conversationCanWrite?(res: Response, projectId: string, conversationId: string): boolean;
  /** Await workers; call the returned release in finally AFTER deleting parent/files. */
  cancelOwnedRuns(res: Response, projectId: string, conversationId?: string): Promise<() => void>;
}

// ---- installer ----------------------------------------------------------------

export interface MultiUserFront {
  projectOwnershipHooks: ProjectOwnershipRouteHooks;
  /** Current account state for project authority rechecks in route services. */
  accountActive: (accountId: string) => boolean;
  /** Attach the ownership store to the main daemon database once it is open. */
  attachProjectOwnership: (db: Database.Database) => void;
  setCancelAccountRuns: (cancel: (accountId: string) => void) => void;
  setCompanyPoolAvailable: (check: () => boolean) => void;
  setRenderedExportsAvailable: (check: () => boolean) => void;
  setIsRunOwner: (check: (runId: string, accountId: string) => boolean) => void;
  /** `accountId: null` cancels every account's runs in the project (owner deletion). */
  setCancelProjectRuns: (cancel: (accountId: string | null, projectId: string, conversationId?: string) => Promise<() => void>) => void;
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
  let companyPoolAvailable = () => false;
  let renderedExportsAvailable = () => false;
  let access: ProjectAccessStore | null = null;
  let cancelAccountRuns: ((accountId: string) => void) | null = null;
  let isRunOwner: ((runId: string, accountId: string) => boolean) | null = null;
  let cancelProjectRuns: ((accountId: string | null, projectId: string, conversationId?: string) => Promise<() => void>) | null = null;
  let isAgentAccountOwner: ((param: 'attemptId' | 'accountId', id: string, accountId: string) => boolean) | null = null;
  let bodyPolicyInstalled = false;

  app.use(acknowledgePathlessUse(createMultiUserGate({
    auth,
    allowedOrigins: mode.allowedOrigins,
    previewOrigin: mode.previewOrigin,
    isProjectOwner: (projectId, accountId) => access?.ownership.isOwnedBy(projectId, accountId) ?? false,
    projectShareRole: (projectId, accountId) => access?.roleOf(projectId, accountId) ?? null,
    canWriteConversation: (projectId, conversationId, accountId) => access?.canWriteConversation(projectId, conversationId, accountId) ?? false,
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
    personalRunsEnabled: Boolean(mode.personalCodex),
    personalApiKeysEnabled: mode.personalProviderKeys !== false,
    companyPoolAvailable: () => companyPoolAvailable(),
    renderedExportsAvailable: () => renderedExportsAvailable(),
  });

  const projectOwnershipHooks: ProjectOwnershipRouteHooks = {
    filterVisibleProjects(res, projects) {
      const actor = multiUserActorOf(res);
      if (!actor || !access) return [];
      const owned = access.ownership.listOwnedProjectIds(actor.accountId);
      const shared = access.shareSummaries(actor.accountId);
      return projects.filter((project) => owned.has(project.id) || shared.has(project.id)).map((project) => {
        const summary = shared.get(project.id);
        if (!summary) return project;
        const studioShare: StudioProjectShareSummary = { role: summary.role, memberCount: summary.memberCount,
          ownerUsername: store.getAccountById(summary.ownerAccountId)?.username ?? '' };
        return { ...project, studioShare };
      });
    },
    bindCreatedProject(res, projectId, createdAt) {
      const actor = multiUserActorOf(res);
      if (!actor || !access) throw new Error('multi-user project creation requires a resolved actor');
      access.ownership.bindOwner(projectId, actor.accountId, createdAt);
    },
    bindCreatedConversation(res, conversationId) {
      const actor = multiUserActorOf(res);
      if (!actor || !access) throw new Error('multi-user conversation creation requires a resolved actor');
      access.bindConversationAuthor(conversationId, actor.accountId);
    },
    conversationCanWrite(res, projectId, conversationId) {
      const actor = multiUserActorOf(res);
      return !!actor && access?.canWriteConversation(projectId, conversationId, actor.accountId) === true;
    },
    async cancelOwnedRuns(res, projectId, conversationId) {
      const actor = multiUserActorOf(res);
      if (!actor || !access?.ownership.isOwnedBy(projectId, actor.accountId) || !cancelProjectRuns) {
        throw new Error('multi-user deletion requires an owned project and isolated run service');
      }
      // The owner's deletion also stops collaborators' turns in the project (#65).
      return cancelProjectRuns(null, projectId, conversationId);
    },
  };

  return {
    projectOwnershipHooks,
    accountActive: (accountId) => store.getAccountById(accountId)?.active === true,
    attachProjectOwnership(db) {
      access = new ProjectAccessStore(db, { accountActive: (accountId) => store.getAccountById(accountId)?.active === true });
    },
    setCancelAccountRuns(cancel) { cancelAccountRuns = cancel; },
    setCompanyPoolAvailable(check) { companyPoolAvailable = check; },
    setRenderedExportsAvailable(check) { renderedExportsAvailable = check; },
    setIsRunOwner(check) { isRunOwner = check; },
    setCancelProjectRuns(cancel) { cancelProjectRuns = cancel; },
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
      const precedence = findPrecedenceOrderViolations(registrations);
      if (precedence.length > 0) {
        throw new Error(`multi-user mode refused: a less specific route is registered ahead of an allowed static route: ${precedence.join(', ')}`);
      }
      if (!bodyPolicyInstalled) throw new Error('multi-user mode refused: body policy middleware was not installed');
      if (!access) throw new Error('multi-user mode refused: project ownership store was not attached');
      if (!cancelAccountRuns) throw new Error('multi-user mode refused: isolated run service was not attached');
      if (!isRunOwner) throw new Error('multi-user mode refused: run ownership lookup was not attached');
      if (!cancelProjectRuns) throw new Error('multi-user mode refused: project run cancellation was not attached');
      if (!isAgentAccountOwner) throw new Error('multi-user mode refused: personal account ownership lookup was not attached');
    },
    close() {
      store.close();
    },
  };
}
