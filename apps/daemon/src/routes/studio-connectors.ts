import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Express, Request, Response } from 'express';
import {
  STUDIO_CONNECTOR_RECHECK_REQUIRED,
  type ConnectorAuthConfigPrepareResponse, type ConnectorConnectResponse, type ConnectorDetail, type ConnectorDetailResponse,
  type ConnectorDiscoveryResponse, type ConnectorListResponse, type ConnectorStatusResponse, type ConnectorStatusSummary,
  type StudioComposioConfigResponse, type StudioConnectorCallbackRefusal,
} from '@open-design/contracts';
import { sendApiError } from '../http/api-errors.js';
import { multiUserActorOf } from '../http/multiuser-gate.js';
import type { AuthActor } from '../services/auth-service.js';
import { multiUserStreamAllowed } from '../http/multiuser-stream.js';
import { connectorDefinitionToDetail, type ConnectorCatalogDefinition } from '../connectors/catalog.js';
import { connectorIdForToolkitSlug, getStaticComposioCatalogDefinitions } from '../connectors/composio.js';
import { StudioComposioClient, StudioComposioError } from '../connectors/studio-composio.js';
import { CompanyComposioConfigError, CompanyComposioStore, StudioConnectorStore, type StudioConnectionRow, type StudioConnectorStateBinding } from '../storage/studio-connectors.js';


export interface RegisterStudioConnectorRoutesDeps {
  db: Database.Database;
  dataRoot: string;
  /** The deployment's public app origin; the OAuth callback returns there. */
  publicOrigin: string;
  /** Whether the session that started an authorization is still the account's current, live session. */
  sessionCurrent: (snapshot: AuthActor) => boolean;
  accountActive: (accountId: string) => boolean;
  /** Programmatic Composio fixture; deployment config cannot supply it. */
  fetch?: typeof fetch;
  clock?: () => number;
}

export interface StudioConnectors {
  /** Session revoke, password reset, disable, logout: pending authorizations of the account die now. */
  invalidateAccount(accountId: string): void;
}

const MAX_PREPARE = 8;
const CONNECTOR_ID = /^[a-z0-9_]{1,64}$/;

/**
 * Account connectors control plane for Web accounts (#62, S58). The standard
 * `/api/connectors/*` routes reach these through reviewed gate aliases; the
 * host-global desktop connector service, its credential file and its fixed
 * local Composio user never run for a cookie actor.
 */
