import http from 'node:http';
import { PNG } from 'pngjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderDeckSlides, setArtifactCaptureRuntime } from '@open-design/artifact-capture';
import { createChromiumCaptureHost, type ChromiumCaptureHost } from '../../src/render/chromium-capture-runtime.js';

// S31 (#66): the desktop capture pipeline driven by headless Chromium.
let host: ChromiumCaptureHost;
let available = true;
let probe: http.Server;
let probeHits = 0;
let probeUrl = '';

beforeAll(async () => {
  host = createChromiumCaptureHost({ assetHosts: [] });
  try { await host.ready(); } catch { available = false; }
  setArtifactCaptureRuntime(host.runtime);
  probe = http.createServer((_req, res) => { probeHits++; res.end('leak'); });
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  probeUrl = `http://127.0.0.1:${(probe.address() as { port: number }).port}/beacon`;
}, 60_000);
afterAll(async () => { await host?.close(); probe?.close(); });

const red = (png: Buffer, x = 0, y = 0) => {
  const { data, width } = PNG.sync.read(png); const i = (y * width + x) * 4;
  return data[i] === 255 && data[i + 1] === 0 && data[i + 2] === 0;
};

describe.runIf(process.platform === 'linux')('headless Chromium capture runtime', () => {
  it('renders each deck slide at the authored stage size', async () => {
    expect(available, 'Chromium must be installed for this suite').toBe(true);
    const html = `<!doctype html><html><head><style>body{margin:0} .slide{width:1920px;height:1080px}</style></head><body>
      <section class="slide" style="background:#ff0000"><h1>One</h1></section>
      <section class="slide" style="background:#0000ff"><h1>Two</h1></section></body></html>`;
    const result = await renderDeckSlides({ html, deck: true });
    expect(result.ok, result.error).toBe(true);
    expect(result.mode).toBe('deck');
    expect(result.slides).toHaveLength(2);
    expect(result.width).toBe(1920); expect(result.height).toBe(1080);
    expect(red(Buffer.from(result.slides![0]!.split(',')[1]!, 'base64'))).toBe(true);
  }, 120_000);

  it('serves only the registered render assets and blocks every other request', async () => {
    const registration = host.register(async (relative) => relative === 'style.css'
      ? { body: Buffer.from('body{background:#ff0000;margin:0}'), contentType: 'text/css' } : null);
    try {
      const html = `<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body>
        <img src="${probeUrl}"><script>fetch(${JSON.stringify(probeUrl)}).catch(()=>{});
        fetch('http://169.254.169.254/latest/meta-data/').catch(()=>{});</script><p>page</p></body></html>`;
      const result = await renderDeckSlides({ html, baseHref: registration.baseHref, deck: false, pageImageFormat: 'png' });
      expect(result.ok, result.error).toBe(true);
      expect(result.mode).toBe('page');
      expect(red(Buffer.from(result.slides![0]!.split(',')[1]!, 'base64'), 1200, 800)).toBe(true);
      expect(probeHits).toBe(0);
    } finally { registration.dispose(); }
  }, 120_000);
});

describe.runIf(process.platform === 'linux')('Chromium inside bubblewrap', () => {
  it('renders through the generated launcher with no network namespace and a minimal filesystem', async () => {
    const { existsSync, mkdtempSync, readFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    expect(existsSync('/usr/bin/bwrap'), 'bubblewrap must be installed for this suite').toBe(true);
    const launcherDir = mkdtempSync(path.join(tmpdir(), 'od-render-launcher-'));
    const sandboxed = createChromiumCaptureHost({ assetHosts: [], bwrap: { path: '/usr/bin/bwrap', launcherDir } });
    try {
      await sandboxed.ready();
      const script = readFileSync(path.join(launcherDir, 'chromium-sandboxed'), 'utf8');
      expect(script).toContain('--unshare-net');
      expect(script).not.toContain(launcherDir.replace(/\/[^/]+$/, '/od-'));
      setArtifactCaptureRuntime(sandboxed.runtime);
      const html = `<!doctype html><html><head><style>body{margin:0} .slide{width:1920px;height:1080px;background:#ff0000}</style></head>
        <body><section class="slide"><h1>簡報</h1></section><img src="${probeUrl}"></body></html>`;
      const result = await renderDeckSlides({ html, deck: true });
      expect(result.ok, result.error).toBe(true);
      expect(red(Buffer.from(result.slides![0]!.split(',')[1]!, 'base64'), 1500, 900)).toBe(true);
      expect(probeHits).toBe(0);
    } finally {
      await sandboxed.close();
      setArtifactCaptureRuntime(host.runtime);
      rmSync(launcherDir, { recursive: true, force: true });
    }
  }, 120_000);
});
