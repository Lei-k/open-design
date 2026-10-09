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
import { registerStudioCatalogRoutes } from '../../src/routes/studio-catalog.js';
import { registerStudioCatalogSharingRoutes, type StudioCatalogSharing } from '../../src/routes/studio-catalog-sharing.js';
import { upsertInstalledPlugin } from '../../src/plugins/registry.js';
import { AuthStore } from '../../src/storage/auth-store.js';
import { StudioSkills } from '../../src/storage/studio-skills.js';
import { ProjectAccessStore } from '../../src/storage/project-access.js';
import { stageStudioSkillPackages } from '../../src/services/studio-skill-packages.js';
import { studioRunResourcePackages } from '../../src/plugins/studio-resources.js';
import { captureStudioPluginSkillContext } from '../../src/plugins/studio-skill-context.js';
import type { SkillInfo } from '../../src/skills.js';

let root: string; let skillsRoot: string; let db: Database.Database; let service: StudioPlugins;
let sharing: StudioCatalogSharing; let accounts: AuthStore; let store: StudioSkills;
let hold: Promise<void> | null; let entered: (() => void) | undefined; let sessionActive: boolean;
const routes = new Map<string, (req: Request, res: Response) => Promise<void>>();
function install(skills: Array<{ ref?: string; path?: string }>, local = false) {
  upsertInstalledPlugin(db, { id: 'skills-fixture', title: 'Skills fixture', version: '1.0.0', sourceKind: 'bundled', source: root,
    trust: 'bundled', capabilitiesGranted: [], fsPath: path.join(root, 'plugin'), installedAt: 1, updatedAt: 1,
    manifest: { name: 'skills-fixture', version: '1.0.0', od: { kind: 'scenario', capabilities: ['prompt:inject'],
      context: { skills: [...(local ? [{ path: './SKILL.md' }] : []), ...skills] } } } } as InstalledPluginRecord);
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-plugin-skills-route-')); skillsRoot = path.join(root, 'skills');
  fs.mkdirSync(path.join(skillsRoot, 'bundled/references'), { recursive: true });
  fs.writeFileSync(path.join(skillsRoot, 'bundled/SKILL.md'), '---\nname: bundled\n---\nBUNDLED_SKILL_BODY');
  fs.writeFileSync(path.join(skillsRoot, 'bundled/references/rules.md'), 'BUNDLED_SKILL_SIDE_FILE');
  fs.mkdirSync(path.join(root, 'plugin'));
  fs.writeFileSync(path.join(root, 'plugin/SKILL.md'), 'PLUGIN_LOCAL_BODY');
  db = openDatabase(root, { dataDir: root }); hold = null; entered = undefined; sessionActive = true;
  accounts = AuthStore.open({ dataRoot: root });
  for (const id of ['A', 'B', 'admin']) accounts.insertAccount({ id, username: id.toLowerCase(), passwordHash: '', role: id === 'admin' ? 'admin' : 'user',
    passwordState: 'setup_required', active: true, createdAt: 1, updatedAt: 1 });
  const access = new ProjectAccessStore(db, { accountActive: () => true });
  for (const [id, owner] of [['project', 'A'], ['admin-project', 'admin']]) {
    db.prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(id, 'Skills project', 1, 1);
    access.ownership.bindOwner(id!, owner!, 1);
  }
  routes.clear();
  const app = Object.fromEntries(['get', 'post', 'patch', 'put', 'delete'].map((method) => [method,
    (url: string, handler: (req: Request, res: Response) => Promise<void>) => routes.set(`${method.toUpperCase()} ${url}`, handler),
  ])) as unknown as Express;
  sharing = registerStudioCatalogSharingRoutes(app, { db, dataRoot: root }); store = new StudioSkills(db);
  const catalog = registerStudioCatalogRoutes(app, { db, skillsRoot, sharing, listBuiltInSkills: async () => [{ id: 'bundled', name: 'Bundled skill',
    dir: path.join(skillsRoot, 'bundled'), source: 'built-in', triggers: [], body: 'Scanner body is never used' } as unknown as SkillInfo] });
  service = registerStudioPluginRoutes(app, { db, dataRoot: root, hostRoots: [root], skillAccess: sharing.grants,
    skillCatalog: { async readSkills(actor, ids) { const skills = await catalog.readSkills(actor, ids); entered?.(); if (hold) await hold; return skills; } } });
  install([{ ref: 'bundled' }]);
});
afterEach(() => { service?.close(); sharing?.close(); accounts?.close(); closeDatabase(); fs.rmSync(root, { recursive: true, force: true }); });
async function apply(actor = 'A', projectId = 'project') {
  const response = internalMultiUserResponse({ accountId: actor, username: actor, role: actor === 'admin' ? 'admin' : 'user',
    sessionId: 'fixture', sessionExpiresAt: Date.now() + 60_000 }, () => sessionActive && accounts.getAccountById(actor)?.active === true);
  await routes.get('POST /api/multiuser/catalog/plugins/:id/apply')!({ params: { id: 'skills-fixture' }, body: { projectId } } as unknown as Request, response.res);
  return response.result() as { status: number; body: any };
}
const count = () => db.prepare('SELECT count(*) AS n FROM studio_plugin_applications').get();
const own = (owner = 'A', body = 'PRIVATE_SKILL_BODY', files?: Array<{ path: string; bytes: Buffer }>) =>
  store.create(owner, { name: `${owner}-skill`, body }, files)!;

