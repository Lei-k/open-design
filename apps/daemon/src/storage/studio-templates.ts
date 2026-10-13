import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ProjectTemplate, StudioProjectMetadata, StudioTemplateSaveRequest } from '@open-design/contracts';
import type { StudioSnapshotFile } from '../projects/studio-snapshot.js';

export interface StudioTemplate extends ProjectTemplate { metadata: StudioProjectMetadata }

/** Each save creates immutable bytes. Deletion withdraws future catalog/use
 * authority, while projects already materialized from it retain their bytes. */
export class StudioTemplates {
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS studio_templates (
      id TEXT PRIMARY KEY, owner_account_id TEXT NOT NULL, snapshot_json TEXT NOT NULL, summary_json TEXT NOT NULL,
      created_at INTEGER NOT NULL, deleted_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS studio_templates_owner ON studio_templates(owner_account_id, deleted_at);
    CREATE TRIGGER IF NOT EXISTS studio_templates_immutable BEFORE UPDATE OF id, owner_account_id, snapshot_json, summary_json, created_at ON studio_templates
      BEGIN SELECT RAISE(ABORT, 'Template snapshot is immutable'); END;`);
  }
  read(owner: string, id: string): StudioTemplate | null {
    const row = this.db.prepare('SELECT snapshot_json FROM studio_templates WHERE id = ? AND owner_account_id = ? AND deleted_at IS NULL')
      .get(id, owner) as { snapshot_json: string } | undefined;
    return row ? JSON.parse(row.snapshot_json) as StudioTemplate : null;
  }
  list(owner: string): ProjectTemplate[] {
    // Do not load every snapshot's binary payload just to render Home.
    return (this.db.prepare('SELECT summary_json FROM studio_templates WHERE owner_account_id = ? AND deleted_at IS NULL ORDER BY created_at DESC, id')
      .all(owner) as Array<{ summary_json: string }>).map((row) => JSON.parse(row.summary_json) as ProjectTemplate);
  }
  save(owner: string, input: StudioTemplateSaveRequest, metadata: StudioProjectMetadata, files: StudioSnapshotFile[]): StudioTemplate {
    const item: StudioTemplate = { id: `studio-template:${randomUUID()}`, name: input.name.trim(), ...(input.description !== undefined ? { description: input.description } : {}),
      sourceProjectId: input.sourceProjectId, createdAt: Date.now(), metadata, fileCount: files.length,
      files: files.map((file) => ({ name: file.name, content: file.bytes.toString('base64'), encoding: 'base64' })) };
    const { metadata: _metadata, files: _files, ...summary } = item;
    this.db.prepare('INSERT INTO studio_templates (id, owner_account_id, snapshot_json, summary_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(item.id, owner, JSON.stringify(item), JSON.stringify({ ...summary, files: [] }), item.createdAt);
    return item;
  }
  delete(owner: string, id: string): boolean {
    return this.db.prepare('UPDATE studio_templates SET deleted_at = ? WHERE id = ? AND owner_account_id = ? AND deleted_at IS NULL')
      .run(Date.now(), id, owner).changes > 0;
  }
}
