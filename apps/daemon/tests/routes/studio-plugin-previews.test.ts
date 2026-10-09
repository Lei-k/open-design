import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { Express, Request, Response } from 'express';
import type { InstalledPluginRecord } from '@open-design/contracts';
import { beforeEach, afterEach, expect, it } from 'vitest';
import { closeDatabase, openDatabase } from '../../src/db.js';
import { AuthStore } from '../../src/storage/auth-store.js';
import { internalMultiUserResponse } from '../../src/http/multiuser-internal.js';
import { registerStudioPluginPreviewRoutes } from '../../src/routes/studio-plugin-previews.js';
import { upsertInstalledPlugin } from '../../src/plugins/registry.js';
import { matchMultiUserRoute } from '../../src/http/multiuser-route-classes.js';
import { pluginPreviewCliRequest } from '../../src/plugins/preview-cli.js';

let root: string; let bundledRoot: string; let folder: string; let db: Database.Database; let auth: AuthStore; let clock: number;
let service: { close(): void }; let record: InstalledPluginRecord;
const routes = new Map<string, (req: Request, res: Response) => unknown>();
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-plugin-preview-')); bundledRoot = path.join(root, 'bundled'); folder = path.join(bundledRoot, 'scenario');
  fs.mkdirSync(path.join(folder, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'assets/preview.html'), '<link rel="stylesheet" href="style.css"><h1>Captured</h1><script src="demo.js"></script>');
  fs.writeFileSync(path.join(folder, 'assets/style.css'), 'h1{color:red}'); fs.writeFileSync(path.join(folder, 'assets/demo.js'), 'console.log("demo")');
  fs.writeFileSync(path.join(folder, 'SKILL.md'), 'INTERNAL_SKILL'); fs.writeFileSync(path.join(folder, 'secrets.json'), '{"token":"PRIVATE"}');
  db = openDatabase(root, { dataDir: root }); auth = AuthStore.open({ dataRoot: root }); clock = Date.now();
  for (const id of ['A', 'B', 'admin']) {
    auth.insertAccount({ id, username: id.toLowerCase(), passwordHash: '', passwordState: 'set', active: true, role: id === 'admin' ? 'admin' : 'user', createdAt: clock, updatedAt: clock });
    auth.insertSession({ id: `${id}-session`, accountId: id, tokenHash: `${id}-token`, createdAt: clock, lastSeenAt: clock, expiresAt: clock + 3600_000 });
    auth.setStudioPilot(id, { studioPilot: true, revision: 1 });
  }
  record = { id: 'demo', title: 'Demo', version: '1.0.0', sourceKind: 'bundled', source: folder, trust: 'bundled', capabilitiesGranted: [], fsPath: folder, installedAt: 1, updatedAt: 1,
    manifest: { name: 'demo', version: '1.0.0', od: { kind: 'scenario', preview: { type: 'html', entry: './assets/preview.html' },
      useCase: { exampleOutputs: [{ path: './assets/preview.html', title: 'Example' }] } } } };
  upsertInstalledPlugin(db, record); routes.clear();
  service = registerStudioPluginPreviewRoutes({ get: (url: string, handler: (req: Request, res: Response) => unknown) => routes.set(url, handler) } as unknown as Express,
    { db, dataRoot: root, bundledRoot, previewOrigin: 'https://preview.test', allowedOrigins: ['https://app.test'], clock: () => clock });
});
afterEach(() => { service.close(); auth.close(); closeDatabase(); fs.rmSync(root, { recursive: true, force: true }); });
async function call(options: { actor?: string; id?: string; example?: string; variant?: string; method?: string; scope?: string; file?: string } = {}) {
  const actor = options.actor ?? 'A'; const response = internalMultiUserResponse({ accountId: actor, username: actor, role: actor === 'admin' ? 'admin' : 'user',
    sessionId: `${actor}-session`, sessionExpiresAt: clock + 3600_000 }, () => true);
  const headers: Record<string, string> = {};
  response.res.set = ((key: string | Record<string, string>, value?: string) => {
    Object.assign(headers, typeof key === 'string' ? { [key.toLowerCase()]: value } : Object.fromEntries(Object.entries(key).map(([name, item]) => [name.toLowerCase(), item]))); return response.res;
  }) as Response['set'];
  let ended = false; response.res.end = (() => { ended = true; return response.res; }) as Response['end'];
  const route = options.scope ? '/api/multiuser/plugin-preview/:scope/*path' : `/api/multiuser/catalog/plugins/:id/${options.example === undefined ? 'preview' : 'example/:name'}`;
  await routes.get(route)!({ method: options.method ?? 'GET', params: { id: options.id ?? 'demo', name: options.example, scope: options.scope, path: options.file?.split('/') },
    query: { ...(options.variant ? { variant: options.variant } : {}) } } as unknown as Request, response.res);
  return { ...(response.result() ?? { status: ended ? 200 : 500, body: null }), headers } as { status: number; body: any; headers: Record<string, string> };
}
const descriptor = async (actor = 'A') => (await call({ actor, variant: 'descriptor' })).body;
const capability = async (url: string, file?: string) => {
  const parts = new URL(url).pathname.split('/'); return call({ scope: parts[4]!, file: file ?? parts.slice(5).join('/') });
};

