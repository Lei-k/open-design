import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import multer from 'multer';
import type Database from 'better-sqlite3';
import type { Express, Request, Response } from 'express';
import type { ProjectMetadata, StudioProjectCreateRequest, StudioProjectMetadata, StudioTemplateSaveRequest, StudioDirectoryImportFields } from '@open-design/contracts';
import { getProject, insertProject, insertConversation, setTabs } from '../db.js';
import { projectDir, isSafeId, validateProjectPath } from '../projects.js';
import { importClaudeDesignZip } from '../design/claude-design-import.js';
import { captureStudioProject, STUDIO_SNAPSHOT_LIMITS, type StudioSnapshotFile } from '../projects/studio-snapshot.js';
import { StudioTemplates } from '../storage/studio-templates.js';
import { ProjectOwnershipStore } from '../storage/project-ownership.js';
import { multiUserActorOf } from '../http/multiuser-gate.js';
import { multiUserStreamAllowed } from '../http/multiuser-stream.js';
import { sendApiError } from '../http/api-errors.js';

const METADATA = ['kind', 'intent', 'fidelity', 'speakerNotes', 'slideCount', 'animations', 'includeLandingPage',
  'includeOsWidgets', 'platform', 'platformTargets', 'nameSource'] as const;
function copyMetadata(metadata?: ProjectMetadata | null): StudioProjectMetadata {
  return { kind: metadata?.kind ?? 'prototype',
    ...Object.fromEntries(METADATA.filter((key) => metadata?.[key] !== undefined).map((key) => [key, metadata![key]])) };
}
class CreationRefusal extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) { super(message); }
}

/** All standard aliases terminate here, including create. No host catalog,
 * filesystem import, workspace header or native-thread binding reaches these
 * operations. Files publish before an atomic project/conversation/owner bind. */
