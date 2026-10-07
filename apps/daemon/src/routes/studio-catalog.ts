import type Database from 'better-sqlite3';
import type { Express, Request, Response } from 'express';
import type { SkillDetail, SkillImportRequest, SkillSummary, SkillUpdateRequest } from '@open-design/contracts';
import { multiUserActorOf } from '../http/multiuser-gate.js';
import { multiUserStreamAllowed } from '../http/multiuser-stream.js';
import { sendApiError } from '../http/api-errors.js';
import type { SkillInfo } from '../skills.js';
import { StudioSkills } from '../storage/studio-skills.js';
import multer from 'multer';
import { captureStudioSkill, type StudioSkillPackage } from '../services/studio-skill-packages.js';
import { parseFrontmatter } from '../design-systems/frontmatter.js';

const SKILL_FILES = 250;
const SKILL_FILE_BYTES = 4 * 1024 * 1024;
const SKILL_BYTES = 8 * 1024 * 1024;

/** One selected folder: a shared top-level directory is dropped so SKILL.md
 * sits at the package root. Hidden, dependency, absolute and traversal paths
 * refuse the whole upload rather than being silently skipped. */
export function skillFolderFiles(input: ReadonlyArray<{ path: string; bytes: Buffer }>): { root: string; files: Array<{ path: string; bytes: Buffer }> } | null {
  if (!input.length || input.length > SKILL_FILES) return null;
  const split = input.map((file) => ({ parts: file.path.replaceAll('\\', '/').split('/'), bytes: file.bytes }));
  if (split.some(({ parts }) => parts.length > 17 || parts.some((part) => !part || part === '.' || part === '..' || part.startsWith('.')
    || part === 'node_modules' || part.includes('\0') || part.length > 255))) return null;
  const first = split[0]!.parts[0]!;
  const shared = split.every(({ parts }) => parts.length > 1 && parts[0] === first);
  const files = split.map(({ parts, bytes }) => ({ path: (shared ? parts.slice(1) : parts).join('/'), bytes }));
  const total = files.reduce((sum, file) => sum + file.bytes.length, 0);
  if (new Set(files.map((file) => file.path)).size !== files.length || total > SKILL_BYTES || !files.some((file) => file.path === 'SKILL.md')) return null;
  return { root: shared ? first : '', files };
}

function skillFields(folder: string, document: Buffer): { name: string; description: string; body: string; triggers: string[] } {
  const { data, body } = parseFrontmatter(new TextDecoder('utf-8', { fatal: true }).decode(document));
  const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
  const name = (text(data.name) || folder).slice(0, 100);
  if (!name || !body.trim()) throw new Error('skill document incomplete');
  const triggers = Array.isArray(data.triggers) ? data.triggers.filter((item): item is string => typeof item === 'string').slice(0, 32) : [];
  return { name, description: text(data.description).slice(0, 1000), body: body.trim(), triggers };
}

export interface StudioCatalog {
  readSkills: (ownerId: string, ids: readonly string[]) => Promise<Array<SkillDetail & { package?: StudioSkillPackage }> | null>;
}

/** Standard API aliases terminate here; host-global registrars never handle
 * Studio catalogs. Bundled reads and account-owned writes are separate sources.
 */
export function registerStudioCatalogRoutes(app: Express, input: {
  db: Database.Database; skillsRoot: string; listBuiltInSkills: () => Promise<SkillInfo[]>;
}): StudioCatalog {
  const store = new StudioSkills(input.db);
  const builtinSummary = ({ dir: _dir, body: _body, ...skill }: SkillInfo): SkillSummary => ({
    ...skill, triggers: skill.triggers.filter((value): value is string => typeof value === 'string'),
    source: 'built-in', selectable: true, hasBody: typeof _body === 'string' && _body.length > 0,
  });
  const read = async (ownerId: string, id: string): Promise<(SkillDetail & { package?: StudioSkillPackage }) | null> => {
    if (id.startsWith('studio-skill:')) return store.read(ownerId, id);
    const item = (await input.listBuiltInSkills()).find((skill) => skill.id === id);
    if (!item) return null;
    try { return { ...builtinSummary(item), ...captureStudioSkill(input.skillsRoot, item.dir, item.id) }; }
    catch { return null; }
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
    const { package: _package, ...detail } = skill;
    res.json(detail);
  }));
  app.get(`${prefix}/:id/files`, handle(async (req, res, ownerId) => {
    const id = String(req.params.id);
    if (id.startsWith('studio-skill:')) {
      const skill = store.read(ownerId, id);
      if (!skill) return sendApiError(res, 404, 'NOT_FOUND', 'skill not found');
      res.json({ files: skill.package?.files.map((file) => ({ path: file.path, kind: 'file', size: Buffer.byteLength(file.data, 'base64') }))
        ?? [{ path: 'SKILL.md', kind: 'file', size: Buffer.byteLength(skill.body) }] });
      return;
    }
    const skill = await read(ownerId, id);
    if (!skill) return sendApiError(res, 404, 'NOT_FOUND', 'skill not found');
    const files = skill.package?.files.map((file) => ({ path: file.path, kind: 'file', size: Buffer.byteLength(file.data, 'base64') })) ?? [];
    if (multiUserStreamAllowed(res)) res.json({ files });
  }));
  app.post(`${prefix}/import`, handle((req, res, ownerId) => {
    if (typeof req.body.name !== 'string' || !req.body.name.trim()) return sendApiError(res, 400, 'BAD_REQUEST', 'skill name is required');
    const skill = store.create(ownerId, req.body as SkillImportRequest);
    if (!skill) return sendApiError(res, 409, 'CONFLICT', 'skill name already exists or is invalid');
    res.status(201).json({ skill });
  }));
  // Browser folder upload: SKILL.md plus side files become one immutable,
  // account-private package. Paths are folder-relative; no host path is read.
  const folderUpload = multer({ storage: multer.memoryStorage(), preservePath: true,
    limits: { fileSize: SKILL_FILE_BYTES, files: SKILL_FILES, fields: 0, parts: SKILL_FILES + 1 } }).array('files');
  const importFolder = (req: Request, res: Response) => {
    folderUpload(req, res, (error) => {
      if (error) { sendApiError(res, 400, 'BAD_REQUEST', 'skill folder upload refused'); return; }
      void handle((request, response, ownerId) => {
        const uploads = Array.isArray(request.files) ? request.files : [];
        const files = skillFolderFiles(uploads.map((file) => ({ path: file.originalname, bytes: file.buffer })));
        if (!files) return sendApiError(response, 400, 'BAD_REQUEST', 'a skill folder with SKILL.md and safe relative paths is required');
        let fields: { name: string; description: string; body: string; triggers: string[] };
        try { fields = skillFields(files.root, files.files.find((file) => file.path === 'SKILL.md')!.bytes); }
        catch { return sendApiError(response, 400, 'BAD_REQUEST', 'SKILL.md must be UTF-8 with a body'); }
        let skill: SkillSummary | null;
        try { skill = store.create(ownerId, fields, files.files); }
        catch { return sendApiError(response, 400, 'BAD_REQUEST', 'skill folder exceeds package limits'); }
        if (!skill) return sendApiError(response, 409, 'CONFLICT', 'skill name already exists or is invalid');
        response.status(201).json({ skill });
      })(req, res);
    });
  };
  app.post('/api/skills/import-files', importFolder);
  app.post(`${prefix}/import-files`, importFolder);
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
    const skills = await Promise.all(ids.map((id) => read(ownerId, id)));
    return skills.every((skill): skill is SkillDetail & { package?: StudioSkillPackage } => skill !== null) ? skills : null;
  } };
}
