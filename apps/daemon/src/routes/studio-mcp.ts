import { randomBytes } from 'node:crypto';
import net from 'node:net';
import type Database from 'better-sqlite3';
import type { Express, Request, Response } from 'express';
import {
  STUDIO_MCP_FORBIDDEN_HEADERS, STUDIO_MCP_HEADER_NAME_PATTERN, STUDIO_MCP_LIMITS, STUDIO_MCP_NOT_IN_RUNS_REASON, STUDIO_MCP_SERVER_ID_PATTERN,
  STUDIO_MCP_STDIO_UNAVAILABLE_REASON,
  type ImportStudioMcpServersResponse, type StudioMcpAuthMode, type StudioMcpAuthorityRefusal, type StudioMcpCallbackRefusal, type StudioMcpOAuthStartResponse,
  type StudioMcpOAuthState, type StudioMcpOAuthStatusResponse, type StudioMcpServer, type StudioMcpServerResponse, type StudioMcpServersResponse,
  type StudioMcpTestResponse, type StudioMcpTransport,
} from '@open-design/contracts';
import { sendApiError } from '../http/api-errors.js';
import { multiUserActorOf } from '../http/multiuser-gate.js';
import { createSafeOutboundFetch, isPublicUnicastAddress, OutboundRequestRefused, type OutboundRefusalReason, type SafeOutboundOptions } from '../http/safe-outbound-fetch.js';
import { MCP_TEMPLATES } from '../mcp-config.js';
import {
  asFetch, discoverStudioMcpAuthorization, exchangeStudioMcpCode, probeStudioMcpServer, refreshStudioMcpToken, registerStudioMcpClient,
  newStudioMcpCodeVerifier, StudioMcpRemoteError, studioMcpAuthorizeUrl,
} from '../mcp-client/studio-remote.js';
import type { AuthActor } from '../services/auth-service.js';
import { StudioMcpStore, StudioMcpStoreError, type StudioMcpServerBinding, type StudioMcpServerFields, type StudioMcpServerRow, type StudioMcpStateBinding } from '../storage/studio-mcp.js';

export interface RegisterStudioMcpRoutesDeps {
  db: Database.Database;
  dataRoot: string;
  /** The deployment's public app origin; the OAuth callback returns there. */
  publicOrigin: string;
  sessionCurrent: (snapshot: AuthActor) => boolean;
  accountActive: (accountId: string) => boolean;
  /** Test-only resolver/address injection for the outbound guard; deployment config cannot supply it. */
  outbound?: Pick<SafeOutboundOptions, 'resolve' | 'allowAddress' | 'timeoutMs'>;
  clock?: () => number;
}

export interface StudioMcp {
  /** Session revoke, password reset, disable, logout: pending authorizations of the account die now. */
  invalidateAccount(accountId: string): void;
}

class McpAuthorityError extends Error {
  constructor(readonly reason: StudioMcpAuthorityRefusal) { super(`mcp authority changed: ${reason}`); }
}
class McpInputError extends Error {
  constructor(readonly kind: 'invalid' | 'stdio' | 'outbound', readonly reason?: OutboundRefusalReason) { super(`mcp input refused: ${kind}`); }
}

/** What an effect was started under; it must still hold when the effect runs. */
interface McpAuthority { actor: AuthActor; server?: StudioMcpServerBinding }

const REMOTE_TEMPLATES = MCP_TEMPLATES.filter((template) => template.transport !== 'stdio');
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const STDIO_FIELDS = ['command', 'args', 'env', 'cwd'];

/**
 * Account remote MCP servers for Web accounts (#62, S60; owner decision 2A).
 * The standard `/api/mcp/servers` and `/api/mcp/oauth/*` routes reach these
 * through reviewed gate aliases; the host `mcp-config.json`, host token store,
 * host client cache and Codex install never run for a cookie actor. stdio is
 * refused with `MULTIUSER_CAPABILITY_UNAVAILABLE` everywhere.
 */
