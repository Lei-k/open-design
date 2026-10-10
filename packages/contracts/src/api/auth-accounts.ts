import type { StudioRuntimeCapabilities } from './studio-parity.js';

/**
 * Multi-user account lifecycle (test-only multi-user mode, #2/#10).
 *
 * Admins provision accounts; the recipient sets the first password with a
 * one-time setup credential. An admin-issued reset retires the current
 * password and sessions and hands out a reset credential the same way. The
 * raw credential appears only once, in the issuing admin's response; lists and
 * audit events carry metadata only, never password material or credentials.
 * See `specs/current/web-multiuser-admin-users.md`.
 */

export type AuthRole = 'admin' | 'user';

/**
 * `set`: the account has a usable password. `setup_required`: provisioned,
 * waiting for the recipient's first password. `reset_required`: an admin
 * issued a reset; the old password no longer works.
 */
export type AuthPasswordState = 'set' | 'setup_required' | 'reset_required';

export type AuthSetupCredentialPurpose = 'setup' | 'reset';

/** Account metadata. Never carries password material. */
export interface AuthAccount {
  id: string;
  username: string;
  role: AuthRole;
  active: boolean;
  passwordState: AuthPasswordState;
  createdAt: number;
  updatedAt: number;
}

/** A freshly issued one-time credential. `token` is the only copy. */
export interface AuthSetupCredential {
  token: string;
  purpose: AuthSetupCredentialPurpose;
  expiresAt: number;
}

/** `POST /api/auth/users` (recipient onboarding: no password field). */
export interface AuthCreateAccountRequest {
  username: string;
  role: AuthRole;
}

export interface AuthCreateAccountResponse {
  account: AuthAccount;
  setup: AuthSetupCredential;
}

/** `POST /api/auth/users/:id/password` with no password field: issue a setup/reset credential. */
export interface AuthIssueSetupCredentialResponse {
  setup: AuthSetupCredential;
}

/** `POST /api/auth/setup` — anonymous; does not sign in. */
export interface AuthCompleteSetupRequest {
  token: string;
  password: string;
}

export interface AuthCompleteSetupResponse {
  account: { username: string };
}

/** `GET /api/auth/users` query: `q` is a username substring; `limit` 1-100 (default 50); `offset` 0-10000. */
export interface AuthAccountListQuery {
  q?: string;
  limit?: number;
  offset?: number;
}

export interface AuthAccountListResponse {
  accounts: AuthAccount[];
  page: { total: number; limit: number; offset: number };
}

export type AuthAuditAction =
  | 'studio_pilot_update'
  | 'bootstrap'
  | 'account_create'
  | 'account_update'
  | 'sessions_revoke'
  | 'credential_issue'
  | 'password_setup'
  | 'password_reset_legacy';

/** One successful lifecycle event. Metadata is non-sensitive (roles, flags, counts, purposes, times). */
export interface AuthAuditEvent {
  id: number;
  at: number;
  actorAccountId: string | null;
  targetAccountId: string | null;
  action: AuthAuditAction;
  outcome: 'success';
  metadata: Record<string, string | number | boolean | null>;
}

/** `GET /api/auth/audit?limit=&before=` — newest first; `nextBefore` pages further back. */
export interface AuthAuditListResponse {
  events: AuthAuditEvent[];
  nextBefore: number | null;
}

/** Admin-only GET/PUT /api/admin/users/:id/studio-pilot. PUT requires the last read revision. */
export interface StudioPilotState {
  studioPilot: boolean;
  revision: number;
}

/** Cookie-authorized effective shell. Public version discovery never enables a pilot. */
export interface AuthSessionResponse {
  account: AuthAccount;
  session: { expiresAt: number };
  studio: StudioRuntimeCapabilities;
  studioRevision: number;
  /** Present for Studio pilot actors: the only namespace in which this actor may
   * propose transcript ids (see `isStudioMessageIdInNamespace`). */
  studioMessageIdPrefix?: string;
}
