import { bindStudioPendingWrite } from '../../src/runtime/studio-resources';
// @vitest-environment jsdom
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { STUDIO_PARITY_LANES, type AuthAccount, type StudioRuntimeCapabilities } from '@open-design/contracts';
import { CookieSession } from '../../src/multiuser/session';
import { StudioCapabilitiesProvider, useStudioCapabilities } from '../../src/runtime/studio-capabilities';
import { studioFetch, studioLocalStorage, studioSetTimeout } from '../../src/runtime/studio-transport';
import { coalescedGet } from '../../src/lib/coalesced-get';
import { stashHomeComposerAttachments, peekHomeComposerAttachments } from '../../src/state/home-composer-stash';
import { IframeKeepAliveProvider, useIframeKeepAlivePool } from '../../src/components/IframeKeepAlivePool';

const capabilities: StudioRuntimeCapabilities = { schemaVersion: 1, shell: 'studio', features: Object.fromEntries(
  STUDIO_PARITY_LANES.map(({ id }) => [id, { status: 'unavailable', reason: 'Pending parity acceptance' }]),
) as StudioRuntimeCapabilities['features'] };
const account = (id: string): AuthAccount => ({ id, username: id, role: 'user', active: true, passwordState: 'set', createdAt: 1, updatedAt: 1 });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
function Project() {
  const studio = useStudioCapabilities();
  const [name, setName] = useState('');
  useEffect(() => { let active = true;
    void coalescedGet('studio-project', async () => (await (await studioFetch('/api/projects')).json()).name)
      .then((value) => { if (active) setName(value); }).catch(() => {});
    return () => { active = false; };
  }, []);
  return <><span>{studio.actor!.username}</span><span>{name}</span><input aria-label="draft" defaultValue={studioLocalStorage().getItem('draft') ?? ''} /><Frame /></>;
}
function Frame() {
  const studio = useStudioCapabilities(); const pool = useIframeKeepAlivePool(); const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const key = `${studio.actor!.id}\0preview`;
    pool.attach(key, host.current!, () => { const frame = document.createElement('iframe'); frame.dataset.owner = studio.actor!.id; frame.src = 'about:blank'; return frame; });
    return () => pool.release(key);
  }, [studio.actor, pool]);
  return <div ref={host} />;
}
function Boundary({ session }: { session: CookieSession }) {
  const state = useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot);
  if (!state.account || state.status !== 'ready') return <span>Withdrawn</span>;
  return <StudioCapabilitiesProvider key={state.generation} session={session} actor={state.account} capabilities={state.studio!} generation={state.generation}><IframeKeepAliveProvider><Project /></IframeKeepAliveProvider></StudioCapabilitiesProvider>;
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it('clears cached project, draft and attachments before a B-pilot render; ignores late A responses', async () => {
  const session = new CookieSession(); let id = 'actor-A';
  const delayed = deferred<Response>();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url === '/api/auth/me'
    ? Response.json({ account: account(id), studio: capabilities, studioRevision: 1 })
    : url.endsWith('/delayed') ? delayed.promise : Response.json({ name: `${id}-project` })));
  await session.verify(); render(<Boundary session={session} />);
  await screen.findByText('actor-A-project');
  const frame = document.querySelector('iframe[data-owner="actor-A"]')!;
  expect(frame.isConnected).toBe(true);
  studioLocalStorage().setItem('draft', 'A-private-draft');
  stashHomeComposerAttachments([new File(['synthetic'], 'A-private-file')]);
  const stale = studioFetch('/api/projects/delayed').catch((error: DOMException) => error.name);
  const frames: string[] = [];
  const capture = () => frames.push(document.body.textContent + (screen.queryByLabelText('draft') as HTMLInputElement | null)?.value);
  const observer = new MutationObserver(capture); observer.observe(document.body, { subtree: true, childList: true, characterData: true });
  act(() => session.withdraw());
  expect(frame.isConnected).toBe(false);
  capture();
  expect(studioLocalStorage().getItem('draft')).toBeNull();
  expect(peekHomeComposerAttachments()).toEqual([]);
  id = 'actor-B'; await act(() => session.verify());
  await screen.findByText('actor-B-project'); capture();
  expect(document.querySelector('iframe[data-owner="actor-A"]')).toBeNull();
  delayed.resolve(Response.json({ name: 'actor-A-late' }));
  expect(await stale).toBe('AbortError');
  capture(); observer.disconnect();
  expect(frames.length).toBeGreaterThan(2);
  expect(frames.every((frame) => !/actor-A|A-private/.test(frame))).toBe(true);
  expect((screen.getByLabelText('draft') as HTMLInputElement).value).toBe('');
  session.dispose();
});

