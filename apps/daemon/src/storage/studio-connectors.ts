import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { loadCompanyCredentialKey } from './company-openai.js';

/**
 * Account connectors (#62, S58; owner decision 2026-10-10): one company
 * Composio key, set only by administrators, and connections that belong to
 * each account through its own OAuth.
 *
 * - The company key is AES-256-GCM ciphertext in SQLite under the same
 *   data-root key file as the company OpenAI credential, authenticated with
 *   its own AAD. No read returns it; summaries carry the last four characters.
 * - Each account maps to a stable opaque Composio entity derived server-side
 *   (`od-acct-` + HMAC of the account id under a daemon secret). It is never
 *   the host user id and never client supplied.
 * - An OAuth state is a random token whose SHA-256 is stored, bound to the
 *   account, its session, role and pilot revision, the connector, the company
 *   key revision and an expiry, and consumed once. Cancellation (the user's,
 *   a session revocation, a key change) is authoritative: it also retires a
 *   state an in-flight callback already consumed, and the callback records a
 *   connection only in a transaction that finds its state neither cancelled
 *   nor expired (`completeConnection`).
 * - Audit rows record actions and outcome categories, never key material,
 *   entities or provider ids.
 */

const AAD = Buffer.from('open-design-company-composio-v1');
export const STUDIO_CONNECTOR_STATE_TTL_MS = 10 * 60 * 1000;
/** Pending authorizations an account may hold at once; the oldest is retired first. */
export const STUDIO_CONNECTOR_MAX_PENDING_STATES = 16;

export class CompanyComposioConfigError extends Error {
  constructor(readonly status: 400 | 409) { super('Company Composio configuration refused'); }
}

interface KeyRow { revision: number; credential_revision: number; credential: string | null; last4: string | null; updated_at: number | null }

export interface CompanyComposioSummary {
  configured: boolean;
  last4: string;
  revision: number;
  credentialRevision: number;
  updatedAt: number | null;
}

export type CompanyComposioAction = 'set' | 'rotate' | 'clear' | 'unchanged';

