import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { symlinkSync, writeFileSync } from 'node:fs';
import JSZip from 'jszip';
import { PNG } from 'pngjs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { cleanupIsolatedDataRoot, loadIsolatedServerModule, multiUserOptions, provisionAccounts,
  startMultiUserDaemon, type Principal, type StartedMultiUserDaemon } from './multiuser-harness.js';

// S31 (#66): owner PDF/PPTX/PNG rendered by the daemon's headless Chromium from captured bytes.
let daemon: StartedMultiUserDaemon; let root: string; let a: Principal; let b: Principal; let admin: Principal;
let beacon: http.Server; let beaconHits = 0; let beaconUrl = '';

beforeAll(async () => {
  ({ dataRoot: root } = await loadIsolatedServerModule());
  daemon = await startMultiUserDaemon(multiUserOptions({ studioRenderer: { assetHosts: [] } }));
  const accounts = await provisionAccounts(daemon, ['render-a', 'render-b']);
  [a, b] = accounts.users as [Principal, Principal]; admin = accounts.admin;
  for (const user of [a, b]) {
    const current = await daemon.request({ path: `/api/admin/users/${user.id}/studio-pilot`, cookie: admin.cookie });
    expect((await daemon.request({ method: 'PUT', path: `/api/admin/users/${user.id}/studio-pilot`, cookie: admin.cookie,
      body: { studioPilot: true, revision: current.json.revision } })).status).toBe(200);
  }
  beacon = http.createServer((_req, res) => { beaconHits++; res.end('x'); });
  await new Promise<void>((resolve) => beacon.listen(0, '127.0.0.1', resolve));
  beaconUrl = `http://127.0.0.1:${(beacon.address() as { port: number }).port}/beacon`;
}, 120_000);
afterAll(async () => { await daemon?.close(); beacon?.close(); cleanupIsolatedDataRoot(); });

async function project(files: Record<string, string>) {
  const id = randomUUID();
  expect((await daemon.request({ method: 'POST', path: '/api/projects', cookie: a.cookie, body: { id, name: 'Render deck' } })).status).toBe(200);
  for (const [name, content] of Object.entries(files)) {
    expect((await daemon.request({ method: 'POST', path: `/api/projects/${id}/files`, cookie: a.cookie, body: { name, content } })).status).toBe(200);
  }
  return id;
}
const exportAs = (id: string, suffix: string, body: unknown, user = a) => fetch(`${daemon.baseUrl}/api/projects/${id}/export/${suffix}`, {
  method: 'POST', headers: { cookie: user.cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const DECK = `<!doctype html><html><head><link rel="stylesheet" href="deck.css"></head><body>
  <section class="slide"><h1>Owner slide one</h1></section><section class="slide"><h1>Owner slide two</h1></section>
  <img src="${'BEACON'}"></body></html>`;

it('advertises rendered exports and renders owner PPTX, PDF and PNG from captured project bytes', async () => {
  expect((await daemon.request({ path: '/api/auth/me', cookie: a.cookie })).json.studio.renderedExports).toBe(true);
  const id = await project({ 'decks/deck.html': DECK.replace('BEACON', beaconUrl),
    'decks/deck.css': 'body{margin:0} .slide{width:1920px;height:1080px;background:#ff0000} img{display:none}' });
  const pptx = await exportAs(id, 'pptx', { fileName: 'decks/deck.html', title: 'Owner deck' });
  expect(pptx.status, await pptx.clone().text()).toBe(200);
  expect(pptx.headers.get('content-type')).toContain('presentationml');
  expect(pptx.headers.get('content-disposition')).toMatch(/Owner.*deck\.pptx/);
  const zip = await JSZip.loadAsync(Buffer.from(await pptx.arrayBuffer()));
  expect(Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))).toHaveLength(2);
  const pdf = await exportAs(id, 'pdf-image', { fileName: 'decks/deck.html', deck: true });
  expect(pdf.status).toBe(200);
  expect(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-');
  const image = await exportAs(id, 'image', { fileName: 'decks/deck.html', deck: true, index: 1 });
  expect(image.status).toBe(200); expect(image.headers.get('content-type')).toBe('image/png');
  const png = PNG.sync.read(Buffer.from(await image.arrayBuffer()));
  expect([png.width, png.height]).toEqual([1920, 1080]);
  expect([...png.data.subarray(0, 3)]).toEqual([255, 0, 0]);
  expect(beaconHits).toBe(0);
}, 180_000);

it('refuses foreign, admin and missing projects alike, non-HTML entries and planted links', async () => {
  const id = await project({ 'deck.html': DECK.replace('BEACON', ''), 'notes.txt': 'x' });
  const reference = await exportAs(randomUUID(), 'pptx', { fileName: 'deck.html' }, b);
  expect(reference.status).toBe(404);
  const referenceText = await reference.text();
  for (const user of [b, admin]) for (const suffix of ['pptx', 'pdf-image', 'image']) {
    const response = await exportAs(id, suffix, { fileName: 'deck.html' }, user);
    expect(response.status).toBe(404); expect(await response.text()).toBe(referenceText);
  }
  expect((await exportAs(id, 'pptx', { fileName: 'notes.txt' })).status).toBe(415);
  for (const body of [{ fileName: '../x.html' }, { fileName: 'deck.html', width: 99999 }, { fileName: 'deck.html', imageFormat: 'gif' },
    { fileName: 'deck.html', baseHref: 'http://127.0.0.1/' }]) expect((await exportAs(id, 'image', body)).status).toBe(400);
  writeFileSync(path.join(root, 'render-secret.css'), 'body{content:"RENDER_SECRET"}');
  symlinkSync(path.join(root, 'render-secret.css'), path.join(root, 'projects', id, 'leak.css'));
  const leaked = await exportAs(id, 'pptx', { fileName: 'deck.html' });
  expect(leaked.status).toBeGreaterThanOrEqual(400);
  expect(Buffer.from(await leaked.arrayBuffer()).toString('latin1')).not.toContain('RENDER_SECRET');
}, 180_000);
