// SQLite persistence for the multi-user auth foundation (issue #2).
//
// Data-root contract (root AGENTS.md, "Daemon data directory contract"): the
// store receives the resolved daemon data root explicitly and has NO fallback
// — no env lookup, no cwd default. Callers must pass `RUNTIME_DATA_DIR` (or a
// test temp root). The database lives at `<dataRoot>/auth/auth.sqlite`, in a
// separate file from the main daemon DB so credentials never share a file
// (or its backups/diagnostic dumps) with project data.
//
// Security invariants held here:
// - The auth directory is owner-only (0700) and the database file is created
//   0600 before SQLite opens it; SQLite creates its WAL/SHM side files with
//   the database file's mode.
// - Sessions are stored by SHA-256 digest of the opaque token only; the raw
//   token is never written.
// - Password material is stored only as the encoded scrypt hash.
// - Multi-step invariants (one-time bootstrap, last-admin protection) are
//   decided inside a single SQLite transaction by the caller via
//   `transaction()`; better-sqlite3 is synchronous so no await can interleave.
// - Setup/reset credentials (#10) are stored by SHA-256 digest only, at most
//   one per account; redeeming one deletes it in the committing transaction.
// - `auth_audit` is append-only (triggers abort UPDATE/DELETE) and holds
//   non-sensitive metadata only.
//
// Schema history: v1 (#2) accounts/sessions/meta; v2 (#10) adds
// `auth_accounts.password_state` (existing rows default to `set`),
// `auth_setup_credentials` and `auth_audit`; v3 adds `auth_studio_pilots`
// (missing rows mean disabled at revision zero). Upgrades run in one immediate
// transaction; a newer schema fails closed.

import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type {
  StudioPilotState,
  AuthAuditAction,
  AuthAuditEvent,
  AuthPasswordState,
  AuthRole,
  AuthSetupCredentialPurpose,
} from '@open-design/contracts';

export type { AuthAuditAction, AuthPasswordState, AuthRole, AuthSetupCredentialPurpose } from '@open-design/contracts';

export const AUTH_STORE_RELATIVE_PATH = path.join('auth', 'auth.sqlite');
const AUTH_SCHEMA_VERSION = 3;
const BOOTSTRAP_META_KEY = 'bootstrap_completed_at';
/** Stored in `password_hash` while no password is usable; never parses as a hash. */
export const NO_PASSWORD_HASH = '';

const PASSWORD_STATES: ReadonlySet<string> = new Set<AuthPasswordState>(['set', 'setup_required', 'reset_required']);
const CREDENTIAL_PURPOSES: ReadonlySet<string> = new Set<AuthSetupCredentialPurpose>(['setup', 'reset']);

export interface AuthAccountRecord {
  id: string;
  username: string;
  passwordHash: string;
  role: AuthRole;
  active: boolean;
  passwordState: AuthPasswordState;
  createdAt: number;
  updatedAt: number;
}

export interface AuthSetupCredentialRecord {
  id: string;
  tokenHash: string;
  accountId: string;
  purpose: AuthSetupCredentialPurpose;
  createdAt: number;
  expiresAt: number;
}

export type AuthAuditMetadata = AuthAuditEvent['metadata'];

export interface AuthAuditInput {
  at: number;
  actorAccountId: string | null;
  targetAccountId: string | null;
  action: AuthAuditAction;
  metadata: AuthAuditMetadata;
}

export type AuthAuditRecord = AuthAuditEvent;

export interface AuthSessionRecord {
  id: string;
  tokenHash: string;
  accountId: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
}

export interface AuthStoreOpenOptions {
  /** Absolute resolved daemon data root. Required; there is no default. */
  dataRoot: string;
}

interface AccountRow {
  id: string;
  username: string;
  password_hash: string;
  role: string;
  active: number;
  password_state: string;
  created_at: number;
  updated_at: number;
}

interface CredentialRow {
  id: string;
  token_hash: string;
  account_id: string;
  purpose: string;
  created_at: number;
  expires_at: number;
}

