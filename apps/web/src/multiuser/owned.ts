import { useMemo, useEffect, useState } from 'react';
import { CookieSession } from './session';
import { isAbort } from './run-errors';
export type OwnedSession = { session: CookieSession; generation: number };
/** Mount and identity both own every request. Releasing either cancels the work. */
export function useOwnedRequest({ session, generation }: OwnedSession) {
  const [mount] = useState(() => ({ controller: new AbortController() }));
  useEffect(() => {
    if (mount.controller.signal.aborted) mount.controller = new AbortController();
    return session.bindMount(mount.controller, generation);
  }, [mount, session, generation]);
  return useMemo(() => Object.assign(
    <T,>(url: string, init?: RequestInit) => session.request<T>(url, { ...init, signal: init?.signal ? AbortSignal.any([mount.controller.signal, init.signal]) : mount.controller.signal }, generation),
    { active: () => !mount.controller.signal.aborted && session.snapshot().generation === generation },
  ), [session, generation, mount]);
}
export function useOwnedResource<T>(request: ReturnType<typeof useOwnedRequest>, url: string, revision: unknown = 0) {
  const [state, setState] = useState<{ data: T | null; error: unknown }>({ data: null, error: null });
  useEffect(() => {
    const controller = new AbortController();
    setState({ data: null, error: null });
    void request<T>(url, { signal: controller.signal }).then((data) => {
      if (!controller.signal.aborted && request.active()) setState({ data, error: null });
    }).catch((error) => { if (!controller.signal.aborted && request.active() && !isAbort(error)) setState({ data: null, error }); });
    return () => controller.abort();
  }, [request, url, revision]);
  return state;
}
