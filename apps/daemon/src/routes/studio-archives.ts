import { createHash } from 'node:crypto';
import { finished } from 'node:stream/promises';
import JSZip from 'jszip';
import type Database from 'better-sqlite3';
import type { Express, Request, Response } from 'express';
import { STUDIO_ARCHIVE_SHA256_HEADER, type StudioArchiveBatchRequest } from '@open-design/contracts';
import { getProject } from '../db.js';
import path from 'node:path';
import { addDesignArchiveMetadata, mimeFor, validateProjectPath } from '../projects.js';
import { sanitizeArchiveFilename } from '../projects/archive-filename.js';
import { captureStudioProject } from '../projects/studio-snapshot.js';
import { readProjectFileVersion } from '../project-file-versions.js';
import { ProjectOwnershipStore } from '../storage/project-ownership.js';
import { multiUserActorOf } from '../http/multiuser-gate.js';
import { bindMultiUserStream, multiUserStreamAllowed } from '../http/multiuser-stream.js';
import { sendApiError } from '../http/api-errors.js';
import { bundleStandaloneHtml, StandaloneHtmlExportError } from '../artifacts/standalone-html.js';

/** Captures bounded owned bytes before compressing or bundling. Standard
 * endpoints rewrite here so the host archive/export walkers never execute for
 * a remote actor. */
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
  // One-file HTML on the same bounded capture: same-project assets are read
  // from captured bytes, never by re-resolving a worker-writable path.
  const exportHtml = async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const owner = multiUserActorOf(res)?.accountId;
    const project = owner && ownership.isOwnedBy(id, owner) ? getProject(input.db, id) : null;
    if (!project) return sendApiError(res, 404, 'NOT_FOUND', 'resource not found');
    if (active.has(owner!) || active.size >= 4) return sendApiError(res, 429, 'RATE_LIMITED', 'export busy; retry later');
    active.add(owner!);
    try {
      const { fileName, title, versionId } = req.body as { fileName: string; title?: string | null; versionId?: string };
      const entryPath = safePath(fileName);
      const files = new Map(captureStudioProject(input.projectsRoot, id).map((file) => [file.name, file.bytes]));
      let entry = files.get(entryPath);
      if (versionId) {
        // The version store refuses planted links; assets still come from the bounded capture.
        const version = await readProjectFileVersion(input.projectsRoot, id, entryPath, versionId).catch(() => null);
        if (!version) return sendApiError(res, 404, 'NOT_FOUND', 'version not found');
        entry = Buffer.from(version.content, 'utf8');
      }
      if (!entry) return sendApiError(res, 404, 'FILE_NOT_FOUND', 'HTML entry not found');
      if (!mimeFor(entryPath).startsWith('text/html')) return sendApiError(res, 415, 'UNSUPPORTED_MEDIA_TYPE', 'standalone export only supports HTML entry files');
      const bundled = await bundleStandaloneHtml({ entryPath, html: entry.toString('utf8'),
        readAsset: async (projectPath) => {
          const bytes = files.get(projectPath);
          return bytes ? { buffer: bytes, mime: mimeFor(projectPath), size: bytes.length } : null;
        } });
      if (req.aborted || res.destroyed || !multiUserStreamAllowed(res)) return;
      if (!ownership.isOwnedBy(id, owner!) || !getProject(input.db, id)) return sendApiError(res, 404, 'NOT_FOUND', 'resource not found');
      const base = (typeof title === 'string' && title.trim()) || path.posix.basename(entryPath, path.posix.extname(entryPath)) || 'artifact';
      const name = `${sanitizeArchiveFilename(base) || 'artifact'}.html`;
      const encoded = encodeURIComponent(name).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
      res.set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': 'sandbox allow-scripts',
        'Content-Disposition': `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '_')}"; filename*=UTF-8''${encoded}`,
        'X-Open-Design-External-Dependencies': String(bundled.externalDependencies.length) });
      res.send(bundled.html);
    } catch (error) {
      if (res.headersSent) return;
      if (error instanceof StandaloneHtmlExportError) {
        const details = { kind: error.kind, ...(error.dependency ? { dependency: error.dependency } : {}), ...(error.limit ? { limit: error.limit } : {}) };
        if (error.kind === 'limit-exceeded') return sendApiError(res, 413, 'PAYLOAD_TOO_LARGE', error.message, { details });
        const unprocessable = error.kind === 'missing-local-dependency' || error.kind === 'invalid-source';
        return sendApiError(res, unprocessable ? 422 : 400, unprocessable ? 'VALIDATION_FAILED' : 'BAD_REQUEST', error.message, { details });
      }
      sendApiError(res, 400, 'BAD_REQUEST', 'export refused');
    } finally { active.delete(owner!); }
  };
  app.post('/api/multiuser/projects/:id/export/html', (req, res) => { void exportHtml(req, res); });
  app.get('/api/multiuser/projects/:id/archive', (req, res) => { void download(req, res, false); });
  app.post('/api/multiuser/projects/:id/archive/batch', (req, res) => { void download(req, res, true); });
}
