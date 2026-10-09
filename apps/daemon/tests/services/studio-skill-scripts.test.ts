import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildStudioSkillPackage, captureStudioSkill, readStudioSkillPackages, stageStudioSkillPackages } from '../../src/services/studio-skill-packages.js';
import { probePersonalSandbox } from '../../src/services/personal-sandbox.js';
import { createStudioSkillScriptRunner, studioSkillScriptDirectory } from '../../src/services/studio-skill-scripts.js';
import { captureStudioPluginSkillContext } from '../../src/plugins/studio-skill-context.js';
import { captureStudioPluginResources } from '../../src/plugins/studio-resources.js';
import type { InstalledPluginRecord } from '@open-design/contracts';

const BWRAP = '/usr/bin/bwrap';
const usable = probePersonalSandbox(BWRAP, tmpdir());

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(tmpdir(), 'studio-skill-script-')); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function setup() {
  const resource = path.join(root, 'bundled', 'scripted');
  fs.mkdirSync(path.join(resource, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(resource, 'SKILL.md'), '---\nname: scripted\n---\nRun scripts/render.sh');
  fs.writeFileSync(path.join(resource, 'scripts/render.sh'), [
    'printf "dir=%s\\n" "$OD_SKILL_DIR"',
    'cat "$OD_SKILL_DIR/scripts/data.txt" > "$1"',
    'cat ../daemon-secret.txt 2>/dev/null && echo SECRET_VISIBLE',
    'cat "$OD_SKILL_DIR/../../../daemon-secret.txt" 2>/dev/null && echo SECRET_VISIBLE',
    'echo tamper > "$OD_SKILL_DIR/scripts/data.txt" 2>/dev/null && echo SKILL_WRITABLE',
    'python3 -c "import socket; socket.create_connection((\'1.1.1.1\', 443), 3)" 2>/dev/null && echo NETWORK_OPEN',
    'getent hosts example.com >/dev/null 2>&1 && echo DNS_OPEN',
    'echo done',
  ].join('\n'));
  fs.writeFileSync(path.join(resource, 'scripts/data.txt'), 'CAPTURED_DATA');
  fs.writeFileSync(path.join(resource, 'notes.md'), 'not a script');
  const packages = readStudioSkillPackages([{ id: 'scripted', package: captureStudioSkill(path.join(root, 'bundled'), resource, 'scripted').package }]);
  fs.writeFileSync(path.join(resource, 'scripts/data.txt'), 'LIVE_REPLACEMENT');
  fs.writeFileSync(path.join(root, 'daemon-secret.txt'), 'DAEMON_SECRET');
  const projects = path.join(root, 'projects'); const cwd = path.join(projects, 'owner');
  fs.mkdirSync(cwd, { recursive: true });
  const runHome = path.join(root, 'data', 'runtime', 'run-1'); fs.mkdirSync(runHome, { recursive: true });
  const skillRoot = stageStudioSkillPackages(runHome, packages)!;
  const run = createStudioSkillScriptRunner({ sandbox: { bwrap: BWRAP, readOnlyPaths: [] }, packages, skillRoot, runHome, cwd });
  return { run, cwd, packages, skillRoot };
}

describe.skipIf(!usable)('company skill scripts run in the offline personal sandbox', () => {
  it('reads captured bytes, writes only the project, sees no daemon data or network', async () => {
    const { run, cwd, packages, skillRoot } = setup();
    const result = await run({ skillId: 'scripted', path: 'scripts/render.sh', args: ['out.txt'], signal: new AbortController().signal });
    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    expect(result.stdout).toContain('dir=$OD_SKILL_DIR');
    expect(result.stdout).toContain('done');
    for (const marker of ['SECRET_VISIBLE', 'SKILL_WRITABLE', 'NETWORK_OPEN', 'DNS_OPEN', root]) expect(result.stdout).not.toContain(marker);
    expect(fs.readFileSync(path.join(cwd, 'out.txt'), 'utf8')).toBe('CAPTURED_DATA');
    expect(fs.readFileSync(path.join(skillRoot, packages[0]!.key, 'scripts/data.txt'), 'utf8')).toBe('CAPTURED_DATA');
  });
  it('cancels a running script with the run', async () => {
    const { run, cwd } = setup();
    fs.writeFileSync(path.join(cwd, 'unused'), '');
    const controller = new AbortController();
    const pending = run({ skillId: 'scripted', path: 'scripts/render.sh', args: ['/dev/stdout'], signal: controller.signal });
    controller.abort(new Error('canceled'));
    await expect(pending).rejects.toThrow();
  });
  it('resolves OD_SKILL_DIR at the embedded catalog skill document inside a plugin carrier', async () => {
    const { cwd, packages } = setup();
    const skill = captureStudioPluginSkillContext({ id: 'scripted', name: 'Scripted', source: 'built-in',
      body: 'Run scripts/render.sh', package: packages[0]! });
    const captured = captureStudioPluginResources({ id: 'plugin', version: '1.0.0', manifest: { name: 'plugin', version: '1.0.0' } } as InstalledPluginRecord, skill.files);
    const pluginPackages = [captured.package!];
    const runHome = path.join(root, 'embedded-run'); fs.mkdirSync(runHome);
    const skillRoot = stageStudioSkillPackages(runHome, pluginPackages)!;
    const run = createStudioSkillScriptRunner({ sandbox: { bwrap: BWRAP, readOnlyPaths: [] }, packages: pluginPackages, skillRoot, runHome, cwd });
    const script = pluginPackages[0]!.files.find((file) => file.path.endsWith('/scripts/render.sh'))!;
    const result = await run({ skillId: pluginPackages[0]!.id, path: script.path, args: ['embedded.txt'], signal: new AbortController().signal });
    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    expect(result.stdout).toContain('dir=$OD_SKILL_DIR');
    expect(fs.readFileSync(path.join(cwd, 'embedded.txt'), 'utf8')).toBe('CAPTURED_DATA');
    for (const marker of ['SECRET_VISIBLE', 'SKILL_WRITABLE', 'NETWORK_OPEN', 'DNS_OPEN', root]) expect(result.stdout).not.toContain(marker);
  });
});

it('uses the nearest captured SKILL.md as a script root, preserving ordinary package roots', () => {
  const resource = buildStudioSkillPackage('plugin', ['SKILL.md', 'opendesign-context/skill-fixture/SKILL.md',
    'opendesign-context/skill-fixture/scripts/nested/run.py', 'scripts/run.py'].map((file) => ({ path: file, bytes: Buffer.from('captured'), executable: false })));
  expect(studioSkillScriptDirectory(resource, 'scripts/run.py')).toBe('');
  expect(studioSkillScriptDirectory(resource, 'opendesign-context/skill-fixture/scripts/nested/run.py')).toBe('opendesign-context/skill-fixture');
  expect(studioSkillScriptDirectory(resource, 'opendesign-context/not-a-skill/scripts/run.py')).toBe('');
});

it('refuses embedded skill documents before spawning even if their captured mode is executable', async () => {
  const resource = buildStudioSkillPackage('plugin', ['SKILL.md', 'opendesign-context/skill-fixture/SKILL.md']
    .map((file) => ({ path: file, bytes: Buffer.from('document'), executable: true })));
  const run = createStudioSkillScriptRunner({ sandbox: { bwrap: BWRAP, readOnlyPaths: [] }, packages: [resource],
    skillRoot: root, runHome: root, cwd: root });
  for (const file of resource.files) await expect(run({ skillId: resource.id, path: file.path, args: [], signal: new AbortController().signal }))
    .rejects.toThrow('skill script refused');
});

it('refuses unknown skills, SKILL.md, non-script resources and oversized arguments before spawning', async () => {
  const { run } = setup();
  const signal = new AbortController().signal;
  await expect(run({ skillId: 'foreign', path: 'scripts/render.sh', args: [], signal })).rejects.toThrow('refused');
  await expect(run({ skillId: 'scripted', path: 'SKILL.md', args: [], signal })).rejects.toThrow('refused');
  await expect(run({ skillId: 'scripted', path: 'notes.md', args: [], signal })).rejects.toThrow('not executable');
  await expect(run({ skillId: 'scripted', path: 'scripts/render.sh', args: ['x'.repeat(5000)], signal })).rejects.toThrow('arguments');
  await expect(run({ skillId: 'scripted', path: 'scripts/render.sh', args: ['a\0b'], signal })).rejects.toThrow('arguments');
});
