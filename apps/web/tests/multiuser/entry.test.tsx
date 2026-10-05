// @vitest-environment jsdom
import { StrictMode, Suspense, lazy } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ClientApp } from '../../app/[[...slug]]/client-app';

vi.mock('next/dynamic', () => ({ default: (load: () => Promise<unknown>) => {
  const Component = lazy(async () => { const loaded = await load(); return { default: loaded } as never; });
  return () => <Suspense fallback={null}><Component /></Suspense>;
} }));
vi.mock('../../src/App', () => ({ App: () => <div>Single-user private workspace</div> }));
vi.mock('../../src/analytics/error-tracking', () => ({ installErrorHandlers: vi.fn() }));
vi.mock('../../src/analytics/provider', () => ({ AnalyticsProvider: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('../../src/observability/install', () => ({ installWebObservability: vi.fn() }));
vi.mock('../../src/runtime/chat-scroll-experiments', () => ({ installChatScrollExperiments: vi.fn() }));
vi.mock('../../src/runtime/chat-scroll-takeover', () => ({ installChatScrollTakeover: vi.fn() }));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
const account = (username: string) => ({ id: username, username, role: 'user', active: true, passwordState: 'set', createdAt: 1, updatedAt: 1 });
let identity = 'alice';
let projects: Promise<Response>;
let calls: string[];
beforeEach(() => {
  window.history.replaceState({}, '', '/projects'); identity = 'alice'; calls = [];
  projects = Promise.resolve(json({ projects: [{ id: 'a', name: 'Alice private project' }] }));
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(url);
    if (url === '/api/version') return json({ version: { version: '0.23.1', capabilities: { slideRenderer: false, multiUser: true } } });
    if (url === '/api/auth/me') return identity ? json({ account: account(identity) }) : json({}, 401);
    if (url === '/api/auth/logout') { identity = ''; return new Response(null, { status: 204 }); }
    if (url === '/api/auth/login') { identity = 'bob'; return json({ account: account('bob') }); }
    if (url === '/api/projects') return (await projects).clone();
    throw new Error('unexpected request');
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
it('does not mount single-user workspace while capability is unresolved or invalid', async () => {
  const held = deferred<Response>(); vi.stubGlobal('fetch', vi.fn(() => held.promise));
  render(<ClientApp />);
  await act(async () => {});
  expect(screen.queryByText('Single-user private workspace')).toBeNull();
  await act(async () => held.resolve(json({})));
  expect(screen.queryByText('Single-user private workspace')).toBeNull();
  expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
});
it.each([200, 401])('rejects a late account A project response (%s) after logout and login B', async (status) => {
  const held = deferred<Response>(); projects = held.promise;
  render(<ClientApp />);
  await screen.findByText('alice');
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Sign out' })));
  projects = Promise.resolve(json({ projects: [{ id: 'b', name: 'Bob private project' }] }));
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'bob' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'bob-password-valid' } });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Sign in' })));
  await screen.findByText('Bob private project');
  await act(async () => held.resolve(json({ projects: [{ id: 'a', name: 'Alice private project' }] }, status)));
  expect(screen.queryByText('Alice private project')).toBeNull();
  expect(screen.getByText('Bob private project')).toBeTruthy();
  expect(screen.getByText('bob')).toBeTruthy();
});
it('withdraws the identity on cross-tab logout and does not read admin data for a user', async () => {
  window.history.replaceState({}, '', '/admin/users'); render(<ClientApp />);
  await screen.findByText('Access denied');
  expect(calls.some((url) => url.startsWith('/api/auth/users'))).toBe(false);
  identity = '';
  await act(async () => window.dispatchEvent(new StorageEvent('storage', { key: 'open-design:auth-change', newValue: 'changed' })));
  expect(screen.queryByText('alice')).toBeNull();
  await screen.findByRole('button', { name: 'Sign in' });
});
it('mounts the original app only after a confirmed single-user response', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json({ version: { version: '0.23.1', capabilities: { slideRenderer: false } } })));
  render(<ClientApp />); await screen.findByText('Single-user private workspace');
});
it('consumes the setup fragment before requesting, clears it, and never automatically logs in', async () => {
  const token = 'a'.repeat(43); window.history.replaceState({}, '', `/setup#${token}`);
  const requests: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    requests.push(url); expect(window.location.hash).toBe('');
    if (url === '/api/version') return json({ version: { version: '0.23.1', capabilities: { slideRenderer: false, multiUser: true } } });
    expect(url).toBe('/api/auth/setup'); expect(JSON.parse(String(init?.body)).token).toBe(token);
    return json({ account: { username: 'alice' } });
  }));
  render(<ClientApp />); await screen.findByLabelText('Confirm password');
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'my-new-valid-password' } });
  fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'my-new-valid-password' } });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Set your password' })));
  await screen.findByText('Your password is set. Sign in to continue.');
  expect(requests).toEqual(['/api/version', '/api/auth/setup']);
  expect(JSON.stringify(localStorage)).not.toContain(token); expect(JSON.stringify(sessionStorage)).not.toContain(token);
});
it('keeps the view during a routine check, then withdraws when identity changes', async () => {
  render(<ClientApp />); await screen.findByText('Alice private project');
  const held = deferred<Response>(); const fetcher = fetch as ReturnType<typeof vi.fn>;
  fetcher.mockImplementation((url: string) => url === '/api/auth/me' ? held.promise : Promise.resolve(json({ projects: [] })));
  act(() => window.dispatchEvent(new Event('focus')));
  expect(screen.getByText('Alice private project')).toBeTruthy(); expect(screen.getByText('alice')).toBeTruthy();
  await act(async () => held.resolve(json({ account: account('bob') })));
  await screen.findByText('bob'); expect(screen.queryByText('Alice private project')).toBeNull();
});
it('consumes a replacement setup fragment on same-document navigation', async () => {
  const token = 'b'.repeat(43); window.history.replaceState({}, '', `/setup#${'a'.repeat(43)}`);
  render(<ClientApp />); await screen.findByLabelText('Confirm password');
  act(() => { window.history.replaceState({}, '', `/setup#${token}`); window.dispatchEvent(new HashChangeEvent('hashchange')); });
  expect(window.location.hash).toBe('');
  act(() => { window.history.replaceState({}, '', '/setup#invalid'); window.dispatchEvent(new HashChangeEvent('hashchange')); });
  await screen.findByText('This setup link is invalid or expired. Ask your administrator for a new link.');
  expect(screen.queryByLabelText('Confirm password')).toBeNull();
});
it('provisions without a password, dismisses the one-use link and reports a last-admin conflict', async () => {
  window.history.replaceState({}, '', '/admin/users');
  const admin = { ...account('root'), role: 'admin' };
  const mutations: Array<{ url: string; body: unknown }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/version') return json({ version: { version: '0.23.1', capabilities: { slideRenderer: false, multiUser: true } } });
    if (url === '/api/auth/me') return json({ account: admin });
    if (url.startsWith('/api/auth/users?')) return json({ accounts: [admin, { ...admin, id: 'other', username: 'other-admin' }], page: { total: 2, limit: 20, offset: 0 } });
    mutations.push({ url, body: JSON.parse(String(init?.body)) });
    if (url === '/api/auth/users') return json({ account: account('new-user'), setup: { token: 'c'.repeat(43), expiresAt: Date.now() + 86_400_000, purpose: 'setup' } });
    return json({}, 409);
  }));
  render(<ClientApp />); await screen.findByRole('button', { name: 'Create account' });
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'new-user' } });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Create account' })));
  expect(mutations[0]).toEqual({ url: '/api/auth/users', body: { username: 'new-user', role: 'user' } });
  expect((screen.getByLabelText('One-time setup link', { selector: 'input' }) as HTMLInputElement).value).toBe(`${window.location.origin}/setup#${'c'.repeat(43)}`);
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss link' }));
  expect(screen.queryByLabelText('One-time setup link', { selector: 'input' })).toBeNull();
  fireEvent.click(within(screen.getAllByRole('listitem')[1]!).getByRole('button', { name: 'Make user' }));
  await act(async () => fireEvent.click(screen.getByRole('button', { name: /^Confirm$/ })));
  expect(screen.getByRole('alert').textContent).toContain('last usable administrator');
  expect(screen.queryByText('Change saved.')).toBeNull();
});
it('keeps unrelated preferences and withdraws account data on an in-progress cross-tab auth change', async () => {
  localStorage.setItem('open-design:locale', 'en');
  render(<ClientApp />); await screen.findByText('Alice private project');
  act(() => window.dispatchEvent(new StorageEvent('storage', { key: 'open-design:auth-change', newValue: 'pending:test' })));
  expect(screen.queryByText('Alice private project')).toBeNull(); expect(screen.queryByText('alice')).toBeNull();
  expect(localStorage.getItem('open-design:locale')).toBe('en');
  await act(async () => window.dispatchEvent(new Event('focus')));
  expect(screen.queryByText('alice')).toBeNull();
  identity = 'bob'; projects = Promise.resolve(json({ projects: [] }));
  await act(async () => window.dispatchEvent(new StorageEvent('storage', { key: 'open-design:auth-change', newValue: 'changed:test' })));
  await screen.findByText('bob');
});
it('removes private content before a page is cached for history navigation', async () => {
  render(<ClientApp />); await screen.findByText('Alice private project');
  act(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  expect(screen.queryByText('Alice private project')).toBeNull();
});
it.each([[], null, { multiUser: false }, { multiUser: 'true' }, { multiUser: null }, { multiUser: 0 }])('fails closed for malformed capabilities %j', async (capabilities) => {
  vi.stubGlobal('fetch', vi.fn(async () => json({ version: { version: '0.23.1', capabilities } })));
  render(<ClientApp />); await screen.findByRole('button', { name: 'Retry' });
  expect(screen.queryByText('Single-user private workspace')).toBeNull();
});

it.each([undefined, {}, { slideRenderer: 'unknown' }])('accepts legacy single-user capabilities %j', async (capabilities) => {
  vi.stubGlobal('fetch', vi.fn(async () => json({ version: { version: '0.13.4', capabilities } })));
  render(<ClientApp />); await screen.findByText('Single-user private workspace');
});
it('selects multi-user without requiring an unrelated renderer capability', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url === '/api/version'
    ? json({ version: { version: '0.23.1', capabilities: { multiUser: true } } }) : json({}, 401)));
  render(<ClientApp />); await screen.findByRole('button', { name: 'Sign in' });
  expect(screen.queryByText('Single-user private workspace')).toBeNull();
});
it.each(['network', '502'])('automatically retries a transient %s version failure before selecting an app', async (failure) => {
  vi.useFakeTimers();
  const fetcher = vi.fn().mockImplementationOnce(async () => { if (failure === 'network') throw new TypeError('Network'); return json({}, 502); })
    .mockResolvedValue(json({ version: { version: '0.13.4' } }));
  vi.stubGlobal('fetch', fetcher); render(<ClientApp />);
  await act(async () => {});
  expect(screen.queryByText('Single-user private workspace')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(300));
  expect(screen.getByText('Single-user private workspace')).toBeTruthy(); expect(fetcher).toHaveBeenCalledTimes(2);
});
it('bounds automatic retries and cancels a scheduled retry when unmounted', async () => {
  vi.useFakeTimers(); const fetcher = vi.fn(async () => json({}, 503)); vi.stubGlobal('fetch', fetcher);
  const view = render(<ClientApp />); await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect(fetcher).toHaveBeenCalledTimes(4); expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' })); await act(async () => {}); view.unmount();
  await act(async () => vi.advanceTimersByTimeAsync(10_000)); expect(fetcher).toHaveBeenCalledTimes(5);
});
function adminRequests(create: () => Promise<Response> = async () => json({ setup: { token: 'd'.repeat(43), expiresAt: Date.now() + 60_000 } })) {
  window.history.replaceState({}, '', '/admin/users');
  let current = { ...account('root'), role: 'admin' };
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/version') return json({ version: { version: '0.23.1', capabilities: { slideRenderer: false, multiUser: true } } });
    if (url === '/api/auth/me') return current.active ? json({ account: current }) : json({}, 401);
    if (url.startsWith('/api/auth/users?')) return json({ accounts: [current], page: { total: 1, limit: 20, offset: 0 } });
    if (url === '/api/auth/users' && init?.method === 'POST') return create();
    throw new Error('Unexpected request');
  });
  vi.stubGlobal('fetch', fetcher);
  return { fetcher, setRole: () => { current = { ...current, role: 'user' }; }, expire: () => { current = { ...current, active: false }; } };
}
function heartbeat() {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  return () => vi.advanceTimersByTime(60_000);
}

