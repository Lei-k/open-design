// Team catalogs for multi-user Studio (#61/#65): an account shares one of its
// private skills or design documents with other accounts of this deployment.
//
// The owner binding on the resource row (`studio_skills` /
// `studio_design_systems`) stays the single, immutable root of authority. A
// grant adds one grantee with the only role there is, `use`: list, inspect,
// preview and select the resource for the grantee's own turns. Editing,
// revisions, deletion and grant management stay with the owner. A grant on a
// deleted resource grants nothing, and owner deletion removes the grants.
// Every read recomputes the role from these rows, so a revoke applies to the
// next request; already admitted runs keep the version they captured.
//
// A grant is effective only while both the owner and the grantee are active
// accounts. Deactivation is a suspension decided at every access, not a
// cleanup: the rows stay, so reactivating the owner (or grantee) restores the
// grants exactly as the owner left them. Owner deletion of the resource and
// explicit revocation remain the only ways a grant ends.

import type Database from 'better-sqlite3';
import { STUDIO_CATALOG_GRANTS_MAX, type StudioCatalogAccessRole, type StudioCatalogShareKind } from '@open-design/contracts';

export const STUDIO_CATALOG_GRANTS_TABLE = 'studio_catalog_grants';
const RESOURCE_TABLE: Record<StudioCatalogShareKind, string> = { skill: 'studio_skills', 'design-system': 'studio_design_systems' };

export interface StudioCatalogGrant {
  kind: StudioCatalogShareKind;
  resourceId: string;
  accountId: string;
  grantedAt: number;
}

export class StudioCatalogGrantLimitError extends Error {
  constructor() { super('share limit reached for this item'); }
}

type GrantRow = { kind: StudioCatalogShareKind; resource_id: string; grantee_account_id: string; granted_at: number };
const toGrant = (row: GrantRow): StudioCatalogGrant => ({ kind: row.kind, resourceId: row.resource_id, accountId: row.grantee_account_id, grantedAt: row.granted_at });

export interface StudioCatalogGrantsOptions {
  /**
   * Live account state from the auth store (a separate database). Must answer
   * from the current row on every call; a missing account is inactive.
   */
  accountActive(accountId: string): boolean;
}

/** The resource tables must exist (their stores create them) before this store is used. */
export class StudioCatalogGrants {
  private readonly accountActive: (accountId: string) => boolean;

  constructor(private readonly db: Database.Database, options: StudioCatalogGrantsOptions) {
    this.accountActive = (accountId) => options.accountActive(accountId) === true;
    db.exec(`CREATE TABLE IF NOT EXISTS ${STUDIO_CATALOG_GRANTS_TABLE} (
      kind               TEXT NOT NULL CHECK (kind IN ('skill', 'design-system')),
      resource_id        TEXT NOT NULL CHECK (length(resource_id) > 0),
      grantee_account_id TEXT NOT NULL CHECK (length(grantee_account_id) > 0),
      role               TEXT NOT NULL CHECK (role = 'use'),
      granted_at         INTEGER NOT NULL,
      PRIMARY KEY (kind, resource_id, grantee_account_id)
    );
    CREATE INDEX IF NOT EXISTS idx_${STUDIO_CATALOG_GRANTS_TABLE}_grantee ON ${STUDIO_CATALOG_GRANTS_TABLE}(grantee_account_id, kind);`);
  }

  /** The owner of a live (not deleted) resource, or null. */
  ownerOf(kind: StudioCatalogShareKind, resourceId: string): string | null {
    if (typeof resourceId !== 'string' || !resourceId) return null;
    const row = this.db.prepare(`SELECT owner_account_id AS owner FROM ${RESOURCE_TABLE[kind]} WHERE id = ? AND deleted_at IS NULL`)
      .get(resourceId) as { owner: string } | undefined;
    return row?.owner ?? null;
  }

  /** Whether a grant from `owner` to `grantee` is in force: both accounts are active right now. */
  private grantInForce(owner: string, grantee: string): boolean {
    return this.accountActive(owner) && this.accountActive(grantee);
  }

  /**
   * The account's role on a live resource: the owner binding wins; no row, or
   * a row whose owner or grantee is deactivated, grants nothing.
   */
  roleOf(kind: StudioCatalogShareKind, resourceId: string, accountId: string): StudioCatalogAccessRole | null {
    if (typeof accountId !== 'string' || !accountId) return null;
    const owner = this.ownerOf(kind, resourceId);
    if (!owner) return null;
    if (owner === accountId) return 'owner';
    if (!this.grantInForce(owner, accountId)) return null;
    return this.db.prepare(`SELECT 1 FROM ${STUDIO_CATALOG_GRANTS_TABLE} WHERE kind = ? AND resource_id = ? AND grantee_account_id = ?`)
      .get(kind, resourceId, accountId) ? 'use' : null;
  }

