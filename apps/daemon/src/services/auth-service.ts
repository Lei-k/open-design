// Auth-domain service for the multi-user foundation (issue #2).
//
// Scope: WHO is calling. This service authenticates accounts and manages
// opaque server-side sessions; it does not (yet) scope any project,
// conversation, run or file to that actor — that is #3/#4/#5, and until it
// lands the route registrar must stay unmounted in the production server.
//
// Invariants:
// - There is no self-registration. The first admin is created exactly once
//   (`bootstrapFirstAdmin`, atomically in the store); every later account is
//   created by an admin.
// - Authority is always re-read from persistence. An `AuthActor` is only a
//   handle: every privileged call re-loads the account and its session, so a
//   forged/stale role, a missing account, a deactivated account or a revoked
//   session is refused.
// - Session tokens are 256-bit random, returned once to the caller and stored
//   only as a SHA-256 digest. Sessions have an absolute TTL (rotation never
//   extends it) and an idle TTL.
// - Role changes, deactivation and password resets revoke the target's
//   sessions; a password change revokes every session of the caller and
//   issues one fresh session.
// - The last active admin can never be demoted or deactivated.
// - Login failure is one generic error regardless of cause, and the
//   unknown-user path still runs a full KDF verification to keep timing flat.
// - Errors carry fixed messages only; nothing here logs.

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  DEFAULT_SCRYPT_PARAMS,
  assertScryptParams,
  hashPassword,
  verifyPassword,
  type ScryptParams,
} from './auth-passwords.js';
import type { AuthAccountRecord, AuthRole, AuthSessionRecord, AuthStore } from '../storage/auth-store.js';

export type { AuthRole } from '../storage/auth-store.js';

export const AUTH_ROLES: readonly AuthRole[] = ['admin', 'user'];
export const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const DEFAULT_SESSION_IDLE_TTL_MS = 2 * 60 * 60 * 1000;
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 1024;
export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 32;

const SESSION_TOKEN_BYTES = 32;
/** 32 random bytes, base64url, no padding. */
const SESSION_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
/** ASCII only; must start with a letter/digit; no path separators or spaces. */
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

export type AuthErrorCode =
  | 'VALIDATION'
  | 'USERNAME_TAKEN'
  | 'BOOTSTRAP_CLOSED'
  | 'INVALID_CREDENTIALS'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'LAST_ADMIN';

const AUTH_ERROR_MESSAGES: Record<AuthErrorCode, string> = {
  VALIDATION: 'invalid request',
  USERNAME_TAKEN: 'username is already taken',
  BOOTSTRAP_CLOSED: 'bootstrap has already completed',
  INVALID_CREDENTIALS: 'invalid username or password',
  FORBIDDEN: 'admin role required',
  NOT_FOUND: 'account not found',
  LAST_ADMIN: 'the last active admin cannot be demoted or deactivated',
};

export class AuthError extends Error {
  readonly code: AuthErrorCode;
  constructor(code: AuthErrorCode, message: string = AUTH_ERROR_MESSAGES[code]) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}

/** Public account projection. Never includes password material. */
export interface AccountView {
  id: string;
  username: string;
  role: AuthRole;
  active: boolean;
  createdAt: number;
  updatedAt: number;
}

/** A resolved session. A handle only: privileged calls re-validate it. */
export interface AuthActor {
  accountId: string;
  username: string;
  role: AuthRole;
  sessionId: string;
  sessionExpiresAt: number;
}

/** A freshly issued session. `token` is the only copy of the secret. */
export interface IssuedSession {
  token: string;
  expiresAt: number;
}

export interface AuthServiceOptions {
  store: AuthStore;
  now?: () => number;
  passwordParams?: ScryptParams;
  sessionTtlMs?: number;
  sessionIdleTtlMs?: number;
}

export interface CredentialsInput {
  username: string;
  password: string;
}

export interface CreateAccountInput extends CredentialsInput {
  role: AuthRole;
}

export interface UpdateAccountPatch {
  role?: AuthRole;
  active?: boolean;
}

