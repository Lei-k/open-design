import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Express, Request, Response } from 'express';
import type Database from 'better-sqlite3';
import type { InstalledPluginRecord } from '@open-design/contracts';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openDatabase, closeDatabase } from '../../src/db.js';
import { internalMultiUserResponse } from '../../src/http/multiuser-internal.js';
import { registerStudioPluginRoutes, type StudioPlugins } from '../../src/routes/studio-plugins.js';
import { getInstalledPlugin, upsertInstalledPlugin } from '../../src/plugins/registry.js';
import { AuthStore } from '../../src/storage/auth-store.js';
import { ProjectAccessStore } from '../../src/storage/project-access.js';

let root: string; let craftRoot: string; let db: Database.Database; let service: StudioPlugins;
const routes = new Map<string, (req: Request, res: Response) => Promise<void>>();
function install(craft: string[] = ['typography', 'color']) {
  const record: InstalledPluginRecord = {
    id: 'craft-fixture', title: 'Craft fixture', version: '1.0.0', sourceKind: 'bundled', source: root, trust: 'bundled',
    capabilitiesGranted: [], fsPath: root, installedAt: 1, updatedAt: 1,
    manifest: { name: 'craft-fixture', version: '1.0.0', od: { kind: 'scenario', capabilities: ['prompt:inject'],
      context: { craft } } },
  };
  upsertInstalledPlugin(db, record);
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-plugin-craft-'));
  craftRoot = path.join(root, 'craft'); fs.mkdirSync(craftRoot);
  fs.writeFileSync(path.join(craftRoot, 'typography.md'), 'CAPTURED_TYPOGRAPHY_RULES');
  fs.writeFileSync(path.join(craftRoot, 'color.md'), 'CAPTURED_COLOR_RULES');
  db = openDatabase(root, { dataDir: root });
  const accounts = AuthStore.open({ dataRoot: root });
  for (const id of ['A', 'B']) accounts.insertAccount({ id, username: id, passwordHash: '', role: 'user',
    passwordState: 'setup_required', active: true, createdAt: 1, updatedAt: 1 });
  accounts.close();
  db.prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run('project', 'Craft project', 1, 1);
  const access = new ProjectAccessStore(db, { accountActive: () => true });
  access.ownership.bindOwner('project', 'A', 1);
  routes.clear();
  const app = Object.fromEntries(['get', 'post'].map((method) => [method,
    (url: string, handler: (req: Request, res: Response) => Promise<void>) => routes.set(`${method.toUpperCase()} ${url}`, handler),
  ])) as unknown as Express;
  service = registerStudioPluginRoutes(app, { db, dataRoot: root, hostRoots: [root], craftRoot });
  install();
});
afterEach(() => { service?.close(); closeDatabase(); fs.rmSync(root, { recursive: true, force: true }); });
async function apply(actor = 'A') {
  const response = internalMultiUserResponse({ accountId: actor, username: actor, role: 'user', sessionId: 'fixture', sessionExpiresAt: Date.now() + 60_000 }, () => true);
  await routes.get('POST /api/multiuser/catalog/plugins/:id/apply')!({ params: { id: 'craft-fixture' }, body: { projectId: 'project' } } as unknown as Request, response.res);
  return response.result() as { status: number; body: any };
}

it('persists craft bodies and refs in the real owner-bound apply transaction, with no host path', async () => {
  expect((await apply('B')).status).toBe(404);
  const applied = await apply(); expect(applied.status).toBe(200);
  expect(applied.body.warnings).toEqual([]);
  expect(applied.body.appliedPlugin.craftRequires).toEqual(['typography', 'color']);
  expect(applied.body.appliedPlugin.resolvedContext.items).toEqual([
    { kind: 'craft', id: 'typography', label: 'typography' }, { kind: 'craft', id: 'color', label: 'color' }]);
  const pinned = service.projectPin('project', 'A')!;
  expect(pinned.prompt).toContain('CAPTURED_TYPOGRAPHY_RULES');
  expect(pinned.prompt).toContain('CAPTURED_COLOR_RULES');
  expect(pinned.prompt).not.toContain(root);
  expect(pinned.promptSha256).toBe(createHash('sha256').update(pinned.prompt).digest('hex'));
  fs.writeFileSync(path.join(craftRoot, 'color.md'), 'UPGRADED_COLOR_RULES');
  db.prepare('DELETE FROM installed_plugins WHERE id = ?').run('craft-fixture');
  expect(service.projectPin('project', 'A')).toEqual(pinned);
});
it('refuses incomplete craft capture without inserting a snapshot or replacing an existing pin', async () => {
  expect((await apply()).status).toBe(200);
  const before = service.projectPin('project', 'A');
  const count = db.prepare('SELECT count(*) AS n FROM applied_plugin_snapshots').get();
  install(['typography', 'missing']);
  expect(await apply()).toMatchObject({ status: 409, body: { error: { code: 'CONFLICT' } } });
  expect(db.prepare('SELECT count(*) AS n FROM applied_plugin_snapshots').get()).toEqual(count);
  expect(service.projectPin('project', 'A')).toEqual(before);
});
it('reopens the persisted capture without the catalog or craft resources', async () => {
  expect((await apply()).status).toBe(200);
  const before = service.projectPin('project', 'A');
  service.close(); fs.rmSync(craftRoot, { recursive: true });
  const app = { get() {}, post() {} } as unknown as Express;
  service = registerStudioPluginRoutes(app, { db, dataRoot: root, hostRoots: [root] });
  expect(service.projectPin('project', 'A')).toEqual(before);
});

