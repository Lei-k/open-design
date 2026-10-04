// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MultiUserApp } from '../../src/multiuser/MultiUserApp';
import { I18nProvider } from '../../src/i18n';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
const summary = { mode: 'multi-user', personalSubscriptionsEnabled: true, codex: { account: { id: 'linked', status: 'connected' }, pendingAttempt: null }, claude: { available: false } };
const run = { id: 'r1', projectId: 'p1', conversationId: 'c1', agentId: 'test-mock', status: 'running', createdAt: 1, updatedAt: 1, queuePosition: null, output: null, message: 'Private prompt A' };
let identity: string;
let requests: Array<{ url: string; init?: RequestInit }>;
let runResponse: () => Promise<Response>;
let conversationResponse: () => Promise<Response>;
let cancelResponse: () => Promise<Response>;
let stream: ReadableStreamDefaultController<Uint8Array>;
let streamSignal: AbortSignal | null | undefined;
let postStatus: number;
let postCode: string;
function mount() { return render(<I18nProvider initial="en"><MultiUserApp setupToken={null} /></I18nProvider>); }
async function switchAccount() {
  identity = 'bob';
  await act(async () => window.dispatchEvent(new Event('focus')));
  await screen.findByText('bob');
}
beforeEach(() => {
  identity = 'alice'; requests = []; streamSignal = null; postStatus = 409; postCode = 'MULTIUSER_PERSONAL_USAGE_LIMIT';
  window.history.replaceState({}, '', '/projects/p1/conversations/c1');
  runResponse = async () => json({ runs: [] });
  cancelResponse = async () => json({ ...run, status: 'canceled' });
  conversationResponse = async () => json({ conversations: [{ id: 'c1', title: 'Conversation', projectId: 'p1' }] });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    requests.push({ url, init });
    if (url === '/api/auth/me') return json({ account: { id: identity, username: identity, role: 'user', active: true } });
    if (url === '/api/auth/logout') return new Response(null, { status: 204 });
    if (url === '/api/projects/p1') return json({ project: { id: 'p1', name: 'Project' } });
    if (url === '/api/projects/p1/conversations') return conversationResponse();
    if (url.endsWith('/messages')) return json({ messages: [] });
    if (url === '/api/agent-accounts') return json(summary);
    if (url === '/api/runs' && init?.method === 'POST') return json({ error: { code: postCode } }, postStatus);
    if (url.startsWith('/api/runs?')) return runResponse();
    if (url === '/api/runs/r1/cancel') return cancelResponse();
    if (url === '/api/runs/r1') return json(run);
    if (url.endsWith('/events')) {
      streamSignal = init?.signal;
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }), { headers: { 'Content-Type': 'text/event-stream' } });
    }
    throw new Error(`Unexpected ${url}`);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });
