import type { ProjectShareRole } from '../storage/project-access.js';
import { MULTIUSER_SHELL_PATHS, MULTIUSER_ASSET_PATHS, MULTIUSER_BUILD_ASSET_ROUTE, MULTIUSER_AGENT_ICON_ROUTE, MULTIUSER_EDITOR_ICON_ROUTE, publicMultiUserFile } from './multiuser-static.js';

// Multi-user route classification registry (issue #4) — declarative data.
//
// Every route the daemon registers (the route-registration inventory, plus
// regex-registered routes and static mounts) is listed here with an explicit
// class and a reason. The multi-user gate (`http/multiuser-gate.ts`) consults
// ONLY this table:
//
//   public-web            explicit public shell and validated build assets only
//   public-probe          no session; process liveness/version only
//   auth                  no session at the gate; the auth registrar enforces its own
//   admin-only            session + persisted role === 'admin'
//   owner-scoped-project  session + the `projectParam` route param must be a project
//                         the actor owns (checked BEFORE the handler); no admin override
//   owner-scoped-run      session + immutable run owner verified before the handler
//   owner-scoped-agent-account  session + the actor's own personal login attempt /
//                         linked account id verified before the handler (#18)
//   actor-scoped          session; the handler scopes to the actor (list filter/create bind)
//   preview-capability    no cookie; handler validates a short-lived owner-bound scope
//   blocked-in-multiuser  denied to everyone, including admins, with the stated reason
//   middleware            a non-terminal `app.use` entry; never authorizes a request
//
// Anything that matches no entry is unclassified and fails closed (404), and
// multi-user startup refuses when the live inventory contains a route missing
// from this table. This slice allows auth, probes, project/conversation access,
// and the isolated test-mock run routes only.
//
// Keys are `METHOD path` exactly as registered. The matcher below supports the
// Express 5 string syntax actually used by the inventory (`:param`, a final
// `*splat`); other syntax is rejected at compile time rather than guessed.

export type MultiUserRouteClass =
  | 'public-web'
  | 'public-probe'
  | 'auth'
  | 'admin-only'
  | 'owner-scoped-project'
  | 'owner-scoped-run'
  | 'owner-scoped-agent-account'
  | 'actor-scoped'
  | 'preview-capability'
  | 'blocked-in-multiuser'
  | 'middleware';

export type MultiUserBodyPolicy = 'project-create' | 'project-patch' | 'conversation-create' | 'conversation-patch' | 'message-write' | 'project-tabs' | 'active-context'
  | 'folder-create' | 'folder-delete' | 'file-write' | 'file-rename' | 'file-version' | 'skill-write' | 'design-system-document' | 'company-openai' | 'studio-settings' | 'studio-memory-entry' | 'studio-memory-index' | 'studio-memory-config' | 'archive-batch' | 'export-html' | 'export-render' | 'comment-upsert' | 'comment-status' | 'comment-anchor' | 'comment-reorder' | 'studio-routine' | 'project-duplicate' | 'template-save' | 'project-share' | 'provider-key' | 'presence-heartbeat' | 'presence-leave' | 'empty' | 'multipart';

/** Per-request ceilings for owner file writes (#58). Larger assets need a resumable upload lane. */
export const MULTIUSER_UPLOAD_MAX_BYTES = 64 * 1024 * 1024;
export const MULTIUSER_FILE_WRITE_MAX_BYTES = 24 * 1024 * 1024;

export interface MultiUserRouteClassification {
  /** `METHOD path`, identical to the registration inventory key. */
  key: string;
  /** Registered method (`GET`, …, `ALL`, `USE`). */
  method: string;
  /** Registered path string (or `String(regexp)` for regex routes). */
  path: string;
  routeClass: MultiUserRouteClass;
  reason: string;
  /** Route param holding the project id (owner-scoped-project only). */
  projectParam?: string;
  runParam?: string;
  /** Route param holding a personal login attempt or linked account id (owner-scoped-agent-account only). */
  agentAccountParam?: 'attemptId' | 'accountId';
  /** Post-parse body policy enforced by the gate. */
  bodyPolicy?: MultiUserBodyPolicy;
  /**
   * Registered with a RegExp or a path array (key uses `String(path)`):
   * listed for review, never matched by the gate, so always denied.
   */
  nonStringPath?: boolean;
  /** Catch-all fallback: never used to classify a request. */
  catchAll?: boolean;
  /**
   * A reviewed RegExp route the gate does match: the same pattern Express
   * routes on (case-sensitive, undecoded path), with each capture group named
   * so the owner check reads its param exactly as for a string route.
   */
  pattern?: RegExp;
  captures?: readonly string[];
  /** Serves owner file bytes on the app origin: the gate applies the untrusted-content response policy. */
  untrustedContent?: boolean;
  /** Declared request-body ceiling; the gate requires a Content-Length within it. */
  maxBodyBytes?: number;
  /**
   * Reviewed alias: after authorization the gate routes the request to this
   * multi-user implementation (`:param` filled from the match, query kept), so
   * the shared client keeps one standard endpoint while the daemon serves the
   * owner/session-bound variant.
   */
  rewriteTo?: string;
  /**
   * owner-scoped-project only: the least project share role (#65) that also
   * admits a non-owner grantee. Absent means the owner alone. Assigned from
   * {@link MULTIUSER_SHARED_PROJECT_ROLES}, never per group.
   */
  sharedRole?: ProjectShareRole;
  /**
   * owner-scoped-project only: route param naming a conversation the actor
   * must have authored (#65), whatever its project role. Assigned from
   * {@link MULTIUSER_CONVERSATION_AUTHOR_PARAMS}.
   */
  conversationParam?: string;
}

export function routeKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

type EntryExtras = Pick<MultiUserRouteClassification, 'projectParam' | 'runParam' | 'agentAccountParam' | 'bodyPolicy' | 'nonStringPath' | 'catchAll' | 'untrustedContent' | 'maxBodyBytes' | 'rewriteTo'>;

function group(
  routeClass: MultiUserRouteClass,
  reason: string,
  keys: readonly string[],
  extras: EntryExtras = {},
): MultiUserRouteClassification[] {
  return keys.map((key) => {
    const space = key.indexOf(' ');
    const method = key.slice(0, space);
    const path = key.slice(space + 1);
    return { key: routeKey(method, path), method: method.toUpperCase(), path, routeClass, reason, ...extras };
  });
}

const blocked = (reason: string, keys: readonly string[]) => group('blocked-in-multiuser', reason, keys);

function nonStringBlocked(
  reason: string,
  routes: ReadonlyArray<readonly [string, RegExp | readonly string[]]>,
): MultiUserRouteClassification[] {
  return routes.map(([method, path]) =>
    group('blocked-in-multiuser', reason, [`${method} ${String(path)}`], { nonStringPath: true })[0]!);
}

/** Reviewed RegExp routes the gate matches with named captures (see `pattern`). */
function regexGroup(
  routeClass: MultiUserRouteClass,
  reason: string,
  routes: ReadonlyArray<readonly [string, RegExp, readonly string[]]>,
  extras: EntryExtras = {},
): MultiUserRouteClassification[] {
  return routes.map(([method, pattern, captures]) => {
    if (pattern.flags.replace('u', '') !== '' || !pattern.source.startsWith('^') || !pattern.source.endsWith('$')) {
      throw new Error(`regex route must be anchored and case-sensitive: ${String(pattern)}`);
    }
    return { ...group(routeClass, reason, [`${method} ${String(pattern)}`], extras)[0]!, pattern, captures };
  });
}

// ---- reasons ----------------------------------------------------------------

const R_NOT_MINIMUM = 'outside the minimum allowed set for this slice; revisit with the multi-user Web UX (#6)';
const R_RUNS = 'real provider execution requires the shared pool/quota (#11) and an approved credential supply';
const R_TOOL_TOKENS = 'agent tool endpoint authorized by run-scoped tool tokens, not accounts; blocked until run isolation (#5)';
const R_HOST_FS = 'host filesystem / desktop integration; not an actor resource';
const R_CREDENTIALS = 'connector/MCP/OAuth/provider credentials are host-level secrets; admin/pool surfaces are #10/#11';
const R_SHARED_CATALOG = 'shared catalog whose user-created entries are global across accounts (not actor-scoped yet)';
const R_PLUGINS = 'plugin install/registry/snapshots are host-level and shared across accounts';
const R_WORKSPACE = 'Vela team workspace feature; workspace/member identity is not the Web login principal';
const R_HOST_OPS = 'host-level daemon operation or diagnostics (local paths, other accounts\' data); admin API is #10';
const R_PROVIDER = 'provider/model access through host credentials; provider integration stays disabled until #11';
const R_STATIC = 'static mount not scoped to an actor; static/preview scoping is a follow-up to #4';
const R_SSE = 'event stream not yet provably scoped to an actor';
const R_PROJECT_FILES = 'project file/preview/export plane not yet verified actor-scoped (#4 follow-up)';
const R_GLOBAL_STATE = 'daemon-global state shared by every account';

