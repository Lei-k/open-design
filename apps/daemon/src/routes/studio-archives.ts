import { createHash } from 'node:crypto';
import { finished } from 'node:stream/promises';
import JSZip from 'jszip';
import type Database from 'better-sqlite3';
import type { Express, Request, Response } from 'express';
import { STUDIO_ARCHIVE_SHA256_HEADER, type StudioArchiveBatchRequest } from '@open-design/contracts';
import { getProject } from '../db.js';
import { addDesignArchiveMetadata, validateProjectPath } from '../projects.js';
import { sanitizeArchiveFilename } from '../projects/archive-filename.js';
import { captureStudioProject } from '../projects/studio-snapshot.js';
import { ProjectOwnershipStore } from '../storage/project-ownership.js';
import { multiUserActorOf } from '../http/multiuser-gate.js';
import { bindMultiUserStream, multiUserStreamAllowed } from '../http/multiuser-stream.js';
import { sendApiError } from '../http/api-errors.js';

/** Captures bounded owned bytes before compressing. Standard endpoints rewrite
 * here so the host archive walkers never execute for a remote actor. */
export function registerStudioArchiveRoutes(app: Express, input: { db: Database.Database; projectsRoot: string }): void {
  const ownership = new ProjectOwnershipStore(input.db);
  const active = new Set<string>();
  const safePath = (value: unknown): string => {
    if (typeof value !== 'string' || !value || value.length > 1024) throw new Error('Invalid archive path');
    const normalized = validateProjectPath(value) as string;
    if (normalized.split('/').some((part) => part.startsWith('.') || part === 'node_modules')) throw new Error('Private archive path');
    return normalized;
  };
  const download = async (req: Request, res: Response, batch: boolean) => {
    const id = String(req.params.id);
    const owner = multiUserActorOf(res)?.accountId;
    const project = owner && ownership.isOwnedBy(id, owner) ? getProject(input.db, id) : null;
    if (!project) return sendApiError(res, 404, 'NOT_FOUND', 'resource not found');
    if (active.has(owner!) || active.size >= 4) return sendApiError(res, 429, 'RATE_LIMITED', 'archive capture busy; retry later');
    active.add(owner!);
    try {
      if (Object.keys(req.query).some((key) => !(!batch && key === 'root'))) throw new Error('Invalid archive query');
      const root = req.query.root === undefined || req.query.root === '' ? '' : safePath(req.query.root);
      const selection = batch ? (req.body as StudioArchiveBatchRequest).files.map(safePath) : null;
      if (selection && new Set(selection).size !== selection.length) throw new Error('Duplicate archive path');
      const files = captureStudioProject(input.projectsRoot, id)
        .filter((file) => selection ? selection.includes(file.name) : !root || file.name.startsWith(root + '/'))
        .map((file) => ({ ...file, name: root ? file.name.slice(root.length + 1) : file.name }));
      if (!files.length || selection && files.length !== selection.length) return sendApiError(res, 404, 'NOT_FOUND', 'resource not found');
      const zip = new JSZip();
      for (const file of files) zip.file(file.name, file.bytes, { binary: true, date: new Date(0) });
      addDesignArchiveMetadata(zip, files.map((file) => file.name), project.name);
      const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
      // Logout/revocation/project deletion while compression yields withdraws
      // the entire download, before headers or any captured byte are released.
      if (req.aborted || res.destroyed || !multiUserStreamAllowed(res)) return;
      if (!ownership.isOwnedBy(id, owner!) || !getProject(input.db, id)) return sendApiError(res, 404, 'NOT_FOUND', 'resource not found');
      const name = `${sanitizeArchiveFilename(project.name) || 'project'}${root ? `-${sanitizeArchiveFilename(root)}` : ''}.zip`;
      const encoded = encodeURIComponent(name).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
      const ascii = name.replace(/[^\x20-\x7e]/g, '_');
      res.set({ 'Content-Type': 'application/zip', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`,
        [STUDIO_ARCHIVE_SHA256_HEADER]: createHash('sha256').update(bytes).digest('hex') });
      res.set('Content-Length', String(bytes.length));
      bindMultiUserStream(res);
      const completion = finished(res, { cleanup: true }).catch(() => {});
      for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
        if (req.aborted || res.destroyed || res.writableEnded || !multiUserStreamAllowed(res)) { res.destroy(); return; }
        if (!res.write(bytes.subarray(offset, offset + 64 * 1024))) {
          const drained = await new Promise<boolean>((resolve) => {
            const cleanup = () => { res.off('drain', ready); res.off('close', closed); res.off('finish', closed); res.off('error', closed); };
            const ready = () => { cleanup(); resolve(true); };
            const closed = () => { cleanup(); resolve(false); };
            res.once('drain', ready); res.once('close', closed); res.once('finish', closed); res.once('error', closed);
          });
          if (!drained) { res.destroy(); return; }
        }
      }
      res.end();
      await completion;
    } catch {
      if (!res.headersSent && !res.writableEnded) sendApiError(res, 400, 'BAD_REQUEST', 'archive capture refused');
    } finally { active.delete(owner!); }
  };
  app.get('/api/multiuser/projects/:id/archive', (req, res) => { void download(req, res, false); });
  app.post('/api/multiuser/projects/:id/archive/batch', (req, res) => { void download(req, res, true); });
}
