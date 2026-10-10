import type Database from 'better-sqlite3';
import type { Express, Request, Response } from 'express';
import type { DesignSystemDetail, DesignSystemDocumentWrite, SkillSummary } from '@open-design/contracts';
import type { SkillInfo } from '../skills.js';
import type { DesignSystemSummary } from '../design-systems/index.js';
import { readDesignSystemAssets } from '../design-systems/index.js';
import { renderDesignSystemPreview } from '../design-systems/preview.js';
import { renderDesignSystemShowcase } from '../design-systems/showcase.js';
import { listPromptTemplates, readPromptTemplate } from '../media/prompt-templates.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { multiUserActorOf } from '../http/multiuser-gate.js';
import { multiUserStreamAllowed } from '../http/multiuser-stream.js';
import { sendApiError } from '../http/api-errors.js';
import { StudioDesignSystems } from '../storage/studio-design-systems.js';
import type { StudioCatalogSharing } from './studio-catalog-sharing.js';

export interface StudioDesignCatalog {
  readSystem(owner: string, id: string): Promise<DesignSystemDetail | null>;
  readSystemAssets(id: string): ReturnType<typeof readDesignSystemAssets>;
}

/** Bundled catalogs are read only from their resource roots. Actor documents
 * use their own version store, never the installed or Vela materialized tree.
 */
