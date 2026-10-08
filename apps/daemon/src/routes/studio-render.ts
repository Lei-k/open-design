import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { Express, Request, Response } from 'express';
import { renderDeckSlides } from '@open-design/artifact-capture';
import { getProject } from '../db.js';
import { mimeFor, validateProjectPath } from '../projects.js';
import { captureStudioProject } from '../projects/studio-snapshot.js';
import { readProjectFileVersion } from '../project-file-versions.js';
import { ProjectOwnershipStore } from '../storage/project-ownership.js';
import { multiUserActorOf } from '../http/multiuser-gate.js';
import { multiUserStreamAllowed } from '../http/multiuser-stream.js';
import { sendApiError } from '../http/api-errors.js';
import { buildDeckRenderInput, buildScreenshotPdf, buildScreenshotPptx, decodeSlideDataUrls, screenshotRenderClientError } from '../deck-export.js';
import type { ChromiumCaptureHost } from '../render/chromium-capture-runtime.js';

/** Owner render body (gate policy `export-render`). */
export interface StudioRenderRequest {
  fileName: string;
  title?: string;
  deck?: boolean;
  editable?: boolean;
  index?: number;
  imageFormat?: 'png' | 'jpeg';
  width?: number;
  height?: number;
  versionId?: string;
}

type Format = 'pptx' | 'pdf' | 'image';
const FORMATS: Record<string, Format> = { pptx: 'pptx', 'pdf-image': 'pdf', image: 'image' };

/**
 * Owner PDF/PPTX/PNG exports rendered by the daemon's headless Chromium (#66).
 * The standard `/export/{pptx,pdf-image,image}` endpoints rewrite here. The
 * document and its same-project assets come from a bounded no-follow capture
 * of the owned project and reach the browser only through this render's
 * private namespace; the browser has no route to daemon URLs or the network
 * beyond the configured public font/CDN hosts. Authority is rechecked before
 * bytes are released.
 */
