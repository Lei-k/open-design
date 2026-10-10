// @vitest-environment jsdom
// #62 S60 (owner decision 2A): Settings → MCP servers for Web accounts. Each
// account adds its own remote (HTTP/SSE) servers; header values are write-only
// and never remain in the DOM; OAuth opens the provider in a new tab; stdio is
// not offered and its reason is shown; servers are not yet usable in runs.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { STUDIO_MCP_LIMITS, STUDIO_PARITY_LANES, type AuthAccount, type StudioMcpServer, type StudioRuntimeCapabilities } from '@open-design/contracts';
import { CookieSession } from '../../src/multiuser/session';
import { StudioCapabilitiesProvider } from '../../src/runtime/studio-capabilities';
import { StudioMcpServers } from '../../src/runtime/StudioMcpServers';
import { studioRequestAvailable } from '../../src/runtime/studio-transport';

const SECRET = 'SNTLWEB_header_value_0123456789abcdef';
const capabilities = (mcpServers = true): StudioRuntimeCapabilities => ({ schemaVersion: 1, shell: 'studio', mcpServers,
  features: Object.fromEntries(STUDIO_PARITY_LANES.map(({ id }) => [id, id === 'settings'
    ? { status: 'pilot', reason: 'Pilot' } : { status: 'unavailable', reason: 'Pending' }])) as StudioRuntimeCapabilities['features'] });
const server = (id: string, extra: Partial<StudioMcpServer> = {}): StudioMcpServer => ({ id, label: null, templateId: null, transport: 'http',
  url: `https://${id}.example.com/mcp`, enabled: true, authMode: 'none', headers: [], oauth: { status: 'not-required', expiresAt: null, scope: null, connectedAt: null },
  lastTest: null, revision: 1, createdAt: 1, updatedAt: 1, ...extra });

