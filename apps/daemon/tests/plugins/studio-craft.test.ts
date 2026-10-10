import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { captureStudioCraft } from '../../src/plugins/studio-craft.js';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-craft-')); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

it('captures only requested rules in manifest order and owns the returned list', () => {
  fs.writeFileSync(path.join(root, 'color.md'), ' Color rules 色彩 ');
  fs.writeFileSync(path.join(root, 'typography.md'), 'Typography rules');
  fs.writeFileSync(path.join(root, 'unused.md'), 'UNREQUESTED_SECRET');
  const requested = ['typography', 'color'];
  const captured = captureStudioCraft(root, requested);
  requested.reverse();
  expect(captured).toEqual({ sections: ['typography', 'color'],
    body: '### typography\n\nTypography rules\n\n---\n\n### color\n\nColor rules 色彩' });
  fs.writeFileSync(path.join(root, 'color.md'), 'changed');
  expect(captured.body).toContain('Color rules 色彩');
});
it('needs no resource root when no rulebook is declared', () => {
  expect(captureStudioCraft(undefined, [])).toEqual({ body: '', sections: [] });
  expect(() => captureStudioCraft(undefined, ['color'])).toThrow();
});
it.each([null, 'color', [123], ['../color'], ['/color'], ['Color'], ['color.md'], ['color', 'color'],
  ['a'.repeat(65)], Array.from({ length: 33 }, (_, i) => `rule-${i}`)])('refuses malformed references %j', (value) => {
  expect(() => captureStudioCraft(root, value)).toThrow('invalid plugin craft references');
});
it('refuses missing and empty rules without dropping declared dependencies', () => {
  fs.writeFileSync(path.join(root, 'color.md'), '   ');
  expect(() => captureStudioCraft(root, ['color'])).toThrow();
  fs.writeFileSync(path.join(root, 'color.md'), 'good');
  expect(() => captureStudioCraft(root, ['color', 'missing'])).toThrow();
});
it('refuses symbolic links, hard links and directories', () => {
  fs.writeFileSync(path.join(root, 'source.md'), 'secret');
  fs.symlinkSync(path.join(root, 'source.md'), path.join(root, 'symbol.md'));
  fs.linkSync(path.join(root, 'source.md'), path.join(root, 'hard.md'));
  fs.mkdirSync(path.join(root, 'directory.md'));
  for (const slug of ['symbol', 'hard', 'directory']) expect(() => captureStudioCraft(root, [slug])).toThrow();
});
it('refuses invalid UTF-8 rather than inserting replacement characters', () => {
  fs.writeFileSync(path.join(root, 'color.md'), Buffer.from([0xc3, 0x28]));
  expect(() => captureStudioCraft(root, ['color'])).toThrow();
});
it('bounds each section and the combined source bytes', () => {
  fs.writeFileSync(path.join(root, 'oversized.md'), 'x'.repeat(128 * 1024 + 1));
  expect(() => captureStudioCraft(root, ['oversized'])).toThrow();
  const slugs = Array.from({ length: 5 }, (_, i) => `section-${i}`);
  for (const slug of slugs) fs.writeFileSync(path.join(root, `${slug}.md`), 'x'.repeat(128 * 1024));
  expect(() => captureStudioCraft(root, slugs)).toThrow('plugin craft context too large');
});
it('refuses a rulebook changed while its bytes are captured', () => {
  const file = path.join(root, 'color.md');
  fs.writeFileSync(file, 'Original rules');
  const read = fs.readSync;
  vi.spyOn(fs, 'readSync').mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
    const count = Reflect.apply(read, fs, args);
    if (count) fs.writeFileSync(file, 'Replacement rules with different size');
    return count;
  }) as typeof fs.readSync);
  expect(() => captureStudioCraft(root, ['color'])).toThrow('plugin craft content changed');
});
