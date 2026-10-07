import type { StudioParityLaneId } from '@open-design/contracts';
import type { CookieSession } from '../multiuser/session';
import { withdrawStudioResources } from './studio-resources';

type Scope = {
  session: CookieSession; generation: number; abort: AbortController; storage: Map<string, string>;
  messageIdPrefix: string | null; usable: (lane: StudioParityLaneId) => boolean; lastRecheck: number;
};
// undefined is the original local runtime; null is a withdrawn cookie runtime.
let scope: Scope | null | undefined;

export function activateStudioTransport(session: CookieSession, generation: number,
  options: { messageIdPrefix?: string | undefined; usable?: (lane: StudioParityLaneId) => boolean } = {}): void {
  if (scope?.session === session && scope.generation === generation && !scope.abort.signal.aborted) return;
  // Called during render so children never fetch before activation (their
  // effects run first). Only the session's current generation may activate:
  // a concurrent render for any other generation can never claim the scope (#75).
  if (session.snapshot().generation !== generation) return;
  scope?.abort.abort();
  scope = null;
  withdrawStudioResources();
  const next: Scope = { session, generation, abort: new AbortController(), storage: new Map(),
    messageIdPrefix: options.messageIdPrefix ?? null, usable: options.usable ?? (() => false), lastRecheck: 0 };
  scope = next;
  session.bindResource(() => {
    next.abort.abort(); next.storage.clear();
    if (scope === next) { scope = null; withdrawStudioResources(); }
  }, generation);
}

/**
 * Transcript ids the App mints before a send. Local mode keeps its ids as-is;
 * a Studio actor's ids live in the namespace its session read returned, the
 * only one the daemon accepts from that actor. Deterministic bases (Home
 * handoff, question answers) stay deterministic within the namespace.
 */
export function studioMessageId(base: string): string {
  return scope?.messageIdPrefix ? `${scope.messageIdPrefix}${base}` : base;
}

const RUN = /^\/api\/runs\/[^/]+$/;
const RUN_ACTION = /^\/api\/runs\/[^/]+\/(?:events|cancel|steer|feedback)$/;
/** The pilot only consumes the established standard project and personal
 * account APIs. This is a UI availability boundary, never authorization. The
 * daemon still authenticates and authorizes each request independently. Run
 * endpoints open only while the execution lane is usable for this actor. */
