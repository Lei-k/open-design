// Multi-user auth routes (issue #2) — mounted ONLY by the multi-user gate.
//
// This registrar authenticates who is calling. It is mounted exclusively by
// `src/http/multiuser-gate.ts` (`installMultiUserFront`) when the test-only,
// not-launch-ready multi-user mode is on; server.ts never imports it directly
// and single-user mode never mounts it. Resource authorization (#3/#4) lives
// in that gate; run isolation (#5) is still open. See
// tests/auth/auth-not-wired.test.ts, which is the deliberate tripwire.
//
// HTTP surface (all under /api/auth, all `Cache-Control: no-store`):
//   POST  /bootstrap                     one-time first admin (needs bootstrap secret)
//   POST  /login                         → sets session cookie
//   POST  /logout                        idempotent; clears cookie
//   GET   /me
//   POST  /session/rotate
//   POST  /password                      self password change (current password required)
//   GET   /users                         admin
//   POST  /users                         admin; the ONLY way to create accounts
//   PATCH /users/:id                     admin; role/active only
//   POST  /users/:id/sessions/revoke     admin
//   POST  /users/:id/password            admin password reset
// There is no registration/signup route.
//
// Request hardening:
// - Session is an opaque token in a `__Host-` cookie (Secure, HttpOnly,
//   SameSite=Strict, Path=/, no Domain). Authorization headers and any
//   client-supplied identity/role headers or body fields are ignored.
// - State-changing requests must be `application/json` (forces a CORS
//   preflight cross-origin) and, when the browser declares an Origin, it must
//   be one of the exact configured origins; `Sec-Fetch-Site` cross-site /
//   same-site without an allowed Origin is refused.
// - Errors go through the shared API error envelope + failure journal, which
//   records only method, route template, status and code. Nothing here logs,
//   and request bodies are never echoed.

