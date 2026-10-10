import { describe, expect, it, vi } from 'vitest';
import { clearStudioBrowserData } from '../../src/runtime/studio-browser-data';
import type { CookieSession } from '../../src/multiuser/session';

function memoryStorage(seed: Record<string, string>): Storage {
  const data = new Map(Object.entries(seed));
  return { get length() { return data.size; }, clear: () => data.clear(), getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null, removeItem: (key) => { data.delete(key); }, setItem: (key, value) => { data.set(key, value); } };
}

describe('clearStudioBrowserData (#67)', () => {
  it('clears origin caches and storage, then revokes the session on the server', async () => {
    const order: string[] = [];
    const deleted: string[] = [];
    const caches = { keys: async () => ['studio-a', 'assets'], delete: async (key: string) => { deleted.push(key); order.push('cache'); return true; } } as unknown as CacheStorage;
    const local = memoryStorage({ 'od:locale': 'zh-TW', 'od:analytics': 'turns' });
    const session = memoryStorage({ draft: 'x' });
    const logout = vi.fn(async () => { order.push('logout'); });
    await clearStudioBrowserData({ logout } as unknown as CookieSession, { caches, localStorage: local, sessionStorage: session });
    expect(deleted).toEqual(['studio-a', 'assets']);
    expect(local.length).toBe(0); expect(session.length).toBe(0);
    expect(logout).toHaveBeenCalledOnce();
    expect(order.at(-1)).toBe('logout');
  });

  it('still signs out when browser storage is unavailable', async () => {
    const throwing = { clear: () => { throw new DOMException('blocked', 'SecurityError'); } } as unknown as Storage;
    const caches = { keys: async () => { throw new Error('insecure'); } } as unknown as CacheStorage;
    const logout = vi.fn(async () => {});
    await clearStudioBrowserData({ logout } as unknown as CookieSession, { caches, localStorage: throwing, sessionStorage: throwing });
    expect(logout).toHaveBeenCalledOnce();
  });
});