export function registerStudioConnectorRoutes(app: Express, deps: RegisterStudioConnectorRoutesDeps): StudioConnectors {
  const now = deps.clock ?? Date.now;
  const company = new CompanyComposioStore(deps.db, deps.dataRoot, now);
  const store = new StudioConnectorStore(deps.db, now);
  const composio = new StudioComposioClient(deps.fetch ?? fetch);
  const catalog = (): ConnectorCatalogDefinition[] => getStaticComposioCatalogDefinitions().filter((definition) => definition.authentication === 'composio');
  const definitionOf = (id: unknown) => typeof id === 'string' && CONNECTOR_ID.test(id) ? catalog().find((definition) => definition.id === id) : undefined;

  const statusOf = (row: StudioConnectionRow | undefined, credentialRevision: number | null): ConnectorStatusSummary => {
    if (!row || row.status !== 'connected') return { status: 'available' };
    const label = row.account_label ?? undefined;
    // A connection made under another company key may live in another Composio
    // project: it is never silently rebound, the account reconnects.
    if (credentialRevision === null || row.credential_revision !== credentialRevision) {
      return { status: 'error', ...(label ? { accountLabel: label } : {}), lastError: STUDIO_CONNECTOR_RECHECK_REQUIRED };
    }
    return { status: 'connected', ...(label ? { accountLabel: label } : {}) };
  };
  const detailsFor = (owner: string, only?: ConnectorCatalogDefinition): ConnectorDetail[] => {
    const summary = company.read();
    const credentialRevision = summary.configured ? summary.credentialRevision : null;
    const rows = new Map(store.connections(owner).map((row) => [row.connector_id, row]));
    return (only ? [only] : catalog()).map((definition) => {
      const detail = connectorDefinitionToDetail(definition);
      const status = statusOf(rows.get(definition.id), credentialRevision);
      const { accountLabel: _label, lastError: _error, ...base } = detail;
      return { ...base, status: status.status, ...(status.accountLabel ? { accountLabel: status.accountLabel } : {}),
        ...(status.lastError ? { lastError: status.lastError } : {}), auth: { provider: 'composio', configured: summary.configured } };
    });
  };
  const owner = (res: Response): string | null => multiUserActorOf(res)?.accountId ?? null;
  const noStore = (res: Response) => res.setHeader('Cache-Control', 'no-store');
  const providerFailed = (res: Response, error: unknown, operation: string) => {
    const status = error instanceof StudioComposioError ? error.httpStatus : null;
    console.error(`[Studio] MULTIUSER_CONNECTOR_PROVIDER_FAILED: ${operation}${status ? ` HTTP ${status}` : ''}`);
    if (error instanceof StudioComposioError && error.kind === 'custom-auth-required') {
      return sendApiError(res, 409, 'CONNECTOR_AUTH_CONFIG_REQUIRED', 'this app needs a custom auth configuration in the company Composio project');
    }
    return sendApiError(res, 502, 'MULTIUSER_CONNECTOR_PROVIDER_FAILED', error instanceof StudioComposioError && error.kind === 'rejected'
      ? 'Composio refused the company key' : 'Composio request failed');
  };
  const notConfigured = (res: Response) => sendApiError(res, 409, 'MULTIUSER_CONNECTORS_NOT_CONFIGURED',
    'no company Composio key is configured; an administrator configures it in Settings → Connectors');
  const authConfigFor = async (definition: ConnectorCatalogDefinition, credential: { apiKey: string; credentialRevision: number }) => {
    const cached = store.authConfig(definition.id, credential.credentialRevision);
    if (cached) return cached;
    const id = await composio.resolveAuthConfig(credential.apiKey, definition.id, definition.providerConnectorId ?? definition.id);
    // Cached per key revision: a rotated key never reuses another project's config.
    if (company.read().credentialRevision === credential.credentialRevision) store.setAuthConfig(definition.id, credential.credentialRevision, id);
    return id;
  };

  // ---- company key (administrators write; everyone reads the redacted state) ----
  const configResponse = (res: Response): StudioComposioConfigResponse => {
    const summary = company.read();
    const admin = multiUserActorOf(res)?.role === 'admin';
    return { configured: summary.configured, apiKeyTail: admin ? summary.last4 : '', revision: summary.revision,
      credentialRevision: summary.credentialRevision, canManage: admin };
  };
  app.get('/api/multiuser/connectors/company-key', (_req, res) => {
    if (!owner(res)) return sendApiError(res, 401, 'UNAUTHORIZED', 'authentication required');
    noStore(res);
    res.json(configResponse(res));
  });
  app.put('/api/multiuser/connectors/company-key', (req, res) => {
    const actor = multiUserActorOf(res);
    if (!actor) return sendApiError(res, 401, 'UNAUTHORIZED', 'authentication required');
    if (actor.role !== 'admin') return sendApiError(res, 403, 'FORBIDDEN', 'admin role required');
    try {
      const { action } = company.update(actor.accountId, req.body);
      if (action !== 'unchanged') {
        // Authorizations started under the previous key can never complete.
        store.cancelAllStates();
        store.audit(actor.accountId, `company_key_${action}`, null, 'ok');
      }
      noStore(res);
      res.json(configResponse(res));
    } catch (error) {
      if (error instanceof CompanyComposioConfigError) {
        return sendApiError(res, error.status, error.status === 409 ? 'CONFLICT' : 'BAD_REQUEST',
          error.status === 409 ? 'the company key changed; reload before saving' : 'invalid company Composio key update');
      }
      sendApiError(res, 500, 'INTERNAL_ERROR', 'company Composio key update failed');
    }
  });

  // ---- the actor's own connections (static catalog + this account's rows only) ----
  app.get('/api/multiuser/connectors', (_req, res) => {
    const actor = owner(res);
    if (!actor) return sendApiError(res, 401, 'UNAUTHORIZED', 'authentication required');
    noStore(res);
    res.json({ connectors: detailsFor(actor) } satisfies ConnectorListResponse);
  });
  app.get('/api/multiuser/connectors/status', (_req, res) => {
    const actor = owner(res);
    if (!actor) return sendApiError(res, 401, 'UNAUTHORIZED', 'authentication required');
    noStore(res);
    const statuses = Object.fromEntries(detailsFor(actor).map((detail) => [detail.id, {
      status: detail.status, ...(detail.accountLabel ? { accountLabel: detail.accountLabel } : {}), ...(detail.lastError ? { lastError: detail.lastError } : {}),
    } satisfies ConnectorStatusSummary]));
    res.json({ statuses } satisfies ConnectorStatusResponse);
  });
  // Discovery is the reviewed static catalog: no host key, no refresh against a provider.
  app.get('/api/multiuser/connectors/discovery', (_req, res) => {
    const actor = owner(res);
    if (!actor) return sendApiError(res, 401, 'UNAUTHORIZED', 'authentication required');
    noStore(res);
    res.json({ connectors: detailsFor(actor), meta: { provider: 'composio' } } satisfies ConnectorDiscoveryResponse);
  });
  app.post('/api/multiuser/connectors/auth-configs/prepare', async (req, res) => {
    const actor = owner(res);
    if (!actor) return sendApiError(res, 401, 'UNAUTHORIZED', 'authentication required');
    const ids = (req.body as { connectorIds?: unknown } | undefined)?.connectorIds;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_PREPARE || ids.some((id) => typeof id !== 'string')) {
      return sendApiError(res, 400, 'VALIDATION_FAILED', 'connectorIds must list 1 to 8 connector ids');
    }
    const credential = company.credential();
    if (!credential) return notConfigured(res);
    const results: ConnectorAuthConfigPrepareResponse['results'] = {};
    for (const id of [...new Set(ids as string[])]) {
      const definition = definitionOf(id);
      if (!definition) { results[id] = { status: 'error', message: 'connector not found' }; continue; }
      try { results[id] = { status: 'ready', authConfigId: await authConfigFor(definition, credential) }; }
      catch (error) {
        console.error(`[Studio] MULTIUSER_CONNECTOR_PROVIDER_FAILED: auth config${error instanceof StudioComposioError && error.httpStatus ? ` HTTP ${error.httpStatus}` : ''}`);
        results[id] = error instanceof StudioComposioError && error.kind === 'custom-auth-required'
          ? { status: 'custom_required', message: 'this app needs a custom auth configuration in the company Composio project' }
          : { status: 'error', message: 'Composio request failed' };
      }
    }
    if (!multiUserStreamAllowed(res)) return;
    noStore(res);
    res.json({ results } satisfies ConnectorAuthConfigPrepareResponse);
  });
  app.get('/api/multiuser/connectors/oauth/callback/:connectorId', async (req, res) => {
    noStore(res);
    const connectorId = String(req.params.connectorId ?? '');
    let bound: StudioConnectorStateBinding | null = null;
    const refuse = (reason: StudioConnectorCallbackRefusal) => {
      store.audit(bound?.accountId ?? 'anonymous', 'connect_refused', definitionOf(connectorId) ? connectorId : null, reason);
      return sendApiError(res, ['state', 'expired', 'replayed', 'not-completed'].includes(reason) ? 400 : 403,
        'MULTIUSER_CONNECTOR_AUTHORIZATION_INVALID', 'this connector authorization is not valid; start again from Settings → Connectors',
        { details: { reason } });
    };
    const definition = definitionOf(connectorId);
    const consumed = store.consumeState(req.query.state, connectorId);
    if (!definition || !consumed.ok) return refuse(definition && !consumed.ok ? consumed.reason : 'state');
    bound = consumed.binding;
    const binding = consumed.binding;
    // Identity comes from the server-side state, never the cookie; it must still be current.
    const authority = (): StudioConnectorCallbackRefusal | null => {
      if (!deps.accountActive(binding.accountId)) return 'account';
      if (!deps.sessionCurrent({ accountId: binding.accountId, username: '', role: binding.role as AuthActor['role'], sessionId: binding.sessionId,
        sessionExpiresAt: binding.sessionExpiresAt, ...(binding.studioRevision === null ? {} : { studioRevision: binding.studioRevision }) })) return 'session';
      const key = company.read();
      if (!key.configured || key.credentialRevision !== binding.credentialRevision) return 'key-changed';
      return null;
    };
    const before = authority();
    if (before) return refuse(before);
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    if (status !== undefined && status.toLowerCase() !== 'success') return refuse('not-completed');
    const queried = ['connected_account_id', 'connection_id', 'account_id'].map((name) => req.query[name]).find((value) => typeof value === 'string') as string | undefined;
    if (queried !== undefined && consumed.providerConnectionId && queried !== consumed.providerConnectionId) return refuse('provider');
    const providerConnectionId = queried ?? consumed.providerConnectionId;
    if (!providerConnectionId || providerConnectionId.length > 256) return refuse('provider');
    const credential = company.credential();
    if (!credential || credential.credentialRevision !== binding.credentialRevision) return refuse('key-changed');
    let account;
    try { account = await composio.connectedAccount(credential.apiKey, providerConnectionId); }
    catch (error) { return providerFailed(res, error, 'callback verification'); }
    const expectedAuthConfig = store.authConfig(definition.id, binding.credentialRevision);
    if (!account || account.userId !== store.entityFor(binding.accountId)
      || (account.toolkitSlug && connectorIdForToolkitSlug(account.toolkitSlug) !== definition.id)
      || (expectedAuthConfig && account.authConfigId && account.authConfigId !== expectedAuthConfig)) return refuse('provider');
    if (account.status && !['ACTIVE', 'CONNECTED'].includes(account.status)) return refuse('not-completed');
    const after = authority();
    if (after) return refuse(after);
    store.saveConnection(binding.accountId, definition.id, { providerConnectionId, accountLabel: account.accountLabel ?? definition.name,
      credentialRevision: binding.credentialRevision });
    store.audit(binding.accountId, 'connect_complete', definition.id, 'ok');
    sendConnectedPage(res, definition.id, definition.name);
  });
  app.get('/api/multiuser/connectors/:connectorId', (req, res) => {
    const actor = owner(res);
    if (!actor) return sendApiError(res, 401, 'UNAUTHORIZED', 'authentication required');
    const definition = definitionOf(req.params.connectorId);
    if (!definition) return sendApiError(res, 404, 'CONNECTOR_NOT_FOUND', 'connector not found');
    noStore(res);
    res.json({ connector: detailsFor(actor, definition)[0]! } satisfies ConnectorDetailResponse);
  });
  app.post('/api/multiuser/connectors/:connectorId/connect', async (req: Request, res) => {
    const actor = multiUserActorOf(res);
    if (!actor) return sendApiError(res, 401, 'UNAUTHORIZED', 'authentication required');
    const definition = definitionOf(req.params.connectorId);
    if (!definition) return sendApiError(res, 404, 'CONNECTOR_NOT_FOUND', 'connector not found');
    const credential = company.credential();
    if (!credential) return notConfigured(res);
    let authConfigId: string;
    try { authConfigId = await authConfigFor(definition, credential); }
    catch (error) { if (!multiUserStreamAllowed(res)) return; return providerFailed(res, error, 'auth config'); }
    if (!multiUserStreamAllowed(res)) return;
    if (company.read().credentialRevision !== credential.credentialRevision) return notConfigured(res);
    const { token, expiresAt } = store.createState({ accountId: actor.accountId, sessionId: actor.sessionId, role: actor.role,
      studioRevision: actor.studioRevision ?? null, sessionExpiresAt: actor.sessionExpiresAt, connectorId: definition.id,
      credentialRevision: credential.credentialRevision });
    const callbackUrl = `${deps.publicOrigin}/api/connectors/oauth/callback/${encodeURIComponent(definition.id)}?${new URLSearchParams({ state: token })}`;
    let link: Awaited<ReturnType<StudioComposioClient['createLink']>>;
    try {
      link = await composio.createLink(credential.apiKey, { authConfigId, entity: store.entityFor(actor.accountId), state: token, callbackUrl });
    } catch (error) {
      store.discardState(token);
      if (!multiUserStreamAllowed(res)) return;
      return providerFailed(res, error, 'connect link');
    }
    // A session revoked or rotated while the provider answered gets nothing and keeps nothing pending.
    if (!multiUserStreamAllowed(res)) { store.discardState(token); return; }
    if (link.providerConnectionId) store.setStateProviderConnection(token, link.providerConnectionId);
    store.audit(actor.accountId, 'connect_start', definition.id, link.redirectUrl ? 'redirect' : 'pending');
    noStore(res);
    res.json({ connector: detailsFor(actor.accountId, definition)[0]!, auth: {
      kind: link.redirectUrl ? 'redirect_required' : 'pending', ...(link.redirectUrl ? { redirectUrl: link.redirectUrl } : {}),
      expiresAt: new Date(expiresAt).toISOString() } } satisfies ConnectorConnectResponse);
  });
  app.post('/api/multiuser/connectors/:connectorId/authorization/cancel', (req, res) => {
    const actor = owner(res);
    if (!actor) return sendApiError(res, 401, 'UNAUTHORIZED', 'authentication required');
    const definition = definitionOf(req.params.connectorId);
    if (!definition) return sendApiError(res, 404, 'CONNECTOR_NOT_FOUND', 'connector not found');
    const cancelled = store.cancelStates(actor, definition.id);
    if (cancelled) store.audit(actor, 'authorization_cancel', definition.id, 'ok');
    noStore(res);
    res.json({ connector: detailsFor(actor, definition)[0]! } satisfies ConnectorDetailResponse);
  });
  app.delete('/api/multiuser/connectors/:connectorId/connection', async (req, res) => {
    const actor = owner(res);
    if (!actor) return sendApiError(res, 401, 'UNAUTHORIZED', 'authentication required');
    const definition = definitionOf(req.params.connectorId);
    const row = definition ? store.connection(actor, definition.id) : null;
    // An unknown connector, one this account never connected and another account's
    // connection are the same refusal: nothing here can address another account's row.
    if (!definition || !row || row.status !== 'connected') return sendApiError(res, 404, 'NOT_FOUND', 'connection not found');
    const credential = company.credential();
    let outcome = 'local';
    if (credential && row.provider_connection_id && row.credential_revision === credential.credentialRevision) {
      try {
        const account = await composio.connectedAccount(credential.apiKey, row.provider_connection_id);
        if (account && account.userId === store.entityFor(actor)) {
          await composio.deleteConnectedAccount(credential.apiKey, row.provider_connection_id);
          outcome = 'provider';
        } else outcome = account ? 'provider-mismatch' : 'provider-missing';
      } catch (error) {
        if (!multiUserStreamAllowed(res)) return;
        return providerFailed(res, error, 'disconnect');
      }
    }
    // The account's own row only, rechecked after the provider call; history stays in the audit.
    const current = store.connection(actor, definition.id);
    if (current?.status === 'connected' && current.provider_connection_id === row.provider_connection_id) store.markDisconnected(actor, definition.id);
    store.audit(actor, 'disconnect', definition.id, outcome);
    if (!multiUserStreamAllowed(res)) return;
    noStore(res);
    res.json({ connector: detailsFor(actor, definition)[0]! } satisfies ConnectorDetailResponse);
  });

  return {
    invalidateAccount(accountId) {
      if (store.cancelStates(accountId)) store.audit(accountId, 'authorization_cancel', null, 'session-revoked');
    },
  };
}

/** Same-origin popup completion: no account label, no provider id; posts only to this origin. */
function sendConnectedPage(res: Response, connectorId: string, name: string): void {
  const nonce = randomBytes(16).toString('base64');
  const escape = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
  res.setHeader('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(name)} connected · OpenDesign</title></head>
<body style="font:14px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0">
<main><h1 style="font-size:20px">${escape(name)} connected</h1><p>You can close this window and return to OpenDesign.</p></main>
<script nonce="${nonce}">try{if(window.opener&&!window.opener.closed){window.opener.postMessage({type:'open-design:connector-connected',connectorId:${JSON.stringify(connectorId)}},location.origin);setTimeout(function(){window.close()},600)}}catch(e){}</script>
</body></html>`);
}
