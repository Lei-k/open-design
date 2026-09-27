// Persistent actor -> project owner binding for multi-user mode (issue #3).
//
// Where it lives: the MAIN daemon SQLite database (the `app.sqlite` handle
// server.ts opens from RUNTIME_DATA_DIR), next to the `projects` table, not
// in the auth store. That is deliberate:
// - the binding is inserted inside the same SQLite transaction as the project
//   row and its seed conversation, so a project can never exist half-owned
//   (atomic create; a failed bind rolls the whole create back);
// - `ON DELETE CASCADE` removes the binding with the project row, so delete is
//   coherent and a later project reusing the id starts unowned;
// - the auth store stays credentials/sessions only. The owner column holds the
//   opaque auth account id; there is no cross-file foreign key, and an owner
//   whose account is gone simply has no session that can resolve to it.
//
// Invariants:
// - A binding is immutable: re-binding fails on the primary key and a trigger
//   aborts every UPDATE. There is no transfer/claim API.
// - A project row without a binding is owned by nobody. Nothing here (or in
//   the gate) auto-claims unbound/legacy rows.
// - The schema is created lazily, only when multi-user mode attaches the
//   store; single-user daemons never get this table.

import type Database from 'better-sqlite3';

export const PROJECT_OWNERS_TABLE = 'multiuser_project_owners';

export function ensureProjectOwnershipSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${PROJECT_OWNERS_TABLE} (
      project_id       TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      owner_account_id TEXT NOT NULL CHECK (length(owner_account_id) > 0),
      created_at       INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_${PROJECT_OWNERS_TABLE}_owner
      ON ${PROJECT_OWNERS_TABLE}(owner_account_id);
    CREATE TRIGGER IF NOT EXISTS ${PROJECT_OWNERS_TABLE}_immutable
      BEFORE UPDATE ON ${PROJECT_OWNERS_TABLE}
      BEGIN
        SELECT RAISE(ABORT, 'project owner binding is immutable');
      END;
  `);
}

export class ProjectOwnershipStore {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    ensureProjectOwnershipSchema(db);
  }

  /**
   * Record `ownerAccountId` as the immutable owner of an existing project.
   * Throws when the project is missing, already bound, or the owner is empty.
   * Call it inside the transaction that inserts the project row.
   */
  bindOwner(projectId: string, ownerAccountId: string, createdAt: number): void {
    if (typeof projectId !== 'string' || projectId.length === 0) {
      throw new Error('bindOwner requires a project id');
    }
    if (typeof ownerAccountId !== 'string' || ownerAccountId.length === 0) {
      throw new Error('bindOwner requires an owner account id');
    }
    this.db
      .prepare(`INSERT INTO ${PROJECT_OWNERS_TABLE} (project_id, owner_account_id, created_at) VALUES (?, ?, ?)`)
      .run(projectId, ownerAccountId, createdAt);
  }

  ownerOf(projectId: string): string | null {
    if (typeof projectId !== 'string') return null;
    const row = this.db
      .prepare(
        `SELECT o.owner_account_id AS owner
           FROM ${PROJECT_OWNERS_TABLE} o
           JOIN projects p ON p.id = o.project_id
          WHERE o.project_id = ?`,
      )
      .get(projectId) as { owner: string } | undefined;
    return row ? row.owner : null;
  }

  isOwnedBy(projectId: string, accountId: string): boolean {
    if (typeof accountId !== 'string' || accountId.length === 0) return false;
    return this.ownerOf(projectId) === accountId;
  }

  listOwnedProjectIds(accountId: string): Set<string> {
    if (typeof accountId !== 'string' || accountId.length === 0) return new Set();
    const rows = this.db
      .prepare(
        `SELECT o.project_id AS id
           FROM ${PROJECT_OWNERS_TABLE} o
           JOIN projects p ON p.id = o.project_id
          WHERE o.owner_account_id = ?`,
      )
      .all(accountId) as Array<{ id: string }>;
    return new Set(rows.map((row) => row.id));
  }
}
