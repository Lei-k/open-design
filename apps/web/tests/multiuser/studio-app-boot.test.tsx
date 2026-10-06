// @vitest-environment jsdom
import { cleanup, render, screen, act, waitFor, fireEvent } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { STUDIO_PARITY_LANES, type StudioRuntimeCapabilities, type AuthAccount } from '@open-design/contracts';
// Preload the real lazy chunk so module transformation is outside UI wait budgets.
import '../../src/App';
import { MultiUserApp } from '../../src/multiuser/MultiUserApp';
import { CookieSession } from '../../src/multiuser/session';
import { studioFetch } from '../../src/runtime/studio-transport';
import { navigate } from '../../src/router';
import { reportExperienceEvent } from '../../src/observability/experience-diagnostics';
vi.mock('../../src/runtime/studio-transport', async (original) => {
  const actual = await original<typeof import('../../src/runtime/studio-transport')>();
  return { ...actual, studioFetch: vi.fn(actual.studioFetch) };
});
const studio: StudioRuntimeCapabilities = { schemaVersion: 1, shell: 'studio', features: Object.fromEntries(
  STUDIO_PARITY_LANES.map(({ id }) => [id, { status: 'unavailable', reason: 'Pending parity #55' }]),
) as StudioRuntimeCapabilities['features'] };
const account = { id: 'A', username: 'pilot-A', role: 'user', active: true, passwordState: 'set', createdAt: 1, updatedAt: 1 };
const project = { id: 'owned-project', name: 'Owned project', createdAt: 1, updatedAt: 1, metadata: { kind: 'prototype' } };
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('renders the existing App without attempting unavailable service requests, including failure diagnostics', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
  const requests: Array<{ source: string; method: string; path: string }> = [];
  const record = (source: string, input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ source, method: (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase(),
      path: new URL(input instanceof Request ? input.url : String(input), location.origin).pathname });
  };
  vi.stubGlobal('EventSource', class {
    constructor(url: string | URL) { record('EventSource', url); }
    addEventListener() {} removeEventListener() {} close() {}
  });
  const originalRequest = CookieSession.prototype.request;
  vi.spyOn(CookieSession.prototype, 'request').mockImplementation(function (this: CookieSession, ...args) {
    record('CookieSession', args[0], args[1]);
    return originalRequest.apply(this, args);
  });
  let currentAccount = account as AuthAccount;
  let effective = studio;
  let revision = 1;
  let currentProject = project;
  const raw = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    record('fetch', input, init);
    const path = new URL(String(input), location.origin).pathname;
    if (path === '/api/auth/me') return Response.json({ account: currentAccount, studio: effective, studioRevision: revision });
    if (path === '/api/projects') return Response.json({ projects: [currentProject] });
    if (path === '/api/projects/owned-project') return Response.json({ project: currentProject });
    if (path.endsWith('/conversations')) return Response.json({ conversations: [{ id: 'conv', title: 'Conversation', createdAt: 1, updatedAt: 1 }] });
    if (path.endsWith('/messages')) return Response.json({ messages: [] });
    if (path.endsWith('/tabs')) return Response.json({ tabs: [], active: null });
    if (path === '/api/agent-accounts') return Response.json({ mode: 'multi-user', personalSubscriptionsEnabled: false, codex: { account: null, pendingAttempt: null }, claude: { available: false } });
    return Response.json({});
  });
  vi.stubGlobal('fetch', raw);
  act(() => navigate({ kind: 'home', view: 'home' }));
  render(<MultiUserApp setupToken={null} />);
  await screen.findByText('pilot-A', {}, { timeout: 15_000 });
  await act(async () => navigate({ kind: 'home', view: 'projects' }));
  await screen.findAllByText('Owned project');
  await act(async () => navigate({ kind: 'project', projectId: project.id, conversationId: 'conv', fileName: null }));
  await screen.findByTestId('chat-composer');
  await act(async () => navigate({ kind: 'home', view: 'settings' }));
  await screen.findByRole('heading', { name: 'Agent accounts' });
  reportExperienceEvent('project_create_result', { result: 'failed', error_code: 'TEST_OPERATION_FAILURE' });
  await waitFor(() => expect(screen.getByText('pilot-A')).toBeVisible());
  expect(raw.mock.calls.some(([input]) => String(input).includes('/observability/'))).toBe(false);
  await act(async () => navigate({ kind: 'project', projectId: project.id, conversationId: 'conv', fileName: null }));
  await screen.findByTestId('chat-composer');
  fireEvent.click(screen.getByTestId('workspace-tabs-dropdown-trigger'));
  fireEvent.click((await screen.findAllByTestId('workspace-tabs-dropdown-row-more'))[0]!);
  fireEvent.click(screen.getByRole('menuitem', { name: /^Rename$/ }));
  fireEvent.change(screen.getByRole('textbox', { name: /^Rename$/ }), { target: { value: 'A-private-draft' } });
  expect(screen.getByRole('textbox', { name: /^Rename$/ })).toHaveValue('A-private-draft');
  expect(screen.getByTestId('workspace-tabs-dropdown-trigger')).toHaveTextContent('Owned project');
  const aShell = document.querySelector('[data-studio-pilot]')!;
  const frames: string[] = [];
  const capture = () => frames.push(document.body.textContent + [...document.querySelectorAll('input,textarea')].map((node) => (node as HTMLInputElement).value).join(' '));
  let animationFrame = 0;
  let sampledFrames = 0;
  const sampleFrame = () => { sampledFrames++; capture(); animationFrame = requestAnimationFrame(sampleFrame); };
  const observer = new MutationObserver(capture); observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  try {
    // Exercise the real provider's synchronous browser lifecycle withdrawal.
    act(() => window.dispatchEvent(new Event('pagehide'))); capture();
    expect(aShell.isConnected).toBe(false);
    animationFrame = requestAnimationFrame(sampleFrame);
    act(() => navigate({ kind: 'home', view: 'projects' }));
    currentAccount = { ...currentAccount, id: 'B', username: 'nonpilot-B' };
    currentProject = { ...project, name: 'B project' };
    effective = { ...studio, shell: 'legacy-multiuser' };
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await screen.findByText('nonpilot-B');
    await screen.findAllByText('B project'); capture();
    await act(async () => { await new Promise<void>((resolve) => requestAnimationFrame(() => resolve())); });
    expect(sampledFrames).toBeGreaterThan(0);
    expect(document.querySelector('[data-studio-pilot]')).toBeNull();
    const legacy = screen.getByText('nonpilot-B');
    effective = studio; revision++;
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(document.querySelector('[data-studio-pilot]')).not.toBeNull());
    await act(async () => navigate({ kind: 'project', projectId: project.id, conversationId: 'conv', fileName: null }));
    await screen.findByTestId('chat-composer'); capture();
    expect(legacy.isConnected).toBe(false);
    const bShell = document.querySelector('[data-studio-pilot]')!;
    currentAccount = { ...currentAccount, role: 'admin' };
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(bShell.isConnected).toBe(false));
    await screen.findByRole('link', { name: 'Users' }); capture();
    const adminShell = document.querySelector('[data-studio-pilot]')!;
    // Revision alone must also replace the private tree, even with unchanged capabilities.
    revision++;
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(adminShell.isConnected).toBe(false));
    await screen.findByTestId('chat-composer'); capture();
    await act(async () => navigate({ kind: 'home', view: 'projects' }));
    effective = { ...studio, shell: 'legacy-multiuser' }; revision++;
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(document.querySelector('[data-studio-pilot]')).toBeNull());
    await screen.findByText('nonpilot-B'); capture();
    expect(frames.length).toBeGreaterThan(5);
    expect(frames.every((frame) => !/pilot-A|Owned project|A-private-draft/.test(frame))).toBe(true);
  } finally { observer.disconnect(); cancelAnimationFrame(animationFrame); }
  for (const [input, init] of vi.mocked(studioFetch).mock.calls) record('StudioAttempt', input, init);
  expect(requests.some(({ source, path }) => source === 'fetch' && path === '/api/projects')).toBe(true);
  expect(requests.some(({ source, path }) => source === 'CookieSession' && path === '/api/agent-accounts')).toBe(true);
  expect(requests.some(({ source, path }) => source === 'EventSource' && path.endsWith('/events'))).toBe(true);
  // Cross-app authority belongs in e2e/tests/studio-shell-transport.test.ts.
  // Its bounded subprocess imports this real UI test's observations and checks
  // every channel against the daemon matcher, never the client availability filter.
  process.stdout.write('STUDIO_BOOT_REQUESTS=' + JSON.stringify(requests) + '\n');
}, 60_000);