  list(kind: StudioCatalogShareKind, resourceId: string): StudioCatalogGrant[] {
    return (this.db.prepare(`SELECT kind, resource_id, grantee_account_id, granted_at FROM ${STUDIO_CATALOG_GRANTS_TABLE}
      WHERE kind = ? AND resource_id = ? ORDER BY granted_at, grantee_account_id`).all(kind, resourceId) as GrantRow[]).map(toGrant);
  }

  /** Live resources shared with the account (not its own) by an active owner, with their owner. */
  sharedWith(kind: StudioCatalogShareKind, accountId: string): Array<{ resourceId: string; ownerAccountId: string }> {
    if (typeof accountId !== 'string' || !accountId) return [];
    return (this.db.prepare(`SELECT r.id AS resourceId, r.owner_account_id AS ownerAccountId FROM ${STUDIO_CATALOG_GRANTS_TABLE} g
      JOIN ${RESOURCE_TABLE[kind]} r ON r.id = g.resource_id AND r.deleted_at IS NULL
      WHERE g.kind = ? AND g.grantee_account_id = ? AND r.owner_account_id <> g.grantee_account_id ORDER BY g.granted_at, r.id`)
      .all(kind, accountId) as Array<{ resourceId: string; ownerAccountId: string }>)
      .filter((row) => this.grantInForce(row.ownerAccountId, accountId));
  }

  /** Accounts with access to each resource that has grants, owner included. */
  memberCounts(kind: StudioCatalogShareKind, resourceIds: readonly string[]): Map<string, number> {
    if (!resourceIds.length) return new Map();
    const rows = this.db.prepare(`SELECT resource_id AS id, COUNT(*) AS n FROM ${STUDIO_CATALOG_GRANTS_TABLE}
      WHERE kind = ? AND resource_id IN (${resourceIds.map(() => '?').join(', ')}) GROUP BY resource_id`)
      .all(kind, ...resourceIds) as Array<{ id: string; n: number }>;
    return new Map(rows.map((row) => [row.id, row.n + 1]));
  }

  /**
   * Add a grant (idempotent for an existing grantee). Refuses the owner and a
   * resource that already has {@link STUDIO_CATALOG_GRANTS_MAX} grantees.
   */
  set(kind: StudioCatalogShareKind, resourceId: string, accountId: string, at: number): StudioCatalogGrant {
    return this.db.transaction(() => {
      const owner = this.ownerOf(kind, resourceId);
      if (!owner) throw new Error('resource not found');
      if (owner === accountId) throw new Error('the owner cannot be a grantee');
      const existing = this.db.prepare(`SELECT kind, resource_id, grantee_account_id, granted_at FROM ${STUDIO_CATALOG_GRANTS_TABLE}
        WHERE kind = ? AND resource_id = ? AND grantee_account_id = ?`).get(kind, resourceId, accountId) as GrantRow | undefined;
      if (existing) return toGrant(existing);
      const count = (this.db.prepare(`SELECT COUNT(*) AS n FROM ${STUDIO_CATALOG_GRANTS_TABLE} WHERE kind = ? AND resource_id = ?`)
        .get(kind, resourceId) as { n: number }).n;
      if (count >= STUDIO_CATALOG_GRANTS_MAX) throw new StudioCatalogGrantLimitError();
      this.db.prepare(`INSERT INTO ${STUDIO_CATALOG_GRANTS_TABLE} (kind, resource_id, grantee_account_id, role, granted_at) VALUES (?, ?, ?, 'use', ?)`)
        .run(kind, resourceId, accountId, at);
      return { kind, resourceId, accountId, grantedAt: at };
    }).immediate();
  }

  remove(kind: StudioCatalogShareKind, resourceId: string, accountId: string): boolean {
    return this.db.prepare(`DELETE FROM ${STUDIO_CATALOG_GRANTS_TABLE} WHERE kind = ? AND resource_id = ? AND grantee_account_id = ?`)
      .run(kind, resourceId, accountId).changes > 0;
  }

  /** Owner deletion: every grant on the resource goes with it. */
  removeAll(kind: StudioCatalogShareKind, resourceId: string): number {
    return this.db.prepare(`DELETE FROM ${STUDIO_CATALOG_GRANTS_TABLE} WHERE kind = ? AND resource_id = ?`).run(kind, resourceId).changes;
  }
}
