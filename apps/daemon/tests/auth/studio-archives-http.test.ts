import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { linkSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import JSZip from 'jszip';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { STUDIO_ARCHIVE_SHA256_HEADER } from '@open-design/contracts';
import { cleanupIsolatedDataRoot, loadIsolatedServerModule, provisionAccounts, startMultiUserDaemon,
  type Principal, type StartedMultiUserDaemon } from './multiuser-harness.js';

let daemon: StartedMultiUserDaemon; let root: string; let a: Principal; let b: Principal; let admin: Principal;
beforeAll(async () => {
  ({ dataRoot: root } = await loadIsolatedServerModule()); daemon = await startMultiUserDaemon();
  const accounts = await provisionAccounts(daemon, ['archive-a', 'archive-b']);
  [a, b] = accounts.users as [Principal, Principal]; admin = accounts.admin;
}, 120_000);
afterAll(async () => { await daemon?.close(); cleanupIsolatedDataRoot(); });
async function project() {
  const response = await daemon.request({ method: 'POST', path: '/api/projects', cookie: a.cookie,
    body: { id: randomUUID(), name: 'Owned design' } });
  expect(response.status, response.text).toBe(200); return response.json.project.id as string;
}
async function write(id: string, name: string, content: string, encoding = 'utf8') {
  expect((await daemon.request({ method: 'POST', path: `/api/projects/${id}/files`, cookie: a.cookie,
    body: { name, content, encoding } })).status).toBe(200);
}
function download(id: string, owner = a, suffix = '/archive', body?: unknown, alias = false) {
  return fetch(`${daemon.baseUrl}/api/${alias ? 'multiuser/' : ''}projects/${id}${suffix}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { cookie: owner.cookie,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

it('downloads captured binary/text bytes, checksum and standard handoff metadata, excluding internal data', async () => {
  const id = await project(); await write(id, 'site/index.html', '<h1>Captured original</h1>');
  await write(id, 'site/assets/logo.png', 'AP8BgA==', 'base64');
  writeFileSync(path.join(root, 'projects', id, '.env'), 'secret must be excluded');
  const response = await download(id);
  expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('content-type')).toContain('application/zip');
  expect(response.headers.get('content-disposition')).toContain('Owned-design.zip');
  const bytes = Buffer.from(await response.arrayBuffer());
  expect(response.headers.get(STUDIO_ARCHIVE_SHA256_HEADER)).toBe(createHash('sha256').update(bytes).digest('hex'));
  await write(id, 'site/index.html', 'Changed after capture');
  const zip = await JSZip.loadAsync(bytes);
  expect(await zip.file('site/index.html')!.async('string')).toBe('<h1>Captured original</h1>');
  expect(await zip.file('site/assets/logo.png')!.async('nodebuffer')).toEqual(Buffer.from([0, 255, 1, 128]));
  expect(zip.file('.env')).toBeNull(); expect(zip.file('DESIGN-HANDOFF.md')).not.toBeNull();
  expect(JSON.parse(await zip.file('DESIGN-MANIFEST.json')!.async('string'))).toMatchObject({
    schema: 'open-design.design-manifest.v1', entryFile: 'site/index.html',
    sourceFiles: { all: ['site/assets/logo.png', 'site/index.html'] },
  });
});

it('supports folder and exact-file selection, and rejects missing, traversal, hidden and extra inputs', async () => {
  const id = await project(); await write(id, 'site/index.html', 'HTML'); await write(id, 'site/assets/logo.png', 'AA==', 'base64');
  const folder = await download(id, a, '/archive?root=site', undefined, true);
  expect(folder.status).toBe(200);
  expect((await JSZip.loadAsync(await folder.arrayBuffer())).file('index.html')).not.toBeNull();
  const selected = await download(id, a, '/archive/batch', { files: ['site/assets/logo.png'] });
  expect(selected.status).toBe(200);
  const zip = await JSZip.loadAsync(await selected.arrayBuffer());
  expect(zip.file('site/index.html')).toBeNull(); expect(zip.file('site/assets/logo.png')).not.toBeNull();
  for (const suffix of ['/archive?root=../', '/archive?root=.env', '/archive?baseDir=host', '/archive?root=site&root=other'])
    expect((await download(id, a, suffix)).status, suffix).toBe(400);
  for (const files of [[], ['../private'], ['.env'], ['site/index.html', 'site/index.html']])
    expect((await download(id, a, '/archive/batch', { files })).status).toBe(400);
  expect((await download(id, a, '/archive/batch', { files: ['site/index.html'], ownerId: a.id })).status).toBe(400);
  expect((await download(id, a, '/archive/batch', { files: ['missing.html'] })).status).toBe(404);
  expect((await download(id, a, '/archive?root=missing')).status).toBe(404);
});

it('gives foreign users, admins and missing ids the same refusal with no byte/checksum oracle on either alias', async () => {
  const id = await project(); await write(id, 'index.html', 'owner-only');
  for (const alias of [false, true]) for (const owner of [b, admin]) for (const batch of [false, true]) {
    const suffix = batch ? '/archive/batch' : '/archive'; const body = batch ? { files: ['index.html'] } : undefined;
    const foreign = await download(id, owner, suffix, body, alias);
    const missing = await download(randomUUID(), owner, suffix, body, alias);
    expect(foreign.status).toBe(404); expect(await foreign.text()).toBe(await missing.text());
    expect(foreign.headers.get(STUDIO_ARCHIVE_SHA256_HEADER)).toBeNull();
    expect(foreign.headers.get('content-disposition')).toBeNull();
  }
});

it('refuses symlinks and hard links without reading host or foreign files', async () => {
  const host = path.join(root, 'archive-host-secret'); writeFileSync(host, 'host archive secret');
  for (const hard of [false, true]) {
    const id = await project(); await write(id, 'index.html', 'owned');
    (hard ? linkSync : symlinkSync)(host, path.join(root, 'projects', id, 'escape.txt'));
    const response = await download(id); expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('host archive secret');
    expect(response.headers.get(STUDIO_ARCHIVE_SHA256_HEADER)).toBeNull();
  }
});

it('withdraws all bytes when the session is logged out while real compression yields', async () => {
  const id = await project(); await write(id, 'index.html', 'must not release after logout');
  const login = await daemon.request({ method: 'POST', path: '/api/auth/login', body: { username: a.username, password: a.password } });
  const cookie = login.setCookies[0]!.split(';')[0]!;
  const original = JSZip.prototype.generateAsync;
  const spy = vi.spyOn(JSZip.prototype, 'generateAsync').mockImplementationOnce(async function (this: JSZip, options, onUpdate) {
    expect((await daemon.request({ method: 'POST', path: '/api/auth/logout', cookie, body: {} })).status).toBe(204);
    return original.call(this, options, onUpdate);
  });
  try {
    const response = await download(id, { ...a, cookie });
    expect((await response.arrayBuffer()).byteLength).toBe(0);
    expect(response.headers.get(STUDIO_ARCHIVE_SHA256_HEADER)).toBeNull();
    expect(spy).toHaveBeenCalledOnce();
  } finally { spy.mockRestore(); }
});


it('bounds concurrent captures and releases admission after completion', async () => {
  const id = await project(); await write(id, 'index.html', 'bounded capture');
  let release!: () => void; let entered!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const original = JSZip.prototype.generateAsync;
  const spy = vi.spyOn(JSZip.prototype, 'generateAsync').mockImplementationOnce(async function (this: JSZip, options, onUpdate) {
    entered(); await blocked; return original.call(this, options, onUpdate);
  });
  const first = download(id);
  try {
    await started;
    expect((await download(id)).status).toBe(429);
    release();
    expect((await first).status).toBe(200);
    expect((await download(id)).status).toBe(200);
  } finally { release(); await first; spy.mockRestore(); }
});


it('withdraws a backpressured download after logout instead of sending the remaining archive', async () => {
  const id = await project();
  writeFileSync(path.join(root, 'projects', id, 'large.bin'), randomBytes(12 * 1024 * 1024));
  const login = await daemon.request({ method: 'POST', path: '/api/auth/login', body: { username: a.username, password: a.password } });
  const cookie = login.setCookies[0]!.split(';')[0]!;
  const transfer = await new Promise<{ bytes: number; declared: number }>((resolve, reject) => {
    const request = http.get(`${daemon.baseUrl}/api/projects/${id}/archive`, { headers: { cookie } }, (incoming) => {
      incoming.pause(); let bytes = 0;
      const declared = Number(incoming.headers['content-length']);
      const complete = () => resolve({ bytes, declared });
      incoming.on('data', (chunk: Buffer) => { bytes += chunk.length; });
      incoming.once('end', complete); incoming.once('error', complete);
      void daemon.request({ method: 'POST', path: '/api/auth/logout', cookie, body: {} }).then((response) => {
        expect(response.status).toBe(204); incoming.resume();
      }).catch(reject);
    });
    request.once('error', reject);
  });
  expect(transfer.declared).toBeGreaterThan(12 * 1024 * 1024);
  expect(transfer.bytes).toBeLessThan(transfer.declared);
});

it('exports one-file HTML from captured owner bytes on the standard route and refuses foreign, unsafe and historical requests', async () => {
  const id = await project();
  await write(id, 'site/index.html', '<link rel="stylesheet" href="style.css"><img src="assets/logo.png"><h1>Owned export</h1>');
  await write(id, 'site/style.css', 'h1 { color: rgb(1, 2, 3); }');
  await write(id, 'site/assets/logo.png', 'AP8BgA==', 'base64');
  const response = await download(id, a, '/export/html', { fileName: 'site/index.html', title: 'Owned export' });
  expect(response.status, await response.clone().text()).toBe(200);
  expect(response.headers.get('content-security-policy')).toBe('sandbox allow-scripts');
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('content-disposition')).toContain('Owned-export.html');
  const html = await response.text();
  expect(html).toContain('rgb(1, 2, 3)');
  expect(html).toContain('data:image/png;base64,AP8BgA==');
  expect(html).not.toContain(root);

  // A worker-planted link to daemon data is not part of the capture and is never embedded.
  writeFileSync(path.join(root, 'outside-secret.css'), 'body { content: "DAEMON_SECRET"; }');
  symlinkSync(path.join(root, 'outside-secret.css'), path.join(root, 'projects', id, 'site', 'leak.css'));
  await write(id, 'site/leak.html', '<link rel="stylesheet" href="leak.css"><p>leak</p>');
  const leaked = await download(id, a, '/export/html', { fileName: 'site/leak.html' }, true);
  expect(await leaked.text()).not.toContain('DAEMON_SECRET');

  expect((await download(id, b, '/export/html', { fileName: 'site/index.html' })).status).toBe(404);
  expect((await download(id, admin, '/export/html', { fileName: 'site/index.html' })).status).toBe(404);
  const anonymous = await fetch(`${daemon.baseUrl}/api/projects/${id}/export/html`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fileName: 'site/index.html' }) });
  expect(anonymous.status).toBe(401);
  for (const body of [{ fileName: '../escape.html' }, { fileName: 'site/index.html', versionId: 'v1' }, { fileName: 'site/style.css' },
    { fileName: 'site/missing.html' }, {}]) {
    expect((await download(id, a, '/export/html', body)).status).toBeGreaterThanOrEqual(400);
  }
});
