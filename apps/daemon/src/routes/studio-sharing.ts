import type Database from 'better-sqlite3';
import type { Express, Request, Response } from 'express';
import type {
  CollabPresenceMember, CollabPresenceResponse, StudioProjectAccessResponse, StudioProjectMember, StudioProjectShareResponse,
} from '@open-design/contracts';
import { getProject } from '../db.js';
import { multiUserActorOf } from '../http/multiuser-gate.js';
import { sendApiError } from '../http/api-errors.js';
import { normalizeUsername } from '../services/auth-service.js';
import { AuthStore } from '../storage/auth-store.js';
import {
  GrantLimitError, ProjectAccessStore, isProjectShareRole, projectRoleAtLeast, type ProjectAccessRole, type ProjectShareRole,
} from '../storage/project-access.js';

/** A tab that stops heartbeating leaves the roster after this long. */
export const STUDIO_PRESENCE_TTL_MS = 30_000;
/** Bounds on process-local presence: tabs per account per project, tabs per project. */
const PRESENCE_TABS_PER_ACCOUNT = 8;
const PRESENCE_TABS_PER_PROJECT = 256;

export interface StudioSharingRoutes {
  close(): void;
}

type Tab = { accountId: string; clientId: string; filePath: string | null; at: number };

/**
 * Project sharing between accounts of one deployment (#65).
 *
 * - The owner grants, changes and revokes view/comment/edit for another active
 *   account, named by username and resolved here; nothing is relayed off the
 *   deployment and there is no invitation link or member identity a client
 *   could assert.
 * - Every member reads its own access and the member list; a grantee may
 *   leave. Admins have no implicit access.
 * - Presence is process-local: identity comes from the session, a client
 *   names only its tab and the file it is viewing, and a revoked member drops
 *   out of the roster on the next read.
 * - A revoke or a downgrade below edit stops the grantee's running turns in
 *   the project. Open streams and preview capabilities recheck the role on
 *   their own (gate stream authority, preview capability checks).
 */
