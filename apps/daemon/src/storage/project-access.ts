// Account-to-account project sharing for multi-user Studio (#65).
//
// The owner binding (`project-ownership.ts`) stays the single, immutable root
// of authority. A grant adds one non-owner account to one project with a role:
//   view    – read the project, its conversations, files, comments; export
//   comment – view + create comments and act on their own
//   edit    – comment + change files and run their own agent turns
// Grants live in the main daemon database next to the owner binding and are
// removed with the project row (`ON DELETE CASCADE`). Nothing is relayed off
// the deployment: there is no workspace, invitation link or member identity
// that a client could assert. The gate and every handler that rechecks access
// read the role from here on each request, so a revoke applies to the next
// request and to every open stream on its next recheck.
// Both endpoints must still be active accounts. Deactivation suspends access
// without deleting grants; reactivation restores the owner's existing choices.

import type Database from 'better-sqlite3';
import { ProjectOwnershipStore } from './project-ownership.js';

export const PROJECT_GRANTS_TABLE = 'multiuser_project_grants';
export const CONVERSATION_AUTHORS_TABLE = 'multiuser_conversation_authors';
export type ProjectShareRole = 'view' | 'comment' | 'edit';
export type ProjectAccessRole = 'owner' | ProjectShareRole;
export const PROJECT_SHARE_ROLES: readonly ProjectShareRole[] = ['view', 'comment', 'edit'];
/** Collaborators per project; sharing is for a team, not a broadcast list. */
export const PROJECT_GRANTS_MAX = 50;

const RANK: Record<ProjectAccessRole, number> = { view: 1, comment: 2, edit: 3, owner: 4 };

export function isProjectShareRole(value: unknown): value is ProjectShareRole {
  return typeof value === 'string' && (PROJECT_SHARE_ROLES as readonly string[]).includes(value);
}

/** True when `role` grants at least `required`. A missing role grants nothing. */
export function projectRoleAtLeast(role: ProjectAccessRole | null | undefined, required: ProjectAccessRole): boolean {
  return !!role && RANK[role] >= RANK[required];
}

export interface ProjectGrant {
  projectId: string;
  accountId: string;
  role: ProjectShareRole;
  grantedAt: number;
  updatedAt: number;
}