export function registerStudioDesignCatalogRoutes(app: Express, input: {
  db: Database.Database; designSystemsRoot: string; promptTemplatesRoot: string; craftRoot: string;
  listBuiltInSystems(): Promise<DesignSystemSummary[]>; listBuiltInTemplates(): Promise<SkillInfo[]>;
  /** Team catalogs (#61/#65): documents other accounts shared with the actor, for use only. */
  sharing?: StudioCatalogSharing;
}): StudioDesignCatalog {
  const store = new StudioDesignSystems(input.db);
  const { sharing } = input;
  /**
   * A private document the actor may use: its own, or one shared with it.
   * Shared documents are read-only for the grantee (`canMutate: false`) and
   * carry the `studioShare` projection; every call re-reads the grant.
   */
  const readPrivate = (actor: string, id: string): DesignSystemDetail | null => {
    const own = store.read(actor, id);
    if (own) {
      const studioShare = sharing?.projection('design-system', id, actor, actor);
      return studioShare ? { ...own, studioShare } : own;
    }
    if (sharing?.grants.roleOf('design-system', id, actor) !== 'use') return null;
    const shared = store.readLive(id);
    return shared ? { ...shared.document, canMutate: false, isEditable: false,
      studioShare: sharing.projection('design-system', id, shared.ownerAccountId, actor)! } : null;
  };
  const prefix = '/api/multiuser/catalog';
  const handle = (operation: (req: Request, res: Response, owner: string) => unknown) => async (req: Request, res: Response) => {
    const owner = multiUserActorOf(res)?.accountId;
    if (!owner) return sendApiError(res, 401, 'UNAUTHORIZED', 'authentication required');
    try { await operation(req, res, owner); }
    catch { if (!res.headersSent && multiUserStreamAllowed(res)) sendApiError(res, 500, 'INTERNAL_ERROR', 'catalog operation failed'); }
  };
  const readSystem = async (owner: string, id: string): Promise<DesignSystemDetail | null> => {
    if (id.startsWith('user:')) return readPrivate(owner, id);
    const builtin = (await input.listBuiltInSystems()).find((item) => item.source === 'built-in' && item.id === id);
    return builtin ? { ...builtin, canMutate: false, isEditable: false } : null;
  };
  app.get(`${prefix}/design-systems`, handle(async (_req, res, owner) => {
    const builtin = await input.listBuiltInSystems();
    if (!multiUserStreamAllowed(res)) return;
    const own = store.list(owner);
    const counts = sharing?.grants.memberCounts('design-system', own.map((system) => system.id)) ?? new Map<string, number>();
    const shared = (sharing?.grants.sharedWith('design-system', owner) ?? []).flatMap(({ resourceId }) => {
      const system = readPrivate(owner, resourceId);
      return system ? [system] : [];
    });
    res.json({ designSystems: [...own.map((system) => counts.has(system.id)
      ? { ...system, studioShare: { role: 'owner' as const, ownerUsername: sharing!.usernameOf(owner), memberCount: counts.get(system.id)! } } : system),
    ...shared, ...builtin].map(({ body: _body, ...summary }) => summary) });
  }));
  app.post(`${prefix}/design-systems`, handle((req, res, owner) => {
    const system = store.create(owner, req.body as DesignSystemDocumentWrite);
    res.status(201).json({ ...system, designSystem: system });
  }));
  app.get(`${prefix}/design-systems/:id`, handle(async (req, res, owner) => {
    const system = await readSystem(owner, String(req.params.id));
    if (!multiUserStreamAllowed(res)) return;
    if (!system) return sendApiError(res, 404, 'NOT_FOUND', 'design system not found');
    res.json({ ...system, designSystem: system });
  }));
  app.patch(`${prefix}/design-systems/:id`, handle((req, res, owner) => {
    const system = store.update(owner, String(req.params.id), req.body as DesignSystemDocumentWrite);
    if (!system) return sendApiError(res, 404, 'NOT_FOUND', 'editable design system not found');
    res.json({ ...system, designSystem: system });
  }));
  app.delete(`${prefix}/design-systems/:id`, handle((req, res, owner) => {
    const id = String(req.params.id);
    if (!store.delete(owner, id)) return sendApiError(res, 404, 'NOT_FOUND', 'editable design system not found');
    // Owner deletion ends every grant; runs and conversations that captured it keep their version.
    sharing?.grants.removeAll('design-system', id);
    res.json({ ok: true });
  }));
  app.get(`${prefix}/design-systems/:id/revisions`, handle((req, res, owner) => {
    const id = String(req.params.id);
    const revisions = store.revisions(owner, id);
    if (!revisions) return sendApiError(res, 404, 'NOT_FOUND', 'design system not found');
    res.json({ revisions });
  }));
  app.get(`${prefix}/design-systems/:id/files`, handle(async (req, res, owner) => {
    const system = await readSystem(owner, String(req.params.id));
    if (!multiUserStreamAllowed(res)) return;
    if (!system) return sendApiError(res, 404, 'NOT_FOUND', 'design system not found');
    res.json({ files: [{ path: 'DESIGN.md', name: 'DESIGN.md', kind: 'document', size: Buffer.byteLength(system.body) }] });
  }));
  app.get(`${prefix}/design-systems/:id/file`, handle(async (req, res, owner) => {
    const system = await readSystem(owner, String(req.params.id));
    if (!multiUserStreamAllowed(res)) return;
    if (!system || req.query.path !== 'DESIGN.md') return sendApiError(res, 404, 'NOT_FOUND', 'design system file not found');
    res.json({ file: { path: 'DESIGN.md', name: 'DESIGN.md', kind: 'document', content: system.body, size: Buffer.byteLength(system.body) } });
  }));
  for (const resource of ['preview', 'showcase'] as const) {
    app.get(`${prefix}/design-systems/:id/${resource}`, handle(async (req, res, owner) => {
      const id = String(req.params.id); const system = await readSystem(owner, id);
      if (!multiUserStreamAllowed(res)) return;
      if (!system) return sendApiError(res, 404, 'NOT_FOUND', 'design system not found');
      res.type('html').send(resource === 'preview' ? renderDesignSystemPreview(id, system.body) : renderDesignSystemShowcase(id, system.body));
    }));
  }
  const templateSummary = ({ body: _body, dir: _dir, ...item }: SkillInfo): SkillSummary => ({
    ...item, source: 'built-in', selectable: false, hasBody: _body.length > 0,
    triggers: item.triggers.filter((value): value is string => typeof value === 'string'),
  });
  app.get(`${prefix}/design-templates`, handle(async (_req, res) => {
    const templates = await input.listBuiltInTemplates();
    if (multiUserStreamAllowed(res)) res.json({ designTemplates: templates.map(templateSummary) });
  }));
  app.get(`${prefix}/design-templates/:id`, handle(async (req, res) => {
    const template = (await input.listBuiltInTemplates()).find((item) => item.id === String(req.params.id));
    if (!multiUserStreamAllowed(res)) return;
    if (!template) return sendApiError(res, 404, 'NOT_FOUND', 'design template not found');
    res.json({ ...templateSummary(template), body: template.body });
  }));
  app.get(`${prefix}/prompt-templates`, handle(async (_req, res) => {
    const templates = await listPromptTemplates(input.promptTemplatesRoot);
    if (multiUserStreamAllowed(res)) res.json({ promptTemplates: templates.map(({ prompt: _prompt, ...summary }) => summary) });
  }));
  app.get(`${prefix}/prompt-templates/:surface/:id`, handle(async (req, res) => {
    const template = await readPromptTemplate(input.promptTemplatesRoot, String(req.params.surface), String(req.params.id));
    if (!multiUserStreamAllowed(res)) return;
    if (!template) return sendApiError(res, 404, 'NOT_FOUND', 'prompt template not found');
    res.json({ promptTemplate: template });
  }));
  const craft = async (id: string) => /^[a-z0-9][a-z0-9-]{0,127}$/.test(id)
    ? await fs.readFile(path.join(input.craftRoot, `${id}.md`), 'utf8').catch(() => null) : null;
  app.get(`${prefix}/craft`, handle(async (_req, res) => {
    const files = await fs.readdir(input.craftRoot, { withFileTypes: true });
    const items = await Promise.all(files.filter((file) => file.isFile() && file.name.endsWith('.md')).map(async (file) => {
      const id = file.name.slice(0, -3); const body = await craft(id);
      return body === null ? null : { id, label: body.split('\n').find((line) => line.startsWith('# '))?.slice(2).trim() ?? id, bytes: Buffer.byteLength(body) };
    }));
    if (multiUserStreamAllowed(res)) res.json({ craft: items.filter((item) => item !== null) });
  }));
  app.get(`${prefix}/craft/:id`, handle(async (req, res) => {
    const id = String(req.params.id); const body = await craft(id);
    if (!multiUserStreamAllowed(res)) return;
    if (body === null) return sendApiError(res, 404, 'NOT_FOUND', 'craft section not found');
    res.json({ id, body });
  }));
  return { readSystem, readSystemAssets: (id) => id.startsWith('user:') ? Promise.resolve({}) : readDesignSystemAssets(input.designSystemsRoot, id) };
}
