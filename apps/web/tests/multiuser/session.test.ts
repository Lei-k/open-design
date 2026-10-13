import { STUDIO_PARITY_LANES } from '@open-design/contracts';
import { afterEach, expect, it, vi } from 'vitest';
import { CookieSession, EXTERNAL_MUTATION_MS } from '../../src/multiuser/session';
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
it('releases private resources synchronously on withdrawal before publishing the next identity', () => {
  const session = new CookieSession();
  const release = vi.fn();
  const dispose = session.bindResource(release, session.snapshot().generation);
  const listener = vi.fn(() => expect(release).toHaveBeenCalledOnce());
  session.subscribe(listener);
  session.withdraw();
  expect(listener).toHaveBeenCalledOnce();
  dispose();
  expect(release).toHaveBeenCalledOnce();
  const stale = vi.fn();
  session.bindResource(stale, 0);
  expect(stale).toHaveBeenCalledOnce();
});
it.each([200, 401])('fences a stale parsed response (%s) even when abort is ignored', async (status) => {
  const body = deferred<unknown>();
  vi.stubGlobal('fetch', vi.fn(async () => ({ status, ok: status === 200, json: () => body.promise })));
  const session = new CookieSession();
  const old = session.request('/api/projects').catch((e) => e);
  await Promise.resolve(); session.withdraw();
  body.resolve({ projects: [{ name: 'Private A' }] });
  expect(await old).toMatchObject({ name: 'AbortError' });
  expect(session.snapshot()).toEqual({ status: 'checking', generation: 1, account: null, outcomeUnknown: false });
});
it('withdraws a current session on a 401 even when its body is not JSON', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ status: 401, ok: false, json: async () => { throw new SyntaxError('invalid JSON'); } })));
  const session = new CookieSession(); await session.request('/api/projects').catch(() => {});
  expect(session.snapshot().status).toBe('anonymous');
});
it('does not restore identity when withdrawal wins between request completion and verification publication', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ account: { id: 'a', username: 'alice', active: true, role: 'user' } }))));
  const session = new CookieSession();
  const request = session.request.bind(session);
  vi.spyOn(session, 'request').mockImplementation(async (...args) => {
    const value = await request(...args);
    // The transport completed, but its consumer has not yet published identity.
    session.withdraw();
    return value;
  });
  await session.verify();
  expect(session.snapshot().account).toBeNull();
  expect(session.snapshot().status).toBe('checking');
});

it('ignores a verification denial that started before a local mutation, then rechecks after settlement', async () => {
  const current = { id: 'a', username: 'alice', active: true, role: 'admin' };
  const heldCheck = deferred<Response>(); const heldWrite = deferred<Response>();
  let me = 0; let writeSignal: AbortSignal | undefined;
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    if (url === '/api/auth/me') return ++me === 2 ? heldCheck.promise : Promise.resolve(new Response(JSON.stringify({ account: current })));
    writeSignal = init?.signal as AbortSignal; return heldWrite.promise;
  }));
  const session = new CookieSession(); await session.verify();
  const generation = session.snapshot().generation;
  const check = session.verify(); const write = session.request('/api/auth/users', { method: 'POST', body: '{}' });
  heldCheck.resolve(new Response('{}', { status: 401 })); await check;
  expect(writeSignal?.aborted).toBe(false); expect(session.snapshot().account?.id).toBe('a');
  heldWrite.resolve(new Response('{}')); await write;
  await vi.waitFor(() => expect(me).toBe(3));
  expect(session.snapshot().generation).toBe(generation);
});

