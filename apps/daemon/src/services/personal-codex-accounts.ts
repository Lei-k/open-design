// Personal Codex subscription accounts for multi-user mode (#18).
//
// A platform user links THEIR OWN Codex subscription through the official
// device-code flow, driven by an isolated per-user `codex app-server` child.
// Contract: specs/current/web-multiuser-personal-subscription.md.
//
// Invariants kept here:
// - Disabled unless the multi-user test harness injected the repository mock
//   app-server; nothing else can enable it (see services/multiuser-mode.ts).
// - One pending attempt and one linked Codex account per platform user at a
//   time. Its provider identity (keyed HMAC of the normalized e-mail that
//   `account/read` reports) is kept by a same-identity re-authorization (only
//   the credential is swapped, native sessions survive) and replaced by a switch
//   to another subscription (same account row; the home and native thread pins
//   start fresh). The same identity may be linked by several platform accounts
//   (one person may own several), each through its own login into its own home.
//   A rejected completion discards its login home.
// - Device codes and verification URLs live only in memory for the owner's
//   pending attempt. They are never persisted, logged, audited or returned
//   after the attempt is terminal.
// - Each actor's CODEX_HOME derives from the resolved daemon data root, mode
//   0700 (files 0600). Nothing is ever copied between homes.
// - A re-authorization's prior home or credential is retained, under a durable
//   record, until its replacement commits; restart and retries put it back, and
//   unlink deletes every copy of the owner's state before the row.
// - Every lookup is keyed by the server-side actor; a foreign id is "missing".
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type {
  ApiErrorCode, PersonalAccountProblem, PersonalAccountStatus, PersonalAgentAccount, PersonalLoginAttempt,
  PersonalLoginAttemptStatus, PersonalLoginFailureCode, PersonalRateLimits, PersonalRateLimitWindow,
} from '@open-design/contracts';
import { attachCodexAppServerSession, type CodexSandboxMode } from '../agent-protocol/codex-app-server/session.js';
import { AppServerAccountClient, closeChild, spawnAppServer, type AppServerEnvironment } from '../integrations/codex-app-server-account.js';

type Json = Record<string, unknown>;

/** Server-side bound on a device-code attempt (the provider's own code lifetime is similar). */
export const PERSONAL_LOGIN_TTL_MS = 15 * 60_000;
const VERIFY_PROMPT = 'Reply with the single word OK.';
/** The provider's credential store inside CODEX_HOME; everything else there is native session state. */
const CREDENTIAL_FILE = 'auth.json';
const MAX_TURN_TEXT = 64 * 1024;

export class PersonalAccountError extends Error {
  constructor(readonly status: number, readonly code: ApiErrorCode, message: string) {
    super(message);
    this.name = 'PersonalAccountError';
  }
}

/** Daemon-owned per-actor runtime directory, shared with the isolated run lane. */
export function actorRuntimeDir(dataRoot: string, accountId: string): string {
  return path.join(dataRoot, 'multiuser-runtime', createHash('sha256').update(accountId).digest('hex'));
}

export function personalCodexHome(dataRoot: string, accountId: string): string {
  return path.join(actorRuntimeDir(dataRoot, accountId), 'codex-home');
}

function privateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

/** Directories 0700, files 0600; symlinks are neither followed nor changed. */
function lockDown(root: string): void {
  const info = fs.lstatSync(root, { throwIfNoEntry: false });
  if (!info || info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    fs.chmodSync(root, 0o700);
    for (const name of fs.readdirSync(root)) lockDown(path.join(root, name));
  } else fs.chmodSync(root, 0o600);
}

export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '***';
  return `${email.slice(0, 1)}***@${email.slice(at + 1)}`;
}

/** Provider failure classes from a failed turn's `codexErrorInfo` (codex 0.160.0 schema). */
export function classifyTurnError(error: unknown): PersonalAccountProblem | null {
  const record = error && typeof error === 'object' ? error as Json : {};
  const info = record.codexErrorInfo;
  const message = typeof record.message === 'string' ? record.message : '';
  if (info === 'usageLimitExceeded') return 'usage_limit_reached';
  if (info === 'unauthorized') return /workspace/iu.test(message) ? 'workspace_not_allowed' : 'reauth_required';
  return null;
}

export const PROBLEM_ERRORS: Record<PersonalAccountProblem, { status: number; code: ApiErrorCode }> = {
  reauth_required: { status: 409, code: 'MULTIUSER_PERSONAL_REAUTH_REQUIRED' },
  usage_limit_reached: { status: 429, code: 'MULTIUSER_PERSONAL_USAGE_LIMIT' },
  workspace_not_allowed: { status: 403, code: 'MULTIUSER_PERSONAL_WORKSPACE_NOT_ALLOWED' },
};

/** Device-login failures reported by `account/login/completed`. Unknown text => provider_error. */
function classifyLoginFailure(error: unknown): { status: PersonalLoginAttemptStatus; failureCode: PersonalLoginFailureCode | null } {
  const text = typeof error === 'string' ? error : '';
  if (/denied/iu.test(text)) return { status: 'denied', failureCode: null };
  if (/expired|timed? ?out/iu.test(text)) return { status: 'expired', failureCode: null };
  if (/workspace/iu.test(text)) return { status: 'failed', failureCode: 'workspace_not_allowed' };
  return { status: 'failed', failureCode: 'provider_error' };
}

function rateWindow(value: unknown): PersonalRateLimitWindow | null {
  const record = value && typeof value === 'object' ? value as Json : null;
  if (!record || typeof record.usedPercent !== 'number' || !Number.isFinite(record.usedPercent)) return null;
  const optional = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) ? v : null);
  return { usedPercent: record.usedPercent, windowDurationMins: optional(record.windowDurationMins), resetsAt: optional(record.resetsAt) };
}

export interface PersonalTurnResult { ok: boolean; problem: PersonalAccountProblem | null; text: string; threadId: string | null }

