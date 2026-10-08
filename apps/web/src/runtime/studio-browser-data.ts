import type { CookieSession } from '../multiuser/session';

/**
 * Web equivalent of the desktop "clear browser data / update cache" actions
 * (#67): remove what this browser keeps for the Studio origin, then end the
 * session on the server so the HttpOnly cookie is revoked rather than merely
 * forgotten. Account data on the server (projects, settings) is untouched,
 * and nothing here can reach another account or shared server caches.
 * Studio private state already lives only in generation-scoped memory; the
 * logout withdraws it through the session boundary.
 */
export async function clearStudioBrowserData(session: CookieSession,
  scope: { caches?: CacheStorage; localStorage?: Storage; sessionStorage?: Storage } = globalThis): Promise<void> {
  try {
    const store = scope.caches;
    if (store) await Promise.all((await store.keys()).map((key) => store.delete(key)));
  } catch { /* CacheStorage can be unavailable (insecure context, privacy mode). */ }
  for (const storage of [scope.sessionStorage, scope.localStorage]) {
    try { storage?.clear(); } catch { /* Blocked site data: nothing persisted to clear. */ }
  }
  await session.logout();
}