export function ensureProjectAccessSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${PROJECT_GRANTS_TABLE} (
      project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      grantee_account_id TEXT NOT NULL CHECK (length(grantee_account_id) > 0),
      role               TEXT NOT NULL CHECK (role IN ('view', 'comment', 'edit')),
      granted_at         INTEGER NOT NULL,
      updated_at         INTEGER NOT NULL,
      PRIMARY KEY (project_id, grantee_account_id)
    );
    CREATE INDEX IF NOT EXISTS idx_${PROJECT_GRANTS_TABLE}_grantee
      ON ${PROJECT_GRANTS_TABLE}(grantee_account_id);
    -- The account that created a conversation in multi-user mode. A conversation
    -- without a row predates sharing (or was seeded with the project) and is the
    -- project owner's.
    CREATE TABLE IF NOT EXISTS ${CONVERSATION_AUTHORS_TABLE} (
      conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
      account_id      TEXT NOT NULL CHECK (length(account_id) > 0)
    );
    CREATE TRIGGER IF NOT EXISTS ${CONVERSATION_AUTHORS_TABLE}_immutable
      BEFORE UPDATE ON ${CONVERSATION_AUTHORS_TABLE}
      BEGIN
        SELECT RAISE(ABORT, 'conversation author is immutable');
      END;
  `);
}

type GrantRow = { project_id: string; grantee_account_id: string; role: ProjectShareRole; granted_at: number; updated_at: number };
const toGrant = (row: GrantRow): ProjectGrant => ({
  projectId: row.project_id, accountId: row.grantee_account_id, role: row.role, grantedAt: row.granted_at, updatedAt: row.updated_at,
});

export interface ProjectAccessOptions {
  /** Live auth-store state, never cached across requests; missing accounts are inactive. */
  accountActive(accountId: string): boolean;
}

export class ProjectAccessStore {
  private readonly db: Database.Database;
  readonly ownership: ProjectOwnershipStore;

  constructor(db: Database.Database, private readonly options: ProjectAccessOptions) {
    this.db = db;
    this.ownership = new ProjectOwnershipStore(db);
    ensureProjectAccessSchema(db);
  }

  /**
   * The account's role on an existing, owned project. The owner binding wins
   * over any grant; a grant on a project whose row is gone, or an unowned
   * legacy row, grants nothing.
   */
  roleOf(projectId: string, accountId: string): ProjectAccessRole | null {
    if (typeof projectId !== 'string' || typeof accountId !== 'string' || !projectId || !accountId) return null;
    const owner = this.ownership.ownerOf(projectId);
    if (!owner || this.options.accountActive(owner) !== true || this.options.accountActive(accountId) !== true) return null;
    if (owner === accountId) return 'owner';
    const row = this.db.prepare(`SELECT role FROM ${PROJECT_GRANTS_TABLE} WHERE project_id = ? AND grantee_account_id = ?`)
      .get(projectId, accountId) as { role: ProjectShareRole } | undefined;
    return row ? row.role : null;
  }

  canView(projectId: string, accountId: string): boolean { return projectRoleAtLeast(this.roleOf(projectId, accountId), 'view'); }
  canComment(projectId: string, accountId: string): boolean { return projectRoleAtLeast(this.roleOf(projectId, accountId), 'comment'); }
  /** Owner or editor: may change files and run agent turns in the project. */
  canWrite(projectId: string, accountId: string): boolean { return projectRoleAtLeast(this.roleOf(projectId, accountId), 'edit'); }

  /** Record the creating account; call inside the transaction that inserts the conversation. */
  bindConversationAuthor(conversationId: string, accountId: string): void {
    this.db.prepare(`INSERT INTO ${CONVERSATION_AUTHORS_TABLE} (conversation_id, account_id) VALUES (?, ?)`).run(conversationId, accountId);
  }

  /**
   * Whether the account may write a conversation's transcript and run turns
   * in it: project write access, and the conversation is the account's own
   * (one without a recorded author is the owner's). Collaborators read each
   * other's conversations but never append to them, so no account's agent
   * history carries another account's messages.
   */
  canWriteConversation(projectId: string, conversationId: string, accountId: string): boolean {
    const role = this.roleOf(projectId, accountId);
    if (!projectRoleAtLeast(role, 'edit')) return false;
    const row = this.db.prepare(`SELECT c.project_id AS projectId, a.account_id AS author FROM conversations c
      LEFT JOIN ${CONVERSATION_AUTHORS_TABLE} a ON a.conversation_id = c.id WHERE c.id = ?`)
      .get(conversationId) as { projectId: string; author: string | null } | undefined;
    if (!row || row.projectId !== projectId) return false;
    return row.author === null ? role === 'owner' : row.author === accountId;
  }

  /** Snapshot of readable ids for synchronous SQL pagination in run lists. */
  readableProjectIds(accountId: string): string[] {
    if (!accountId || this.options.accountActive(accountId) !== true) return [];
    const rows = this.db.prepare(`SELECT o.project_id AS id, o.owner_account_id AS owner
      FROM multiuser_project_owners o JOIN projects p ON p.id = o.project_id
      WHERE o.owner_account_id = ? OR EXISTS (SELECT 1 FROM ${PROJECT_GRANTS_TABLE} g
        WHERE g.project_id = o.project_id AND g.grantee_account_id = ?)`).all(accountId, accountId) as Array<{ id: string; owner: string }>;
    return rows.filter((row) => this.options.accountActive(row.owner) === true).map((row) => row.id);
  }

  listGrants(projectId: string): ProjectGrant[] {
    return (this.db.prepare(`SELECT * FROM ${PROJECT_GRANTS_TABLE} WHERE project_id = ? ORDER BY granted_at, grantee_account_id`)
      .all(projectId) as GrantRow[]).map(toGrant);
  }

  /**
   * The account's view of every shared project it can read: projects granted
   * to it, and projects it owns that have at least one grant.
   */
  shareSummaries(accountId: string): Map<string, { role: ProjectAccessRole; ownerAccountId: string; memberCount: number }> {
    if (typeof accountId !== 'string' || !accountId || this.options.accountActive(accountId) !== true) return new Map();
    const rows = this.db.prepare(`SELECT o.project_id AS projectId, o.owner_account_id AS owner,
        (SELECT role FROM ${PROJECT_GRANTS_TABLE} g WHERE g.project_id = o.project_id AND g.grantee_account_id = ?) AS granted,
        (SELECT COUNT(*) FROM ${PROJECT_GRANTS_TABLE} g WHERE g.project_id = o.project_id) AS grants
      FROM multiuser_project_owners o JOIN projects p ON p.id = o.project_id
      WHERE EXISTS (SELECT 1 FROM ${PROJECT_GRANTS_TABLE} g WHERE g.project_id = o.project_id
        AND (o.owner_account_id = ? OR g.grantee_account_id = ?))`)
      .all(accountId, accountId, accountId) as Array<{ projectId: string; owner: string; granted: ProjectShareRole | null; grants: number }>;
    // Cache account state only within this synchronous read.
    const states = new Map<string, boolean>();
    const active = (id: string) => {
      if (!states.has(id)) states.set(id, this.options.accountActive(id) === true);
      return states.get(id)!;
    };
    return new Map(rows.filter((row) => active(row.owner)).map((row) => [row.projectId, {
      role: row.owner === accountId ? 'owner' as const : row.granted!, ownerAccountId: row.owner, memberCount: row.grants + 1,
    }]));
  }

  /**
   * Insert or change a grant. Refuses the owner (an owner is never a grantee)
   * and a project that has reached {@link PROJECT_GRANTS_MAX} other accounts.
   */
  setGrant(projectId: string, accountId: string, role: ProjectShareRole, at: number): { grant: ProjectGrant; previous: ProjectShareRole | null } {
    if (!isProjectShareRole(role)) throw new Error('invalid share role');
    return this.db.transaction(() => {
      const owner = this.ownership.ownerOf(projectId);
      if (!owner || this.options.accountActive(owner) !== true || this.options.accountActive(accountId) !== true) {
        throw new Error('project or account unavailable');
      }
      if (owner === accountId) throw new Error('the owner cannot be a grantee');
      const previous = this.db.prepare(`SELECT role FROM ${PROJECT_GRANTS_TABLE} WHERE project_id = ? AND grantee_account_id = ?`)
        .get(projectId, accountId) as { role: ProjectShareRole } | undefined;
      if (!previous) {
        const count = (this.db.prepare(`SELECT COUNT(*) AS n FROM ${PROJECT_GRANTS_TABLE} WHERE project_id = ?`).get(projectId) as { n: number }).n;
        if (count >= PROJECT_GRANTS_MAX) throw new GrantLimitError();
      }
      this.db.prepare(`INSERT INTO ${PROJECT_GRANTS_TABLE} (project_id, grantee_account_id, role, granted_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(project_id, grantee_account_id) DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at`)
        .run(projectId, accountId, role, at, at);
      const row = this.db.prepare(`SELECT * FROM ${PROJECT_GRANTS_TABLE} WHERE project_id = ? AND grantee_account_id = ?`)
        .get(projectId, accountId) as GrantRow;
      return { grant: toGrant(row), previous: previous?.role ?? null };
    })();
  }

  removeGrant(projectId: string, accountId: string): boolean {
    return this.db.prepare(`DELETE FROM ${PROJECT_GRANTS_TABLE} WHERE project_id = ? AND grantee_account_id = ?`)
      .run(projectId, accountId).changes > 0;
  }
}

export class GrantLimitError extends Error {
  constructor() { super('share limit reached for this project'); }
}
