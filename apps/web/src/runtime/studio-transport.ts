import type { CookieSession } from '../multiuser/session';
import { withdrawStudioResources } from './studio-resources';

type Scope = { session: CookieSession; generation: number; abort: AbortController; storage: Map<string, string> };
// undefined is the original local runtime; null is a withdrawn cookie runtime.
let scope: Scope | null | undefined;

export function activateStudioTransport(session: CookieSession, generation: number): void {
  if (scope?.session === session && scope.generation === generation && !scope.abort.signal.aborted) return;
  scope?.abort.abort();
  scope = null;
  withdrawStudioResources();
  const next: Scope = { session, generation, abort: new AbortController(), storage: new Map() };
  scope = next;
  session.bindResource(() => {
    next.abort.abort(); next.storage.clear();
    if (scope === next) { scope = null; withdrawStudioResources(); }
  }, generation);
}

/** The pilot only consumes the established standard project and personal
 * account APIs. This is a UI availability boundary, never authorization. The
 * daemon still authenticates and authorizes each request independently. */
export function studioRequestAvailable(method: string, path: string): boolean {
  if (/^\/api\/(?:version|health)$/.test(path)) return method === 'GET';
  if (path === '/api/active') return method === 'GET' || method === 'POST';
  if (path === '/api/projects') return method === 'GET' || method === 'POST';
  if (/^\/api\/projects\/[^/]+$/.test(path)) return ['GET', 'PATCH', 'DELETE'].includes(method);
  if (/^\/api\/projects\/[^/]+\/conversations$/.test(path)) return ['GET', 'POST'].includes(method);
  if (/^\/api\/projects\/[^/]+\/conversations\/[^/]+$/.test(path)) return ['PATCH', 'DELETE'].includes(method);
  if (/^\/api\/projects\/[^/]+\/conversations\/[^/]+\/messages$/.test(path)) return method === 'GET';
  if (/^\/api\/projects\/[^/]+\/tabs$/.test(path)) return ['GET', 'PUT'].includes(method);
  if (/^\/api\/projects\/[^/]+\/events$/.test(path)) return method === 'GET';
  return false;
}

export function studioUsesLocalServices(): boolean { return scope === undefined; }

/** Shared request seam: unavailable domains never reach fetch, and a response
 * cannot be consumed after its issuing identity has been withdrawn. */
export function studioFetch(this: unknown, ...args: Parameters<typeof fetch>): Promise<Response> {
  // Keep the native call synchronous, including thrown errors and promise
  // identity. An async wrapper changes both even when it simply returns fetch.
  if (scope === undefined) return Reflect.apply(globalThis.fetch, this, args);
  return fetchInStudio(...args);
}

async function fetchInStudio(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const issued = scope;
  if (!issued || issued.abort.signal.aborted) throw new DOMException('Withdrawn Studio', 'AbortError');
  const requestUrl = input instanceof Request ? input.url : String(input);
  const url = new URL(requestUrl, window.location.origin);
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  if (url.origin !== window.location.origin || !studioRequestAvailable(method, url.pathname)) {
    return Response.json({ error: { code: 'STUDIO_UNAVAILABLE', message: 'This capability is not available in the Studio pilot.' } }, { status: 503 });
  }
  const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : null);
  const signal = AbortSignal.any([issued.abort.signal, ...(callerSignal ? [callerSignal] : [])]);
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  for (const key of [...headers.keys()]) if (/^(?:authorization|x-od-)/i.test(key)) headers.delete(key);
  const finish = ['GET', 'HEAD'].includes(method) ? () => {} : issued.session.beginMutation(issued.generation);
  try {
    const response = await globalThis.fetch(input, { ...init, headers, signal, credentials: 'same-origin', cache: 'no-store' });
    if (response.status === 401 && scope === issued) { issued.session.withdraw(); void issued.session.verify(); }
    if (signal.aborted || scope !== issued) { void response.body?.cancel(); throw new DOMException('Withdrawn Studio', 'AbortError'); }
    if (response.headers.get('content-type')?.includes('text/event-stream')) return response;
    // Fence parsing too: coalescers and state loaders receive only fully consumed
    // responses from their own generation, even when a transport ignores abort.
    const body = await response.arrayBuffer();
    if (signal.aborted || scope !== issued) throw new DOMException('Withdrawn Studio', 'AbortError');
    const buffered = new Response(response.status === 204 ? null : body, { status: response.status, statusText: response.statusText, headers: response.headers });
    const guard = (value: Response): Response => {
      for (const name of ['json', 'text', 'arrayBuffer', 'blob', 'formData'] as const) {
        const read = value[name].bind(value);
        Object.defineProperty(value, name, { value: async () => {
          const parsed = await read();
          if (signal.aborted || scope !== issued) throw new DOMException('Withdrawn Studio', 'AbortError');
          return parsed;
        } });
      }
      const clone = value.clone.bind(value);
      Object.defineProperty(value, 'clone', { value: () => guard(clone()) });
      return value;
    };
    return guard(buffered);
  } finally { finish(); }
}

