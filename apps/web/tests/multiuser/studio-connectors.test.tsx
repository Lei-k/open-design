// @vitest-environment jsdom
// #62 S58: Settings → Connectors for Web accounts. Administrators manage the
// company Composio key write-only; members see who can fix a missing key; every
// account connects, sees and disconnects only its own apps through the shared
// ConnectorsBrowser. No key material may remain in the DOM.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { STUDIO_PARITY_LANES, type AuthAccount, type ConnectorDetail, type StudioComposioConfigResponse, type StudioRuntimeCapabilities } from '@open-design/contracts';
import { CookieSession } from '../../src/multiuser/session';
import { StudioCapabilitiesProvider } from '../../src/runtime/studio-capabilities';
import { StudioConnectors } from '../../src/runtime/StudioConnectors';
import { CONNECTORS_CHANGED_EVENT } from '../../src/components/connectors-events';
import { studioRequestAvailable } from '../../src/runtime/studio-transport';

const KEY = 'ak_web_company_composio_key_5678';
const capabilities = (connectors = true): StudioRuntimeCapabilities => ({ schemaVersion: 1, shell: 'studio', connectors,
  features: Object.fromEntries(STUDIO_PARITY_LANES.map(({ id }) => [id, id === 'settings'
    ? { status: 'pilot', reason: 'Pilot' } : { status: 'unavailable', reason: 'Pending' }])) as StudioRuntimeCapabilities['features'] });

interface Fake { admin: boolean; configured: boolean; revision: number; tail: string; status: Record<string, ConnectorDetail['status']>;
  calls: Array<{ method: string; url: string; body: unknown }>; connectFails?: boolean; configFails?: boolean }
function fakeDaemon(fake: Fake) {
  const account: AuthAccount = { id: 'A', username: 'A', role: fake.admin ? 'admin' : 'user', active: true, passwordState: 'set', createdAt: 1, updatedAt: 1 };
  const connector = (id: string, name: string): ConnectorDetail => ({ id, name, provider: 'composio', category: 'Developer', tools: [],
    status: fake.status[id] ?? 'available', ...(fake.status[id] === 'connected' ? { accountLabel: `${id}@apps.example` } : {}),
    auth: { provider: 'composio', configured: fake.configured } });
  const list = () => [connector('github', 'GitHub'), connector('notion', 'Notion')];
  const config = (): StudioComposioConfigResponse => ({ configured: fake.configured, apiKeyTail: fake.admin && fake.configured ? fake.tail : '',
    revision: fake.revision, credentialRevision: fake.revision, canManage: fake.admin });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    fake.calls.push({ method, url, body });
    if (url === '/api/auth/me') return Response.json({ account, studio: capabilities(), studioRevision: 1, studioMessageIdPrefix: 'mua_0123456789abcdef01234567_' });
    if (url === '/api/connectors/composio/config' && method === 'GET') return fake.configFails ? Response.json({}, { status: 500 }) : Response.json(config());
    if (url === '/api/connectors/composio/config' && method === 'PUT') {
      if (body.revision !== fake.revision) return Response.json({ error: { code: 'CONFLICT', message: 'stale' } }, { status: 409 });
      fake.revision += 1; fake.configured = body.apiKey !== null; fake.tail = body.apiKey ? String(body.apiKey).slice(-4) : '';
      return Response.json(config());
    }
    if (url === '/api/connectors' || url.startsWith('/api/connectors/discovery')) return Response.json({ connectors: list() });
    if (url === '/api/connectors/status') return Response.json({ statuses: Object.fromEntries(list().map((item) => [item.id, { status: item.status, ...(item.accountLabel ? { accountLabel: item.accountLabel } : {}) }])) });
    if (url === '/api/connectors/auth-configs/prepare') return Response.json({ results: { [body.connectorIds[0]]: { status: 'ready', authConfigId: 'ac' } } });
    const connect = /^\/api\/connectors\/([a-z_]+)\/connect$/.exec(url);
    if (connect) {
      if (fake.connectFails) return Response.json({ error: { code: 'MULTIUSER_CONNECTOR_PROVIDER_FAILED', message: 'Composio request failed' } }, { status: 502 });
      return Response.json({ connector: connector(connect[1]!, 'GitHub'), auth: { kind: 'redirect_required', redirectUrl: 'https://backend.composio.dev/oauth/start/opaque', expiresAt: new Date(Date.now() + 600_000).toISOString() } });
    }
    const remove = /^\/api\/connectors\/([a-z_]+)\/connection$/.exec(url);
    if (remove && method === 'DELETE') { fake.status[remove[1]!] = 'available'; return Response.json({ connector: connector(remove[1]!, 'GitHub') }); }
    const cancel = /^\/api\/connectors\/([a-z_]+)\/authorization\/cancel$/.exec(url);
    if (cancel) return Response.json({ connector: connector(cancel[1]!, 'GitHub') });
    const detail = /^\/api\/connectors\/([a-z_]+)(?:\?.*)?$/.exec(url);
    if (detail) return Response.json({ connector: list().find((item) => item.id === detail[1]) ?? connector(detail[1]!, detail[1]!) });
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
    <StudioConnectors />
  </StudioCapabilitiesProvider>);
  return session;
}
const card = (id: string) => document.querySelector(`[data-connector-id="${id}"]`) as HTMLElement;
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('tells a member without a company key to ask an administrator and offers no controls', async () => {
  const fake: Fake = { admin: false, configured: false, revision: 0, tail: '', status: {}, calls: [] };
  const session = await mount(fake);
  await waitFor(() => expect(screen.getByTestId('studio-connectors-unavailable').textContent).toContain('ask an administrator'));
  expect(screen.queryByTestId('studio-connectors-key')).toBeNull();
  expect(screen.queryByRole('button')).toBeNull();
  expect(fake.calls.filter((call) => call.url.startsWith('/api/connectors')).map((call) => call.url)).toEqual(['/api/connectors/composio/config']);
  session.dispose();
});

