import { afterEach, expect, it, vi } from 'vitest';
import { fetchMcpServers } from '../../src/state/mcp';
afterEach(() => { vi.unstubAllGlobals(); });
it('S61 composer and routine server source exposes only enabled connected owner servers, without credentials', async () => {

  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ runs: { available: true, reason: null }, servers: [
    { id: 'ready', transport: 'http', enabled: true, authMode: 'none', headers: [{ name: 'Authorization', tail: '1234' }], oauth: { status: 'not-required' } },
    { id: 'disabled', transport: 'http', enabled: false, authMode: 'none', oauth: { status: 'not-required' } },
    { id: 'needs', transport: 'sse', enabled: true, authMode: 'oauth', oauth: { status: 'needs-auth' } },
    { id: 'expired', transport: 'http', enabled: true, authMode: 'oauth', oauth: { status: 'expired' } },
    { id: 'connected', transport: 'sse', enabled: true, authMode: 'oauth', oauth: { status: 'connected' } },
  ], templates: [] })));
  const data = await fetchMcpServers();
  expect(data?.servers.map((server) => server.id)).toEqual(['ready', 'connected']);
  expect(JSON.stringify(data)).not.toContain('Authorization');
});
