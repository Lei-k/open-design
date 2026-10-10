import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { STUDIO_MCP_LIMITS, type StudioMcpAuthMode, type StudioMcpHeaderSummary, type StudioMcpTransport } from '@open-design/contracts';
import { AccountSecretSealer } from './personal-provider-keys.js';

/**
 * Account remote MCP servers (#62, S60; owner decision 2A). Every row belongs
 * to exactly one account; nothing here lists or reads across accounts.
 *
 * - Header values, OAuth tokens, dynamic client registrations and pending
 *   authorizations (PKCE verifier, client secret) are sealed with the
 *   account-secret sealer (same master key and construction as account
 *   OpenAI/Tavily keys). Only header names and a long value's last four
 *   characters are stored in clear.
 * - `instance_id` is new for every creation and `generation` increments
 *   whenever the endpoint identity changes (URL, transport, auth mode): OAuth
 *   tokens, client registrations and pending states are bound to both, so a
 *   credential is never sent to an endpoint it was not issued for, and an
 *   authorization started before the change cannot finish. Disabling cancels
 *   pending authorizations; a disabled server is unusable for any effect.
 * - An OAuth state is a random token whose SHA-256 is stored, bound to the
 *   account, its session, role and pilot revision, the server instance and
 *   generation, and a ten-minute expiry; it is consumed once. Cancellation is
 *   authoritative (it also retires a state an in-flight callback consumed).
 * - The audit is append-only: action, server id and outcome category only.
 * - Nothing a provider returned is stored in clear except an allowlisted,
 *   bounded, secret-scrubbed `scope` (the caller sanitises it with
 *   `untrustedScope`); the authorization-server issuer is kept only as a
 *   SHA-256 lookup key. Raw token / registration responses are never stored.
 *   Secrets are read (decrypted) only by the effect that sends them, after its
 *   final authority check (`openState`, `token`, `headers`).
 */

export const STUDIO_MCP_STATE_TTL_MS = 10 * 60 * 1000;
export const STUDIO_MCP_MAX_PENDING_STATES = 8;
const SEAL_LABEL = 'open-design-account-mcp-v1';

export class StudioMcpStoreError extends Error {
  constructor(readonly kind: 'limit' | 'exists' | 'missing' | 'conflict' | 'invalid') { super(`studio mcp store refused: ${kind}`); }
}

export interface StudioMcpServerRow {
  owner_account_id: string; server_id: string; instance_id: string; generation: number;
  label: string | null; template_id: string | null; transport: StudioMcpTransport; url: string; enabled: number;
  auth_mode: StudioMcpAuthMode; headers_sealed: string | null; header_summary_json: string;
  last_test_json: string | null; revision: number; created_at: number; updated_at: number;
}
export interface StudioMcpServerFields {
  label: string | null; templateId: string | null; transport: StudioMcpTransport; url: string; enabled: boolean;
  authMode: StudioMcpAuthMode;
}
/** The endpoint identity an effect was started under. */
export interface StudioMcpServerBinding { serverId: string; instanceId: string; generation: number }

export interface StudioMcpTokenSecret {
  accessToken: string; refreshToken?: string; tokenType: string;
  tokenEndpoint: string; clientId: string; clientSecret?: string; resource?: string;
}
export interface StudioMcpTokenRow {
  owner_account_id: string; server_id: string; instance_id: string; generation: number; sealed: string;
  scope: string | null; expires_at: number | null; saved_at: number;
}
export interface StudioMcpClientSecret { clientId: string; clientSecret?: string }
export interface StudioMcpPendingSecret {
  codeVerifier: string; clientId: string; clientSecret?: string; tokenEndpoint: string; redirectUri: string; resource?: string; scope?: string;
}
export interface StudioMcpStateBinding extends StudioMcpServerBinding {
  accountId: string; sessionId: string; role: string; studioRevision: number | null; sessionExpiresAt: number;
}
interface StateRow {
  state_hash: string; owner_account_id: string; session_id: string; role: string; studio_revision: number | null; session_expires_at: number;
  server_id: string; instance_id: string; generation: number; pending_sealed: string; expires_at: number; used_at: number | null;
  cancelled: 'state' | 'session' | 'server-changed' | null; completed_at: number | null; created_at: number;
}
export type StudioMcpConsumedState =
  /** Only the non-secret routing facts; the pending secret is opened later with `openState`. */
  | { ok: true; binding: StudioMcpStateBinding; tokenEndpoint: string; requestedScope: string | null }
  | { ok: false; reason: 'state' | 'expired' | 'replayed' | 'session' | 'server-changed' };
