import type { StudioMcpTestResult, StudioMcpTransport } from '@open-design/contracts';
import { OutboundRequestRefused, type OutboundRefusalReason, type SafeOutboundFetch } from '../http/safe-outbound-fetch.js';
import {
  buildAuthorizeUrl, deriveCodeChallenge, discoverAuthServer, discoverProtectedResource, exchangeCodeForToken, generateCodeVerifier,
  refreshAccessToken, registerClient, type AuthorizationServerMetadata, type OAuthTokenResponse,
} from '../mcp-oauth.js';

/**
 * Account remote MCP client helpers for Studio (#62, S60). Every request goes
 * through the SSRF-guarded fetch; the desktop OAuth helpers in `mcp-oauth.ts`
 * are reused only through `asFetch`, never with their host token or client
 * cache files. Provider bodies and error texts are never returned or logged:
 * callers get fixed codes.
 */

export class StudioMcpRemoteError extends Error {
  constructor(readonly code: 'discovery' | 'registration' | 'token' | 'authorize-endpoint' | 'protocol') { super(`remote MCP ${code} failed`); }
}

/**
 * Adapts the guarded fetch to the `typeof fetch` the shared OAuth helpers take;
 * bodies are already bounded. Those helpers swallow fetch errors during
 * discovery, so every guard refusal is also recorded in `refusals`.
 */
export function asFetch(safe: SafeOutboundFetch, options: { signal?: AbortSignal; refusals?: OutboundRefusalReason[]; beforeRequest?: () => void } = {}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => { headers[key] = value; });
    // Authority is re-established before every outbound request (S58 pattern).
    options.beforeRequest?.();
    let response;
    try {
      response = await safe(url, { method: init?.method ?? 'GET', headers,
        ...(typeof init?.body === 'string' ? { body: init.body } : {}), ...(options.signal ? { signal: options.signal } : {}) });
    } catch (error) {
      if (error instanceof OutboundRequestRefused) options.refusals?.push(error.reason);
      throw error;
    }
    return new Response(response.status === 204 || response.status === 304 ? null : Buffer.from(response.body),
      { status: response.status, headers: response.headers });
  }) as typeof fetch;
}

const PROTOCOL_VERSION = '2025-06-18';

function firstSseData(text: string, event?: string): string | null {
  for (const block of text.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/);
    const name = lines.find((line) => line.startsWith('event:'))?.slice(6).trim() ?? 'message';
    const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
    if (data && (event === undefined || name === event)) return data;
  }
  return null;
}
const sseDone = (event?: string) => (received: Uint8Array) => firstSseData(Buffer.from(received).toString('utf8'), event) !== null;

/**
 * One MCP handshake probe: streamable HTTP sends `initialize`; legacy SSE opens
 * the stream and waits for its `endpoint` event. Codes: null (reachable),
 * `unauthorized`, `status`, `protocol`, or an outbound refusal reason prefixed
 * `outbound:`. Never the body.
 */
export async function probeStudioMcpServer(safe: SafeOutboundFetch, server: { transport: StudioMcpTransport; url: string },
  headers: Record<string, string>, signal?: AbortSignal): Promise<StudioMcpTestResult> {
  const base: StudioMcpTestResult = { ok: false, code: null, httpStatus: null, needsAuth: false, serverName: null, protocolVersion: null };
  try {
    if (server.transport === 'sse') {
      const response = await safe(server.url, { method: 'GET', headers: { ...headers, accept: 'text/event-stream' }, stopWhen: sseDone('endpoint'),
        ...(signal ? { signal } : {}) });
      if (response.status === 401 || response.status === 403) return { ...base, code: 'unauthorized', httpStatus: response.status, needsAuth: true };
      if (response.status < 200 || response.status >= 300) return { ...base, code: 'status', httpStatus: response.status };
      return firstSseData(response.text(), 'endpoint') !== null ? { ...base, ok: true, httpStatus: response.status }
        : { ...base, code: 'protocol', httpStatus: response.status };
    }
    const response = await safe(server.url, { method: 'POST', ...(signal ? { signal } : {}),
      headers: { ...headers, accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'mcp-protocol-version': PROTOCOL_VERSION },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'OpenDesign Studio', version: '1' } } }),
      // A JSON answer is read to its end; an event-stream answer stops after its first event.
      stopWhen: (received) => !/^\s*[[{]/.test(Buffer.from(received.subarray(0, 64)).toString('utf8')) && sseDone()(received) });
    if (response.status === 401 || response.status === 403) return { ...base, code: 'unauthorized', httpStatus: response.status, needsAuth: true };
    if (response.status < 200 || response.status >= 300) return { ...base, code: 'status', httpStatus: response.status };
    const type = response.headers.get('content-type') ?? '';
    const raw = /text\/event-stream/i.test(type) ? firstSseData(response.text()) : response.text();
    type InitializeMessage = { result?: { protocolVersion?: unknown; serverInfo?: { name?: unknown } } };
    let message: InitializeMessage | null;
    try { message = raw ? JSON.parse(raw) as InitializeMessage : null; } catch { message = null; }
    const result = message && typeof message === 'object' ? message.result : undefined;
    if (!result || typeof result !== 'object') return { ...base, code: 'protocol', httpStatus: response.status };
    const name = typeof result.serverInfo?.name === 'string' ? result.serverInfo.name.slice(0, 128) : null;
    const version = typeof result.protocolVersion === 'string' ? result.protocolVersion.slice(0, 32) : null;
    return { ...base, ok: true, httpStatus: response.status, serverName: name, protocolVersion: version };
  } catch (error) {
    if (error instanceof OutboundRequestRefused) return { ...base, code: `outbound:${error.reason}` };
    return { ...base, code: 'network' };
  }
}

