// Auth-domain service for the multi-user foundation (issue #2).
//
// Scope: WHO is calling. This service authenticates accounts and manages
// opaque server-side sessions; it does not (yet) scope any project,
// conversation, run or file to that actor. Resource authorization (#3/#4) is
// enforced by `http/multiuser-gate.ts`, the only place this service is
// composed into the daemon, and only in the test-only multi-user mode.
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
// - The last USABLE admin (active, with a set password) can never be demoted,
//   deactivated or reset; a pending admin does not count (#10).
// - Admin onboarding (#10): `provisionAccount` creates an account with no
//   usable password plus a one-time setup credential; the recipient chooses
//   the password with `completePasswordSetup`. `issueSetupCredential` re-issues
//   it, or, for an account with a password, retires that password and every
//   session and issues a reset credential. Credentials are 256-bit random,
//   returned once, stored as a SHA-256 digest, superseded by a reissue, and
//   consumed in the committing transaction. Expiry is re-checked after the
//   KDF. Invalid, used, superseded and expired credentials share one error.
// - Every successful management/bootstrap/setup/reset/revoke mutation appends
//   an audit row in the same transaction (non-sensitive metadata only).
// - Legacy, TEST-ONLY direct-password operations remain for fixtures:
//   `createAccount` (admin-chosen password) and `resetPassword` (admin sets
//   the password). They are not the onboarding flow; see
//   specs/current/web-multiuser-admin-users.md for their activation obligations.
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
import type {
  AuthAccount,
  AuthAccountListResponse,
  AuthAuditEvent,
  AuthAuditListResponse,
  AuthSetupCredential,
} from '@open-design/contracts';
import {
  NO_PASSWORD_HASH,
  type AuthAccountRecord,
  type AuthAuditInput,
  type AuthRole,
  type AuthSessionRecord,
  type AuthStore,
} from '../storage/auth-store.js';

export type { AuthRole } from '../storage/auth-store.js';

export const AUTH_ROLES: readonly AuthRole[] = ['admin', 'user'];
export const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const DEFAULT_SESSION_IDLE_TTL_MS = 2 * 60 * 60 * 1000;
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 1024;
export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 32;
/** Test-only default; not a confirmed production policy (see the admin-users spec). */
export const DEFAULT_SETUP_CREDENTIAL_TTL_MS = 24 * 60 * 60 * 1000;
export const ACCOUNT_SEARCH_DEFAULT_LIMIT = 50;
export const ACCOUNT_SEARCH_MAX_LIMIT = 100;
export const ACCOUNT_SEARCH_MAX_OFFSET = 10_000;
export const AUDIT_DEFAULT_LIMIT = 50;
export const AUDIT_MAX_LIMIT = 100;

const SESSION_TOKEN_BYTES = 32;
/** 32 random bytes, base64url, no padding. */
const SESSION_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
/** ASCII only; must start with a letter/digit; no path separators or spaces. */
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
/** A username fragment for search: the username alphabet, any position. */
const USERNAME_FRAGMENT_RE = /^[a-z0-9._-]+$/;

export type AuthErrorCode =
  | 'VALIDATION'
  | 'USERNAME_TAKEN'
  | 'BOOTSTRAP_CLOSED'
  | 'INVALID_CREDENTIALS'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'LAST_ADMIN'
  | 'SETUP_INVALID';

const AUTH_ERROR_MESSAGES: Record<AuthErrorCode, string> = {
  VALIDATION: 'invalid request',
  USERNAME_TAKEN: 'username is already taken',
  BOOTSTRAP_CLOSED: 'bootstrap has already completed',
  INVALID_CREDENTIALS: 'invalid username or password',
  FORBIDDEN: 'admin role required',
  NOT_FOUND: 'account not found',
  LAST_ADMIN: 'the last usable admin cannot be demoted, deactivated or reset',
  // One fixed answer for unknown, malformed, used, superseded and expired credentials.
  SETUP_INVALID: 'invalid or expired setup credential',
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
export type AccountView = AuthAccount;

/** A freshly issued setup/reset credential. `token` is the only copy. */
export type IssuedSetupCredential = AuthSetupCredential;

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
  setupCredentialTtlMs?: number;
}