export type StudioMcpCompleted<R extends string> = { ok: true } | { ok: false; reason: 'state' | 'expired' | 'replayed' | 'session' | 'server-changed' | R };

const hashState = (token: string) => createHash('sha256').update(`studio-mcp-state:${token}`).digest('hex');
/** Provider-controlled issuer strings are never stored in clear; only this lookup key. */
const issuerKey = (issuer: string) => `sha256:${createHash('sha256').update(`studio-mcp-issuer:${issuer}`).digest('hex')}`;
const STATE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const tailOf = (value: string) => (value.length >= 16 ? value.slice(-4) : '');

export class StudioMcpStore {
  private readonly sealer: AccountSecretSealer;
  constructor(private readonly db: Database.Database, dataRoot: string, private readonly now: () => number = Date.now) {
    this.sealer = new AccountSecretSealer(dataRoot, SEAL_LABEL);
    db.exec(`CREATE TABLE IF NOT EXISTS studio_mcp_servers (
      owner_account_id TEXT NOT NULL, server_id TEXT NOT NULL, instance_id TEXT NOT NULL, generation INTEGER NOT NULL,
      label TEXT, template_id TEXT, transport TEXT NOT NULL CHECK (transport IN ('http','sse')), url TEXT NOT NULL,
      enabled INTEGER NOT NULL CHECK (enabled IN (0,1)), auth_mode TEXT NOT NULL CHECK (auth_mode IN ('none','oauth')),
      headers_sealed TEXT, header_summary_json TEXT NOT NULL DEFAULT '[]', last_test_json TEXT,
      revision INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (owner_account_id, server_id)
    );
    CREATE TABLE IF NOT EXISTS studio_mcp_oauth_tokens (
      owner_account_id TEXT NOT NULL, server_id TEXT NOT NULL, instance_id TEXT NOT NULL, generation INTEGER NOT NULL,
      sealed TEXT NOT NULL, scope TEXT, expires_at INTEGER, saved_at INTEGER NOT NULL,
      PRIMARY KEY (owner_account_id, server_id)
    );
    CREATE TABLE IF NOT EXISTS studio_mcp_oauth_clients (
      owner_account_id TEXT NOT NULL, server_id TEXT NOT NULL, instance_id TEXT NOT NULL, generation INTEGER NOT NULL,
      issuer TEXT NOT NULL, redirect_uri TEXT NOT NULL, sealed TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY (owner_account_id, server_id)
    );
    CREATE TABLE IF NOT EXISTS studio_mcp_oauth_states (
      state_hash TEXT PRIMARY KEY, owner_account_id TEXT NOT NULL, session_id TEXT NOT NULL, role TEXT NOT NULL,
      studio_revision INTEGER, session_expires_at INTEGER NOT NULL, server_id TEXT NOT NULL, instance_id TEXT NOT NULL,
      generation INTEGER NOT NULL, pending_sealed TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER,
      cancelled TEXT CHECK (cancelled IS NULL OR cancelled IN ('state','session','server-changed')), completed_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS studio_mcp_oauth_states_owner ON studio_mcp_oauth_states (owner_account_id, used_at);
    CREATE TABLE IF NOT EXISTS studio_mcp_audit (
      id INTEGER PRIMARY KEY, actor_account_id TEXT NOT NULL, action TEXT NOT NULL, server_id TEXT,
      outcome TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS studio_mcp_audit_immutable BEFORE UPDATE ON studio_mcp_audit
      BEGIN SELECT RAISE(ABORT, 'audit rows are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS studio_mcp_audit_no_delete BEFORE DELETE ON studio_mcp_audit
      BEGIN SELECT RAISE(ABORT, 'audit rows are immutable'); END;`);
  }

