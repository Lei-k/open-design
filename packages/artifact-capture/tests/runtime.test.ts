import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { artifactCaptureRuntime, loadFirstDomToPptxBundle, setArtifactCaptureRuntime, type CaptureRuntime } from '../src/index.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('artifact capture runtime', () => {
  it('returns the runtime the host installed', () => {
    const runtime = { createWindow: () => { throw new Error('unused'); }, nativeImage: {} as CaptureRuntime['nativeImage'],
      loadDomToPptxBundle: async () => 'bundle' } as CaptureRuntime;
    setArtifactCaptureRuntime(runtime);
    expect(artifactCaptureRuntime()).toBe(runtime);
  });

  it('loads the first readable dom-to-pptx bundle, gunzipping .gz candidates', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'od-capture-')); dirs.push(dir);
    writeFileSync(path.join(dir, 'bundle.js.gz'), gzipSync('window.domToPptx = 1;'));
    await expect(loadFirstDomToPptxBundle([path.join(dir, 'missing.js'), path.join(dir, 'bundle.js.gz')])).resolves.toBe('window.domToPptx = 1;');
    await expect(loadFirstDomToPptxBundle([path.join(dir, 'missing.js')])).rejects.toThrow('dom-to-pptx vendor bundle not found');
  });
});
