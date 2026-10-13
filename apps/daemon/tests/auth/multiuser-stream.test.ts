import { EventEmitter } from 'node:events';
import type { Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindMultiUserStream, multiUserStreamAllowed, MULTIUSER_STREAM_RECHECK_MS, setMultiUserStreamAuthority } from '../../src/http/multiuser-stream.js';

function response() {
  const emitter = new EventEmitter();
  const result = Object.assign(emitter, { locals: {}, writableEnded: false,
    end: vi.fn(() => { result.writableEnded = true; emitter.emit('finish'); }) });
  return result as unknown as Response & { end: ReturnType<typeof vi.fn> };
}
afterEach(() => vi.useRealTimers());
describe('continuous Studio stream authority', () => {
  it('checks before each payload and closes immediately on revocation', () => {
    const res = response();
    let valid = true;
    setMultiUserStreamAuthority(res, () => valid);
    expect(multiUserStreamAllowed(res)).toBe(true);
    valid = false;
    expect(multiUserStreamAllowed(res)).toBe(false);
    expect(res.end).toHaveBeenCalledOnce();
    expect(multiUserStreamAllowed(res)).toBe(false);
    expect(res.end).toHaveBeenCalledOnce();
  });
  it('closes an idle stream at the authority deadline and releases its timer', () => {
    vi.useFakeTimers();
    const res = response();
    setMultiUserStreamAuthority(res, () => false);
    bindMultiUserStream(res);
    bindMultiUserStream(res);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(MULTIUSER_STREAM_RECHECK_MS - 1);
    expect(res.end).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(res.end).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('fails closed when authority storage fails and leaves single-user streams alone', () => {
    const single = response();
    expect(multiUserStreamAllowed(single)).toBe(true);
    const multi = response();
    setMultiUserStreamAuthority(multi, () => { throw new Error('database unavailable'); });
    expect(multiUserStreamAllowed(multi)).toBe(false);
  });
  it('releases its authority timer when the client disconnects', () => {
    vi.useFakeTimers();
    const res = response();
    setMultiUserStreamAuthority(res, () => true);
    bindMultiUserStream(res);
    res.emit('close');
    expect(vi.getTimerCount()).toBe(0);
  });
});
