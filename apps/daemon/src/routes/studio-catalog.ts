import type Database from 'better-sqlite3';
import type { Express, Request, Response } from 'express';
import type { SkillDetail, SkillImportRequest, SkillSummary, SkillUpdateRequest } from '@open-design/contracts';
import { multiUserActorOf } from '../http/multiuser-gate.js';
import { multiUserStreamAllowed } from '../http/multiuser-stream.js';
import { sendApiError } from '../http/api-errors.js';
import { listSkillFiles, type SkillInfo } from '../skills.js';
import { StudioSkills } from '../storage/studio-skills.js';

export interface StudioCatalog {
  readSkills: (ownerId: string, ids: readonly string[]) => Promise<SkillDetail[] | null>;
}

/** Standard API aliases terminate here; host-global registrars never handle
 * Studio catalogs. Bundled reads and account-owned writes are separate sources.
 */
export function registerStudioCatalogRoutes(app: Express, input: {
  db: Database.Database; listBuiltInSkills: () => Promise<SkillInfo[]>;
}): StudioCatalog {
  const store = new StudioSkills(input.db);
  const builtinSummary = ({ dir: _dir, body: _body, ...skill }: SkillInfo): SkillSummary => ({
    ...skill, triggers: skill.triggers.filter((value): value is string => typeof value === 'string'),
    source: 'built-in', selectable: false, hasBody: typeof _body === 'string' && _body.length > 0,
  });
  const read = async (ownerId: string, id: string): Promise<SkillDetail | null> => {
    if (id.startsWith('studio-skill:')) return store.read(ownerId, id);
    const item = (await input.listBuiltInSkills()).find((skill) => skill.id === id);
    return item ? { ...builtinSummary(item), body: item.body } : null;
  };
  const handle = (operation: (req: Request, res: Response, ownerId: string) => unknown) => async (req: Request, res: Response) => {
    const ownerId = multiUserActorOf(res)?.accountId;
    if (!ownerId) return sendApiError(res, 401, 'UNAUTHORIZED', 'authentication required');
    try { await operation(req, res, ownerId); }
    catch { if (!res.headersSent) sendApiError(res, 500, 'INTERNAL_ERROR', 'catalog operation failed'); }
  };
  const prefix = '/api/multiuser/catalog/skills';
  app.get(prefix, handle(async (_req, res, ownerId) => {
    const builtins = await input.listBuiltInSkills();
    if (!multiUserStreamAllowed(res)) return;
    res.json({ skills: [...store.list(ownerId), ...builtins.map(builtinSummary)] });
  }));
  app.get(`${prefix}/:id`, handle(async (req, res, ownerId) => {
    const skill = await read(ownerId, String(req.params.id));
    if (!multiUserStreamAllowed(res)) return;
    if (!skill) return sendApiError(res, 404, 'NOT_FOUND', 'skill not found');
    res.json(skill);
  }));
  app.get(`${prefix}/:id/files`, handle(async (req, res, ownerId) => {
    const id = String(req.params.id);
    if (id.startsWith('studio-skill:')) {
      const skill = store.read(ownerId, id);
      if (!skill) return sendApiError(res, 404, 'NOT_FOUND', 'skill not found');
      res.json({ files: [{ path: 'SKILL.md', kind: 'file', size: Buffer.byteLength(skill.body) }] });
      return;
    }
    const skill = (await input.listBuiltInSkills()).find((item) => item.id === id);
    if (!skill) return sendApiError(res, 404, 'NOT_FOUND', 'skill not found');
    const files = await listSkillFiles(skill.dir);
    if (multiUserStreamAllowed(res)) res.json({ files });
  }));
  app.post(`${prefix}/import`, handle((req, res, ownerId) => {
    if (typeof req.body.name !== 'string' || !req.body.name.trim()) return sendApiError(res, 400, 'BAD_REQUEST', 'skill name is required');
    const skill = store.create(ownerId, req.body as SkillImportRequest);
    if (!skill) return sendApiError(res, 409, 'CONFLICT', 'skill name already exists or is invalid');
    res.status(201).json({ skill });
  }));
  app.put(`${prefix}/:id`, handle((req, res, ownerId) => {
    const skill = store.update(ownerId, String(req.params.id), req.body as SkillUpdateRequest);
    if (!skill) return sendApiError(res, 404, 'NOT_FOUND', 'editable skill not found');
    res.json({ skill });
  }));
  app.delete(`${prefix}/:id`, handle((req, res, ownerId) => {
    if (!store.delete(ownerId, String(req.params.id))) return sendApiError(res, 404, 'NOT_FOUND', 'editable skill not found');
    res.json({ ok: true });
  }));
  return { readSkills: async (ownerId, ids) => {
    // Executable bundled attachments need their own sandbox staging closure.
    // Reading the bundled catalog is not permission to execute those assets.
    if (ids.some((id) => !id.startsWith('studio-skill:'))) return null;
    const skills = await Promise.all(ids.map((id) => read(ownerId, id)));
    return skills.every((skill): skill is SkillDetail => skill !== null) ? skills : null;
  } };
}
