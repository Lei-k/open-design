import { afterEach, expect, it, vi } from 'vitest';
import { CookieSession, EXTERNAL_MUTATION_MS } from '../../src/multiuser/session';
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
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