export class CompanyComposioStore {
  private readonly key: Buffer;
  constructor(private readonly db: Database.Database, dataRoot: string, private readonly now: () => number = Date.now) {
    this.key = loadCompanyCredentialKey(dataRoot);
    db.exec(`CREATE TABLE IF NOT EXISTS company_composio_config (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1), revision INTEGER NOT NULL,
      credential_revision INTEGER NOT NULL, credential TEXT, last4 TEXT, updated_at INTEGER
    );
    INSERT OR IGNORE INTO company_composio_config VALUES (1, 0, 0, NULL, NULL, NULL);
    CREATE TABLE IF NOT EXISTS company_composio_audit (
      id INTEGER PRIMARY KEY, actor_id TEXT NOT NULL, action TEXT NOT NULL CHECK (action IN ('set','rotate','clear','unchanged')),
      revision INTEGER NOT NULL, credential_revision INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS company_composio_audit_immutable BEFORE UPDATE ON company_composio_audit
      BEGIN SELECT RAISE(ABORT, 'audit rows are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS company_composio_audit_no_delete BEFORE DELETE ON company_composio_audit
      BEGIN SELECT RAISE(ABORT, 'audit rows are immutable'); END;`);
  }
  private row(): KeyRow { return this.db.prepare('SELECT * FROM company_composio_config WHERE singleton = 1').get() as KeyRow; }
  read(): CompanyComposioSummary {
    const row = this.row();
    return { configured: row.credential !== null, last4: row.credential !== null ? row.last4 ?? '' : '',
      revision: row.revision, credentialRevision: row.credential_revision, updatedAt: row.updated_at };
  }
  configured(): boolean { return this.row().credential !== null; }
  /** Internal use only: the key and the revision it belongs to, or null. */
  credential(): { apiKey: string; credentialRevision: number } | null {
    const row = this.row();
    if (!row.credential) return null;
    const bytes = Buffer.from(row.credential, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
    decipher.setAAD(AAD); decipher.setAuthTag(bytes.subarray(12, 28));
    return { apiKey: Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'), credentialRevision: row.credential_revision };
  }
  private encrypt(value: string): string {
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(AAD);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
  }
  /**
   * Revision-checked; a string sets or rotates, null clears. `authorize` runs
   * inside the write transaction immediately before the write (it throws to
   * refuse); `onChange` runs in the same transaction when the key changed, so
   * a key change and its side effects commit together.
   */
  update(actorId: string, input: unknown, hooks: { authorize?: () => void; onChange?: (action: Exclude<CompanyComposioAction, 'unchanged'>) => void } = {}): { summary: CompanyComposioSummary; action: CompanyComposioAction } {
    const body = input as { revision?: unknown; apiKey?: unknown } | null;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !['revision', 'apiKey'].includes(key))
      || !Number.isSafeInteger(body.revision) || Number(body.revision) < 0
      || !(body.apiKey === null || typeof body.apiKey === 'string' && body.apiKey.trim().length >= 8 && body.apiKey.length <= 4096
        && !/[\s\0]/.test(body.apiKey.trim()))) throw new CompanyComposioConfigError(400);
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : null;
    return this.db.transaction(() => {
      hooks.authorize?.();
      const previous = this.row();
      if (previous.revision !== body.revision) throw new CompanyComposioConfigError(409);
      const prior = this.credential();
      const action: CompanyComposioAction = apiKey === null ? (prior ? 'clear' : 'unchanged')
        : !prior ? 'set' : prior.apiKey === apiKey ? 'unchanged' : 'rotate';
      const revision = previous.revision + 1;
      const credentialRevision = previous.credential_revision + (action === 'unchanged' ? 0 : 1);
      this.db.prepare('UPDATE company_composio_config SET revision = ?, credential_revision = ?, credential = ?, last4 = ?, updated_at = ? WHERE singleton = 1')
        .run(revision, credentialRevision, apiKey === null ? null : action === 'unchanged' ? previous.credential : this.encrypt(apiKey),
          apiKey === null ? null : apiKey.slice(-4), this.now());
      this.db.prepare('INSERT INTO company_composio_audit (actor_id, action, revision, credential_revision, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(actorId, action, revision, credentialRevision, this.now());
      if (action !== 'unchanged') hooks.onChange?.(action);
      return { summary: this.read(), action };
    }).immediate();
  }
}

export type StudioConnectionStatus = 'connected' | 'disconnected';
export interface StudioConnectionRow {
  owner_account_id: string; connector_id: string; status: StudioConnectionStatus; provider_connection_id: string | null;
  account_label: string | null; credential_revision: number; connected_at: number | null; updated_at: number;
}
/** What the session that started an authorization looked like; rechecked at the callback. */
export interface StudioConnectorStateBinding {
  accountId: string; sessionId: string; role: string; studioRevision: number | null; sessionExpiresAt: number;
  connectorId: string; credentialRevision: number;
}
interface StateRow {
  state_hash: string; owner_account_id: string; session_id: string; role: string; studio_revision: number | null;
  session_expires_at: number; connector_id: string; credential_revision: number; provider_connection_id: string | null;
  expires_at: number; used_at: number | null; cancelled: 'state' | 'session' | 'key-changed' | null; completed_at: number | null; created_at: number;
}
export type ConsumedState =
  | { ok: true; binding: StudioConnectorStateBinding; providerConnectionId: string | null }
  | { ok: false; reason: 'state' | 'expired' | 'replayed' | 'session' | 'key-changed' };
/** Outcome of the callback's final, transactional completion. */
export type CompletedConnection<R extends string> = { ok: true } | { ok: false; reason: 'state' | 'expired' | 'replayed' | 'session' | 'key-changed' | R };

const hashState = (token: string) => createHash('sha256').update(`studio-connector-state:${token}`).digest('hex');
const STATE_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export class StudioConnectorStore {
  private readonly entitySecret: Buffer;
  constructor(private readonly db: Database.Database, private readonly now: () => number = Date.now) {
    db.exec(`CREATE TABLE IF NOT EXISTS studio_connector_meta (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1), entity_secret BLOB NOT NULL CHECK (length(entity_secret) = 32)
    );
    CREATE TABLE IF NOT EXISTS studio_connector_auth_configs (
      connector_id TEXT NOT NULL, credential_revision INTEGER NOT NULL, auth_config_id TEXT NOT NULL,
      PRIMARY KEY (connector_id, credential_revision)
    );
    CREATE TABLE IF NOT EXISTS studio_connector_connections (
      owner_account_id TEXT NOT NULL, connector_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('connected','disconnected')),
      provider_connection_id TEXT, account_label TEXT, credential_revision INTEGER NOT NULL,
      connected_at INTEGER, updated_at INTEGER NOT NULL, PRIMARY KEY (owner_account_id, connector_id)
    );
    CREATE TABLE IF NOT EXISTS studio_connector_states (
      state_hash TEXT PRIMARY KEY, owner_account_id TEXT NOT NULL, session_id TEXT NOT NULL, role TEXT NOT NULL,
      studio_revision INTEGER, session_expires_at INTEGER NOT NULL, connector_id TEXT NOT NULL,
      credential_revision INTEGER NOT NULL, provider_connection_id TEXT, expires_at INTEGER NOT NULL,
      used_at INTEGER, cancelled TEXT CHECK (cancelled IS NULL OR cancelled IN ('state','session','key-changed')), completed_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS studio_connector_states_owner ON studio_connector_states (owner_account_id, used_at);
    CREATE TABLE IF NOT EXISTS studio_connector_audit (
      id INTEGER PRIMARY KEY, actor_account_id TEXT NOT NULL, action TEXT NOT NULL, connector_id TEXT,
      outcome TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS studio_connector_audit_immutable BEFORE UPDATE ON studio_connector_audit
      BEGIN SELECT RAISE(ABORT, 'audit rows are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS studio_connector_audit_no_delete BEFORE DELETE ON studio_connector_audit
      BEGIN SELECT RAISE(ABORT, 'audit rows are immutable'); END;`);
    // Tables created before completion was tracked gain the column; existing rows read as not completed.
    if (!(db.prepare('PRAGMA table_info(studio_connector_states)').all() as Array<{ name: string }>).some((column) => column.name === 'completed_at')) {
      db.exec('ALTER TABLE studio_connector_states ADD COLUMN completed_at INTEGER');
    }
    db.prepare('INSERT OR IGNORE INTO studio_connector_meta (singleton, entity_secret) VALUES (1, ?)').run(randomBytes(32));
    this.entitySecret = (db.prepare('SELECT entity_secret FROM studio_connector_meta WHERE singleton = 1').get() as { entity_secret: Buffer }).entity_secret;
  }

  /** The account's Composio entity: stable, opaque, server-derived; never the host user id. */
  entityFor(accountId: string): string {
    return `od-acct-${createHmac('sha256', this.entitySecret).update(`composio-entity:${accountId}`).digest('hex').slice(0, 32)}`;
  }

  authConfig(connectorId: string, credentialRevision: number): string | null {
    return (this.db.prepare('SELECT auth_config_id FROM studio_connector_auth_configs WHERE connector_id = ? AND credential_revision = ?')
      .get(connectorId, credentialRevision) as { auth_config_id: string } | undefined)?.auth_config_id ?? null;
  }
  setAuthConfig(connectorId: string, credentialRevision: number, authConfigId: string): void {
    this.db.prepare(`INSERT INTO studio_connector_auth_configs (connector_id, credential_revision, auth_config_id) VALUES (?, ?, ?)
      ON CONFLICT(connector_id, credential_revision) DO UPDATE SET auth_config_id = excluded.auth_config_id`).run(connectorId, credentialRevision, authConfigId);
  }

  connection(owner: string, connectorId: string): StudioConnectionRow | null {
    return (this.db.prepare('SELECT * FROM studio_connector_connections WHERE owner_account_id = ? AND connector_id = ?')
      .get(owner, connectorId) as StudioConnectionRow | undefined) ?? null;
  }
  connections(owner: string): StudioConnectionRow[] {
    return this.db.prepare('SELECT * FROM studio_connector_connections WHERE owner_account_id = ?').all(owner) as StudioConnectionRow[];
  }
  /** Record (or replace) the account's own connection; history of earlier ones lives in the audit. */
  saveConnection(owner: string, connectorId: string, input: { providerConnectionId: string; accountLabel: string; credentialRevision: number }): void {
    const at = this.now();
    this.db.prepare(`INSERT INTO studio_connector_connections (owner_account_id, connector_id, status, provider_connection_id, account_label, credential_revision, connected_at, updated_at)
      VALUES (?, ?, 'connected', ?, ?, ?, ?, ?)
      ON CONFLICT(owner_account_id, connector_id) DO UPDATE SET status = 'connected', provider_connection_id = excluded.provider_connection_id,
        account_label = excluded.account_label, credential_revision = excluded.credential_revision, connected_at = excluded.connected_at, updated_at = excluded.updated_at`)
      .run(owner, connectorId, input.providerConnectionId, input.accountLabel.slice(0, 256), input.credentialRevision, at, at);
  }
  /** The row stays (status history); the provider id is cleared so nothing can act on it again. */
  markDisconnected(owner: string, connectorId: string): void {
    this.db.prepare(`UPDATE studio_connector_connections SET status = 'disconnected', provider_connection_id = NULL, updated_at = ?
      WHERE owner_account_id = ? AND connector_id = ?`).run(this.now(), owner, connectorId);
  }

  /** Reconcile an already-completed DELETE without overwriting a replacement connection. */
  reconcileDeleted(owner: string, connectorId: string, providerId: string, credentialRevision: number): void {
    this.db.prepare(`UPDATE studio_connector_connections SET status = 'disconnected', provider_connection_id = NULL, updated_at = ?
      WHERE owner_account_id = ? AND connector_id = ? AND provider_connection_id = ? AND credential_revision = ?`)
      .run(this.now(), owner, connectorId, providerId, credentialRevision);
  }

  /** A new single-use state bound to the starting session; returns the token (only its hash is stored). */
  createState(binding: StudioConnectorStateBinding): { token: string; expiresAt: number } {
    const token = randomBytes(32).toString('base64url');
    const at = this.now();
    const expiresAt = at + STUDIO_CONNECTOR_STATE_TTL_MS;
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM studio_connector_states WHERE expires_at < ? OR used_at IS NOT NULL AND used_at < ?').run(at - STUDIO_CONNECTOR_STATE_TTL_MS, at - STUDIO_CONNECTOR_STATE_TTL_MS);
      const pending = this.db.prepare('SELECT state_hash FROM studio_connector_states WHERE owner_account_id = ? AND used_at IS NULL ORDER BY created_at, rowid')
        .all(binding.accountId) as Array<{ state_hash: string }>;
      for (const stale of pending.slice(0, Math.max(0, pending.length - STUDIO_CONNECTOR_MAX_PENDING_STATES + 1))) {
        this.db.prepare("UPDATE studio_connector_states SET used_at = ?, cancelled = 'state' WHERE state_hash = ?").run(at, stale.state_hash);
      }
      this.db.prepare(`INSERT INTO studio_connector_states (state_hash, owner_account_id, session_id, role, studio_revision, session_expires_at,
        connector_id, credential_revision, provider_connection_id, expires_at, used_at, cancelled, completed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, ?)`)
        .run(hashState(token), binding.accountId, binding.sessionId, binding.role, binding.studioRevision, binding.sessionExpiresAt,
          binding.connectorId, binding.credentialRevision, expiresAt, at);
    })();
    return { token, expiresAt };
  }
  setStateProviderConnection(token: string, providerConnectionId: string): void {
    this.db.prepare('UPDATE studio_connector_states SET provider_connection_id = ? WHERE state_hash = ? AND used_at IS NULL')
      .run(providerConnectionId, hashState(token));
  }
  /** Retire a state that never left the server (the link request failed). */
  discardState(token: string): void {
    this.db.prepare("UPDATE studio_connector_states SET used_at = ?, cancelled = 'state' WHERE state_hash = ? AND used_at IS NULL").run(this.now(), hashState(token));
  }
  /** Single use: the first callback consumes the state whatever the outcome of the checks that follow. */
  consumeState(token: unknown, connectorId: string): ConsumedState {
    if (typeof token !== 'string' || !STATE_TOKEN.test(token)) return { ok: false, reason: 'state' };
    const at = this.now();
    return this.db.transaction((): ConsumedState => {
      const row = this.db.prepare('SELECT * FROM studio_connector_states WHERE state_hash = ?').get(hashState(token)) as StateRow | undefined;
      if (!row || row.connector_id !== connectorId) return { ok: false, reason: 'state' };
      if (row.cancelled !== null) return { ok: false, reason: row.cancelled };
      if (row.used_at !== null) return { ok: false, reason: 'replayed' };
      this.db.prepare('UPDATE studio_connector_states SET used_at = ? WHERE state_hash = ?').run(at, row.state_hash);
      if (row.expires_at <= at) return { ok: false, reason: 'expired' };
      return { ok: true, providerConnectionId: row.provider_connection_id, binding: { accountId: row.owner_account_id, sessionId: row.session_id,
        role: row.role, studioRevision: row.studio_revision, sessionExpiresAt: row.session_expires_at, connectorId: row.connector_id,
        credentialRevision: row.credential_revision } };
    }).immediate();
  }
  /**
   * Record the account's connection for a consumed state, in one transaction
   * that first re-reads the state — refusing it if it was cancelled (by the
   * user, a session revocation or a key change) or expired after the callback
   * consumed it, or already completed — and then runs `recheck` (account,
   * session and key authority) inside the same transaction. A cancel that
   * returned before this commit can therefore never be followed by a
   * connection.
   */
  completeConnection<R extends string>(token: string, connectorId: string,
    input: { owner: string; providerConnectionId: string; accountLabel: string; credentialRevision: number },
    recheck: () => R | null): CompletedConnection<R> {
    const at = this.now();
    return this.db.transaction((): CompletedConnection<R> => {
      const row = this.db.prepare('SELECT * FROM studio_connector_states WHERE state_hash = ?').get(hashState(token)) as StateRow | undefined;
      if (!row || row.connector_id !== connectorId || row.owner_account_id !== input.owner || row.used_at === null) return { ok: false, reason: 'state' };
      if (row.cancelled !== null) return { ok: false, reason: row.cancelled };
      if (row.completed_at !== null) return { ok: false, reason: 'replayed' };
      if (row.expires_at <= at) return { ok: false, reason: 'expired' };
      const refused = recheck();
      if (refused) return { ok: false, reason: refused };
      this.saveConnection(input.owner, connectorId, input);
      this.db.prepare('UPDATE studio_connector_states SET completed_at = ? WHERE state_hash = ?').run(at, row.state_hash);
      return { ok: true };
    }).immediate();
  }
  /**
   * Retire authorizations: one connector (the user cancelled), or every one the
   * account holds (session revoke, disable). Authoritative for in-flight
   * callbacks: a state a callback already consumed but has not completed is
   * cancelled too, so `completeConnection` refuses it.
   */
  cancelStates(owner: string, connectorId?: string): number {
    const at = this.now();
    return this.db.prepare(`UPDATE studio_connector_states SET used_at = COALESCE(used_at, ?), cancelled = ?
      WHERE owner_account_id = ? AND cancelled IS NULL AND completed_at IS NULL AND expires_at > ?
      ${connectorId === undefined ? '' : 'AND connector_id = ?'}`).run(at, connectorId === undefined ? 'session' : 'state', owner, at,
      ...(connectorId === undefined ? [] : [connectorId])).changes;
  }
  /** Company key change: every authorization started under the old key dies with it, in flight or not. */
  cancelAllStates(): number {
    const at = this.now();
    return this.db.prepare(`UPDATE studio_connector_states SET used_at = COALESCE(used_at, ?), cancelled = 'key-changed'
      WHERE cancelled IS NULL AND completed_at IS NULL AND expires_at > ?`).run(at, at).changes;
  }

  audit(actor: string, action: string, connectorId: string | null, outcome: string): void {
    this.db.prepare('INSERT INTO studio_connector_audit (actor_account_id, action, connector_id, outcome, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(actor, action, connectorId, outcome, this.now());
  }
}