interface AuditRow {
  id: number;
  at: number;
  actor_account_id: string | null;
  target_account_id: string | null;
  action: string;
  outcome: string;
  metadata_json: string;
}

interface SessionRow {
  id: string;
  token_hash: string;
  account_id: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
}

export class AuthStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthStoreError';
  }
}

function assertRealDirectory(dir: string): void {
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new AuthStoreError('auth store directory must be a real directory');
  }
}

function assertRealFileOrMissing(file: string): void {
  if (!existsSync(file)) return;
  const stat = lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new AuthStoreError('auth store database must be a regular file');
  }
}

function toAccount(row: AccountRow): AuthAccountRecord {
  if (row.role !== 'admin' && row.role !== 'user') {
    // Fail closed on a tampered/unknown role instead of guessing.
    throw new AuthStoreError('auth store contains an unknown role');
  }
  if (!PASSWORD_STATES.has(row.password_state)) {
    throw new AuthStoreError('auth store contains an unknown password state');
  }
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    role: row.role,
    active: row.active === 1,
    passwordState: row.password_state as AuthPasswordState,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toCredential(row: CredentialRow): AuthSetupCredentialRecord {
  if (!CREDENTIAL_PURPOSES.has(row.purpose)) throw new AuthStoreError('auth store contains an unknown credential purpose');
  return {
    id: row.id,
    tokenHash: row.token_hash,
    accountId: row.account_id,
    purpose: row.purpose as AuthSetupCredentialPurpose,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

function toAudit(row: AuditRow): AuthAuditRecord {
  let metadata: unknown;
  try {
    metadata = JSON.parse(row.metadata_json);
  } catch {
    throw new AuthStoreError('auth store contains malformed audit metadata');
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || row.outcome !== 'success') {
    throw new AuthStoreError('auth store contains malformed audit metadata');
  }
  return {
    id: row.id,
    at: row.at,
    actorAccountId: row.actor_account_id,
    targetAccountId: row.target_account_id,
    action: row.action as AuthAuditAction,
    outcome: 'success',
    metadata: metadata as AuthAuditMetadata,
  };
}

function toSession(row: SessionRow): AuthSessionRecord {
  return {
    id: row.id,
    tokenHash: row.token_hash,
    accountId: row.account_id,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
  };
}

export class AuthStore {
  readonly file: string;
  private readonly db: Database.Database;

  private constructor(file: string, db: Database.Database) {
    this.file = file;
    this.db = db;
  }

  static open(options: AuthStoreOpenOptions): AuthStore {
    const dataRoot = (options as Partial<AuthStoreOpenOptions> | undefined)?.dataRoot;
    if (typeof dataRoot !== 'string' || dataRoot.length === 0 || !path.isAbsolute(dataRoot)) {
      throw new AuthStoreError('AuthStore.open requires an explicit absolute dataRoot');
    }
    const authDir = path.join(dataRoot, path.dirname(AUTH_STORE_RELATIVE_PATH));
    const file = path.join(dataRoot, AUTH_STORE_RELATIVE_PATH);

    mkdirSync(authDir, { recursive: true, mode: 0o700 });
    assertRealDirectory(authDir);
    if (process.platform !== 'win32') chmodSync(authDir, 0o700);

    assertRealFileOrMissing(file);
    if (!existsSync(file)) {
      // Create owner-only before SQLite touches it; `wx` refuses to follow a
      // file that appeared in the meantime.
      try {
        closeSync(openSync(file, 'wx', 0o600));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        assertRealFileOrMissing(file);
      }
    }
    if (process.platform !== 'win32') chmodSync(file, 0o600);

    const db = new Database(file);
    try {
      db.pragma('journal_mode = WAL');
      db.pragma('foreign_keys = ON');
      db.pragma('busy_timeout = 5000');
      db.pragma('secure_delete = ON');
      migrate(db);
    } catch (error) {
      db.close();
      throw error;
    }
    return new AuthStore(file, db);
  }

  close(): void {
    if (this.db.open) this.db.close();
  }

  /** Run `fn` inside one immediate SQLite write transaction. */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }

  // ---- bootstrap -------------------------------------------------------

  isBootstrapped(): boolean {
    const row = this.db
      .prepare('SELECT 1 AS present FROM auth_meta WHERE key = ?')
      .get(BOOTSTRAP_META_KEY) as { present: number } | undefined;
    return row !== undefined || this.countAccounts() > 0;
  }

  /**
   * Atomically insert the first admin iff bootstrap has never completed and
   * no account exists. Returns false (and writes nothing) otherwise.
   */
  insertFirstAdmin(account: AuthAccountRecord, audit: AuthAuditInput): boolean {
    if (account.role !== 'admin' || !account.active || account.passwordState !== 'set') {
      throw new AuthStoreError('first account must be an active admin with a password');
    }
    return this.transaction(() => {
      if (this.isBootstrapped()) return false;
      this.insertAccountRow(account);
      this.db
        .prepare('INSERT INTO auth_meta (key, value) VALUES (?, ?)')
        .run(BOOTSTRAP_META_KEY, String(account.createdAt));
      this.appendAudit(audit);
      return true;
    });
  }

  // ---- accounts --------------------------------------------------------

  countAccounts(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM auth_accounts').get() as { n: number };
    return row.n;
  }

  /** Admins that can actually sign in: active AND with a usable password. */
  countUsableAdmins(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM auth_accounts WHERE role = 'admin' AND active = 1 AND password_state = 'set'")
      .get() as { n: number };
    return row.n;
  }

  getAccountById(id: string): AuthAccountRecord | null {
    if (typeof id !== 'string') return null;
    const row = this.db.prepare('SELECT * FROM auth_accounts WHERE id = ?').get(id) as AccountRow | undefined;
    return row ? toAccount(row) : null;
  }

  /** Lookup by the already-normalized username. */
  getAccountByUsername(username: string): AuthAccountRecord | null {
    if (typeof username !== 'string') return null;
    const row = this.db
      .prepare('SELECT * FROM auth_accounts WHERE username = ?')
      .get(username) as AccountRow | undefined;
    return row ? toAccount(row) : null;
  }

  listAccounts(): AuthAccountRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM auth_accounts ORDER BY created_at ASC, username ASC')
      .all() as AccountRow[];
    return rows.map(toAccount);
  }

  /**
   * One page of accounts in creation order. `contains` is an already-validated
   * username fragment matched literally (no LIKE wildcards).
   */
  searchAccounts(query: { contains: string | null; limit: number; offset: number }): { accounts: AuthAccountRecord[]; total: number } {
    const where = 'WHERE (? IS NULL OR instr(username, ?) > 0)';
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM auth_accounts ${where}`)
      .get(query.contains, query.contains) as { n: number }).n;
    const rows = this.db
      .prepare(`SELECT * FROM auth_accounts ${where} ORDER BY created_at ASC, rowid ASC LIMIT ? OFFSET ?`)
      .all(query.contains, query.contains, query.limit, query.offset) as AccountRow[];
    return { accounts: rows.map(toAccount), total };
  }

  /** Insert a new account. Returns false when the username is taken. */
  insertAccount(account: AuthAccountRecord): boolean {
    try {
      this.insertAccountRow(account);
      return true;
    } catch (error) {
      if ((error as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') return false;
      throw error;
    }
  }

  updateAccountFlags(id: string, patch: { role: AuthRole; active: boolean }, updatedAt: number): void {
    this.db
      .prepare('UPDATE auth_accounts SET role = ?, active = ?, updated_at = ? WHERE id = ?')
      .run(patch.role, patch.active ? 1 : 0, updatedAt, id);
  }

  updatePassword(id: string, patch: { passwordHash: string; passwordState: AuthPasswordState }, updatedAt: number): void {
    this.db
      .prepare('UPDATE auth_accounts SET password_hash = ?, password_state = ?, updated_at = ? WHERE id = ?')
      .run(patch.passwordHash, patch.passwordState, updatedAt, id);
  }

  private insertAccountRow(account: AuthAccountRecord): void {
    this.db
      .prepare(
        `INSERT INTO auth_accounts (id, username, password_hash, role, active, password_state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        account.id,
        account.username,
        account.passwordHash,
        account.role,
        account.active ? 1 : 0,
        account.passwordState,
        account.createdAt,
        account.updatedAt,
      );
  }

  // ---- setup / reset credentials -----------------------------------------

  /** Replace the account's outstanding credential (supersession), if any. */
  replaceSetupCredential(credential: AuthSetupCredentialRecord): void {
    this.deleteSetupCredentialsForAccount(credential.accountId);
    this.db
      .prepare(
        `INSERT INTO auth_setup_credentials (id, token_hash, account_id, purpose, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(credential.id, credential.tokenHash, credential.accountId, credential.purpose, credential.createdAt, credential.expiresAt);
  }

  getSetupCredentialByTokenHash(tokenHash: string): AuthSetupCredentialRecord | null {
    const row = this.db
      .prepare('SELECT * FROM auth_setup_credentials WHERE token_hash = ?')
      .get(tokenHash) as CredentialRow | undefined;
    return row ? toCredential(row) : null;
  }

  deleteSetupCredential(id: string): boolean {
    return this.db.prepare('DELETE FROM auth_setup_credentials WHERE id = ?').run(id).changes > 0;
  }

  deleteSetupCredentialsForAccount(accountId: string): number {
    return this.db.prepare('DELETE FROM auth_setup_credentials WHERE account_id = ?').run(accountId).changes;
  }

  getStudioPilot(accountId: string): StudioPilotState {
    const row = this.db.prepare('SELECT enabled, revision FROM auth_studio_pilots WHERE account_id = ?').get(accountId) as { enabled: number; revision: number } | undefined;
    return { studioPilot: row?.enabled === 1, revision: row?.revision ?? 0 };
  }

  /** Caller holds the immediate transaction after checking the expected revision. */
  setStudioPilot(accountId: string, state: StudioPilotState): void {
    this.db.prepare(`INSERT INTO auth_studio_pilots (account_id, enabled, revision) VALUES (?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET enabled = excluded.enabled, revision = excluded.revision`)
      .run(accountId, state.studioPilot ? 1 : 0, state.revision);
  }

  // ---- audit -------------------------------------------------------------

  appendAudit(event: AuthAuditInput): void {
    this.db
      .prepare(
        `INSERT INTO auth_audit (at, actor_account_id, target_account_id, action, outcome, metadata_json)
         VALUES (?, ?, ?, ?, 'success', ?)`,
      )
      .run(event.at, event.actorAccountId, event.targetAccountId, event.action, JSON.stringify(event.metadata));
  }

  /** Newest first; `beforeId` pages further back. Returns one extra row to signal more. */
  listAudit(query: { limit: number; beforeId: number | null }): AuthAuditRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM auth_audit WHERE (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?')
      .all(query.beforeId, query.beforeId, query.limit) as AuditRow[];
    return rows.map(toAudit);
  }

  // ---- sessions --------------------------------------------------------

  insertSession(session: AuthSessionRecord): void {
    this.db
      .prepare(
        `INSERT INTO auth_sessions (id, token_hash, account_id, created_at, last_seen_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        session.tokenHash,
        session.accountId,
        session.createdAt,
        session.lastSeenAt,
        session.expiresAt,
      );
  }

  getSessionByTokenHash(tokenHash: string): AuthSessionRecord | null {
    const row = this.db
      .prepare('SELECT * FROM auth_sessions WHERE token_hash = ?')
      .get(tokenHash) as SessionRow | undefined;
    return row ? toSession(row) : null;
  }

  getSessionById(id: string): AuthSessionRecord | null {
    if (typeof id !== 'string') return null;
    const row = this.db.prepare('SELECT * FROM auth_sessions WHERE id = ?').get(id) as SessionRow | undefined;
    return row ? toSession(row) : null;
  }

  touchSession(id: string, lastSeenAt: number): void {
    this.db.prepare('UPDATE auth_sessions SET last_seen_at = ? WHERE id = ?').run(lastSeenAt, id);
  }

  deleteSession(id: string): boolean {
    return this.db.prepare('DELETE FROM auth_sessions WHERE id = ?').run(id).changes > 0;
  }

  deleteSessionsForAccount(accountId: string): number {
    return this.db.prepare('DELETE FROM auth_sessions WHERE account_id = ?').run(accountId).changes;
  }

  /** Remove sessions past their absolute expiry or idle window. */
  deleteStaleSessions(now: number, idleTtlMs: number): number {
    return this.db
      .prepare('DELETE FROM auth_sessions WHERE expires_at <= ? OR last_seen_at <= ?')
      .run(now, now - idleTtlMs).changes;
  }
}

const V1_SCHEMA = `
  CREATE TABLE IF NOT EXISTS auth_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS auth_accounts (
    id            TEXT PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('admin', 'user')),
    active        INTEGER NOT NULL CHECK (active IN (0, 1)),
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS auth_sessions (
    id           TEXT PRIMARY KEY,
    token_hash   TEXT NOT NULL UNIQUE,
    account_id   TEXT NOT NULL REFERENCES auth_accounts(id) ON DELETE CASCADE,
    created_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS auth_sessions_account_idx ON auth_sessions(account_id);
`;

// Plain CREATE (no IF NOT EXISTS): a conflicting object aborts the upgrade,
// which then rolls back as a whole instead of half-applying.
const V2_UPGRADE = `
  ALTER TABLE auth_accounts ADD COLUMN password_state TEXT NOT NULL DEFAULT 'set'
    CHECK (password_state IN ('set', 'setup_required', 'reset_required'));
  CREATE TABLE auth_setup_credentials (
    id         TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    account_id TEXT NOT NULL UNIQUE REFERENCES auth_accounts(id) ON DELETE CASCADE,
    purpose    TEXT NOT NULL CHECK (purpose IN ('setup', 'reset')),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE auth_audit (
    id                INTEGER PRIMARY KEY,
    at                INTEGER NOT NULL,
    actor_account_id  TEXT,
    target_account_id TEXT,
    action            TEXT NOT NULL,
    outcome           TEXT NOT NULL CHECK (outcome IN ('success')),
    metadata_json     TEXT NOT NULL
  );
  CREATE TRIGGER auth_audit_no_update BEFORE UPDATE ON auth_audit
    BEGIN SELECT RAISE(ABORT, 'auth_audit is append-only'); END;
  CREATE TRIGGER auth_audit_no_delete BEFORE DELETE ON auth_audit
    BEGIN SELECT RAISE(ABORT, 'auth_audit is append-only'); END;
`;

function schemaVersion(db: Database.Database): number {
  const version = db.pragma('user_version', { simple: true }) as number;
  if (version > AUTH_SCHEMA_VERSION) {
    throw new AuthStoreError('auth store schema is newer than this daemon');
  }
  return version;
}

function migrate(db: Database.Database): void {
  if (schemaVersion(db) === AUTH_SCHEMA_VERSION) return;
  db.transaction(() => {
    // Re-read under the write lock: another connection may have upgraded.
    const version = schemaVersion(db);
    if (version === AUTH_SCHEMA_VERSION) return;
    if (version < 1) db.exec(V1_SCHEMA);
    if (version < 2) db.exec(V2_UPGRADE);
    if (version < 3) db.exec(`CREATE TABLE auth_studio_pilots (
      account_id TEXT PRIMARY KEY REFERENCES auth_accounts(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
      revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)
    )`);
    db.pragma(`user_version = ${AUTH_SCHEMA_VERSION}`);
  }).immediate();
}
