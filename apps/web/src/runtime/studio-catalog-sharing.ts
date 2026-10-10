import { useCallback, useEffect, useRef, useState } from 'react';
import type { StudioCatalogAccessResponse, StudioCatalogShareKind, StudioCatalogShareRole } from '@open-design/contracts';
import { studioFetch, studioRequestAvailable } from './studio-transport';

export interface StudioCatalogSharing {
  /** The session may share catalog items at all (catalogs and collaboration lanes usable). */
  available: boolean;
  /** Null until loaded, and after the actor lost access. */
  access: StudioCatalogAccessResponse | null;
  reload: () => void;
  share: (username: string, role: StudioCatalogShareRole) => Promise<'ok' | 'not-found' | 'limit' | 'error'>;
  revoke: (accountId: string) => Promise<boolean>;
  leave: () => Promise<boolean>;
}

const SEGMENT: Record<StudioCatalogShareKind, string> = { skill: 'skills', 'design-system': 'design-systems' };
const json = { 'Content-Type': 'application/json' };

/**
 * Team catalogs between accounts of one multi-user deployment (#61/#65): the
 * member list and use grants of one private skill or design document. Roles
 * come only from the daemon; nothing loads until `active` (the dialog opened).
 */
export function useStudioCatalogSharing(kind: StudioCatalogShareKind, resourceId: string, active: boolean): StudioCatalogSharing {
  const base = `/api/multiuser/catalog/${SEGMENT[kind]}/${encodeURIComponent(resourceId)}`;
  const available = studioRequestAvailable('GET', `${base}/access`);
  const [access, setAccess] = useState<StudioCatalogAccessResponse | null>(null);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => { setAccess(null); }, [base]);

  const reload = useCallback(() => {
    if (!available) return;
    void studioFetch(`${base}/access`).then(async (response) => {
      if (!live.current) return;
      setAccess(response.ok ? await response.json() as StudioCatalogAccessResponse : null);
    }).catch(() => {});
  }, [available, base]);

  useEffect(() => { if (active) reload(); }, [active, reload]);

  const share = useCallback(async (username: string, role: StudioCatalogShareRole) => {
    try {
      const response = await studioFetch(`${base}/shares`, { method: 'PUT', headers: json, body: JSON.stringify({ username: username.trim(), role }) });
      if (response.ok) { reload(); return 'ok' as const; }
      if (response.status === 404) return 'not-found' as const;
      return response.status === 409 ? 'limit' as const : 'error' as const;
    } catch { return 'error' as const; }
  }, [base, reload]);

  const revoke = useCallback(async (accountId: string) => {
    try {
      const response = await studioFetch(`${base}/shares/${encodeURIComponent(accountId)}`, { method: 'DELETE' });
      reload();
      return response.ok;
    } catch { return false; }
  }, [base, reload]);

  const leave = useCallback(async () => {
    try {
      const response = await studioFetch(`${base}/access`, { method: 'DELETE' });
      if (response.ok) setAccess(null);
      return response.ok;
    } catch { return false; }
  }, [base]);

  return { available, access, reload, share, revoke, leave };
}