it('prevents self reset, disable and demotion with an explanation', async () => {
  adminRequests(); render(<ClientApp />); await screen.findByRole('button', { name: 'Make user' });
  for (const name of ['Issue setup/reset link', 'Disable', 'Make user']) expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText('Ask another administrator to reset your password or change your own access.')).toBeTruthy();
});
it('keeps the setup link, form draft and search during a same-identity heartbeat', async () => {
  adminRequests(); const tick = heartbeat(); render(<ClientApp />); await screen.findByLabelText('Username');
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'new-user' } });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Create account' })));
  const link = screen.getByLabelText('One-time setup link', { selector: 'input' });
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'next-user' } });
  fireEvent.change(screen.getByLabelText('Search usernames'), { target: { value: 'draft-search' } });
  await act(async () => tick());
  expect(screen.getByLabelText('One-time setup link', { selector: 'input' })).toBe(link);
  expect((screen.getByLabelText('Username') as HTMLInputElement).value).toBe('next-user');
  expect((screen.getByLabelText('Search usernames') as HTMLInputElement).value).toBe('draft-search');
});
it.each(['role', '401'])('withdraws admin data on a heartbeat reporting %s', async (change) => {
  const state = adminRequests(); const tick = heartbeat(); render(<ClientApp />); await screen.findByLabelText('Username');
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Create account' })));
  if (change === 'role') state.setRole(); else state.expire();
  await act(async () => tick());
  expect(screen.queryByLabelText('One-time setup link', { selector: 'input' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Create account' })).toBeNull();
  expect(change === 'role' ? screen.getByText('Access denied') : screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
});
it('checks a same identity during create without disturbing it, then confirms after it settles', async () => {
  const held = deferred<Response>(); const { fetcher } = adminRequests(() => held.promise);
  render(<ClientApp />); await screen.findByLabelText('Username');
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'new-user' } });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Create account' })));
  const mutation = fetcher.mock.calls.find(([url, init]) => url === '/api/auth/users' && init?.method === 'POST')!;
  const before = fetcher.mock.calls.filter(([url]) => url === '/api/auth/me').length;
  await act(async () => window.dispatchEvent(new Event('focus')));
  expect(mutation[1]?.signal?.aborted).toBe(false);
  expect(fetcher.mock.calls.filter(([url]) => url === '/api/auth/me')).toHaveLength(before + 1);
  await act(async () => held.resolve(json({ setup: { token: 'd'.repeat(43), expiresAt: Date.now() + 60_000 } })));
  expect(screen.getByLabelText('One-time setup link', { selector: 'input' })).toBeTruthy();
  expect(screen.queryByText(/Outcome unknown/)).toBeNull();
  expect(fetcher.mock.calls.filter(([url]) => url === '/api/auth/me')).toHaveLength(before + 2);
});
it('reports an unknown mutation outcome after genuine cross-tab withdrawal without leaking its late result', async () => {
  const held = deferred<Response>(); adminRequests(() => held.promise); render(<ClientApp />); await screen.findByLabelText('Username');
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'new-user' } });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Create account' })));
  act(() => window.dispatchEvent(new StorageEvent('storage', { key: 'open-design:auth-change', newValue: 'pending:test' })));
  expect(screen.getByText(/Outcome unknown/)).toBeTruthy();
  await act(async () => held.resolve(json({ setup: { token: 'd'.repeat(43), expiresAt: Date.now() + 60_000 } })));
  expect(screen.queryByLabelText('One-time setup link', { selector: 'input' })).toBeNull();
  expect(screen.getByText(/Outcome unknown/)).toBeTruthy();
});

it('rechecks safely after StrictMode effect cleanup without getting stuck', async () => {
  render(<StrictMode><ClientApp /></StrictMode>); await screen.findByText('Alice private project');
});
it.each(['role', '401'])('applies a server %s change during a hung owned write', async (change) => {
  const held = deferred<Response>(); const state = adminRequests(() => held.promise); const tick = heartbeat();
  render(<ClientApp />); await screen.findByLabelText('Username');
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'new-user' } });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Create account' })));
  const mutation = state.fetcher.mock.calls.find(([url, init]) => url === '/api/auth/users' && init?.method === 'POST')!;
  if (change === 'role') state.setRole(); else state.expire();
  await act(async () => tick());
  // The write never settled, yet the routine check ran and withdrew the old identity.
  expect(change === 'role' ? screen.getByText('Access denied') : screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Create account' })).toBeNull();
  expect(mutation[1]?.signal?.aborted).toBe(true);
  expect(screen.getByText(/Outcome unknown/)).toBeTruthy();
  await act(async () => held.resolve(json({ setup: { token: 'd'.repeat(43), expiresAt: Date.now() + 60_000 } })));
  expect(screen.queryByLabelText('One-time setup link', { selector: 'input' })).toBeNull();
});
