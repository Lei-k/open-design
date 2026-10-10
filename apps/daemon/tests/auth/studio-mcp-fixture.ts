// S60 test fixture: a loopback remote MCP server plus its OAuth authorization
// server. The daemon reaches it only through the explicit, programmatic
// `testMcpOutbound` injection (an injected resolver for `*.fixture.test` and an
// exact extra address); production has no such switch.
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export const MCP_HEADER_SENTINEL = 'SNTLMCP_header_value_0123456789abcdef';
export const MCP_TOKEN_SENTINEL = 'SNTLMCP_access_token_0123456789abcdef';
export const MCP_REFRESH_SENTINEL = 'SNTLMCP_refresh_token_0123456789abcdef';
export const MCP_CLIENT_SECRET_SENTINEL = 'SNTLMCP_client_secret_0123456789abcd';

export interface McpFixture {
  port: number;
  url(path?: string, host?: string): string;
  requests: Array<{ method: string; path: string; host: string; authorization?: string; apiKey?: string; body: string }>;
  state: {
    accessToken: string; refreshToken: string; issuer: string | null; authorizationEndpoint: string | null;
    holdMcp: boolean; holdToken: boolean; tokenFails: boolean; releases: Array<() => void>;
  };
  resolve(hostname: string): Promise<string[]>;
  allowAddress(address: string): boolean;
  close(): Promise<void>;
}

export const MCP_FIXTURE_DNS: Record<string, string[]> = {
  'private.blocked.test': ['10.0.0.5'],
  'meta.blocked.test': ['169.254.169.254'],
  'mixed.blocked.test': ['93.184.216.34', '192.168.1.10'],
  'mapped.blocked.test': ['::ffff:127.0.0.1'],
};

export async function startMcpFixture(): Promise<McpFixture> {
  const requests: McpFixture['requests'] = [];
  const state: McpFixture['state'] = { accessToken: MCP_TOKEN_SENTINEL, refreshToken: MCP_REFRESH_SENTINEL, issuer: null, authorizationEndpoint: null,
    holdMcp: false, holdToken: false, tokenFails: false, releases: [] };
  let refreshCount = 0;
  const hold = () => new Promise<void>((resolve) => { state.releases.push(resolve); });
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => { void (async () => {
      const url = new URL(req.url ?? '/', 'http://fixture');
      requests.push({ method: req.method ?? '', path: url.pathname, host: req.headers.host ?? '', ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
        ...(typeof req.headers['x-api-key'] === 'string' ? { apiKey: req.headers['x-api-key'] } : {}), body });
      const json = (value: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
      const origin = `http://${req.headers.host}`;
      if (url.pathname === '/mcp' && req.method === 'POST') {
        if (state.holdMcp) await hold();
        const authorized = req.headers['x-api-key'] === MCP_HEADER_SENTINEL || req.headers.authorization === `Bearer ${state.accessToken}`;
        if (!authorized) { res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` }); return void res.end(`denied ${body}`); }
        return json({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fixture-mcp', version: '1' } } });
      }
      if (url.pathname === '/mcp-events' && req.method === 'POST') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        return void res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26', serverInfo: { name: 'fixture-events' } } })}\n\n`);
      }
      if (url.pathname === '/sse' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        return void res.write('event: endpoint\ndata: /messages?sessionId=fixture\n\n');
      }
      if (url.pathname === '/redirect') { res.writeHead(307, { location: 'http://private.blocked.test/mcp' }); return void res.end(); }
      if (url.pathname === '/redirect-get') { res.writeHead(302, { location: 'http://meta.blocked.test/latest/meta-data/' }); return void res.end(); }
      if (url.pathname === '/huge') { res.writeHead(200, { 'content-type': 'application/json' }); return void res.end(Buffer.alloc(2 * 1024 * 1024, 32)); }
      if (url.pathname === '/hang') return; // never answers
      if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
        return json({ resource: `${origin}/mcp`, authorization_servers: [state.issuer ?? origin], scopes_supported: ['mcp:read'] });
      }
      if (url.pathname.startsWith('/.well-known/oauth-authorization-server') || url.pathname.startsWith('/.well-known/openid-configuration')) {
        return json({ issuer: origin, authorization_endpoint: state.authorizationEndpoint ?? `${origin}/authorize`, token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`, code_challenge_methods_supported: ['S256'] });
      }
      if (url.pathname === '/register' && req.method === 'POST') {
        return json({ client_id: `fixture-client-${requests.filter((item) => item.path === '/register').length}`, client_secret: MCP_CLIENT_SECRET_SENTINEL }, 201);
      }
      if (url.pathname === '/token' && req.method === 'POST') {
        if (state.holdToken) await hold();
        const form = new URLSearchParams(body);
        if (state.tokenFails) return json({ error: 'invalid_grant', error_description: `echo ${body}` }, 400);
        if (form.get('grant_type') === 'authorization_code' && form.get('code') === 'good-code' && form.get('code_verifier')) {
          return json({ access_token: state.accessToken, refresh_token: state.refreshToken, token_type: 'Bearer', expires_in: 3600, scope: 'mcp:read' });
        }
        if (form.get('grant_type') === 'refresh_token' && form.get('refresh_token') === state.refreshToken) {
          refreshCount++;
          state.accessToken = `${MCP_TOKEN_SENTINEL}_r${refreshCount}`;
          return json({ access_token: state.accessToken, token_type: 'Bearer', expires_in: 3600 });
        }
        return json({ error: 'invalid_grant' }, 400);
      }
      res.statusCode = 404; res.end();
    })(); });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port, requests, state,
    url: (path = '/mcp', host = 'mcp.fixture.test') => `http://${host}:${port}${path}`,
    resolve: async (hostname) => (hostname.endsWith('.fixture.test') ? ['127.0.0.1'] : MCP_FIXTURE_DNS[hostname] ?? []),
    allowAddress: (address) => address === '127.0.0.1',
    close: async () => { for (const release of state.releases.splice(0)) release(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); },
  };
}