/** Pilot drafts/preferences are memory-only and generation-scoped. Local-mode
 * storage semantics stay unchanged. Never read a host's persisted config into
 * a cookie actor, nor persist private pilot data in browser storage. */
function storage(kind: 'localStorage' | 'sessionStorage'): Storage {
  const prefix = `${kind}:`;
  const key = (name: string) => `${prefix}${name}`;
  const keys = () => [...(scope?.storage.keys() ?? [])].filter((name) => name.startsWith(prefix));
  return {
    get length() { return keys().length; },
    key(index) { return keys()[index]?.slice(prefix.length) ?? null; },
    getItem(name) { return scope?.storage.get(key(name)) ?? null; },
    setItem(name, value) { scope?.storage.set(key(name), String(value)); },
    removeItem(name) { scope?.storage.delete(key(name)); },
    clear() { for (const name of keys()) scope?.storage.delete(name); },
  };
}
const localMemory = storage('localStorage');
const sessionMemory = storage('sessionStorage');
// Return the original object in local mode: native method receivers, borrowed
// calls, spies, missing arguments and return values must remain untouched.
// Keep qualified and global bindings distinct (also in non-browser hosts).
export function studioLocalStorage(): Storage { return scope === undefined ? localStorage : localMemory; }
export function studioSessionStorage(): Storage { return scope === undefined ? sessionStorage : sessionMemory; }
export function studioWindowLocalStorage(): Storage { return scope === undefined ? window.localStorage : localMemory; }
export function studioWindowSessionStorage(): Storage { return scope === undefined ? window.sessionStorage : sessionMemory; }

function timer(repeat: boolean, handler: TimerHandler, delay?: number, ...args: unknown[]): number {
  const issued = scope;
  if (!issued) return 0;
  const schedule = repeat ? globalThis.setInterval : globalThis.setTimeout;
  const release = () => { globalThis.clearTimeout(id); globalThis.clearInterval(id); };
  const id = schedule(() => {
    if (!repeat) issued.abort.signal.removeEventListener('abort', release);
    if (scope === issued && !issued.abort.signal.aborted && typeof handler === 'function') handler(...args);
  }, delay);
  issued.abort.signal.addEventListener('abort', release, { once: true });
  return id as unknown as number;
}
export function studioWindowSetTimeout(...args: [TimerHandler, number?, ...unknown[]]): number {
  return scope === undefined ? Reflect.apply(window.setTimeout, window, args) : timer(false, ...args);
}
export function studioWindowSetInterval(...args: [TimerHandler, number?, ...unknown[]]): number {
  return scope === undefined ? Reflect.apply(window.setInterval, window, args) : timer(true, ...args);
}
export const studioSetTimeout = function (this: unknown, ...args: [TimerHandler, number?, ...unknown[]]) {
  return scope === undefined ? Reflect.apply(globalThis.setTimeout, this, args) : timer(false, ...args);
} as unknown as typeof setTimeout;
export const studioSetInterval = function (this: unknown, ...args: [TimerHandler, number?, ...unknown[]]) {
  return scope === undefined ? Reflect.apply(globalThis.setInterval, this, args) : timer(true, ...args);
} as unknown as typeof setInterval;
