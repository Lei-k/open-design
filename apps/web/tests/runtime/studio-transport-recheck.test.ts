import { afterEach, expect, it, vi } from 'vitest';
import { CookieSession } from '../../src/multiuser/session';
import { activateStudioTransport, studioEventSourceCtor, studioMessageId, studioRequestAvailable } from '../../src/runtime/studio-transport';

class FakeEventSource extends EventTarget {
  constructor(readonly url: string | URL) { super(); }
  close() {}
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('keeps local ids and the native EventSource outside a Studio scope', () => {
  vi.stubGlobal('EventSource', FakeEventSource);
  expect(studioMessageId('abc')).toBe('abc');
  expect(studioEventSourceCtor()).toBe(FakeEventSource);
});

it('re-reads the session once when the server ends a Studio stream (#73) and namespaces ids', () => {
  vi.useFakeTimers();
  vi.stubGlobal('EventSource', FakeEventSource);
  const session = new CookieSession();
  const verify = vi.spyOn(session, 'verify').mockResolvedValue(undefined);
  activateStudioTransport(session, session.snapshot().generation, { messageIdPrefix: `mua_${'c'.repeat(24)}_`, usable: (lane) => lane === 'execution' });
  expect(studioMessageId('turn')).toBe(`mua_${'c'.repeat(24)}_turn`);
  expect(studioRequestAvailable('POST', '/api/runs')).toBe(true);
  const Ctor = studioEventSourceCtor()!;
  const stream = new Ctor('/api/projects/p/events');
  stream.dispatchEvent(new Event('error'));
  stream.dispatchEvent(new Event('error'));
  expect(verify).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(2_100);
  stream.dispatchEvent(new Event('error'));
  expect(verify).toHaveBeenCalledTimes(2);
  // Withdrawal ends the scope: later stream errors from that identity do nothing.
  session.withdraw();
  stream.dispatchEvent(new Event('error'));
  expect(verify).toHaveBeenCalledTimes(2);
  expect(studioRequestAvailable('POST', '/api/runs')).toBe(false);
});

it('never activates a scope for a generation the session has not published (#75)', () => {
  const session = new CookieSession();
  const stale = session.snapshot().generation;
  session.withdraw();
  activateStudioTransport(session, stale, { messageIdPrefix: `mua_${'d'.repeat(24)}_`, usable: () => true });
  expect(studioMessageId('x')).toBe('x');
  activateStudioTransport(session, session.snapshot().generation, { messageIdPrefix: `mua_${'d'.repeat(24)}_`, usable: () => true });
  expect(studioMessageId('x')).toBe(`mua_${'d'.repeat(24)}_x`);
});