// ---- registry ---------------------------------------------------------------

const CLASSIFICATION_ENTRIES: readonly MultiUserRouteClassification[] = [
  ...group('public-web', 'reviewed public app code only; canonical file and symlink checks in the static handler',
    [...MULTIUSER_SHELL_PATHS, ...MULTIUSER_ASSET_PATHS, MULTIUSER_BUILD_ASSET_ROUTE, MULTIUSER_AGENT_ICON_ROUTE, MULTIUSER_EDITOR_ICON_ROUTE].map((path) => `GET ${path}`)),
  // Probes -------------------------------------------------------------------
  ...group('public-probe', 'process liveness/readiness/version only; carries no account or project data', [
    'GET /api/health',
    'GET /api/ready',
    'GET /api/version',
  ]),

  // Auth registrar (mounted only in multi-user mode, before the global parser)
  ...group('auth', 'handled by the auth registrar (routes/auth.ts), which enforces its own session/admin checks and request hardening', [
    'POST /api/auth/bootstrap',
    'POST /api/auth/login',
    'POST /api/auth/logout',
    'GET /api/auth/me',
    'POST /api/auth/session/rotate',
    'POST /api/auth/password',
    'POST /api/auth/setup',
    'GET /api/auth/users',
    'POST /api/auth/users',
    'PATCH /api/auth/users/:id',
    'POST /api/auth/users/:id/sessions/revoke',
    'POST /api/auth/users/:id/password',
    'GET /api/auth/audit',
  ]),
  ...group('middleware', 'auth registrar hardening, bounded body parser and error handler; not an endpoint', ['USE /api/auth']),

  // Non-terminal middleware ----------------------------------------------------
  ...group('middleware', 'route-scoped body parser registered before the global JSON parser; not an endpoint', [
    'USE /api/library/ingest',
    'USE /api/brands/:id/extract-from-html',
    'USE /api/diagnostics/chat-scroll-forensics',
  ]),
  ...group('middleware', 'global /api browser-origin guard; not an endpoint', ['USE /api']),
  ...group('middleware', 'pathless authorization gate; never authorizes on its own', ['USE <pathless:authorization-gate:1>']),
  ...group('middleware', 'pathless global JSON parser; never authorizes on its own', ['USE <pathless:json-parser:1>']),
  ...group('middleware', 'pathless project body policy; never authorizes on its own', ['USE <pathless:body-policy:1>']),
  ...group('middleware', 'root static middleware is disabled for requests in multi-user mode', ['USE <pathless:root-static:1>']),

  // Projects: the minimum allowed set -------------------------------------------
  ...group('actor-scoped', 'transient focus keyed by authenticated session; project ownership rechecked before any content lookup',
    ['GET /api/active']),
  ...group('actor-scoped', 'transient session focus; bounded body and project ownership checked by handler; no global MCP context',
    ['POST /api/active'], { bodyPolicy: 'active-context' }),
  ...group('actor-scoped', 'lists only projects the actor owns (ProjectOwnershipRouteHooks.filterVisibleProjects)', [
    'GET /api/projects',
  ]),
  ...group(
    'actor-scoped',
    'creates a project owned by the actor; the owner binding is written in the create transaction; body limited by the project-create policy',
    ['POST /api/projects'],
    { bodyPolicy: 'project-create', rewriteTo: '/api/multiuser/projects', maxBodyBytes: 256_000 },
  ),
  ...group('actor-scoped', 'account project creation with captured template files and atomic ownership', ['POST /api/multiuser/projects'],
    { bodyPolicy: 'project-create', maxBodyBytes: 256_000 }),
  ...group('owner-scoped-project', 'owned file copy; no host or conversation credentials copied', ['POST /api/projects/:id/duplicate'],
    { projectParam: 'id', bodyPolicy: 'project-duplicate', maxBodyBytes: 4096, rewriteTo: '/api/multiuser/projects/:id/duplicate' }),
  ...group('owner-scoped-project', 'owned file copy alias; authority rechecked before publication', ['POST /api/multiuser/projects/:id/duplicate'],
    { projectParam: 'id', bodyPolicy: 'project-duplicate', maxBodyBytes: 4096 }),
  ...['GET /api/templates', 'GET /api/templates/:id', 'POST /api/templates', 'DELETE /api/templates/:id'].flatMap((key) => {
    const alias = key.replace('/api/templates', '/api/multiuser/catalog/templates');
    const extras = key.startsWith('POST ') ? { bodyPolicy: 'template-save' as const, maxBodyBytes: 8192 }
      : key.startsWith('DELETE ') ? { bodyPolicy: 'empty' as const } : {};
    return [...group('actor-scoped', 'account-owned immutable template snapshots; no host template store', [key],
      { ...extras, rewriteTo: alias.slice(alias.indexOf(' ') + 1) }),
      ...group('actor-scoped', 'account template alias; same ownership checks', [alias], extras)];
  }),
  ...group('actor-scoped', 'bounded browser archive import to an owned managed project', ['POST /api/import/claude-design'],
    { bodyPolicy: 'multipart', maxBodyBytes: MULTIUSER_UPLOAD_MAX_BYTES + 65536, rewriteTo: '/api/multiuser/import/claude-design' }),
  ...group('actor-scoped', 'browser archive alias; no host paths or workspace identity', ['POST /api/multiuser/import/claude-design'],
    { bodyPolicy: 'multipart', maxBodyBytes: MULTIUSER_UPLOAD_MAX_BYTES + 65536 }),
  ...group('actor-scoped', 'bounded browser directory upload; relative files only, no host paths', ['POST /api/import/files'],
    { bodyPolicy: 'multipart', maxBodyBytes: MULTIUSER_UPLOAD_MAX_BYTES + 65536 }),
  ...group('owner-scoped-project', 'project id must be owned by the actor (gate check before the handler); no admin override', [
    'GET /api/projects/:id',
    'DELETE /api/projects/:id',
    'GET /api/projects/:id/conversations',
    'GET /api/projects/:id/conversations/:cid/messages',
    'GET /api/projects/:id/files',
    'GET /api/projects/:id/file-content/*path',
    'GET /api/projects/:id/tabs',
    'GET /api/projects/:id/events',
    'DELETE /api/projects/:id/conversations/:cid',
    'GET /api/multiuser/projects/:id/preview-url',
    'POST /api/multiuser/projects/:id/preview/:scope/renew',
    'POST /api/multiuser/projects/:id/conversations',
    'GET /api/multiuser/projects/:id/conversations/:cid/design',
    'GET /api/multiuser/projects/:id/design-selections',
  ], { projectParam: 'id' }),
  ...group('owner-scoped-project', 'project owner checked before standard Studio mutation; bounded body cannot change resource or run ownership',
    ['POST /api/projects/:id/conversations'], { projectParam: 'id', bodyPolicy: 'conversation-create' }),
  ...group('owner-scoped-project', 'project owner checked before conversation title or mode update; immutable parent binding',
    ['PATCH /api/projects/:id/conversations/:cid'], { projectParam: 'id', bodyPolicy: 'conversation-patch' }),
  ...group('owner-scoped-project', 'project and conversation scoped message lookup; client cannot write daemon run identity or foreign message rows',
    ['PUT /api/projects/:id/conversations/:cid/messages/:mid'], { projectParam: 'id', bodyPolicy: 'message-write' }),
  ...group('owner-scoped-project', 'project owner checked before tabs write; remote actors cannot create host browser sessions',
    ['PUT /api/projects/:id/tabs'], { projectParam: 'id', bodyPolicy: 'project-tabs' }),
  ...group(
    'owner-scoped-project',
    'project id must be owned by the actor (gate check before the handler); body limited by the project-patch policy',
    ['PATCH /api/projects/:id'],
    { projectParam: 'id', bodyPolicy: 'project-patch' },
  ),

  // Projects: everything else stays blocked -------------------------------------
  ...blocked(R_WORKSPACE, [
    'POST /api/projects/:id/collab/changed',
    'POST /api/projects/:id/collab/publish',
    'POST /api/projects/:id/collab/sync-intent',
    'POST /api/projects/:id/collab/pull',
    'PUT /api/projects/:id/collab/bootstrap',
    'GET /api/projects/:id/collab/status',
    'GET /api/projects/:id/workspace-scope',
  ]),
  ...blocked(R_HOST_FS, [
    'POST /api/projects/:id/open-in',
    'POST /api/projects/:id/working-dir',
  ]),
  ...blocked('imports through host Figma credentials/network', ['POST /api/projects/:id/figma/import']),
  ...blocked('copies content from plugins, templates or design systems that are not actor-scoped', [
    'POST /api/projects/:id/scenario/restore-automatic',
    'POST /api/projects/:id/design-system-copy',
  ]),
  // Project sharing between accounts of this deployment (#65). The owner
  // manages grants; a grantee reads its own access and may leave. Presence is
  // stamped from the session, never from a client-asserted member.
  ...group('owner-scoped-project', 'project owner manages account grants; grantees resolved server-side by username',
    ['DELETE /api/multiuser/projects/:id/shares/:accountId'], { projectParam: 'id' }),
  ...group('owner-scoped-project', 'project owner grants view/comment/edit to an active account of this deployment',
    ['PUT /api/multiuser/projects/:id/shares'], { projectParam: 'id', bodyPolicy: 'project-share', maxBodyBytes: 4 * 1024 }),
  ...group('owner-scoped-project', 'the actor\'s own role and the member list of a project it owns or was granted; leaving removes only that grant',
    ['GET /api/multiuser/projects/:id/access', 'DELETE /api/multiuser/projects/:id/access'], { projectParam: 'id' }),
  ...([
    ['GET', '', undefined],
    ['POST', '/heartbeat', 'presence-heartbeat'],
    ['POST', '/leave', 'presence-leave'],
  ] as const).flatMap(([method, suffix, bodyPolicy]) => {
    const extras = { projectParam: 'id', ...(bodyPolicy ? { bodyPolicy, maxBodyBytes: 4 * 1024 } : {}) };
    return [
      ...group('owner-scoped-project', 'project presence for the owner and grantees; identity from the session, process-local, no relay',
        [`${method} /api/projects/:id/presence${suffix}`], { ...extras, rewriteTo: `/api/multiuser/projects/:id/presence${suffix}` }),
      ...group('owner-scoped-project', 'project presence alias', [`${method} /api/multiuser/projects/:id/presence${suffix}`], extras),
    ];
  }),
  // Owner-only preview comments (#59, #65): standard paths rewrite to the
  // actor handler; the host handler's workspace/collab identity never runs.
  ...([
    ['GET', '', undefined],
    ['POST', '', 'comment-upsert'],
    ['PATCH', '/:commentId', 'comment-status'],
    ['PATCH', '/:commentId/anchor', 'comment-anchor'],
    ['PATCH', '/:commentId/reorder', 'comment-reorder'],
    ['DELETE', '/:commentId', 'empty'],
  ] as const).flatMap(([method, suffix, bodyPolicy]) => {
    const extras = { projectParam: 'id', ...(bodyPolicy ? { bodyPolicy, ...(bodyPolicy === 'empty' ? {} : { maxBodyBytes: 64 * 1024 }) } : {}) };
    return [
      ...group('owner-scoped-project', 'owner-only preview comments; conversation rechecked in the project, no member identity or relay',
        [`${method} /api/projects/:id/conversations/:cid/comments${suffix}`],
        { ...extras, rewriteTo: `/api/multiuser/projects/:id/conversations/:cid/comments${suffix}` }),
      ...group('owner-scoped-project', 'owner-only preview comment alias; same ownership checks',
        [`${method} /api/multiuser/projects/:id/conversations/:cid/comments${suffix}`], extras),
    ];
  }),
  ...blocked('interactive host shell; never available to Web accounts without run isolation (#5)', [
    'GET /api/projects/:id/terminals',
    'POST /api/projects/:id/terminals',
    'GET /api/projects/:id/terminals/:tid/stream',
    'POST /api/projects/:id/terminals/:tid/stdin',
    'POST /api/projects/:id/terminals/:tid/resize',
    'POST /api/projects/:id/terminals/:tid/kill',
    'DELETE /api/projects/:id/terminals/:tid',
  ]),
  ...blocked('host browser automation sessions', [
    'POST /api/projects/:id/browser-sessions',
    'DELETE /api/projects/:id/browser-sessions/:sessionId',
  ]),
  ...blocked('deploy/finalize/handoff use host provider credentials', [
    'GET /api/projects/:id/deployments',
    'POST /api/projects/:id/deploy',
    'POST /api/projects/:id/deploy/preflight',
    'POST /api/projects/:id/finalize/:provider',
    'POST /api/projects/:id/handoff',
    'POST /api/projects/:id/deployments/:deploymentId/check-link',
  ]),
  // S5 (#58): the owner's managed project files. Paths resolve inside the
  // project root with symlink-aware checks in the handlers; bytes served on
  // the app origin carry the untrusted-content policy; writes are bounded.
  ...group('owner-scoped-project', 'owner project file reads; handlers resolve paths inside the managed project root', [
    'GET /api/projects/:id/search',
    'GET /api/projects/:id/folders',
  ], { projectParam: 'id' }),
  ...group('owner-scoped-project', 'owner folder create in the managed project root', ['POST /api/projects/:id/folders'],
    { projectParam: 'id', bodyPolicy: 'folder-create' }),
  ...group('owner-scoped-project', 'owner folder delete in the managed project root', ['DELETE /api/projects/:id/folders'],
    { projectParam: 'id', bodyPolicy: 'folder-delete' }),
  ...group('owner-scoped-project', 'owner file write (JSON text/base64 or one multipart file); no artifact manifests', ['POST /api/projects/:id/files'],
    { projectParam: 'id', bodyPolicy: 'file-write', maxBodyBytes: MULTIUSER_FILE_WRITE_MAX_BYTES }),
  ...group('owner-scoped-project', 'owner file rename inside the managed project root', ['POST /api/projects/:id/files/rename'],
    { projectParam: 'id', bodyPolicy: 'file-rename' }),
  ...group('owner-scoped-project', 'owner file delete inside the managed project root', ['DELETE /api/projects/:id/files/:name'], { projectParam: 'id' }),
  ...group('owner-scoped-project', 'owner multipart upload into the managed project root; bounded request', ['POST /api/projects/:id/upload'],
    { projectParam: 'id', bodyPolicy: 'multipart', maxBodyBytes: MULTIUSER_UPLOAD_MAX_BYTES }),
  // S6 (#59): the standard preview URL mints the owner/session-bound capability
  // on the dedicated preview origin (#39), never an app-origin scope.
  ...group('owner-scoped-project', 'mints an owner/session-bound capability on the preview origin', ['GET /api/projects/:id/preview-url'],
    { projectParam: 'id', rewriteTo: '/api/multiuser/projects/:id/preview-url' }),
  ...regexGroup('owner-scoped-project', 'owner file bytes on the app origin; served under the untrusted-content policy', [
    ['GET', /^\/api\/projects\/([^/]+)\/files\/(.+)$/u, ['id', 'path']],
    ['GET', /^\/api\/projects\/([^/]+)\/raw\/(.+)$/u, ['id', 'path']],
    ['GET', /^\/api\/projects\/([^/]+)\/files\/(.+)\/versions\/([^/]+)$/u, ['id', 'path', 'versionId']],
  ], { projectParam: 'id', untrustedContent: true }),
  ...regexGroup('owner-scoped-project', 'owner file metadata, versions and text extraction', [
    ['GET', /^\/api\/projects\/([^/]+)\/files\/(.+)\/versions$/u, ['id', 'path']],
    ['GET', /^\/api\/projects\/([^/]+)\/text-preview\/(.+)$/u, ['id', 'path']],
  ], { projectParam: 'id' }),
  ...regexGroup('owner-scoped-project', 'owner file delete by path', [
    ['DELETE', /^\/api\/projects\/([^/]+)\/raw\/(.+)$/u, ['id', 'path']],
  ], { projectParam: 'id' }),
  ...regexGroup('owner-scoped-project', 'owner manual version capture', [
    ['POST', /^\/api\/projects\/([^/]+)\/files\/(.+)\/versions$/u, ['id', 'path']],
  ], { projectParam: 'id', bodyPolicy: 'file-version' }),
  ...regexGroup('owner-scoped-project', 'owner version restore', [
    ['POST', /^\/api\/projects\/([^/]+)\/files\/(.+)\/versions\/([^/]+)\/restore$/u, ['id', 'path', 'versionId']],
  ], { projectParam: 'id', bodyPolicy: 'empty' }),
  ...group('owner-scoped-project', 'immutable artifact metadata and refs; handlers verify project, conversation and artifact lineage', [
    'GET /api/projects/:id/conversations/:cid/messages/:mid/artifacts',
    'GET /api/projects/:id/chat-artifact-snapshots/:sid',
    'GET /api/projects/:id/workspace-artifacts/:aid',
  ], { projectParam: 'id' }),
  ...group('owner-scoped-project', 'immutable owner artifact bytes; untrusted content and no-store on the app origin', [
    'GET /api/projects/:id/chat-artifact-snapshots/:sid/content',
    'GET /api/projects/:id/chat-artifact-snapshots/:sid/thumbnail',
  ], { projectParam: 'id', untrustedContent: true }),
  ...['GET /api/projects/:id/archive', 'POST /api/projects/:id/archive/batch'].flatMap((key) => {
    const method = key.startsWith('POST ') ? 'POST' : 'GET';
    const route = key.slice(method.length + 1);
    const alias = route.replace('/api/projects/', '/api/multiuser/projects/');
    const extras = method === 'POST' ? { bodyPolicy: 'archive-batch' as const, maxBodyBytes: 512 * 1024 } : {};
    return [...group('owner-scoped-project', 'bounded owned ZIP capture; no host paths or credentials', [key],
      { projectParam: 'id', ...extras, rewriteTo: alias }),
      ...group('owner-scoped-project', 'owned ZIP alias; fresh authority before byte release', [`${method} ${alias}`],
        { projectParam: 'id', ...extras })];
  }),
  ...group('owner-scoped-project', 'one-file HTML bundle of an owned entry; same-project assets only, no renderer or host paths',
    ['POST /api/projects/:id/export/html'],
    { projectParam: 'id', bodyPolicy: 'export-html', maxBodyBytes: 8 * 1024, rewriteTo: '/api/multiuser/projects/:id/export/html' }),
  ...group('owner-scoped-project', 'owned HTML export alias; fresh authority before byte release', ['POST /api/multiuser/projects/:id/export/html'],
    { projectParam: 'id', bodyPolicy: 'export-html', maxBodyBytes: 8 * 1024 }),
  // Server-rendered PDF/PPTX/PNG of an owned entry (#66); captured bytes in an isolated headless browser.
  ...['pptx', 'pdf-image', 'image'].flatMap((format) => [
    ...group('owner-scoped-project', 'owner render of captured project bytes; no daemon URL or network reachable from the renderer',
      [`POST /api/projects/:id/export/${format}`],
      { projectParam: 'id', bodyPolicy: 'export-render', maxBodyBytes: 8 * 1024, rewriteTo: `/api/multiuser/projects/:id/export/${format}` }),
    ...group('owner-scoped-project', 'owner render alias; fresh authority before byte release', [`POST /api/multiuser/projects/:id/export/${format}`],
      { projectParam: 'id', bodyPolicy: 'export-render', maxBodyBytes: 8 * 1024 }),
  ]),
  ...blocked(R_PROJECT_FILES, [
    'GET /api/projects/:id/export/manifest',
    'POST /api/projects/:id/export/pdf',
    'POST /api/projects/:id/export',
    'GET /api/projects/:id/export/*splat',
    'GET /api/projects/:id/design-token-suggestions',
    'GET /api/projects/:id/design-system-package-audit',
    'POST /api/projects/:id/preview/:scope/renew',
    'GET /api/projects/:id/files/:name/preview',
  ]),
  ...['GET /api/routines', 'POST /api/routines', 'GET /api/routines/:id', 'PATCH /api/routines/:id', 'DELETE /api/routines/:id',
    'POST /api/routines/:id/run', 'GET /api/routines/:id/runs'].flatMap((key) => {
    const alias = key.replace('/api/routines', '/api/multiuser/routines');
    const bodyPolicy = key.startsWith('POST /api/routines/:id/run') || key.startsWith('DELETE ') ? 'empty' as const
      : key.startsWith('POST ') || key.startsWith('PATCH ') ? 'studio-routine' as const : undefined;
    const extras = bodyPolicy === 'studio-routine' ? { bodyPolicy, maxBodyBytes: 64 * 1024 } : bodyPolicy ? { bodyPolicy } : {};
    return [...group('actor-scoped', 'account-owned Automations; every dispatch revalidates the owner, pilot, project and execution source', [key],
      { ...extras, rewriteTo: alias.slice(alias.indexOf(' ') + 1) }),
      ...group('actor-scoped', 'account Automations alias; same cookie authority and closed fields', [alias], extras)];
  }),
  ...blocked(R_RUNS, [
    'POST /api/projects/:id/media/hyperframes/scaffold',
    'POST /api/projects/:id/media/generate',
    'GET /api/projects/:id/media/tasks',
    'GET /api/projects/:projectId/genui',
    'POST /api/projects/:projectId/genui/:surfaceId/revoke',
    'POST /api/projects/:projectId/genui/prefill',
    'POST /api/projects/:projectId/critique/:runId/interrupt',
    'GET /api/projects/:projectId/critique/:runId/artifact',
  ]),
  ...blocked(R_PLUGINS, [
    'GET /api/projects/:projectId/applied-plugins',
    'POST /api/projects/:id/plugins/install-folder',
    'POST /api/projects/:id/plugins/publish-github',
    'GET /api/projects/:id/plugin-candidates',
    'POST /api/projects/:id/plugin-candidates/:candidateId/dismiss',
    'POST /api/projects/:id/plugin-candidates/:candidateId/draft',
    'POST /api/projects/:id/plugin-candidates/:candidateId/share-tasks',
    'POST /api/projects/:id/plugins/contribute-open-design',
    'POST /api/projects/:id/plugins/share-tasks',
  ]),
  ...nonStringBlocked(R_PROJECT_FILES, [
    ['POST', /^\/api\/projects\/([^/]+)\/files\/(.+)\/publish-public$/u],
    ['DELETE', /^\/api\/projects\/([^/]+)\/files\/(.+)\/publish-public$/u],
    ['GET', /^\/api\/projects\/([^/]+)\/files\/(.+)\/publish-public$/u],
    ['GET', /^\/api\/projects\/([^/]+)\/preview\/([^/]+)\/(.+)$/u],
    ['OPTIONS', /^\/api\/projects\/([^/]+)\/raw\/(.+)$/u],
    ['OPTIONS', /^\/api\/projects\/([^/]+)\/powered\/(.+)$/u],
    ['GET', /^\/api\/projects\/([^/]+)\/powered\/(.+)$/u],
  ]),

  // Static mounts and the SPA shell -----------------------------------------------
  ...blocked(R_STATIC, ['USE /artifacts', 'USE /frames', 'USE /api/plugin-previews']),
  ...group(
    'blocked-in-multiuser',
    'SPA shell fallback; the multi-user Web UX (#6) is not built, so no shell is served and the catch-all never classifies a request',
    ['GET /*splat'],
    { catchAll: true },
  ),

  // Execution --------------------------------------------------------------------
  ...group('actor-scoped', 'body-free built-in design catalogue; handler excludes every user-installed entry', [
    'GET /api/multiuser/design-catalog',
  ]),
  ...group('preview-capability', 'cookie-free preview origin; handler validates the owner/session-bound short-lived scope', [
    'GET /api/multiuser/projects/:id/preview/:scope/*path',
  ]),
  ...group('admin-only', 'per-account Studio pilot metadata; handler validates revision and closed body', [
    'GET /api/admin/users/:id/studio-pilot',
    'PUT /api/admin/users/:id/studio-pilot',
  ]),
  ...group('admin-only', 'aggregate pool operations; no project or run content', [
    'GET /api/admin/pool',
    'PUT /api/admin/pool/providers/:providerId',
    'PUT /api/admin/pool/users/:id/quota',
  ]),
  ...group('admin-only', 'company OpenAI metadata; credentials never returned', ['GET /api/admin/pool/openai']),
  ...group('admin-only', 'write-only encrypted company credential and revision-checked provider policy', ['PUT /api/admin/pool/openai'], { bodyPolicy: 'company-openai' }),
  ...group('actor-scoped', 'test mock only; create binds the trusted actor, owned managed project and conversation in one SQLite insert', [
    'POST /api/runs',
    'GET /api/runs',
  ]),
  ...group('owner-scoped-run', 'gate and handler verify immutable run owner and project before lookup, stream or cancellation; no admin override', [
    'GET /api/runs/:id',
    'GET /api/runs/:id/events',
    'POST /api/runs/:id/cancel',
    'POST /api/runs/:id/steer',
    'POST /api/runs/:id/feedback',
  ], { runParam: 'id' }),
  // Personal subscription accounts (#18): the actor's own provider link only.
  ...group('actor-scoped', 'personal subscription summary and login start; the handler keys every lookup by the actor', [
    'GET /api/agent-accounts',
    'POST /api/agent-accounts/codex/logins',
  ]),
  ...group('owner-scoped-agent-account', 'login attempt must belong to the actor (gate check before the handler); foreign and forged ids are the same 404; no admin override', [
    'GET /api/agent-accounts/codex/logins/:attemptId',
    'POST /api/agent-accounts/codex/logins/:attemptId/cancel',
  ], { agentAccountParam: 'attemptId' }),
  ...group('owner-scoped-agent-account', 'linked account must be the actor\'s own (gate check before the handler); admins cannot verify, use or unlink it', [
    'POST /api/agent-accounts/codex/accounts/:accountId/verify',
    'DELETE /api/agent-accounts/codex/accounts/:accountId',
  ], { agentAccountParam: 'accountId' }),
  ...group('admin-only', 'personal subscription metadata (linked, status, timestamps, worker time) and the host-wide personal worker ceiling; no identity or secrets', [
    'GET /api/admin/agent-accounts',
    'PUT /api/admin/agent-accounts/personal-capacity',
  ]),
  ...blocked(R_RUNS, [
    'POST /api/chat',
    'GET /api/runs/by-plugin-workflow/:workflowId',
    'GET /api/runs/:id/result-package',
    'GET /api/runs/:id/agui',
    'GET /api/runs/:runId/genui',
    'POST /api/runs/:runId/genui/:surfaceId/respond',
    'GET /api/runs/:runId/genui/:surfaceId',
    'GET /api/runs/:runId/devloop-iterations',
    'POST /api/runs/:runId/replay',
    'GET /api/automation-source-packets',
    'GET /api/automation-source-packets/:id',
    'POST /api/automation-ingestions',
    'GET /api/automation-proposals',
    'POST /api/automation-proposals',
    'GET /api/automation-proposals/:id',
    'POST /api/automation-proposals/:id/apply',
    'POST /api/automation-proposals/:id/reject',
    'GET /api/automation-templates',
    'GET /api/automation-templates/:id',
    'POST /api/routines/:id/runs/:runId/crystallize',
    'GET /api/orbit/status',
    'POST /api/orbit/run',
    'POST /api/research/search',
    'GET /api/critique/conformance',
    'POST /api/media/tasks/:id/wait',
    'POST /api/plugins/share-tasks/:id/wait',
  ]),
  ...blocked(R_SSE, [
    'GET /api/library/events',
    'GET /api/workspace/events',
    'GET /api/plugins/events',
    'GET /api/plugins/events/snapshot',
    'GET /api/plugins/events/stats',
    'POST /api/plugins/events/purge',
  ]),
  ...blocked(R_TOOL_TOKENS, [
    'GET /api/tools/connectors/list',
    'POST /api/tools/connectors/execute',
    'POST /api/tools/library/search',
    'POST /api/tools/library/apply',
    'POST /api/tools/live-artifacts/create',
    'GET /api/tools/live-artifacts/list',
    'POST /api/tools/live-artifacts/update',
    'POST /api/tools/live-artifacts/refresh',
    'POST /api/tools/deliverable-syntax/check',
    'POST /api/tools/design-systems/read',
    'POST /api/tools/media/hyperframes/scaffold',
    'POST /api/tools/media/generate',
  ]),
  ...blocked('live artifacts are refreshed by agents/connectors and are not actor-scoped', [
    'GET /api/live-artifacts',
    'OPTIONS /api/live-artifacts/:artifactId/preview',
    'GET /api/live-artifacts/:artifactId/preview',
    'GET /api/live-artifacts/:artifactId',
    'GET /api/live-artifacts/:artifactId/refreshes',
    'PATCH /api/live-artifacts/:artifactId',
    'DELETE /api/live-artifacts/:artifactId',
    'OPTIONS /api/live-artifacts/:artifactId/refresh',
    'POST /api/live-artifacts/:artifactId/refresh',
  ]),

  // Host / credentials / providers -------------------------------------------------
  ...blocked(R_CREDENTIALS, [
    'POST /api/agents/:agentId/oauth-launch',
    'POST /api/agents/:agentId/companion/install',
    'GET /api/agents',
    'GET /api/connectors',
    'GET /api/connectors/status',
    'GET /api/connectors/discovery',
    'GET /api/connectors/logos/:slug',
    'GET /api/connectors/composio/config',
    'PUT /api/connectors/composio/config',
    'GET /api/connectors/:connectorId',
    'POST /api/connectors/auth-configs/prepare',
    'POST /api/connectors/:connectorId/connect',
    'GET /api/connectors/oauth/callback/:connectorId',
    'POST /api/connectors/:connectorId/authorization/cancel',
    'DELETE /api/connectors/:connectorId/connection',
    'GET /api/mcp/install-info',
    'GET /api/mcp/install/codex/status',
    'POST /api/mcp/install/codex',
    'DELETE /api/mcp/install/codex',
    'GET /api/mcp/servers',
    'PUT /api/mcp/servers',
    'POST /api/mcp/oauth/start',
    'GET /api/mcp/oauth/callback',
    'GET /api/mcp/oauth/status',
    'POST /api/mcp/oauth/disconnect',
    'POST /api/xai/oauth/start',
    'POST /api/xai/oauth/complete',
    'GET /api/xai/auth/status',
    'POST /api/xai/oauth/cancel',
    'POST /api/xai/oauth/disconnect',
    'POST /api/xai/search',
    'GET /api/integrations/vela/status',
    'GET /api/integrations/vela/wallet',
    'ALL /api/integrations/vela/api-proxy/*splat',
    'GET /api/integrations/vela/message-center-public/messages',
    'ALL /api/integrations/vela/message-center/*splat',
    'POST /api/integrations/vela/login',
    'POST /api/integrations/vela/login/cancel',
    'POST /api/integrations/vela/analytics-entry',
    'POST /api/integrations/vela/analytics-profile',
    'POST /api/integrations/vela/logout',
    'GET /api/deploy/config',
    'PUT /api/deploy/config',
    'GET /api/deploy/cloudflare-pages/zones',
    'GET /api/media/config',
    'PUT /api/media/config',
  ]),
  ...nonStringBlocked(R_CREDENTIALS, [
    ['ALL', ['/api/touchpoints/production-runtime', '/api/touchpoints/production-runtime/*splat']],
    ['ALL', ['/api/touchpoints/test-runtime', '/api/touchpoints/test-runtime/*splat']],
  ]),
  ...blocked(R_PROVIDER, [
    'GET /api/amr/models',
    'GET /api/media/models',
    'GET /api/media/providers/aihubmix/models',
    'GET /api/media/providers/elevenlabs/voices',
    'POST /api/provider/models',
    'POST /api/proxy/anthropic/stream',
    'POST /api/proxy/openai/stream',
    'POST /api/proxy/azure/stream',
    'POST /api/proxy/google/stream',
    'POST /api/proxy/ollama/stream',
    'POST /api/proxy/senseaudio/stream',
    'POST /api/proxy/aihubmix/stream',
    'POST /api/proxy/:provider/stream',
    'POST /api/test/connection',
  ]),
  ...blocked(R_HOST_FS, [
    'POST /api/dialog/open-folder',
    'POST /api/dir-exists',
    'GET /api/recent-dirs',
    'GET /api/editors',
    'POST /api/system/open-external',
    'GET /api/project-locations',
    'PUT /api/project-locations',
    'POST /api/project-locations/scan',
    'POST /api/import/folder',
    'POST /api/codex-pets/sync',
  ]),
  // In-page pet (#67): bundled pets only; host CODEX_HOME pets and the sync that writes there stay host-owned.
  ...['GET /api/codex-pets', 'GET /api/codex-pets/:id/spritesheet'].flatMap((key) => {
    const alias = key.replace('/api/codex-pets', '/api/multiuser/catalog/codex-pets');
    return [...group('actor-scoped', 'bundled in-page pet catalog; no host CODEX_HOME pets', [key], { rewriteTo: alias.slice(alias.indexOf(' ') + 1) }),
      ...group('actor-scoped', 'bundled pet catalog alias', [alias])];
  }),
  ...blocked(R_HOST_OPS, [
    'GET /api/daemon/status',
    'GET /api/daemon/db',
    'POST /api/daemon/db/verify',
    'POST /api/daemon/db/vacuum',
    'POST /api/daemon/shutdown',
    'GET /api/diagnostics/amr-terminal-reports',
    'POST /api/diagnostics/chat-scroll-forensics',
    'GET /api/diagnostics/export',
    'GET /api/metrics',
    'POST /api/observability/event',
    'GET /api/preview/isolation',
  ]),
  ...blocked('daemon-global app configuration (agent CLI env, providers, labs); admin surface is #10', [
    'GET /api/strategies/od-next/rollout',
  ]),
  ...blocked(R_GLOBAL_STATE, [
    'GET /api/analytics/config',
    'POST /api/analytics/mcp/context',
    'POST /api/analytics/mcp/event',
    'POST /api/attribution/claim',
    'POST /api/attribution/bridge-url',
    'GET /api/memory/extractions',
    'DELETE /api/memory/extractions',
    'DELETE /api/memory/extractions/:id',
    'GET /api/memory/verifications',
    'DELETE /api/memory/verifications',
    'DELETE /api/memory/verifications/:id',
    'POST /api/memory/rules/suggest',
    'POST /api/memory/connectors/suggest',
    'POST /api/memory/connectors/extract',
    'POST /api/memory/extract',
    'POST /api/upload',
    'POST /api/artifacts/save',
    'POST /api/artifacts/lint',
    'POST /api/social-share',
  ]),
  ...blocked('daemon-global clipper library, pairing and extension ingest', [
    'POST /api/library/pair',
    'OPTIONS /api/library/pair/confirm',
    'POST /api/library/pair/confirm',
    'GET /api/library/connection',
    'OPTIONS /api/library/ingest',
    'POST /api/library/ingest',
    'GET /api/library/clipper-probe',
    'GET /api/library/assets',
    'POST /api/library/sync',
    'GET /api/library/assets/:id',
    'DELETE /api/library/assets/:id',
    'GET /api/library/assets/:id/raw',
    'GET /api/library/assets/:id/figma',
    'GET /api/library/assets/:id/element',
    'POST /api/library/assets/:id/apply',
    'POST /api/library/assets/:id/edit-as-page',
  ]),
  ...blocked('brand extraction writes the daemon-global brand library and runs agents', [
    'GET /api/brands',
    'POST /api/brands',
    'POST /api/brands/:id/continue-extraction',
    'POST /api/brands/:id/cancel-extraction',
    'POST /api/brands/:id/preview',
    'POST /api/brands/:id/finalize',
    'POST /api/brands/:id/extract-from-html',
    'GET /api/brands/:id',
    'DELETE /api/brands/:id',
    'GET /api/brands/:id/logo',
  ]),

  // Account-private provider keys (#62/#63): write-only, encrypted per account; reads show only last4.
  ...group('actor-scoped', 'the actor\'s own provider key summaries; never the key, never another account', ['GET /api/multiuser/settings/provider-keys']),
  ...group('actor-scoped', 'write-only account provider key sealed with the deployment master key; revision-checked; no admin read path',
    ['PUT /api/multiuser/settings/provider-keys/:provider'], { bodyPolicy: 'provider-key', maxBodyBytes: 8 * 1024 }),
  // Actor preferences and manual memory (#62); host registrars never run.
  ...[
    ['GET /api/app-config', undefined],
    ['PUT /api/app-config', 'studio-settings'],
    ['GET /api/memory', undefined],
    ['GET /api/memory/tree', undefined],
    ['PATCH /api/memory/tree/:id', 'studio-memory-entry'],
    ['PUT /api/memory/index', 'studio-memory-index'],
    ['PATCH /api/memory/config', 'studio-memory-config'],
    ['GET /api/memory/events', undefined],
    ['GET /api/memory/system-prompt', undefined],
    ['POST /api/memory', 'studio-memory-entry'],
    ['GET /api/memory/:id', undefined],
    ['PUT /api/memory/:id', 'studio-memory-entry'],
    ['DELETE /api/memory/:id', 'empty'],
  ].flatMap(([key, policy]) => {
    const alias = key!.replace('/api/app-config', '/api/multiuser/settings/config').replace('/api/memory', '/api/multiuser/settings/memory');
    const bodyPolicy = policy as MultiUserBodyPolicy | undefined;
    const extras = bodyPolicy ? { bodyPolicy } : {};
    return [...group('actor-scoped', 'account-owned preferences and manual memory; private stream; no host settings or provider access', [key!],
      { ...extras, rewriteTo: alias.slice(alias.indexOf(' ') + 1) }),
      ...group('actor-scoped', 'actor settings alias; identical cookie authority and closed fields', [alias], extras)];
  }),

  // Shared catalogs / plugins ------------------------------------------------------
  ...['GET /api/skills', 'GET /api/skills/:id', 'GET /api/skills/:id/files',
    'POST /api/skills/import', 'PUT /api/skills/:id', 'DELETE /api/skills/:id'].flatMap((key) => {
    const alias = key.replace('/api/skills', '/api/multiuser/catalog/skills');
    const rewriteTo = alias.slice(alias.indexOf(' ') + 1);
    const bodyPolicy = key.startsWith('POST ') || key.startsWith('PUT ') ? 'skill-write' as const
      : key.startsWith('DELETE ') ? 'empty' as const : undefined;
    const extras = bodyPolicy ? { bodyPolicy } : {};
    return [...group('actor-scoped', 'bundled reads and account-owned text skills; immutable revisions; no host registry access', [key], { ...extras, rewriteTo }),
      ...group('actor-scoped', 'actor catalog alias; same cookie authority and bounded skill body', [alias], extras)];
  }),
  ...group('actor-scoped', 'bounded browser skill folder upload to an account-private immutable package; relative files only', ['POST /api/skills/import-files'],
    { bodyPolicy: 'multipart', maxBodyBytes: 8 * 1024 * 1024 + 65536 * 4 }),
  ...group('actor-scoped', 'skill folder upload alias; no host paths or registry access', ['POST /api/multiuser/catalog/skills/import-files'],
    { bodyPolicy: 'multipart', maxBodyBytes: 8 * 1024 * 1024 + 65536 * 4 }),
  ...['GET /api/craft', 'GET /api/craft/:id', 'GET /api/design-templates', 'GET /api/design-templates/:id', 'GET /api/prompt-templates', 'GET /api/prompt-templates/:surface/:id', 'GET /api/design-systems', 'POST /api/design-systems', 'PATCH /api/design-systems/:id', 'DELETE /api/design-systems/:id', 'GET /api/design-systems/:id', 'GET /api/design-systems/:id/revisions', 'GET /api/design-systems/:id/files', 'GET /api/design-systems/:id/file', 'GET /api/design-systems/:id/preview', 'GET /api/design-systems/:id/showcase'].flatMap((key) => {
    const alias = key.replace('/api/', '/api/multiuser/catalog/');
    const bodyPolicy = key.startsWith('POST ') || key.startsWith('PATCH ') ? 'design-system-document' as const
      : key.startsWith('DELETE ') ? 'empty' as const : undefined;
    const extras = { ...(bodyPolicy ? { bodyPolicy, maxBodyBytes: 300_000 } : {}),
      ...(/\/(?:preview|showcase)$/.test(key) ? { untrustedContent: true } : {}) };
    return [...group('actor-scoped', 'bundled catalog reads and account-owned versioned design documents; no host registry access', [key],
      { ...extras, rewriteTo: alias.slice(alias.indexOf(' ') + 1) }),
      ...group('actor-scoped', 'actor design catalog alias; identical cookie authority and closed fields', [alias], extras)];
  }),
  ...blocked(R_SHARED_CATALOG, [
    'GET /api/asset-cache',
    'GET /api/atoms',
    'GET /api/atoms/:id',
    'GET /api/skills/:id/example',
    'GET /api/skills/:id/assets/*splat',
    'POST /api/skills/install',
    'POST /api/design-systems/install',
    'POST /api/design-systems/import/local',
    'POST /api/design-systems/import/github',
    'POST /api/design-systems/import/shadcn',
    'POST /api/design-systems/generation-jobs',
    'GET /api/design-systems/generation-jobs/:jobId',
    'POST /api/design-systems/:id/revision-jobs',
    'POST /api/design-systems/:id/token-contract/rebuild-jobs',
    'PATCH /api/design-systems/:id/revisions/:revisionId',
    'GET /api/design-systems/:id/static',
    'POST /api/design-systems/:id/workspace',
    'GET /api/design-systems/:id/archive',
    'POST /api/design-systems/:id/sync-assets',
  ]),
  ...blocked(R_PLUGINS, [
    'GET /api/plugins',
    'GET /api/plugins/stats',
    'GET /api/plugins/:id',
    'POST /api/plugins/upload-zip',
    'POST /api/plugins/upload-folder',
    'POST /api/plugins/install',
    'POST /api/plugins/:id/uninstall',
    'POST /api/plugins/:id/upgrade',
    'POST /api/plugins/:id/apply-local',
    'POST /api/plugins/:id/apply',
    'POST /api/plugins/:id/duplicate-project',
    'POST /api/plugins/:id/share-project',
    'POST /api/plugins/:id/doctor',
    'POST /api/plugins/:id/trust',
    'GET /api/plugins/:id/preview',
    'GET /api/plugins/:id/example/:name',
    'GET /api/plugins/:id/asset/*splat',
    'GET /api/applied-plugins/:snapshotId',
    'GET /api/applied-plugins/:snapshotId/canon',
    'GET /api/applied-plugins',
    'POST /api/applied-plugins/export',
    'POST /api/applied-plugins/prune',
    'GET /api/marketplaces',
    'POST /api/marketplaces',
    'GET /api/marketplaces/:id',
    'DELETE /api/marketplaces/:id',
    'POST /api/marketplaces/:id/refresh',
    'POST /api/marketplaces/:id/trust',
    'GET /api/marketplaces/:id/plugins',
  ]),
  ...blocked('external/marketing fetches; not needed by the minimum set', [
    'GET /api/community/discord',
    'GET /api/github/open-design',
    'GET /api/github/open-design/releases/latest',
    'GET /api/whats-new',
  ]),

  // Vela team workspaces ------------------------------------------------------------
  ...blocked(R_WORKSPACE, [
    'POST /api/workspace/invite/continue',
    'POST /api/workspace/invite',
    'GET /api/workspace/context',
    'GET /api/workspace/directory',
    'PUT /api/workspace/active',
    'GET /api/workspace/projects/team',
    'GET /api/workspace/members',
    'PUT /api/workspace/billing/interests/:clientId',
    'DELETE /api/workspace/billing/interests/:clientId',
    'GET /api/workspace/billing',
    'GET /api/workspace/billing/catalog',
    'POST /api/workspace/billing/checkout',
    'PUT /api/workspace/context',
    'GET /api/workspace/resources/:kind/:id/state',
    'POST /api/workspace/resources/:kind/:id/copy-check',
    'PUT /api/workspace/resources/:kind/:id/state',
    'GET /api/workspace/design-systems/team',
    'POST /api/workspace/design-systems/:id/share',
    'DELETE /api/workspace/design-systems/:id/share',
    'GET /api/workspace/plugins/team',
    'POST /api/workspace/plugins/:id/share',
    'DELETE /api/workspace/plugins/:id/share',
    'GET /api/workspace/skills/team',
    'POST /api/workspace/skills/:id/share',
    'DELETE /api/workspace/skills/:id/share',
    'GET /api/workspaces/:workspaceId/projects',
    'POST /api/workspaces/:workspaceId/projects/:projectId/move',
    'POST /api/workspaces/:workspaceId/projects/batch-move',
    'POST /api/workspaces/:workspaceId/projects/batch-delete',
  ]),
];