export interface StudioMcpAuthorizationPlan {
  authServer: AuthorizationServerMetadata;
  resource: string;
  scope: string | undefined;
}

/** RFC 9728 → RFC 8414 discovery for the server, every document through the guarded fetch. */
export async function discoverStudioMcpAuthorization(fetchImpl: typeof fetch, serverUrl: string): Promise<StudioMcpAuthorizationPlan> {
  const prm = await discoverProtectedResource(serverUrl, fetchImpl);
  const issuer = typeof prm?.authorization_servers?.[0] === 'string' ? prm.authorization_servers[0] : new URL(serverUrl).origin;
  const authServer = await discoverAuthServer(issuer, fetchImpl);
  if (!authServer) throw new StudioMcpRemoteError('discovery');
  // The browser is sent to the authorization endpoint; the token and registration
  // endpoints are fetched by the daemon through the guarded fetch.
  for (const value of [authServer.authorization_endpoint, authServer.token_endpoint, authServer.registration_endpoint]) {
    if (value === undefined) continue;
    let parsed: URL;
    try { parsed = new URL(value); } catch { throw new StudioMcpRemoteError('authorize-endpoint'); }
    if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.username || parsed.password) throw new StudioMcpRemoteError('authorize-endpoint');
  }
  const scopes = Array.isArray(prm?.scopes_supported) && prm.scopes_supported.length ? prm.scopes_supported : authServer.scopes_supported;
  const scope = Array.isArray(scopes) && scopes.every((item) => typeof item === 'string') ? scopes.join(' ').slice(0, 1024) : undefined;
  return { authServer, resource: typeof prm?.resource === 'string' ? prm.resource : serverUrl, scope: scope || undefined };
}

export async function registerStudioMcpClient(fetchImpl: typeof fetch, authServer: AuthorizationServerMetadata, redirectUri: string) {
  if (!authServer.registration_endpoint) throw new StudioMcpRemoteError('registration');
  try { return await registerClient(authServer.registration_endpoint, redirectUri, fetchImpl); }
  catch (error) { if (error instanceof OutboundRequestRefused) throw error; throw new StudioMcpRemoteError('registration'); }
}

/** A fresh PKCE verifier (RFC 7636); it is sealed into the pending state, never returned. */
export const newStudioMcpCodeVerifier = generateCodeVerifier;

export function studioMcpAuthorizeUrl(plan: StudioMcpAuthorizationPlan, input: { clientId: string; redirectUri: string; state: string; codeVerifier: string }): string {
  return buildAuthorizeUrl({ authServer: plan.authServer, clientId: input.clientId, redirectUri: input.redirectUri, state: input.state,
    codeChallenge: deriveCodeChallenge(input.codeVerifier), resource: plan.resource, ...(plan.scope ? { scope: plan.scope } : {}) });
}

function checkedToken(response: OAuthTokenResponse): OAuthTokenResponse {
  if (typeof response.access_token !== 'string' || !response.access_token || response.access_token.length > 16_384
    || (response.refresh_token !== undefined && (typeof response.refresh_token !== 'string' || response.refresh_token.length > 16_384))) {
    throw new StudioMcpRemoteError('token');
  }
  return response;
}

export async function exchangeStudioMcpCode(fetchImpl: typeof fetch, input: Parameters<typeof exchangeCodeForToken>[0]): Promise<OAuthTokenResponse> {
  try { return checkedToken(await exchangeCodeForToken(input, fetchImpl)); }
  catch (error) { if (error instanceof OutboundRequestRefused) throw error; throw new StudioMcpRemoteError('token'); }
}

export async function refreshStudioMcpToken(fetchImpl: typeof fetch, input: Parameters<typeof refreshAccessToken>[0]): Promise<OAuthTokenResponse> {
  try { return checkedToken(await refreshAccessToken(input, fetchImpl)); }
  catch (error) { if (error instanceof OutboundRequestRefused) throw error; throw new StudioMcpRemoteError('token'); }
}