interface Fake { servers: StudioMcpServer[]; calls: Array<{ method: string; url: string; body: unknown }>; listFails?: boolean; createFails?: string }
function fakeDaemon(fake: Fake) {
  const account: AuthAccount = { id: 'A', username: 'A', role: 'user', active: true, passwordState: 'set', createdAt: 1, updatedAt: 1 };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    fake.calls.push({ method, url, body });
    if (url === '/api/auth/me') return Response.json({ account, studio: capabilities(), studioRevision: 1, studioMessageIdPrefix: 'mua_0123456789abcdef01234567_' });
    if (url === '/api/mcp/servers' && method === 'GET') {
      if (fake.listFails) return Response.json({ error: { code: 'INTERNAL_ERROR' } }, { status: 500 });
      return Response.json({ servers: fake.servers, templates: [], limits: STUDIO_MCP_LIMITS, stdio: { available: false, reason: 'stdio refused' },
        runs: { available: false, reason: 'not in runs' } });
    }
    if (url === '/api/multiuser/mcp/servers' && method === 'POST') {
      if (fake.createFails) return Response.json({ error: { code: fake.createFails, message: 'refused', details: { reason: 'address' } } }, { status: 400 });
      const made = server(body.id, { url: body.url, transport: body.transport, authMode: body.authMode,
        headers: Object.entries(body.headers ?? {}).map(([name, value]) => ({ name, configured: true as const, tail: String(value).slice(-4) })),
        oauth: { status: body.authMode === 'oauth' ? 'needs-auth' : 'not-required', expiresAt: null, scope: null, connectedAt: null } });
      fake.servers.push(made);
      return Response.json({ server: made }, { status: 201 });
    }
    const test = /^\/api\/multiuser\/mcp\/servers\/([a-z0-9_-]+)\/test$/.exec(url);
    if (test) return Response.json({ server: fake.servers.find((item) => item.id === test[1]), result: { ok: false, code: 'unauthorized', httpStatus: 401, needsAuth: true, serverName: null, protocolVersion: null } });
    if (url === '/api/mcp/oauth/start') return Response.json({ authorizeUrl: 'https://auth.example.com/authorize?state=opaque', redirectUri: 'https://app/api/mcp/oauth/callback', expiresAt: new Date().toISOString() });
    if (url === '/api/mcp/oauth/disconnect') {
      const found = fake.servers.find((item) => item.id === body.serverId)!;
      found.oauth = { status: 'needs-auth', expiresAt: null, scope: null, connectedAt: null };
      return Response.json({ ok: true });
    }
    const one = /^\/api\/multiuser\/mcp\/servers\/([a-z0-9_-]+)$/.exec(url);
    if (one && method === 'DELETE') { fake.servers = fake.servers.filter((item) => item.id !== one[1]); return Response.json({ ok: true }); }
    return Response.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
  }));
  return account;
}
async function mount(fake: Fake) {
  const account = fakeDaemon(fake);
  const session = new CookieSession();
  await session.verify();
  const state = session.snapshot();
  render(<StudioCapabilitiesProvider session={session} generation={state.generation} actor={account} capabilities={state.studio!}>
    <StudioMcpServers />
  </StudioCapabilitiesProvider>);
  return session;
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('shows the empty state, the stdio-unavailable reason and the not-in-runs note, with no stdio controls', async () => {
  const fake: Fake = { servers: [], calls: [] };
  const session = await mount(fake);
  await waitFor(() => expect(screen.getByTestId('studio-mcp-empty')).toBeTruthy());
  expect(screen.getByTestId('studio-mcp-stdio-unavailable').textContent).toMatch(/stdio/i);
  expect(screen.getByTestId('studio-mcp-run-available').textContent).toMatch(/composer or routine/);
  const transport = screen.getByTestId('studio-mcp-add-transport') as HTMLSelectElement;
  expect([...transport.options].map((option) => option.value)).toEqual(['http', 'sse']);
  for (const control of document.querySelectorAll('input, select, textarea, label')) {
    expect(`${control.getAttribute('data-testid') ?? ''} ${control.getAttribute('aria-label') ?? ''} ${control.getAttribute('placeholder') ?? ''} ${control.tagName === 'LABEL' ? control.textContent : ''}`)
      .not.toMatch(/command|args|argument|environment|stdio/i);
  }
  session.dispose();
});

it('adds a remote server; the header value is sent once and never stays in the DOM', async () => {
  const fake: Fake = { servers: [], calls: [] };
  const session = await mount(fake);
  await waitFor(() => screen.getByTestId('studio-mcp-add'));
  fireEvent.change(screen.getByTestId('studio-mcp-add-id'), { target: { value: 'docs' } });
  fireEvent.change(screen.getByTestId('studio-mcp-add-url'), { target: { value: 'https://docs.example.com/mcp' } });
  fireEvent.click(screen.getByTestId('studio-mcp-add-header'));
  fireEvent.change(screen.getByTestId('studio-mcp-header-name-0'), { target: { value: 'Authorization' } });
  fireEvent.change(screen.getByTestId('studio-mcp-header-value-0'), { target: { value: SECRET } });
  expect((screen.getByTestId('studio-mcp-header-value-0') as HTMLInputElement).type).toBe('password');
  fireEvent.click(screen.getByTestId('studio-mcp-add-submit'));
  await waitFor(() => expect(screen.getByTestId('studio-mcp-server-docs')).toBeTruthy());
  const create = fake.calls.find((call) => call.method === 'POST' && call.url === '/api/multiuser/mcp/servers');
  expect(create?.body).toEqual({ id: 'docs', url: 'https://docs.example.com/mcp', transport: 'http', authMode: 'none', headers: { Authorization: SECRET } });
  expect(screen.queryByTestId('studio-mcp-header-value-0')).toBeNull();
  expect(within(screen.getByTestId('studio-mcp-server-docs')).getByText(/Authorization · ••••cdef/)).toBeTruthy();
  expect(document.body.innerHTML).not.toContain(SECRET);
  for (const input of document.querySelectorAll('input')) expect((input as HTMLInputElement).value).not.toContain(SECRET);
  session.dispose();
});

it('opens OAuth in a new tab when sign-in is needed and offers sign-out once connected', async () => {
  const open = vi.spyOn(window, 'open').mockImplementation(() => null);
  const fake: Fake = { calls: [], servers: [
    server('needs', { authMode: 'oauth', oauth: { status: 'needs-auth', expiresAt: null, scope: null, connectedAt: null } }),
    server('linked', { authMode: 'oauth', oauth: { status: 'connected', expiresAt: null, scope: 'read', connectedAt: 1 } }),
  ] };
  const session = await mount(fake);
  await waitFor(() => screen.getByTestId('studio-mcp-connect-needs'));
  expect(screen.getByTestId('studio-mcp-oauth-needs').textContent).toBe('Sign-in needed');
  expect(screen.getByTestId('studio-mcp-oauth-linked').textContent).toBe('Signed in');
  fireEvent.click(screen.getByTestId('studio-mcp-connect-needs'));
  await waitFor(() => expect(open).toHaveBeenCalledWith('https://auth.example.com/authorize?state=opaque', '_blank', 'noopener'));
  fireEvent.click(screen.getByTestId('studio-mcp-disconnect-linked'));
  await waitFor(() => expect(screen.getByTestId('studio-mcp-oauth-linked').textContent).toBe('Sign-in needed'));
  session.dispose();
});

it('shows typed errors: a failed list, a refused address and a failed connection test', async () => {
  const failing: Fake = { servers: [], calls: [], listFails: true };
  const first = await mount(failing);
  await waitFor(() => expect(screen.getByTestId('studio-mcp-error')).toBeTruthy());
  first.dispose(); cleanup(); vi.unstubAllGlobals();
  const fake: Fake = { servers: [server('probe')], calls: [], createFails: 'MULTIUSER_MCP_OUTBOUND_REFUSED' };
  const session = await mount(fake);
  await waitFor(() => screen.getByTestId('studio-mcp-test-button-probe'));
  fireEvent.click(screen.getByTestId('studio-mcp-test-button-probe'));
  await waitFor(() => expect(screen.getByTestId('studio-mcp-test-probe').textContent).toBe('Connection failed (unauthorized)'));
  fireEvent.change(screen.getByTestId('studio-mcp-add-id'), { target: { value: 'meta' } });
  fireEvent.change(screen.getByTestId('studio-mcp-add-url'), { target: { value: 'http://169.254.169.254/' } });
  fireEvent.click(screen.getByTestId('studio-mcp-add-submit'));
  await waitFor(() => expect(screen.getByTestId('studio-mcp-notice').textContent).toMatch(/not allowed or cannot be reached/));
  session.dispose();
});

it('opens the MCP routes only with the settings lane and the mcpServers capability; never stdio installs or the callback', () => {
  const settings = (lane: string) => lane === 'settings';
  for (const [method, path] of [['GET', '/api/mcp/servers'], ['PUT', '/api/mcp/servers'], ['POST', '/api/multiuser/mcp/servers'],
    ['PATCH', '/api/multiuser/mcp/servers/docs'], ['DELETE', '/api/multiuser/mcp/servers/docs'], ['POST', '/api/multiuser/mcp/servers/docs/test'],
    ['POST', '/api/mcp/oauth/start'], ['POST', '/api/mcp/oauth/disconnect'], ['GET', '/api/mcp/oauth/status'], ['POST', '/api/multiuser/mcp/oauth/refresh']] as const) {
    expect(studioRequestAvailable(method, path, settings, false, false, false, true), `${method} ${path}`).toBe(true);
    expect(studioRequestAvailable(method, path, settings, false, false, false, false), `${method} ${path}`).toBe(false);
  }
  for (const [method, path] of [['GET', '/api/mcp/install-info'], ['POST', '/api/mcp/install/codex'], ['GET', '/api/mcp/oauth/callback'],
    ['POST', '/api/mcp/servers'], ['DELETE', '/api/mcp/servers']] as const) {
    expect(studioRequestAvailable(method, path, () => true, true, true, true, true), `${method} ${path}`).toBe(false);
  }
});
