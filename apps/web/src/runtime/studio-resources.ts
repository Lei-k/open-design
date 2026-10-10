import type { CookieSession } from '../multiuser/session';
/** Private module state participates in the same synchronous identity boundary
 * as mounted React state. Registrations live for the module's lifetime. */
const resets = new Set<() => void>();
export function registerStudioReset(reset: () => void): void { resets.add(reset); }
export function withdrawStudioResources(): void {
  for (const reset of resets) reset();
}

/** Flush a normal view departure, but discard work before authority withdrawal.
 * Returning the session release directly would discard ordinary unmounts too. */
export function bindStudioPendingWrite(session: CookieSession, generation: number, flush: () => void, discard: () => void): () => void {
  let live = true;
  const release = session.bindResource(() => { live = false; discard(); }, generation);
  return () => { if (live) flush(); release(); };
}
