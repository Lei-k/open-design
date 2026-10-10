import type { StudioMcpTestResult, StudioMcpTransport } from '@open-design/contracts';
import { OutboundAuthorityRefused, OutboundRequestRefused, type OutboundRefusalReason, type SafeOutboundFetch, type SafeOutboundInit } from '../http/safe-outbound-fetch.js';
import {
  buildAuthorizeUrl, deriveCodeChallenge, discoverAuthServer, discoverProtectedResource, generateCodeVerifier,
  registerClient, type AuthorizationServerMetadata,
} from '../mcp-oauth.js';
import { untrustedProtocolVersion, untrustedText, untrustedTokenType, type KnownSecrets } from './studio-untrusted.js';

/**
 * Account remote MCP client helpers for Studio (#62, S60). Every request goes
 * through the SSRF-guarded fetch; the desktop OAuth helpers in `mcp-oauth.ts`
 * are reused only through `asFetch`, never with their host token or client
 * cache files. Provider bodies and error texts are never returned or logged:
 * callers get fixed codes.
 *
 * Authority (S60 Repair 1): callers pass a synchronous `beforeConnect` hook
 * that the guarded fetch runs after DNS resolution, for every hop, before
 * dispatch and again on the open socket. Credentials (static headers, bearer
 * tokens, the token-request form with code verifier / refresh token / client
 * secret) are produced inside that hook, i.e. decrypted only after the final
 * check. Everything a provider returns is untrusted: only allowlisted,
 * bounded, secret-scrubbed fields leave these helpers.
 */

export class StudioMcpRemoteError extends Error {
  constructor(readonly code: 'discovery' | 'registration' | 'token' | 'authorize-endpoint' | 'protocol') { super(`remote MCP ${code} failed`); }
}

/**
 * Adapts the guarded fetch to the `typeof fetch` the shared OAuth helpers take;
 * bodies are already bounded. Those helpers swallow fetch errors during
 * discovery, so every guard refusal is also recorded in `refusals`.
 */