const PROJECT_FILE_RE = String.raw`/^\/api\/projects\/([^/]+)`;
/**
 * The least share role (#65) that reaches each owner-scoped project route.
 * Everything not listed stays owner-only: deleting the project or a
 * conversation, project settings and instructions (PATCH), duplicating, tab
 * layout, routines and grant management.
 */
export const MULTIUSER_SHARED_PROJECT_ROLES: Readonly<Record<string, ProjectShareRole>> = {
  ...Object.fromEntries([
    'GET /api/projects/:id',
    'GET /api/projects/:id/conversations',
    'GET /api/projects/:id/conversations/:cid/messages',
    'GET /api/projects/:id/conversations/:cid/messages/:mid/artifacts',
    'GET /api/projects/:id/files',
    'GET /api/projects/:id/file-content/*path',
    'GET /api/projects/:id/tabs',
    'GET /api/projects/:id/events',
    'GET /api/projects/:id/search',
    'GET /api/projects/:id/folders',
    'GET /api/projects/:id/preview-url',
    'GET /api/multiuser/projects/:id/preview-url',
    'POST /api/multiuser/projects/:id/preview/:scope/renew',
    'GET /api/multiuser/projects/:id/conversations/:cid/design',
    'GET /api/multiuser/projects/:id/design-selections',
    'GET /api/projects/:id/chat-artifact-snapshots/:sid',
    'GET /api/projects/:id/chat-artifact-snapshots/:sid/content',
    'GET /api/projects/:id/chat-artifact-snapshots/:sid/thumbnail',
    'GET /api/projects/:id/workspace-artifacts/:aid',
    'GET /api/projects/:id/archive',
    'GET /api/multiuser/projects/:id/archive',
    'POST /api/projects/:id/archive/batch',
    'POST /api/multiuser/projects/:id/archive/batch',
    ...['html', 'pptx', 'pdf-image', 'image'].flatMap((format) => [
      `POST /api/projects/:id/export/${format}`, `POST /api/multiuser/projects/:id/export/${format}`]),
    'GET /api/projects/:id/conversations/:cid/comments',
    'GET /api/multiuser/projects/:id/conversations/:cid/comments',
    ...['', '/heartbeat', '/leave'].flatMap((suffix) => [
      `${suffix ? 'POST' : 'GET'} /api/projects/:id/presence${suffix}`, `${suffix ? 'POST' : 'GET'} /api/multiuser/projects/:id/presence${suffix}`]),
    'GET /api/multiuser/projects/:id/access',
    'DELETE /api/multiuser/projects/:id/access',
    String.raw`GET ${PROJECT_FILE_RE}\/files\/(.+)$/u`,
    String.raw`GET ${PROJECT_FILE_RE}\/raw\/(.+)$/u`,
    String.raw`GET ${PROJECT_FILE_RE}\/files\/(.+)\/versions\/([^/]+)$/u`,
    String.raw`GET ${PROJECT_FILE_RE}\/files\/(.+)\/versions$/u`,
    String.raw`GET ${PROJECT_FILE_RE}\/text-preview\/(.+)$/u`,
  ].map((key) => [key, 'view' as const])),
  ...Object.fromEntries([
    ...['', '/:commentId', '/:commentId/anchor', '/:commentId/reorder'].flatMap((suffix) => [
      ...(suffix ? ['PATCH'] : ['POST']).flatMap((method) => [
        `${method} /api/projects/:id/conversations/:cid/comments${suffix}`,
        `${method} /api/multiuser/projects/:id/conversations/:cid/comments${suffix}`]),
    ]),
    'DELETE /api/projects/:id/conversations/:cid/comments/:commentId',
    'DELETE /api/multiuser/projects/:id/conversations/:cid/comments/:commentId',
  ].map((key) => [key, 'comment' as const])),
  ...Object.fromEntries([
    'POST /api/projects/:id/conversations',
    'POST /api/multiuser/projects/:id/conversations',
    'PATCH /api/projects/:id/conversations/:cid',
    'PUT /api/projects/:id/conversations/:cid/messages/:mid',
    'POST /api/projects/:id/folders',
    'DELETE /api/projects/:id/folders',
    'POST /api/projects/:id/files',
    'POST /api/projects/:id/files/rename',
    'DELETE /api/projects/:id/files/:name',
    'POST /api/projects/:id/upload',
    String.raw`DELETE ${PROJECT_FILE_RE}\/raw\/(.+)$/u`,
    String.raw`POST ${PROJECT_FILE_RE}\/files\/(.+)\/versions$/u`,
    String.raw`POST ${PROJECT_FILE_RE}\/files\/(.+)\/versions\/([^/]+)\/restore$/u`,
  ].map((key) => [key, 'edit' as const])),
};

