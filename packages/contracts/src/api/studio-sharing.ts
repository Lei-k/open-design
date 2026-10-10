// Project sharing between accounts of one multi-user deployment (#65).
//
// The owner grants another active account of the same deployment a role on
// one project. Identity is always the server session: a client never names a
// member, workspace or author. There is no relay off the deployment.

/** Least privilege first: each role includes the ones before it. */
export type StudioProjectShareRole = 'view' | 'comment' | 'edit';
export type StudioProjectAccessRole = 'owner' | StudioProjectShareRole;
export const STUDIO_PROJECT_SHARE_ROLES: readonly StudioProjectShareRole[] = ['view', 'comment', 'edit'];

export interface StudioProjectMember {
  /** Opaque account id; comment `authorMemberId` and presence `memberId` use it. */
  accountId: string;
  username: string;
  role: StudioProjectAccessRole;
  /** Epoch ms the grant was made (absent for the owner). */
  grantedAt?: number;
}

/** GET /api/multiuser/projects/:id/access — any member of the project. */
export interface StudioProjectAccessResponse {
  projectId: string;
  /** The caller's own role. */
  role: StudioProjectAccessRole;
  self: StudioProjectMember;
  owner: StudioProjectMember;
  /** Owner first, then grantees in grant order. */
  members: StudioProjectMember[];
  /** True when at least one other account has a grant. */
  shared: boolean;
}

/** PUT /api/multiuser/projects/:id/shares — owner only; adds or changes a grant. */
export interface StudioProjectShareRequest {
  username: string;
  role: StudioProjectShareRole;
}

export interface StudioProjectShareResponse {
  member: StudioProjectMember;
}

/** POST /api/projects/:id/presence/heartbeat in multi-user mode. */
export interface StudioPresenceHeartbeatRequest {
  /** Per-tab id so one account's two tabs are tracked separately. */
  clientId: string;
  filePath?: string | null;
}

/** POST /api/projects/:id/presence/leave in multi-user mode. */
export interface StudioPresenceLeaveRequest {
  clientId: string;
}

export function isStudioProjectShareRole(value: unknown): value is StudioProjectShareRole {
  return typeof value === 'string' && (STUDIO_PROJECT_SHARE_ROLES as readonly string[]).includes(value);
}

// ---- Team catalogs (#61/#65): private skills and design documents ----------
//
// The owner shares one private skill or design document with another active
// account of the same deployment, named by username and resolved on the
// server. The only grant is `use`: list, inspect, preview and select it in
// the grantee's own turns. The owner alone edits, revises, deletes and
// manages grants. A missing, foreign or insufficient resource is one 404.

export type StudioCatalogShareKind = 'skill' | 'design-system';
export type StudioCatalogShareRole = 'use';
export type StudioCatalogAccessRole = 'owner' | StudioCatalogShareRole;
export const STUDIO_CATALOG_SHARE_ROLES: readonly StudioCatalogShareRole[] = ['use'];
/** Grantees per shared skill or design document. */
export const STUDIO_CATALOG_GRANTS_MAX = 50;

/**
 * Read projection on catalog entries shared between accounts: `use` for an
 * entry shared with the reader, `owner` for the reader's own entry that has
 * at least one grantee. Absent for an unshared entry. Never mutation authority.
 */
export interface StudioCatalogShareSummary {
  role: StudioCatalogAccessRole;
  ownerUsername: string;
  /** Accounts with access, owner included. */
  memberCount: number;
}

export interface StudioCatalogMember {
  accountId: string;
  username: string;
  role: StudioCatalogAccessRole;
  /** Epoch ms the grant was made (absent for the owner). */
  grantedAt?: number;
}

/** GET /api/multiuser/catalog/{skills|design-systems}/:id/access — the owner or a grantee. */
export interface StudioCatalogAccessResponse {
  kind: StudioCatalogShareKind;
  resourceId: string;
  /** The caller's own role. */
  role: StudioCatalogAccessRole;
  self: StudioCatalogMember;
  owner: StudioCatalogMember;
  /** Owner first, then grantees in grant order. */
  members: StudioCatalogMember[];
  shared: boolean;
}

/** PUT /api/multiuser/catalog/{skills|design-systems}/:id/shares — owner only. */
export interface StudioCatalogShareRequest {
  username: string;
  role: StudioCatalogShareRole;
}

export interface StudioCatalogShareResponse {
  member: StudioCatalogMember;
}

export function isStudioCatalogShareRole(value: unknown): value is StudioCatalogShareRole {
  return typeof value === 'string' && (STUDIO_CATALOG_SHARE_ROLES as readonly string[]).includes(value);
}