it.each(['ref', 'path'] as const)('captures a bundled catalog %s and local plugin skill without host paths', async (key) => {
  install([{ [key]: 'bundled' }], true);
  const applied = await apply(); expect(applied.status).toBe(200);
  expect(applied.body.appliedPlugin.resolvedContext.items).toContainEqual({ kind: 'skill', id: 'bundled', label: 'Bundled skill' });
  const pin = service.projectPin('project', 'A')!;
  expect(pin.prompt).toContain('BUNDLED_SKILL_BODY'); expect(pin.prompt).toContain('PLUGIN_LOCAL_BODY');
  expect(pin.prompt).not.toContain('Scanner body'); expect(pin.prompt).not.toContain(root);
  const files = pin.resourcePackage!.files;
  const reference = files.find((file) => file.path.endsWith('/references/rules.md'))!;
  expect(Buffer.from(reference.data, 'base64').toString()).toBe('BUNDLED_SKILL_SIDE_FILE');
  expect(pin.prompt).toContain(reference.path.replace('/references/rules.md', '/'));
  fs.rmSync(skillsRoot, { recursive: true }); fs.rmSync(path.join(root, 'plugin'), { recursive: true });
  service.close(); service = registerStudioPluginRoutes({ get() {}, post() {} } as unknown as Express, { db, dataRoot: root, hostRoots: [root] });
  expect(service.projectPin('project', 'A')).toEqual(pin);
  const home = path.join(root, 'run'); fs.mkdirSync(home);
  const packages = studioRunResourcePackages({ pluginSnapshot: pin });
  const staged = stageStudioSkillPackages(home, packages)!;
  expect(fs.readFileSync(path.join(staged, packages[0]!.key, reference.path), 'utf8')).toBe('BUNDLED_SKILL_SIDE_FILE');
});

it('captures an owned legacy text skill and preserves it after edits and deletion', async () => {
  const skill = own(); install([{ ref: skill.id }]);
  expect((await apply()).status).toBe(200); const pin = service.projectPin('project', 'A')!;
  expect(pin.prompt).toContain('PRIVATE_SKILL_BODY');
  expect(pin.resourcePackage!.files.some((file) => file.path.endsWith('/SKILL.md'))).toBe(true);
  store.update('A', skill.id, { body: 'EDITED_PRIVATE_SKILL' }); store.delete('A', skill.id);
  expect(service.projectPin('project', 'A')).toEqual(pin);
  expect((await apply()).status).toBe(404); expect(count()).toEqual({ n: 1 });
});

it('requires a private skill grant, gives admins no bypass, and captures all shared folder bytes', async () => {
  const binary = Buffer.from([0, 255, 128, 1]);
  const skill = own('B', 'SHARED_SKILL_BODY', [{ path: 'SKILL.md', bytes: Buffer.from('replaced from stored body') },
    { path: 'assets/font.woff2', bytes: binary }, { path: 'scripts/build.py', bytes: Buffer.from('print("captured")') }]);
  install([{ ref: skill.id }]);
  const missing = (await apply()).body; expect((await apply()).status).toBe(404);
  expect((await apply('admin', 'admin-project'))).toEqual({ status: 404, body: missing });
  expect((await apply('B')).status).toBe(404);
  sharing.grants.set('skill', skill.id, 'A', 1);
  const applied = await apply(); expect(applied.status).toBe(200); expect(applied.body.warnings).toEqual([]);
  const pin = service.projectPin('project', 'A')!;
  expect(pin.prompt).toContain('SHARED_SKILL_BODY');
  const file = pin.resourcePackage!.files.find((file) => file.path.endsWith('/assets/font.woff2'))!;
  expect(Buffer.from(file.data, 'base64')).toEqual(binary);
  sharing.grants.remove('skill', skill.id, 'A');
  expect(await apply()).toEqual({ status: 404, body: missing }); expect(service.projectPin('project', 'A')).toEqual(pin);
});

it('refuses absent, empty or unsafe bundled resources atomically', async () => {
  expect((await apply()).status).toBe(200); const pin = service.projectPin('project', 'A');
  install([{ ref: 'missing' }]); expect((await apply()).status).toBe(404);
  install([{ ref: 'bundled' }]); fs.writeFileSync(path.join(skillsRoot, 'bundled/SKILL.md'), '---\nname: bundled\n---\n');
  expect((await apply()).status).toBe(409);
  fs.writeFileSync(path.join(skillsRoot, 'bundled/SKILL.md'), 'Valid');
  fs.symlinkSync(path.join(root, 'plugin/SKILL.md'), path.join(skillsRoot, 'bundled/linked'));
  expect((await apply()).status).toBe(404); expect(count()).toEqual({ n: 1 }); expect(service.projectPin('project', 'A')).toEqual(pin);
});