/**
 * Transcript writes (#65): only the conversation's author appends messages or
 * renames it, so one account's agent history never carries another's turns.
 * Run admission applies the same rule in the run service.
 */
export const MULTIUSER_CONVERSATION_AUTHOR_PARAMS: Readonly<Record<string, string>> = {
  'PATCH /api/projects/:id/conversations/:cid': 'cid',
  'PUT /api/projects/:id/conversations/:cid/messages/:mid': 'cid',
};

export const MULTIUSER_ROUTE_CLASSIFICATION: readonly MultiUserRouteClassification[] = (() => {
  const keys = new Set(CLASSIFICATION_ENTRIES.filter((entry) => entry.routeClass === 'owner-scoped-project').map((entry) => entry.key));
  const unknown = [...Object.keys(MULTIUSER_SHARED_PROJECT_ROLES), ...Object.keys(MULTIUSER_CONVERSATION_AUTHOR_PARAMS)].filter((key) => !keys.has(key));
  if (unknown.length) throw new Error(`share roles name routes that are not owner-scoped projects: ${unknown.join(', ')}`);
  return CLASSIFICATION_ENTRIES.map((entry) => {
    const sharedRole = MULTIUSER_SHARED_PROJECT_ROLES[entry.key];
    const conversationParam = MULTIUSER_CONVERSATION_AUTHOR_PARAMS[entry.key];
    return sharedRole || conversationParam ? { ...entry, ...(sharedRole ? { sharedRole } : {}), ...(conversationParam ? { conversationParam } : {}) } : entry;
  });
})();
const CLASSIFICATION_BY_KEY: ReadonlyMap<string, MultiUserRouteClassification> = new Map(
  MULTIUSER_ROUTE_CLASSIFICATION.map((entry) => [entry.key, entry]),
);