import { createHash, timingSafeEqual } from 'node:crypto';
import express, {
  type ErrorRequestHandler,
  type Express,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import type { ApiErrorCode } from '@open-design/contracts';
import { sendApiError } from '../http/api-errors.js';
import {
  AuthError,
  type AuthActor,
  type AuthErrorCode,
  type AuthRole,
  type AuthService,
  type IssuedSession,
  type UpdateAccountPatch,
} from '../services/auth-service.js';

export const AUTH_SESSION_COOKIE = '__Host-od_session';
export const AUTH_ROUTE_PREFIX = '/api/auth';
/** Minimum bootstrap secret length; shorter configured secrets are refused. */
export const MIN_BOOTSTRAP_SECRET_LENGTH = 32;

const SESSION_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** Hard upper bound on any auth request body, in raw (wire) bytes. */
export const AUTH_BODY_LIMIT_BYTES = 16 * 1024;

export type AuthRouteService = Pick<
  AuthService,
  | 'now'
  | 'isBootstrapRequired'
  | 'bootstrapFirstAdmin'
  | 'login'
  | 'logout'
  | 'resolveSession'
  | 'rotateSession'
  | 'getOwnAccount'
  | 'changeOwnPassword'
  | 'listAccounts'
  | 'createAccount'
  | 'updateAccount'
  | 'revokeAccountSessions'
  | 'resetPassword'
>;

export interface RegisterAuthRoutesDeps {
  auth: AuthRouteService;
  /**
   * One-time first-admin bootstrap secret, supplied by the operator. `null`
   * (or empty) disables the bootstrap endpoint entirely (404).
   */
  bootstrapSecret: string | null;
  /** Exact browser origins allowed to make state-changing requests. */
  allowedOrigins: readonly string[];
  onAccountSessionsRevoked?: (accountId: string) => void;
}

const STATUS_BY_AUTH_CODE: Record<AuthErrorCode, { status: number; code: ApiErrorCode }> = {
  VALIDATION: { status: 400, code: 'BAD_REQUEST' },
  USERNAME_TAKEN: { status: 409, code: 'CONFLICT' },
  BOOTSTRAP_CLOSED: { status: 409, code: 'CONFLICT' },
  INVALID_CREDENTIALS: { status: 401, code: 'UNAUTHORIZED' },
  FORBIDDEN: { status: 403, code: 'FORBIDDEN' },
  NOT_FOUND: { status: 404, code: 'NOT_FOUND' },
  LAST_ADMIN: { status: 409, code: 'CONFLICT' },
};

// ---- cookies ---------------------------------------------------------

function sessionCookie(token: string, maxAgeSeconds: number): string {
  return `${AUTH_SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Strict`;
}

export function clearedSessionCookie(): string {
  return `${AUTH_SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

interface PresentedCookie {
  /** The cookie name appeared at least once. */
  present: boolean;
  /** A single, well-formed token; null for absent, duplicated or malformed. */
  token: string | null;
}

/**
 * Read the session cookie strictly: exactly one occurrence of the exact
 * name with a well-formed token. Duplicates are refused rather than
 * picking one, so a cookie-tossing attacker cannot shadow the real cookie.
 */
export function readSessionCookie(header: string | undefined): PresentedCookie {
  if (typeof header !== 'string' || header.length === 0) return { present: false, token: null };
  const values: string[] = [];
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === AUTH_SESSION_COOKIE) values.push(part.slice(eq + 1).trim());
  }
  if (values.length === 0) return { present: false, token: null };
  const only = values.length === 1 ? values[0]! : null;
  return { present: true, token: only !== null && SESSION_TOKEN_RE.test(only) ? only : null };
}

function maxAgeSeconds(expiresAt: number, now: number): number {
  return Math.max(0, Math.floor((expiresAt - now) / 1000));
}

function setSession(res: Response, auth: AuthRouteService, session: IssuedSession): void {
  res.setHeader('Set-Cookie', sessionCookie(session.token, maxAgeSeconds(session.expiresAt, auth.now())));
}

// ---- request helpers -------------------------------------------------

function bodyObject(req: Request): Record<string, unknown> | null {
  const body: unknown = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  return body as Record<string, unknown>;
}

function stringField(body: Record<string, unknown> | null, key: string): string {
  const value = body?.[key];
  return typeof value === 'string' ? value : '';
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Constant-time compare that does not leak the configured secret's length. */
function secretMatches(presented: unknown, expected: string): boolean {
  if (typeof presented !== 'string' || presented.length === 0) return false;
  return timingSafeEqual(digest(presented), digest(expected));
}

function sendAuthError(res: Response, error: unknown): void {
  if (error instanceof AuthError) {
    const mapped = STATUS_BY_AUTH_CODE[error.code];
    sendApiError(res, mapped.status, mapped.code, error.message);
    return;
  }
  // Unknown failure: fixed message, no details, no logging (the error could
  // in principle carry request-derived data).
  sendApiError(res, 500, 'INTERNAL_ERROR', 'internal error');
}

type AsyncHandler = (req: Request, res: Response) => Promise<void> | void;

function handle(fn: AsyncHandler): RequestHandler {
  return (req, res) => {
    Promise.resolve()
      .then(() => fn(req, res))
      .catch((error: unknown) => {
        if (!res.headersSent) sendAuthError(res, error);
      });
  };
}

function actorOf(res: Response): AuthActor {
  const actor = res.locals.authActor as AuthActor | undefined;
  if (!actor) throw new AuthError('FORBIDDEN');
  return actor;
}

/**
 * Middleware resolving the session cookie into `res.locals.authActor`, or
 * answering 401 (and clearing a presented-but-dead cookie). Exported for the
 * auth routes; it grants identity only, not resource access (the multi-user
 * gate resolves sessions itself before any non-auth route).
 */
export function createRequireSession(auth: Pick<AuthRouteService, 'resolveSession'>): RequestHandler {
  return (req, res, next) => {
    const cookie = readSessionCookie(req.headers.cookie);
    const actor = cookie.token ? auth.resolveSession(cookie.token) : null;
    if (!actor) {
      if (cookie.present) res.setHeader('Set-Cookie', clearedSessionCookie());
      sendApiError(res, 401, 'UNAUTHORIZED', 'authentication required');
      return;
    }
    res.locals.authActor = actor;
    next();
  };
}

function normalizeAllowedOrigins(origins: readonly string[]): ReadonlySet<string> {
  if (!Array.isArray(origins) || origins.length === 0) {
    throw new Error('registerAuthRoutes requires at least one allowed origin');
  }
  const out = new Set<string>();
  for (const origin of origins) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error('registerAuthRoutes: allowed origins must be absolute origins');
    }
    if (parsed.origin !== origin || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
      throw new Error('registerAuthRoutes: allowed origins must be exact scheme://host[:port] origins');
    }
    out.add(origin);
  }
  return out;
}

function createRequestHardening(allowedOrigins: ReadonlySet<string>): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Vary', 'Cookie, Origin');
    if (!STATE_CHANGING_METHODS.has(req.method)) {
      next();
      return;
    }
    const origin = req.get('origin');
    if (origin !== undefined) {
      if (!allowedOrigins.has(origin)) {
        sendApiError(res, 403, 'FORBIDDEN', 'cross-origin request rejected');
        return;
      }
    } else {
      const fetchSite = req.get('sec-fetch-site');
      if (fetchSite === 'cross-site' || fetchSite === 'same-site') {
        sendApiError(res, 403, 'FORBIDDEN', 'cross-origin request rejected');
        return;
      }
    }
    if (!req.is('application/json')) {
      sendApiError(res, 415, 'UNSUPPORTED_MEDIA_TYPE', 'state-changing auth requests must be application/json');
      return;
    }
    const bound = checkAuthBodyBound(req);
    if (bound === 'encoded') {
      sendApiError(res, 415, 'UNSUPPORTED_MEDIA_TYPE', 'compressed auth request bodies are not accepted');
      return;
    }
    if (bound === 'too-large') {
      sendApiError(res, 413, 'PAYLOAD_TOO_LARGE', 'request body too large');
      return;
    }
    next();
  };
}

/**
 * Enforce AUTH_BODY_LIMIT_BYTES on the raw wire body independently of which
 * body parser runs. body-parser skips a body that an earlier parser already
 * read, so the registrar's own 16kb parser cannot bound a body accepted by
 * a looser upstream parser (e.g. the server's global 4mb `express.json`).
 * This check runs before any handler, fails closed, and holds in any order:
 * - Content-Encoding other than identity is refused (the bound is on raw
 *   bytes; an upstream parser would otherwise inflate first).
 * - A declared Content-Length above the bound (or unparsable) is refused.
 * - With no Content-Length (chunked), the size is only measurable by our own
 *   bounded parser; if an upstream parser already consumed the body, the
 *   size is unknowable here and the request is refused.
 */
function checkAuthBodyBound(req: Request): 'ok' | 'encoded' | 'too-large' {
  const encoding = (req.get('content-encoding') ?? 'identity').trim().toLowerCase();
  if (encoding !== 'identity') return 'encoded';
  const declared = req.get('content-length');
  if (declared !== undefined) {
    if (!/^\d{1,15}$/.test(declared.trim())) return 'too-large';
    return Number(declared.trim()) > AUTH_BODY_LIMIT_BYTES ? 'too-large' : 'ok';
  }
  const alreadyConsumed = (req as { _body?: unknown })._body === true || req.readableEnded;
  return alreadyConsumed ? 'too-large' : 'ok';
}

/** Body-parser failures: generic answer, never echo or log the raw body. */
const authBodyErrorHandler: ErrorRequestHandler = (error: unknown, _req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  const status = (error as { status?: unknown; statusCode?: unknown })?.status
    ?? (error as { statusCode?: unknown })?.statusCode;
  if (status === 413) sendApiError(res, 413, 'PAYLOAD_TOO_LARGE', 'request body too large');
  else if (status === 400) sendApiError(res, 400, 'BAD_REQUEST', 'malformed JSON body');
  else if (status === 415) sendApiError(res, 415, 'UNSUPPORTED_MEDIA_TYPE', 'unsupported request body');
  else sendApiError(res, 500, 'INTERNAL_ERROR', 'internal error');
};

// ---- registrar -------------------------------------------------------

export function registerAuthRoutes(app: Express, deps: RegisterAuthRoutesDeps): void {
  const { auth } = deps;
  const allowedOrigins = normalizeAllowedOrigins(deps.allowedOrigins);
  const bootstrapSecret = deps.bootstrapSecret && deps.bootstrapSecret.length > 0 ? deps.bootstrapSecret : null;
  if (bootstrapSecret !== null && bootstrapSecret.length < MIN_BOOTSTRAP_SECRET_LENGTH) {
    throw new Error(`registerAuthRoutes: bootstrap secret must be at least ${MIN_BOOTSTRAP_SECRET_LENGTH} characters`);
  }
  const requireSession = createRequireSession(auth);
  const p = AUTH_ROUTE_PREFIX;

  // Required mount order (see checkAuthBodyBound): register this registrar
  // BEFORE any global body parser, so its bounded parser reads the body. The
  // multi-user gate does exactly that in the production composition. If a
  // global parser ever runs first, the hardening middleware still enforces the
  // raw-byte bound and refuses unmeasurable (chunked) bodies.
  app.use(p, createRequestHardening(allowedOrigins));
  app.use(p, express.json({ limit: AUTH_BODY_LIMIT_BYTES, strict: true, type: 'application/json' }));

  app.post(`${p}/bootstrap`, handle(async (req, res) => {
    if (bootstrapSecret === null) {
      sendApiError(res, 404, 'NOT_FOUND', 'not found');
      return;
    }
    const body = bodyObject(req);
    if (!secretMatches(body?.bootstrapToken, bootstrapSecret)) {
      sendApiError(res, 403, 'FORBIDDEN', 'invalid bootstrap token');
      return;
    }
    const account = await auth.bootstrapFirstAdmin({
      username: stringField(body, 'username'),
      password: stringField(body, 'password'),
    });
    // Bootstrap deliberately does not sign in: the admin logs in normally.
    res.status(201).json({ account });
  }));

  app.post(`${p}/login`, handle(async (req, res) => {
    const body = bodyObject(req);
    const previous = readSessionCookie(req.headers.cookie).token;
    try {
      const { session, account } = await auth.login(
        { username: stringField(body, 'username'), password: stringField(body, 'password') },
        { previousToken: previous },
      );
      setSession(res, auth, session);
      res.status(200).json({ account, session: { expiresAt: session.expiresAt } });
    } catch (error) {
      // Every login failure is the same generic 401, whatever the cause.
      if (error instanceof AuthError) sendAuthError(res, new AuthError('INVALID_CREDENTIALS'));
      else throw error;
    }
  }));

  app.post(`${p}/logout`, handle((req, res) => {
    const { token } = readSessionCookie(req.headers.cookie);
    const accountId = token ? auth.resolveSession(token)?.accountId : null;
    if (token) auth.logout(token);
    if (accountId) deps.onAccountSessionsRevoked?.(accountId);
    res.setHeader('Set-Cookie', clearedSessionCookie());
    res.status(204).end();
  }));

  app.get(`${p}/me`, requireSession, handle((_req, res) => {
    const actor = actorOf(res);
    res.status(200).json({ account: auth.getOwnAccount(actor), session: { expiresAt: actor.sessionExpiresAt } });
  }));

  app.post(`${p}/session/rotate`, requireSession, handle((req, res) => {
    const { token } = readSessionCookie(req.headers.cookie);
    const session = token ? auth.rotateSession(token) : null;
    if (!session) {
      res.setHeader('Set-Cookie', clearedSessionCookie());
      sendApiError(res, 401, 'UNAUTHORIZED', 'authentication required');
      return;
    }
    setSession(res, auth, session);
    res.status(200).json({ session: { expiresAt: session.expiresAt } });
  }));

  app.post(`${p}/password`, requireSession, handle(async (req, res) => {
    const accountId = actorOf(res).accountId;
    const body = bodyObject(req);
    const session = await auth.changeOwnPassword(actorOf(res), {
      currentPassword: stringField(body, 'currentPassword'),
      newPassword: stringField(body, 'newPassword'),
    });
    deps.onAccountSessionsRevoked?.(accountId);
    setSession(res, auth, session);
    res.status(200).json({ session: { expiresAt: session.expiresAt } });
  }));

  app.get(`${p}/users`, requireSession, handle((_req, res) => {
    res.status(200).json({ accounts: auth.listAccounts(actorOf(res)) });
  }));

  app.post(`${p}/users`, requireSession, handle(async (req, res) => {
    const body = bodyObject(req);
    const account = await auth.createAccount(actorOf(res), {
      username: stringField(body, 'username'),
      password: stringField(body, 'password'),
      role: body?.role as AuthRole, // validated by the service
    });
    res.status(201).json({ account });
  }));

  app.patch(`${p}/users/:id`, requireSession, handle((req, res) => {
    const actor = actorOf(res);
    const body = bodyObject(req);
    // Authorization first (non-admins get 403 regardless of body), then the
    // service validates the patch shape.
    const prior = auth.listAccounts(actor).find((entry) => entry.id === String(req.params.id));
    const account = auth.updateAccount(actor, String(req.params.id), (body ?? []) as UpdateAccountPatch);
    if (prior && (prior.role !== account.role || (prior.active && !account.active))) {
      deps.onAccountSessionsRevoked?.(String(req.params.id));
    }
    res.status(200).json({ account });
  }));

  app.post(`${p}/users/:id/sessions/revoke`, requireSession, handle((req, res) => {
    const revoked = auth.revokeAccountSessions(actorOf(res), String(req.params.id));
    deps.onAccountSessionsRevoked?.(String(req.params.id));
    res.status(200).json({ revoked });
  }));

  app.post(`${p}/users/:id/password`, requireSession, handle(async (req, res) => {
    await auth.resetPassword(actorOf(res), String(req.params.id), stringField(bodyObject(req), 'password'));
    deps.onAccountSessionsRevoked?.(String(req.params.id));
    res.status(204).end();
  }));

  app.use(p, authBodyErrorHandler);
}
