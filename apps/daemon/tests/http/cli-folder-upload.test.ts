import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, linkSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { captureCliFolder } from '../../src/http/cli-folder-upload.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true }); });
const root = () => { const value = mkdtempSync(path.join(os.tmpdir(), 'studio selected folder ')); roots.push(value); return value; };

it('uploads a folder with spaces, nested binary assets and no hidden credentials or dependency caches', () => {
  const directory = root();
  mkdirSync(path.join(directory, 'assets')); mkdirSync(path.join(directory, 'node_modules'));
  writeFileSync(path.join(directory, 'assets', 'logo.png'), Buffer.from([0, 255, 128]));
  writeFileSync(path.join(directory, '.env'), 'PRIVATE'); writeFileSync(path.join(directory, 'node_modules', 'a.js'), 'DEPENDENCY');
  writeFileSync(path.join(directory, '.artifact.json'), 'private manifest');
  expect(captureCliFolder(directory)).toEqual([{ name: 'assets/logo.png', bytes: Buffer.from([0, 255, 128]) }]);
});

it('refuses file and directory links, hard links, and an empty selected folder', () => {
  const directory = root(); const outside = root(); writeFileSync(path.join(outside, 'secret'), 'PRIVATE');
  expect(() => captureCliFolder(directory)).toThrow('no uploadable');
  symlinkSync(outside, path.join(directory, 'linked')); expect(() => captureCliFolder(directory)).toThrow('symbolic');
  rmSync(path.join(directory, 'linked'));
  linkSync(path.join(outside, 'secret'), path.join(directory, 'hard')); expect(() => captureCliFolder(directory)).toThrow('unsupported');
});