export function classificationFor(key: string): MultiUserRouteClassification | null {
  return CLASSIFICATION_BY_KEY.get(key) ?? null;
}

// ---- inventory checks -------------------------------------------------------

export interface RouteRegistrationLike {
  method: string;
  path: string;
}

/** Registered routes with no classification (sorted, de-duplicated keys). */
export function findUnclassifiedRegistrations(registrations: readonly RouteRegistrationLike[]): string[] {
  const out = new Set<string>();
  for (const registration of registrations) {
    const key = routeKey(registration.method, registration.path);
    if (!CLASSIFICATION_BY_KEY.has(key)) out.add(key);
  }
  return [...out].sort();
}

/** Classified keys that the live inventory does not register (sorted). */
export function findStaleClassifications(registrations: readonly RouteRegistrationLike[]): string[] {
  const registered = new Set(registrations.map((r) => routeKey(r.method, r.path)));
  return MULTIUSER_ROUTE_CLASSIFICATION.filter((entry) => !registered.has(entry.key)).map((entry) => entry.key).sort();
}

/**
 * Stale entries that would let a request PAST the gate (anything that is not
 * blocked or middleware). A request matching such an entry would reach
 * whatever handler happens to answer that path, so startup refuses on these.
 */
export function findStaleNonBlockedClassifications(registrations: readonly RouteRegistrationLike[]): string[] {
  const stale = new Set(findStaleClassifications(registrations));
  return MULTIUSER_ROUTE_CLASSIFICATION
    .filter((entry) => stale.has(entry.key))
    .filter((entry) => entry.routeClass !== 'blocked-in-multiuser' && entry.routeClass !== 'middleware')
    .map((entry) => entry.key)
    .sort();
}