export function asFetch(safe: SafeOutboundFetch, options: { signal?: AbortSignal; refusals?: OutboundRefusalReason[]; beforeRequest?: () => void;
  beforeConnect?: SafeOutboundInit['beforeConnect'] } = {}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => { headers[key] = value; });
    // Authority is re-established before every outbound request (S58 pattern), and
    // again after DNS resolution, per hop, before dispatch and on the open socket.
    options.beforeRequest?.();
    let response;
    try {
      response = await safe(url, { method: init?.method ?? 'GET', headers,
        ...(typeof init?.body === 'string' ? { body: init.body } : {}), ...(options.signal ? { signal: options.signal } : {}),
        ...(options.beforeConnect ? { beforeConnect: options.beforeConnect } : {}) });
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

export interface StudioMcpProbeAccess {
  /**
   * Runs after DNS resolution, per hop: throw to refuse. In the `dispatch`
   * phase it returns the credential headers (decrypted there, after the check).
   */
  beforeConnect: (hop: Parameters<NonNullable<SafeOutboundInit['beforeConnect']>>[0]) => Record<string, string> | void;
  /** The server's known secrets, for scrubbing what the remote returns. */
  secrets: () => KnownSecrets;
}

/**
 * One MCP handshake probe: streamable HTTP sends `initialize`; legacy SSE opens
 * the stream and waits for its `endpoint` event. Codes: null (reachable),
 * `unauthorized`, `status`, `protocol`, or an outbound refusal reason prefixed
 * `outbound:`. Never the body. An authority refusal from the hook propagates
 * (`OutboundAuthorityRefused`). Of the initialize result only `serverInfo.name`
 * (printable, ≤ 128, scrubbed of the server's secrets) and a date-shaped
 * `protocolVersion` are kept; instructions, titles and the rest are dropped.
 */
export async function probeStudioMcpServer(safe: SafeOutboundFetch, server: { transport: StudioMcpTransport; url: string },
  access: StudioMcpProbeAccess, signal?: AbortSignal): Promise<StudioMcpTestResult> {
  const base: StudioMcpTestResult = { ok: false, code: null, httpStatus: null, needsAuth: false, serverName: null, protocolVersion: null };
  const beforeConnect: SafeOutboundInit['beforeConnect'] = (hop) => {
    const headers = access.beforeConnect(hop);
    return hop.phase === 'dispatch' && headers ? { headers } : undefined;
  };
  try {
    if (server.transport === 'sse') {
      const response = await safe(server.url, { method: 'GET', headers: { accept: 'text/event-stream' }, stopWhen: sseDone('endpoint'),
        beforeConnect, ...(signal ? { signal } : {}) });
      if (response.status === 401 || response.status === 403) return { ...base, code: 'unauthorized', httpStatus: response.status, needsAuth: true };
      if (response.status < 200 || response.status >= 300) return { ...base, code: 'status', httpStatus: response.status };
      return firstSseData(response.text(), 'endpoint') !== null ? { ...base, ok: true, httpStatus: response.status }
        : { ...base, code: 'protocol', httpStatus: response.status };
    }
    const response = await safe(server.url, { method: 'POST', ...(signal ? { signal } : {}), beforeConnect,
      headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'mcp-protocol-version': PROTOCOL_VERSION },
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
    const name = untrustedText(result.serverInfo && typeof result.serverInfo === 'object' ? result.serverInfo.name : null, access.secrets());
    return { ...base, ok: true, httpStatus: response.status, serverName: name, protocolVersion: untrustedProtocolVersion(result.protocolVersion) };
  } catch (error) {
    if (error instanceof OutboundAuthorityRefused) throw error;
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

/** The secret inputs of one token request, produced inside the hook after its final check. */
export type StudioMcpTokenGrant =
  | { grantType: 'authorization_code'; code: string; codeVerifier: string; redirectUri: string; clientId: string; clientSecret?: string; resource?: string }
  | { grantType: 'refresh_token'; refreshToken: string; clientId: string; clientSecret?: string; resource?: string };

/**
 * The allowlisted part of a token response; the raw response is never kept.
 * `untrustedScope` must still go through `untrustedScope()` with the server's
 * known secrets (including these new tokens) before it is stored or shown.
 */
export interface StudioMcpTokenResult {
  accessToken: string; refreshToken?: string; tokenType: string; expiresInSeconds: number | null; untrustedScope: string | null;
}

const MAX_TOKEN_LENGTH = 16_384;

/**
 * RFC 6749 token request (authorization code or refresh) through the guarded
 * fetch. `authorize` runs after DNS resolution, before dispatch and on the
 * open socket; `grant` (which decrypts the code verifier / refresh token /
 * client secret) runs only after `authorize` passed in the dispatch phase.
 * POST, so a redirect is refused by the guard.
 */
export async function requestStudioMcpToken(safe: SafeOutboundFetch, tokenEndpoint: string,
  input: { authorize: () => void; grant: () => StudioMcpTokenGrant; signal?: AbortSignal }): Promise<StudioMcpTokenResult> {
  let response;
  try {
    response = await safe(tokenEndpoint, { method: 'POST', ...(input.signal ? { signal: input.signal } : {}),
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      beforeConnect: (hop) => {
        input.authorize();
        if (hop.phase !== 'dispatch') return undefined;
        const grant = input.grant();
        const form = new URLSearchParams();
        form.set('grant_type', grant.grantType);
        if (grant.grantType === 'authorization_code') {
          form.set('code', grant.code); form.set('redirect_uri', grant.redirectUri); form.set('client_id', grant.clientId); form.set('code_verifier', grant.codeVerifier);
        } else {
          form.set('refresh_token', grant.refreshToken); form.set('client_id', grant.clientId);
        }
        if (grant.resource) form.set('resource', grant.resource);
        // RFC 6749 §2.3.1: a confidential client authenticates with HTTP Basic.
        const headers: Record<string, string> = grant.clientSecret
          ? { authorization: `Basic ${Buffer.from(`${grant.clientId}:${grant.clientSecret}`).toString('base64')}` } : {};
        return { headers, body: form.toString() };
      } });
  } catch (error) {
    if (error instanceof OutboundRequestRefused) throw error;
    throw new StudioMcpRemoteError('token');
  }
  if (response.status < 200 || response.status >= 300) throw new StudioMcpRemoteError('token');
  let json: Record<string, unknown>;
  try {
    const parsed = response.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape');
    json = parsed as Record<string, unknown>;
  } catch { throw new StudioMcpRemoteError('token'); }
  const access = json.access_token; const refresh = json.refresh_token;
  if (typeof access !== 'string' || !access || access.length > MAX_TOKEN_LENGTH || /[\s\0]/.test(access)
    || (refresh !== undefined && refresh !== null && (typeof refresh !== 'string' || !refresh || refresh.length > MAX_TOKEN_LENGTH || /[\s\0]/.test(refresh)))) {
    throw new StudioMcpRemoteError('token');
  }
  const expiresIn = json.expires_in;
  return {
    accessToken: access, ...(typeof refresh === 'string' ? { refreshToken: refresh } : {}),
    tokenType: untrustedTokenType(json.token_type),
    expiresInSeconds: typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0 ? Math.min(expiresIn, 366 * 24 * 3600) : null,
    untrustedScope: typeof json.scope === 'string' ? json.scope.slice(0, 8192) : null,
  };
}