it('persists all plugin files and local skills with the application and never rereads them after reopen', async () => {
  const folder = path.join(root, 'plugin'); fs.mkdirSync(path.join(folder, 'references'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'SKILL.md'), '---\nname: first\n---\nFIRST_PLUGIN_SKILL');
  fs.writeFileSync(path.join(folder, 'references/SECOND.md'), 'SECOND_PLUGIN_SKILL');
  fs.writeFileSync(path.join(folder, 'example.html'), '<h1>IMMUTABLE_PLUGIN_ASSET</h1>');
  const installed = getInstalledPlugin(db, 'craft-fixture')!;
  upsertInstalledPlugin(db, { ...installed, fsPath: folder, manifest: { ...installed.manifest,
    od: { ...installed.manifest.od, context: { craft: ['color'], assets: ['./example.html'],
      skills: [{ path: './SKILL.md' }, { path: './references/SECOND.md' }] } } } });
  const applied = await apply(); expect(applied.status).toBe(200);
  const pinned = service.projectPin('project', 'A')!;
  expect(pinned.prompt).toContain('FIRST_PLUGIN_SKILL'); expect(pinned.prompt).toContain('SECOND_PLUGIN_SKILL');
  expect(pinned.prompt).toContain(pinned.resourcePackage!.hash);
  expect(pinned.resourcePackage!.files.find((file) => file.path === 'example.html')?.data)
    .toBe(Buffer.from('<h1>IMMUTABLE_PLUGIN_ASSET</h1>').toString('base64'));
  fs.rmSync(folder, { recursive: true }); service.close();
  service = registerStudioPluginRoutes({ get() {}, post() {} } as unknown as Express, { db, dataRoot: root, hostRoots: [root] });
  expect(service.projectPin('project', 'A')).toEqual(pinned);
});
it('adds the nullable resource carrier to a legacy application table without rewriting old snapshots', async () => {
  expect((await apply()).status).toBe(200);
  const pinned = service.projectPin('project', 'A'); service.close();
  db.exec('ALTER TABLE studio_plugin_applications DROP COLUMN resource_package_json');
  service = registerStudioPluginRoutes({ get() {}, post() {} } as unknown as Express, { db, dataRoot: root, hostRoots: [root] });
  expect(service.projectPin('project', 'A')).toEqual(pinned);
  expect(() => db.prepare('UPDATE studio_plugin_applications SET prompt = ?').run('changed')).toThrow('immutable');
});
it('bounds the combined rendered context without replacing the current application', async () => {
  expect((await apply()).status).toBe(200); const pinned = service.projectPin('project', 'A');
  const folder = path.join(root, 'large-plugin'); fs.mkdirSync(folder);
  const skills = Array.from({ length: 5 }, (_, i) => ({ path: `./RULES-${i}.md` }));
  for (const skill of skills) fs.writeFileSync(path.join(folder, skill.path), 'x'.repeat(256 * 1024));
  const installed = getInstalledPlugin(db, 'craft-fixture')!;
  upsertInstalledPlugin(db, { ...installed, fsPath: folder, manifest: { ...installed.manifest,
    od: { ...installed.manifest.od, context: { skills } } } });
  expect(await apply()).toMatchObject({ status: 409, body: { error: { code: 'CONFLICT', message: 'plugin prompt exceeds the context limit' } } });
  expect(service.projectPin('project', 'A')).toEqual(pinned);
});
