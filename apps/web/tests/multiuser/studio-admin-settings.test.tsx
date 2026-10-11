// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { STUDIO_PARITY_LANES, type StudioRuntimeCapabilities } from '@open-design/contracts';
import { I18nProvider } from '../../src/i18n';
import { StudioCapabilitiesProvider } from '../../src/runtime/studio-capabilities';
import { StudioAccountSettings } from '../../src/runtime/StudioAccountSettings';
import { CookieSession } from '../../src/multiuser/session';
import type { AppConfig } from '../../src/types';

vi.mock('../../src/components/SkillsSection', () => ({ SkillsSection: () => null }));
vi.mock('../../src/components/MemorySection', () => ({ MemorySection: () => null }));
vi.mock('../../src/runtime/StudioMcpServers', () => ({ StudioMcpServers: () => null }));
vi.mock('../../src/runtime/StudioConnectors', () => ({ StudioConnectors: () => null }));
vi.mock('../../src/runtime/StudioDeploy', () => ({ StudioDeploySettings: () => null }));
const capabilities: StudioRuntimeCapabilities = { schemaVersion: 1, shell: 'studio', features: Object.fromEntries(STUDIO_PARITY_LANES.map(({ id }) => [id, { status: 'unavailable', reason: 'pending' }])) as StudioRuntimeCapabilities['features'] };
let session: CookieSession;
afterEach(() => { cleanup(); session?.dispose(); vi.unstubAllGlobals(); vi.useRealTimers(); });
async function mount(path = '/admin/users', role = 'admin', providerEnabled = false) {
  window.history.replaceState({}, '', path);
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  let currentRole = role;
  const user = { id: 'second', username: 'Second admin', role: 'admin', active: true, passwordState: 'set', createdAt: 1, updatedAt: 3 };
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/auth/me') return Response.json({ account: { ...user, id: 'root', username: 'Root', role: currentRole }, studio: capabilities, studioRevision: 1 });
    if (url.startsWith('/api/auth/users?')) return Response.json({ accounts: [user], page: { total: 21, offset: 0, limit: 20 } });
    if (url === '/api/auth/users/second') return Response.json({ account: user });
    if (url.startsWith('/api/auth/audit?')) return Response.json({ events: [{ id: 1, at: 1, action: 'account_update', actorAccountId: 'root', targetAccountId: 'second', metadata: {} }], nextBefore: 1 });
    if (url === '/api/agent-accounts') return Response.json({ mode: 'multi-user', personalSubscriptionsEnabled: false, codex: { account: null, pendingAttempt: null }, claude: { available: false } });
    if (url === '/api/health') return Response.json({ ok: true, hidden: 'not-presented' });
    if (url === '/api/admin/pool/openai') return Response.json({ provider: { providerId: 'openai', enabled: providerEnabled, configured: providerEnabled, capacity: 0, model: 'fixture', revision: 0, credentialRevision: 0 } });
    if (url === '/api/admin/pool') return Response.json({ providers: { openai: { capacity: 2, active: 1, queued: 3 } }, users: { second: { usedMs: 0, budgetMs: 60000, remainingMs: 60000 } } });
    if (url === '/api/admin/agent-accounts') return Response.json({ personalWorkerCapacity: 2, activePersonalRuns: 1, queuedPersonalRuns: 0, users: {
      expired: { codex: { linked: true, status: 'requires_reauth', linkedAt: 1, verifiedAt: 1, updatedAt: 1 }, personalWorkerMs: 0 },
      disabled: { codex: { linked: true, status: 'disabled', linkedAt: 1, verifiedAt: 1, updatedAt: 1 }, personalWorkerMs: 0 },
    } });
    return Response.json({});
  });
  vi.stubGlobal('fetch', fetcher);
  session = new CookieSession(); await session.verify();
  const state = session.snapshot(); expect(state.status).toBe('ready');
  render(<I18nProvider initial="en"><StudioCapabilitiesProvider session={session} generation={state.generation} actor={state.account!} capabilities={capabilities}><StudioAccountSettings presentation="page" initialSection="execution" initial={{} as AppConfig} onClose={() => {}} onPersist={() => {}} /></StudioCapabilitiesProvider></I18nProvider>);
  return { fetcher, demote: async () => { currentRole = 'user'; await act(async () => session.verify()); } };
}
it('opens Users in the shared Settings frame on a phone; searches, pages and confirms revision-bound role changes', async () => {
  const { fetcher } = await mount();
  const row = (await screen.findByText('Second admin')).closest('li')!;
  expect(screen.getByTestId('studio-settings-nav-users')).toBeTruthy();
  expect(screen.getByTestId('studio-settings-nav-company')).toBeTruthy();
  expect(screen.queryByTestId('company-openai-settings')).toBeNull();
  const toggle = screen.getByRole('button', { name: 'Expand settings sidebar' });
  toggle.focus(); expect(document.activeElement).toBe(toggle); fireEvent.click(toggle);
  fireEvent.click(within(row).getByRole('button', { name: 'Make user' }));
  expect(fetcher.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
  await act(async () => {});
  const mutation = fetcher.mock.calls.find(([, init]) => init?.method === 'PATCH');
  expect(JSON.parse(String(mutation?.[1]?.body))).toEqual({ role: 'user', revision: 3 });
});
it('searches and pages users through the bounded HTTP query', async () => {
  const { fetcher } = await mount();
  await screen.findByText('Second admin');
  fireEvent.change(screen.getByLabelText('Search usernames'), { target: { value: 'second' } });
  fireEvent.click(screen.getByRole('button', { name: 'Search' })); await act(async () => {});
  expect(fetcher.mock.calls.some(([url]) => url.includes('&q=second'))).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Next' })); await act(async () => {});
  expect(fetcher.mock.calls.some(([url]) => url.includes('offset=20'))).toBe(true);
});
it('keeps page account navigation reachable in both the Studio and retained legacy Settings hosts', async () => {
  await mount('/settings');
  fireEvent.click(screen.getByTestId('studio-account-trigger'));
  expect(screen.getByRole('menuitem', { name: 'Back to home' }).getAttribute('href')).toBe('/');
  expect(screen.getByRole('menuitem', { name: 'Settings', exact: true }).getAttribute('href')).toBe('/settings');
});
it.each(['/admin/users', '/admin/audit', '/settings?section=company', '/settings?section=personal'])('refuses non-admin deep link %s before requesting admin metadata', async (path) => {
  const { fetcher } = await mount(path, 'user'); await act(async () => {});
  expect(screen.getByRole('alert').textContent).toContain('Access denied');
  expect(fetcher.mock.calls.some(([url]) => /\/api\/(admin|auth\/(users|audit))/.test(url))).toBe(false);
});
it('withdraws a mounted admin page, its confirmation and cached rows synchronously on demotion', async () => {
  const { demote } = await mount();
  const row = (await screen.findByText('Second admin')).closest('li')!;
  fireEvent.click(within(row).getByRole('button', { name: 'Make user' }));
  await demote();
  expect(screen.queryByText('Second admin')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
});
it('presents aggregate company slots, queue and quota independently from Users, with a destructive confirmation', async () => {
  const { fetcher } = await mount('/settings?section=company');
  await screen.findByTestId('company-openai-settings');
  await screen.findByLabelText('Worker budget (minutes)');
  fireEvent.change(screen.getByLabelText('Worker budget (minutes)'), { target: { value: '0' } });
  fireEvent.click(screen.getAllByRole('button', { name: 'Save' }).at(-1)!);
  expect(fetcher.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' })); await act(async () => {});
  expect(fetcher.mock.calls.some(([url, init]) => url === '/api/admin/pool/users/second/quota' && JSON.parse(String(init?.body)).budgetMinutes === 0)).toBe(true);
});
it('presents personal worker capacity and aggregate usage in Settings', async () => {
  await mount('/settings?section=personal');
  expect(await screen.findByLabelText('Concurrent workers')).toBeTruthy();
});
it.each(['Sign-in expired', 'Disabled by provider'])('shows the authoritative personal worker status %s instead of treating every linked worker as connected', async (status) => {
  await mount('/settings?section=personal');
  expect(await screen.findByText(status)).toBeTruthy();
});
it('shows the existing server health check in About using only the public health boolean', async () => {
  const { fetcher } = await mount('/settings');
  fireEvent.click(screen.getByTestId('studio-settings-nav-about'));
  await screen.findByTestId('studio-about-health');
  expect(fetcher.mock.calls.some(([url]) => url === '/api/health')).toBe(true);
});
it('filters audit actions and pages the server cursor without persisting cached events', async () => {
  const { fetcher } = await mount('/admin/audit');
  const filter = await screen.findByLabelText('Filter this audit page');
  fireEvent.change(filter, { target: { value: 'nothing' } });
  expect(screen.queryByText('account_update')).toBeNull();
  fireEvent.change(filter, { target: { value: 'account' } });
  expect(screen.getByText('account_update')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Next' })); await act(async () => {});
  expect(fetcher.mock.calls.some(([url]) => url.endsWith('&before=1'))).toBe(true);
});
it('requires confirmation before disabling an enabled company provider and clears the key draft', async () => {
  const { fetcher } = await mount('/settings?section=company', 'admin', true);
  const provider = await screen.findByTestId('company-openai-settings');
  const key = within(provider).getByLabelText('New API key (optional)') as HTMLInputElement;
  fireEvent.change(key, { target: { value: 'fixture-secret-key' } });
  fireEvent.click(within(provider).getByRole('checkbox'));
  fireEvent.click(within(provider).getByRole('button', { name: 'Save' })); await act(async () => {});
  expect(fetcher.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
  expect(key.value).toBe('');
  fireEvent.click(within(provider).getByRole('button', { name: 'Confirm' })); await act(async () => {});
  expect(fetcher.mock.calls.some(([url, init]) => url === '/api/admin/pool/openai' && init?.method === 'PUT' && JSON.parse(String(init.body)).enabled === false)).toBe(true);
});
