import type { StudioParityLaneId } from '@open-design/contracts';
import type { CookieSession } from '../multiuser/session';
import { withdrawStudioResources } from './studio-resources';

type Scope = {
  session: CookieSession; generation: number; abort: AbortController; storage: Map<string, string>;
  messageIdPrefix: string | null; usable: (lane: StudioParityLaneId) => boolean; lastRecheck: number;
  renderedExports: boolean; researchSearch: boolean; connectors: boolean; mcpServers: boolean;
};
// undefined is the original local runtime; null is a withdrawn cookie runtime.
let scope: Scope | null | undefined;

export function activateStudioTransport(session: CookieSession, generation: number,
  options: { messageIdPrefix?: string | undefined; usable?: (lane: StudioParityLaneId) => boolean; renderedExports?: boolean; researchSearch?: boolean; connectors?: boolean; mcpServers?: boolean } = {}): void {
  if (scope?.session === session && scope.generation === generation && !scope.abort.signal.aborted) return;
  // Called during render so children never fetch before activation (their
  // effects run first). Only the session's current generation may activate:
  // a concurrent render for any other generation can never claim the scope (#75).
  if (session.snapshot().generation !== generation) return;
  scope?.abort.abort();
  scope = null;
  withdrawStudioResources();
  const next: Scope = { session, generation, abort: new AbortController(), storage: new Map(),
    messageIdPrefix: options.messageIdPrefix ?? null, usable: options.usable ?? (() => false), lastRecheck: 0,
    renderedExports: options.renderedExports === true, researchSearch: options.researchSearch === true, connectors: options.connectors === true,
    mcpServers: options.mcpServers === true };
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
  usable: (lane: StudioParityLaneId) => boolean = (lane) => scope?.usable(lane) ?? false,
  renderedExports: boolean = scope?.renderedExports ?? false,
  researchSearch: boolean = scope?.researchSearch ?? false,
  connectors: boolean = scope?.connectors ?? false,
  mcpServers: boolean = scope?.mcpServers ?? false): boolean {
  if (/^\/api\/(?:version|health)$/.test(path)) return method === 'GET';
  // Public, no-store deployment version (About → check for a newer deployment).
  if (path === '/api/version') return method === 'GET';
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
    // Deployment-local public links (#66): owner publish/read/revoke; served only from the preview origin.
    if (/^\/api\/projects\/[^/]+\/files\/.+\/publish-public$/.test(path)) return ['GET', 'POST', 'DELETE'].includes(method);
    if (/^\/api\/multiuser\/projects\/[^/]+\/public-links$/.test(path)) return method === 'GET';
    // Server-rendered formats exist only where the deployment configured a renderer (#66).
    if (/^\/api\/(?:multiuser\/)?projects\/[^/]+\/export\/(?:pptx|pdf-image|image)$/.test(path)) return renderedExports && method === 'POST';
  }
  if (usable('home')) {
    if (path === '/api/import/files') return method === 'POST';
    if (/^\/api\/(?:multiuser\/)?projects\/[^/]+\/duplicate$/.test(path)) return method === 'POST';
    if (/^\/api\/(?:multiuser\/)?import\/claude-design$/.test(path)) return method === 'POST';
  }
  // Team catalogs (#61/#65): use grants on the actor's private skills and design
  // documents to other accounts of this deployment. Needs both lanes.
  if (usable('catalogs') && usable('collaboration')) {
    const share = /^\/api\/multiuser\/catalog\/(?:skills|design-systems)\/[^/]+\/(access|shares)(\/[^/]+)?$/.exec(path);
    if (share) return share[1] === 'access' ? !share[2] && (method === 'GET' || method === 'DELETE') : share[2] ? method === 'DELETE' : method === 'PUT';
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
    // Bundled plugins (#61): the catalog with Web availability, owner-only apply onto an
    // owned project, applied snapshots and read-only marketplaces. Install, upgrade,
    // marketplace changes, doctor and trust stay closed. On the standard prefix the
    // static `stats`/`events` siblings keep their own (closed) routes, as on the daemon.
    if (catalogPath === '/api/plugins') return method === 'GET';
    if (/^\/api\/plugins\/[^/]+\/(?:preview|example\/[^/]+)$/.test(catalogPath)) return method === 'GET' || method === 'HEAD';
    const plugin = /^\/api\/plugins\/([^/]+)(\/apply)?$/.exec(catalogPath);
    if (plugin && !(path.startsWith('/api/plugins/') && ['stats', 'events'].includes(plugin[1]!))) return plugin[2] ? method === 'POST' : method === 'GET';
    if (/^\/api\/applied-plugins\/[^/]+$/.test(catalogPath)) return method === 'GET';
    if (catalogPath === '/api/marketplaces' || /^\/api\/marketplaces\/[^/]+(?:\/plugins)?$/.test(catalogPath)) return method === 'GET';
  }
  if (usable('automations')) {
    const routinePath = path.replace(/^\/api\/multiuser\/routines(?=\/|$)/, '/api/routines');
    if (routinePath === '/api/routines') return method === 'GET' || method === 'POST';
    if (/^\/api\/routines\/[^/]+$/.test(routinePath)) return ['GET', 'PATCH', 'DELETE'].includes(method);
    if (/^\/api\/routines\/[^/]+\/run$/.test(routinePath)) return method === 'POST';
    if (/^\/api\/routines\/[^/]+\/runs$/.test(routinePath)) return method === 'GET';
    // #64: bundled templates, the account's packets/proposals and crystallize of its own runs.
    if (/^\/api\/routines\/[^/]+\/runs\/[^/]+\/crystallize$/.test(routinePath)) return method === 'POST';
    const automationPath = path.replace(/^\/api\/multiuser\/automation-/, '/api/automation-');
    if (/^\/api\/automation-templates(?:\/[^/]+)?$/.test(automationPath)) return method === 'GET';
    if (/^\/api\/automation-source-packets(?:\/[^/]+)?$/.test(automationPath)) return method === 'GET';
    if (automationPath === '/api/automation-ingestions') return method === 'POST';
    if (automationPath === '/api/automation-proposals') return method === 'GET' || method === 'POST';
    if (/^\/api\/automation-proposals\/[^/]+$/.test(automationPath)) return method === 'GET';
    if (/^\/api\/automation-proposals\/[^/]+\/(?:apply|reject)$/.test(automationPath)) return method === 'POST';
  }
  // Account-private provider keys (#62/#63): write-only; reads carry last4 only.
  if (usable('execution')) {
    if (path === '/api/multiuser/settings/provider-keys') return method === 'GET';
    if (path === '/api/multiuser/settings/provider-keys/openai') return method === 'PUT';
    // Research keys (#63) exist only where the server advertises account research.
    if (path === '/api/multiuser/settings/provider-keys/tavily') return researchSearch && method === 'PUT';
  }
  // Account connectors (#62, S58): the company key state (administrators write it) and the
  // actor's own connections. Logos, the OAuth callback (a navigation) and tool routes stay closed.
  if (usable('settings') && connectors) {
    const connectorPath = path.replace(/^\/api\/multiuser\/connectors(?=\/|$)/, '/api/connectors')
      .replace(/^\/api\/connectors\/company-key$/, '/api/connectors/composio/config');
    if (connectorPath === '/api/connectors/composio/config') return method === 'GET' || method === 'PUT';
    if (['/api/connectors', '/api/connectors/status', '/api/connectors/discovery'].includes(connectorPath)) return method === 'GET';
    if (connectorPath === '/api/connectors/auth-configs/prepare') return method === 'POST';
    const connector = /^\/api\/connectors\/([a-z0-9_]+)(\/connect|\/authorization\/cancel|\/connection)?$/.exec(connectorPath);
    if (connector && !['logos', 'oauth', 'composio', 'auth-configs', 'status', 'discovery'].includes(connector[1]!)) {
      return connector[2] === '/connection' ? method === 'DELETE' : connector[2] ? method === 'POST' : method === 'GET';
    }
  }
  // Account remote MCP servers (#62, S60): the actor's own HTTP/SSE servers and their OAuth.
  // The OAuth callback is a navigation; stdio and the host Codex install are never opened.
  if (usable('settings') && mcpServers) {
    const mcpPath = path.replace(/^\/api\/mcp(?=\/)/, '/api/multiuser/mcp');
    if (mcpPath === '/api/multiuser/mcp/servers') return method === 'GET' || method === 'PUT' || (method === 'POST' && path.startsWith('/api/multiuser/'));
    if (/^\/api\/multiuser\/mcp\/servers\/[a-z0-9][a-z0-9_-]{0,63}$/.test(path)) return method === 'PATCH' || method === 'DELETE';
    if (/^\/api\/multiuser\/mcp\/servers\/[a-z0-9][a-z0-9_-]{0,63}\/test$/.test(path)) return method === 'POST';
    if (/^\/api\/multiuser\/mcp\/oauth\/(?:start|disconnect)$/.test(mcpPath)) return method === 'POST';
    if (/^\/api\/multiuser\/mcp\/oauth\/(?:refresh|cancel)$/.test(path)) return method === 'POST';
    if (mcpPath === '/api/multiuser/mcp/oauth/status') return method === 'GET';
  }
  // Account research (#63) on the account's own Tavily key.
  if (usable('generation') && researchSearch && /^\/api\/(?:multiuser\/)?research\/search$/.test(path)) return method === 'POST';
  if (usable('settings')) {
    const settingsPath = path.replace(/^\/api\/multiuser\/settings\/config$/, '/api/app-config')
      .replace(/^\/api\/multiuser\/settings\/memory(?=\/|$)/, '/api/memory');
    if (settingsPath === '/api/app-config') return method === 'GET' || method === 'PUT';
    // In-page pet (#67): the bundled catalog only; community sync stays host-owned.
    if (/^\/api\/(?:multiuser\/catalog\/)?codex-pets(?:\/[^/]+\/spritesheet)?$/.test(path)) return method === 'GET';
    if (settingsPath === '/api/memory') return method === 'GET' || method === 'POST';
    if (/^\/api\/memory\/(?:tree|events|system-prompt)$/.test(settingsPath)) return method === 'GET';
    if (settingsPath === '/api/memory/index') return method === 'PUT';
    if (settingsPath === '/api/memory/config') return method === 'PATCH';
    if (/^\/api\/memory\/tree\/[a-z0-9_]{1,128}$/.test(settingsPath)) return method === 'PATCH';
    // Automatic memory (#62): the account's own history, heuristic rule proposals and extract.
    if (settingsPath === '/api/memory/extractions' || settingsPath === '/api/memory/verifications') return method === 'GET' || method === 'DELETE';
    if (/^\/api\/memory\/(?:extractions|verifications)\/[^/]+$/.test(settingsPath)) return method === 'DELETE';
    if (settingsPath === '/api/memory/rules/suggest' || settingsPath === '/api/memory/extract') return method === 'POST';
    if (/^\/api\/memory\/[a-z0-9_]{1,128}$/.test(settingsPath)) {
      if (['extract', 'rules', 'connectors'].includes(settingsPath.slice(12))) return false;
      return ['GET', 'PUT', 'DELETE'].includes(method);
    }
  }
  // Data-backed Live Artifacts are readable without an OpenAI media source.
  if (usable('files') && usable('preview')) {
    const artifactPath = path.replace(/^\/api\/multiuser\/live-artifacts(?=\/|$)/, '/api/live-artifacts');
    if (artifactPath === '/api/live-artifacts') return method === 'GET' || method === 'POST';
    if (/^\/api\/live-artifacts\/[^/]+$/.test(artifactPath)) return ['GET', 'PATCH', 'DELETE'].includes(method);
    if (/^\/api\/live-artifacts\/[^/]+\/(preview|refreshes)$/.test(artifactPath)) return method === 'GET';
    if (/^\/api\/live-artifacts\/[^/]+\/refresh$/.test(artifactPath)) return method === 'POST';
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
    // Preview comments (#59), shared with project members (#65).
    const comment = /^\/api\/(?:multiuser\/)?projects\/[^/]+\/conversations\/[^/]+\/comments(?:\/([^/]+)(\/anchor|\/reorder)?)?$/.exec(path);
    if (comment) return comment[1] === undefined ? method === 'GET' || method === 'POST'
      : comment[2] ? method === 'PATCH' : method === 'PATCH' || method === 'DELETE';
  }
  if (usable('collaboration')) {
    // Account-to-account project sharing on this deployment (#65): members,
    // grants and session-stamped presence. Never Vela workspace or collab sync.
    if (/^\/api\/multiuser\/projects\/[^/]+\/access$/.test(path)) return method === 'GET' || method === 'DELETE';
    if (/^\/api\/multiuser\/projects\/[^/]+\/shares$/.test(path)) return method === 'PUT';
    if (/^\/api\/multiuser\/projects\/[^/]+\/shares\/[^/]+$/.test(path)) return method === 'DELETE';
    if (/^\/api\/projects\/[^/]+\/presence$/.test(path)) return method === 'GET';
    if (/^\/api\/projects\/[^/]+\/presence\/(?:heartbeat|leave)$/.test(path)) return method === 'POST';
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