export function registerStudioRenderRoutes(app: Express, input: {
  db: Database.Database; projectsRoot: string; dataRoot: string; host: ChromiumCaptureHost | null;
}): void {
  const ownership = new ProjectOwnershipStore(input.db);
  const active = new Set<string>();
  const host = input.host;
  const render = async (req: Request, res: Response, format: Format) => {
    if (!host) return sendApiError(res, 503, 'UPSTREAM_UNAVAILABLE', 'this deployment has no export renderer configured');
    const id = String(req.params.id);
    const owner = multiUserActorOf(res)?.accountId;
    if (!owner || !ownership.isOwnedBy(id, owner) || !getProject(input.db, id)) return sendApiError(res, 404, 'NOT_FOUND', 'resource not found');
    if (active.has(owner) || active.size >= 2) return sendApiError(res, 429, 'RATE_LIMITED', 'export busy; retry later');
    active.add(owner);
    const body = req.body as StudioRenderRequest;
    let outputDir: string | null = null;
    let registration: { baseHref: string; dispose(): void } | null = null;
    try {
      const entryPath = validateProjectPath(body.fileName) as string;
      if (!mimeFor(entryPath).startsWith('text/html')) return sendApiError(res, 415, 'UNSUPPORTED_MEDIA_TYPE', 'only HTML artifacts can be rendered');
      const files = new Map(captureStudioProject(input.projectsRoot, id).map((file) => [file.name, file.bytes]));
      let html = files.get(entryPath)?.toString('utf8');
      if (body.versionId) {
        const version = await readProjectFileVersion(input.projectsRoot, id, entryPath, body.versionId).catch(() => null);
        if (!version) return sendApiError(res, 404, 'NOT_FOUND', 'version not found');
        html = version.content;
      }
      if (html === undefined) return sendApiError(res, 404, 'FILE_NOT_FOUND', 'HTML entry not found');
      try { await host.ready(); } catch {
        return sendApiError(res, 503, 'UPSTREAM_UNAVAILABLE', 'the export renderer is unavailable on this server');
      }
      registration = host.register(async (relative) => {
        const bytes = files.get(relative);
        return bytes ? { body: bytes, contentType: mimeFor(relative) } : null;
      });
      const entryDir = path.posix.dirname(entryPath);
      const baseHref = entryDir === '.' ? registration.baseHref
        : `${registration.baseHref}${entryDir.split('/').map(encodeURIComponent).join('/')}/`;
      const editable = format === 'pptx' && body.editable === true;
      if (editable) {
        // The editable PPTX engine writes one file; the scratch dir follows the daemon data root.
        outputDir = path.join(input.dataRoot, 'export-render', randomUUID());
        await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });
      }
      const { input: renderInput, title, defaultFilename } = await buildDeckRenderInput({
        daemonUrl: '', projectsRoot: input.projectsRoot, projectId: id, fileName: entryPath, sourceHtml: html, baseHref,
        ...(typeof body.title === 'string' ? { title: body.title } : {}),
        ...(typeof body.width === 'number' ? { width: body.width } : {}),
        ...(typeof body.height === 'number' ? { height: body.height } : {}),
        ...(format === 'pptx' ? { deck: true, ...(editable ? { editable: true, outputDir: outputDir! } : {}) }
          : typeof body.deck === 'boolean' ? { deck: body.deck } : {}),
        ...(format === 'image' ? (typeof body.index === 'number' && Number.isInteger(body.index) && body.index >= 0 ? { index: body.index } : { stitch: true }) : {}),
        ...(format === 'pdf' && body.deck !== true ? { paginate: true } : {}),
        ...(format === 'image' && body.imageFormat === 'jpeg' ? { pageImageFormat: 'jpeg' as const } : {}),
      });
      const rendered = await renderDeckSlides(renderInput);
      const clientError = screenshotRenderClientError(rendered, format);
      if (clientError) return sendApiError(res, clientError.status, 'BAD_REQUEST', clientError.message);
      let buffer: Buffer; let contentType: string; let ext: string;
      if (editable) {
        const real = rendered.ok && typeof rendered.pptxFile === 'string' ? await fs.realpath(rendered.pptxFile).catch(() => null) : null;
        if (!real || path.dirname(real) !== await fs.realpath(outputDir!)) return sendApiError(res, 502, 'UPSTREAM_UNAVAILABLE', rendered.error || 'editable PPTX renderer returned no file');
        buffer = await fs.readFile(real);
        contentType = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'; ext = 'pptx';
      } else {
        if (!rendered.ok || !Array.isArray(rendered.slides) || rendered.slides.length === 0) {
          return sendApiError(res, 502, 'UPSTREAM_UNAVAILABLE', rendered.error || 'renderer returned no images');
        }
        if (format === 'pptx' && rendered.mode === 'page') {
          return sendApiError(res, 422, 'BAD_REQUEST', 'this artifact is not a slide deck — export it as PDF or an image instead');
        }
        const images = decodeSlideDataUrls(rendered.slides);
        if (format === 'pptx') {
          const aspect = typeof rendered.width === 'number' && typeof rendered.height === 'number' && rendered.height > 0 ? rendered.width / rendered.height : undefined;
          buffer = await buildScreenshotPptx(images, { title, ...(aspect ? { aspect } : {}) });
          contentType = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'; ext = 'pptx';
        } else if (format === 'pdf') {
          buffer = await buildScreenshotPdf(images); contentType = 'application/pdf'; ext = 'pdf';
        } else {
          if (images.length !== 1) return sendApiError(res, 502, 'UPSTREAM_UNAVAILABLE', 'renderer returned more than one image');
          buffer = images[0]!.buffer; contentType = images[0]!.jpeg ? 'image/jpeg' : 'image/png'; ext = images[0]!.jpeg ? 'jpg' : 'png';
        }
      }
      // Rendering is slow: logout, deletion or a transfer of the project may have won meanwhile.
      if (req.socket.destroyed || res.destroyed || !multiUserStreamAllowed(res)) return;
      if (!ownership.isOwnedBy(id, owner) || !getProject(input.db, id)) return sendApiError(res, 404, 'NOT_FOUND', 'resource not found');
      const filename = `${defaultFilename}.${ext}`;
      const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '_') || `export.${ext}`;
      res.set({ 'Content-Type': contentType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}` });
      res.send(buffer);
    } catch {
      if (!res.headersSent) sendApiError(res, 400, 'BAD_REQUEST', 'export refused');
    } finally {
      active.delete(owner);
      registration?.dispose();
      if (outputDir) await fs.rm(outputDir, { recursive: true, force: true }).catch(() => undefined);
    }
  };
  for (const [suffix, format] of Object.entries(FORMATS)) {
    app.post(`/api/multiuser/projects/:id/export/${suffix}`, (req, res) => { void render(req, res, format); });
  }
}