function meFetch() {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ account: { id: 'a', username: 'alice', active: true, role: 'user' } })));
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
it('re-verifies after an abandoned cross-tab pending marker expires; a new pending marker restarts the wait', async () => {
  vi.useFakeTimers();
  const fetcher = meFetch();
  const session = new CookieSession();
  expect(EXTERNAL_MUTATION_MS).toBe(10_000);
  session.receiveAuthChange('pending:first');
  await vi.advanceTimersByTimeAsync(5_000);
  session.receiveAuthChange('pending:second');
  await vi.advanceTimersByTimeAsync(9_999);
  expect(fetcher).not.toHaveBeenCalled();
  expect(session.snapshot().status).toBe('checking');
  await vi.advanceTimersByTimeAsync(1);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(session.snapshot()).toMatchObject({ status: 'ready', account: { id: 'a' } });
  session.dispose();
});
it('verifies once when a completion marker follows, and disposal cancels a pending expiry', async () => {
  vi.useFakeTimers();
  const fetcher = meFetch();
  const session = new CookieSession();
  session.receiveAuthChange('pending:peer');
  await vi.advanceTimersByTimeAsync(2_000);
  session.receiveAuthChange('changed:peer');
  await vi.advanceTimersByTimeAsync(30_000);
  expect(fetcher).toHaveBeenCalledTimes(1);
  session.receiveAuthChange('pending:again');
  session.dispose();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it.each([['studio', 2], ['legacy-multiuser', 2]] as const)('withdraws resources before publishing a changed pilot %s revision', async (shell, revision) => {
  const account = { id: 'a', username: 'alice', active: true, role: 'user' };
  let studio = { schemaVersion: 1, shell: 'studio', features: Object.fromEntries(STUDIO_PARITY_LANES.map(({ id }) => [id, { status: 'unavailable', reason: 'Pilot test' }])) };
  let studioRevision = 1;
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ account, studio, studioRevision }))));
  const session = new CookieSession();
  await session.verify();
  const generation = session.snapshot().generation;
  const release = vi.fn();
  session.bindResource(release, generation);
  const seen: unknown[] = [];
  session.subscribe(() => { seen.push(session.snapshot().account?.id ?? null); expect(release).toHaveBeenCalledOnce(); });
  studio = { ...studio, shell }; studioRevision = revision;
  await session.verify();
  expect(release).toHaveBeenCalledOnce();
  expect(seen).toEqual([null, 'a']);
  expect(session.snapshot().generation).toBe(generation + 1);
  session.dispose();
});

it.each([{ studioRevision: 1 }, { studio: null, studioRevision: 0 }, { studioRevision: '1' }])('withdraws on a malformed capability pair', async (fields) => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ account: { id: 'a', username: 'alice', active: true, role: 'user' }, ...fields }))));
  const session = new CookieSession();
  await session.verify();
  expect(session.snapshot()).toMatchObject({ account: null, status: 'error' });
  session.dispose();
});

const pilotStudio = (execution: 'pilot' | 'unavailable') => ({ schemaVersion: 1, shell: 'studio', features: Object.fromEntries(STUDIO_PARITY_LANES.map(({ id }) => [id,
  id === 'baseline' ? { status: 'supported' } : id === 'execution' ? { status: execution, reason: 'r' } : { status: 'unavailable', reason: 'r' }])) });
const meWith = (extra: Record<string, unknown>) => vi.fn(async () => new Response(JSON.stringify({
  account: { id: 'a', username: 'alice', active: true, role: 'user' }, studioRevision: 1, ...extra })));
it('publishes the pilot transcript-id namespace and refuses a pilot that cannot name one', async () => {
  const prefix = `mua_${'a'.repeat(24)}_`;
  vi.stubGlobal('fetch', meWith({ studio: pilotStudio('pilot'), studioMessageIdPrefix: prefix }));
  const ready = new CookieSession(); await ready.verify();
  expect(ready.snapshot()).toMatchObject({ status: 'ready', studioMessageIdPrefix: prefix });
  for (const extra of [{ studio: pilotStudio('pilot') }, { studio: pilotStudio('pilot'), studioMessageIdPrefix: 'mua_short_' },
    { studio: pilotStudio('unavailable'), studioMessageIdPrefix: 42 }]) {
    vi.stubGlobal('fetch', meWith(extra));
    const refused = new CookieSession(); await refused.verify();
    expect(refused.snapshot().status).toBe('error');
    expect(refused.snapshot().account).toBeNull();
  }
  // A pilot without execution may omit the namespace (it cannot send).
  vi.stubGlobal('fetch', meWith({ studio: pilotStudio('unavailable') }));
  const readOnly = new CookieSession(); await readOnly.verify();
  expect(readOnly.snapshot()).toMatchObject({ status: 'ready' });
  expect(readOnly.snapshot().studioMessageIdPrefix).toBeUndefined();
});
it('withdraws private state when the namespace changes under the same account', async () => {
  vi.stubGlobal('fetch', meWith({ studio: pilotStudio('pilot'), studioMessageIdPrefix: `mua_${'a'.repeat(24)}_` }));
  const session = new CookieSession(); await session.verify();
  const release = vi.fn();
  session.bindResource(release, session.snapshot().generation);
  vi.stubGlobal('fetch', meWith({ studio: pilotStudio('pilot'), studioMessageIdPrefix: `mua_${'b'.repeat(24)}_` }));
  await session.verify();
  expect(release).toHaveBeenCalledOnce();
  expect(session.snapshot().studioMessageIdPrefix).toBe(`mua_${'b'.repeat(24)}_`);
});
