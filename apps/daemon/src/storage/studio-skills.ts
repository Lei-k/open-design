import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { SkillDetail, SkillImportRequest, SkillSummary, SkillUpdateRequest } from '@open-design/contracts';
import { normalizeMode, slugifySkillName } from '../skills.js';
import { buildStudioSkillPackage, readStudioSkillPackages, type StudioSkillPackage } from '../services/studio-skill-packages.js';

interface SkillRow { id: string; owner_account_id: string; name: string; description: string; body: string;
  triggers_json: string; revision: number; deleted_at: number | null; package_json: string | null }

/** Browser folder imports carry no mode bits; scripts run by extension. */
export interface StudioSkillUploadFile { path: string; bytes: Buffer }

/** SKILL.md regenerated from the stored fields, so a text edit keeps the
 * package's document and the composed body identical. */
function skillDocument(name: string, description: string, body: string): Buffer {
  const quote = (value: string) => JSON.stringify(value);
  return Buffer.from(`---\nname: ${quote(name)}\n${description ? `description: ${quote(description)}\n` : ''}---\n${body}`);
}

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
    // Additive: text-only rows keep a NULL package and remain valid.
    for (const table of ['studio_skills', 'studio_skill_revisions']) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'package_json')) db.exec(`ALTER TABLE ${table} ADD COLUMN package_json TEXT`);
    }
  }
  private packageOf(row: SkillRow): StudioSkillPackage | undefined {
    if (row.package_json === null) return undefined;
    return readStudioSkillPackages([{ id: row.id, package: JSON.parse(row.package_json) }])[0];
  }
  private repackage(row: SkillRow, body: string, description: string): string | null {
    const resource = this.packageOf(row);
    if (!resource) return null;
    const files = resource.files.map((file) => ({ path: file.path, executable: file.executable,
      bytes: file.path === 'SKILL.md' ? skillDocument(row.name, description, body) : Buffer.from(file.data, 'base64') }));
    const next = buildStudioSkillPackage(row.id, files);
    readStudioSkillPackages([{ id: row.id, package: next }]);
    return JSON.stringify(next);
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
  read(owner: string, id: string): (SkillDetail & { package?: StudioSkillPackage }) | null {
    const row = this.row(owner, id);
    if (!row) return null;
    const resource = this.packageOf(row);
    return { ...this.summary(row), body: row.body, ...(resource ? { package: resource } : {}) };
  }
  private revision(row: SkillRow): void {
    this.db.prepare(`INSERT INTO studio_skill_revisions (skill_id, revision, body, description, triggers_json, created_at, package_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(row.id, row.revision, row.body, row.description, row.triggers_json, Date.now(), row.package_json);
  }
  create(owner: string, input: SkillImportRequest, upload?: readonly StudioSkillUploadFile[]): SkillSummary | null {
    const id = `studio-skill:${randomUUID()}`;
    const slug = slugifySkillName(input.name);
    if (!slug) return null;
    let packageJson: string | null = null;
    if (upload) {
      const files = upload.map((file) => ({ path: file.path, executable: false,
        bytes: file.path === 'SKILL.md' ? skillDocument(input.name.trim(), input.description ?? '', input.body) : file.bytes }));
      const resource = buildStudioSkillPackage(id, files);
      readStudioSkillPackages([{ id, package: resource }]);
      packageJson = JSON.stringify(resource);
    }
    return this.db.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM studio_skills WHERE owner_account_id = ? AND slug = ? AND deleted_at IS NULL').get(owner, slug)) return null;
      this.db.prepare(`INSERT INTO studio_skills (id, owner_account_id, name, slug, description, body, triggers_json, revision, package_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`).run(id, owner, input.name.trim(), slug, input.description ?? '', input.body, JSON.stringify(input.triggers ?? []), packageJson);
      const row = this.row(owner, id)!; this.revision(row);
      return this.summary(row);
    }).immediate();
  }
  update(owner: string, id: string, input: SkillUpdateRequest): SkillSummary | null {
    return this.db.transaction(() => {
      const existing = this.row(owner, id);
      if (!existing || (input.name !== undefined && input.name.trim() !== existing.name)) return null;
      const description = input.description ?? existing.description;
      this.db.prepare(`UPDATE studio_skills SET body = ?, description = ?, triggers_json = ?, revision = revision + 1, package_json = ?
        WHERE id = ? AND owner_account_id = ? AND deleted_at IS NULL`).run(input.body, description,
        JSON.stringify(input.triggers ?? JSON.parse(existing.triggers_json)), this.repackage(existing, input.body, description), id, owner);
      const row = this.row(owner, id)!; this.revision(row);
      return this.summary(row);
    }).immediate();
  }
  delete(owner: string, id: string): boolean {
    return this.db.prepare('UPDATE studio_skills SET deleted_at = ? WHERE id = ? AND owner_account_id = ? AND deleted_at IS NULL')
      .run(Date.now(), id, owner).changes > 0;
  }
}