export function registerStudioProjectCreationRoutes(app: Express, input: {
  db: Database.Database; dataRoot: string; projectsRoot: string;
  readSkill: (owner: string, id: string) => Promise<boolean>;
  readDesignSystem: (owner: string, id: string) => Promise<boolean>;
}) {
  const { db, projectsRoot } = input;
  const ownership = new ProjectOwnershipStore(db);
  const templates = new StudioTemplates(db);
  const pending = new Set<string>();
  const stagingRoot = path.join(input.dataRoot, 'studio-project-staging');
  const ownedProject = (owner: string, id: string) => {
    if (!ownership.isOwnedBy(id, owner)) throw new CreationRefusal(404, 'resource not found');
    const project = getProject(db, id);
    if (!project) throw new CreationRefusal(404, 'resource not found');
    return project;
  };
  const handle = (operation: (req: Request, res: Response, owner: string) => Promise<unknown> | unknown) => async (req: Request, res: Response) => {
    const owner = multiUserActorOf(res)?.accountId;
    if (!owner) return sendApiError(res, 401, 'UNAUTHORIZED', 'authentication required');
    try { await operation(req, res, owner); }
    catch (error) {
      if (res.headersSent || res.writableEnded) return;
      if (error instanceof CreationRefusal) return sendApiError(res, error.status,
        error.status === 404 ? 'NOT_FOUND' : error.status === 409 ? 'CONFLICT' : 'BAD_REQUEST', error.message);
      sendApiError(res, 400, 'BAD_REQUEST', 'project files could not be captured or imported');
    }
  };
  const stage = async () => {
    await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
    return mkdtemp(path.join(stagingRoot, 'capture-'));
  };
  const validateResources = async (owner: string, setup: StudioProjectCreateRequest) => {
    if (setup.skillId && !await input.readSkill(owner, setup.skillId)
      || setup.designSystemId && !await input.readDesignSystem(owner, setup.designSystemId)) throw new CreationRefusal(404, 'resource not found');
  };
  const create = async (req: Request, res: Response, owner: string, setup: StudioProjectCreateRequest,
    capture: (directory: string) => Promise<{ files: string[]; entryFile?: string | null; metadata?: ProjectMetadata }>,
    revalidate: () => void = () => {}) => {
    if (!isSafeId(setup.id) || typeof setup.name !== 'string' || !setup.name.trim() || setup.name.length > 100)
      throw new CreationRefusal(400, 'valid project id and name are required');
    // Globally colliding ids never disclose their owner or existing contents.
    if (getProject(db, setup.id) || pending.has(setup.id)) throw new CreationRefusal(409, 'project id unavailable');
    pending.add(setup.id);
    let directory: string | undefined;
    let published = false;
    let committed = false;
    try {
      await validateResources(owner, setup);
      if (!multiUserStreamAllowed(res) || req.aborted || res.destroyed) return;
      directory = await stage();
      const captured = await capture(directory);
      if (!multiUserStreamAllowed(res) || req.aborted || res.destroyed) return;
      revalidate();
      await mkdir(projectsRoot, { recursive: true });
      // Reserve an absent target. A previous directory is never overwritten,
      // even when no project row owns it (interrupted startup/legacy data).
      await mkdir(projectDir(projectsRoot, setup.id), { mode: 0o700 });
      published = true;
      await rename(directory, projectDir(projectsRoot, setup.id));
      await validateResources(owner, setup);
      if (!multiUserStreamAllowed(res) || req.aborted || res.destroyed) return;
      revalidate();
      const now = Date.now(); const conversationId = randomUUID();
      const project = db.transaction(() => {
        const created = insertProject(db, { id: setup.id, name: setup.name.trim(), skillId: setup.skillId ?? null,
          designSystemId: setup.designSystemId ?? null, customInstructions: setup.customInstructions ?? null,
          pendingPrompt: setup.pendingPrompt ?? null, metadata: captured.metadata ?? setup.metadata ?? {}, createdAt: now, updatedAt: now });
        insertConversation(db, { id: conversationId, projectId: setup.id, title: null,
          sessionMode: setup.conversationMode ?? 'design', createdAt: now, updatedAt: now });
        ownership.bindOwner(setup.id, owner, now);
        if (captured.entryFile) setTabs(db, setup.id, [captured.entryFile], captured.entryFile);
        return created;
      }).immediate();
      committed = true;
      res.json({ project, conversationId, copiedFiles: captured.files, entryFile: captured.entryFile ?? null });
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
      if (published && !committed) await rm(projectDir(projectsRoot, setup.id), { recursive: true, force: true }).catch(() => {});
      pending.delete(setup.id);
    }
  };
  const materialize = async (directory: string, files: StudioSnapshotFile[]) => {
    for (const file of files) {
      const name = validateProjectPath(file.name) as string;
      const target = path.join(directory, name);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, file.bytes, { flag: 'wx', mode: 0o600 });
    }
    return { files: files.map((file) => file.name), entryFile: files.find((file) => /\.html?$/i.test(file.name))?.name ?? null };
  };
  const projects = '/api/multiuser/projects';
  app.post(projects, handle(async (req, res, owner) => {
    const conversationMode = req.body.conversationMode ?? req.body.sessionMode;
    const setup: StudioProjectCreateRequest = { ...req.body, ...(conversationMode ? { conversationMode } : {}) };
    const templateId = setup.metadata?.templateId;
    const template = templateId ? templates.read(owner, templateId) : null;
    if (setup.metadata?.kind === 'template' && !template || templateId && !template) throw new CreationRefusal(404, 'resource not found');
    const captured = template?.files.map((file) => ({ name: file.name, bytes: Buffer.from(file.content, file.encoding ?? 'utf8') })) ?? [];
    await create(req, res, owner, setup, async (directory) => ({ ...await materialize(directory, captured),
      metadata: template ? { ...template.metadata, ...setup.metadata, templateId: template.id, templateLabel: template.name } : setup.metadata ?? { kind: 'prototype' } }),
    () => { if (template && !templates.read(owner, template.id)) throw new CreationRefusal(404, 'resource not found'); });
  }));
  app.post(`${projects}/:id/duplicate`, handle(async (req, res, owner) => {
    const source = ownedProject(owner, String(req.params.id));
    const files = captureStudioProject(projectsRoot, source.id);
    await create(req, res, owner, { id: randomUUID(), name: req.body.name ?? `${source.name.slice(0, 93)} (copy)`,
      skillId: source.skillId, designSystemId: source.designSystemId, customInstructions: source.customInstructions,
      metadata: copyMetadata(source.metadata) }, (directory) => materialize(directory, files), () => { ownedProject(owner, source.id); });
  }));
  const catalog = '/api/multiuser/catalog/templates';
  app.get(catalog, handle((_req, res, owner) => { res.json({ templates: templates.list(owner) }); }));
  app.get(`${catalog}/:id`, handle((req, res, owner) => {
    const template = templates.read(owner, String(req.params.id));
    if (!template) throw new CreationRefusal(404, 'resource not found');
    res.json({ template });
  }));
  app.post(catalog, handle((req, res, owner) => {
    const setup = req.body as StudioTemplateSaveRequest;
    const source = ownedProject(owner, setup.sourceProjectId);
    const files = captureStudioProject(projectsRoot, source.id);
    if (!multiUserStreamAllowed(res) || req.aborted || res.destroyed) return;
    const template = templates.save(owner, setup, copyMetadata(source.metadata), files);
    res.status(201).json({ template });
  }));
  app.delete(`${catalog}/:id`, handle((req, res, owner) => {
    if (!templates.delete(owner, String(req.params.id))) throw new CreationRefusal(404, 'resource not found');
    res.json({ ok: true });
  }));
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: STUDIO_SNAPSHOT_LIMITS.bytes, files: 1, fields: 0, parts: 2 } }).single('file');
  const directoryUpload = multer({ storage: multer.memoryStorage(), preservePath: true,
    limits: { fileSize: STUDIO_SNAPSHOT_LIMITS.fileBytes, files: STUDIO_SNAPSHOT_LIMITS.files, fields: 1, fieldSize: 1024, parts: STUDIO_SNAPSHOT_LIMITS.files + 2 } }).array('files');
  app.post('/api/import/files', (req, res) => {
    directoryUpload(req, res, (error) => {
      if (error) { sendApiError(res, 400, 'BAD_REQUEST', 'directory upload refused'); return; }
      void handle(async (request, response, owner) => {
        const fields = (request.body ?? {}) as StudioDirectoryImportFields;
        if (Object.keys(fields).some((key) => key !== 'name') || fields.name !== undefined &&
          (typeof fields.name !== 'string' || !fields.name.trim() || fields.name.length > 100 || fields.name.includes('\0')))
          throw new CreationRefusal(400, 'invalid directory import fields');
        const uploads = Array.isArray(request.files) ? request.files : [];
        if (!uploads.length) throw new CreationRefusal(400, 'directory files required');
        const files = uploads.map((file) => {
          if (file.originalname.length > 1024) throw new CreationRefusal(400, 'invalid file path');
          const name = validateProjectPath(file.originalname) as string;
          if (name.split('/').some((segment) => segment.startsWith('.') || segment === 'node_modules')) throw new CreationRefusal(400, 'private or dependency files must be excluded');
          return { name, bytes: file.buffer };
        });
        if (new Set(files.map((file) => file.name)).size !== files.length
          || files.reduce((total, file) => total + file.bytes.length, 0) > STUDIO_SNAPSHOT_LIMITS.bytes) throw new CreationRefusal(400, 'directory upload limit or duplicate file');
        await create(request, response, owner, { id: randomUUID(), name: fields.name ?? 'Imported folder', metadata: { kind: 'prototype' } },
          (directory) => materialize(directory, files));
      })(req, res);
    });
  });
  app.post('/api/multiuser/import/claude-design', (req, res) => {
    upload(req, res, (error) => {
      if (error) { sendApiError(res, 400, 'BAD_REQUEST', 'archive upload refused'); return; }
      void handle(async (request, response, owner) => {
        const file = request.file;
        if (!file || !/\.zip$/i.test(file.originalname)) throw new CreationRefusal(400, 'ZIP file required');
        await create(request, response, owner, { id: randomUUID(), name: path.basename(file.originalname).replace(/\.zip$/i, '').slice(0, 100) || 'Imported design',
          metadata: { kind: 'prototype' } }, async (directory) => {
          const zip = path.join(path.dirname(directory), `${path.basename(directory)}.zip`);
          try {
            await writeFile(zip, file.buffer, { flag: 'wx', mode: 0o600 });
            const imported = await importClaudeDesignZip(zip, directory);
            // Reapply bounded, no-follow capture to imported bytes before publication.
            captureStudioProject(stagingRoot, path.basename(directory));
            return { ...imported, metadata: { kind: 'prototype', importedFrom: 'claude-design', entryFile: imported.entryFile,
              sourceFileName: path.basename(file.originalname).slice(0, 256) } };
          } finally { await rm(zip, { force: true }); }
        });
      })(req, res);
    });
  });
}
