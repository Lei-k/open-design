import { createHash, randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { Express, Request, Response } from 'express';
import type { InstalledPluginRecord, StudioPluginPreviewResponse } from '@open-design/contracts';
import { multiUserActorOf } from '../http/multiuser-gate.js';
import { sendApiError } from '../http/api-errors.js';
import { getInstalledPlugin } from '../plugins/registry.js';
import { captureStudioResource } from '../projects/studio-snapshot.js';
import { AuthStore } from '../storage/auth-store.js';

const MAX_POOL_BYTES = 64 * 1024 * 1024;
const TYPES: Record<string, string> = { '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg' };
const safePath = (value: unknown): string | null => {
  if (typeof value !== 'string' || value.length > 1024 || /[\\\u0000-\u001f:#?%]/u.test(value)) return null;
  const name = value.replace(/^\.\//, '');
  return name.split('/').every((part) => part && !part.startsWith('.') && part !== 'node_modules') ? name : null;
};
const stamp = (record: InstalledPluginRecord) => createHash('sha256').update(JSON.stringify([record.version, record.manifest, record.fsPath])).digest('hex');

/** Bundled public resources only. No worker/project files, host asset proxy or network fetches. */
export function registerStudioPluginPreviewRoutes(app: Express, input: {
  db: Database.Database; dataRoot: string; bundledRoot: string; previewOrigin: string; allowedOrigins: string[]; clock?: () => number;
}): { close(): void } {
  const auth = AuthStore.open({ dataRoot: input.dataRoot });
  const now = input.clock ?? Date.now;
  type Capture = { actor: string; session: string; expires: number; pilotRevision: number; plugin: string; stamp: string; files: Map<string, Buffer>; size: number };
  const scopes = new Map<string, Capture>();
  let total = 0;
  const remove = (key: string) => { const item = scopes.get(key); if (item) total -= item.size; scopes.delete(key); };
  const missing = (res: Response) => sendApiError(res, 404, 'NOT_FOUND', 'preview not found');
  const bundled = (id: string) => { const record = getInstalledPlugin(input.db, id); return record?.sourceKind === 'bundled' ? record : null; };
  const route = (req: Request, res: Response) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    const actor = multiUserActorOf(res);
    if (!actor || auth.getAccountById(actor.accountId)?.active !== true) return missing(res);
    const record = bundled(String(req.params.id));
    if (!record) return missing(res);
    const variant = req.query.variant ?? 'source';
    if (typeof variant !== 'string' || !['source', 'descriptor', 'rendered'].includes(variant)) return sendApiError(res, 400, 'BAD_REQUEST', 'invalid preview variant');
    try {
      // Registry metadata alone is never authority to read another host directory.
      const root = realpathSync(input.bundledRoot); const directory = path.resolve(record.fsPath);
      if (!directory.startsWith(root + path.sep) || realpathSync(directory) !== directory) return missing(res);
      const files = new Map(captureStudioResource(path.dirname(directory), directory)
        .filter((file) => Object.hasOwn(TYPES, path.posix.extname(file.name).toLowerCase())).map((file) => [file.name, file.bytes]));
      const od = record.manifest.od;
      const example = req.params.name;
      const examples = od?.useCase?.exampleOutputs ?? [];
      let candidates: unknown[];
      if (example !== undefined) {
        const name = String(example);
        if (!/^[\w.-]{1,128}$/u.test(name) || name.startsWith('.')) return missing(res);
        candidates = examples.filter((entry) => path.posix.basename(entry.path).replace(/\.[^.]+$/, '') === name).map((entry) => entry.path);
        if (!candidates.length) candidates = [`examples/${name}/index.html`, `examples/${name}.html`];
      } else candidates = [od?.preview?.entry, ...(od?.context?.assets ?? []), ...examples.map((entry) => entry.path),
        'preview/index.html', 'index.html', 'examples/index.html', 'assets/index.html', 'assets/preview.html', 'assets/example.html',
        'assets/example-slides.html', 'assets/template.html', 'public/index.html', 'dist/index.html',
        ...[...files.keys()].filter((name) => /^(?:(?:assets|public|dist|examples|preview|templates)\/)?[^/]+\.html?$/iu.test(name))];
      const entry = candidates.map(safePath).find((name): name is string => Boolean(name && /\.html?$/iu.test(name) && files.has(name)));
      if (!entry) return missing(res);
      const bytes = files.get(entry)!;
      const html = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      // Express dispatches HEAD to GET too; probes never mint a scope or redirect across origins.
      if (req.method === 'HEAD') return res.status(200).end();
      if (variant === 'source') return res.set({ 'Content-Type': 'text/plain; charset=utf-8', 'Content-Security-Policy': "sandbox; default-src 'none'" }).send(html);
      const session = auth.getSessionById(actor.sessionId);
      const pilot = auth.getStudioPilot(actor.accountId);
      if (!session || session.accountId !== actor.accountId || session.expiresAt <= now() || !pilot.studioPilot) return missing(res);
      for (const [key, value] of scopes) if (value.expires <= now()) remove(key);
      const size = [...files.values()].reduce((sum, value) => sum + value.length, 0);
      const own = [...scopes].filter(([, value]) => value.actor === actor.accountId);
      while (own.length >= 8) remove(own.shift()![0]);
      while (scopes.size >= 128 || total + size > MAX_POOL_BYTES) remove(scopes.keys().next().value!);
      const key = randomBytes(32).toString('base64url');
      const expiresAt = Math.min(now() + 5 * 60_000, actor.sessionExpiresAt, session.expiresAt);
      scopes.set(key, { actor: actor.accountId, session: actor.sessionId, expires: expiresAt, pilotRevision: pilot.revision, plugin: record.id, stamp: stamp(record), files, size }); total += size;
      const result: StudioPluginPreviewResponse = { pluginId: record.id, version: record.version, entry, sha256: createHash('sha256').update(bytes).digest('hex'),
        url: `${input.previewOrigin}/api/multiuser/plugin-preview/${key}/${entry.split('/').map(encodeURIComponent).join('/')}`, expiresAt };
      return variant === 'descriptor' ? res.json(result) : res.status(302).set('Location', result.url).send('');
    } catch { return missing(res); }
  };
  app.get('/api/multiuser/catalog/plugins/:id/preview', route);
  app.get('/api/multiuser/catalog/plugins/:id/example/:name', route);
  app.get('/api/multiuser/plugin-preview/:scope/*path', (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
    const key = String(req.params.scope); const capture = scopes.get(key);
    const session = capture && auth.getSessionById(capture.session); const account = capture && auth.getAccountById(capture.actor);
    const record = capture && bundled(capture.plugin);
    const pilot = capture && auth.getStudioPilot(capture.actor);
    if (!capture || capture.expires <= now() || !session || session.accountId !== capture.actor || session.expiresAt <= now()
      || !account?.active || account.passwordState !== 'set' || !pilot?.studioPilot || pilot.revision !== capture.pilotRevision
      || !record || stamp(record) !== capture.stamp) { remove(key); return missing(res); }
    const raw = req.params.path; const name = safePath(Array.isArray(raw) ? raw.join('/') : raw);
    const bytes = name ? capture.files.get(name) : undefined;
    if (!bytes || !name) return missing(res);
    res.set({ 'Content-Type': TYPES[path.posix.extname(name).toLowerCase()]!, 'Access-Control-Allow-Origin': 'null',
      'Content-Security-Policy': `sandbox allow-scripts; default-src 'none'; img-src 'self' data:; media-src 'self' data:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-src 'self'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors ${input.allowedOrigins.join(' ')} ${input.previewOrigin}` });
    return res.send(bytes);
  });
  return { close() { scopes.clear(); total = 0; auth.close(); } };
}