/**
 * Run-time connector grants (#62, S59; persistence moved here in S60).
 *
 * - The per-account revocation epoch: every account-wide revocation (session
 *   revoke, password reset, disable, role change, logout) bumps it, and a grant
 *   captured under an older epoch is refused at the provider boundary.
 * - The immutable per-call tool audit: actor, connector, tool slug, run id,
 *   outcome category and time only — never arguments, results, entities,
 *   provider ids or keys. Completed rows also count toward the per-run limit.
 */
export class StudioConnectorGrantStore {
  constructor(private readonly db: Database.Database, private readonly now: () => number = Date.now) {
    db.exec(`CREATE TABLE IF NOT EXISTS studio_mcp_tool_audit (id INTEGER PRIMARY KEY, actor_account_id TEXT NOT NULL,
        server_id TEXT NOT NULL, tool_name TEXT NOT NULL, run_id TEXT NOT NULL, outcome TEXT NOT NULL, duration_ms INTEGER NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS studio_mcp_tool_audit_run ON studio_mcp_tool_audit (run_id);
      CREATE TRIGGER IF NOT EXISTS studio_mcp_tool_audit_immutable BEFORE UPDATE ON studio_mcp_tool_audit
        BEGIN SELECT RAISE(ABORT, 'audit rows are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS studio_mcp_tool_audit_no_delete BEFORE DELETE ON studio_mcp_tool_audit
        BEGIN SELECT RAISE(ABORT, 'audit rows are immutable'); END;
      CREATE TABLE IF NOT EXISTS studio_connector_grant_epochs (account_id TEXT PRIMARY KEY, version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS studio_connector_tool_audit (id INTEGER PRIMARY KEY, actor_account_id TEXT NOT NULL,
        connector_id TEXT NOT NULL, tool_slug TEXT NOT NULL, run_id TEXT NOT NULL, outcome TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS studio_connector_tool_audit_run ON studio_connector_tool_audit (run_id);
      CREATE TRIGGER IF NOT EXISTS studio_connector_tool_audit_immutable BEFORE UPDATE ON studio_connector_tool_audit
        BEGIN SELECT RAISE(ABORT, 'audit rows are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS studio_connector_tool_audit_no_delete BEFORE DELETE ON studio_connector_tool_audit
        BEGIN SELECT RAISE(ABORT, 'audit rows are immutable'); END;`);
  }
  epoch(owner: string): number {
    return (this.db.prepare('SELECT version FROM studio_connector_grant_epochs WHERE account_id = ?').get(owner) as { version: number } | undefined)?.version ?? 0;
  }
  invalidate(owner: string): void {
    this.db.prepare(`INSERT INTO studio_connector_grant_epochs VALUES (?, 1)
      ON CONFLICT(account_id) DO UPDATE SET version = version + 1`).run(owner);
  }
  /** Completed (audited) tool calls of a run, whatever their outcome. */
  toolCalls(runId: string): number {
    return (this.db.prepare('SELECT (SELECT COUNT(*) FROM studio_connector_tool_audit WHERE run_id = ?) + (SELECT COUNT(*) FROM studio_mcp_tool_audit WHERE run_id = ?) AS n').get(runId, runId) as { n: number }).n;
  }
  appendMcpAudit(row: { owner: string; serverId: string; toolName: string; runId: string; outcome: string; durationMs: number }): void {
    this.db.prepare(`INSERT INTO studio_mcp_tool_audit (actor_account_id, server_id, tool_name, run_id, outcome, duration_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(row.owner, row.serverId, row.toolName, row.runId, row.outcome, row.durationMs, this.now());
  }
  appendToolAudit(row: { owner: string; connectorId: string; toolSlug: string; runId: string; outcome: string }): void {
    this.db.prepare(`INSERT INTO studio_connector_tool_audit (actor_account_id, connector_id, tool_slug, run_id, outcome, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(row.owner, row.connectorId, row.toolSlug, row.runId, row.outcome, this.now());
  }
}