it.each(['revoke', 'delete', 'disable-owner', 'disable-actor', 'revoke-session', 'edit'])(
  'rechecks skill and session authority after asynchronous capture: %s', async (change) => {
    const skill = own('B'); install([{ ref: skill.id }]); sharing.grants.set('skill', skill.id, 'A', 1);
    expect((await apply()).status).toBe(200); const pin = service.projectPin('project', 'A');
    let release!: () => void; hold = new Promise<void>((resolve) => { release = resolve; });
    const waiting = new Promise<void>((resolve) => { entered = resolve; }); const pending = apply(); await waiting;
    if (change === 'revoke') sharing.grants.remove('skill', skill.id, 'A');
    else if (change === 'delete') store.delete('B', skill.id);
    else if (change === 'disable-owner') accounts.updateAccountFlags('B', { role: 'user', active: false }, 2);
    else if (change === 'disable-actor') accounts.updateAccountFlags('A', { role: 'user', active: false }, 2);
    else if (change === 'revoke-session') sessionActive = false;
    else store.update('B', skill.id, { body: 'CHANGED_DURING_APPLY' });
    hold = null; release();
    expect((await pending).status).toBe(['disable-actor', 'revoke-session'].includes(change) ? 499 : change === 'edit' ? 409 : 404);
    if (change === 'disable-actor') accounts.updateAccountFlags('A', { role: 'user', active: true }, 3);
    expect(count()).toEqual({ n: 1 }); expect(service.projectPin('project', 'A')).toEqual(pin);
  });

it('enforces the combined prompt limit for several referenced skills without changing the pin', async () => {
  expect((await apply()).status).toBe(200); const pin = service.projectPin('project', 'A');
  const skills = Array.from({ length: 5 }, (_, i) => store.create('A', { name: `large-${i}`, body: 'x'.repeat(256 * 1024) })!);
  install(skills.map((skill) => ({ ref: skill.id })));
  expect(await apply()).toMatchObject({ status: 409, body: { error: { message: 'plugin prompt exceeds the context limit' } } });
  expect(count()).toEqual({ n: 1 }); expect(service.projectPin('project', 'A')).toEqual(pin);
});

it('refuses a plugin file colliding with a referenced skill namespace instead of overwriting captured bytes', async () => {
  expect((await apply()).status).toBe(200); const pin = service.projectPin('project', 'A');
  const skill = own();
  const document = captureStudioPluginSkillContext(store.read('A', skill.id)!).files[0]!.name;
  const collision = path.join(root, 'plugin', document);
  fs.mkdirSync(path.dirname(collision), { recursive: true }); fs.writeFileSync(collision, 'PLUGIN_REPLACEMENT');
  install([{ ref: skill.id }], true);
  expect(await apply()).toMatchObject({ status: 409, body: { error: { message: 'plugin content is unavailable' } } });
  expect(count()).toEqual({ n: 1 }); expect(service.projectPin('project', 'A')).toEqual(pin);
});

it('retains the existing per-carrier resource budget when combining several authorized skills', async () => {
  expect((await apply()).status).toBe(200); const pin = service.projectPin('project', 'A');
  const bytes = Buffer.alloc(3 * 1024 * 1024, 1);
  const skills = Array.from({ length: 3 }, (_, i) => store.create('A', { name: `resources-${i}`, body: 'Captured rules' },
    [{ path: 'SKILL.md', bytes: Buffer.from('Captured rules') }, { path: 'assets/blob.bin', bytes }])!);
  install(skills.map((skill) => ({ ref: skill.id })));
  expect(await apply()).toMatchObject({ status: 409, body: { error: { message: 'plugin content is unavailable' } } });
  expect(count()).toEqual({ n: 1 }); expect(service.projectPin('project', 'A')).toEqual(pin);
});

it('checks project membership and active accounts when reading a captured plugin pin', async () => {
  expect((await apply()).status).toBe(200); const pin = service.projectPin('project', 'A');
  expect(service.projectPin('project', 'B')).toBeNull();
  expect(service.projectPin('project', 'admin')).toBeNull();
  expect(service.projectPin('missing', 'A')).toBeNull();
  const access = new ProjectAccessStore(db, { accountActive: (id) => accounts.getAccountById(id)?.active === true });
  access.setGrant('project', 'B', 'view', 1); expect(service.projectPin('project', 'B')).toEqual(pin);
  accounts.updateAccountFlags('B', { role: 'user', active: false }, 2); expect(service.projectPin('project', 'B')).toBeNull();
  accounts.updateAccountFlags('B', { role: 'user', active: true }, 3); expect(service.projectPin('project', 'B')).toEqual(pin);
  accounts.updateAccountFlags('A', { role: 'user', active: false }, 4);
  expect(service.projectPin('project', 'A')).toBeNull(); expect(service.projectPin('project', 'B')).toBeNull();
  accounts.updateAccountFlags('A', { role: 'user', active: true }, 5);
  access.removeGrant('project', 'B'); expect(service.projectPin('project', 'B')).toBeNull(); expect(service.projectPin('project', 'A')).toEqual(pin);
});
