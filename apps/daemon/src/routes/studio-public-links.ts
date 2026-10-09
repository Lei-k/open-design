import { createHash, randomBytes } from 'node:crypto';
import { constants, closeSync, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { Express, Request, Response } from 'express';
import type { PublicProjectFilePublication, StudioPublicLinksResponse } from '@open-design/contracts';
import { getProject } from '../db.js';
import { mimeFor, validateProjectPath } from '../projects.js';
import { captureStudioProject } from '../projects/studio-snapshot.js';
import { ProjectAccessStore } from '../storage/project-access.js';
import { AuthStore } from '../storage/auth-store.js';
import { multiUserActorOf } from '../http/multiuser-gate.js';
import { sendApiError } from '../http/api-errors.js';

export const PUBLIC_LINKS_TABLE = 'multiuser_public_links';
const LINKS_PER_ACCOUNT = 100;
const BUNDLE_BYTES = 32 * 1024 * 1024;
const ASSET_REF = /(?:src|href|poster)\s*=\s*["']([^"'#?]+)(?:[?#][^"']*)?["']|url\(\s*["']?([^"')#?]+)/giu;
/** Public bytes run on the preview origin under a sandbox; no cookies, no session, no app access. */
const PUBLIC_CSP = ["sandbox allow-scripts allow-forms allow-popups", "default-src 'self' data: blob:", "img-src 'self' data: blob: https:",
  "media-src 'self' data: blob:", "style-src 'self' 'unsafe-inline' https:", "font-src 'self' data: https:",
  "script-src 'self' 'unsafe-inline'", "connect-src 'none'", "frame-ancestors 'none'", "form-action 'none'"].join('; ');

interface LinkRow { slug: string; project_id: string; owner_account_id: string; file_name: string; digest: string; size: number; created_at: number }

/** Relative same-project files an HTML entry references explicitly; nothing else is published with it. */
function referencedAssets(entry: string, html: string, available: ReadonlyMap<string, Buffer>): string[] {
  const base = path.posix.dirname(entry);
  const found = new Set<string>();
  for (const match of html.matchAll(ASSET_REF)) {
    const ref = (match[1] ?? match[2] ?? '').trim();
    if (!ref || /^[a-z][a-z0-9+.-]*:/iu.test(ref) || ref.startsWith('/') || ref.startsWith('//')) continue;
    let decoded: string;
    try { decoded = decodeURIComponent(ref); } catch { continue; }
    const name = path.posix.normalize(path.posix.join(base === '.' ? '' : base, decoded));
    if (!name.startsWith('../') && name !== entry && available.has(name)) found.add(name);
  }
  return [...found].slice(0, 200);
}

/**
 * Deployment-local public links (#66), with no external relay. The owner
 * publishes one file; its bytes, plus the same-project assets it references,
 * are captured at publish time through the no-follow project capture and
 * served from the cookie-free preview origin under an unguessable slug. Later
 * edits never change a published link (republish to update); revoking,
 * deleting the project or disabling the account ends it.
 */