  // ---- servers -------------------------------------------------------------------
  list(owner: string): StudioMcpServerRow[] {
    return this.db.prepare('SELECT * FROM studio_mcp_servers WHERE owner_account_id = ? ORDER BY created_at, rowid').all(owner) as StudioMcpServerRow[];
  }
  get(owner: string, serverId: string): StudioMcpServerRow | null {
    return (this.db.prepare('SELECT * FROM studio_mcp_servers WHERE owner_account_id = ? AND server_id = ?').get(owner, serverId) as StudioMcpServerRow | undefined) ?? null;
  }
  /** The row only while it is still the same endpoint identity. */
  bound(owner: string, binding: StudioMcpServerBinding): StudioMcpServerRow | null {
    const row = this.get(owner, binding.serverId);
    return row && row.instance_id === binding.instanceId && row.generation === binding.generation ? row : null;
  }
  headerSummary(row: StudioMcpServerRow): StudioMcpHeaderSummary[] {
    try {
      const parsed = JSON.parse(row.header_summary_json) as Array<{ name: string; tail: string }>;
      return parsed.map((entry) => ({ name: entry.name, configured: true as const, tail: entry.tail }));
    } catch { return []; }
  }
  /** Internal use only (an outbound request the owner started): the decrypted static headers. */
  headers(row: StudioMcpServerRow): Record<string, string> {
    const opened = this.sealer.open(row.owner_account_id, `headers:${row.server_id}:${row.instance_id}`, row.headers_sealed);
    if (!opened) return {};
    try { return JSON.parse(opened) as Record<string, string>; } catch { return {}; }
  }
  private writeHeaders(owner: string, serverId: string, instanceId: string, headers: Record<string, string>) {
    const names = Object.keys(headers).sort((a, b) => a.localeCompare(b));
    if (names.length > STUDIO_MCP_LIMITS.maxHeaders) throw new StudioMcpStoreError('invalid');
    return {
      sealed: names.length ? this.sealer.seal(owner, `headers:${serverId}:${instanceId}`, JSON.stringify(Object.fromEntries(names.map((name) => [name, headers[name]!])))) : null,
      summary: JSON.stringify(names.map((name) => ({ name, tail: tailOf(headers[name]!) }))),
    };
  }
  /** `authorize` runs inside the write transaction immediately before the write and throws to refuse. */
  create(owner: string, serverId: string, fields: StudioMcpServerFields, headers: Record<string, string>, authorize: () => void): StudioMcpServerRow {
    return this.db.transaction(() => {
      authorize();
      if (this.get(owner, serverId)) throw new StudioMcpStoreError('exists');
      const count = (this.db.prepare('SELECT COUNT(*) AS n FROM studio_mcp_servers WHERE owner_account_id = ?').get(owner) as { n: number }).n;
      if (count >= STUDIO_MCP_LIMITS.maxServers) throw new StudioMcpStoreError('limit');
      const instanceId = randomUUID();
      const written = this.writeHeaders(owner, serverId, instanceId, headers);
      const at = this.now();
      this.db.prepare(`INSERT INTO studio_mcp_servers (owner_account_id, server_id, instance_id, generation, label, template_id, transport, url, enabled,
        auth_mode, headers_sealed, header_summary_json, last_test_json, revision, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?)`)
        .run(owner, serverId, instanceId, fields.label, fields.templateId, fields.transport, fields.url, fields.enabled ? 1 : 0, fields.authMode,
          written.sealed, written.summary, at, at);
      this.audit(owner, 'server_create', serverId, 'ok');
      return this.get(owner, serverId)!;
    }).immediate();
  }
  /**
   * Revision-checked update. `headers` maps a name to a new value, or to null to
   * remove it; absent names are kept. A change of URL, transport or auth mode
   * starts a new generation: its OAuth token and client registration are
   * deleted and pending authorizations cancelled in the same transaction.
   * Disabling cancels pending authorizations.
   */
  update(owner: string, serverId: string, revision: number | null, patch: Partial<StudioMcpServerFields>,
    headers: Record<string, string | null>, authorize: () => void): { row: StudioMcpServerRow; generationChanged: boolean } {
    return this.db.transaction(() => {
      authorize();
      const row = this.get(owner, serverId);
      if (!row) throw new StudioMcpStoreError('missing');
      if (revision !== null && row.revision !== revision) throw new StudioMcpStoreError('conflict');
      const next = {
        label: patch.label !== undefined ? patch.label : row.label,
        templateId: patch.templateId !== undefined ? patch.templateId : row.template_id,
        transport: patch.transport ?? row.transport, url: patch.url ?? row.url,
        enabled: patch.enabled ?? row.enabled === 1, authMode: patch.authMode ?? row.auth_mode,
      };
      const generationChanged = next.url !== row.url || next.transport !== row.transport || next.authMode !== row.auth_mode;
      const disabling = row.enabled === 1 && !next.enabled;
      const merged = this.headers(row);
      for (const [name, value] of Object.entries(headers)) {
        const existing = Object.keys(merged).find((key) => key.toLowerCase() === name.toLowerCase());
        if (existing) delete merged[existing];
        if (value !== null) merged[name] = value;
      }
      const written = this.writeHeaders(owner, serverId, row.instance_id, merged);
      const generation = row.generation + (generationChanged ? 1 : 0);
      this.db.prepare(`UPDATE studio_mcp_servers SET generation = ?, label = ?, template_id = ?, transport = ?, url = ?, enabled = ?, auth_mode = ?,
        headers_sealed = ?, header_summary_json = ?, last_test_json = CASE WHEN ? THEN NULL ELSE last_test_json END, revision = ?, updated_at = ?
        WHERE owner_account_id = ? AND server_id = ?`).run(generation, next.label, next.templateId, next.transport, next.url, next.enabled ? 1 : 0,
        next.authMode, written.sealed, written.summary, generationChanged ? 1 : 0, row.revision + 1, this.now(), owner, serverId);
      if (generationChanged) this.retireCredentials(owner, serverId);
      // A disabled server keeps its token for a later re-enable, but no authorization started before can finish.
      else if (disabling) this.cancelStatesFor(owner, serverId, 'server-changed');
      this.audit(owner, 'server_update', serverId, generationChanged ? 'endpoint-changed' : disabling ? 'disabled' : 'ok');
      return { row: this.get(owner, serverId)!, generationChanged };
    }).immediate();
  }
  remove(owner: string, serverId: string, authorize: () => void): boolean {
    return this.db.transaction(() => {
      authorize();
      if (!this.get(owner, serverId)) return false;
      this.db.prepare('DELETE FROM studio_mcp_servers WHERE owner_account_id = ? AND server_id = ?').run(owner, serverId);
      this.retireCredentials(owner, serverId);
      this.audit(owner, 'server_delete', serverId, 'ok');
      return true;
    }).immediate();
  }
  private retireCredentials(owner: string, serverId: string): void {
    this.db.prepare('DELETE FROM studio_mcp_oauth_tokens WHERE owner_account_id = ? AND server_id = ?').run(owner, serverId);
    this.db.prepare('DELETE FROM studio_mcp_oauth_clients WHERE owner_account_id = ? AND server_id = ?').run(owner, serverId);
    this.cancelStatesFor(owner, serverId, 'server-changed');
  }
  recordTest(owner: string, binding: StudioMcpServerBinding, result: { ok: boolean; code: string | null }): void {
    this.db.prepare(`UPDATE studio_mcp_servers SET last_test_json = ? WHERE owner_account_id = ? AND server_id = ? AND instance_id = ? AND generation = ?`)
      .run(JSON.stringify({ ok: result.ok, at: this.now(), code: result.code }), owner, binding.serverId, binding.instanceId, binding.generation);
  }

