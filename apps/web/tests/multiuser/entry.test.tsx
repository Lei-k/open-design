// @vitest-environment jsdom
import { Suspense, lazy } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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
    if (url === '/api/projects') return projects;
    throw new Error('unexpected request');
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
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
it('hides private content during a deferred focus check, then accepts only the new identity', async () => {
  render(<ClientApp />); await screen.findByText('Alice private project');
  const held = deferred<Response>(); const fetcher = fetch as ReturnType<typeof vi.fn>;
  fetcher.mockImplementation((url: string) => url === '/api/auth/me' ? held.promise : Promise.resolve(json({ projects: [] })));
  act(() => window.dispatchEvent(new Event('focus')));
  expect(screen.queryByText('Alice private project')).toBeNull(); expect(screen.queryByText('alice')).toBeNull();
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
    if (url.startsWith('/api/auth/users?')) return json({ accounts: [admin], page: { total: 1, limit: 20, offset: 0 } });
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
  fireEvent.click(screen.getByRole('button', { name: 'Make user' }));
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
it.each([[], {}, { multiUser: false }, { slideRenderer: 'unknown' }])('fails closed for malformed capabilities %j', async (capabilities) => {
  vi.stubGlobal('fetch', vi.fn(async () => json({ version: { version: '0.23.1', capabilities } })));
  render(<ClientApp />); await screen.findByRole('button', { name: 'Retry' });
  expect(screen.queryByText('Single-user private workspace')).toBeNull();
});
