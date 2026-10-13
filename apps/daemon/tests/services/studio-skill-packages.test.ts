import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureStudioSkill, readStudioSkillPackages, stageStudioSkillPackages } from '../../src/services/studio-skill-packages.js';
import { probePersonalSandbox, sandboxedCommand } from '../../src/services/personal-sandbox.js';

let root: string;
let resource: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(tmpdir(), 'studio-skill-package-'));
  resource = path.join(root, 'bundled', 'test-skill');
  fs.mkdirSync(path.join(resource, 'references'), { recursive: true });
  fs.writeFileSync(path.join(resource, 'SKILL.md'), '---\nname: test-skill\n---\nRead references/rules.md.');
  fs.writeFileSync(path.join(resource, 'references/rules.md'), 'CAPTURED_ORIGINAL');
  fs.writeFileSync(path.join(resource, 'helper.sh'), '#!/bin/sh\nprintf helper');
  fs.chmodSync(path.join(resource, 'helper.sh'), 0o755);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
function capture() { return captureStudioSkill(path.join(root, 'bundled'), resource, 'test-skill'); }
function snapshots() { const captured = capture(); return [{ id: 'test-skill', package: captured.package }]; }

it('captures immutable side files and execution bits, without a host path in the body', () => {
  const captured = capture();
  expect(captured.body).toBe('Read references/rules.md.');
  expect(captured.body).not.toContain(root);
  const packages = readStudioSkillPackages([{ id: 'test-skill', package: captured.package }]);
  fs.writeFileSync(path.join(resource, 'references/rules.md'), 'REPLACEMENT');
  const home = path.join(root, 'run'); fs.mkdirSync(home);
  const staged = stageStudioSkillPackages(home, packages)!;
  expect(fs.readFileSync(path.join(staged, captured.package.key, 'references/rules.md'), 'utf8')).toBe('CAPTURED_ORIGINAL');
  expect(fs.statSync(path.join(staged, captured.package.key, 'helper.sh')).mode & 0o777).toBe(0o500);
  expect(capture().package.hash).not.toBe(captured.package.hash);
});

it('refuses external source directories, source links and hard links', () => {
  expect(() => captureStudioSkill(path.join(root, 'other'), resource, 'test-skill')).toThrow();
  fs.symlinkSync(path.join(resource, 'references/rules.md'), path.join(resource, 'link.md'));
  expect(capture).toThrow();
  fs.unlinkSync(path.join(resource, 'link.md'));
  fs.linkSync(path.join(resource, 'references/rules.md'), path.join(resource, 'hard.md'));
  expect(capture).toThrow();
});

it('refuses corrupt persisted paths, bytes, ids, hashes and excessive resources before staging', () => {
  for (const change of [
    (value: ReturnType<typeof snapshots>) => { value[0]!.package.files[0]!.path = '../escape'; },
    (value: ReturnType<typeof snapshots>) => { value[0]!.package.files[0]!.data = Buffer.from('altered').toString('base64'); },
    (value: ReturnType<typeof snapshots>) => { value[0]!.package.key = 'foreign-key'; },
    (value: ReturnType<typeof snapshots>) => { value[0]!.package.id = 'foreign'; },
    (value: ReturnType<typeof snapshots>) => { value[0]!.package.hash = 'damaged'; },
  ]) {
    const value = snapshots(); change(value);
    expect(() => readStudioSkillPackages(value)).toThrow();
  }
  const value = snapshots();
  expect(() => readStudioSkillPackages([...value, ...value])).toThrow();
  expect(() => readStudioSkillPackages(Array.from({ length: 13 }, () => ({ id: 'text-only' })))).toThrow();
  expect(readStudioSkillPackages([{ id: 'existing-text-only' }])).toEqual([]);
  fs.writeFileSync(path.join(resource, 'too-large.bin'), Buffer.alloc(4 * 1024 * 1024 + 1));
  expect(capture).toThrow();
});

const bwrap = '/usr/bin/bwrap';
describe.skipIf(!probePersonalSandbox(bwrap, tmpdir()))('real read-only resource mount', () => {
  it('blocks resource writes despite the same uid and a writable HOME; control can write', () => {
    const packages = readStudioSkillPackages(snapshots());
    const home = path.join(root, 'run'); fs.mkdirSync(home);
    const skills = stageStudioSkillPackages(home, packages)!;
    const target = path.join(skills, packages[0]!.key, 'references/rules.md');
    const run = (readOnly: boolean) => {
      const command = sandboxedCommand({ bwrap, readOnlyPaths: [] }, { codexHome: home, home, temp: home, cwd: home,
        ...(readOnly ? { skillPackages: skills } : {}) }, ['/bin/sh', '-c',
        'cat "$1"; if chmod u+w "$1" && printf corrupt > "$1"; then exit 12; fi', '_', target]);
      return spawnSync(command[0], command.slice(1), { env: {}, encoding: 'utf8', timeout: 10_000 });
    };
    const protectedRun = run(true);
    expect(protectedRun.status, protectedRun.stderr).toBe(0);
    expect(protectedRun.stdout).toBe('CAPTURED_ORIGINAL');
    expect(fs.readFileSync(target, 'utf8')).toBe('CAPTURED_ORIGINAL');
    expect(run(false).status).toBe(12);
    expect(fs.readFileSync(target, 'utf8')).toBe('corrupt');
  });
});
