import { afterEach, expect, it, vi } from 'vitest';
import { studioFetch, studioSetTimeout, studioSetInterval, studioWindowSetTimeout, studioWindowSetInterval, studioLocalStorage, studioSessionStorage, studioWindowLocalStorage, studioWindowSessionStorage } from '../../src/runtime/studio-transport';

afterEach(() => vi.unstubAllGlobals());

it('delegates fetch synchronously with the original receiver, arguments and promise', () => {
  const result = Promise.resolve(new Response());
  const calls: { receiver: unknown; args: unknown[] }[] = [];
  vi.stubGlobal('fetch', function (this: unknown, ...args: unknown[]) { calls.push({ receiver: this, args }); return result; });
  const receiver = {};
  expect(studioFetch.call(receiver, '/one')).toBe(result);
  expect(calls).toEqual([{ receiver, args: ['/one'] }]);
  studioFetch('/two', undefined);
  expect(calls[1]).toEqual({ receiver: undefined, args: ['/two', undefined] });
  const failure = new Error('native failure');
  vi.stubGlobal('fetch', () => { throw failure; });
  expect(() => studioFetch('/three')).toThrow(failure);
});

it.each([
  ['setTimeout', studioSetTimeout, studioWindowSetTimeout],
  ['setInterval', studioSetInterval, studioWindowSetInterval],
] as const)('preserves %s argument count, receiver and native handle', (name, bare, qualified) => {
  const handle = {};
  const calls: { receiver: unknown; args: unknown[] }[] = [];
  const native = function (this: unknown, ...args: unknown[]) { calls.push({ receiver: this, args }); return handle; };
  const win = { [name]: native };
  vi.stubGlobal(name, native); vi.stubGlobal('window', win);
  const callback = () => {};
  expect(bare(callback)).toBe(handle);
  expect(calls.pop()).toEqual({ receiver: undefined, args: [callback] });
  expect(qualified(callback)).toBe(handle);
  expect(calls.pop()).toEqual({ receiver: win, args: [callback] });
  expect(qualified(callback, undefined, 'payload')).toBe(handle);
  expect(calls.pop()).toEqual({ receiver: win, args: [callback, undefined, 'payload'] });
  const receiver = {};
  expect(Reflect.apply(bare, receiver, [callback, undefined, 'payload'])).toBe(handle);
  expect(calls.pop()).toEqual({ receiver, args: [callback, undefined, 'payload'] });
});

it.each([['localStorage', studioLocalStorage, studioWindowLocalStorage], ['sessionStorage', studioSessionStorage, studioWindowSessionStorage]] as const)(
  'preserves global and qualified %s bindings and every native method call', (name, getStorage, getWindowStorage) => {
    const calls: { receiver: unknown; args: unknown[] }[] = [];
    const method = function (this: unknown, ...args: unknown[]) { calls.push({ receiver: this, args }); return 'native'; };
    const native = { length: 7, getItem: method, setItem: method, key: method, clear: method, removeItem: method };
    vi.stubGlobal(name, native);
    const facade = getStorage();
    expect(facade).toBe(native);
    expect(facade.length).toBe(7);
    expect(facade.getItem('key')).toBe('native');
    expect(calls.pop()).toEqual({ receiver: native, args: ['key'] });
    Reflect.apply(facade.getItem, facade, []);
    expect(calls.pop()).toEqual({ receiver: native, args: [] });
    const qualified = { ...native };
    vi.stubGlobal('window', { [name]: qualified });
    expect(getWindowStorage()).toBe(qualified);
    expect(getStorage()).toBe(native);
    for (const value of [getStorage(), getWindowStorage()]) {
      for (const key of ['key', 'getItem', 'setItem', 'removeItem', 'clear'] as const) {
        for (const args of [[], ['key'], ['key', undefined], ['key', 'value', 'extra']]) {
          expect(Reflect.apply(value[key], value, args)).toBe('native');
          expect(calls.pop()).toEqual({ receiver: value, args });
          expect(Reflect.apply(value[key], qualified, args)).toBe('native');
          expect(calls.pop()).toEqual({ receiver: qualified, args });
        }
      }
    }
  },
);