function toView(account: AuthAccountRecord): AccountView {
  return {
    id: account.id,
    username: account.username,
    role: account.role,
    active: account.active,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function isLiveTokenShape(token: unknown): token is string {
  return typeof token === 'string' && SESSION_TOKEN_RE.test(token);
}

/** NFKC → trim → lowercase. Returns null when the result is not a valid username. */
export function normalizeUsername(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > USERNAME_MAX_LENGTH * 4) return null;
  const normalized = input.normalize('NFKC').trim().toLowerCase();
  if (normalized.length < USERNAME_MIN_LENGTH || normalized.length > USERNAME_MAX_LENGTH) return null;
  return USERNAME_RE.test(normalized) ? normalized : null;
}

function passwordLength(password: string): number {
  return [...password.normalize('NFKC')].length;
}

function assertPasswordPolicy(password: unknown, normalizedUsername: string): asserts password is string {
  if (typeof password !== 'string') throw new AuthError('VALIDATION', 'password must be a string');
  if (password.length > PASSWORD_MAX_LENGTH * 4) {
    throw new AuthError('VALIDATION', `password must be ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} characters`);
  }
  const length = passwordLength(password);
  if (length < PASSWORD_MIN_LENGTH || length > PASSWORD_MAX_LENGTH) {
    throw new AuthError('VALIDATION', `password must be ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} characters`);
  }
  if (password.normalize('NFKC').trim().toLowerCase() === normalizedUsername) {
    throw new AuthError('VALIDATION', 'password must differ from the username');
  }
}

function requireUsername(input: unknown): string {
  const username = normalizeUsername(input);
  if (!username) {
    throw new AuthError(
      'VALIDATION',
      `username must be ${USERNAME_MIN_LENGTH}-${USERNAME_MAX_LENGTH} characters of a-z, 0-9, ".", "_" or "-", starting with a letter or digit`,
    );
  }
  return username;
}

function requireRole(input: unknown): AuthRole {
  if (input === 'admin' || input === 'user') return input;
  throw new AuthError('VALIDATION', 'role must be "admin" or "user"');
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

export class AuthService {
  readonly now: () => number;
  private readonly store: AuthStore;
  private readonly passwordParams: ScryptParams;
  private readonly sessionTtlMs: number;
  private readonly sessionIdleTtlMs: number;
  private dummyHash: Promise<string> | null = null;

  constructor(options: AuthServiceOptions) {
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.passwordParams = { ...(options.passwordParams ?? DEFAULT_SCRYPT_PARAMS) };
    assertScryptParams(this.passwordParams);
    this.sessionTtlMs = positiveInteger(options.sessionTtlMs, DEFAULT_SESSION_TTL_MS, 'sessionTtlMs');
    this.sessionIdleTtlMs = positiveInteger(options.sessionIdleTtlMs, DEFAULT_SESSION_IDLE_TTL_MS, 'sessionIdleTtlMs');
    // Precompute eagerly so even the first unknown-user login costs exactly
    // one verification, like every other login.
    this.dummyHash = this.getDummyHash();
    this.dummyHash.catch(() => { /* surfaced (as a failed login) when awaited */ });
  }

  // ---- bootstrap -------------------------------------------------------

  isBootstrapRequired(): boolean {
    return !this.store.isBootstrapped();
  }

  async bootstrapFirstAdmin(input: CredentialsInput): Promise<AccountView> {
    if (!this.isBootstrapRequired()) throw new AuthError('BOOTSTRAP_CLOSED');
    const username = requireUsername(input?.username);
    assertPasswordPolicy(input?.password, username);
    const passwordHash = await hashPassword(input.password, this.passwordParams);
    const at = this.now();
    const account: AuthAccountRecord = {
      id: randomUUID(),
      username,
      passwordHash,
      role: 'admin',
      active: true,
      createdAt: at,
      updatedAt: at,
    };
    // The store decides atomically; concurrent callers that all passed the
    // fast-path check above lose here.
    if (!this.store.insertFirstAdmin(account)) throw new AuthError('BOOTSTRAP_CLOSED');
    return toView(account);
  }

  // ---- login / sessions ------------------------------------------------

  async login(
    input: CredentialsInput,
    options: { previousToken?: string | null } = {},
  ): Promise<{ session: IssuedSession; account: AccountView }> {
    const username = normalizeUsername((input as Partial<CredentialsInput> | undefined)?.username);
    const rawPassword = (input as Partial<CredentialsInput> | undefined)?.password;
    const password =
      typeof rawPassword === 'string' && rawPassword.length <= PASSWORD_MAX_LENGTH * 4 ? rawPassword : '';
    const account = username ? this.store.getAccountByUsername(username) : null;

    // Always run exactly one full KDF verification so unknown users, inactive
    // users and wrong passwords cost the same.
    const matches = await verifyPassword(password, account ? account.passwordHash : await this.getDummyHash());
    if (!account || !account.active || !matches || password.length === 0) {
      throw new AuthError('INVALID_CREDENTIALS');
    }

    // Re-read after the await: the account may have been deactivated,
    // re-passworded or removed while the KDF ran.
    const session = this.store.transaction(() => {
      const current = this.store.getAccountById(account.id);
      if (!current || !current.active || current.passwordHash !== account.passwordHash) {
        throw new AuthError('INVALID_CREDENTIALS');
      }
      // Session-fixation defense: whatever session the client presented is
      // retired, whoever it belonged to.
      if (isLiveTokenShape(options.previousToken)) {
        const previous = this.store.getSessionByTokenHash(hashToken(options.previousToken));
        if (previous) this.store.deleteSession(previous.id);
      }
      const at = this.now();
      this.store.deleteStaleSessions(at, this.sessionIdleTtlMs);
      return this.issueSession(current.id, at, at + this.sessionTtlMs);
    });
    return { session, account: toView(account) };
  }

  /**
   * Resolve an opaque token to an actor, or null. Refreshes the idle window.
   * Expired, idle, orphaned and deactivated-account sessions are deleted.
   */
  resolveSession(token: unknown): AuthActor | null {
    if (!isLiveTokenShape(token)) return null;
    const digest = hashToken(token);
    const session = this.store.getSessionByTokenHash(digest);
    if (!session || !timingSafeEqual(Buffer.from(session.tokenHash), Buffer.from(digest))) return null;
    const at = this.now();
    if (!this.isSessionFresh(session, at)) {
      this.store.deleteSession(session.id);
      return null;
    }
    const account = this.store.getAccountById(session.accountId);
    if (!account || !account.active) {
      this.store.deleteSession(session.id);
      return null;
    }
    this.store.touchSession(session.id, at);
    return {
      accountId: account.id,
      username: account.username,
      role: account.role,
      sessionId: session.id,
      sessionExpiresAt: session.expiresAt,
    };
  }

  /** Replace a live session with a new token; the absolute expiry is kept. */
  rotateSession(token: unknown): IssuedSession | null {
    const actor = this.resolveSession(token);
    if (!actor) return null;
    return this.store.transaction(() => {
      if (!this.store.deleteSession(actor.sessionId)) return null;
      return this.issueSession(actor.accountId, this.now(), actor.sessionExpiresAt);
    });
  }

  /** Revoke the session behind `token`, if any. Idempotent. */
  logout(token: unknown): void {
    if (!isLiveTokenShape(token)) return;
    const session = this.store.getSessionByTokenHash(hashToken(token));
    if (session) this.store.deleteSession(session.id);
  }

  /** The caller's own account, re-read from persistence. */
  getOwnAccount(actor: AuthActor): AccountView {
    return toView(this.requireLiveAccount(actor));
  }

  async changeOwnPassword(
    actor: AuthActor,
    input: { currentPassword: string; newPassword: string },
  ): Promise<IssuedSession> {
    const account = this.requireLiveAccount(actor);
    const currentOk = await verifyPassword(input?.currentPassword, account.passwordHash);
    if (!currentOk) throw new AuthError('INVALID_CREDENTIALS');
    assertPasswordPolicy(input?.newPassword, account.username);
    const passwordHash = await hashPassword(input.newPassword, this.passwordParams);
    return this.store.transaction(() => {
      const current = this.requireLiveAccount(actor);
      if (current.passwordHash !== account.passwordHash) throw new AuthError('INVALID_CREDENTIALS');
      const at = this.now();
      this.store.updatePasswordHash(current.id, passwordHash, at);
      this.store.deleteSessionsForAccount(current.id);
      return this.issueSession(current.id, at, at + this.sessionTtlMs);
    });
  }

  // ---- admin management ------------------------------------------------

  async createAccount(actor: AuthActor, input: CreateAccountInput): Promise<AccountView> {
    this.requireAdmin(actor);
    const username = requireUsername(input?.username);
    assertPasswordPolicy(input?.password, username);
    const role = requireRole(input?.role);
    if (this.store.getAccountByUsername(username)) throw new AuthError('USERNAME_TAKEN');
    const passwordHash = await hashPassword(input.password, this.passwordParams);
    return this.store.transaction(() => {
      // The admin may have been demoted/revoked while the KDF ran.
      this.requireAdmin(actor);
      const at = this.now();
      const account: AuthAccountRecord = {
        id: randomUUID(),
        username,
        passwordHash,
        role,
        active: true,
        createdAt: at,
        updatedAt: at,
      };
      if (!this.store.insertAccount(account)) throw new AuthError('USERNAME_TAKEN');
      return toView(account);
    });
  }

  listAccounts(actor: AuthActor): AccountView[] {
    this.requireAdmin(actor);
    return this.store.listAccounts().map(toView);
  }

  updateAccount(actor: AuthActor, accountId: string, patch: UpdateAccountPatch): AccountView {
    this.requireAdmin(actor);
    const normalized = normalizePatch(patch);
    return this.store.transaction(() => {
      this.requireAdmin(actor);
      const target = this.store.getAccountById(accountId);
      if (!target) throw new AuthError('NOT_FOUND');
      const nextRole = normalized.role ?? target.role;
      const nextActive = normalized.active ?? target.active;
      const wasActiveAdmin = target.role === 'admin' && target.active;
      const staysActiveAdmin = nextRole === 'admin' && nextActive;
      if (wasActiveAdmin && !staysActiveAdmin && this.store.countActiveAdmins() <= 1) {
        throw new AuthError('LAST_ADMIN');
      }
      const roleChanged = nextRole !== target.role;
      const activeChanged = nextActive !== target.active;
      if (!roleChanged && !activeChanged) return toView(target);
      const at = this.now();
      this.store.updateAccountFlags(target.id, { role: nextRole, active: nextActive }, at);
      // Any authority change invalidates existing sessions; the account must
      // sign in again to pick up its new role.
      if (roleChanged || !nextActive) this.store.deleteSessionsForAccount(target.id);
      return toView({ ...target, role: nextRole, active: nextActive, updatedAt: at });
    });
  }

  revokeAccountSessions(actor: AuthActor, accountId: string): number {
    this.requireAdmin(actor);
    return this.store.transaction(() => {
      if (!this.store.getAccountById(accountId)) throw new AuthError('NOT_FOUND');
      return this.store.deleteSessionsForAccount(accountId);
    });
  }

  async resetPassword(actor: AuthActor, accountId: string, newPassword: string): Promise<void> {
    this.requireAdmin(actor);
    const target = this.store.getAccountById(accountId);
    if (!target) throw new AuthError('NOT_FOUND');
    assertPasswordPolicy(newPassword, target.username);
    const passwordHash = await hashPassword(newPassword, this.passwordParams);
    this.store.transaction(() => {
      this.requireAdmin(actor);
      if (!this.store.getAccountById(accountId)) throw new AuthError('NOT_FOUND');
      this.store.updatePasswordHash(accountId, passwordHash, this.now());
      this.store.deleteSessionsForAccount(accountId);
    });
  }

  // ---- internals -------------------------------------------------------

  private isSessionFresh(session: AuthSessionRecord, at: number): boolean {
    return at < session.expiresAt && at - session.lastSeenAt < this.sessionIdleTtlMs;
  }

  private issueSession(accountId: string, at: number, expiresAt: number): IssuedSession {
    const token = randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
    this.store.insertSession({
      id: randomUUID(),
      tokenHash: hashToken(token),
      accountId,
      createdAt: at,
      lastSeenAt: at,
      expiresAt,
    });
    return { token, expiresAt };
  }

  /**
   * Re-validate an actor handle against persistence: the session must still
   * exist, belong to the same account, be fresh; the account must be active.
   * The returned record — never the handle — is the source of authority.
   */
  private requireLiveAccount(actor: AuthActor): AuthAccountRecord {
    const session = actor && typeof actor === 'object' ? this.store.getSessionById(actor.sessionId) : null;
    if (!session || session.accountId !== actor.accountId || !this.isSessionFresh(session, this.now())) {
      throw new AuthError('FORBIDDEN');
    }
    const account = this.store.getAccountById(session.accountId);
    if (!account || !account.active) throw new AuthError('FORBIDDEN');
    return account;
  }

  private requireAdmin(actor: AuthActor): AuthAccountRecord {
    const account = this.requireLiveAccount(actor);
    if (account.role !== 'admin') throw new AuthError('FORBIDDEN');
    return account;
  }

  private getDummyHash(): Promise<string> {
    // A real hash at the configured cost, of a random throwaway secret that
    // is immediately discarded, so the unknown-user path does the same KDF
    // work as a real verification and can never match.
    this.dummyHash ??= hashPassword(randomBytes(32).toString('base64url'), this.passwordParams);
    return this.dummyHash;
  }
}

function normalizePatch(patch: unknown): UpdateAccountPatch {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new AuthError('VALIDATION');
  const entries = Object.entries(patch as Record<string, unknown>);
  if (entries.length === 0) throw new AuthError('VALIDATION', 'patch must set role and/or active');
  const out: UpdateAccountPatch = {};
  for (const [key, value] of entries) {
    if (key === 'role') out.role = requireRole(value);
    else if (key === 'active') {
      if (typeof value !== 'boolean') throw new AuthError('VALIDATION', 'active must be a boolean');
      out.active = value;
    } else {
      throw new AuthError('VALIDATION', 'only role and active can be changed');
    }
  }
  return out;
}