export function registerStudioPublicLinkRoutes(app: Express, input: {
  db: Database.Database; dataRoot: string; projectsRoot: string; previewOrigin: string; clock?: () => number;
}): { close(): void } {
  const { db } = input;
  const now = input.clock ?? Date.now;
  const accounts = AuthStore.open({ dataRoot: input.dataRoot });
  const access = new ProjectAccessStore(db, { accountActive: (id) => accounts.getAccountById(id)?.active === true });
  const root = path.join(input.dataRoot, 'studio-public-links');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  db.exec(`CREATE TABLE IF NOT EXISTS ${PUBLIC_LINKS_TABLE} (
    slug TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    owner_account_id TEXT NOT NULL, file_name TEXT NOT NULL, digest TEXT NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_${PUBLIC_LINKS_TABLE}_project ON ${PUBLIC_LINKS_TABLE}(project_id, file_name);`);
  const url = (slug: string, fileName: string) => `${input.previewOrigin}/api/multiuser/public/${slug}/${path.posix.basename(fileName).split('/').map(encodeURIComponent).join('/')}`;
  const publication = (row: LinkRow): PublicProjectFilePublication & { createdAt: number; digest: string } =>
    ({ url: url(row.slug, row.file_name), slug: row.slug, fileName: row.file_name, createdAt: row.created_at, digest: row.digest });
  const bundleDir = (slug: string) => path.join(root, slug);
  const removeBundles = (slugs: string[]) => { for (const slug of slugs) rmSync(bundleDir(slug), { recursive: true, force: true }); };
  // Rows whose project disappeared (FK cascade) leave bundles behind; sweep them.
  const sweep = () => {
    const live = new Set((db.prepare(`SELECT slug FROM ${PUBLIC_LINKS_TABLE}`).all() as Array<{ slug: string }>).map((row) => row.slug));
    try { for (const entry of readdirSync(root)) if (!live.has(entry)) removeBundles([entry]); } catch { /* best effort */ }
  };
  const owner = (req: Request, res: Response): { accountId: string; projectId: string } | null => {
    const accountId = multiUserActorOf(res)?.accountId;
    const projectId = String(req.params.id ?? '');
    if (!accountId || !getProject(db, projectId) || access.roleOf(projectId, accountId) !== 'owner') {
      sendApiError(res, 404, 'NOT_FOUND', 'not found'); return null;
    }
    return { accountId, projectId };
  };
  const fileParam = (req: Request): string | null => {
    try { return validateProjectPath(decodeURIComponent(String(req.params.path ?? ''))) as string; } catch { return null; }
  };
  const base = '/api/multiuser/projects/:id/public-links';

  app.get(base, (req, res) => {
    const target = owner(req, res); if (!target) return;
    const rows = db.prepare(`SELECT * FROM ${PUBLIC_LINKS_TABLE} WHERE project_id = ? ORDER BY created_at DESC`).all(target.projectId) as LinkRow[];
    res.setHeader('Cache-Control', 'no-store');
    res.json({ links: rows.map(publication) } satisfies StudioPublicLinksResponse);
  });
  app.get(`${base}/:path`, (req, res) => {
    const target = owner(req, res); if (!target) return;
    const fileName = fileParam(req); if (!fileName) return sendApiError(res, 400, 'BAD_REQUEST', 'invalid file path');
    const row = db.prepare(`SELECT * FROM ${PUBLIC_LINKS_TABLE} WHERE project_id = ? AND file_name = ? ORDER BY created_at DESC LIMIT 1`)
      .get(target.projectId, fileName) as LinkRow | undefined;
    res.setHeader('Cache-Control', 'no-store');
    res.json({ publication: row ? publication(row) : null });
  });
  app.post(`${base}/:path`, (req, res) => {
    const target = owner(req, res); if (!target) return;
    const fileName = fileParam(req); if (!fileName) return sendApiError(res, 400, 'BAD_REQUEST', 'invalid file path');
    let files: Map<string, Buffer>;
    try { files = new Map(captureStudioProject(input.projectsRoot, target.projectId).map((file) => [file.name, file.bytes])); }
    catch { return sendApiError(res, 409, 'CONFLICT', 'the project could not be captured safely'); }
    const entry = files.get(fileName);
    if (!entry) return sendApiError(res, 404, 'FILE_NOT_FOUND', 'file not found');
    const html = /\.html?$/iu.test(fileName) ? entry.toString('utf8') : null;
    const assets = html === null ? [] : referencedAssets(fileName, html, files);
    const bundle = [[fileName, entry] as const, ...assets.map((name) => [name, files.get(name)!] as const)];
    const size = bundle.reduce((sum, [, bytes]) => sum + bytes.length, 0);
    if (size > BUNDLE_BYTES) return sendApiError(res, 413, 'PAYLOAD_TOO_LARGE', 'the published file and its assets are too large');
    const count = (db.prepare(`SELECT COUNT(*) AS n FROM ${PUBLIC_LINKS_TABLE} WHERE owner_account_id = ?`).get(target.accountId) as { n: number }).n;
    const previous = db.prepare(`SELECT slug FROM ${PUBLIC_LINKS_TABLE} WHERE project_id = ? AND file_name = ?`).all(target.projectId, fileName) as Array<{ slug: string }>;
    if (count - previous.length >= LINKS_PER_ACCOUNT) return sendApiError(res, 409, 'CONFLICT', 'public link limit reached; revoke one first');
    const slug = randomBytes(24).toString('base64url');
    const digest = createHash('sha256');
    const dir = bundleDir(slug);
    try {
      mkdirSync(dir, { mode: 0o700 });
      const manifest: Record<string, { file: string; mime: string }> = {};
      bundle.forEach(([name, bytes], index) => {
        digest.update(name).update('\0').update(bytes);
        writeFileSync(path.join(dir, `${index}.bin`), bytes, { mode: 0o600, flag: 'wx' });
        manifest[name] = { file: `${index}.bin`, mime: mimeFor(name) };
      });
      writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ entry: fileName, files: manifest }), { mode: 0o600, flag: 'wx' });
    } catch { removeBundles([slug]); return sendApiError(res, 500, 'INTERNAL_ERROR', 'publish failed'); }
    // Republishing a file replaces its link: the old URL stops serving.
    const row = db.transaction(() => {
      db.prepare(`DELETE FROM ${PUBLIC_LINKS_TABLE} WHERE project_id = ? AND file_name = ?`).run(target.projectId, fileName);
      db.prepare(`INSERT INTO ${PUBLIC_LINKS_TABLE} (slug, project_id, owner_account_id, file_name, digest, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(slug, target.projectId, target.accountId, fileName, digest.digest('hex'), size, now());
      return db.prepare(`SELECT * FROM ${PUBLIC_LINKS_TABLE} WHERE slug = ?`).get(slug) as LinkRow;
    }).immediate();
    removeBundles(previous.map((item) => item.slug));
    res.setHeader('Cache-Control', 'no-store');
    res.json(publication(row));
  });
  app.delete(`${base}/:path`, (req, res) => {
    const target = owner(req, res); if (!target) return;
    const fileName = fileParam(req); if (!fileName) return sendApiError(res, 400, 'BAD_REQUEST', 'invalid file path');
    const slug = (req.body as { slug?: unknown } | undefined)?.slug;
    const rows = db.prepare(`SELECT slug FROM ${PUBLIC_LINKS_TABLE} WHERE project_id = ? AND file_name = ? AND (? IS NULL OR slug = ?)`)
      .all(target.projectId, fileName, typeof slug === 'string' ? slug : null, typeof slug === 'string' ? slug : null) as Array<{ slug: string }>;
    if (!rows.length) return sendApiError(res, 404, 'NOT_FOUND', 'no public link');
    for (const item of rows) db.prepare(`DELETE FROM ${PUBLIC_LINKS_TABLE} WHERE slug = ?`).run(item.slug);
    removeBundles(rows.map((item) => item.slug));
    res.json({ ok: true, slug: rows[0]!.slug, fileName });
  });

  // Cookie-free public serving on the preview origin. Unknown, revoked and
  // disabled-owner links are one indistinguishable 404.
  app.get('/api/multiuser/public/:slug/*path', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const slug = String(req.params.slug ?? '');
    const row = /^[A-Za-z0-9_-]{32}$/.test(slug)
      ? db.prepare(`SELECT * FROM ${PUBLIC_LINKS_TABLE} WHERE slug = ?`).get(slug) as LinkRow | undefined : undefined;
    if (!row || accounts.getAccountById(row.owner_account_id)?.active !== true || !getProject(db, row.project_id)) {
      return sendApiError(res, 404, 'NOT_FOUND', 'not found');
    }
    let manifest: { entry: string; files: Record<string, { file: string; mime: string }> };
    try { manifest = JSON.parse(readFileSync(path.join(bundleDir(slug), 'manifest.json'), 'utf8')); }
    catch { return sendApiError(res, 404, 'NOT_FOUND', 'not found'); }
    const raw = req.params.path;
    const requested = (Array.isArray(raw) ? raw.join('/') : String(raw ?? '')).replaceAll('\\', '/');
    const entryBase = path.posix.dirname(manifest.entry);
    // The entry is served at its own basename; assets resolve relative to it.
    const name = requested === path.posix.basename(manifest.entry) ? manifest.entry
      : path.posix.normalize(entryBase === '.' ? requested : `${entryBase}/${requested}`);
    const item = Object.hasOwn(manifest.files, name) ? manifest.files[name] : undefined;
    if (!item || !/^\d+\.bin$/.test(item.file)) return sendApiError(res, 404, 'NOT_FOUND', 'not found');
    let fd: number | undefined;
    try {
      fd = openSync(path.join(bundleDir(slug), item.file), constants.O_RDONLY | constants.O_NOFOLLOW);
      if (!fstatSync(fd).isFile()) throw new Error('not a file');
      const bytes = readFileSync(fd);
      res.setHeader('Content-Type', item.mime);
      res.setHeader('Content-Security-Policy', PUBLIC_CSP);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
      res.setHeader('X-Robots-Tag', 'noindex');
      res.end(bytes);
    } catch { sendApiError(res, 404, 'NOT_FOUND', 'not found'); }
    finally { if (fd !== undefined) closeSync(fd); }
  });
  sweep();
  return { close: () => accounts.close() };
}
