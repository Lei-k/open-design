// @vitest-environment jsdom
import { useSyncExternalStore } from 'react';
import { cleanup, render, screen, act, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { STUDIO_PARITY_LANES, type StudioRuntimeCapabilities } from '@open-design/contracts';
import { App } from '../../src/App';
import { CookieSession } from '../../src/multiuser/session';
import { StudioCapabilitiesProvider } from '../../src/runtime/studio-capabilities';
import { studioFetch, studioRequestAvailable } from '../../src/runtime/studio-transport';
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
function SessionApp({ session }: { session: CookieSession }) {
  const state = useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot);
  if (state.status !== 'ready' || !state.account) return <p>Withdrawn</p>;
  return <StudioCapabilitiesProvider key={state.generation} session={session} generation={state.generation} actor={state.account} capabilities={state.studio!}><App /></StudioCapabilitiesProvider>;
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('renders the existing App without attempting unavailable service requests, including failure diagnostics', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('EventSource', class { addEventListener() {} removeEventListener() {} close() {} });
  let currentAccount = account;
  let currentProject = project;
  const raw = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === '/api/auth/me') return Response.json({ account: currentAccount, studio, studioRevision: 1 });
    if (path === '/api/projects') return Response.json({ projects: [currentProject] });
    if (path === '/api/projects/owned-project') return Response.json({ project: currentProject });
    if (path.endsWith('/conversations')) return Response.json({ conversations: [{ id: 'conv', title: 'Conversation', createdAt: 1, updatedAt: 1 }] });
    if (path.endsWith('/messages')) return Response.json({ messages: [] });
    if (path.endsWith('/tabs')) return Response.json({ tabs: [], active: null });
    if (path === '/api/agent-accounts') return Response.json({ mode: 'multi-user', personalSubscriptionsEnabled: false, codex: { account: null, pendingAttempt: null }, claude: { available: false } });
    return Response.json({});
  });
  vi.stubGlobal('fetch', raw);
  const session = new CookieSession(); await session.verify();
  act(() => navigate({ kind: 'home', view: 'home' }));
  render(<SessionApp session={session} />);
  await screen.findByText('pilot-A');
  await act(async () => navigate({ kind: 'home', view: 'projects' }));
  await screen.findAllByText('Owned project');
  await act(async () => navigate({ kind: 'project', projectId: project.id, conversationId: 'conv', fileName: null }));
  await screen.findByTestId('chat-composer');
  await act(async () => navigate({ kind: 'home', view: 'settings' }));
  await screen.findByRole('heading', { name: 'Agent accounts' });
  reportExperienceEvent('project_create_result', { result: 'failed', error_code: 'TEST_OPERATION_FAILURE' });
  await waitFor(() => expect(screen.getByText('pilot-A')).toBeVisible());
  const attempted = vi.mocked(studioFetch).mock.calls.map(([input, init]) => ({ method: init?.method ?? 'GET', path: new URL(String(input), location.origin).pathname }));
  expect(attempted.filter(({ method, path }) => !studioRequestAvailable(method, path))).toEqual([]);
  expect(raw.mock.calls.some(([input]) => String(input).includes('/observability/'))).toBe(false);
  await act(async () => navigate({ kind: 'home', view: 'projects' }));
  await screen.findAllByText('Owned project');
  const frames: string[] = [];
  const capture = () => frames.push(document.body.textContent + [...document.querySelectorAll('input,textarea')].map((node) => (node as HTMLInputElement).value).join(' '));
  const observer = new MutationObserver(capture); observer.observe(document.body, { subtree: true, childList: true, characterData: true });
  act(() => session.withdraw()); capture();
  currentAccount = { ...account, id: 'B', username: 'pilot-B' };
  currentProject = { ...project, name: 'B project' };
  await act(() => session.verify());
  await screen.findAllByText('B project'); capture(); observer.disconnect();
  expect(frames.length).toBeGreaterThan(1);
  expect(frames.every((frame) => !/pilot-A|Owned project/.test(frame))).toBe(true);
  act(() => session.dispose());
}, 30_000);