export interface CredentialsInput {
  username: string;
  password: string;
}

export interface CreateAccountInput extends CredentialsInput {
  role: AuthRole;
}

export interface ProvisionAccountInput {
  username: string;
  role: AuthRole;
}

export interface AccountSearchInput {
  q?: string;
  limit?: number;
  offset?: number;
}

export interface AuditListInput {
  limit?: number;
  before?: number;
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
    passwordState: account.passwordState,
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

function boundedInteger(value: unknown, fallback: number, min: number, max: number, label: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new AuthError('VALIDATION', `${label} must be an integer from ${min} to ${max}`);
  }
  return value;
}

/** NFKC → trim → lowercase username fragment, or a VALIDATION error. */
function requireUsernameFragment(input: unknown): string {
  const normalized = typeof input === 'string' && input.length <= USERNAME_MAX_LENGTH * 4
    ? input.normalize('NFKC').trim().toLowerCase()
    : '';
  if (normalized.length === 0 || normalized.length > USERNAME_MAX_LENGTH || !USERNAME_FRAGMENT_RE.test(normalized)) {
    throw new AuthError('VALIDATION', 'q must be 1-32 characters of a-z, 0-9, ".", "_" or "-"');
  }
  return normalized;
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
  private readonly setupCredentialTtlMs: number;
  private dummyHash: Promise<string> | null = null;

  constructor(options: AuthServiceOptions) {
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.passwordParams = { ...(options.passwordParams ?? DEFAULT_SCRYPT_PARAMS) };
    assertScryptParams(this.passwordParams);
    this.sessionTtlMs = positiveInteger(options.sessionTtlMs, DEFAULT_SESSION_TTL_MS, 'sessionTtlMs');
    this.sessionIdleTtlMs = positiveInteger(options.sessionIdleTtlMs, DEFAULT_SESSION_IDLE_TTL_MS, 'sessionIdleTtlMs');
    this.setupCredentialTtlMs = positiveInteger(
      options.setupCredentialTtlMs, DEFAULT_SETUP_CREDENTIAL_TTL_MS, 'setupCredentialTtlMs');
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
      passwordState: 'set',
      createdAt: at,
      updatedAt: at,
    };
    // The store decides atomically; concurrent callers that all passed the
    // fast-path check above lose here.
    const audit: AuthAuditInput = { at, actorAccountId: account.id, targetAccountId: account.id, action: 'bootstrap', metadata: {} };
    if (!this.store.insertFirstAdmin(account, audit)) throw new AuthError('BOOTSTRAP_CLOSED');
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
    const usable = account !== null && account.passwordState === 'set';

    // Always run exactly one full KDF verification so unknown users, inactive
    // users, accounts without a usable password and wrong passwords cost the same.
    const matches = await verifyPassword(password, usable ? account.passwordHash : await this.getDummyHash());
    if (!account || !usable || !account.active || !matches || password.length === 0) {
      throw new AuthError('INVALID_CREDENTIALS');
    }

    // Re-read after the await: the account may have been deactivated,
    // re-passworded or removed while the KDF ran.
    const session = this.store.transaction(() => {
      const current = this.store.getAccountById(account.id);
      if (!current || !current.active || current.passwordState !== 'set' || current.passwordHash !== account.passwordHash) {
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
    if (!account || !account.active || account.passwordState !== 'set') {
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
      this.store.updatePassword(current.id, { passwordHash, passwordState: 'set' }, at);
      this.store.deleteSessionsForAccount(current.id);
      return this.issueSession(current.id, at, at + this.sessionTtlMs);
    });
  }

  // ---- admin management ------------------------------------------------

  /**
   * LEGACY, TEST-ONLY: create an account with an admin-chosen password. Kept
   * for test fixtures; recipient onboarding is `provisionAccount`.
   */
  async createAccount(actor: AuthActor, input: CreateAccountInput): Promise<AccountView> {
    this.requireAdmin(actor);
    const username = requireUsername(input?.username);
    assertPasswordPolicy(input?.password, username);
    const role = requireRole(input?.role);
    if (this.store.getAccountByUsername(username)) throw new AuthError('USERNAME_TAKEN');
    const passwordHash = await hashPassword(input.password, this.passwordParams);
    return this.store.transaction(() => {
      // The admin may have been demoted/revoked while the KDF ran.
      const issuer = this.requireAdmin(actor);
      const at = this.now();
      const account: AuthAccountRecord = {
        id: randomUUID(),
        username,
        passwordHash,
        role,
        active: true,
        passwordState: 'set',
        createdAt: at,
        updatedAt: at,
      };
      if (!this.store.insertAccount(account)) throw new AuthError('USERNAME_TAKEN');
      this.audit(issuer.id, account.id, 'account_create', { role, onboarding: 'legacy_password' }, at);
      return toView(account);
    });
  }

  /**
   * Admin onboarding: an account with no usable password plus a one-time
   * setup credential for the recipient. Nothing here can sign in until the
   * recipient completes setup.
   */
  provisionAccount(actor: AuthActor, input: ProvisionAccountInput): { account: AccountView; setup: IssuedSetupCredential } {
    this.requireAdmin(actor);
    const username = requireUsername(input?.username);
    const role = requireRole(input?.role);
    return this.store.transaction(() => {
      const issuer = this.requireAdmin(actor);
      const at = this.now();
      const account: AuthAccountRecord = {
        id: randomUUID(),
        username,
        passwordHash: NO_PASSWORD_HASH,
        role,
        active: true,
        passwordState: 'setup_required',
        createdAt: at,
        updatedAt: at,
      };
      if (!this.store.insertAccount(account)) throw new AuthError('USERNAME_TAKEN');
      this.audit(issuer.id, account.id, 'account_create', { role, onboarding: 'setup_credential' }, at);
      return { account: toView(account), setup: this.issueCredentialRow(issuer.id, account, at) };
    });
  }

  /**
   * Issue a fresh one-time credential for an active account, superseding any
   * outstanding one. A pending account gets a new setup credential. An
   * account with a password is reset: the password and every session are
   * retired in the same transaction (the caller then cancels the owner's runs)
   * and the owner chooses the replacement with the reset credential.
   */
  issueSetupCredential(actor: AuthActor, accountId: string): IssuedSetupCredential {
    this.requireAdmin(actor);
    return this.store.transaction(() => {
      const issuer = this.requireAdmin(actor);
      const target = this.store.getAccountById(accountId);
      if (!target) throw new AuthError('NOT_FOUND');
      if (!target.active) throw new AuthError('VALIDATION', 'account is deactivated');
      const at = this.now();
      let account = target;
      if (target.passwordState === 'set') {
        if (target.role === 'admin' && this.store.countUsableAdmins() <= 1) throw new AuthError('LAST_ADMIN');
        this.store.updatePassword(target.id, { passwordHash: NO_PASSWORD_HASH, passwordState: 'reset_required' }, at);
        this.store.deleteSessionsForAccount(target.id);
        account = { ...target, passwordHash: NO_PASSWORD_HASH, passwordState: 'reset_required', updatedAt: at };
      }
      return this.issueCredentialRow(issuer.id, account, at);
    });
  }

  /**
   * Recipient side: set the password with a setup/reset credential. Applies
   * the normal password policy; a policy failure consumes nothing. Does not
   * sign in. The credential, the account state and expiry are re-checked
   * after the KDF inside the committing transaction, which also consumes the
   * credential, so a replay, a concurrent redemption, a reissue or a
   * deactivation during the KDF all lose.
   */
  async completePasswordSetup(input: { token: string; password: string }): Promise<{ username: string }> {
    const token = (input as Partial<{ token: unknown }> | undefined)?.token;
    if (!isLiveTokenShape(token)) throw new AuthError('SETUP_INVALID');
    const digest = hashToken(token);
    const credential = this.store.getSetupCredentialByTokenHash(digest);
    const account = credential ? this.store.getAccountById(credential.accountId) : null;
    if (!credential || !account || !this.isCredentialRedeemable(credential.expiresAt, account, this.now())) {
      throw new AuthError('SETUP_INVALID');
    }
    assertPasswordPolicy(input.password, account.username);
    const passwordHash = await hashPassword(input.password, this.passwordParams);
    return this.store.transaction(() => {
      const current = this.store.getSetupCredentialByTokenHash(digest);
      const target = current ? this.store.getAccountById(current.accountId) : null;
      const at = this.now();
      if (!current || current.id !== credential.id || !target || !this.isCredentialRedeemable(current.expiresAt, target, at)) {
        throw new AuthError('SETUP_INVALID');
      }
      this.store.deleteSetupCredential(current.id);
      this.store.updatePassword(target.id, { passwordHash, passwordState: 'set' }, at);
      this.store.deleteSessionsForAccount(target.id);
      this.audit(target.id, target.id, 'password_setup', { purpose: current.purpose }, at);
      return { username: target.username };
    });
  }

  /** Throws FORBIDDEN unless the actor is a live admin (authorization before request validation). */
  assertAdmin(actor: AuthActor): void {
    this.requireAdmin(actor);
  }

  /** Every account, unpaged (internal callers only; HTTP uses `searchAccounts`). */
  listAccounts(actor: AuthActor): AccountView[] {
    this.requireAdmin(actor);
    return this.store.listAccounts().map(toView);
  }

  /** Bounded admin search by username fragment, in creation order. */
  searchAccounts(actor: AuthActor, input: AccountSearchInput): { accounts: AccountView[] } & AuthAccountListResponse['page'] {
    this.requireAdmin(actor);
    const contains = input?.q === undefined ? null : requireUsernameFragment(input.q);
    const limit = boundedInteger(input?.limit, ACCOUNT_SEARCH_DEFAULT_LIMIT, 1, ACCOUNT_SEARCH_MAX_LIMIT, 'limit');
    const offset = boundedInteger(input?.offset, 0, 0, ACCOUNT_SEARCH_MAX_OFFSET, 'offset');
    const page = this.store.searchAccounts({ contains, limit, offset });
    return { accounts: page.accounts.map(toView), total: page.total, limit, offset };
  }

  /** Bounded admin audit read, newest first. */
  listAuditEvents(actor: AuthActor, input: AuditListInput): AuthAuditListResponse {
    this.requireAdmin(actor);
    const limit = boundedInteger(input?.limit, AUDIT_DEFAULT_LIMIT, 1, AUDIT_MAX_LIMIT, 'limit');
    const before = input?.before === undefined ? null : boundedInteger(input.before, 0, 1, Number.MAX_SAFE_INTEGER, 'before');
    const rows: AuthAuditEvent[] = this.store.listAudit({ limit: limit + 1, beforeId: before });
    const events = rows.slice(0, limit);
    return { events, nextBefore: rows.length > limit ? events[events.length - 1]!.id : null };
  }

  updateAccount(actor: AuthActor, accountId: string, patch: UpdateAccountPatch): AccountView {
    this.requireAdmin(actor);
    const normalized = normalizePatch(patch);
    return this.store.transaction(() => {
      const issuer = this.requireAdmin(actor);
      const target = this.store.getAccountById(accountId);
      if (!target) throw new AuthError('NOT_FOUND');
      const nextRole = normalized.role ?? target.role;
      const nextActive = normalized.active ?? target.active;
      const hasPassword = target.passwordState === 'set';
      const wasUsableAdmin = target.role === 'admin' && target.active && hasPassword;
      const staysUsableAdmin = nextRole === 'admin' && nextActive && hasPassword;
      if (wasUsableAdmin && !staysUsableAdmin && this.store.countUsableAdmins() <= 1) {
        throw new AuthError('LAST_ADMIN');
      }
      const roleChanged = nextRole !== target.role;
      const activeChanged = nextActive !== target.active;
      if (!roleChanged && !activeChanged) return toView(target);
      const at = this.now();
      this.store.updateAccountFlags(target.id, { role: nextRole, active: nextActive }, at);
      // Any authority change invalidates existing sessions; the account must
      // sign in again to pick up its new role. A deactivated account keeps no
      // outstanding setup/reset credential.
      if (roleChanged || !nextActive) this.store.deleteSessionsForAccount(target.id);
      if (!nextActive) this.store.deleteSetupCredentialsForAccount(target.id);
      this.audit(issuer.id, target.id, 'account_update',
        { fromRole: target.role, toRole: nextRole, fromActive: target.active, toActive: nextActive }, at);
      return toView({ ...target, role: nextRole, active: nextActive, updatedAt: at });
    });
  }

  revokeAccountSessions(actor: AuthActor, accountId: string): number {
    this.requireAdmin(actor);
    return this.store.transaction(() => {
      const issuer = this.requireAdmin(actor);
      if (!this.store.getAccountById(accountId)) throw new AuthError('NOT_FOUND');
      const revoked = this.store.deleteSessionsForAccount(accountId);
      this.audit(issuer.id, accountId, 'sessions_revoke', { revoked }, this.now());
      return revoked;
    });
  }

  /**
   * LEGACY, TEST-ONLY: the admin sets the target's password directly. Kept for
   * fixtures; recovery is `issueSetupCredential`. Withdraws any outstanding
   * setup/reset credential.
   */
  async resetPassword(actor: AuthActor, accountId: string, newPassword: string): Promise<void> {
    this.requireAdmin(actor);
    const target = this.store.getAccountById(accountId);
    if (!target) throw new AuthError('NOT_FOUND');
    assertPasswordPolicy(newPassword, target.username);
    const passwordHash = await hashPassword(newPassword, this.passwordParams);
    this.store.transaction(() => {
      const issuer = this.requireAdmin(actor);
      if (!this.store.getAccountById(accountId)) throw new AuthError('NOT_FOUND');
      const at = this.now();
      this.store.updatePassword(accountId, { passwordHash, passwordState: 'set' }, at);
      this.store.deleteSetupCredentialsForAccount(accountId);
      this.store.deleteSessionsForAccount(accountId);
      this.audit(issuer.id, accountId, 'password_reset_legacy', {}, at);
    });
  }

  // ---- internals -------------------------------------------------------

  private isSessionFresh(session: AuthSessionRecord, at: number): boolean {
    return at < session.expiresAt && at - session.lastSeenAt < this.sessionIdleTtlMs;
  }

  private isCredentialRedeemable(expiresAt: number, account: AuthAccountRecord, at: number): boolean {
    return at < expiresAt && account.active && account.passwordState !== 'set';
  }

  /** Call inside a transaction: replace the account's credential and audit the issue. */
  private issueCredentialRow(issuerId: string, account: AuthAccountRecord, at: number): IssuedSetupCredential {
    const purpose = account.passwordState === 'setup_required' ? 'setup' : 'reset';
    const token = randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
    const expiresAt = at + this.setupCredentialTtlMs;
    this.store.replaceSetupCredential({
      id: randomUUID(),
      tokenHash: hashToken(token),
      accountId: account.id,
      purpose,
      createdAt: at,
      expiresAt,
    });
    this.audit(issuerId, account.id, 'credential_issue', { purpose, expiresAt }, at);
    return { token, purpose, expiresAt };
  }

  private audit(
    actorAccountId: string,
    targetAccountId: string,
    action: AuthAuditInput['action'],
    metadata: AuthAuditInput['metadata'],
    at: number,
  ): void {
    this.store.appendAudit({ at, actorAccountId, targetAccountId, action, metadata });
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
    if (!account || !account.active || account.passwordState !== 'set') throw new AuthError('FORBIDDEN');
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