it.each(['runs', 'conversations'])('fences deferred %s responses across A to B even if transport ignores abort', async (kind) => {
  const held = deferred<Response>();
  if (kind === 'runs') runResponse = () => held.promise;
  else conversationResponse = () => held.promise;
  mount(); await screen.findByText('alice');
  await vi.waitFor(() => expect(requests.some(({ url }) => kind === 'runs' ? url.startsWith('/api/runs?') : url.endsWith('/conversations'))).toBe(true));
  runResponse = async () => json({ runs: [] });
  conversationResponse = async () => json({ conversations: [{ id: 'c1', title: 'Bob conversation', projectId: 'p1' }] });
  await switchAccount();
  await act(async () => held.resolve(json(kind === 'runs' ? { runs: [{ ...run, message: 'Private A' }] } : { conversations: [{ id: 'c1', title: 'Private A' }] })));
  expect(screen.queryByText('Private A')).toBeNull();
  expect(screen.getByText('bob')).toBeTruthy();
});
it.each(['logout', 'switch', 'pagehide', 'cross-tab', 'unmount'])('closes the open run stream on %s and rejects late events', async (action) => {
  runResponse = async () => json({ runs: [run] });
  const view = mount();
  await vi.waitFor(() => expect(streamSignal).toBeTruthy());
  const oldSignal = streamSignal;
  runResponse = async () => json({ runs: [] });
  if (action === 'logout') await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Sign out' })));
  if (action === 'switch') await switchAccount();
  if (action === 'pagehide') act(() => window.dispatchEvent(new Event('pagehide')));
  if (action === 'cross-tab') act(() => window.dispatchEvent(new StorageEvent('storage', { key: 'open-design:auth-change', newValue: 'pending:test' })));
  if (action === 'unmount') view.unmount();
  expect(oldSignal?.aborted).toBe(true);
  await act(async () => { try { stream.enqueue(new TextEncoder().encode('id: 3\nevent: agent\ndata: {"text":"Late private A"}\n\n')); } catch { /* reader canceled */ } });
  expect(screen.queryByText('Late private A')).toBeNull();
});
it('deduplicates persisted replay and live events by sequence', async () => {
  runResponse = async () => json({ runs: [run] }); mount();
  await vi.waitFor(() => expect(streamSignal).toBeTruthy());
  await act(async () => {
    stream.enqueue(new TextEncoder().encode('id: 1\nevent: queued\ndata: {}\n\nid: 2\nevent: start\ndata: {}\n\nid: 3\nevent: agent\ndata: {"text":"Only once"}\n\n'));
    stream.enqueue(new TextEncoder().encode('id: 3\nevent: agent\ndata: {"text":"Only once"}\n\nid: 4\nevent: end\ndata: {"status":"succeeded"}\n\n'));
  });
  expect(screen.getAllByText('Only once')).toHaveLength(1);
  expect(screen.getByText('Succeeded')).toBeTruthy();
});
it('requires an explicit source and never retries personal failure on company capacity', async () => {
  mount(); const send = await screen.findByRole('button', { name: 'Send' });
  expect((send as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'hello' } });
  const sources = screen.getByRole('group', { name: 'Execution source' });
  fireEvent.click(within(sources).getByRole('radio', { name: 'My Codex subscription' }));
  await act(async () => fireEvent.click(send));
  expect(screen.getByRole('alert').textContent).toContain('subscription usage limit');
  const posts = requests.filter(({ url, init }) => url === '/api/runs' && init?.method === 'POST');
  expect(posts).toHaveLength(1);
  expect(JSON.parse(String(posts[0]!.init?.body))).toMatchObject({ executionSource: 'personal_subscription', agentId: 'codex' });
  expect((screen.getByRole('radio', { name: 'My Codex subscription' }) as HTMLInputElement).checked).toBe(true);
});
it.each(['company_pool', 'personal_subscription'])('derives the pinned %s source from history on reload', async (source) => {
  runResponse = async () => json({ runs: [{ ...run, status: 'succeeded', ...(source === 'personal_subscription' ? { executionSource: source } : {}), output: { text: 'Saved result' } }] });
  mount();
  await screen.findByText('Saved result');
  const company = screen.getByRole('radio', { name: 'Company pool (test mock)' }) as HTMLInputElement;
  const personal = screen.getByRole('radio', { name: 'My Codex subscription' }) as HTMLInputElement;
  expect(company.disabled).toBe(true); expect(personal.disabled).toBe(true);
  expect(company.checked).toBe(source === 'company_pool'); expect(personal.checked).toBe(source === 'personal_subscription');
  expect(streamSignal).toBeNull();
});
it.each(['foreign', 'missing'])('shows uniform not-found for a %s conversation without a composer', async () => {
  conversationResponse = async () => json({ error: { code: 'NOT_FOUND' } }, 404);
  mount();
  expect((await screen.findByRole('alert')).textContent).toBe('Project, conversation or run not found.');
  expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
});
it('shows a terminal personal failure without offering a company retry', async () => {
  runResponse = async () => json({ runs: [{ ...run, status: 'failed', executionSource: 'personal_subscription', output: { reason: 'MULTIUSER_PERSONAL_USAGE_LIMIT' } }] });
  mount();
  expect((await screen.findByRole('alert')).textContent).toContain('subscription usage limit');
  expect((screen.getByRole('radio', { name: 'Company pool (test mock)' }) as HTMLInputElement).disabled).toBe(true);
  expect(requests.some(({ init }) => init?.method === 'POST')).toBe(false);
});
it('does not revive a terminal stream when an earlier cancel response arrives late', async () => {
  const held = deferred<Response>();
  cancelResponse = () => held.promise;
  runResponse = async () => json({ runs: [run] });
  mount(); await vi.waitFor(() => expect(streamSignal).toBeTruthy());
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Cancel run' })));
  await act(async () => stream.enqueue(new TextEncoder().encode('id: 1\nevent: end\ndata: {"status":"canceled"}\n\n')));
  expect(screen.getByText('Canceled')).toBeTruthy();
  await act(async () => held.resolve(json(run)));
  expect(screen.getByText('Canceled')).toBeTruthy();
  expect(requests.filter(({ url }) => url.endsWith('/events'))).toHaveLength(1);
});