it('suppresses unavailable domains before fetch and cancels owned timers on withdrawal', async () => {
  const session = new CookieSession();
  const network = vi.fn(async (url: string) => url === '/api/auth/me'
    ? Response.json({ account: account('actor'), studio: capabilities, studioRevision: 1 }) : Response.json({ name: 'owned-project' }));
  vi.stubGlobal('fetch', network);
  await session.verify(); render(<Boundary session={session} />); await screen.findByText('owned-project');
  const count = network.mock.calls.length;
  expect((await studioFetch('/api/agents')).status).toBe(503);
  expect((await studioFetch('https://example.invalid/private')).status).toBe(503);
  expect(network.mock.calls.length).toBe(count);
  vi.useFakeTimers(); const timer = vi.fn(); studioSetTimeout(timer, 50);
  act(() => session.withdraw()); vi.advanceTimersByTime(100);
  expect(timer).not.toHaveBeenCalled();
  session.dispose();
});

it('flushes a normal view departure but never an A pending write after B takes over', async () => {
  const session = new CookieSession(); let id = 'A';
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ account: account(id), studio: capabilities, studioRevision: 1 })));
  await session.verify();
  const writes: string[] = []; let pending: string | null = 'normal-tab';
  const flush = () => { if (pending) writes.push(pending); pending = null; };
  const discard = () => { pending = null; };
  const normalUnmount = bindStudioPendingWrite(session, session.snapshot().generation, flush, discard);
  normalUnmount(); expect(writes).toEqual(['normal-tab']);
  pending = 'A-private-tab';
  const staleUnmount = bindStudioPendingWrite(session, session.snapshot().generation, flush, discard);
  session.withdraw(); expect(pending).toBeNull();
  id = 'B'; await session.verify();
  staleUnmount(); expect(writes).toEqual(['normal-tab']);
  session.dispose();
});

it('retains outcome-unknown for an interrupted App mutation and never replays it', async () => {
  const session = new CookieSession(); const delayed = deferred<Response>();
  const requests = vi.fn(async (url: string) => url === '/api/auth/me'
    ? Response.json({ account: account('A'), studio: capabilities, studioRevision: 1 }) : delayed.promise);
  vi.stubGlobal('fetch', requests); await session.verify();
  const { activateStudioTransport } = await import('../../src/runtime/studio-transport');
  activateStudioTransport(session, session.snapshot().generation);
  const pending = studioFetch('/api/projects', { method: 'POST', body: JSON.stringify({ id: 'synthetic-project', name: 'Synthetic project' }) }).catch((e: DOMException) => e.name);
  session.withdraw();
  expect(session.snapshot().outcomeUnknown).toBe(true);
  delayed.resolve(Response.json({ project: { id: 'synthetic-project' } }, { status: 201 }));
  expect(await pending).toBe('AbortError');
  expect(requests.mock.calls.filter(([url]) => url === '/api/projects')).toHaveLength(1);
  session.dispose();
});

it('closes actor EventSource resources synchronously and refuses stale or unavailable streams', async () => {
  const { activateStudioTransport, studioEventSourceCtor } = await import('../../src/runtime/studio-transport');
  const closed = vi.fn(); const starts = vi.fn();
  vi.stubGlobal('EventSource', class {
    constructor(url: string | URL) { starts(String(url)); }
    addEventListener() {} close() { closed(); }
  });
  const session = new CookieSession();
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ account: account('A'),
    studio: { ...capabilities, features: { ...capabilities.features, settings: { status: 'pilot', reason: 'Actor manual settings' } } }, studioRevision: 1 })));
  await session.verify();
  activateStudioTransport(session, session.snapshot().generation, { usable: (lane) => lane === 'settings' });
  const Events = studioEventSourceCtor()!;
  new Events('/api/memory/events');
  expect(starts).toHaveBeenCalledOnce();
  expect(() => new Events('/api/plugins/events')).toThrow('Unavailable Studio stream');
  session.withdraw();
  expect(closed).toHaveBeenCalledOnce();
  expect(studioEventSourceCtor()).toBeNull();
  expect(() => new Events('/api/memory/events')).toThrow('Unavailable Studio stream');
  expect(starts).toHaveBeenCalledOnce();
  session.dispose();
});