/**
 * Drive one turn through the shared app-server session driver in `codexHome`.
 * A raw tap on the same stdout reads the failed turn's `codexErrorInfo`, which
 * the normalizer does not forward.
 */
export function runPersonalCodexTurn(input: AppServerEnvironment & {
  prompt: string; resumeThreadId: string | null; sandboxMode: CodexSandboxMode; onThread?: (threadId: string) => void;
  /** Called synchronously from the child's close event, before `done` settles. */
  onDone?: (result: PersonalTurnResult) => void;
}): { child: ChildProcessWithoutNullStreams; done: Promise<PersonalTurnResult> } {
  const child = spawnAppServer(input);
  let text = '';
  let problem: PersonalAccountProblem | null = null;
  let tap = '';
  child.stdout.on('data', (chunk: Buffer) => {
    tap += chunk.toString('utf8');
    let newline: number;
    while ((newline = tap.indexOf('\n')) !== -1) {
      const line = tap.slice(0, newline);
      tap = tap.slice(newline + 1);
      try {
        const frame = JSON.parse(line) as Json;
        const turn = frame.method === 'turn/completed' ? (frame.params as Json | undefined)?.turn as Json | undefined : undefined;
        if (turn?.status === 'failed') problem = classifyTurnError(turn.error);
      } catch { /* not a frame */ }
    }
  });
  const session = attachCodexAppServerSession({
    child, prompt: input.prompt, cwd: input.cwd, sandboxMode: input.sandboxMode,
    resumeSessionId: input.resumeThreadId, resumeSessionOwned: input.resumeThreadId !== null,
    onAgentEvent: (event) => {
      if (event.type === 'text_delta' && typeof event.delta === 'string' && text.length < MAX_TURN_TEXT) text += event.delta;
      if (event.type === 'status' && typeof event.sessionId === 'string') input.onThread?.(event.sessionId);
      // A fatal transport error never reaches turn/completed; end the child.
      if (event.type === 'error') { try { child.stdin.end(); } catch { /* gone */ } }
    },
  });
  const done = new Promise<PersonalTurnResult>((resolve) => {
    child.once('close', (code) => {
      const result = { ok: code === 0 && session.completedSuccessfully() && problem === null,
        problem, text: text.slice(0, MAX_TURN_TEXT), threadId: session.getDurableSessionId() };
      input.onDone?.(result);
      resolve(result);
    });
  });
  return { child, done };
}

type AttemptRow = {
  id: string; owner_account_id: string; status: PersonalLoginAttemptStatus; failure_code: PersonalLoginFailureCode | null;
  created_at: number; expires_at: number; updated_at: number;
};
type AccountRow = {
  id: string; owner_account_id: string; status: PersonalAccountStatus; identity_hash: string; masked_identity: string;
  plan_type: string | null; credential_version: number; last_problem: PersonalAccountProblem | null;
  rate_limits_json: string | null; linked_at: number; verified_at: number | null; updated_at: number;
};
interface LiveAttempt {
  id: string; ownerId: string; loginId: string; userCode: string; verificationUrl: string;
  client: AppServerAccountClient; loginHome: string; timer: NodeJS.Timeout; completing: boolean;
  closed: Promise<void> | null;
}

type InstallMode = 'link' | 'reauthorize' | 'switch';

const ACCOUNT_COLUMNS = 'id, owner_account_id, provider, status, identity_hash, masked_identity, plan_type, '
  + 'credential_version, last_problem, rate_limits_json, linked_at, verified_at, updated_at';
const ACCOUNT_TABLE = `
        id TEXT PRIMARY KEY,
        owner_account_id TEXT NOT NULL CHECK (length(owner_account_id) > 0),
        provider TEXT NOT NULL CHECK (provider IN ('codex')),
        status TEXT NOT NULL CHECK (status IN ('connected','requires_reauth','disabled')),
        identity_hash TEXT NOT NULL, masked_identity TEXT NOT NULL, plan_type TEXT,
        credential_version INTEGER NOT NULL, last_problem TEXT, rate_limits_json TEXT,
        linked_at INTEGER NOT NULL, verified_at INTEGER, updated_at INTEGER NOT NULL,
        UNIQUE (owner_account_id, provider)
      `;

export interface UsablePersonalAccount { id: string; credentialVersion: number; codexHome: string }

export class PersonalCodexAccounts {
  readonly enabled: boolean;
  private readonly db: Database.Database;
  private readonly dataRoot: string;
  private readonly command: readonly [string, ...string[]] | null;
  private readonly now: () => number;
  private readonly live = new Map<string, LiveAttempt>();
  private readonly verifying = new Map<string, ChildProcessWithoutNullStreams>();
  /**
   * Owners whose account is mid-unlink or mid-re-authorization. Set synchronously
   * before the operation's first await; while set, the account admits, dispatches
   * and verifies nothing (and, while unlinking, links nothing).
   */
  private readonly unlinking = new Set<string>();
  private readonly reauthorizing = new Set<string>();
  private cancelPersonalRuns: (ownerId: string) => Promise<void> = async () => {};
  /** Clears the owner's native thread pins; called inside the switch's bind transaction. */
  private forgetNativeSessions: (ownerId: string) => void = () => {};
  private identityKey: Buffer;
  private stopped = false;

