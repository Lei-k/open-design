/**
 * Account remote MCP servers on multi-user Web (#62, S60; owner decision 2A,
 * 2026-10-10): each account manages its own list of REMOTE MCP servers
 * (streamable HTTP or SSE, optional static headers, optional OAuth). stdio
 * servers — anything that would run a command on the deployment host — are
 * refused on multi-user Web; desktop/single-user keeps its existing
 * `McpServerConfig` behaviour unchanged.
 *
 * Header values and OAuth tokens are write-only: they are sealed per account
 * and no response carries them. Reads show header names, a configured flag and
 * (for long values only) the last four characters. Another account's server is
 * unaddressable — identical to a server that does not exist — and administrators
 * have no read bypass. Run-time use is bound to the run owner’s selected usable servers.
 */
import type { McpTemplate, UpdateMcpServersRequest } from './mcp.js';

export type StudioMcpTransport = 'http' | 'sse';
export type StudioMcpAuthMode = 'none' | 'oauth';

export const STUDIO_MCP_LIMITS = {
  maxServers: 16,
  maxHeaders: 16,
  maxHeaderNameLength: 64,
  maxHeaderValueLength: 4096,
  maxUrlLength: 2048,
  maxLabelLength: 100,
} as const;

/** Same slug rule as the desktop config: it names the server to agents later. */
export const STUDIO_MCP_SERVER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** Header names the account may pin; hop-by-hop and connection-level headers are refused. */
export const STUDIO_MCP_HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
export const STUDIO_MCP_FORBIDDEN_HEADERS: readonly string[] = [
  'host', 'content-length', 'content-type', 'connection', 'transfer-encoding', 'upgrade', 'te', 'trailer',
  'keep-alive', 'proxy-authorization', 'proxy-connection', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'cookie',
];

export const STUDIO_MCP_STDIO_UNAVAILABLE_REASON =
  'stdio MCP servers run a command on the deployment host and are not allowed on multi-user Web; add a remote (HTTP or SSE) server instead';
export const STUDIO_MCP_INSTALL_UNAVAILABLE_REASON =
  'the OpenDesign MCP server is a stdio server installed into the deployment host\'s coding-agent configuration; stdio MCP is not allowed on multi-user Web';
export const STUDIO_MCP_NOT_IN_RUNS_REASON =
  'account MCP servers are configurable in Settings but not yet usable in runs or routines';

/** Redacted header: never the value. `tail` is the last four characters of values of 16+ characters, else empty. */
export interface StudioMcpHeaderSummary {
  name: string;
  configured: true;
  tail: string;
}

export type StudioMcpOAuthState = 'not-required' | 'needs-auth' | 'connected' | 'expired';

export interface StudioMcpServer {
  id: string;
  label: string | null;
  templateId: string | null;
  transport: StudioMcpTransport;
  url: string;
  enabled: boolean;
  authMode: StudioMcpAuthMode;
  headers: StudioMcpHeaderSummary[];
  oauth: { status: StudioMcpOAuthState; expiresAt: number | null; scope: string | null; connectedAt: number | null };
  /** The last connection test; codes only. */
  lastTest: { ok: boolean; at: number; code: string | null } | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface StudioMcpServersResponse {
  servers: StudioMcpServer[];
  /** Remote (HTTP/SSE) built-in presets only. */
  templates: McpTemplate[];
  limits: typeof STUDIO_MCP_LIMITS;
  stdio: { available: false; reason: string };
  runs: { available: boolean; reason: string | null };
}

export interface StudioMcpServerResponse {
  server: StudioMcpServer;
}

/** `transport` accepts `streamable-http` as an alias of `http`. Header values are write-only. */
export interface CreateStudioMcpServerRequest {
  id: string;
  url: string;
  transport?: StudioMcpTransport | 'streamable-http';
  label?: string | null;
  templateId?: string | null;
  enabled?: boolean;
  authMode?: StudioMcpAuthMode;
  headers?: Record<string, string>;
}

/** Revision-checked. In `headers` a string sets a value, `null` removes it, an absent name keeps it. */
export interface UpdateStudioMcpServerRequest {
  revision: number;
  url?: string;
  transport?: StudioMcpTransport | 'streamable-http';
  label?: string | null;
  enabled?: boolean;
  authMode?: StudioMcpAuthMode;
  headers?: Record<string, string | null>;
}

/**
 * Import uses the desktop `PUT /api/mcp/servers` body. On multi-user Web it
 * upserts the listed remote servers for the actor (unlisted servers are kept);
 * any stdio entry refuses the whole request.
 */
export type ImportStudioMcpServersRequest = UpdateMcpServersRequest;
export interface ImportStudioMcpServersResponse extends StudioMcpServersResponse {
  imported: string[];
}

export interface StudioMcpTestResult {
  ok: boolean;
  /** Fixed code: null when ok; otherwise a refusal or outcome category. */
  code: string | null;
  httpStatus: number | null;
  needsAuth: boolean;
  serverName: string | null;
  protocolVersion: string | null;
}
export interface StudioMcpTestResponse {
  server: StudioMcpServer;
  result: StudioMcpTestResult;
}

export interface StudioMcpOAuthRequest {
  serverId: string;
}
export interface StudioMcpOAuthStartResponse {
  authorizeUrl: string;
  redirectUri: string;
  expiresAt: string;
}
export interface StudioMcpOAuthStatusResponse {
  connected: boolean;
  status: StudioMcpOAuthState;
  expiresAt: number | null;
  scope: string | null;
  savedAt: number | null;
}

/** details.reason of `MULTIUSER_MCP_AUTHORITY_CHANGED`. */
export type StudioMcpAuthorityRefusal = 'account' | 'session' | 'server-changed';
/** details.reason of `MULTIUSER_MCP_AUTHORIZATION_INVALID`. */
export type StudioMcpCallbackRefusal = 'state' | 'expired' | 'replayed' | 'session' | 'account' | 'server-changed' | 'provider' | 'not-completed';
/** details.reason of `MULTIUSER_MCP_OUTBOUND_REFUSED`: the SSRF guard refused the destination. */
export type StudioMcpOutboundRefusal = 'scheme' | 'credentials' | 'host' | 'address' | 'redirect' | 'timeout' | 'size' | 'network';

/** Daemon-mediated run tools, identical on personal Codex and both Responses sources. */
export interface StudioMcpTool { name: string; description: string; inputSchema: Record<string, unknown> }
export interface StudioMcpToolsResponse { servers: Array<{ serverId: string; tools: StudioMcpTool[] }> }
export interface StudioMcpToolCallRequest { serverId: string; toolName: string; input: Record<string, unknown> }
export interface StudioMcpToolCallResponse { serverId: string; toolName: string; output: unknown }
