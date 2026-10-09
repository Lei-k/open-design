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
import { registerStudioDesignCatalogRoutes } from '../../src/routes/studio-design-catalog.js';
import { registerStudioCatalogSharingRoutes, type StudioCatalogSharing } from '../../src/routes/studio-catalog-sharing.js';
import { upsertInstalledPlugin } from '../../src/plugins/registry.js';
import { AuthStore } from '../../src/storage/auth-store.js';
import { StudioDesignSystems } from '../../src/storage/studio-design-systems.js';
import { ProjectAccessStore } from '../../src/storage/project-access.js';
import type { DesignSystemSummary } from '../../src/design-systems/index.js';

let root: string; let brands: string; let db: Database.Database; let service: StudioPlugins;
let sharing: StudioCatalogSharing; let accounts: AuthStore; let store: StudioDesignSystems;
let hold: Promise<void> | null; let entered: (() => void) | undefined;
const routes = new Map<string, (req: Request, res: Response) => Promise<void>>();
function install(reference: { primary?: boolean; ref?: string }) {
  upsertInstalledPlugin(db, { id: 'design-fixture', title: 'Design fixture', version: '1.0.0', sourceKind: 'bundled', source: root,
    trust: 'bundled', capabilitiesGranted: [], fsPath: path.join(root, 'missing-plugin'), installedAt: 1, updatedAt: 1,
    manifest: { name: 'design-fixture', version: '1.0.0', od: { kind: 'scenario', capabilities: ['prompt:inject'],
      context: { designSystem: reference } } } } as InstalledPluginRecord);
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-plugin-design-route-')); brands = path.join(root, 'brands');
  fs.mkdirSync(path.join(brands, 'brand'), { recursive: true });
  fs.writeFileSync(path.join(brands, 'brand/DESIGN.md'), 'BUNDLED_DESIGN_RULES');
  fs.writeFileSync(path.join(brands, 'brand/tokens.css'), ':root { --brand: #123456; }');
  db = openDatabase(root, { dataDir: root }); hold = null; entered = undefined;
  accounts = AuthStore.open({ dataRoot: root });
  for (const id of ['A', 'B', 'admin']) accounts.insertAccount({ id, username: id.toLowerCase(), passwordHash: '', role: id === 'admin' ? 'admin' : 'user',
    passwordState: 'setup_required', active: true, createdAt: 1, updatedAt: 1 });
  db.prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run('project', 'Brand project', 1, 1);
  new ProjectAccessStore(db, { accountActive: () => true }).ownership.bindOwner('project', 'A', 1);
  routes.clear();
  const app = Object.fromEntries(['get', 'post', 'patch', 'put', 'delete'].map((method) => [method,
    (url: string, handler: (req: Request, res: Response) => Promise<void>) => routes.set(`${method.toUpperCase()} ${url}`, handler),
  ])) as unknown as Express;
  sharing = registerStudioCatalogSharingRoutes(app, { db, dataRoot: root });
  store = new StudioDesignSystems(db);
  const catalog = registerStudioDesignCatalogRoutes(app, { db, designSystemsRoot: brands, promptTemplatesRoot: root, craftRoot: root,
    sharing, listBuiltInTemplates: async () => [], listBuiltInSystems: async () => [{ id: 'brand', title: 'Brand', source: 'built-in',
      body: fs.readFileSync(path.join(brands, 'brand/DESIGN.md'), 'utf8') } as DesignSystemSummary] });
  service = registerStudioPluginRoutes(app, { db, dataRoot: root, hostRoots: [root], designSystemsRoot: brands, designAccess: sharing.grants,
    designCatalog: { async readSystem(actor, id) { const system = await catalog.readSystem(actor, id); entered?.(); if (hold) await hold; return system; } } });
  install({ ref: 'brand' });
});
afterEach(() => { service?.close(); sharing?.close(); accounts?.close(); closeDatabase(); fs.rmSync(root, { recursive: true, force: true }); });
async function apply(actor = 'A') {
  const response = internalMultiUserResponse({ accountId: actor, username: actor, role: actor === 'admin' ? 'admin' : 'user',
    sessionId: 'fixture', sessionExpiresAt: Date.now() + 60_000 }, () => true);
  await routes.get('POST /api/multiuser/catalog/plugins/:id/apply')!({ params: { id: 'design-fixture' }, body: { projectId: 'project' } } as unknown as Request, response.res);
  return response.result() as { status: number; body: any };
}
const count = () => db.prepare('SELECT count(*) AS n FROM studio_plugin_applications').get();
it('captures explicit bundled design rules and token files in the standard apply snapshot', async () => {
  const applied = await apply(); expect(applied.status).toBe(200);
  expect(applied.body.warnings).toEqual([]);
  expect(applied.body.appliedPlugin.resolvedContext.items).toEqual([{ kind: 'design-system', id: 'brand', label: 'Brand', primary: true }]);
  const pin = service.projectPin('project', 'A')!;
  expect(pin.prompt).toContain('BUNDLED_DESIGN_RULES'); expect(pin.prompt).not.toContain(root);
  expect(pin.resourcePackage?.files.some((file) => file.path.endsWith('/tokens.css'))).toBe(true);
  fs.rmSync(brands, { recursive: true }); expect(service.projectPin('project', 'A')).toEqual(pin);
});
it.each([{}, { primary: true }])('binds primary design context %j to the owner project selection and refuses an absent selection', async (reference) => {
  install(reference); expect((await apply()).status).toBe(409);
  const own = store.create('A', { title: 'Own brand', body: 'OWNER_PRIVATE_BRAND' });
  db.prepare('UPDATE projects SET design_system_id = ? WHERE id = ?').run(own.id, 'project');
  expect((await apply()).status).toBe(200);
  const pin = service.projectPin('project', 'A')!;
  expect(pin.prompt).toContain('OWNER_PRIVATE_BRAND');
  store.update('A', own.id, { body: 'NEW_BRAND' }); store.delete('A', own.id);
  expect(service.projectPin('project', 'A')).toEqual(pin);
});
it('requires a private document grant and gives neither foreign accounts nor admins owner access', async () => {
  const other = store.create('B', { title: 'Shared brand', body: 'SHARED_PRIVATE_BRAND' }); install({ ref: other.id });
  expect((await apply()).status).toBe(404);
  for (const actor of ['B', 'admin']) expect((await apply(actor)).status).toBe(404);
  sharing.grants.set('design-system', other.id, 'A', 1);
  expect((await apply()).status).toBe(200); const pin = service.projectPin('project', 'A');
  sharing.grants.remove('design-system', other.id, 'A');
  expect((await apply()).status).toBe(404); expect(service.projectPin('project', 'A')).toEqual(pin);
});
it.each(['revoke', 'delete', 'disable-owner'])('rechecks private design authority after asynchronous capture: %s', async (change) => {
  const other = store.create('B', { body: 'PRIVATE_BRAND' }); install({ ref: other.id }); sharing.grants.set('design-system', other.id, 'A', 1);
  let release!: () => void; hold = new Promise<void>((resolve) => { release = resolve; });
  const waiting = new Promise<void>((resolve) => { entered = resolve; }); const pending = apply();
  await waiting;
  if (change === 'revoke') sharing.grants.remove('design-system', other.id, 'A');
  else if (change === 'delete') store.delete('B', other.id);
  else accounts.updateAccountFlags('B', { role: 'user', active: false }, 2);
  hold = null; release(); expect((await pending).status).toBe(404); expect(count()).toEqual({ n: 0 });
});
it('refuses a project design selection changed while apply awaited the catalog', async () => {
  install({ primary: true }); db.prepare('UPDATE projects SET design_system_id = ? WHERE id = ?').run('brand', 'project');
  let release!: () => void; hold = new Promise<void>((resolve) => { release = resolve; });
  const waiting = new Promise<void>((resolve) => { entered = resolve; }); const pending = apply(); await waiting;
  db.prepare('UPDATE projects SET design_system_id = NULL WHERE id = ?').run('project');
  hold = null; release(); expect((await pending).status).toBe(409); expect(count()).toEqual({ n: 0 });
});
it('refuses a same-version manifest replaced while apply awaited the design catalog', async () => {
  let release!: () => void; hold = new Promise<void>((resolve) => { release = resolve; });
  const waiting = new Promise<void>((resolve) => { entered = resolve; }); const pending = apply(); await waiting;
  db.prepare("UPDATE installed_plugins SET manifest_json = json_set(manifest_json, '$.description', 'Replacement') WHERE id = ?").run('design-fixture');
  hold = null; release(); expect((await pending).status).toBe(409); expect(count()).toEqual({ n: 0 });
});