it.each(['A', 'B', 'admin'])('exposes the same bundled source and examples to %s without host paths', async (actor) => {
  const source = await call({ actor }); const example = await call({ actor, example: 'preview' });
  expect(source.status).toBe(200); expect(source.body).toContain('<h1>Captured</h1>'); expect(example.body).toBe(source.body);
  expect(source.headers['content-type']).toContain('text/plain'); expect(source.headers['content-security-policy']).toContain("default-src 'none'");
  const result = await descriptor(actor); expect(result).toMatchObject({ pluginId: 'demo', entry: 'assets/preview.html', version: '1.0.0', expiresAt: clock + 5 * 60_000 });
  expect(JSON.stringify(result)).not.toContain(folder); expect(result.sha256).toMatch(/^[a-f0-9]{64}$/u);
});
it('serves captured local assets with no app cookies, scripts outside the bundle or outbound connections', async () => {
  const preview = await descriptor(); fs.writeFileSync(path.join(folder, 'assets/style.css'), 'UPGRADED');
  expect((await capability(preview.url)).body.toString()).toContain('Captured');
  expect((await capability(preview.url, 'assets/style.css')).body.toString()).toBe('h1{color:red}');
  const policy = (await capability(preview.url)).headers['content-security-policy']!;
  expect(policy).toContain('sandbox allow-scripts'); expect(policy).toContain("connect-src 'none'"); expect(policy).toContain("base-uri 'none'");
  expect(policy).not.toContain('allow-same-origin'); expect(policy).not.toContain('https:;');
  for (const file of ['SKILL.md', 'secrets.json', '../private.html', 'assets/%2e%2e/private.html']) expect((await capability(preview.url, file)).status).toBe(404);
});
it.each(['logout', 'session-expiry', 'scope-expiry', 'disable', 'pilot-revoke', 'pilot-revision', 'upgrade', 'remove', 'restart'])('invalidates preview capabilities on %s', async (change) => {
  const preview = await descriptor(); expect((await capability(preview.url)).status).toBe(200);
  if (change === 'logout') auth.deleteSession('A-session');
  if (change === 'session-expiry') clock += 3600_000;
  if (change === 'scope-expiry') clock += 5 * 60_000;
  if (change === 'disable') auth.updateAccountFlags('A', { role: 'user', active: false }, clock);
  if (change === 'pilot-revoke') auth.setStudioPilot('A', { studioPilot: false, revision: 2 });
  if (change === 'pilot-revision') auth.setStudioPilot('A', { studioPilot: true, revision: 2 });
  if (change === 'upgrade') upsertInstalledPlugin(db, { ...record, version: '2.0.0' });
  if (change === 'remove') db.prepare('DELETE FROM installed_plugins WHERE id = ?').run('demo');
  if (change === 'restart') service.close();
  expect((await capability(preview.url)).status).toBe(404);
});
it.each(['local', 'marketplace', 'github'] as const)('makes %s installs indistinguishable from missing for every actor', async (sourceKind) => {
  upsertInstalledPlugin(db, { ...record, sourceKind });
  for (const actor of ['A', 'B', 'admin']) expect(await call({ actor })).toEqual(await call({ actor, id: 'missing' }));
});
it.each(['symlink', 'hardlink', 'outside-root', 'invalid-utf8', 'oversized'])('refuses unsafe %s captures without reading host data', async (kind) => {
  const file = path.join(folder, 'assets/preview.html'); const outside = path.join(root, 'host.html'); fs.writeFileSync(outside, 'HOST_PRIVATE');
  fs.unlinkSync(file);
  if (kind === 'symlink') fs.symlinkSync(outside, file);
  if (kind === 'hardlink') fs.linkSync(outside, file);
  if (kind === 'outside-root') upsertInstalledPlugin(db, { ...record, fsPath: root });
  if (kind === 'invalid-utf8') fs.writeFileSync(file, Buffer.from([0xff]));
  if (kind === 'oversized') fs.writeFileSync(file, 'x'.repeat(4 * 1024 * 1024 + 1));
  const result = await call({ variant: 'descriptor' }); expect(result.status).toBe(404);
  expect(JSON.stringify(result)).not.toContain('HOST_PRIVATE'); expect(JSON.stringify(result)).not.toContain(root);
});
it('probes without redirecting and evicts old scopes within a bounded per-account pool', async () => {
  const first = await descriptor();
  expect(await call({ method: 'HEAD', variant: 'rendered' })).toMatchObject({ status: 200, headers: { 'cache-control': 'no-store' } });
  const rendered = await call({ variant: 'rendered' }); expect(rendered.status).toBe(302);
  expect((await capability(rendered.headers.location!)).status).toBe(200);
  for (let i = 0; i < 7; i++) await descriptor();
  expect((await capability(first.url)).status).toBe(404);
  expect((await call({ variant: 'unsupported' })).status).toBe(400);
});
it('keeps UI, CLI and aliases on the reviewed API and the host asset proxy closed', () => {
  for (const prefix of ['/api/plugins', '/api/multiuser/catalog/plugins']) for (const suffix of ['/demo/preview', '/demo/example/preview']) {
    for (const method of ['GET', 'HEAD']) expect(matchMultiUserRoute(method, prefix + suffix)[0]?.entry.routeClass).toBe('actor-scoped');
  }
  expect(matchMultiUserRoute('GET', '/api/multiuser/plugin-preview/secret/assets/demo.js')[0]?.entry.routeClass).toBe('preview-capability');
  expect(matchMultiUserRoute('GET', '/api/plugins/demo/asset/secrets.json')[0]?.entry.routeClass).toBe('blocked-in-multiuser');
  expect(pluginPreviewCliRequest(['demo', '--example', 'a/b', '--json'])).toEqual({ path: '/api/plugins/demo/example/a%2Fb?variant=source', json: true, descriptor: false });
  expect(pluginPreviewCliRequest(['demo', '--variant', 'descriptor', '--daemon-url', 'https://app.test'])).toMatchObject({ descriptor: true, daemonUrl: 'https://app.test' });
  for (const args of [[], ['demo', 'extra'], ['demo', '--variant', 'host'], ['demo', '--example'], ['demo', '--unknown'], ['demo', '--daemon-url', 'a', '--daemon-url', 'b']]) expect(() => pluginPreviewCliRequest(args)).toThrow();
});