  // ---- OAuth tokens and client registrations ----------------------------------------
  token(owner: string, binding: StudioMcpServerBinding): { row: StudioMcpTokenRow; secret: StudioMcpTokenSecret } | null {
    const row = this.db.prepare('SELECT * FROM studio_mcp_oauth_tokens WHERE owner_account_id = ? AND server_id = ? AND instance_id = ? AND generation = ?')
      .get(owner, binding.serverId, binding.instanceId, binding.generation) as StudioMcpTokenRow | undefined;
    if (!row) return null;
    const opened = this.sealer.open(owner, `token:${binding.serverId}:${binding.instanceId}:${binding.generation}`, row.sealed);
    if (!opened) return null;
    try { return { row, secret: JSON.parse(opened) as StudioMcpTokenSecret }; } catch { return null; }
  }
  /** Routing facts for a refresh without keeping any secret: endpoint, refreshability and the token version. */
  tokenEndpoint(owner: string, binding: StudioMcpServerBinding): { tokenEndpoint: string; refreshable: boolean; savedAt: number } | null {
    const current = this.token(owner, binding);
    return current ? { tokenEndpoint: current.secret.tokenEndpoint, refreshable: Boolean(current.secret.refreshToken), savedAt: current.row.saved_at } : null;
  }
  /**
   * Every secret this account holds for the server — static header values, the
   * OAuth access/refresh token and client secret, the registered client secret —
   * for scrubbing provider-returned metadata. Returned structured so the route can
   * derive every representation the outbound layer emits from it
   * (`studioMcpOutboundCredentials`). Never returned to a client.
   */
  secretMaterial(owner: string, serverId: string): { headers: Record<string, string>; token: StudioMcpTokenSecret | null; client: StudioMcpClientSecret | null } {
    const row = this.get(owner, serverId);
    const material: { headers: Record<string, string>; token: StudioMcpTokenSecret | null; client: StudioMcpClientSecret | null } = {
      headers: row ? this.headers(row) : {}, token: null, client: null };
    const token = this.db.prepare('SELECT * FROM studio_mcp_oauth_tokens WHERE owner_account_id = ? AND server_id = ?').get(owner, serverId) as StudioMcpTokenRow | undefined;
    if (token) {
      const opened = this.sealer.open(owner, `token:${serverId}:${token.instance_id}:${token.generation}`, token.sealed);
      try { material.token = opened ? JSON.parse(opened) as StudioMcpTokenSecret : null; } catch { /* unreadable: nothing to add */ }
    }
    const client = this.db.prepare('SELECT * FROM studio_mcp_oauth_clients WHERE owner_account_id = ? AND server_id = ?').get(owner, serverId) as
      { instance_id: string; generation: number; sealed: string } | undefined;
    if (client) {
      const opened = this.sealer.open(owner, `client:${serverId}:${client.instance_id}:${client.generation}`, client.sealed);
      try { material.client = opened ? JSON.parse(opened) as StudioMcpClientSecret : null; } catch { /* ignore */ }
    }
    return material;
  }
  tokenMeta(owner: string, serverId: string): StudioMcpTokenRow | null {
    return (this.db.prepare('SELECT * FROM studio_mcp_oauth_tokens WHERE owner_account_id = ? AND server_id = ?').get(owner, serverId) as StudioMcpTokenRow | undefined) ?? null;
  }
  /** Save (or replace) the token; `recheck` runs in the same transaction and returns a refusal reason to abort. */
  saveToken<R extends string>(owner: string, binding: StudioMcpServerBinding, secret: StudioMcpTokenSecret, meta: { scope: string | null; expiresAt: number | null },
    recheck: () => R | null, expectedSavedAt?: number): R | 'replaced' | null {
    return this.db.transaction((): R | 'replaced' | null => {
      const refused = recheck();
      if (refused) return refused;
      if (expectedSavedAt !== undefined && this.token(owner, binding)?.row.saved_at !== expectedSavedAt) return 'replaced';
      this.writeToken(owner, binding, secret, meta);
      return null;
    }).immediate();
  }
  private writeToken(owner: string, binding: StudioMcpServerBinding, secret: StudioMcpTokenSecret, meta: { scope: string | null; expiresAt: number | null }): void {
    this.db.prepare(`INSERT INTO studio_mcp_oauth_tokens (owner_account_id, server_id, instance_id, generation, sealed, scope, expires_at, saved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(owner_account_id, server_id) DO UPDATE SET instance_id = excluded.instance_id,
      generation = excluded.generation, sealed = excluded.sealed, scope = excluded.scope, expires_at = excluded.expires_at, saved_at = excluded.saved_at`)
      .run(owner, binding.serverId, binding.instanceId, binding.generation,
        this.sealer.seal(owner, `token:${binding.serverId}:${binding.instanceId}:${binding.generation}`, JSON.stringify(secret)),
        meta.scope?.slice(0, 1024) ?? null, meta.expiresAt, this.now());
  }
  clearToken(owner: string, serverId: string, authorize: () => void): boolean {
    return this.db.transaction(() => {
      authorize();
      const changes = this.db.prepare('DELETE FROM studio_mcp_oauth_tokens WHERE owner_account_id = ? AND server_id = ?').run(owner, serverId).changes;
      return changes > 0;
    }).immediate();
  }
  client(owner: string, binding: StudioMcpServerBinding, issuer: string, redirectUri: string): StudioMcpClientSecret | null {
    const row = this.db.prepare(`SELECT sealed FROM studio_mcp_oauth_clients WHERE owner_account_id = ? AND server_id = ? AND instance_id = ?
      AND generation = ? AND issuer = ? AND redirect_uri = ?`).get(owner, binding.serverId, binding.instanceId, binding.generation, issuerKey(issuer), redirectUri) as { sealed: string } | undefined;
    const opened = this.sealer.open(owner, `client:${binding.serverId}:${binding.instanceId}:${binding.generation}`, row?.sealed);
    if (!opened) return null;
    try { return JSON.parse(opened) as StudioMcpClientSecret; } catch { return null; }
  }
  saveClient(owner: string, binding: StudioMcpServerBinding, issuer: string, redirectUri: string, secret: StudioMcpClientSecret): void {
    this.db.prepare(`INSERT INTO studio_mcp_oauth_clients (owner_account_id, server_id, instance_id, generation, issuer, redirect_uri, sealed, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(owner_account_id, server_id) DO UPDATE SET instance_id = excluded.instance_id, generation = excluded.generation,
      issuer = excluded.issuer, redirect_uri = excluded.redirect_uri, sealed = excluded.sealed, created_at = excluded.created_at`)
      .run(owner, binding.serverId, binding.instanceId, binding.generation, issuerKey(issuer), redirectUri,
        this.sealer.seal(owner, `client:${binding.serverId}:${binding.instanceId}:${binding.generation}`, JSON.stringify(secret)), this.now());
  }

