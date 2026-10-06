import { parseStudioRuntimeCapabilities, type AuthAccount, type AuthSessionResponse, type StudioRuntimeCapabilities } from '@open-design/contracts';

export type SessionState = { generation: number; status: 'checking' | 'anonymous' | 'ready' | 'error'; account: AuthAccount | null; outcomeUnknown: boolean; studio?: StudioRuntimeCapabilities; studioRevision?: number };
export class RequestFailure extends Error {
  constructor(readonly status: number, readonly code: string | null = null) { super('Request failed'); }
}
export const AUTH_CHANGE_KEY = 'open-design:auth-change';
export const SESSION_CHECK_MS = 60_000;
/** A peer tab's `pending:` marker with no follow-up stops withholding verification after this long. */
export const EXTERNAL_MUTATION_MS = 10_000;

/** One in-memory cookie-session boundary. No credential or account is persisted. */
export class CookieSession {
  private state: SessionState = { generation: 0, status: 'checking', account: null, outcomeUnknown: false };
  private listeners = new Set<() => void>();
  private abort = new AbortController();
  private mutation = false;
  private externalMutation = false;
  private externalMutationTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingMutations = new Map<symbol, number>();
  private verificationRevision = 0;
  private checking = false;
  private recheckRequested = false;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.state;
  private publish(status: SessionState['status'], account: AuthAccount | null = null) {
    this.state = { ...this.state, status, account };
    this.listeners.forEach((listener) => listener());
  }
  clearOutcomeUnknown = () => {
    this.state = { ...this.state, outcomeUnknown: false };
    this.listeners.forEach((listener) => listener());
  };
  withdraw = () => {
    const outcomeUnknown = this.state.outcomeUnknown || [...this.pendingMutations.values()].includes(this.state.generation);
    this.verificationRevision++;
    this.abort.abort(); this.abort = new AbortController();
    this.state = { generation: this.state.generation + 1, status: 'checking', account: null, outcomeUnknown };
    this.listeners.forEach((listener) => listener());
  };
  dispose = () => {
    this.verificationRevision++; this.abort.abort(); this.recheckRequested = false;
    // A disposed listener can no longer receive a peer's completion marker.
    clearTimeout(this.externalMutationTimer); this.externalMutation = false;
  };
  private signalChange(pending = false) {
    // A random invalidation marker only; never identity, links or credentials.
    try { localStorage.setItem(AUTH_CHANGE_KEY, `${pending ? 'pending' : 'changed'}:${crypto.randomUUID()}`); } catch { /* storage unavailable */ }
  }
  private hasPendingMutation() {
    return [...this.pendingMutations.values()].includes(this.state.generation);
  }
  async request<T>(url: string, init?: RequestInit, generation = this.state.generation): Promise<T> {
    if (generation !== this.state.generation) throw new DOMException('Stale request', 'AbortError');
    const signal = init?.signal ? AbortSignal.any([this.abort.signal, init.signal]) : this.abort.signal;
    const ownedMutation = !['GET', 'HEAD'].includes((init?.method ?? 'GET').toUpperCase()) && !['/api/auth/login', '/api/auth/logout', '/api/auth/setup'].includes(url);
    const operation = Symbol();
    if (ownedMutation) {
      this.pendingMutations.set(operation, generation);
      this.verificationRevision++; // A check started before this write cannot publish over it.
      if (this.checking) this.recheckRequested = true;
    }
    try {
      const response = await fetch(url, { ...init, credentials: 'same-origin', cache: 'no-store', signal,
        headers: { 'Content-Type': 'application/json', ...init?.headers } });
      // A malformed denial body must not keep a dead session visible.
      const body: unknown = response.status === 204 ? null : await response.json().catch(() => null);
      // Check AFTER parsing, even if a transport ignores abort. A late 401 has no authority.
      if (signal.aborted || generation !== this.state.generation) throw new DOMException('Stale request', 'AbortError');
      if (!response.ok) {
        if (response.status === 401 && url !== '/api/auth/me' && !url.endsWith('/login') && !url.endsWith('/setup')) {
          this.withdraw(); this.publish('anonymous');
        }
        const error = body && typeof body === 'object' && 'error' in body ? body.error : null;
        const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : null;
        throw new RequestFailure(response.status, code);
      }
      return body as T;
    } finally {
      this.pendingMutations.delete(operation);
      if (this.recheckRequested && !this.hasPendingMutation() && !this.mutation && !this.externalMutation && !this.checking) void this.verify();
    }
  }
  /** Stream transport uses the same generation fence and cookie as JSON requests. */
  async stream(url: string, mountSignal: AbortSignal, generation: number): Promise<Response> {
    if (generation !== this.state.generation) throw new DOMException('Stale stream', 'AbortError');
    const signal = AbortSignal.any([this.abort.signal, mountSignal]);
    const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal, headers: { Accept: 'text/event-stream' } });
    if (signal.aborted || generation !== this.state.generation) {
      await response.body?.cancel();
      throw new DOMException('Stale stream', 'AbortError');
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401) { this.withdraw(); this.publish('anonymous'); }
      throw new RequestFailure(response.status);
    }
    return response;
  }
  /** A mount owns its resources; session withdrawal aborts them synchronously. */
  bindResource(release: () => void, generation: number): () => void {
    const signal = this.abort.signal;
    let released = false;
    const cleanup = () => {
      if (released) return;
      released = true;
      signal.removeEventListener('abort', cleanup);
      release();
    };
    if (signal.aborted || generation !== this.state.generation) cleanup();
    else signal.addEventListener('abort', cleanup, { once: true });
    return cleanup;
  }

  /** A mount owns its resources; session withdrawal aborts them synchronously. */
  bindMount(controller: AbortController, generation: number): () => void {
    const signal = this.abort.signal;
    const abort = () => controller.abort();
    if (signal.aborted || generation !== this.state.generation) abort();
    else signal.addEventListener('abort', abort, { once: true });
    return () => { signal.removeEventListener('abort', abort); controller.abort(); };
  }
  receiveAuthChange = (value: string | null) => {
    clearTimeout(this.externalMutationTimer);
    this.externalMutation = value?.startsWith('pending:') ?? false;
    this.withdraw();
    if (!this.externalMutation) { void this.verify(); return; }
    // A peer that closed mid-sign-in never sends its completion marker.
    this.externalMutationTimer = setTimeout(() => { this.externalMutation = false; void this.verify(); }, EXTERNAL_MUTATION_MS);
  };
  /**
   * Routine checks also run while an owned write is in flight, so a server-side
   * 401, deactivation or id/role change is not postponed by a hung write. A check
   * that began before a write still loses to it (revision fence), and a check
   * that overlapped a write is repeated once the write settles.
   */
  verify = async () => {
    if (this.abort.signal.aborted) this.abort = new AbortController();
    if (this.mutation || this.externalMutation || this.checking) { this.recheckRequested = true; return; }
    this.checking = true; this.recheckRequested = false;
    const generation = this.state.generation;
    const revision = this.verificationRevision;
    const duringWrite = this.hasPendingMutation();
    try {
      const result = await this.request<Partial<AuthSessionResponse>>('/api/auth/me');
      if (generation !== this.state.generation || revision !== this.verificationRevision || this.abort.signal.aborted) return;
      const a = result?.account;
      if (!a || typeof a.id !== 'string' || typeof a.username !== 'string' || typeof a.active !== 'boolean' || !['admin', 'user'].includes(a.role)) {
        this.withdraw(); this.publish('error'); return;
      }
      if (!a.active) { this.withdraw(); this.publish('anonymous'); return; }
      // Older daemons without the authenticated capability contract stay in the
      // legacy shell. A malformed advertised contract never enables Studio.
      const studio = result.studio === undefined ? undefined : parseStudioRuntimeCapabilities(result.studio);
      if ((result.studio !== undefined || result.studioRevision !== undefined) && (!studio
        || !Number.isSafeInteger(result.studioRevision) || result.studioRevision! < 0)) {
        this.withdraw(); this.publish('error'); return;
      }
      const previous = this.state.account;
      const changed = previous !== null && (previous.id !== a.id || previous.role !== a.role || previous.active !== a.active
        || this.state.studioRevision !== result.studioRevision
        || JSON.stringify(this.state.studio) !== JSON.stringify(studio));
      if (changed) this.withdraw();
      this.state = { ...this.state, studio: studio ?? undefined, studioRevision: result.studioRevision };
      this.publish('ready', a);
      // An overlapping write may take effect after this read; confirm once it settles.
      if (duringWrite && !changed) this.recheckRequested = true;
    } catch (error) {
      if (generation !== this.state.generation || revision !== this.verificationRevision) return;
      if (error instanceof RequestFailure && error.status === 401) { this.withdraw(); this.publish('anonymous'); return; }
      // A transport outage is not an identity change. Keep established form/link state.
      if (!this.state.account) this.publish('error');
    } finally {
      this.checking = false;
      if (this.recheckRequested && !this.hasPendingMutation() && !this.mutation && !this.externalMutation && !this.abort.signal.aborted) void this.verify();
    }
  };
  async login(username: string, password: string) {
    if (this.mutation) return;
    this.mutation = true; this.withdraw(); this.signalChange(true);
    try { await this.request('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }); }
    catch (error) { this.publish('anonymous'); throw error; }
    finally { this.mutation = false; this.signalChange(); }
    await this.verify();
  }
  async logout() {
    if (this.mutation) return;
    this.mutation = true; this.withdraw(); this.signalChange(true);
    try { await this.request('/api/auth/logout', { method: 'POST', body: '{}' }); this.publish('anonymous'); }
    catch { this.publish('error'); }
    finally { this.mutation = false; this.signalChange(); }
  }
}
