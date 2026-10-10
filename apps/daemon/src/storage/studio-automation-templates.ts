import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { STUDIO_AUTOMATION_LIMITS, type AutomationTemplate } from '@open-design/contracts';
import { normalizeAutomationTemplate } from '../automation-templates.js';

export class StudioTemplateRefusal extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) { super(message); }
}
const invalid = () => new StudioTemplateRefusal(400, 'invalid account automation template');
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number) => typeof value === 'string' && Boolean(value.trim()) && value.length <= max && !value.includes('\0');
const choices = (value: unknown, allowed: readonly string[], max = 16) => Array.isArray(value) && value.length > 0 && value.length <= max
  && new Set(value).size === value.length && value.every((item) => typeof item === 'string' && allowed.includes(item));

/** Closed, bounded metadata. Context and stage configs require their own actor-aware runtime support. */
export function parseStudioAutomationTemplate(value: unknown, id: string): AutomationTemplate {
  if (!object(value) || Object.keys(value).some((key) => !['id', 'title', 'description', 'purpose', 'triggerKinds', 'sourceKinds', 'stages',
    'outputSinks', 'reviewPolicy', 'tokenCompression', 'tags'].includes(key))
    || value.id !== undefined && value.id !== id
    || !text(value.title, 200) || !text(value.description, 2000) || !text(value.purpose, 4000)
    || !choices(value.triggerKinds, ['manual', 'schedule', 'connector', 'project-event'])
    || !choices(value.sourceKinds, ['upload', 'url', 'repo', 'connector', 'artifact', 'chat'])
    || !choices(value.outputSinks, ['memory', 'skill', 'design-system', 'automation-template', 'artifact'])
    || !['always', 'trusted-source', 'auto-apply'].includes(String(value.reviewPolicy))
    || !['off', 'balanced', 'aggressive'].includes(String(value.tokenCompression))
    || value.tags !== undefined && !(Array.isArray(value.tags) && value.tags.length <= 16 && value.tags.every((tag) => text(tag, 80)))
    || !Array.isArray(value.stages) || value.stages.length === 0 || value.stages.length > 32) throw invalid();
  const ids = new Set<string>();
  for (const stage of value.stages) {
    if (!object(stage) || Object.keys(stage).some((key) => !['id', 'kind', 'title', 'description'].includes(key))
      || typeof stage.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{1,95}$/.test(stage.id) || ids.has(stage.id)
      || !['ingest', 'canonicalize', 'redact', 'compress', 'classify', 'propose', 'agent-run', 'apply', 'notify'].includes(String(stage.kind))
      || !text(stage.title, 200) || stage.description !== undefined && !text(stage.description, 2000)) throw invalid();
    ids.add(stage.id);
  }
  if (Buffer.byteLength(JSON.stringify(value)) > STUDIO_AUTOMATION_LIMITS.bodyBytes) throw invalid();
  return normalizeAutomationTemplate({ ...value, id });
}

/** Synchronous transactions allow the template mutation and proposal verdict to commit together. */
export class StudioAutomationTemplates {
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS studio_automation_templates (
      id TEXT PRIMARY KEY, owner_account_id TEXT NOT NULL, template_json TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS studio_automation_templates_owner ON studio_automation_templates(owner_account_id);`);
  }
  list(owner: string): AutomationTemplate[] {
    return (this.db.prepare('SELECT template_json FROM studio_automation_templates WHERE owner_account_id = ? ORDER BY rowid')
      .all(owner) as Array<{ template_json: string }>).map((row) => JSON.parse(row.template_json));
  }
  read(owner: string, id: string): AutomationTemplate | null {
    const row = this.db.prepare('SELECT template_json FROM studio_automation_templates WHERE owner_account_id = ? AND id = ?')
      .get(owner, id) as { template_json: string } | undefined;
    return row ? JSON.parse(row.template_json) as AutomationTemplate : null;
  }
  validate(action: string, target: unknown, after: unknown, before?: unknown): AutomationTemplate | null {
    if (!['create', 'update', 'delete'].includes(action)) throw invalid();
    if (action !== 'create') this.snapshot(before, String(target));
    if (action === 'delete') return null;
    let value: unknown;
    try { value = JSON.parse(String(after)); } catch { throw invalid(); }
    return parseStudioAutomationTemplate(value, action === 'create' ? 'studio-template-draft' : String(target));
  }
  private snapshot(before: unknown, id: string): AutomationTemplate {
    try { return parseStudioAutomationTemplate(JSON.parse(String(before)), id); } catch { throw invalid(); }
  }
  apply(owner: string, action: string, target: unknown, before: unknown, after: unknown): string {
    return this.db.transaction(() => {
      const parsed = this.validate(action, target, after, before);
      const id = action === 'create' ? `studio-template-${randomUUID()}` : String(target);
      if (action === 'create') {
        const count = (this.db.prepare('SELECT COUNT(*) AS n FROM studio_automation_templates WHERE owner_account_id = ?').get(owner) as { n: number }).n;
        if (count >= STUDIO_AUTOMATION_LIMITS.templates) throw new StudioTemplateRefusal(409, 'automation template limit reached');
        this.db.prepare('INSERT INTO studio_automation_templates VALUES (?, ?, ?)').run(id, owner, JSON.stringify({ ...parsed, id }));
      } else {
        const current = this.read(owner, id);
        if (!current) throw new StudioTemplateRefusal(404, 'resource not found');
        const expected = this.snapshot(before, id);
        if (JSON.stringify(current) !== JSON.stringify(expected)) throw new StudioTemplateRefusal(409, 'automation template changed; review a fresh proposal');
        if (action === 'delete') this.db.prepare('DELETE FROM studio_automation_templates WHERE id = ? AND owner_account_id = ?').run(id, owner);
        else this.db.prepare('UPDATE studio_automation_templates SET template_json = ? WHERE id = ? AND owner_account_id = ?').run(JSON.stringify(parsed), id, owner);
      }
      return id;
    }).immediate();
  }
}
