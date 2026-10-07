import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { DesignSystemDetail, DesignSystemDocumentWrite, DesignSystemRevision } from '@open-design/contracts';

interface Row { id: string; owner_account_id: string; document_json: string; revision: number; deleted_at: number | null }

/** Account documents have globally unique ids and immutable versions. Bundled
 * systems are read through a separate source and cannot be shadowed or edited.
 */
export class StudioDesignSystems {
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS studio_design_systems (
      id TEXT PRIMARY KEY, owner_account_id TEXT NOT NULL, document_json TEXT NOT NULL,
      revision INTEGER NOT NULL, deleted_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS studio_design_system_versions (
      design_system_id TEXT NOT NULL REFERENCES studio_design_systems(id), revision INTEGER NOT NULL,
      document_json TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(design_system_id, revision)
    );
    CREATE TRIGGER IF NOT EXISTS studio_design_system_versions_immutable BEFORE UPDATE ON studio_design_system_versions
      BEGIN SELECT RAISE(ABORT, 'Design system version is immutable'); END;`);
  }
  private row(owner: string, id: string): Row | undefined {
    return this.db.prepare('SELECT * FROM studio_design_systems WHERE id = ? AND owner_account_id = ? AND deleted_at IS NULL')
      .get(id, owner) as Row | undefined;
  }
  read(owner: string, id: string): DesignSystemDetail | null {
    const row = this.row(owner, id);
    return row ? JSON.parse(row.document_json) as DesignSystemDetail : null;
  }
  list(owner: string): DesignSystemDetail[] {
    return (this.db.prepare('SELECT document_json FROM studio_design_systems WHERE owner_account_id = ? AND deleted_at IS NULL ORDER BY id')
      .all(owner) as Pick<Row, 'document_json'>[]).map((row) => JSON.parse(row.document_json) as DesignSystemDetail);
  }
  private persist(row: Row): void {
    this.db.prepare('INSERT INTO studio_design_system_versions (design_system_id, revision, document_json, created_at) VALUES (?, ?, ?, ?)')
      .run(row.id, row.revision, row.document_json, Date.now());
  }
  private document(id: string, patch: DesignSystemDocumentWrite, current?: DesignSystemDetail): DesignSystemDetail {
    const body = patch.body ?? current?.body ?? '';
    const now = new Date().toISOString();
    return { id, title: patch.title?.trim() || current?.title || 'Untitled',
      category: patch.category?.trim() || current?.category || 'Custom', summary: patch.summary ?? current?.summary ?? '',
      surface: patch.surface ?? current?.surface ?? 'web', status: patch.status ?? current?.status ?? 'draft',
      body, source: 'user', isEditable: true, canMutate: true,
      swatches: [...new Set(body.match(/#[0-9a-fA-F]{6}\b/g) ?? [])].slice(0, 8),
      createdAt: current?.createdAt ?? now, updatedAt: now };
  }
  create(owner: string, patch: DesignSystemDocumentWrite): DesignSystemDetail {
    const id = `user:studio_${randomUUID()}`;
    return this.db.transaction(() => {
      const document = this.document(id, patch);
      this.db.prepare('INSERT INTO studio_design_systems (id, owner_account_id, document_json, revision) VALUES (?, ?, ?, 1)')
        .run(id, owner, JSON.stringify(document));
      this.persist(this.row(owner, id)!);
      return document;
    }).immediate();
  }
  update(owner: string, id: string, patch: DesignSystemDocumentWrite): DesignSystemDetail | null {
    return this.db.transaction(() => {
      const current = this.read(owner, id);
      if (!current) return null;
      const document = this.document(id, patch, current);
      this.db.prepare('UPDATE studio_design_systems SET document_json = ?, revision = revision + 1 WHERE id = ? AND owner_account_id = ? AND deleted_at IS NULL')
        .run(JSON.stringify(document), id, owner);
      this.persist(this.row(owner, id)!);
      return document;
    }).immediate();
  }
  revisions(owner: string, id: string): DesignSystemRevision[] | null {
    if (!this.row(owner, id)) return null;
    let previous = '';
    return (this.db.prepare('SELECT revision, document_json, created_at FROM studio_design_system_versions WHERE design_system_id = ? ORDER BY revision')
      .all(id) as Array<{ revision: number; document_json: string; created_at: number }>).map((row) => {
      const document = JSON.parse(row.document_json) as DesignSystemDetail;
      const revision: DesignSystemRevision = { id: `document-${row.revision}`, designSystemId: id, status: 'accepted', feedback: '',
        baseBody: previous, proposedBody: document.body, createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.created_at).toISOString() };
      previous = document.body;
      return revision;
    });
  }
  delete(owner: string, id: string): boolean {
    return this.db.prepare('UPDATE studio_design_systems SET deleted_at = ? WHERE id = ? AND owner_account_id = ? AND deleted_at IS NULL')
      .run(Date.now(), id, owner).changes > 0;
  }
}