// ---- matcher ----------------------------------------------------------------

type Segment =
  | { kind: 'literal'; value: string }
  | { kind: 'param'; name: string }
  | { kind: 'splat'; name: string };

const PARAM_NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const UNSUPPORTED_PATTERN_CHARS = /[{}()?+!\\[\]\s^$|]/;

/**
 * Compile the subset of Express 5 path syntax used by the inventory. Returns
 * null for anything else, so an unexpected pattern can never be matched more
 * loosely than Express would route it.
 */
export function compileRoutePattern(pattern: string): Segment[] | null {
  if (typeof pattern !== 'string' || !pattern.startsWith('/') || UNSUPPORTED_PATTERN_CHARS.test(pattern)) return null;
  if (pattern === '/') return [];
  const parts = pattern.slice(1).split('/');
  const segments: Segment[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (part.length === 0) return null;
    if (part.startsWith(':')) {
      const name = part.slice(1);
      if (!PARAM_NAME_RE.test(name)) return null;
      segments.push({ kind: 'param', name });
    } else if (part.startsWith('*')) {
      const name = part.slice(1);
      if (!PARAM_NAME_RE.test(name) || i !== parts.length - 1) return null;
      segments.push({ kind: 'splat', name });
    } else {
      if (part.includes(':') || part.includes('*')) return null;
      segments.push({ kind: 'literal', value: part.toLowerCase() });
    }
  }
  return segments;
}

