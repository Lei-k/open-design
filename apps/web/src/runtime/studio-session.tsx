import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { AUTH_CHANGE_KEY, CookieSession, SESSION_CHECK_MS, type SessionState } from '../multiuser/session';

export interface StudioSessionContextValue {
  session: CookieSession;
  state: SessionState;
}
const StudioSessionContext = createContext<StudioSessionContextValue | null>(null);

/** Shared identity boundary for both the fallback and the authenticated App.
 * No analytics, global workspace or single-user effects run from this provider.
 * `paused` keeps the setup entry public without probing private account APIs.
 */
export function StudioSessionProvider({ children, paused = false }: { children: ReactNode; paused?: boolean }) {
  const [session] = useState(() => new CookieSession());
  const state = useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot);
  useEffect(() => {
    if (paused) return;
    void session.verify();
    const verify = () => { if (document.visibilityState !== 'hidden') void session.verify(); };
    const storage = (event: StorageEvent) => {
      if (event.key === AUTH_CHANGE_KEY) flushSync(() => session.receiveAuthChange(event.newValue));
    };
    const hide = () => flushSync(() => session.withdraw());
    window.addEventListener('focus', verify);
    document.addEventListener('visibilitychange', verify);
    window.addEventListener('storage', storage);
    window.addEventListener('pagehide', hide);
    window.addEventListener('pageshow', verify);
    const timer = window.setInterval(verify, SESSION_CHECK_MS);
    return () => {
      session.dispose();
      clearInterval(timer);
      window.removeEventListener('pagehide', hide);
      window.removeEventListener('pageshow', verify);
      window.removeEventListener('focus', verify);
      document.removeEventListener('visibilitychange', verify);
      window.removeEventListener('storage', storage);
    };
  }, [session, paused]);
  return <StudioSessionContext.Provider value={{ session, state }}>{children}</StudioSessionContext.Provider>;
}

export function useStudioSession(): StudioSessionContextValue {
  const context = useContext(StudioSessionContext);
  if (!context) throw new Error('Studio session provider is required');
  return context;
}
