import { afterEach, expect, it, vi } from 'vitest';
import { CookieSession } from '../../src/multiuser/session';
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
afterEach(() => vi.unstubAllGlobals());
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
