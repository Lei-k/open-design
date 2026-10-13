import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DesignSystemDetail } from '@open-design/contracts';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { captureStudioPluginDesignContext } from '../../src/plugins/studio-design-context.js';
import { captureStudioPluginResources } from '../../src/plugins/studio-resources.js';
import type { InstalledPluginRecord } from '@open-design/contracts';

let root: string;
const system = (extra: Partial<DesignSystemDetail> = {}) => ({ id: 'brand', title: 'Brand', source: 'built-in', body: '# Brand\nUse #123456', ...extra } as DesignSystemDetail);
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-plugin-design-'));
  fs.mkdirSync(path.join(root, 'brand'));
  fs.writeFileSync(path.join(root, 'brand/DESIGN.md'), system().body);
  fs.writeFileSync(path.join(root, 'brand/tokens.css'), ':root { --brand: #123456; }');
  fs.writeFileSync(path.join(root, 'brand/components.html'), '<button>Brand</button>');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
it('captures the complete brand package under a host-neutral namespace', () => {
  const captured = captureStudioPluginDesignContext(system(), root);
  expect(captured.prompt).toContain(system().body);
  expect(JSON.stringify(captured)).not.toContain(root);
  expect(captured.files.map((file) => path.basename(file.name)).sort()).toEqual(['DESIGN.md', 'components.html', 'tokens.css']);
  expect(captured.files.every((file) => /^opendesign-context\/design-[a-f0-9]{32}\//.test(file.name))).toBe(true);
  fs.writeFileSync(path.join(root, 'brand/tokens.css'), 'CHANGED');
  expect(captured.files.find((file) => file.name.endsWith('/tokens.css'))?.bytes.toString()).toContain('--brand: #123456');
});
it('captures authorized private documents without inspecting a host user folder', () => {
  const captured = captureStudioPluginDesignContext(system({ id: 'user:studio_fixture', source: 'user' }));
  expect(captured.files).toHaveLength(1);
  expect(captured.files[0]?.name.endsWith('/DESIGN.md')).toBe(true);
});
it('refuses unsupported sources, empty or oversized documents and unsafe bundled ids', () => {
  for (const value of [system({ body: '' }), system({ body: 'x'.repeat(256 * 1024 + 1) }),
    system({ id: '../other' }), system({ id: 'team:foreign', source: 'user' })]) {
    expect(() => captureStudioPluginDesignContext(value, root)).toThrow();
  }
});
it('refuses a package whose document changed since the catalog read, and linked side files', () => {
  fs.writeFileSync(path.join(root, 'brand/DESIGN.md'), 'Replacement');
  expect(() => captureStudioPluginDesignContext(system(), root)).toThrow('design package changed');
  fs.writeFileSync(path.join(root, 'brand/DESIGN.md'), system().body);
  fs.symlinkSync(path.join(root, 'brand/tokens.css'), path.join(root, 'brand/linked.css'));
  expect(() => captureStudioPluginDesignContext(system(), root)).toThrow();
});
it('carries brand bytes in an asset-free plugin without needing a plugin folder', () => {
  const design = captureStudioPluginDesignContext(system(), root);
  const captured = captureStudioPluginResources({ id: 'fixture', version: '1.0.0', fsPath: path.join(root, 'absent'),
    manifest: { name: 'fixture', version: '1.0.0' } } as InstalledPluginRecord, design.files);
  expect(captured.package?.files.filter((file) => file.path.startsWith('opendesign-context/'))).toHaveLength(3);
});
