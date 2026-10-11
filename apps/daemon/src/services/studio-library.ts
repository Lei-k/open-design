import Database from 'better-sqlite3';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, lstat, readdir, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { STUDIO_LIBRARY_LIMITS, LIBRARY_UPLOAD_MAX_BYTES, isLibraryUploadMimeAllowed,
  type LibraryAssetFilter, type LibraryIngestRequest, type LibraryIngestResponse, type LibraryPairingConfirmRequest,
  type StudioLibraryConnectionStatus, type ApiErrorCode, type LibrarySourceKind } from '@open-design/contracts';
import { migrateLibrary, listLibraryAssets, getLibraryAsset, findLibraryAssetByHash, updateLibraryAsset, deleteLibraryAsset, addLibraryAssetSource } from '../library-store.js';
import { registerLibraryAsset, detectMime, extForMime, resolveAssetFigmaSidecarPath, resolveAssetElementSidecarPath, writeFigmaSidecar, writeElementSidecar } from '../library.js';
import { writeCompanyProjectMedia } from './company-project-files.js';
import { createSafeOutboundFetch } from '../http/safe-outbound-fetch.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const publicAsset = ({ filePath: _private, ...asset }: NonNullable<ReturnType<typeof getLibraryAsset>>) => asset;
export class StudioLibraryError extends Error {
  constructor(readonly status: number, readonly code: ApiErrorCode) { super('account library request refused'); }
}
const refuse = (status: number, code: ApiErrorCode): never => { throw new StudioLibraryError(status, code); };
export function studioLibraryExtensionOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || !/^(chrome|moz)-extension:\/\/[a-zA-Z0-9-]+$/.test(value)) return null;
  return value;
}
/** Reuses the standard registry/schema/sidecars within private account databases.
 * No host index, token, sync or event bus enters this service. */
