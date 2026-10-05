import { afterEach, expect, it, vi } from 'vitest';
import { CookieSession } from '../../src/multiuser/session';
import { watchRunEvents } from '../../src/multiuser/run-stream';
const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach((fn) => fn()); vi.unstubAllGlobals(); vi.useRealTimers(); });
it('replays and reconnects without delivering a persisted sequence twice', async () => {
  vi.useFakeTimers();
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const fetcher = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } })));
  vi.stubGlobal('fetch', fetcher);
  const session = new CookieSession();
  const seen: string[] = [];
  const reconnect = vi.fn();
  const stop = watchRunEvents({ session, generation: 0 }, 'run', (frame) => seen.push(String(frame.data.text ?? frame.event)), reconnect, vi.fn());
  cleanups.push(stop);
  await vi.advanceTimersByTimeAsync(0);
  stream.enqueue(new TextEncoder().encode('id: 1\nevent: agent\ndata: {"text":"first"}\n\n'));
  stream.close();
  await vi.advanceTimersByTimeAsync(0);
  expect(seen).toEqual(['first']); expect(reconnect).toHaveBeenLastCalledWith(true);
  await vi.advanceTimersByTimeAsync(1499); expect(fetcher).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); expect(fetcher).toHaveBeenCalledTimes(2);
  stream.enqueue(new TextEncoder().encode('id: 1\nevent: agent\ndata: {"text":"first"}\n\nid: 2\nevent: agent\ndata: {"text":"second"}\n\nid: 3\nevent: end\ndata: {"status":"succeeded"}\n\n'));
  await vi.advanceTimersByTimeAsync(10_000);
  expect(seen).toEqual(['first', 'second', 'end']); expect(fetcher).toHaveBeenCalledTimes(2);
});
it.each(['withdraw', 'unmount'])('cancels an open reader on %s even when transport ignores abort', async (action) => {
  let signal: AbortSignal | null | undefined;
  const cancel = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    signal = init?.signal;
    return new Response(new ReadableStream<Uint8Array>({ cancel }));
  }));
  const session = new CookieSession();
  const event = vi.fn();
  const stop = watchRunEvents({ session, generation: 0 }, 'run', event, vi.fn(), vi.fn());
  cleanups.push(stop);
  await vi.waitFor(() => expect(signal).toBeTruthy());
  if (action === 'withdraw') session.withdraw(); else stop();
  expect(signal?.aborted).toBe(true);
  await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
  expect(event).not.toHaveBeenCalled();
});
it('a stream 401 withdraws identity without retrying', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn(async () => new Response('{}', { status: 401 }));
  vi.stubGlobal('fetch', fetcher);
  const session = new CookieSession();
  cleanups.push(watchRunEvents({ session, generation: 0 }, 'run', vi.fn(), vi.fn(), vi.fn()));
  await vi.advanceTimersByTimeAsync(10_000);
  expect(session.snapshot().status).toBe('anonymous'); expect(fetcher).toHaveBeenCalledTimes(1);
});
it('does not keep reconnecting an inaccessible run', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn(async () => new Response('{}', { status: 404 }));
  vi.stubGlobal('fetch', fetcher);
  const session = new CookieSession(); const failure = vi.fn();
  cleanups.push(watchRunEvents({ session, generation: 0 }, 'missing', vi.fn(), vi.fn(), failure));
  await vi.advanceTimersByTimeAsync(10_000);
  expect(failure).toHaveBeenCalledTimes(1); expect(fetcher).toHaveBeenCalledTimes(1);
});
function endingStreams(bodies: string[]) {
  let index = 0;
  return vi.fn(async () => {
    const body = bodies[index++] ?? '';
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      if (body) controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    } }));
  });
}
/** Each entry is the wait since the previous connection; asserts both sides of the boundary. */
async function expectReconnects(fetcher: ReturnType<typeof vi.fn>, delays: number[]) {
  let calls = fetcher.mock.calls.length;
  for (const delay of delays) {
    await vi.advanceTimersByTimeAsync(delay - 1); expect(fetcher).toHaveBeenCalledTimes(calls);
    await vi.advanceTimersByTimeAsync(1); expect(fetcher).toHaveBeenCalledTimes(++calls);
  }
}
it('backs off exponentially up to a ceiling while a stream keeps ending without new events', async () => {
  vi.useFakeTimers();
  const fetcher = endingStreams([]);
  vi.stubGlobal('fetch', fetcher);
  const reconnect = vi.fn();
  cleanups.push(watchRunEvents({ session: new CookieSession(), generation: 0 }, 'run', vi.fn(), reconnect, vi.fn()));
  await vi.advanceTimersByTimeAsync(0);
  expect(fetcher).toHaveBeenCalledTimes(1);
  await expectReconnects(fetcher, [1_500, 3_000, 6_000, 12_000, 24_000, 30_000, 30_000]);
  expect(reconnect).toHaveBeenLastCalledWith(true);
});
it('resets the backoff after a connection delivers a new event, not after a replay', async () => {
  vi.useFakeTimers();
  const event = 'id: 1\nevent: agent\ndata: {"text":"new"}\n\n';
  const fetcher = endingStreams(['', '', event, event, '']);
  vi.stubGlobal('fetch', fetcher);
  const seen = vi.fn();
  cleanups.push(watchRunEvents({ session: new CookieSession(), generation: 0 }, 'run', seen, vi.fn(), vi.fn()));
  await vi.advanceTimersByTimeAsync(0);
  // empty, empty, new event (reset), replayed event only (no reset), empty.
  await expectReconnects(fetcher, [1_500, 3_000, 1_500, 3_000]);
  expect(seen).toHaveBeenCalledTimes(1);
});
it('stops a scheduled reconnect when the owner releases the stream', async () => {
  vi.useFakeTimers();
  const fetcher = endingStreams([]);
  vi.stubGlobal('fetch', fetcher);
  const stop = watchRunEvents({ session: new CookieSession(), generation: 0 }, 'run', vi.fn(), vi.fn(), vi.fn());
  await vi.advanceTimersByTimeAsync(0);
  stop();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
