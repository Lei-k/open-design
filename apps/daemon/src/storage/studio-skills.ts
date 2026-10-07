import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { SkillDetail, SkillImportRequest, SkillSummary, SkillUpdateRequest } from '@open-design/contracts';
import { normalizeMode, slugifySkillName } from '../skills.js';

interface SkillRow { id: string; owner_account_id: string; name: string; description: string; body: string;
  triggers_json: string; revision: number; deleted_at: number | null }

/** Text skills belong to the Web account, not to the daemon's installed tree.
 * Revisions are immutable; a run stores the selected revision's body at admission.
 * Every lookup includes the owner, including deletion and conflict checks.
 */
export class StudioSkills {
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS studio_skills (
      id TEXT PRIMARY KEY, owner_account_id TEXT NOT NULL, name TEXT NOT NULL,
      slug TEXT NOT NULL, description TEXT NOT NULL, body TEXT NOT NULL,
      triggers_json TEXT NOT NULL, revision INTEGER NOT NULL, deleted_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS studio_skills_active_name ON studio_skills(owner_account_id, slug) WHERE deleted_at IS NULL;
    CREATE TABLE IF NOT EXISTS studio_skill_revisions (
      skill_id TEXT NOT NULL REFERENCES studio_skills(id), revision INTEGER NOT NULL,
      body TEXT NOT NULL, description TEXT NOT NULL, triggers_json TEXT NOT NULL,
      created_at INTEGER NOT NULL, PRIMARY KEY(skill_id, revision)
    );
    CREATE TRIGGER IF NOT EXISTS studio_skill_revisions_immutable BEFORE UPDATE ON studio_skill_revisions
      BEGIN SELECT RAISE(ABORT, 'Skill revision is immutable'); END;`);
  }
  private row(owner: string, id: string): SkillRow | undefined {
    return this.db.prepare('SELECT * FROM studio_skills WHERE id = ? AND owner_account_id = ? AND deleted_at IS NULL').get(id, owner) as SkillRow | undefined;
  }
  private summary(row: SkillRow): SkillSummary {
    return { id: row.id, name: row.name, description: row.description,
      triggers: JSON.parse(row.triggers_json) as string[], mode: normalizeMode(undefined, row.body, row.description),
      source: 'user', previewType: '', designSystemRequired: false, defaultFor: [], upstream: null,
      hasBody: row.body.length > 0, examplePrompt: '', aggregatesExamples: false };
  }
  list(owner: string): SkillSummary[] {
    return (this.db.prepare('SELECT * FROM studio_skills WHERE owner_account_id = ? AND deleted_at IS NULL ORDER BY name, id').all(owner) as SkillRow[])
      .map((row) => this.summary(row));
  }
  read(owner: string, id: string): SkillDetail | null {
    const row = this.row(owner, id);
    return row ? { ...this.summary(row), body: row.body } : null;
  }
  private revision(row: SkillRow): void {
    this.db.prepare(`INSERT INTO studio_skill_revisions (skill_id, revision, body, description, triggers_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(row.id, row.revision, row.body, row.description, row.triggers_json, Date.now());
  }
  create(owner: string, input: SkillImportRequest): SkillSummary | null {
    const id = `studio-skill:${randomUUID()}`;
    const slug = slugifySkillName(input.name);
    if (!slug) return null;
    return this.db.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM studio_skills WHERE owner_account_id = ? AND slug = ? AND deleted_at IS NULL').get(owner, slug)) return null;
      this.db.prepare(`INSERT INTO studio_skills (id, owner_account_id, name, slug, description, body, triggers_json, revision)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1)`).run(id, owner, input.name.trim(), slug, input.description ?? '', input.body, JSON.stringify(input.triggers ?? []));
      const row = this.row(owner, id)!; this.revision(row);
      return this.summary(row);
    }).immediate();
  }
  update(owner: string, id: string, input: SkillUpdateRequest): SkillSummary | null {
    return this.db.transaction(() => {
      const existing = this.row(owner, id);
      if (!existing || (input.name !== undefined && input.name.trim() !== existing.name)) return null;
      this.db.prepare(`UPDATE studio_skills SET body = ?, description = ?, triggers_json = ?, revision = revision + 1
        WHERE id = ? AND owner_account_id = ? AND deleted_at IS NULL`).run(input.body, input.description ?? existing.description,
        JSON.stringify(input.triggers ?? JSON.parse(existing.triggers_json)), id, owner);
      const row = this.row(owner, id)!; this.revision(row);
      return this.summary(row);
    }).immediate();
  }
  delete(owner: string, id: string): boolean {
    return this.db.prepare('UPDATE studio_skills SET deleted_at = ? WHERE id = ? AND owner_account_id = ? AND deleted_at IS NULL')
      .run(Date.now(), id, owner).changes > 0;
  }
}
