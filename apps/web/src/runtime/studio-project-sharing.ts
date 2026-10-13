import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CollabCloudMemberDirectoryEntry, CollabPresenceMember, CollabPresenceResponse, StudioProjectAccessResponse,
  StudioProjectShareRole,
} from '@open-design/contracts';
import type { ProjectCollab } from '../collab/useProjectCollab';
import { randomUUID } from '../utils/uuid';
import { studioFetch, studioRequestAvailable, studioSetInterval } from './studio-transport';

const ACCESS_POLL_MS = 10_000;
const HEARTBEAT_MS = 10_000;

export interface StudioProjectSharing {
  /** The shared-project state the existing ProjectView/FileViewer collab UI consumes. */
  collab: ProjectCollab;
  /** Null until the first read, and after the actor lost access. */
  access: StudioProjectAccessResponse | null;
  /** The actor could read the project and no longer can (revoked, left or deleted). */
  revoked: boolean;
  reload: () => void;
  share: (username: string, role: StudioProjectShareRole) => Promise<'ok' | 'not-found' | 'limit' | 'error'>;
  revoke: (accountId: string) => Promise<boolean>;
  leave: () => Promise<boolean>;
}

const json = { 'Content-Type': 'application/json' };

/**
 * Project sharing between accounts of one multi-user deployment (#65), shaped
 * as the {@link ProjectCollab} state the shared project UI already renders:
 * the read-only banner, presence avatars and per-comment author permissions.
 * Identity and roles come only from the daemon (`/access`); presence names the
 * tab and file, never a member. Dormant (no requests) when `enabled` is false.
 */
export function useStudioProjectSharing(projectId: string | null, options: { enabled: boolean; filePath?: string | null }): StudioProjectSharing {
  const enabled = options.enabled && Boolean(projectId)
    && studioRequestAvailable('GET', `/api/multiuser/projects/${projectId}/access`);
  const [access, setAccess] = useState<StudioProjectAccessResponse | null>(null);
  const [present, setPresent] = useState<CollabPresenceMember[]>([]);
  const [revoked, setRevoked] = useState(false);
  const clientId = useMemo(() => randomUUID().replace(/[^A-Za-z0-9_-]/g, ''), []);
  const base = projectId ? `/api/multiuser/projects/${encodeURIComponent(projectId)}` : '';
  const presenceBase = projectId ? `/api/projects/${encodeURIComponent(projectId)}/presence` : '';
  const filePath = options.filePath ?? null;
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  useEffect(() => { setAccess(null); setPresent([]); setRevoked(false); }, [projectId]);

  const reload = useCallback(() => {
    if (!enabled) return;
    void studioFetch(`${base}/access`).then(async (response) => {
      if (!live.current) return;
      if (response.status === 404) { setAccess((previous) => { if (previous) setRevoked(true); return null; }); return; }
      if (response.ok) { setAccess(await response.json() as StudioProjectAccessResponse); setRevoked(false); }
    }).catch(() => {});
  }, [enabled, base]);

  const shared = Boolean(access?.shared);
  const refreshPresence = useCallback(() => {
    if (!enabled || !shared) return;
    void studioFetch(presenceBase).then(async (response) => {
      if (live.current && response.ok) setPresent(((await response.json()) as CollabPresenceResponse).present);
    }).catch(() => {});
  }, [enabled, shared, presenceBase]);

  useEffect(() => {
    if (!enabled) return undefined;
    reload();
    const timer = studioSetInterval(reload, ACCESS_POLL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') reload(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [enabled, reload]);

  // Heartbeat only while the project is actually shared; leave on unmount.
  useEffect(() => {
    if (!enabled || !shared) { setPresent([]); return undefined; }
    const beat = () => {
      void studioFetch(`${presenceBase}/heartbeat`, { method: 'POST', headers: json, body: JSON.stringify({ clientId, filePath }) })
        .then(async (response) => {
          if (live.current && response.ok) setPresent(((await response.json()) as CollabPresenceResponse).present);
        }).catch(() => {});
    };
    beat();
    const timer = studioSetInterval(beat, HEARTBEAT_MS);
    return () => {
      clearInterval(timer);
      void studioFetch(`${presenceBase}/leave`, { method: 'POST', headers: json, body: JSON.stringify({ clientId }), keepalive: true }).catch(() => {});
    };
  }, [enabled, shared, presenceBase, clientId, filePath]);

  const share = useCallback(async (username: string, role: StudioProjectShareRole) => {
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
      if (response.ok) { setAccess(null); setRevoked(true); }
      return response.ok;
    } catch { return false; }
  }, [base]);

  const collab = useMemo<ProjectCollab>(() => {
    const role = access?.role ?? null;
    const isOwner = role === 'owner';
    const writer = role === 'owner' || role === 'edit';
    const names = new Map((access?.members ?? []).map((member) => [member.accountId, member]));
    const resolveMember = (memberId: string | null | undefined): CollabCloudMemberDirectoryEntry | null => {
      const member = memberId ? names.get(memberId) : undefined;
      return member ? { memberId: member.accountId, displayName: member.username, role: member.role === 'owner' ? 'owner' : 'member' } : null;
    };
    return {
      enabled: shared,
      member: access ? { memberId: access.self.accountId, name: access.self.username, role: isOwner ? 'owner' : 'member', filePath } : null,
      present,
      publishedVersion: null,
      syncState: null,
      viewerOnly: revoked || (role !== null && !writer),
      writerAuthority: revoked ? 'denied' : role === null ? 'pending' : writer ? 'allowed' : 'denied',
      isOwner,
      isEffectiveOwner: isOwner,
      isSharedNonOwner: shared && role !== null && !isOwner,
      ownerDisplayName: shared && !isOwner ? access?.owner.username ?? null : null,
      ownerRole: shared && !isOwner ? 'owner' : null,
      downloadPending: false,
      reportChange: () => {},
      requestPublish: () => {},
      refreshPresence,
      checkStatusNow: reload,
      ...(role === null ? {} : { canComment: role !== 'view' }),
      resolveMember,
    };
  }, [access, shared, present, revoked, filePath, refreshPresence, reload]);

  return { collab, access, revoked, reload, share, revoke, leave };
}