export function registerStudioSharingRoutes(app: Express, input: {
  db: Database.Database;
  dataRoot: string;
  /** Push a thin invalidation onto the project's events stream. */
  emitProjectEvent: (projectId: string, payload: Record<string, unknown>) => void;
  /** Stop one account's turns in one project; resolves once they have exited. */
  cancelProjectRuns?: (accountId: string, projectId: string) => Promise<() => void>;
  clock?: () => number;
}): StudioSharingRoutes {
  const { db } = input;
  const now = input.clock ?? Date.now;
  const accounts = AuthStore.open({ dataRoot: input.dataRoot });
  const access = new ProjectAccessStore(db, { accountActive: (id) => accounts.getAccountById(id)?.active === true });
  const presence = new Map<string, Map<string, Tab>>();

  const signal = (projectId: string, type: 'presence-changed' | 'project-metadata-changed') => {
    try { input.emitProjectEvent(projectId, { type, projectId, at: now() }); } catch { /* best-effort signal */ }
  };
  const actorOf = (res: Response) => multiUserActorOf(res)?.accountId ?? '';
  const refuse = (res: Response) => sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'not found');
  /** The project and the actor's role, when the actor holds at least `required`. */
  const member = (req: Request, res: Response, required: ProjectAccessRole) => {
    const projectId = String(req.params.id);
    const actor = actorOf(res);
    const role = actor ? access.roleOf(projectId, actor) : null;
    if (!actor || !projectRoleAtLeast(role, required) || !getProject(db, projectId)) { refuse(res); return null; }
    return { projectId, actor, role: role! };
  };
  const usernameOf = (accountId: string) => accounts.getAccountById(accountId)?.username ?? '';
  const memberList = (projectId: string): StudioProjectMember[] => {
    const owner = access.ownership.ownerOf(projectId)!;
    return [
      { accountId: owner, username: usernameOf(owner), role: 'owner' },
      ...access.listGrants(projectId).map((grant) => ({
        accountId: grant.accountId, username: usernameOf(grant.accountId), role: grant.role, grantedAt: grant.grantedAt,
      })),
    ];
  };
  const stopTurns = async (accountId: string, projectId: string) => {
    if (!input.cancelProjectRuns) return;
    const release = await input.cancelProjectRuns(accountId, projectId).catch(() => null);
    release?.();
  };
  const dropPresence = (projectId: string, accountId: string) => {
    const tabs = presence.get(projectId);
    if (!tabs) return false;
    let dropped = false;
    for (const [key, tab] of tabs) if (tab.accountId === accountId) { tabs.delete(key); dropped = true; }
    if (tabs.size === 0) presence.delete(projectId);
    return dropped;
  };

  app.get('/api/multiuser/projects/:id/access', (req, res) => {
    const found = member(req, res, 'view'); if (!found) return;
    const members = memberList(found.projectId);
    const self = members.find((entry) => entry.accountId === found.actor)!;
    const response: StudioProjectAccessResponse = {
      projectId: found.projectId, role: found.role, self, owner: members[0]!, members, shared: members.length > 1,
    };
    res.set('Cache-Control', 'no-store').json(response);
  });

  app.delete('/api/multiuser/projects/:id/access', async (req, res) => {
    const found = member(req, res, 'view'); if (!found) return;
    if (found.role === 'owner') return sendApiError(res, 409, 'CONFLICT', 'the owner cannot leave their own project');
    access.removeGrant(found.projectId, found.actor);
    dropPresence(found.projectId, found.actor);
    await stopTurns(found.actor, found.projectId);
    signal(found.projectId, 'project-metadata-changed');
    signal(found.projectId, 'presence-changed');
    res.json({ ok: true });
  });

  app.put('/api/multiuser/projects/:id/shares', async (req, res) => {
    const found = member(req, res, 'owner'); if (!found) return;
    const body = req.body as { username: string; role: string };
    const username = normalizeUsername(body.username);
    const grantee = username ? accounts.getAccountByUsername(username) : null;
    // Owners name accounts they work with; an unknown, inactive or own username is one refusal.
    if (!grantee || !grantee.active || grantee.id === found.actor || !isProjectShareRole(body.role)) {
      return sendApiError(res, 404, 'NOT_FOUND', 'no active account with that username');
    }
    let previous: ProjectShareRole | null;
    let grantedAt: number;
    try {
      ({ previous, grant: { grantedAt } } = access.setGrant(found.projectId, grantee.id, body.role, now()));
    } catch (error) {
      if (error instanceof GrantLimitError) return sendApiError(res, 409, 'CONFLICT', error.message);
      return refuse(res);
    }
    if (previous === 'edit' && body.role !== 'edit') await stopTurns(grantee.id, found.projectId);
    signal(found.projectId, 'project-metadata-changed');
    const response: StudioProjectShareResponse = { member: { accountId: grantee.id, username: grantee.username, role: body.role, grantedAt } };
    res.json(response);
  });

  app.delete('/api/multiuser/projects/:id/shares/:accountId', async (req, res) => {
    const found = member(req, res, 'owner'); if (!found) return;
    const grantee = String(req.params.accountId);
    if (!access.removeGrant(found.projectId, grantee)) return sendApiError(res, 404, 'NOT_FOUND', 'no such member');
    const left = dropPresence(found.projectId, grantee);
    await stopTurns(grantee, found.projectId);
    signal(found.projectId, 'project-metadata-changed');
    if (left) signal(found.projectId, 'presence-changed');
    res.json({ ok: true });
  });

  /** Live tabs of current members, one roster entry per account (latest tab wins). */
  const roster = (projectId: string): CollabPresenceMember[] => {
    const tabs = presence.get(projectId);
    if (!tabs) return [];
    const cutoff = now() - STUDIO_PRESENCE_TTL_MS;
    const latest = new Map<string, Tab>();
    for (const [key, tab] of tabs) {
      const role = access.roleOf(projectId, tab.accountId);
      if (tab.at < cutoff || !role) { tabs.delete(key); continue; }
      const seen = latest.get(tab.accountId);
      if (!seen || seen.at < tab.at) latest.set(tab.accountId, tab);
    }
    if (tabs.size === 0) presence.delete(projectId);
    return [...latest.values()].sort((a, b) => a.accountId.localeCompare(b.accountId)).map((tab) => ({
      memberId: tab.accountId, name: usernameOf(tab.accountId),
      role: access.roleOf(projectId, tab.accountId) === 'owner' ? 'owner' as const : 'member' as const,
      filePath: tab.filePath, heartbeatAt: new Date(tab.at).toISOString(),
    }));
  };
  const sendRoster = (res: Response, projectId: string) => {
    const response: CollabPresenceResponse = { present: roster(projectId) };
    res.set('Cache-Control', 'no-store').json(response);
  };

  app.get('/api/multiuser/projects/:id/presence', (req, res) => {
    const found = member(req, res, 'view'); if (!found) return;
    sendRoster(res, found.projectId);
  });

  app.post('/api/multiuser/projects/:id/presence/heartbeat', (req, res) => {
    const found = member(req, res, 'view'); if (!found) return;
    const body = req.body as { clientId: string; filePath?: string | null };
    const key = `${found.actor}\u0000${body.clientId}`;
    let tabs = presence.get(found.projectId);
    const previous = tabs?.get(key);
    if (!previous) {
      roster(found.projectId); // expire stale tabs before counting
      tabs = presence.get(found.projectId);
      const mine = tabs ? [...tabs.values()].filter((tab) => tab.accountId === found.actor).length : 0;
      if ((tabs?.size ?? 0) >= PRESENCE_TABS_PER_PROJECT || mine >= PRESENCE_TABS_PER_ACCOUNT) {
        return sendApiError(res, 429, 'RATE_LIMITED', 'too many open tabs on this project');
      }
    }
    if (!tabs) { tabs = new Map(); presence.set(found.projectId, tabs); }
    const filePath = typeof body.filePath === 'string' ? body.filePath : null;
    tabs.set(key, { accountId: found.actor, clientId: body.clientId, filePath, at: now() });
    if (!previous || previous.filePath !== filePath) signal(found.projectId, 'presence-changed');
    sendRoster(res, found.projectId);
  });

  app.post('/api/multiuser/projects/:id/presence/leave', (req, res) => {
    const found = member(req, res, 'view'); if (!found) return;
    const tabs = presence.get(found.projectId);
    const removed = tabs?.delete(`${found.actor}\u0000${(req.body as { clientId: string }).clientId}`) ?? false;
    if (tabs?.size === 0) presence.delete(found.projectId);
    if (removed) signal(found.projectId, 'presence-changed');
    res.json({ ok: true });
  });

  return {
    close() {
      presence.clear();
      accounts.close();
    },
  };
}