function decodeSegment(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

function splitRequestPath(rawPath: string): string[] | null {
  if (typeof rawPath !== 'string' || !rawPath.startsWith('/')) return null;
  // Express (strict: false) tolerates exactly one trailing slash.
  const trimmed = rawPath.length > 1 && rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath;
  if (trimmed === '/') return [];
  const parts = trimmed.slice(1).split('/');
  return parts.some((part) => part.length === 0) ? null : parts;
}

function matchSegments(segments: readonly Segment[], parts: readonly string[]): Record<string, string> | null {
  const params: Record<string, string> = {};
  let i = 0;
  for (const segment of segments) {
    if (segment.kind === 'splat') {
      if (i >= parts.length) return null;
      const rest: string[] = [];
      for (; i < parts.length; i++) {
        const decoded = decodeSegment(parts[i]!);
        if (decoded === null) return null;
        rest.push(decoded);
      }
      params[segment.name] = rest.join('/');
      return params;
    }
    const part = parts[i];
    if (part === undefined) return null;
    if (segment.kind === 'literal') {
      if (part.toLowerCase() !== segment.value) return null;
    } else {
      const decoded = decodeSegment(part);
      if (decoded === null || decoded.length === 0) return null;
      params[segment.name] = decoded;
    }
    i++;
  }
  return i === parts.length ? params : null;
}

interface CompiledEntry {
  entry: MultiUserRouteClassification;
  segments: Segment[] | null;
  mountPrefix: string | null;
}

const COMPILED: readonly CompiledEntry[] = MULTIUSER_ROUTE_CLASSIFICATION
  .filter((entry) => !entry.nonStringPath && !entry.catchAll && entry.routeClass !== 'middleware')
  .map((entry) => (entry.method === 'USE'
    ? { entry, segments: null, mountPrefix: entry.path.toLowerCase() }
    : { entry, segments: entry.pattern ? null : compileRoutePattern(entry.path), mountPrefix: null }));

/** Express decodes each capture; an undecodable one never matches. */
function matchPattern(entry: MultiUserRouteClassification, rawPath: string): Record<string, string> | null {
  const found = entry.pattern!.exec(rawPath);
  if (!found) return null;
  const params: Record<string, string> = {};
  for (const [index, name] of (entry.captures ?? []).entries()) {
    const decoded = decodeSegment(found[index + 1] ?? '');
    if (decoded === null || decoded.length === 0) return null;
    params[name] = decoded;
  }
  return params;
}

export interface MultiUserRouteMatch {
  entry: MultiUserRouteClassification;
  params: Record<string, string>;
}

/**
 * Every classified route that could answer `method rawPath`. `rawPath` is the
 * undecoded request pathname (Express `req.path` at the app root). Only
 * reviewed regex entries (`pattern`) match; other regex routes, the SPA
 * catch-all and middleware never do, so requests only they would answer are
 * unclassified and fail closed.
 */
export function matchMultiUserRoute(method: string, rawPath: string): MultiUserRouteMatch[] {
  const verb = String(method || '').toUpperCase() === 'HEAD' ? 'GET' : String(method || '').toUpperCase();
  const parts = splitRequestPath(rawPath);
  if (parts === null) return [];
  const lowerPath = `/${parts.join('/')}`.toLowerCase();
  const matches: MultiUserRouteMatch[] = [];
  for (const compiled of COMPILED) {
    if (compiled.mountPrefix !== null) {
      if (lowerPath === compiled.mountPrefix || lowerPath.startsWith(`${compiled.mountPrefix}/`)) {
        matches.push({ entry: compiled.entry, params: {} });
      }
      continue;
    }
    if (compiled.entry.pattern) {
      if (compiled.entry.method !== 'ALL' && compiled.entry.method !== verb) continue;
      const params = matchPattern(compiled.entry, rawPath);
      if (params) matches.push({ entry: compiled.entry, params });
      continue;
    }
    if (compiled.segments === null) continue;
    if (compiled.entry.routeClass === 'public-web' && publicMultiUserFile(rawPath) === null) continue;
    if (compiled.entry.method !== 'ALL' && compiled.entry.method !== verb) continue;
    const params = matchSegments(compiled.segments, parts);
    if (params) matches.push({ entry: compiled.entry, params });
  }
  return matches;
}
