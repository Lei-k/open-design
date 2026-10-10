import { COMPOSIO_API_BASE_URL, connectorIdForToolkitSlug } from './composio.js';

/**
 * The Composio calls the Studio connectors control plane (#62, S58) makes,
 * always with the company key and an explicit per-account entity. Unlike the
 * desktop provider it reads no host config, never uses the desktop user id,
 * fixes the API origin, refuses redirects and never echoes provider bodies.
 */
export class StudioComposioError extends Error {
  constructor(readonly kind: 'rejected' | 'not-found' | 'failed' | 'custom-auth-required', readonly httpStatus: number | null) {
    super(`Composio request ${kind}`);
  }
}

export interface StudioComposioConnectedAccount {
  id: string;
  userId: string | null;
  authConfigId: string | null;
  toolkitSlug: string | null;
  status: string | null;
  accountLabel: string | null;
}

const TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
async function boundedBody(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new StudioComposioError('failed', response.status); }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { reader.releaseLock(); }
}
const text = (value: unknown): string | null => typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

export class StudioComposioClient {
  constructor(private readonly fetchImpl: typeof fetch = fetch, private readonly baseUrl = COMPOSIO_API_BASE_URL) {}

  private async request(apiKey: string, path: string, init: { method: string; body?: unknown; allow404?: boolean }): Promise<Record<string, unknown> | null> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: init.method, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'OpenDesign Studio connectors', 'x-api-key': apiKey },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
    } catch { throw new StudioComposioError('failed', null); }
    if (response.status === 404 && init.allow404) { void response.body?.cancel(); return null; }
    if (!response.ok) {
      const body = await boundedBody(response).catch(() => '');
      void body; // Provider bodies are never echoed or logged.
      if (response.status === 401 || response.status === 403) throw new StudioComposioError('rejected', response.status);
      if (response.status === 404) throw new StudioComposioError('not-found', 404);
      if (/use_composio_managed_auth|managed auth|custom auth/i.test(body)) throw new StudioComposioError('custom-auth-required', response.status);
      throw new StudioComposioError('failed', response.status);
    }
    if (init.method === 'DELETE') { void response.body?.cancel(); return {}; }
    let value: unknown;
    try { value = JSON.parse(await boundedBody(response)); } catch { throw new StudioComposioError('failed', response.status); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new StudioComposioError('failed', response.status);
    return value as Record<string, unknown>;
  }

  /**
   * An enabled auth config for the toolkit in the company project, creating a
   * Composio-managed one if none exists. `beforeCreate` runs immediately before
   * that provider-side write (after the list request settled) and throws to
   * stop it.
   */
  async resolveAuthConfig(apiKey: string, connectorId: string, catalogSlug: string, hooks: { beforeCreate?: () => void } = {}): Promise<string> {
    // Composio toolkit slugs are lower case; the catalog keeps display casing.
    const toolkitSlug = catalogSlug.toLowerCase();
    const listed = await this.request(apiKey, `/api/v3/auth_configs?${new URLSearchParams({ toolkit_slug: toolkitSlug })}`, { method: 'GET' });
    const items = Array.isArray(listed?.items) ? listed.items : Array.isArray(listed?.data) ? listed.data : [];
    for (const item of items) {
      const entry = record(item);
      const id = text(entry.id) ?? text(record(entry.auth_config).id);
      const slug = text(record(entry.toolkit).slug) ?? text(entry.toolkit_slug) ?? toolkitSlug;
      const status = text(entry.status)?.toUpperCase();
      if (id && (!status || status === 'ENABLED') && connectorIdForToolkitSlug(slug) === connectorId) return id;
    }
    hooks.beforeCreate?.();
    const created = await this.request(apiKey, '/api/v3.1/auth_configs', { method: 'POST',
      body: { toolkit: { slug: toolkitSlug }, auth_config: { type: 'use_composio_managed_auth' } } });
    const id = text(created?.id) ?? text(record(created?.auth_config).id);
    const slug = text(record(created?.toolkit).slug) ?? text(created?.toolkit_slug) ?? toolkitSlug;
    if (!id || connectorIdForToolkitSlug(slug) !== connectorId) throw new StudioComposioError('failed', null);
    return id;
  }

  /** Starts the account's OAuth link for its own entity. */
  async createLink(apiKey: string, input: { authConfigId: string; entity: string; state: string; callbackUrl: string }): Promise<{ providerConnectionId: string | null; redirectUrl: string | null; status: string | null }> {
    const response = await this.request(apiKey, '/api/v3.1/connected_accounts/link', { method: 'POST', body: {
      auth_config_id: input.authConfigId, user_id: input.entity, connection_data: { state_prefix: input.state }, callback_url: input.callbackUrl,
    } });
    const redirectUrl = text(response?.redirect_url) ?? text(response?.redirectUrl);
    let safeRedirect: string | null = null;
    if (redirectUrl) {
      try { if (new URL(redirectUrl).protocol === 'https:') safeRedirect = redirectUrl; } catch { safeRedirect = null; }
    }
    return { providerConnectionId: text(response?.connected_account_id) ?? text(response?.connectedAccountId) ?? text(response?.id) ?? text(response?.nanoid),
      redirectUrl: safeRedirect, status: text(response?.status)?.toUpperCase() ?? null };
  }

  async connectedAccount(apiKey: string, id: string): Promise<StudioComposioConnectedAccount | null> {
    const response = await this.request(apiKey, `/api/v3/connected_accounts/${encodeURIComponent(id)}`, { method: 'GET', allow404: true });
    if (!response) return null;
    return { id, userId: text(response.user_id) ?? text(response.userId), authConfigId: text(record(response.auth_config).id),
      toolkitSlug: text(record(response.toolkit).slug), status: text(response.status)?.toUpperCase() ?? null,
      accountLabel: text(response.account_label) ?? text(response.accountLabel) ?? text(response.email) ?? text(response.name) };
  }

  async deleteConnectedAccount(apiKey: string, id: string): Promise<void> {
    await this.request(apiKey, `/api/v3/connected_accounts/${encodeURIComponent(id)}`, { method: 'DELETE', allow404: true });
  }

  async toolMetadata(apiKey: string, toolkitSlug: string): Promise<Record<string, unknown>[]> {
    const response = await this.request(apiKey, `/api/v3.1/tools?${new URLSearchParams({ toolkit_slug: toolkitSlug.toLowerCase(), limit: '1000' })}`, { method: 'GET' });
    const items = Array.isArray(response?.items) ? response.items : Array.isArray(response?.data) ? response.data : [];
    return items.slice(0, 1000).filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item));
  }

  async executeTool(apiKey: string, toolSlug: string, entity: string, connectionId: string, input: unknown): Promise<unknown> {
    const response = await this.request(apiKey, `/api/v3.1/tools/execute/${encodeURIComponent(toolSlug)}`, { method: 'POST',
      body: { user_id: entity, connected_account_id: connectionId, arguments: input } });
    if (!response || response.successful === false || response.error) throw new StudioComposioError('failed', null);
    return response.data ?? null;
  }
}