  // ---- single-use OAuth states ---------------------------------------------------------
  createState(binding: StudioMcpStateBinding, pending: StudioMcpPendingSecret): { token: string; expiresAt: number } {
    const token = randomBytes(32).toString('base64url');
    const at = this.now();
    const expiresAt = at + STUDIO_MCP_STATE_TTL_MS;
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM studio_mcp_oauth_states WHERE expires_at < ? OR used_at IS NOT NULL AND used_at < ?').run(at - STUDIO_MCP_STATE_TTL_MS, at - STUDIO_MCP_STATE_TTL_MS);
      const open = this.db.prepare('SELECT state_hash FROM studio_mcp_oauth_states WHERE owner_account_id = ? AND used_at IS NULL ORDER BY created_at, rowid')
        .all(binding.accountId) as Array<{ state_hash: string }>;
      for (const stale of open.slice(0, Math.max(0, open.length - STUDIO_MCP_MAX_PENDING_STATES + 1))) {
        this.db.prepare("UPDATE studio_mcp_oauth_states SET used_at = ?, cancelled = 'state' WHERE state_hash = ?").run(at, stale.state_hash);
      }
      this.db.prepare(`INSERT INTO studio_mcp_oauth_states (state_hash, owner_account_id, session_id, role, studio_revision, session_expires_at, server_id,
        instance_id, generation, pending_sealed, expires_at, used_at, cancelled, completed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`)
        .run(hashState(token), binding.accountId, binding.sessionId, binding.role, binding.studioRevision, binding.sessionExpiresAt, binding.serverId,
          binding.instanceId, binding.generation, this.sealer.seal(binding.accountId, `state:${hashState(token)}`, JSON.stringify(pending)), expiresAt, at);
    })();
    return { token, expiresAt };
  }
  /** Single use: the first callback consumes the state whatever the outcome of the checks that follow. */
  consumeState(token: unknown): StudioMcpConsumedState {
    if (typeof token !== 'string' || !STATE_TOKEN.test(token)) return { ok: false, reason: 'state' };
    const at = this.now();
    return this.db.transaction((): StudioMcpConsumedState => {
      const row = this.db.prepare('SELECT * FROM studio_mcp_oauth_states WHERE state_hash = ?').get(hashState(token)) as StateRow | undefined;
      if (!row) return { ok: false, reason: 'state' };
      if (row.cancelled !== null) return { ok: false, reason: row.cancelled };
      if (row.used_at !== null) return { ok: false, reason: 'replayed' };
      this.db.prepare('UPDATE studio_mcp_oauth_states SET used_at = ? WHERE state_hash = ?').run(at, row.state_hash);
      if (row.expires_at <= at) return { ok: false, reason: 'expired' };
      const pending = this.openPending(row);
      if (!pending) return { ok: false, reason: 'state' };
      return { ok: true, tokenEndpoint: pending.tokenEndpoint, requestedScope: pending.scope ?? null, binding: { accountId: row.owner_account_id, sessionId: row.session_id, role: row.role,
        studioRevision: row.studio_revision, sessionExpiresAt: row.session_expires_at, serverId: row.server_id, instanceId: row.instance_id, generation: row.generation } };
    }).immediate();
  }
  private openPending(row: StateRow): StudioMcpPendingSecret | null {
    const opened = this.sealer.open(row.owner_account_id, `state:${row.state_hash}`, row.pending_sealed);
    if (!opened) return null;
    try { return JSON.parse(opened) as StudioMcpPendingSecret; } catch { return null; }
  }
  private liveStateRow(token: string, binding: StudioMcpStateBinding): StateRow | null {
    const row = this.db.prepare('SELECT * FROM studio_mcp_oauth_states WHERE state_hash = ?').get(hashState(token)) as StateRow | undefined;
    if (!row || row.owner_account_id !== binding.accountId || row.server_id !== binding.serverId || row.instance_id !== binding.instanceId
      || row.generation !== binding.generation || row.used_at === null || row.cancelled !== null || row.completed_at !== null || row.expires_at <= this.now()) return null;
    return row;
  }
  /** A consumed state is still live (not cancelled, completed or expired) for its callback. */
  stateLive(token: string, binding: StudioMcpStateBinding): boolean { return this.liveStateRow(token, binding) !== null; }
  /** The pending secret of a consumed, still-live state — opened only by the effect that sends it. */
  openState(token: string, binding: StudioMcpStateBinding): StudioMcpPendingSecret | null {
    const row = this.liveStateRow(token, binding);
    return row ? this.openPending(row) : null;
  }
  /**
   * Store the account's token for a consumed state, in one transaction that
   * re-reads the state (refusing it if cancelled, expired or already
   * completed) and runs `recheck` (account, session, server identity) first.
   */
  completeState<R extends string>(token: string, binding: StudioMcpStateBinding, secret: StudioMcpTokenSecret, meta: { scope: string | null; expiresAt: number | null },
    recheck: () => R | null): StudioMcpCompleted<R> {
    const at = this.now();
    return this.db.transaction((): StudioMcpCompleted<R> => {
      const row = this.db.prepare('SELECT * FROM studio_mcp_oauth_states WHERE state_hash = ?').get(hashState(token)) as StateRow | undefined;
      if (!row || row.owner_account_id !== binding.accountId || row.server_id !== binding.serverId || row.used_at === null) return { ok: false, reason: 'state' };
      if (row.cancelled !== null) return { ok: false, reason: row.cancelled };
      if (row.completed_at !== null) return { ok: false, reason: 'replayed' };
      if (row.expires_at <= at) return { ok: false, reason: 'expired' };
      const refused = recheck();
      if (refused) return { ok: false, reason: refused };
      this.writeToken(binding.accountId, binding, secret, meta);
      this.db.prepare('UPDATE studio_mcp_oauth_states SET completed_at = ? WHERE state_hash = ?').run(at, row.state_hash);
      return { ok: true };
    }).immediate();
  }
  discardState(token: string): void {
    this.db.prepare("UPDATE studio_mcp_oauth_states SET used_at = ?, cancelled = 'state' WHERE state_hash = ? AND used_at IS NULL").run(this.now(), hashState(token));
  }
  /** The user cancelled one server's authorization, or every one the account holds died with its session. */
  cancelStates(owner: string, serverId?: string): number {
    return this.cancelStatesFor(owner, serverId, serverId === undefined ? 'session' : 'state');
  }
  private cancelStatesFor(owner: string, serverId: string | undefined, reason: 'state' | 'session' | 'server-changed'): number {
    const at = this.now();
    return this.db.prepare(`UPDATE studio_mcp_oauth_states SET used_at = COALESCE(used_at, ?), cancelled = ?
      WHERE owner_account_id = ? AND cancelled IS NULL AND completed_at IS NULL AND expires_at > ?
      ${serverId === undefined ? '' : 'AND server_id = ?'}`).run(at, reason, owner, at, ...(serverId === undefined ? [] : [serverId])).changes;
  }
  pendingCount(owner: string, serverId: string): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM studio_mcp_oauth_states WHERE owner_account_id = ? AND server_id = ? AND used_at IS NULL AND expires_at > ?`)
      .get(owner, serverId, this.now()) as { n: number }).n;
  }

  audit(actor: string, action: string, serverId: string | null, outcome: string): void {
    this.db.prepare('INSERT INTO studio_mcp_audit (actor_account_id, action, server_id, outcome, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(actor, action, serverId, outcome, this.now());
  }
}
