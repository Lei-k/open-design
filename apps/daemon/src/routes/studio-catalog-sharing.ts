import type Database from 'better-sqlite3';
import type { Express, Request, Response } from 'express';
import type {
  StudioCatalogAccessResponse, StudioCatalogMember, StudioCatalogShareKind, StudioCatalogShareResponse, StudioCatalogShareSummary,
} from '@open-design/contracts';
import { isStudioCatalogShareRole } from '@open-design/contracts';
import { multiUserActorOf } from '../http/multiuser-gate.js';
import { sendApiError } from '../http/api-errors.js';
import { normalizeUsername } from '../services/auth-service.js';
import { AuthStore } from '../storage/auth-store.js';
import { StudioCatalogGrantLimitError, StudioCatalogGrants } from '../storage/studio-catalog-grants.js';
import { StudioDesignSystems } from '../storage/studio-design-systems.js';
import { StudioSkills } from '../storage/studio-skills.js';

export interface StudioCatalogSharing {
  grants: StudioCatalogGrants;
  usernameOf(accountId: string): string;
  /** The `studioShare` projection of one resource as `actor` sees it; absent for an unshared own entry. */
  projection(kind: StudioCatalogShareKind, resourceId: string, ownerAccountId: string, actor: string): StudioCatalogShareSummary | undefined;
  close(): void;
}

const SEGMENT: Record<StudioCatalogShareKind, string> = { skill: 'skills', 'design-system': 'design-systems' };

/**
 * Team catalogs between accounts of one deployment (#61/#65).
 *
 * - The owner of a private skill or design document grants `use` to another
 *   active account, named by username and resolved here. There is no relay,
 *   workspace, invitation link or client-asserted member.
 * - The owner and grantees read the member list; a grantee may leave. Admins
 *   hold only grants made to them.
 * - Missing, foreign and insufficient access are the same 404 on every route.
 * - Revocation applies to the next catalog read, preview and admission. Runs
 *   and conversations that already captured a version keep it.
 * - Deactivating the owner or the grantee suspends the grant the same way;
 *   reactivation restores it (the rows are never rewritten by deactivation).
 */
export function registerStudioCatalogSharingRoutes(app: Express, input: { db: Database.Database; dataRoot: string; clock?: () => number }): StudioCatalogSharing {
  const now = input.clock ?? Date.now;
  // The resource stores own (and create) the tables the grant store joins.
  new StudioSkills(input.db);
  new StudioDesignSystems(input.db);
  const accounts = AuthStore.open({ dataRoot: input.dataRoot });
  // Grants follow the live account state: a deactivated owner's (or grantee's)
  // grants are suspended at every access decision and apply again on reactivation.
  const grants = new StudioCatalogGrants(input.db, { accountActive: (accountId) => accounts.getAccountById(accountId)?.active === true });
  const usernameOf = (accountId: string) => accounts.getAccountById(accountId)?.username ?? '';
  const refuse = (res: Response) => sendApiError(res, 404, 'NOT_FOUND', 'not found');

  const projection: StudioCatalogSharing['projection'] = (kind, resourceId, ownerAccountId, actor) => {
    const memberCount = grants.memberCounts(kind, [resourceId]).get(resourceId) ?? 1;
    if (ownerAccountId === actor) return memberCount > 1 ? { role: 'owner', ownerUsername: usernameOf(actor), memberCount } : undefined;
    return { role: 'use', ownerUsername: usernameOf(ownerAccountId), memberCount };
  };

  for (const kind of ['skill', 'design-system'] as const) {
    const base = `/api/multiuser/catalog/${SEGMENT[kind]}/:id`;
    /** The resource and the actor's role, when the actor holds at least `required`. */
    const member = (req: Request, res: Response, required: 'owner' | 'use') => {
      const resourceId = String(req.params.id);
      const actor = multiUserActorOf(res)?.accountId ?? '';
      const role = actor ? grants.roleOf(kind, resourceId, actor) : null;
      if (!role || (required === 'owner' && role !== 'owner')) { refuse(res); return null; }
      return { resourceId, actor, role };
    };
    const memberList = (resourceId: string): StudioCatalogMember[] => {
      const owner = grants.ownerOf(kind, resourceId)!;
      return [
        { accountId: owner, username: usernameOf(owner), role: 'owner' },
        ...grants.list(kind, resourceId).map((grant) => ({ accountId: grant.accountId, username: usernameOf(grant.accountId), role: 'use' as const, grantedAt: grant.grantedAt })),
      ];
    };

    app.get(`${base}/access`, (req, res) => {
      const found = member(req, res, 'use'); if (!found) return;
      const members = memberList(found.resourceId);
      const response: StudioCatalogAccessResponse = { kind, resourceId: found.resourceId, role: found.role,
        self: members.find((entry) => entry.accountId === found.actor)!, owner: members[0]!, members, shared: members.length > 1 };
      res.json(response);
    });

    app.delete(`${base}/access`, (req, res) => {
      const found = member(req, res, 'use'); if (!found) return;
      if (found.role === 'owner') return sendApiError(res, 409, 'CONFLICT', 'the owner cannot leave their own item');
      grants.remove(kind, found.resourceId, found.actor);
      res.json({ ok: true });
    });

    app.put(`${base}/shares`, (req, res) => {
      const found = member(req, res, 'owner'); if (!found) return;
      const body = req.body as { username: string; role: string };
      const username = normalizeUsername(body.username);
      const grantee = username ? accounts.getAccountByUsername(username) : null;
      // An unknown, inactive or own username is one refusal.
      if (!grantee || !grantee.active || grantee.id === found.actor || !isStudioCatalogShareRole(body.role)) {
        return sendApiError(res, 404, 'NOT_FOUND', 'no active account with that username');
      }
      let grantedAt: number;
      try { ({ grantedAt } = grants.set(kind, found.resourceId, grantee.id, now())); }
      catch (error) {
        if (error instanceof StudioCatalogGrantLimitError) return sendApiError(res, 409, 'CONFLICT', error.message);
        return refuse(res);
      }
      const response: StudioCatalogShareResponse = { member: { accountId: grantee.id, username: grantee.username, role: 'use', grantedAt } };
      res.json(response);
    });

    app.delete(`${base}/shares/:accountId`, (req, res) => {
      const found = member(req, res, 'owner'); if (!found) return;
      if (!grants.remove(kind, found.resourceId, String(req.params.accountId))) return sendApiError(res, 404, 'NOT_FOUND', 'no such member');
      res.json({ ok: true });
    });
  }

  return { grants, usernameOf, projection, close() { accounts.close(); } };
}