it('lets an administrator set the key write-only, then shows the catalog; the key never stays in the DOM', async () => {
  const dispatched = vi.spyOn(window, 'dispatchEvent');
  const fake: Fake = { admin: true, configured: false, revision: 0, tail: '', status: {}, calls: [] };
  const session = await mount(fake);
  await waitFor(() => expect(screen.getByTestId('studio-connectors-unavailable').textContent).toContain('Add it above'));
  expect((screen.getByTestId('studio-connectors-key-save') as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByTestId('studio-connectors-key-input'), { target: { value: KEY } });
  await act(async () => { fireEvent.click(screen.getByTestId('studio-connectors-key-save')); });
  await waitFor(() => expect(screen.getByTestId('studio-connectors-key-saved').textContent).toContain('5678'));
  expect(fake.calls.filter((call) => call.method === 'PUT')).toEqual([{ method: 'PUT', url: '/api/connectors/composio/config', body: { revision: 0, apiKey: KEY } }]);
  expect((screen.getByTestId('studio-connectors-key-input') as HTMLInputElement).value).toBe('');
  expect(dispatched.mock.calls.some(([event]) => event.type === CONNECTORS_CHANGED_EVENT)).toBe(true);
  await waitFor(() => expect(card('github')).toBeTruthy());
  expect(screen.getByTestId('studio-connectors-not-in-runs').textContent).toContain('can be selected for runs');
  expect(document.documentElement.outerHTML).not.toContain(KEY);
  // Clearing must invalidate the composer even when no app status changed.
  const beforeClear = dispatched.mock.calls.filter(([event]) => event.type === CONNECTORS_CHANGED_EVENT).length;
  // Clearing needs an explicit confirmation and returns to the unavailable state.
  fireEvent.click(screen.getByTestId('studio-connectors-key-clear'));
  await act(async () => { fireEvent.click(screen.getByTestId('studio-connectors-clear-commit')); });
  await waitFor(() => expect(screen.getByTestId('studio-connectors-unavailable')).toBeTruthy());
  expect(dispatched.mock.calls.filter(([event]) => event.type === CONNECTORS_CHANGED_EVENT).length).toBeGreaterThan(beforeClear);
  expect(fake.calls.filter((call) => call.method === 'PUT').at(-1)!.body).toEqual({ revision: 1, apiKey: null });
  expect(card('github')).toBeNull();
  session.dispose();
});

it('a stale administrator write reports the conflict and reloads instead of retrying', async () => {
  const fake: Fake = { admin: true, configured: true, revision: 3, tail: '1111', status: {}, calls: [] };
  const session = await mount(fake);
  await waitFor(() => expect(screen.getByTestId('studio-connectors-key-saved')).toBeTruthy());
  fake.revision = 4;
  fireEvent.change(screen.getByTestId('studio-connectors-key-input'), { target: { value: KEY } });
  await act(async () => { fireEvent.click(screen.getByTestId('studio-connectors-key-save')); });
  await waitFor(() => expect(screen.getByTestId('studio-connectors-notice').textContent).toContain('changed elsewhere'));
  expect(fake.calls.filter((call) => call.method === 'PUT')).toHaveLength(1);
  expect((screen.getByTestId('studio-connectors-key-input') as HTMLInputElement).value).toBe('');
  expect(document.documentElement.outerHTML).not.toContain(KEY);
  session.dispose();
});

it('connects, shows connecting then connected, and disconnects the member\'s own app', async () => {
  const fake: Fake = { admin: false, configured: true, revision: 1, tail: '5678', status: {}, calls: [] };
  const open = vi.spyOn(window, 'open').mockReturnValue(null);
  const session = await mount(fake);
  await waitFor(() => expect(card('github')).toBeTruthy());
  expect(screen.queryByTestId('studio-connectors-key')).toBeNull();
  expect(document.body.textContent).not.toContain('5678');
  const connectButton = within(card('github')).getByRole('button', { name: 'Connect' });
  await act(async () => { fireEvent.click(connectButton); });
  await waitFor(() => expect(fake.calls.some((call) => call.url === '/api/connectors/github/connect' && call.method === 'POST')).toBe(true));
  // Studio opens the provider in a new tab; it never asks the daemon to open a host browser.
  expect(open).toHaveBeenCalledWith('https://backend.composio.dev/oauth/start/opaque', '_blank');
  expect(fake.calls.some((call) => call.url === '/api/system/open-external')).toBe(false);
  await waitFor(() => expect(within(card('github')).getAllByLabelText('Waiting for authorization...').length).toBeGreaterThan(0));
  // The callback tab posts back; the card picks up the account's own connection.
  fake.status.github = 'connected';
  await act(async () => { window.dispatchEvent(new MessageEvent('message', { data: { type: 'open-design:connector-connected', connectorId: 'github' }, origin: window.location.origin })); });
  await waitFor(() => expect(within(card('github')).getByRole('button', { name: 'Disconnect' })).toBeTruthy());
  await act(async () => { fireEvent.click(within(card('github')).getByRole('button', { name: 'Disconnect' })); });
  await waitFor(() => expect(within(card('github')).getByRole('button', { name: 'Connect' })).toBeTruthy());
  expect(fake.calls.some((call) => call.url === '/api/connectors/github/connection' && call.method === 'DELETE')).toBe(true);
  // No logo proxy request in Studio: the deployment does not fetch third-party logos.
  expect(document.querySelector('img[src*="/api/connectors/logos/"]')).toBeNull();
  session.dispose();
});

it('shows a typed provider failure on the card and a load failure with a retry', async () => {
  const fake: Fake = { admin: false, configured: true, revision: 1, tail: '', status: {}, calls: [], connectFails: true };
  vi.spyOn(window, 'open').mockReturnValue(null);
  const session = await mount(fake);
  await waitFor(() => expect(card('github')).toBeTruthy());
  await act(async () => { fireEvent.click(within(card('github')).getByRole('button', { name: 'Connect' })); });
  await waitFor(() => expect(document.body.textContent).toContain('Composio request failed'));
  session.dispose();
  cleanup();
  const failing: Fake = { admin: false, configured: true, revision: 1, tail: '', status: {}, calls: [], configFails: true };
  const second = await mount(failing);
  await waitFor(() => expect(screen.getByTestId('studio-connectors-error')).toBeTruthy());
  second.dispose();
});

it('opens exactly the reviewed connector routes in the transport, and only with the settings lane and capability', () => {
  const settings = (lane: string) => lane === 'settings';
  const open = (method: string, path: string, connectors = true, usable: (lane: string) => boolean = settings) =>
    studioRequestAvailable(method, path, usable as never, false, false, connectors);
  for (const [method, path] of [['GET', '/api/connectors'], ['GET', '/api/connectors/status'], ['GET', '/api/connectors/discovery'],
    ['GET', '/api/connectors/github'], ['GET', '/api/connectors/composio/config'], ['PUT', '/api/connectors/composio/config'],
    ['POST', '/api/connectors/auth-configs/prepare'], ['POST', '/api/connectors/github/connect'],
    ['POST', '/api/connectors/github/authorization/cancel'], ['DELETE', '/api/connectors/github/connection'],
    ['GET', '/api/multiuser/connectors/company-key'], ['GET', '/api/multiuser/connectors/github']] as const) {
    expect(open(method, path), `${method} ${path}`).toBe(true);
    expect(open(method, path, false), `${method} ${path} without capability`).toBe(false);
    expect(open(method, path, true, () => false), `${method} ${path} without lane`).toBe(false);
  }
  for (const [method, path] of [['GET', '/api/connectors/logos/github'], ['GET', '/api/connectors/oauth/callback/github'],
    ['GET', '/api/tools/connectors/list'], ['POST', '/api/tools/connectors/execute'], ['POST', '/api/memory/connectors/extract'],
    ['DELETE', '/api/connectors/github'], ['PUT', '/api/connectors/github/connect'], ['GET', '/api/connectors/github/connection'],
    ['GET', '/api/connectors/../github'], ['POST', '/api/system/open-external']] as const) {
    expect(open(method, path), `${method} ${path}`).toBe(false);
  }
});
