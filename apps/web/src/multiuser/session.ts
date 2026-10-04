import type { AuthAccount } from '@open-design/contracts';

export type SessionState = { generation: number; status: 'checking' | 'anonymous' | 'ready' | 'error'; account: AuthAccount | null };
export class RequestFailure extends Error {
  constructor(readonly status: number) { super('Request failed'); }
}
export const AUTH_CHANGE_KEY = 'open-design:auth-change';
export const SESSION_CHECK_MS = 60_000;

/** One in-memory cookie-session boundary. No credential or account is persisted. */
export class CookieSession {
  private state: SessionState = { generation: 0, status: 'checking', account: null };
  private listeners = new Set<() => void>();
  private abort = new AbortController();
  private mutation = false;
  private externalMutation = false;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.state;
  private publish(status: SessionState['status'], account: AuthAccount | null = null) {
    this.state = { ...this.state, status, account };
    this.listeners.forEach((listener) => listener());
  }
  withdraw = () => {
    this.abort.abort(); this.abort = new AbortController();
    this.state = { generation: this.state.generation + 1, status: 'checking', account: null };
    this.listeners.forEach((listener) => listener());
  };
  dispose = () => { this.abort.abort(); };
  private signalChange(pending = false) {
    // A random invalidation marker only; never identity, links or credentials.
    try { localStorage.setItem(AUTH_CHANGE_KEY, `${pending ? 'pending' : 'changed'}:${crypto.randomUUID()}`); } catch { /* storage unavailable */ }
  }
  async request<T>(url: string, init?: RequestInit, generation = this.state.generation): Promise<T> {
    if (generation !== this.state.generation) throw new DOMException('Stale request', 'AbortError');
    const signal = this.abort.signal;
    const response = await fetch(url, { ...init, credentials: 'same-origin', cache: 'no-store', signal,
      headers: { 'Content-Type': 'application/json', ...init?.headers } });
    // A malformed denial body must not keep a dead session visible.
    const body: unknown = response.status === 204 ? null : await response.json().catch(() => null);
    // Check AFTER parsing, even if a transport ignores abort. A late 401 has no authority.
    if (signal.aborted || generation !== this.state.generation) throw new DOMException('Stale request', 'AbortError');
    if (!response.ok) {
      if (response.status === 401 && !url.endsWith('/login') && !url.endsWith('/setup')) {
        this.withdraw(); this.publish('anonymous');
      }
      throw new RequestFailure(response.status);
    }
    return body as T;
  }
  receiveAuthChange = (value: string | null) => {
    this.externalMutation = value?.startsWith('pending:') ?? false;
    if (this.externalMutation) this.withdraw();
    else void this.verify();
  };
  verify = async () => {
    if (this.mutation || this.externalMutation) return;
    this.withdraw();
    const generation = this.state.generation;
    try {
      const result = await this.request<{ account: AuthAccount }>('/api/auth/me');
      if (generation !== this.state.generation || this.abort.signal.aborted) return;
      const a = result.account;
      if (!a || typeof a.id !== 'string' || typeof a.username !== 'string' || !a.active || !['admin', 'user'].includes(a.role)) throw new Error('Invalid identity');
      this.publish('ready', a);
    } catch (error) {
      if (generation !== this.state.generation) return;
      this.publish(error instanceof RequestFailure && error.status === 401 ? 'anonymous' : 'error');
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