  constructor(input: { db: Database.Database; dataRoot: string; appServerScript?: string; clock?: () => number }) {
    this.db = input.db;
    this.dataRoot = input.dataRoot;
    this.command = input.appServerScript ? [process.execPath, input.appServerScript] : null;
    this.enabled = this.command !== null;
    this.now = input.clock ?? Date.now;
    this.migrateIdentityUniqueness();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS multiuser_agent_accounts (${ACCOUNT_TABLE});
      DROP TRIGGER IF EXISTS multiuser_agent_accounts_binding_immutable;
      CREATE TRIGGER multiuser_agent_accounts_binding_immutable
        BEFORE UPDATE OF owner_account_id, provider ON multiuser_agent_accounts
        BEGIN SELECT RAISE(ABORT, 'agent account binding is immutable'); END;
      -- The identity changes only through a subscription switch, which bumps the
      -- credential version and clears the verification in the same update.
      CREATE TRIGGER IF NOT EXISTS multiuser_agent_accounts_identity_switch_only
        BEFORE UPDATE OF identity_hash ON multiuser_agent_accounts
        WHEN NEW.identity_hash IS NOT OLD.identity_hash
          AND (NEW.credential_version <= OLD.credential_version OR NEW.verified_at IS NOT NULL)
        BEGIN SELECT RAISE(ABORT, 'agent account identity changes only through a switch'); END;
      CREATE TABLE IF NOT EXISTS multiuser_agent_login_attempts (
        id TEXT PRIMARY KEY,
        owner_account_id TEXT NOT NULL CHECK (length(owner_account_id) > 0),
        provider TEXT NOT NULL CHECK (provider IN ('codex')),
        status TEXT NOT NULL CHECK (status IN ('pending','connected','denied','expired','canceled','failed')),
        failure_code TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_multiuser_agent_login_one_pending
        ON multiuser_agent_login_attempts(owner_account_id, provider) WHERE status = 'pending';
      CREATE TRIGGER IF NOT EXISTS multiuser_agent_login_owner_immutable
        BEFORE UPDATE OF owner_account_id, provider ON multiuser_agent_login_attempts
        BEGIN SELECT RAISE(ABORT, 'login attempt binding is immutable'); END;
      CREATE TABLE IF NOT EXISTS multiuser_agent_account_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      -- A prior home or credential set aside by a re-authorization that has not committed.
      -- The bind transaction deletes the row, so its presence alone says the set-aside copy
      -- is still the account's truth.
      CREATE TABLE IF NOT EXISTS multiuser_agent_retained_state (
        owner_account_id TEXT PRIMARY KEY CHECK (length(owner_account_id) > 0),
        kind TEXT NOT NULL CHECK (kind IN ('home','credential')),
        had_prior INTEGER NOT NULL CHECK (had_prior IN (0, 1)), created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS multiuser_agent_account_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, actor_account_id TEXT NOT NULL, target_account_id TEXT NOT NULL,
        provider TEXT NOT NULL, action TEXT NOT NULL, detail TEXT, ref_id TEXT, created_at INTEGER NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS multiuser_agent_account_audit_immutable BEFORE UPDATE ON multiuser_agent_account_audit
        BEGIN SELECT RAISE(ABORT, 'agent account audit is append only'); END;
      CREATE TRIGGER IF NOT EXISTS multiuser_agent_account_audit_no_delete BEFORE DELETE ON multiuser_agent_account_audit
        BEGIN SELECT RAISE(ABORT, 'agent account audit is append only'); END;
    `);
    this.db.prepare("INSERT OR IGNORE INTO multiuser_agent_account_config (key, value) VALUES ('identity-key', ?)")
      .run(randomBytes(32).toString('base64'));
    this.identityKey = Buffer.from((this.db.prepare("SELECT value FROM multiuser_agent_account_config WHERE key = 'identity-key'")
      .get() as { value: string }).value, 'base64');
    this.recover();
  }

  /**
   * Databases created before the one-identity-per-provider rule was dropped keep
   * `UNIQUE (provider, identity_hash)`, which SQLite cannot drop in place. Rebuild
   * the table once, in one transaction: same columns, rows and ids; only the
   * per-owner uniqueness. Its triggers go with the old table and are recreated by
   * the schema that follows. No other table references it by foreign key, and
   * login attempts, runs and session pins refer to unchanged ids.
   */
  private migrateIdentityUniqueness(): void {
    const indexes = this.db.prepare('PRAGMA index_list(multiuser_agent_accounts)').all() as
      Array<{ name: string; unique: number; origin: string }>;
    const legacy = indexes.some((index) => index.unique === 1 && index.origin === 'u' &&
      (this.db.prepare(`PRAGMA index_info(${JSON.stringify(index.name)})`).all() as Array<{ name: string }>)
        .map((column) => column.name).join(',') === 'provider,identity_hash');
    if (!legacy) return;
    this.db.transaction(() => {
      this.db.exec(`CREATE TABLE multiuser_agent_accounts_next (${ACCOUNT_TABLE})`);
      this.db.exec(`INSERT INTO multiuser_agent_accounts_next (${ACCOUNT_COLUMNS}) SELECT ${ACCOUNT_COLUMNS} FROM multiuser_agent_accounts`);
      this.db.exec('DROP TABLE multiuser_agent_accounts');
      this.db.exec('ALTER TABLE multiuser_agent_accounts_next RENAME TO multiuser_agent_accounts');
    }).immediate();
  }

  setRunHooks(hooks: { cancelPersonalRuns: (ownerId: string) => Promise<void>; forgetNativeSessions?: (ownerId: string) => void }): void {
    this.cancelPersonalRuns = hooks.cancelPersonalRuns;
    if (hooks.forgetNativeSessions) this.forgetNativeSessions = hooks.forgetNativeSessions;
  }

  audit(actorId: string, targetId: string, action: string, detail: string | null = null, refId: string | null = null): void {
    this.db.prepare(`INSERT INTO multiuser_agent_account_audit
      (actor_account_id, target_account_id, provider, action, detail, ref_id, created_at) VALUES (?, ?, 'codex', ?, ?, ?, ?)`)
      .run(actorId, targetId, action, detail, refId, this.now());
  }

  // ---- reads -----------------------------------------------------------------

  summary(ownerId: string): { account: PersonalAgentAccount | null; pendingAttempt: PersonalLoginAttempt | null } {
    const pending = this.db.prepare("SELECT * FROM multiuser_agent_login_attempts WHERE owner_account_id = ? AND status = 'pending'")
      .get(ownerId) as AttemptRow | undefined;
    const account = this.accountRow(ownerId);
    return { account: account ? this.accountDto(account) : null, pendingAttempt: pending ? this.attemptDto(pending, false) : null };
  }

  async attempt(ownerId: string, attemptId: string): Promise<PersonalLoginAttempt | null> {
    const row = this.ownedAttempt(ownerId, attemptId);
    if (!row) return null;
    if (row.status === 'pending' && this.now() >= row.expires_at) {
      await this.finalize(row.id, 'expired', null, 'link_expire');
    }
    return this.attemptDto(this.ownedAttempt(ownerId, attemptId)!, true);
  }

  /** Gate hook: the id names the actor's own attempt / linked account. */
  isOwner(param: 'attemptId' | 'accountId', id: string, ownerId: string): boolean {
    if (param === 'attemptId') return this.ownedAttempt(ownerId, id) !== null;
    return this.accountRow(ownerId)?.id === id;
  }

  usableAccount(ownerId: string): UsablePersonalAccount | null {
    if (!this.enabled) return null;
    const row = this.accountRow(ownerId);
    if (!row || row.status !== 'connected' || this.fenced(ownerId) || this.retained(ownerId)) return null;
    return { id: row.id, credentialVersion: row.credential_version, codexHome: personalCodexHome(this.dataRoot, ownerId) };
  }

  /** Re-apply 0700/0600 after a provider child wrote into the actor's home. */
  secureHome(ownerId: string): void {
    const home = personalCodexHome(this.dataRoot, ownerId);
    if (fs.existsSync(home)) lockDown(home);
  }

  appServerCommand(): readonly [string, ...string[]] | null {
    return this.command;
  }

  adminView(ownerIds: readonly string[]): Record<string, { linked: boolean; status: PersonalAccountStatus | null;
    linkedAt: number | null; verifiedAt: number | null; updatedAt: number | null }> {
    const out: ReturnType<PersonalCodexAccounts['adminView']> = {};
    for (const ownerId of ownerIds) {
      const row = this.accountRow(ownerId);
      out[ownerId] = { linked: !!row, status: row?.status ?? null, linkedAt: row?.linked_at ?? null,
        verifiedAt: row?.verified_at ?? null, updatedAt: row?.updated_at ?? null };
    }
    return out;
  }

  // ---- login state machine -----------------------------------------------------

  async startLogin(ownerId: string): Promise<PersonalLoginAttempt> {
    if (!this.enabled || !this.command) throw new PersonalAccountError(403, 'MULTIUSER_PERSONAL_DISABLED', 'personal subscriptions are not enabled on this server');
    if (this.unlinking.has(ownerId)) throw new PersonalAccountError(409, 'MULTIUSER_PERSONAL_BUSY', 'the personal account is being unlinked');
    const id = randomBytes(32).toString('base64url');
    const createdAt = this.now();
    // Replace atomically: the prior pending attempt and the new one never coexist.
    const prior = this.db.transaction(() => {
      const previous = this.db.prepare("SELECT id FROM multiuser_agent_login_attempts WHERE owner_account_id = ? AND status = 'pending'")
        .get(ownerId) as { id: string } | undefined;
      if (previous) {
        this.db.prepare("UPDATE multiuser_agent_login_attempts SET status = 'canceled', updated_at = ? WHERE id = ? AND status = 'pending'")
          .run(createdAt, previous.id);
        this.audit(ownerId, ownerId, 'link_cancel', 'replaced', previous.id);
      }
      this.db.prepare(`INSERT INTO multiuser_agent_login_attempts (id, owner_account_id, provider, status, created_at, expires_at, updated_at)
        VALUES (?, ?, 'codex', 'pending', ?, ?, ?)`).run(id, ownerId, createdAt, createdAt + PERSONAL_LOGIN_TTL_MS, createdAt);
      this.audit(ownerId, ownerId, 'link_start', null, id);
      return previous?.id ?? null;
    }).immediate();
    if (prior) await this.teardown(prior);
    const loginHome = this.loginHome(ownerId, id);
    privateDir(actorRuntimeDir(this.dataRoot, ownerId));
    privateDir(loginHome);
    privateDir(path.join(loginHome, 'tmp'));
    const client = new AppServerAccountClient({ command: this.command, codexHome: loginHome, home: loginHome,
      temp: path.join(loginHome, 'tmp'), cwd: loginHome, dataRoot: this.dataRoot });
    try {
      await client.initialize();
      const started = await client.request('account/login/start', { type: 'chatgptDeviceCode' });
      if (started.type !== 'chatgptDeviceCode' || typeof started.loginId !== 'string' || typeof started.userCode !== 'string'
          || typeof started.verificationUrl !== 'string' || !/^https:\/\//u.test(started.verificationUrl)) {
        throw new Error('unexpected login response');
      }
      const stillPending = this.attemptRow(id)?.status === 'pending' && !this.stopped;
      if (!stillPending) {
        await client.close();
        fs.rmSync(loginHome, { recursive: true, force: true });
        return this.attemptDto(this.attemptRow(id)!, false);
      }
      // Fire at the durable deadline, not a full TTL after the provider answered.
      const timer = setTimeout(() => { this.finalize(id, 'expired', null, 'link_expire').catch(() => {}); },
        Math.max(0, createdAt + PERSONAL_LOGIN_TTL_MS - this.now()));
      timer.unref();
      const live: LiveAttempt = { id, ownerId, loginId: started.loginId, userCode: started.userCode,
        verificationUrl: started.verificationUrl, client, loginHome, timer, completing: false, closed: null };
      this.live.set(id, live);
      client.onNotification((method, params) => {
        if (method === 'account/login/completed') {
          this.onCompleted(id, params).catch(() => this.finalize(id, 'failed', 'provider_error', 'link_fail').catch(() => {}));
        }
      });
      client.child.once('close', () => {
        if (this.live.get(id) === live && !live.completing && !live.closed) this.finalize(id, 'failed', 'provider_error', 'link_fail').catch(() => {});
      });
      return this.attemptDto(this.attemptRow(id)!, true);
    } catch {
      await client.close();
      fs.rmSync(loginHome, { recursive: true, force: true });
      this.transition(id, 'failed', 'provider_error', 'link_fail');
      return this.attemptDto(this.attemptRow(id)!, false);
    }
  }

  async cancelLogin(ownerId: string, attemptId: string): Promise<PersonalLoginAttempt | null> {
    const row = this.ownedAttempt(ownerId, attemptId);
    if (!row) return null;
    if (row.status === 'pending') {
      // State first: any completion that races the cancel is ignored.
      this.transition(row.id, 'canceled', null, 'link_cancel');
      const live = this.live.get(row.id);
      if (live) await live.client.request('account/login/cancel', { loginId: live.loginId }, 2_000).catch(() => null);
      await this.teardown(row.id);
    }
    return this.attemptDto(this.ownedAttempt(ownerId, attemptId)!, false);
  }

  /** Session revocation / deactivation: end the actor's pending login. */
  async cancelPendingFor(ownerId: string): Promise<void> {
    const pending = this.db.prepare("SELECT id FROM multiuser_agent_login_attempts WHERE owner_account_id = ? AND status = 'pending'")
      .get(ownerId) as { id: string } | undefined;
    if (pending) await this.cancelLogin(ownerId, pending.id);
  }

  private async onCompleted(attemptId: string, params: Json): Promise<void> {
    const live = this.live.get(attemptId);
    // Replays, foreign login ids and anything after a terminal state are ignored.
    if (!live || live.completing || params.loginId !== live.loginId) return;
    if (this.attemptRow(attemptId)?.status !== 'pending') return;
    live.completing = true;
    if (this.pastDeadline(attemptId)) { await this.finalize(attemptId, 'expired', null, 'link_expire'); return; }
    if (params.success !== true) {
      const mapped = classifyLoginFailure(params.error);
      await this.finalize(attemptId, mapped.status, mapped.failureCode, `link_${mapped.status === 'failed' ? 'fail' : mapped.status === 'denied' ? 'deny' : 'expire'}`);
      return;
    }
    let read: Json;
    let limits: Json | null;
    try {
      read = await live.client.request('account/read', { refreshToken: false });
      limits = await live.client.request('account/rateLimits/read', null).catch(() => null);
    } catch {
      await this.finalize(attemptId, 'failed', 'provider_error', 'link_fail');
      return;
    }
    clearTimeout(live.timer);
    await live.client.close();
    if (this.attemptRow(attemptId)?.status !== 'pending' || this.stopped) { await this.finalize(attemptId, 'failed', 'interrupted', 'link_fail'); return; }
    // Re-checked after the provider reads and before any side effect (fence, cancellation, install).
    if (this.pastDeadline(attemptId)) { await this.finalize(attemptId, 'expired', null, 'link_expire'); return; }
    const account = read.account && typeof read.account === 'object' ? read.account as Json : null;
    const email = account?.type === 'chatgpt' && typeof account.email === 'string' ? account.email.trim().toLowerCase() : '';
    if (!email || !email.includes('@')) { await this.finalize(attemptId, 'failed', 'identity_unavailable', 'link_fail'); return; }
    const identity = createHmac('sha256', this.identityKey).update(`codex:${email}`).digest('hex');
    const rateLimits = this.rateLimits(limits);
    const planType = typeof account?.planType === 'string' ? account.planType.slice(0, 64) : null;
    const existing = this.accountRow(live.ownerId);
    // Re-authorization replaces the credential (same identity) or switches the subscription
    // (different identity) on the same account row: fence the owner so nothing is admitted
    // or dispatched on the old version, then stop the runs bound to it.
    if (existing) this.reauthorizing.add(live.ownerId);
    try {
      if (existing) await this.cancelPersonalRuns(live.ownerId);
      if (this.attemptRow(attemptId)?.status !== 'pending' || this.stopped || this.unlinking.has(live.ownerId)) {
        await this.finalize(attemptId, 'failed', 'interrupted', 'link_fail');
        return;
      }
      if (this.pastDeadline(attemptId)) { await this.finalize(attemptId, 'expired', null, 'link_expire'); return; }
      await this.bind(attemptId, live, existing, { identity, email, planType, rateLimits });
    } finally { this.reauthorizing.delete(live.ownerId); }
  }

  /**
   * Bind a completed, accepted login. Synchronous until the bind commits, so no
   * dispatch can observe a half-swapped home. Any failure after the first credential
   * change restores the prior credential (or, for a switch, the prior home and row);
   * if that restore fails too, the backup is kept and the account becomes
   * `requires_reauth`, never left usable.
   */
  private async bind(attemptId: string, live: LiveAttempt, existing: AccountRow | undefined,
    read: { identity: string; email: string; planType: string | null; rateLimits: PersonalRateLimits | null }): Promise<void> {
    const { identity, email, planType, rateLimits } = read;
    const mode: InstallMode = !existing ? 'link' : existing.identity_hash === identity ? 'reauthorize' : 'switch';
    const at = this.now();
    const limitsJson = rateLimits ? JSON.stringify(rateLimits) : null;
    const rollback: { undo: (() => void) | null } = { undo: null };
    // A copy retained by an earlier failed re-authorization goes back in place first;
    // if it cannot, nothing new is installed over it.
    if (existing && !this.reconcileRetained(live.ownerId)) {
      this.recordProblem(live.ownerId, existing.id, 'reauth_required');
      await this.finalize(attemptId, 'failed', 'provider_error', 'link_fail');
      return;
    }
    // UNIQUE(owner, provider) is the backstop; a failed bind leaves no new credential behind.
    try {
      this.installCredentials(live.ownerId, live.loginHome, mode, (fn) => { rollback.undo = fn; });
      this.db.transaction(() => {
        if (existing && mode === 'switch') {
          // Same row, new subscription: its verification and the old native threads do not carry over.
          this.db.prepare(`UPDATE multiuser_agent_accounts SET status = 'connected', identity_hash = ?, masked_identity = ?,
            plan_type = ?, credential_version = credential_version + 1, verified_at = NULL, last_problem = NULL,
            rate_limits_json = ?, updated_at = ? WHERE id = ?`)
            .run(identity, maskEmail(email), planType, limitsJson, at, existing.id);
          this.forgetNativeSessions(live.ownerId);
        } else if (existing) {
          this.db.prepare(`UPDATE multiuser_agent_accounts SET status = 'connected', masked_identity = ?, plan_type = ?,
            credential_version = credential_version + 1, last_problem = NULL, rate_limits_json = ?, updated_at = ? WHERE id = ?`)
            .run(maskEmail(email), planType, limitsJson, at, existing.id);
        } else {
          this.db.prepare(`INSERT INTO multiuser_agent_accounts (id, owner_account_id, provider, status, identity_hash, masked_identity,
            plan_type, credential_version, rate_limits_json, linked_at, updated_at) VALUES (?, ?, 'codex', 'connected', ?, ?, ?, 1, ?, ?, ?)`)
            .run(randomUUID(), live.ownerId, identity, maskEmail(email), planType, limitsJson, at, at);
        }
        // Committing the replacement is what retires the set-aside copy.
        this.releaseRetained(live.ownerId);
        this.transition(attemptId, 'connected', null, 'link_complete');
      }).immediate();
    } catch {
      try { rollback.undo?.(); } catch {
        if (existing) this.recordProblem(live.ownerId, existing.id, 'reauth_required');
      }
      await this.finalize(attemptId, 'failed', 'provider_error', 'link_fail');
      return;
    }
    this.live.delete(attemptId);
    // The replaced credential or home is obsolete once the bind committed; a copy that
    // cannot be removed now is removed by the next reconciliation or unlink.
    try {
      fs.rmSync(this.credentialBackup(live.ownerId), { force: true });
      fs.rmSync(this.homeBackup(live.ownerId), { recursive: true, force: true });
    } catch { /* obsolete copy */ }
    fs.rmSync(live.loginHome, { recursive: true, force: true });
  }

  /**
   * Put a completed login's credential in place as the owner's CODEX_HOME.
   * - `link`: the whole login home moves in.
   * - `reauthorize` (same identity): only the credential file is swapped, so the
   *   owner's native sessions (pinned by conversations) survive.
   * - `switch` (different identity): the whole login home moves in; the previous
   *   home, whose sessions belong to the old subscription, is set aside until commit.
   * The undo is registered before the first change and reverses exactly the steps
   * that happened, including when permission hardening fails.
   */
  private installCredentials(ownerId: string, loginHome: string, mode: InstallMode, setUndo: (undo: () => void) => void): void {
    const home = personalCodexHome(this.dataRoot, ownerId);
    if (mode === 'link') {
      setUndo(() => fs.rmSync(home, { recursive: true, force: true }));
      fs.rmSync(home, { recursive: true, force: true });
      fs.renameSync(loginHome, home);
      lockDown(home);
      return;
    }
    if (mode === 'switch') {
      const aside = this.homeBackup(ownerId);
      const hadHome = fs.existsSync(home);
      this.retain(ownerId, 'home', hadHome);
      let setAside = false;
      let installed = false;
      setUndo(() => {
        if (installed) fs.rmSync(home, { recursive: true, force: true });
        if (setAside) fs.renameSync(aside, home);
        this.releaseRetained(ownerId);
      });
      if (hadHome) { fs.renameSync(home, aside); setAside = true; }
      fs.renameSync(loginHome, home);
      installed = true;
      lockDown(home);
      return;
    }
    privateDir(home);
    const current = path.join(home, CREDENTIAL_FILE);
    // Kept inside the home, so cleaning the login staging directory can never delete it.
    const backup = this.credentialBackup(ownerId);
    const hadPrevious = fs.existsSync(current);
    this.retain(ownerId, 'credential', hadPrevious);
    let backedUp = false;
    let installed = false;
    setUndo(() => {
      if (installed) fs.rmSync(current, { force: true });
      if (backedUp) fs.renameSync(backup, current);
      this.releaseRetained(ownerId);
    });
    if (hadPrevious) { fs.renameSync(current, backup); backedUp = true; }
    fs.renameSync(path.join(loginHome, CREDENTIAL_FILE), current);
    installed = true;
    lockDown(home);
  }

  /** Where a switch sets the previous home aside; beside the home, outside login staging. */
  private homeBackup(ownerId: string): string {
    return path.join(actorRuntimeDir(this.dataRoot, ownerId), 'codex-home.previous');
  }

  /** Durably note, before the first file change, that this owner's prior state is being set aside. */
  private retain(ownerId: string, kind: 'home' | 'credential', hadPrior: boolean): void {
    this.db.prepare('INSERT INTO multiuser_agent_retained_state (owner_account_id, kind, had_prior, created_at) VALUES (?, ?, ?, ?)')
      .run(ownerId, kind, hadPrior ? 1 : 0, this.now());
  }

  private releaseRetained(ownerId: string): void {
    this.db.prepare('DELETE FROM multiuser_agent_retained_state WHERE owner_account_id = ?').run(ownerId);
  }

  private retained(ownerId: string): { kind: 'home' | 'credential'; had_prior: number } | undefined {
    return this.db.prepare('SELECT kind, had_prior FROM multiuser_agent_retained_state WHERE owner_account_id = ?')
      .get(ownerId) as { kind: 'home' | 'credential'; had_prior: number } | undefined;
  }

  /**
   * Put a retained prior state back before anything new is installed (on restart and
   * on the next re-authorization). A retained record exists only while its replacement
   * has not committed, so the set-aside copy is the account's truth: whatever stands
   * in its place is an uncommitted replacement and goes. Without a record, any copy
   * left beside the home belongs to a committed replacement and is obsolete. Returns
   * false when the prior state cannot be put back; the retained copy then stays where
   * it is and nothing is installed over it.
   */
  private reconcileRetained(ownerId: string): boolean {
    const home = personalCodexHome(this.dataRoot, ownerId);
    const aside = this.homeBackup(ownerId);
    const backup = this.credentialBackup(ownerId);
    const record = this.retained(ownerId);
    try {
      if (!record) {
        fs.rmSync(aside, { recursive: true, force: true });
        fs.rmSync(backup, { force: true });
        return true;
      }
      const copy = record.kind === 'home' ? aside : backup;
      const target = record.kind === 'home' ? home : path.join(home, CREDENTIAL_FILE);
      if (fs.existsSync(copy)) {
        fs.rmSync(target, { recursive: true, force: true });
        fs.renameSync(copy, target);
      } else if (record.had_prior === 0) {
        // Nothing was set aside because nothing existed: the target is an uncommitted replacement.
        fs.rmSync(target, { recursive: true, force: true });
      }
      // Otherwise the copy was never moved, or was already moved back: the target is the prior state.
      this.releaseRetained(ownerId);
      return true;
    } catch {
      return false;
    }
  }

  private credentialBackup(ownerId: string): string {
    return path.join(personalCodexHome(this.dataRoot, ownerId), `${CREDENTIAL_FILE}.previous`);
  }

  private pastDeadline(attemptId: string): boolean {
    const row = this.attemptRow(attemptId);
    return !!row && this.now() >= row.expires_at;
  }

  private fenced(ownerId: string): boolean {
    return this.unlinking.has(ownerId) || this.reauthorizing.has(ownerId);
  }

  private rateLimits(result: Json | null): PersonalRateLimits | null {
    const snapshot = result?.rateLimits && typeof result.rateLimits === 'object' ? result.rateLimits as Json : null;
    if (!snapshot) return null;
    const primary = rateWindow(snapshot.primary);
    const secondary = rateWindow(snapshot.secondary);
    return primary || secondary ? { primary, secondary, readAt: this.now() } : null;
  }

  /** Move a pending attempt to a terminal state (no-op otherwise) and tear its child down. */
  private async finalize(attemptId: string, status: PersonalLoginAttemptStatus, failureCode: PersonalLoginFailureCode | null,
    action: string): Promise<void> {
    this.transition(attemptId, status, failureCode, action);
    await this.teardown(attemptId);
  }

  private transition(attemptId: string, status: PersonalLoginAttemptStatus, failureCode: PersonalLoginFailureCode | null, action: string): void {
    const row = this.attemptRow(attemptId);
    if (!row) return;
    const changed = this.db.prepare(`UPDATE multiuser_agent_login_attempts SET status = ?, failure_code = ?, updated_at = ?
      WHERE id = ? AND status = 'pending'`).run(status, failureCode, this.now(), attemptId).changes;
    if (changed > 0) this.audit(row.owner_account_id, row.owner_account_id, action, failureCode ?? status, attemptId);
  }

  private async teardown(attemptId: string): Promise<void> {
    const live = this.live.get(attemptId);
    const row = this.attemptRow(attemptId);
    if (live) {
      clearTimeout(live.timer);
      live.closed ??= live.client.close();
      await live.closed;
      if (this.live.get(attemptId) === live) this.live.delete(attemptId);
    }
    if (row) fs.rmSync(this.loginHome(row.owner_account_id, attemptId), { recursive: true, force: true });
  }

  // ---- verify / problems / unlink -------------------------------------------------

  async verify(ownerId: string, accountId: string, consent: unknown): Promise<PersonalAgentAccount | null> {
    const row = this.accountRow(ownerId);
    if (!row || row.id !== accountId) return null;
    if (consent !== true) throw new PersonalAccountError(400, 'MULTIUSER_PERSONAL_CONSENT_REQUIRED', 'verification consumes your plan; explicit consent is required');
    if (!this.enabled || !this.command) throw new PersonalAccountError(403, 'MULTIUSER_PERSONAL_DISABLED', 'personal subscriptions are not enabled on this server');
    if (this.fenced(ownerId)) throw new PersonalAccountError(409, 'MULTIUSER_PERSONAL_BUSY', 'the personal account is being changed');
    if (row.status !== 'connected') throw new PersonalAccountError(409, 'MULTIUSER_PERSONAL_UNAVAILABLE', 'the personal account is not usable; re-authorize or unlink it');
    if (this.verifying.has(ownerId)) throw new PersonalAccountError(409, 'MULTIUSER_PERSONAL_BUSY', 'a verification is already running');
    const work = path.join(actorRuntimeDir(this.dataRoot, ownerId), 'codex-verify');
    privateDir(work);
    privateDir(path.join(work, 'tmp'));
    const home = personalCodexHome(this.dataRoot, ownerId);
    const turn = runPersonalCodexTurn({ command: this.command, codexHome: home, home: work, temp: path.join(work, 'tmp'),
      cwd: work, dataRoot: this.dataRoot, prompt: VERIFY_PROMPT, resumeThreadId: null, sandboxMode: 'read-only' });
    this.verifying.set(ownerId, turn.child);
    let result: PersonalTurnResult;
    try { result = await turn.done; } finally {
      this.verifying.delete(ownerId);
      fs.rmSync(work, { recursive: true, force: true });
    }
    this.secureHome(ownerId);
    const current = this.accountRow(ownerId);
    if (!current || current.id !== accountId || current.credential_version !== row.credential_version || this.fenced(ownerId)) {
      throw new PersonalAccountError(409, 'MULTIUSER_PERSONAL_UNAVAILABLE', 'the personal account changed during verification');
    }
    if (result.ok) {
      this.db.prepare('UPDATE multiuser_agent_accounts SET verified_at = ?, last_problem = NULL, updated_at = ? WHERE id = ?')
        .run(this.now(), this.now(), accountId);
      this.audit(ownerId, ownerId, 'verify', 'ok', accountId);
      return this.accountDto(this.accountRow(ownerId)!);
    }
    this.audit(ownerId, ownerId, 'verify', result.problem ?? 'failed', accountId);
    if (result.problem) {
      this.recordProblem(ownerId, accountId, result.problem);
      const mapped = PROBLEM_ERRORS[result.problem];
      throw new PersonalAccountError(mapped.status, mapped.code, 'the provider refused the verification request');
    }
    throw new PersonalAccountError(502, 'AGENT_EXECUTION_FAILED', 'verification request failed');
  }

  /** Apply a provider failure class; usage limits never change the status or the source. */
  recordProblem(ownerId: string, accountId: string, problem: PersonalAccountProblem): void {
    const row = this.accountRow(ownerId);
    if (!row || row.id !== accountId) return;
    const status: PersonalAccountStatus = problem === 'reauth_required' ? 'requires_reauth'
      : problem === 'workspace_not_allowed' ? 'disabled' : row.status;
    this.db.prepare('UPDATE multiuser_agent_accounts SET status = ?, last_problem = ?, updated_at = ? WHERE id = ?')
      .run(status, problem, this.now(), accountId);
    if (status !== row.status) this.audit(ownerId, ownerId, 'status_change', status, accountId);
  }

  async unlink(ownerId: string, accountId: string): Promise<boolean> {
    const row = this.accountRow(ownerId);
    if (!row || row.id !== accountId) return false;
    if (this.unlinking.has(ownerId)) throw new PersonalAccountError(409, 'MULTIUSER_PERSONAL_BUSY', 'the personal account is being unlinked');
    // Fence before the first await: the account is unusable until its row and home are gone.
    this.unlinking.add(ownerId);
    try {
      await this.cancelPendingFor(ownerId);
      await this.cancelPersonalRuns(ownerId);
      const verifying = this.verifying.get(ownerId);
      if (verifying) await closeChild(verifying, 0);
      const home = personalCodexHome(this.dataRoot, ownerId);
      if (this.command && fs.existsSync(home)) {
        // Best effort local logout; this is not a provider-side revocation.
        const client = new AppServerAccountClient({ command: this.command, codexHome: home, home, temp: home, cwd: home, dataRoot: this.dataRoot });
        try { await client.initialize(); await client.request('account/logout', null, 3_000); } catch { /* deletion below is authoritative */ }
        await client.close();
      }
      // Every copy of this owner's state goes before the row: the active home (with any
      // retained credential inside it) and a home set aside by a failed switch.
      try {
        fs.rmSync(this.homeBackup(ownerId), { recursive: true, force: true });
        fs.rmSync(home, { recursive: true, force: true });
      } catch (error) {
        this.recordProblem(ownerId, accountId, 'reauth_required');
        throw error;
      }
      this.db.transaction(() => {
        this.db.prepare('DELETE FROM multiuser_agent_accounts WHERE id = ? AND owner_account_id = ?').run(accountId, ownerId);
        this.releaseRetained(ownerId);
        this.audit(ownerId, ownerId, 'unlink', null, accountId);
      })();
      return true;
    } finally { this.unlinking.delete(ownerId); }
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    for (const id of [...this.live.keys()]) {
      this.transition(id, 'failed', 'interrupted', 'link_interrupted');
      await this.teardown(id);
    }
    await Promise.all([...this.verifying.values()].map((child) => closeChild(child, 0)));
  }

  // ---- internals ---------------------------------------------------------------

  /** Restart: pending attempts lost their child, so they fail; their login homes go. */
  private recover(): void {
    const pending = this.db.prepare("SELECT id FROM multiuser_agent_login_attempts WHERE status = 'pending'").all() as Array<{ id: string }>;
    for (const { id } of pending) this.transition(id, 'failed', 'interrupted', 'link_interrupted');
    // Retained copies go back in place; copies left by a committed replacement go.
    const owners = this.db.prepare(`SELECT owner_account_id AS id FROM multiuser_agent_retained_state
      UNION SELECT owner_account_id FROM multiuser_agent_accounts`).all() as Array<{ id: string }>;
    for (const { id } of owners) {
      const account = this.accountRow(id);
      if (!this.reconcileRetained(id) && account) this.recordProblem(id, account.id, 'reauth_required');
    }
    const root = path.join(this.dataRoot, 'multiuser-runtime');
    if (!fs.existsSync(root)) return;
    for (const actor of fs.readdirSync(root)) {
      const dir = path.join(root, actor);
      if (!fs.lstatSync(dir).isDirectory()) continue;
      for (const name of fs.readdirSync(dir)) {
        if (name.startsWith('codex-login-') || name === 'codex-verify') fs.rmSync(path.join(dir, name), { recursive: true, force: true });
      }
    }
  }

  private loginHome(ownerId: string, attemptId: string): string {
    return path.join(actorRuntimeDir(this.dataRoot, ownerId), `codex-login-${createHash('sha256').update(attemptId).digest('hex').slice(0, 24)}`);
  }

  private attemptRow(id: string): AttemptRow | undefined {
    return this.db.prepare('SELECT * FROM multiuser_agent_login_attempts WHERE id = ?').get(id) as AttemptRow | undefined;
  }

  private ownedAttempt(ownerId: string, id: string): AttemptRow | null {
    const row = this.attemptRow(id);
    return row && row.owner_account_id === ownerId ? row : null;
  }

  private accountRow(ownerId: string): AccountRow | undefined {
    return this.db.prepare("SELECT * FROM multiuser_agent_accounts WHERE owner_account_id = ? AND provider = 'codex'")
      .get(ownerId) as AccountRow | undefined;
  }

  private attemptDto(row: AttemptRow, withSecrets: boolean): PersonalLoginAttempt {
    const live = withSecrets && row.status === 'pending' ? this.live.get(row.id) : undefined;
    return {
      id: row.id, provider: 'codex', status: row.status, failureCode: row.failure_code,
      createdAt: row.created_at, expiresAt: row.expires_at,
      ...(live ? { verificationUrl: live.verificationUrl, userCode: live.userCode } : {}),
    };
  }

  private accountDto(row: AccountRow): PersonalAgentAccount {
    return {
      id: row.id, provider: 'codex', status: row.status, maskedIdentity: row.masked_identity, planType: row.plan_type,
      linkedAt: row.linked_at, verifiedAt: row.verified_at, lastProblem: row.last_problem,
      rateLimits: row.rate_limits_json ? JSON.parse(row.rate_limits_json) as PersonalRateLimits : null,
    };
  }
}
