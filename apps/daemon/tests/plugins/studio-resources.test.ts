import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { InstalledPluginRecord } from '@open-design/contracts';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { captureStudioPluginResources, studioRunResourcePackages } from '../../src/plugins/studio-resources.js';
import { buildStudioSkillPackage, stageStudioSkillPackages } from '../../src/services/studio-skill-packages.js';

let root: string; let folder: string;
const record = (context: Record<string, unknown> = {}): InstalledPluginRecord => ({
  id: 'resource-fixture', title: 'Resource fixture', version: '1.0.0', sourceKind: 'bundled', source: folder, trust: 'bundled',
  capabilitiesGranted: [], fsPath: folder, installedAt: 1, updatedAt: 1,
  manifest: { name: 'resource-fixture', version: '1.0.0', od: { kind: 'scenario', context } } as InstalledPluginRecord['manifest'],
});
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-plugin-resources-')); folder = path.join(root, 'plugin');
  fs.mkdirSync(path.join(folder, 'references'), { recursive: true });
  fs.mkdirSync(path.join(folder, 'source'));
  fs.writeFileSync(path.join(folder, 'SKILL.md'), '---\nname: fixture\n---\nRead references/rules.md');
  fs.writeFileSync(path.join(folder, 'references/rules.md'), 'CAPTURED_PLUGIN_RULES');
  fs.writeFileSync(path.join(folder, 'references/SECOND.md'), 'Second local skill');
  fs.writeFileSync(path.join(folder, 'source/example.html'), '<h1>CAPTURED_PLUGIN_DESIGN</h1>');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const capture = () => captureStudioPluginResources(record({ skills: [{ path: './SKILL.md' }, { path: './references/SECOND.md' }], assets: ['./source'] }));

it('captures all local skill bodies and a complete relative resource tree with immutable binary bytes', () => {
  const binary = Buffer.from([0, 1, 255, 128]); fs.writeFileSync(path.join(folder, 'source/font.woff2'), binary);
  const captured = capture();
  expect(captured.skills).toEqual([{ path: 'SKILL.md', body: 'Read references/rules.md' },
    { path: 'references/SECOND.md', body: 'Second local skill' }]);
  expect(JSON.stringify(captured)).not.toContain(root);
  fs.writeFileSync(path.join(folder, 'source/font.woff2'), 'LIVE_REPLACEMENT');
  const packages = studioRunResourcePackages({ skillSnapshots: [], pluginSnapshot: { resourcePackage: captured.package } });
  const home = path.join(root, 'run'); fs.mkdirSync(home);
  const staged = stageStudioSkillPackages(home, packages)!;
  expect(fs.readFileSync(path.join(staged, packages[0]!.key, 'source/font.woff2'))).toEqual(binary);
  expect(fs.statSync(path.join(staged, packages[0]!.key, 'source/font.woff2')).mode & 0o777).toBe(0o400);
});
it('supports asset-only plugins with a generated carrier document and no undeclared skill prompt', () => {
  fs.rmSync(path.join(folder, 'SKILL.md'));
  const captured = captureStudioPluginResources(record({ assets: ['./source/example.html'] }));
  expect(captured.skills).toEqual([]);
  expect(captured.package?.files.some((file) => file.path === 'SKILL.md')).toBe(true);
  expect(studioRunResourcePackages({ pluginSnapshot: { resourcePackage: captured.package } })).toHaveLength(1);
});
it('does not inspect a resource root for a content-free plugin', () => {
  const plain = record(); plain.fsPath = path.join(root, 'missing');
  expect(captureStudioPluginResources(plain)).toEqual({ skills: [] });
});
it('refuses missing assets and skills, including an empty declared directory', () => {
  fs.mkdirSync(path.join(folder, 'empty'));
  for (const context of [{ assets: ['./missing.html'] }, { assets: ['./empty'] }, { skills: [{ path: './MISSING.md' }] }]) {
    expect(() => captureStudioPluginResources(record(context))).toThrow();
  }
});
it.each(['../outside', '/etc/passwd', 'file:host', '.secret', './source/../../outside', './source\\other'])('refuses unsafe paths %s', (ref) => {
  expect(() => captureStudioPluginResources(record({ assets: [ref] }))).toThrow();
  expect(() => captureStudioPluginResources(record({ skills: [{ path: `./${ref}` }] }))).toThrow();
});
it('refuses linked files and intermediate directories, even inside the bundle', () => {
  const link = path.join(folder, 'references/linked.md');
  fs.symlinkSync(path.join(folder, 'SKILL.md'), link); expect(capture).toThrow(); fs.unlinkSync(link);
  fs.linkSync(path.join(folder, 'SKILL.md'), link); expect(capture).toThrow(); fs.unlinkSync(link);
  fs.symlinkSync(path.join(folder, 'source'), path.join(folder, 'references/linked-directory')); expect(capture).toThrow();
});
it('refuses corrupt packages and keeps legacy text-only captures readable', () => {
  const captured = capture().package!;
  const damaged = structuredClone(captured); damaged.files[0]!.data = Buffer.from('altered').toString('base64');
  expect(() => studioRunResourcePackages({ pluginSnapshot: { resourcePackage: damaged } })).toThrow();
  expect(() => studioRunResourcePackages({ pluginSnapshot: { resourcePackage: null } })).toThrow();
  expect(studioRunResourcePackages({ skillSnapshots: [{ id: 'old' }], pluginSnapshot: { prompt: 'old text' } })).toEqual([]);
});
it('admits 12 selected skills plus one plugin, enforcing one 16 MiB combined budget', () => {
  const skill = (id: string, bytes: Buffer = Buffer.from('text')) => ({ id, package: buildStudioSkillPackage(id,
    [{ path: 'SKILL.md', bytes, executable: false }]) });
  const skills = Array.from({ length: 12 }, (_, i) => skill(`selected-${i}`));
  expect(studioRunResourcePackages({ skillSnapshots: skills, pluginSnapshot: { resourcePackage: capture().package } })).toHaveLength(13);
  expect(() => studioRunResourcePackages({ skillSnapshots: [...skills, skill('thirteenth')], pluginSnapshot: { resourcePackage: capture().package } })).toThrow();
  const big = Buffer.alloc(4 * 1024 * 1024, 65);
  const bigSkills = [skill('large-1', big), skill('large-2', big), skill('large-3', big), skill('large-4', big)];
  expect(() => studioRunResourcePackages({ skillSnapshots: bigSkills, pluginSnapshot: { resourcePackage: capture().package } })).toThrow();
});