export function registerStudioMcpRoutes(app: Express, deps: RegisterStudioMcpRoutesDeps): StudioMcp {
  const now = deps.clock ?? Date.now;
  const store = new StudioMcpStore(deps.db, deps.dataRoot, now);
  const safe = createSafeOutboundFetch({ ...(deps.outbound ?? {}) });
  const redirectUri = `${deps.publicOrigin}/api/mcp/oauth/callback`;
  const noStore = (res: Response) => res.setHeader('Cache-Control', 'no-store');

  /**
   * Invariant (S58 pattern): authority is re-established synchronously
   * immediately before every outbound request and every local mutation — the
   * account is active, the session is still its live current session (same
   * role and pilot revision), and, where the effect acts on a server, that
   * server is still the same instance and endpoint generation and enabled.
   * Any change refuses with `MULTIUSER_MCP_AUTHORITY_CHANGED`: nothing further
   * is sent and nothing changes locally.
   */
  const authorityRefusal = (expected: McpAuthority): StudioMcpAuthorityRefusal | null => {
    if (!deps.accountActive(expected.actor.accountId)) return 'account';
    if (!deps.sessionCurrent(expected.actor)) return 'session';
    if (expected.server) {
      const row = store.bound(expected.actor.accountId, expected.server);
      if (!row || row.enabled !== 1) return 'server-changed';
    }
    return null;
  };
  const assertAuthority = (expected: McpAuthority) => {
    const refused = authorityRefusal(expected);
    if (refused) throw new McpAuthorityError(refused);
  };
  const authorityChanged = (res: Response, actor: string, action: string, serverId: string | null, reason: StudioMcpAuthorityRefusal) => {
    store.audit(actor, `${action}_refused`, serverId, reason);
    return sendApiError(res, 409, 'MULTIUSER_MCP_AUTHORITY_CHANGED',
      'the account, session or MCP server changed while this request ran; further effects were refused', { details: { reason } });
  };
  const notFound = (res: Response) => sendApiError(res, 404, 'NOT_FOUND', 'MCP server not found');
  const stdioRefused = (res: Response, actor: string, action: string) => {
    store.audit(actor, `${action}_refused`, null, 'stdio');
    return sendApiError(res, 403, 'MULTIUSER_CAPABILITY_UNAVAILABLE', STUDIO_MCP_STDIO_UNAVAILABLE_REASON,
      { details: { capability: 'mcp-stdio', reason: STUDIO_MCP_STDIO_UNAVAILABLE_REASON } });
  };
  const outboundRefused = (res: Response, actor: string, action: string, serverId: string | null, reason: OutboundRefusalReason) => {
    store.audit(actor, `${action}_refused`, serverId, `outbound:${reason}`);
    return sendApiError(res, 400, 'MULTIUSER_MCP_OUTBOUND_REFUSED', 'this MCP server address is not allowed or not reachable from this deployment',
      { details: { reason } });
  };
  /** A failed effect: an authority change outranks whatever raced it; then guard refusals; then a fixed provider failure. */
  const effectFailed = (res: Response, error: unknown, authority: McpAuthority, action: string, serverId: string | null, refusals: OutboundRefusalReason[] = []) => {
    const reason = error instanceof McpAuthorityError ? error.reason : authorityRefusal(authority);
    if (reason) return authorityChanged(res, authority.actor.accountId, action, serverId, reason);
    const blocked = error instanceof OutboundRequestRefused ? error.reason : refusals[0];
    if (blocked) return outboundRefused(res, authority.actor.accountId, action, serverId, blocked);
    const code = error instanceof StudioMcpRemoteError ? error.code : 'failed';
    console.error(`[Studio] MULTIUSER_MCP_PROVIDER_FAILED: ${action} ${code}`);
    store.audit(authority.actor.accountId, `${action}_failed`, serverId, code);
    return sendApiError(res, 502, 'MULTIUSER_MCP_PROVIDER_FAILED', 'the MCP server or its authorization server did not complete the request', { details: { reason: code } });
  };

  const oauthState = (row: StudioMcpServerRow): { status: StudioMcpOAuthState; expiresAt: number | null; scope: string | null; connectedAt: number | null } => {
    if (row.auth_mode !== 'oauth') return { status: 'not-required', expiresAt: null, scope: null, connectedAt: null };
    const token = store.tokenMeta(row.owner_account_id, row.server_id);
    if (!token || token.instance_id !== row.instance_id || token.generation !== row.generation) return { status: 'needs-auth', expiresAt: null, scope: null, connectedAt: null };
    return { status: token.expires_at !== null && token.expires_at <= now() ? 'expired' : 'connected', expiresAt: token.expires_at, scope: token.scope, connectedAt: token.saved_at };
  };
  const dto = (row: StudioMcpServerRow): StudioMcpServer => {
    let lastTest: StudioMcpServer['lastTest'] = null;
    try { lastTest = row.last_test_json ? JSON.parse(row.last_test_json) as StudioMcpServer['lastTest'] : null; } catch { lastTest = null; }
    return { id: row.server_id, label: row.label, templateId: row.template_id, transport: row.transport, url: row.url, enabled: row.enabled === 1,
      authMode: row.auth_mode, headers: store.headerSummary(row), oauth: oauthState(row), lastTest, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at };
  };
  const listResponse = (owner: string): StudioMcpServersResponse => ({ servers: store.list(owner).map(dto), templates: REMOTE_TEMPLATES, limits: STUDIO_MCP_LIMITS,
    stdio: { available: false, reason: STUDIO_MCP_STDIO_UNAVAILABLE_REASON }, runs: { available: false, reason: STUDIO_MCP_NOT_IN_RUNS_REASON } });
  const binding = (row: StudioMcpServerRow): StudioMcpServerBinding => ({ serverId: row.server_id, instanceId: row.instance_id, generation: row.generation });

  // ---- input validation: fixed messages, never echoing a value ----------------------
  const hasStdio = (body: Record<string, unknown>) => body.transport === 'stdio' || STDIO_FIELDS.some((key) => body[key] !== undefined);
  const transportOf = (value: unknown, fallback?: StudioMcpTransport): StudioMcpTransport => {
    if (value === undefined && fallback) return fallback;
    if (value === 'http' || value === 'streamable-http') return 'http';
    if (value === 'sse') return 'sse';
    throw new McpInputError('invalid');
  };
  const urlOf = (value: unknown): string => {
    if (typeof value !== 'string' || !value.trim() || value.length > STUDIO_MCP_LIMITS.maxUrlLength) throw new McpInputError('invalid');
    let parsed: URL;
    try { parsed = new URL(value.trim()); } catch { throw new McpInputError('invalid'); }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new McpInputError('outbound', 'scheme');
    if (parsed.username || parsed.password) throw new McpInputError('outbound', 'credentials');
    const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    // Early, syntactic refusal; every request is still re-vetted after DNS resolution.
    if (host === 'localhost' || host.endsWith('.localhost') || (net.isIP(host) && !isPublicUnicastAddress(host) && !deps.outbound?.allowAddress?.(host))) {
      throw new McpInputError('outbound', 'address');
    }
    parsed.hash = '';
    return parsed.toString();
  };
  const labelOf = (value: unknown): string | null => {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || value.length > STUDIO_MCP_LIMITS.maxLabelLength || /[\0\r\n]/.test(value)) throw new McpInputError('invalid');
    return value.trim() || null;
  };
  const templateOf = (value: unknown): string | null => {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string' || !REMOTE_TEMPLATES.some((template) => template.id === value)) throw new McpInputError('invalid');
    return value;
  };
  const authModeOf = (value: unknown, fallback: StudioMcpAuthMode): StudioMcpAuthMode => {
    if (value === undefined) return fallback;
    if (value === 'none' || value === 'oauth') return value;
    throw new McpInputError('invalid');
  };
  const headersOf = (value: unknown, allowNull: boolean): Record<string, string | null> => {
    if (value === undefined) return {};
    if (!isRecord(value) || Object.keys(value).length > STUDIO_MCP_LIMITS.maxHeaders) throw new McpInputError('invalid');
    const out: Record<string, string | null> = {};
    const seen = new Set<string>();
    for (const [name, raw] of Object.entries(value)) {
      const lower = name.toLowerCase();
      if (!STUDIO_MCP_HEADER_NAME_PATTERN.test(name) || STUDIO_MCP_FORBIDDEN_HEADERS.includes(lower) || seen.has(lower)) throw new McpInputError('invalid');
      seen.add(lower);
      if (raw === null && allowNull) { out[name] = null; continue; }
      if (typeof raw !== 'string' || !raw.trim() || raw.length > STUDIO_MCP_LIMITS.maxHeaderValueLength || /[\0\r\n]/.test(raw)) throw new McpInputError('invalid');
      out[name] = raw;
    }
    return out;
  };
  const createFields = (body: Record<string, unknown>): { id: string; fields: StudioMcpServerFields; headers: Record<string, string> } => {
    if (Object.keys(body).some((key) => !['id', 'url', 'transport', 'label', 'templateId', 'enabled', 'authMode', 'headers'].includes(key))) throw new McpInputError('invalid');
    if (typeof body.id !== 'string' || !STUDIO_MCP_SERVER_ID_PATTERN.test(body.id)) throw new McpInputError('invalid');
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw new McpInputError('invalid');
    const url = urlOf(body.url);
    return { id: body.id, headers: headersOf(body.headers, false) as Record<string, string>, fields: {
      url, transport: transportOf(body.transport, 'http'), label: labelOf(body.label), templateId: templateOf(body.templateId),
      enabled: body.enabled !== false, authMode: authModeOf(body.authMode, 'none') } };
  };
  const inputFailed = (res: Response, error: unknown, actor: string, action: string) => {
    if (error instanceof McpInputError && error.kind === 'outbound') return outboundRefused(res, actor, action, null, error.reason ?? 'address');
    if (error instanceof McpInputError && error.kind === 'stdio') return stdioRefused(res, actor, action);
    return sendApiError(res, 400, 'VALIDATION_FAILED', 'invalid MCP server settings');
  };
  const storeFailed = (res: Response, error: unknown, actor: AuthActor, action: string, serverId: string | null) => {
    if (error instanceof McpAuthorityError) return authorityChanged(res, actor.accountId, action, serverId, error.reason);
    if (error instanceof StudioMcpStoreError) {
      if (error.kind === 'limit') return sendApiError(res, 409, 'MULTIUSER_MCP_LIMIT_REACHED', `an account can keep at most ${STUDIO_MCP_LIMITS.maxServers} MCP servers`);
      if (error.kind === 'exists') return sendApiError(res, 409, 'CONFLICT', 'an MCP server with this id already exists');
      if (error.kind === 'conflict') return sendApiError(res, 409, 'CONFLICT', 'the MCP server changed; reload before saving');
      if (error.kind === 'missing') return notFound(res);
      return sendApiError(res, 400, 'VALIDATION_FAILED', 'invalid MCP server settings');
    }
    if (error instanceof McpInputError) return inputFailed(res, error, actor.accountId, action);
    console.error(`[Studio] MCP ${action} failed`);
    return sendApiError(res, 500, 'INTERNAL_ERROR', 'MCP server request failed');
  };
  const actorOf = (res: Response) => multiUserActorOf(res);
  const unauthorized = (res: Response) => sendApiError(res, 401, 'UNAUTHORIZED', 'authentication required');
  /** The actor's own row; another account's server is identical to a missing one. */
  const ownedRow = (actor: AuthActor, serverId: unknown) => typeof serverId === 'string' && STUDIO_MCP_SERVER_ID_PATTERN.test(serverId) ? store.get(actor.accountId, serverId) : null;

  // ---- servers ----------------------------------------------------------------------
  app.get('/api/multiuser/mcp/servers', (_req, res) => {
    const actor = actorOf(res);
    if (!actor) return unauthorized(res);
    noStore(res);
    res.json(listResponse(actor.accountId));
  });
  app.post('/api/multiuser/mcp/servers', (req, res) => {
    const actor = actorOf(res);
    if (!actor) return unauthorized(res);
    const body = isRecord(req.body) ? req.body : {};
    if (hasStdio(body)) return stdioRefused(res, actor.accountId, 'server_create');
    let input: ReturnType<typeof createFields>;
    try { input = createFields(body); } catch (error) { return inputFailed(res, error, actor.accountId, 'server_create'); }
    try {
      const row = store.create(actor.accountId, input.id, input.fields, input.headers, () => assertAuthority({ actor }));
      noStore(res);
      res.status(201).json({ server: dto(row) } satisfies StudioMcpServerResponse);
    } catch (error) { return storeFailed(res, error, actor, 'server_create', input.id); }
  });
  // Import: the desktop `PUT /api/mcp/servers` body, upserting the listed remote servers for the actor.
  app.put('/api/multiuser/mcp/servers', (req, res) => {
    const actor = actorOf(res);
    if (!actor) return unauthorized(res);
    const list = isRecord(req.body) && Array.isArray(req.body.servers) ? req.body.servers : null;
    if (!list || list.length > STUDIO_MCP_LIMITS.maxServers || list.some((entry) => !isRecord(entry))) return sendApiError(res, 400, 'VALIDATION_FAILED', 'invalid MCP server import');
    const entries = list as Record<string, unknown>[];
    // A desktop entry without a transport is stdio there; any stdio entry refuses the whole import.
    if (entries.some((entry) => entry.transport === undefined || hasStdio(entry))) return stdioRefused(res, actor.accountId, 'server_import');
    let parsed: Array<ReturnType<typeof createFields>>;
    try {
      parsed = entries.map((entry) => createFields({ id: entry.id, url: entry.url, transport: entry.transport,
        ...(entry.label !== undefined ? { label: entry.label } : {}), ...(entry.templateId !== undefined ? { templateId: entry.templateId } : {}),
        ...(entry.enabled !== undefined ? { enabled: entry.enabled } : {}),
        ...(entry.authMode !== undefined ? { authMode: entry.authMode } : {}), ...(entry.headers !== undefined ? { headers: entry.headers } : {}) }));
      if (new Set(parsed.map((entry) => entry.id)).size !== parsed.length) throw new McpInputError('invalid');
    } catch (error) { return inputFailed(res, error, actor.accountId, 'server_import'); }
    try {
      deps.db.transaction(() => {
        for (const entry of parsed) {
          if (store.get(actor.accountId, entry.id)) store.update(actor.accountId, entry.id, null, entry.fields, entry.headers, () => assertAuthority({ actor }));
          else store.create(actor.accountId, entry.id, entry.fields, entry.headers, () => assertAuthority({ actor }));
        }
      }).immediate();
      store.audit(actor.accountId, 'server_import', null, String(parsed.length));
      noStore(res);
      res.json({ ...listResponse(actor.accountId), imported: parsed.map((entry) => entry.id) } satisfies ImportStudioMcpServersResponse);
    } catch (error) { return storeFailed(res, error, actor, 'server_import', null); }
  });
  app.patch('/api/multiuser/mcp/servers/:serverId', (req, res) => {
    const actor = actorOf(res);
    if (!actor) return unauthorized(res);
    const row = ownedRow(actor, req.params.serverId);
    if (!row) return notFound(res);
    const body = isRecord(req.body) ? req.body : {};
    if (hasStdio(body)) return stdioRefused(res, actor.accountId, 'server_update');
    let patch: Partial<StudioMcpServerFields>; let headers: Record<string, string | null>;
    try {
      if (Object.keys(body).some((key) => !['revision', 'url', 'transport', 'label', 'enabled', 'authMode', 'headers'].includes(key))
        || !Number.isSafeInteger(body.revision) || (body.enabled !== undefined && typeof body.enabled !== 'boolean')) throw new McpInputError('invalid');
      patch = {
        ...(body.url !== undefined ? { url: urlOf(body.url) } : {}),
        ...(body.transport !== undefined ? { transport: transportOf(body.transport) } : {}),
        ...(body.label !== undefined ? { label: labelOf(body.label) } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled as boolean } : {}),
        ...(body.authMode !== undefined ? { authMode: authModeOf(body.authMode, row.auth_mode) } : {}),
      };
      headers = headersOf(body.headers, true);
    } catch (error) { return inputFailed(res, error, actor.accountId, 'server_update'); }
    try {
      const { row: updated } = store.update(actor.accountId, row.server_id, body.revision as number, patch, headers, () => assertAuthority({ actor }));
      noStore(res);
      res.json({ server: dto(updated) } satisfies StudioMcpServerResponse);
    } catch (error) { return storeFailed(res, error, actor, 'server_update', row.server_id); }
  });
  app.delete('/api/multiuser/mcp/servers/:serverId', (req, res) => {
    const actor = actorOf(res);
    if (!actor) return unauthorized(res);
    const row = ownedRow(actor, req.params.serverId);
    if (!row) return notFound(res);
    try {
      if (!store.remove(actor.accountId, row.server_id, () => assertAuthority({ actor }))) return notFound(res);
      noStore(res);
      res.json({ ok: true });
    } catch (error) { return storeFailed(res, error, actor, 'server_delete', row.server_id); }
  });
  app.post('/api/multiuser/mcp/servers/:serverId/test', async (req, res) => {
    const actor = actorOf(res);
    if (!actor) return unauthorized(res);
    const row = ownedRow(actor, req.params.serverId);
    if (!row) return notFound(res);
    if (row.enabled !== 1) return sendApiError(res, 409, 'CONFLICT', 'this MCP server is disabled');
    const authority: McpAuthority = { actor, server: binding(row) };
    const headers = { ...store.headers(row) };
    const token = row.auth_mode === 'oauth' ? store.token(actor.accountId, binding(row)) : null;
    if (token && !Object.keys(headers).some((name) => name.toLowerCase() === 'authorization')) headers.Authorization = `Bearer ${token.secret.accessToken}`;
    let result;
    try {
      assertAuthority(authority);
      result = await probeStudioMcpServer(safe, { transport: row.transport, url: row.url }, headers);
      assertAuthority(authority);
    } catch (error) { return effectFailed(res, error, authority, 'server_test', row.server_id); }
    store.recordTest(actor.accountId, binding(row), { ok: result.ok, code: result.code });
    store.audit(actor.accountId, 'server_test', row.server_id, result.ok ? 'ok' : result.code ?? 'failed');
    if (result.code?.startsWith('outbound:')) return outboundRefused(res, actor.accountId, 'server_test', row.server_id, result.code.slice(9) as OutboundRefusalReason);
    noStore(res);
    res.json({ server: dto(store.get(actor.accountId, row.server_id) ?? row), result } satisfies StudioMcpTestResponse);
  });

  // ---- OAuth: server-side single-use state bound to account, session and server ----------
  const oauthServer = (req: Request, res: Response, actor: AuthActor): StudioMcpServerRow | null => {
    const serverId = req.method === 'GET' ? req.query.serverId : isRecord(req.body) ? req.body.serverId : undefined;
    const row = ownedRow(actor, serverId);
    if (!row) { notFound(res); return null; }
    return row;
  };
  app.post('/api/multiuser/mcp/oauth/start', async (req, res) => {
    const actor = actorOf(res);
    if (!actor) return unauthorized(res);
    const row = oauthServer(req, res, actor);
    if (!row) return;
    if (row.auth_mode !== 'oauth') return sendApiError(res, 409, 'CONFLICT', 'this MCP server does not use OAuth');
    if (row.enabled !== 1) return sendApiError(res, 409, 'CONFLICT', 'this MCP server is disabled');
    const server = binding(row);
    const authority: McpAuthority = { actor, server };
    const refusals: OutboundRefusalReason[] = [];
    const fetchImpl = asFetch(safe, { refusals, beforeRequest: () => assertAuthority(authority) });
    let token: string; let expiresAt: number; let authorizeUrl: string;
    try {
      const plan = await discoverStudioMcpAuthorization(fetchImpl, row.url);
      assertAuthority(authority);
      let client = store.client(actor.accountId, server, plan.authServer.issuer, redirectUri);
      if (!client) {
        client = await registerStudioMcpClient(fetchImpl, plan.authServer, redirectUri);
        assertAuthority(authority);
        store.saveClient(actor.accountId, server, plan.authServer.issuer, redirectUri, client);
      }
      // The state is a local binding effect: created under authority checked just now.
      assertAuthority(authority);
      const codeVerifier = newStudioMcpCodeVerifier();
      const stateBinding: StudioMcpStateBinding = { ...server, accountId: actor.accountId, sessionId: actor.sessionId, role: actor.role,
        studioRevision: actor.studioRevision ?? null, sessionExpiresAt: actor.sessionExpiresAt };
      ({ token, expiresAt } = store.createState(stateBinding, { codeVerifier, clientId: client.clientId,
        ...(client.clientSecret ? { clientSecret: client.clientSecret } : {}), tokenEndpoint: plan.authServer.token_endpoint, redirectUri,
        resource: plan.resource, ...(plan.scope ? { scope: plan.scope } : {}) }));
      authorizeUrl = studioMcpAuthorizeUrl(plan, { clientId: client.clientId, redirectUri, state: token, codeVerifier });
    } catch (error) { return effectFailed(res, error, authority, 'oauth_start', row.server_id, refusals); }
    store.audit(actor.accountId, 'oauth_start', row.server_id, 'redirect');
    noStore(res);
    res.json({ authorizeUrl, redirectUri, expiresAt: new Date(expiresAt).toISOString() } satisfies StudioMcpOAuthStartResponse);
  });
  app.get('/api/multiuser/mcp/oauth/callback', async (req, res) => {
    noStore(res);
    let bound: StudioMcpStateBinding | null = null;
    const refuse = (reason: StudioMcpCallbackRefusal) => {
      store.audit(bound?.accountId ?? 'anonymous', 'oauth_callback_refused', bound?.serverId ?? null, reason);
      return sendApiError(res, ['state', 'expired', 'replayed', 'not-completed'].includes(reason) ? 400 : 403,
        'MULTIUSER_MCP_AUTHORIZATION_INVALID', 'this MCP authorization is not valid; start again from Settings → MCP servers', { details: { reason } });
    };
    const consumed = store.consumeState(req.query.state);
    if (!consumed.ok) return refuse(consumed.reason);
    bound = consumed.binding;
    const binding_ = consumed.binding;
    // Identity comes from the server-side state, never the cookie; it must still be current.
    const stateActor: AuthActor = { accountId: binding_.accountId, username: '', role: binding_.role as AuthActor['role'], sessionId: binding_.sessionId,
      sessionExpiresAt: binding_.sessionExpiresAt, ...(binding_.studioRevision === null ? {} : { studioRevision: binding_.studioRevision }) };
    const authority: McpAuthority = { actor: stateActor, server: binding_ };
    const recheck = (): 'account' | 'session' | 'server-changed' | null => authorityRefusal(authority);
    const before = recheck();
    if (before) return refuse(before);
    if (typeof req.query.error === 'string' || typeof req.query.code !== 'string' || !req.query.code || req.query.code.length > 4096) return refuse('not-completed');
    const pending = consumed.pending;
    let tokenResponse;
    try {
      tokenResponse = await exchangeStudioMcpCode(asFetch(safe, { beforeRequest: () => assertAuthority(authority) }), {
        tokenEndpoint: pending.tokenEndpoint, clientId: pending.clientId, ...(pending.clientSecret ? { clientSecret: pending.clientSecret } : {}),
        redirectUri: pending.redirectUri, code: req.query.code, codeVerifier: pending.codeVerifier, ...(pending.resource ? { resource: pending.resource } : {}) });
    } catch {
      const changed = recheck();
      return refuse(changed ?? 'provider');
    }
    const completed = store.completeState(String(req.query.state), binding_, {
      accessToken: tokenResponse.access_token, ...(tokenResponse.refresh_token ? { refreshToken: tokenResponse.refresh_token } : {}),
      tokenType: typeof tokenResponse.token_type === 'string' ? tokenResponse.token_type.slice(0, 32) : 'Bearer',
      tokenEndpoint: pending.tokenEndpoint, clientId: pending.clientId, ...(pending.clientSecret ? { clientSecret: pending.clientSecret } : {}),
      ...(pending.resource ? { resource: pending.resource } : {}),
    }, { scope: typeof tokenResponse.scope === 'string' ? tokenResponse.scope : pending.scope ?? null,
      expiresAt: typeof tokenResponse.expires_in === 'number' && Number.isFinite(tokenResponse.expires_in) && tokenResponse.expires_in > 0
        ? now() + Math.min(tokenResponse.expires_in, 366 * 24 * 3600) * 1000 : null }, recheck);
    if (!completed.ok) return refuse(completed.reason);
    store.audit(binding_.accountId, 'oauth_complete', binding_.serverId, 'ok');
    sendConnectedPage(res, binding_.serverId);
  });
  app.get('/api/multiuser/mcp/oauth/status', (req, res) => {
    const actor = actorOf(res);
    if (!actor) return unauthorized(res);
    const row = oauthServer(req, res, actor);
    if (!row) return;
    const state = oauthState(row);
    noStore(res);
    res.json({ connected: state.status === 'connected', status: state.status, expiresAt: state.expiresAt, scope: state.scope,
      savedAt: state.connectedAt } satisfies StudioMcpOAuthStatusResponse);
  });
  app.post('/api/multiuser/mcp/oauth/refresh', async (req, res) => {
    const actor = actorOf(res);
    if (!actor) return unauthorized(res);
    const row = oauthServer(req, res, actor);
    if (!row) return;
    if (row.enabled !== 1) return sendApiError(res, 409, 'CONFLICT', 'this MCP server is disabled');
    const server = binding(row);
    const current = store.token(actor.accountId, server);
    if (!current?.secret.refreshToken) return sendApiError(res, 409, 'CONFLICT', 'this MCP server has no refreshable authorization');
    const authority: McpAuthority = { actor, server };
    const refusals: OutboundRefusalReason[] = [];
    let refreshed;
    try {
      refreshed = await refreshStudioMcpToken(asFetch(safe, { refusals, beforeRequest: () => assertAuthority(authority) }), {
        tokenEndpoint: current.secret.tokenEndpoint, clientId: current.secret.clientId, refreshToken: current.secret.refreshToken,
        ...(current.secret.clientSecret ? { clientSecret: current.secret.clientSecret } : {}), ...(current.secret.resource ? { resource: current.secret.resource } : {}) });
    } catch (error) { return effectFailed(res, error, authority, 'oauth_refresh', row.server_id, refusals); }
    const saved = store.saveToken(actor.accountId, server, { ...current.secret, accessToken: refreshed.access_token,
      ...(refreshed.refresh_token ? { refreshToken: refreshed.refresh_token } : {}) }, {
      scope: typeof refreshed.scope === 'string' ? refreshed.scope : current.row.scope,
      expiresAt: typeof refreshed.expires_in === 'number' && refreshed.expires_in > 0 ? now() + Math.min(refreshed.expires_in, 366 * 24 * 3600) * 1000 : null,
    }, () => authorityRefusal(authority), current.row.saved_at);
    if (saved === 'replaced') return sendApiError(res, 409, 'CONFLICT', 'the authorization changed while refreshing; reload');
    if (saved) return authorityChanged(res, actor.accountId, 'oauth_refresh', row.server_id, saved);
    store.audit(actor.accountId, 'oauth_refresh', row.server_id, 'ok');
    const state = oauthState(store.get(actor.accountId, row.server_id)!);
    noStore(res);
    res.json({ connected: state.status === 'connected', status: state.status, expiresAt: state.expiresAt, scope: state.scope, savedAt: state.connectedAt } satisfies StudioMcpOAuthStatusResponse);
  });
  app.post('/api/multiuser/mcp/oauth/cancel', (req, res) => {
    const actor = actorOf(res);
    if (!actor) return unauthorized(res);
    const row = oauthServer(req, res, actor);
    if (!row) return;
    const refused = authorityRefusal({ actor });
    if (refused) return authorityChanged(res, actor.accountId, 'oauth_cancel', row.server_id, refused);
    if (store.cancelStates(actor.accountId, row.server_id)) store.audit(actor.accountId, 'oauth_cancel', row.server_id, 'ok');
    noStore(res);
    res.json({ server: dto(row) } satisfies StudioMcpServerResponse);
  });
  app.post('/api/multiuser/mcp/oauth/disconnect', (req, res) => {
    const actor = actorOf(res);
    if (!actor) return unauthorized(res);
    const row = oauthServer(req, res, actor);
    if (!row) return;
    try {
      const cleared = store.clearToken(actor.accountId, row.server_id, () => assertAuthority({ actor }));
      store.cancelStates(actor.accountId, row.server_id);
      store.audit(actor.accountId, 'oauth_disconnect', row.server_id, cleared ? 'ok' : 'none');
    } catch (error) { return storeFailed(res, error, actor, 'oauth_disconnect', row.server_id); }
    noStore(res);
    res.json({ ok: true });
  });

  return {
    invalidateAccount(accountId) {
      if (store.cancelStates(accountId)) store.audit(accountId, 'oauth_cancel', null, 'session-revoked');
    },
  };
}

/** Same-origin popup completion: no token, no provider detail; posts only to this origin. */
function sendConnectedPage(res: Response, serverId: string): void {
  const nonce = randomBytes(16).toString('base64');
  const escape = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
  res.setHeader('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>MCP server connected · OpenDesign</title></head>
<body style="font:14px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0">
<main><h1 style="font-size:20px">${escape(serverId)} connected</h1><p>You can close this window and return to OpenDesign.</p></main>
<script nonce="${nonce}">try{if(window.opener&&!window.opener.closed){window.opener.postMessage({type:'open-design:mcp-oauth',serverId:${JSON.stringify(serverId)}},location.origin);setTimeout(function(){window.close()},600)}}catch(e){}</script>
</body></html>`);
}