export function studioRequestAvailable(method: string, path: string,
  usable: (lane: StudioParityLaneId) => boolean = (lane) => scope?.usable(lane) ?? false): boolean {
  if (/^\/api\/(?:version|health)$/.test(path)) return method === 'GET';
  if (path === '/api/active') return method === 'GET' || method === 'POST';
  if (path === '/api/projects') return method === 'GET' || method === 'POST';
  if (/^\/api\/projects\/[^/]+$/.test(path)) return ['GET', 'PATCH', 'DELETE'].includes(method);
  if (/^\/api\/projects\/[^/]+\/conversations$/.test(path)) return ['GET', 'POST'].includes(method);
  if (/^\/api\/projects\/[^/]+\/conversations\/[^/]+$/.test(path)) return ['PATCH', 'DELETE'].includes(method);
  if (/^\/api\/projects\/[^/]+\/conversations\/[^/]+\/messages$/.test(path)) return method === 'GET';
  if (/^\/api\/projects\/[^/]+\/conversations\/[^/]+\/messages\/[^/]+$/.test(path)) return method === 'PUT';
  if (/^\/api\/projects\/[^/]+\/tabs$/.test(path)) return ['GET', 'PUT'].includes(method);
  if (/^\/api\/projects\/[^/]+\/events$/.test(path)) return method === 'GET';
  if (usable('delivery')) {
    if (/^\/api\/(?:multiuser\/)?projects\/[^/]+\/archive$/.test(path)) return method === 'GET';
    if (/^\/api\/(?:multiuser\/)?projects\/[^/]+\/archive\/batch$/.test(path)) return method === 'POST';
    if (/^\/api\/(?:multiuser\/)?projects\/[^/]+\/export\/html$/.test(path)) return method === 'POST';
  }
  if (usable('home')) {
    if (path === '/api/import/files') return method === 'POST';
    if (/^\/api\/(?:multiuser\/)?projects\/[^/]+\/duplicate$/.test(path)) return method === 'POST';
    if (/^\/api\/(?:multiuser\/)?import\/claude-design$/.test(path)) return method === 'POST';
  }
  if (usable('catalogs')) {
    const catalogPath = path.replace(/^\/api\/multiuser\/catalog\//, '/api/');
    if (catalogPath === '/api/templates') return method === 'GET' || method === 'POST';
    if (/^\/api\/templates\/[^/]+$/.test(catalogPath)) return method === 'GET' || method === 'DELETE';
    if (catalogPath === '/api/design-systems') return method === 'GET' || method === 'POST';
    if (/^\/api\/design-systems\/[^/]+$/.test(catalogPath)) return ['GET', 'PATCH', 'DELETE'].includes(method);
    if (/^\/api\/design-systems\/[^/]+\/(?:files|file|revisions|preview|showcase)$/.test(catalogPath)) return method === 'GET';
    if (/^\/api\/(?:craft|design-templates)(?:\/[^/]+)?$/.test(catalogPath)) return method === 'GET';
    if (catalogPath === '/api/prompt-templates' || /^\/api\/prompt-templates\/[^/]+\/[^/]+$/.test(catalogPath)) return method === 'GET';
    const skillPath = path.replace(/^\/api\/multiuser\/catalog\/skills(?=\/|$)/, '/api/skills');
    if (skillPath === '/api/skills') return method === 'GET';
    if ((skillPath === '/api/skills/import' || skillPath === '/api/skills/import-files') && method === 'POST') return true;
    if (/^\/api\/skills\/[^/]+$/.test(skillPath)) return ['GET', 'PUT', 'DELETE'].includes(method);
    if (/^\/api\/skills\/[^/]+\/files$/.test(skillPath)) return method === 'GET';
  }
  if (usable('settings')) {
    const settingsPath = path.replace(/^\/api\/multiuser\/settings\/config$/, '/api/app-config')
      .replace(/^\/api\/multiuser\/settings\/memory(?=\/|$)/, '/api/memory');
    if (settingsPath === '/api/app-config') return method === 'GET' || method === 'PUT';
    if (settingsPath === '/api/memory') return method === 'GET' || method === 'POST';
    if (/^\/api\/memory\/(?:tree|events|system-prompt)$/.test(settingsPath)) return method === 'GET';
    if (settingsPath === '/api/memory/index') return method === 'PUT';
    if (settingsPath === '/api/memory/config') return method === 'PATCH';
    if (/^\/api\/memory\/tree\/[a-z0-9_]{1,128}$/.test(settingsPath)) return method === 'PATCH';
    if (/^\/api\/memory\/[a-z0-9_]{1,128}$/.test(settingsPath)) {
      if (['extractions', 'verifications', 'extract', 'rules', 'connectors'].includes(settingsPath.slice(12))) return false;
      return ['GET', 'PUT', 'DELETE'].includes(method);
    }
  }
  if (usable('files')) {
    const file = /^\/api\/projects\/[^/]+\/(files|folders|search|upload|raw|text-preview|file-content)(?:\/(.+))?$/.exec(path);
    if (file) {
      const [, area, rest] = file;
      if (area === 'files' && rest === undefined) return method === 'GET' || method === 'POST';
      if (area === 'files' && rest === 'rename') return method === 'POST';
      if (area === 'files' && /\/versions\/[^/]+\/restore$/.test(rest!)) return method === 'POST';
      if (area === 'files' && /\/versions$/.test(rest!)) return method === 'GET' || method === 'POST';
      // `files/<name>/preview` is the preview endpoint (#59), not a nested file.
      if (area === 'files') return /^[^/]+\/preview$/.test(rest!) ? false : method === 'GET' || method === 'DELETE';
      if (area === 'folders' && rest === undefined) return ['GET', 'POST', 'DELETE'].includes(method);
      if (area === 'search' && rest === undefined) return method === 'GET';
      if (area === 'upload' && rest === undefined) return method === 'POST';
      if (area === 'raw' && rest) return method === 'GET' || method === 'DELETE';
      if ((area === 'text-preview' || area === 'file-content') && rest) return method === 'GET';
      return false;
    }
  }
  if (usable('preview')) {
    if (/^\/api\/projects\/[^/]+\/preview-url$/.test(path)) return method === 'GET';
    if (/^\/api\/projects\/[^/]+\/chat-artifact-snapshots\/[^/]+(?:\/(?:content|thumbnail))?$/.test(path)
      || /^\/api\/projects\/[^/]+\/workspace-artifacts\/[^/]+$/.test(path)
      || /^\/api\/projects\/[^/]+\/conversations\/[^/]+\/messages\/[^/]+\/artifacts$/.test(path)) return method === 'GET';
    if (/^\/api\/multiuser\/projects\/[^/]+\/preview\/[^/]+\/renew$/.test(path)) return method === 'POST';
  }
  if (usable('execution')) {
    if (path === '/api/runs') return method === 'GET' || method === 'POST';
    if (RUN.test(path)) return method === 'GET';
    const action = RUN_ACTION.exec(path) ? path.slice(path.lastIndexOf('/') + 1) : null;
    if (action) return action === 'events' ? method === 'GET' : method === 'POST';
  }
  return false;
}

export function studioUsesLocalServices(): boolean { return scope === undefined; }

/** Local mode has every service; a Studio actor only the lanes its session made usable. */
export function studioLaneUsable(lane: StudioParityLaneId): boolean {
  return scope === undefined || (scope !== null && scope.usable(lane));
}

/**
 * The daemon closes this actor's streams within a second of an identity, role
 * or pilot-revision change, while ordinary requests keep succeeding. Treat a
 * server-ended stream or a refusal as a cue to re-read the session now rather
 * than at the next heartbeat (#73). Bounded so a flapping network cannot turn
 * it into a polling loop.
 */
function recheckSession(issued: Scope): void {
  const at = Date.now();
  if (scope !== issued || issued.abort.signal.aborted || at - issued.lastRecheck < 2_000) return;
  issued.lastRecheck = at;
  void issued.session.verify();
}

/** EventSource for Studio streams; the local runtime keeps the native class. */
export function studioEventSourceCtor(): typeof EventSource | null {
  if (typeof EventSource === 'undefined') return null;
  const issued = scope;
  if (issued === undefined) return EventSource;
  if (!issued || issued.abort.signal.aborted) return null;
  const active = issued;
  return class StudioEventSource extends EventSource {
    private release: (() => void) | undefined;
    constructor(url: string | URL, init?: EventSourceInit) {
      const target = new URL(String(url), window.location.origin);
      if (scope !== active || active.abort.signal.aborted || target.origin !== window.location.origin
        || !studioRequestAvailable('GET', target.pathname, active.usable)) throw new DOMException('Unavailable Studio stream', 'AbortError');
      super(url, init);
      this.release = active.session.bindResource(() => { super.close(); }, active.generation);
      this.addEventListener('error', () => recheckSession(active));
    }
    override close(): void { super.close(); this.release?.(); this.release = undefined; }
  };
}

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
    else if (response.status === 403) recheckSession(issued);
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
  // String handlers are eval; a Studio scope never schedules code from text (#75).
  if (typeof handler !== 'function') throw new TypeError('Studio timers require a function handler');
  const issued = scope;
  if (!issued) return 0;
  const schedule = repeat ? globalThis.setInterval : globalThis.setTimeout;
  const release = () => { globalThis.clearTimeout(id); globalThis.clearInterval(id); };
  const id = schedule(() => {
    if (!repeat) issued.abort.signal.removeEventListener('abort', release);
    if (scope === issued && !issued.abort.signal.aborted) handler(...args);
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