export class StudioLibrary {
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly events = new EventEmitter();
  private readonly clock: () => number;
  constructor(private readonly input: { db: Database.Database; dataRoot: string; accountActive(id: string): boolean; clock?: () => number }) {
    this.clock = input.clock ?? Date.now; this.events.setMaxListeners(0);
    input.db.exec(`CREATE TABLE IF NOT EXISTS studio_library_pairing (
      owner_account_id TEXT PRIMARY KEY, code_hash TEXT UNIQUE NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS studio_library_tokens (
      id TEXT PRIMARY KEY, owner_account_id TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, label TEXT NOT NULL,
      extension_origin TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS studio_library_token_owner ON studio_library_tokens(owner_account_id);
      CREATE TABLE IF NOT EXISTS studio_library_rate (owner_account_id TEXT PRIMARY KEY, window_at INTEGER NOT NULL, count INTEGER NOT NULL);`);
  }
  private active(owner: string) { if (!this.input.accountActive(owner)) refuse(401, 'UNAUTHORIZED'); }
  pair(owner: string) {
    this.active(owner); const code = randomBytes(12).toString('base64url'); const expiresAt = this.clock() + STUDIO_LIBRARY_LIMITS.pairingTtlMs;
    this.input.db.prepare(`INSERT INTO studio_library_pairing VALUES (?, ?, ?) ON CONFLICT(owner_account_id)
      DO UPDATE SET code_hash=excluded.code_hash, expires_at=excluded.expires_at`).run(owner, hash(code), expiresAt);
    return { code, expiresAt };
  }
  confirm(body: LibraryPairingConfirmRequest) {
    const origin = studioLibraryExtensionOrigin(body.extensionOrigin);
    if (!origin || typeof body.code !== 'string' || body.code.length > 64 || (body.label !== undefined && (typeof body.label !== 'string' || body.label.length > 128 || /[\x00-\x1f]/.test(body.label)))) refuse(400, 'BAD_REQUEST');
    return this.input.db.transaction(() => {
      const pending = this.input.db.prepare('SELECT owner_account_id AS owner, expires_at AS expiresAt FROM studio_library_pairing WHERE code_hash=?')
        .get(hash(body.code)) as { owner: string; expiresAt: number } | undefined;
      if (!pending || pending.expiresAt <= this.clock() || !this.input.accountActive(pending.owner)) return refuse(401, 'PAIRING_FAILED');
      const count = this.connection(pending.owner).tokens.length;
      if (count >= STUDIO_LIBRARY_LIMITS.maxTokens) refuse(409, 'CONFLICT');
      const token = `odlt_${randomBytes(32).toString('base64url')}`; const label = body.label?.trim() || 'Browser Extension'; const now = this.clock();
      this.input.db.prepare('INSERT INTO studio_library_tokens VALUES (?, ?, ?, ?, ?, ?, ?)').run(randomUUID(), pending.owner, hash(token), label, origin, now, now);
      this.input.db.prepare('DELETE FROM studio_library_pairing WHERE owner_account_id=?').run(pending.owner);
      return { token, label };
    }).immediate();
  }
  tokenOwner(token: string | undefined, origin?: string): string | null {
    if (!token || token.length > 128) return null;
    const row = this.input.db.prepare('SELECT owner_account_id AS owner, extension_origin AS origin FROM studio_library_tokens WHERE token_hash=?').get(hash(token)) as { owner: string; origin: string } | undefined;
    return row && this.input.accountActive(row.owner) && (!origin || origin === row.origin) ? row.owner : null;
  }
  touch(token: string) { this.input.db.prepare('UPDATE studio_library_tokens SET last_used_at=? WHERE token_hash=?').run(this.clock(), hash(token)); }
  connection(owner: string): StudioLibraryConnectionStatus {
    this.active(owner);
    const tokens = this.input.db.prepare(`SELECT id, label, extension_origin AS extensionOrigin, created_at AS createdAt, last_used_at AS lastUsedAt
      FROM studio_library_tokens WHERE owner_account_id=? ORDER BY created_at, rowid`).all(owner) as StudioLibraryConnectionStatus['tokens'];
    return { paired: tokens.length > 0, tokens };
  }
  revoke(owner: string, id: string) { this.active(owner); return this.input.db.prepare('DELETE FROM studio_library_tokens WHERE owner_account_id=? AND id=?').run(owner, id).changes === 1; }
  private rate(owner: string) {
    this.input.db.transaction(() => {
      const now = this.clock(); const row = this.input.db.prepare('SELECT window_at AS start, count FROM studio_library_rate WHERE owner_account_id=?').get(owner) as { start: number; count: number } | undefined;
      const fresh = !row || now - row.start >= 60000;
      if (!fresh && row.count >= STUDIO_LIBRARY_LIMITS.ingestPerMinute) refuse(429, 'RATE_LIMITED');
      this.input.db.prepare('INSERT OR REPLACE INTO studio_library_rate VALUES (?, ?, ?)').run(owner, fresh ? now : row.start, fresh ? 1 : row.count + 1);
    }).immediate();
  }
  private async directory(dir: string) {
    await mkdir(dir, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
    const info = await lstat(dir); if (!info.isDirectory() || info.isSymbolicLink()) refuse(409, 'CONFLICT');
  }
  private async objectPath(root: string, filename: string) {
    if (!filename.startsWith(path.join(root, 'objects') + path.sep) || path.dirname(path.dirname(filename)) !== path.join(root, 'objects')) refuse(409, 'CONFLICT');
    await this.directory(path.join(root, 'objects')); await this.directory(path.dirname(filename));
    const info = await lstat(filename).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return null; });
    if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)) refuse(409, 'CONFLICT'); return info?.size ?? 0;
  }
  /** Serialized per account: quota, sidecar updates and deletion cannot race each other. */
  private withStore<T>(owner: string, operation: (db: Database.Database, root: string) => Promise<T>): Promise<T> {
    const next = (this.pending.get(owner) ?? Promise.resolve()).catch(() => {}).then(async () => {
      this.active(owner);
      const parent = path.join(this.input.dataRoot, 'studio-accounts'); const account = path.join(parent, hash(owner)); const root = path.join(account, 'library');
      for (const dir of [parent, account, root]) {
        await this.directory(dir);
      }
      const filename = path.join(root, 'library.sqlite');
      const existing = await lstat(filename).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return null; });
      if (existing && (!existing.isFile() || existing.nlink !== 1)) refuse(409, 'CONFLICT');
      this.active(owner); const db = new Database(filename);
      try { db.pragma('foreign_keys = ON'); migrateLibrary(db); return await operation(db, root); } finally { db.close(); }
    });
    this.pending.set(owner, next); void next.finally(() => { if (this.pending.get(owner) === next) this.pending.delete(owner); }).catch(() => {});
    return next;
  }
  private check(owner: string, current: () => boolean) { this.active(owner); if (!current()) refuse(401, 'UNAUTHORIZED'); }
  async ingest(owner: string, body: LibraryIngestRequest & { mime?: string | undefined }, current: () => boolean, clipper = false): Promise<LibraryIngestResponse> {
    this.check(owner, current); this.rate(owner);
    let bytes: Buffer;
    if (typeof body.text === 'string') bytes = Buffer.from(body.text);
    else if (typeof body.dataUrl === 'string') {
      const match = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(body.dataUrl);
      if (!match) return refuse(400, 'BAD_REQUEST');
      try { bytes = match[2] ? Buffer.from(match[3]!, 'base64') : Buffer.from(decodeURIComponent(match[3]!)); }
      catch { return refuse(400, 'BAD_REQUEST'); }
      body = { ...body, mime: body.mime ?? match[1] ?? '' };
    } else if (typeof body.url === 'string') {
      try {
        const response = await createSafeOutboundFetch({ maxResponseBytes: STUDIO_LIBRARY_LIMITS.ingestBytes })(body.url, { beforeConnect: () => this.check(owner, current) });
        this.check(owner, current); if (response.status < 200 || response.status >= 300) return refuse(502, 'INGEST_FETCH_FAILED'); bytes = Buffer.from(response.body);
        body = { ...body, mime: body.mime ?? response.headers.get('content-type')?.split(';')[0] ?? '' };
      } catch { this.check(owner, current); return refuse(502, 'INGEST_FETCH_FAILED'); }
    } else return refuse(400, 'BAD_REQUEST');
    const sidecarBytes = Buffer.byteLength(body.figmaCapture ?? '') + Buffer.byteLength(body.elementHtml ?? '');
    if (bytes.length + sidecarBytes > STUDIO_LIBRARY_LIMITS.ingestBytes || (!clipper && bytes.length > LIBRARY_UPLOAD_MAX_BYTES)) refuse(413, 'PAYLOAD_TOO_LARGE');
    const mime = body.mime || (body.text !== undefined ? 'text/plain' : detectMime(bytes, body.filename));
    if (!clipper && !isLibraryUploadMimeAllowed(mime, body.filename)) refuse(415, 'UNSUPPORTED_MEDIA_TYPE');
    return this.withStore(owner, async (db, root) => {
      this.check(owner, current);
      const usage = (db.prepare('SELECT count(*) AS count FROM library_assets').get() as { count: number }).count;
      const contentHash = createHash('sha256').update(bytes).digest('hex'); const existing = findLibraryAssetByHash(db, contentHash);
      const object = path.join(root, 'objects', contentHash.slice(0, 2), contentHash);
      await this.objectPath(root, existing?.filePath ?? `${object}${extForMime(mime)}`);
      let sidecarDelta = 0;
      for (const [content, suffix] of [[body.figmaCapture, '.od-figma.json'], [body.elementHtml, '.element.html']] as const) {
        if (content !== undefined) sidecarDelta += Buffer.byteLength(content) - await this.objectPath(root, `${object}${suffix}`);
      }

      // Count actual objects including sidecars and leftovers after interrupted writes.
      const size = async (dir: string): Promise<number> => {
        const entries = await readdir(dir, { withFileTypes: true }).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; return []; });
        let total = 0; for (const entry of entries) { const full = path.join(dir, entry.name); const info = await lstat(full);
          if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()) || info.isFile() && info.nlink !== 1) refuse(409, 'CONFLICT');
          total += info.isDirectory() ? await size(full) : info.size; } return total;
      };
      if (!existing && usage >= STUDIO_LIBRARY_LIMITS.assets || await size(path.join(root, 'objects')) + (existing ? 0 : bytes.length) + sidecarDelta > STUDIO_LIBRARY_LIMITS.accountBytes) refuse(409, 'MULTIUSER_LIBRARY_LIMIT_REACHED');
      this.check(owner, current);
      const result = await registerLibraryAsset({ db, libraryDir: root, storage: 'owned', bytes, mime,
        filename: `capture${extForMime(mime)}`, kind: body.kind, sourceUrl: body.sourceUrl, sourceTitle: body.sourceTitle, tags: body.tags,
        metadata: { ...(body.metadata ?? {}), ...(body.figmaCapture ? { figmaCapture: { version: 1, size: Buffer.byteLength(body.figmaCapture), nodeCount: body.figmaNodeCount ?? 0 } } : {}) },
        source: { sourceKind: clipper ? 'clipper' : 'manual-upload' }, authorize: () => this.check(owner, current) });
      this.check(owner, current);
      if (body.figmaCapture && !await writeFigmaSidecar(root, result.asset.contentHash, body.figmaCapture)) refuse(500, 'INGEST_FAILED');
      this.check(owner, current);
      if (body.elementHtml && !await writeElementSidecar(root, result.asset.contentHash, body.elementHtml)) refuse(500, 'INGEST_FAILED');
      this.check(owner, current);
      if (result.deduped && (body.figmaCapture || body.elementHtml)) updateLibraryAsset(db, result.asset.id, { metadata: {
        ...(result.asset.metadata ?? {}), ...(body.metadata ?? {}),
        ...(body.figmaCapture ? { figmaCapture: { version: 1, size: Buffer.byteLength(body.figmaCapture), nodeCount: body.figmaNodeCount ?? 0 } } : {}),
      } });
      const asset = publicAsset(getLibraryAsset(db, result.asset.id)!);
      this.events.emit(owner, 'ingest', { assetId: asset.id, deduped: result.deduped });
      return { asset, deduped: result.deduped, ...(result.taskId ? { taskId: result.taskId } : {}) };
    });
  }
  list(owner: string, filter: LibraryAssetFilter = {}) { return this.withStore(owner, async (db) => listLibraryAssets(db, filter).map(publicAsset)); }
  get(owner: string, id: string) { return this.withStore(owner, async (db) => { const asset = getLibraryAsset(db, id); return asset ? publicAsset(asset) : null; }); }
  bytes(owner: string, id: string, kind: 'raw' | 'figma' | 'element' = 'raw') {
    return this.withStore(owner, async (db, root) => {
      const asset = getLibraryAsset(db, id); if (!asset) return null;
      const filename = kind === 'raw' ? asset.filePath : kind === 'figma' ? resolveAssetFigmaSidecarPath(asset, root) : resolveAssetElementSidecarPath(asset, root);
      if (!filename || !filename.startsWith(path.join(root, 'objects') + path.sep)) return null;
      try {
        await this.objectPath(root, filename); const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try { const info = await file.stat(); if (!info.isFile() || info.nlink !== 1 || info.size > STUDIO_LIBRARY_LIMITS.ingestBytes) return null;
          return { bytes: await file.readFile(), mime: kind === 'figma' ? 'application/json' : kind === 'element' ? 'text/html; charset=utf-8' : asset.mime ?? 'application/octet-stream' };
        } finally { await file.close(); }
      } catch { return null; }
    });
  }
  remove(owner: string, id: string, current: () => boolean) { return this.withStore(owner, async (db, root) => {
    this.check(owner, current); const asset = getLibraryAsset(db, id); if (!asset) return false;
    for (const filename of [asset.filePath, resolveAssetFigmaSidecarPath(asset, root), resolveAssetElementSidecarPath(asset, root)]) {
      this.check(owner, current); if (filename?.startsWith(path.join(root, 'objects') + path.sep)) { await this.objectPath(root, filename); this.check(owner, current); await unlink(filename).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; }); }
    }
    this.check(owner, current); deleteLibraryAsset(db, id); this.events.emit(owner, 'delete', { assetId: id }); return true;
  }); }
  async apply(owner: string, id: string, projectId: string, projectsRoot: string, current: () => boolean, dir = 'library', includeElement = false, sourceKind: LibrarySourceKind = 'manual-upload') {
    const asset = await this.get(owner, id); if (!asset) return refuse(404, 'NOT_FOUND');
    const raw = await this.bytes(owner, id); if (!raw) return refuse(404, 'NOT_FOUND');
    const relPath = `${dir}/${asset.contentHash.slice(0, 12)}${extForMime(asset.mime)}`;
    this.check(owner, current); writeCompanyProjectMedia(projectsRoot, projectId, relPath, raw.bytes);
    let elementRelPath: string | undefined;
    if (includeElement) { const element = await this.bytes(owner, id, 'element'); if (element) {
      elementRelPath = `${dir}/${asset.contentHash.slice(0, 12)}.element.html`; this.check(owner, current); writeCompanyProjectMedia(projectsRoot, projectId, elementRelPath, element.bytes); } }
    await this.withStore(owner, async (db) => { this.check(owner, current); addLibraryAssetSource(db, { assetId: id, sourceKind, projectId }); });
    return { relPath, ...(elementRelPath ? { elementRelPath } : {}) };
  }
  link(owner: string, id: string, projectId: string, current: () => boolean) { return this.withStore(owner, async (db) => { this.check(owner, current); addLibraryAssetSource(db, { assetId: id, sourceKind: 'manual-upload', projectId }); }); }
  subscribe(owner: string, listener: (event: string, data: unknown) => void) { this.events.on(owner, listener); return () => { this.events.off(owner, listener); }; }
}
