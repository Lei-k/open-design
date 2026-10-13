import { currentAccountRevision } from './helpers.js';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { cleanupIsolatedDataRoot, loadIsolatedServerModule, multiUserOptions, provisionAccounts,
  startMultiUserDaemon, type Principal, type StartedMultiUserDaemon } from './multiuser-harness.js';

// Deployment-local public links (#66): owner-published captures served from the
// cookie-free preview origin, never from the app origin, never a live file.
const PREVIEW_ORIGIN = 'https://preview.od-mu.test.invalid';
let daemon: StartedMultiUserDaemon;
let root: string; let a: Principal; let b: Principal; let c: Principal; let admin: Principal;
beforeAll(async () => {
  ({ dataRoot: root } = await loadIsolatedServerModule());
  daemon = await startMultiUserDaemon(multiUserOptions());
  const accounts = await provisionAccounts(daemon, ['public-a', 'public-b', 'public-c']);
  [a, b, c] = accounts.users as [Principal, Principal, Principal]; admin = accounts.admin;
}, 120_000);
afterAll(async () => { await daemon?.close(); cleanupIsolatedDataRoot(); });

const previewHost = () => new URL(PREVIEW_ORIGIN).host;
const publicGet = (url: string, host = previewHost()) => {
  const parsed = new URL(url);
  return daemon.request({ path: parsed.pathname, headers: { host } });
};
async function project(user = a) {
  const id = randomUUID();
  expect((await daemon.request({ method: 'POST', path: '/api/projects', cookie: user.cookie, body: { id, name: 'Public' } })).status).toBe(200);
  const write = (name: string, content: string) => daemon.request({ method: 'POST', path: `/api/projects/${id}/files`, cookie: user.cookie, body: { name, content } });
  expect((await write('site/index.html', '<!doctype html><img src="img/logo.svg"><a href="../secret.txt">x</a><link href="style.css" rel="stylesheet">')).status).toBe(200);
  expect((await write('site/img/logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>')).status).toBe(200);
  expect((await write('site/style.css', 'body{color:red}')).status).toBe(200);
  expect((await write('secret.txt', 'PRIVATE_UNREFERENCED')).status).toBe(200);
  return id;
}

it('publishes an immutable capture with only referenced assets, on the preview origin only', async () => {
  const id = await project();
  const file = encodeURIComponent('site/index.html');
  const published = await daemon.request({ method: 'POST', path: `/api/projects/${id}/files/${file}/publish-public`, cookie: a.cookie });
  expect(published.status, published.text).toBe(200);
  const { url, slug, fileName } = published.json;
  expect(fileName).toBe('site/index.html');
  expect(url.startsWith(`${PREVIEW_ORIGIN}/api/multiuser/public/${slug}/index.html`)).toBe(true);
  const page = await publicGet(url);
  expect(page.status).toBe(200);
  expect(page.text).toContain('img/logo.svg');
  expect(page.headers['content-security-policy']).toContain('sandbox');
  expect(page.headers['set-cookie']).toBeUndefined();
  const asset = url.replace(/index\.html$/, 'img/logo.svg');
  expect((await publicGet(asset)).status).toBe(200);
  expect((await publicGet(url.replace(/index\.html$/, 'style.css'))).text).toBe('body{color:red}');
  // Unreferenced files and traversal never leave the project.
  expect((await publicGet(url.replace(/index\.html$/, '../secret.txt'))).status).toBe(404);
  expect((await publicGet(url.replace(/index\.html$/, 'secret.txt'))).status).toBe(404);
  // Not served from the app origin.
  expect((await publicGet(url, new URL(daemon.baseUrl).host)).status).toBe(404);
  // Later edits do not change the published capture.
  await daemon.request({ method: 'POST', path: `/api/projects/${id}/files`, cookie: a.cookie, body: { name: 'site/index.html', content: '<p>EDITED</p>' } });
  expect((await publicGet(url)).text).not.toContain('EDITED');
  const state = await daemon.request({ path: `/api/projects/${id}/files/${file}/publish-public`, cookie: a.cookie });
  expect(state.json.publication).toMatchObject({ slug, fileName: 'site/index.html' });
  const list = await daemon.request({ path: `/api/multiuser/projects/${id}/public-links`, cookie: a.cookie });
  expect(list.json.links).toHaveLength(1);
  // Republishing replaces the link.
  const again = await daemon.request({ method: 'POST', path: `/api/projects/${id}/files/${file}/publish-public`, cookie: a.cookie });
  expect(again.json.slug).not.toBe(slug);
  expect((await publicGet(url)).status).toBe(404);
  expect((await publicGet(again.json.url)).text).toContain('EDITED');
  const revoked = await daemon.request({ method: 'DELETE', path: `/api/projects/${id}/files/${file}/publish-public`, cookie: a.cookie, body: { slug: again.json.slug } });
  expect(revoked.status).toBe(200);
  expect((await publicGet(again.json.url)).status).toBe(404);
});

it('is owner-only, refuses symlinks, and stops serving when the project or account goes away', async () => {
  const id = await project();
  const file = encodeURIComponent('site/index.html');
  for (const user of [b, admin]) {
    expect((await daemon.request({ method: 'POST', path: `/api/projects/${id}/files/${file}/publish-public`, cookie: user.cookie })).status).toBe(404);
  }
  // A grantee with edit rights still cannot publish publicly.
  expect((await daemon.request({ method: 'PUT', path: `/api/multiuser/projects/${id}/shares`, cookie: a.cookie, body: { username: b.username, role: 'edit' } })).status).toBe(200);
  expect((await daemon.request({ method: 'POST', path: `/api/projects/${id}/files/${file}/publish-public`, cookie: b.cookie })).status).toBe(404);
  const published = await daemon.request({ method: 'POST', path: `/api/projects/${id}/files/${file}/publish-public`, cookie: a.cookie });
  expect((await publicGet(published.json.url)).status).toBe(200);
  // A planted symlink makes the capture refuse instead of following it. Only
  // what the page references is read (#119), so the page references it.
  const other = await project();
  symlinkSync(path.join(root, 'app.sqlite'), path.join(root, 'projects', other, 'site', 'img', 'leak.svg'));
  expect((await daemon.request({ method: 'POST', path: `/api/projects/${other}/files`, cookie: a.cookie,
    body: { name: 'site/index.html', content: '<img src="img/logo.svg"><img src="img/leak.svg">' } })).status).toBe(200);
  const planted = await daemon.request({ method: 'POST', path: `/api/projects/${other}/files/${file}/publish-public`, cookie: a.cookie });
  expect(planted.status).toBe(409);
  expect(planted.json.error).toMatchObject({ code: 'PUBLIC_LINK_FILE_REFUSED', data: { path: 'site/img/leak.svg', reason: 'symlink' } });
  expect(planted.text).not.toContain(root);
  expect((await daemon.request({ path: `/api/multiuser/projects/${other}/public-links`, cookie: a.cookie })).json.links).toEqual([]);
  expect((await publicGet(`${PREVIEW_ORIGIN}/api/multiuser/public/${'x'.repeat(32)}/index.html`)).status).toBe(404);
  expect((await daemon.request({ method: 'PATCH', path: `/api/auth/users/${a.id}`, cookie: admin.cookie, body: { revision: await currentAccountRevision(daemon.request, a.id, admin.cookie),  active: false } })).status).toBeLessThan(300);
  expect((await publicGet(published.json.url)).status).toBe(404);
  expect((await daemon.request({ method: 'PATCH', path: `/api/auth/users/${a.id}`, cookie: admin.cookie, body: { revision: await currentAccountRevision(daemon.request, a.id, admin.cookie),  active: true } })).status).toBeLessThan(300);
  expect((await publicGet(published.json.url)).status).toBe(200);
});

// #119: publishing reads only the entry and the assets it references, so an
// unsafe or oversized file elsewhere in the project cannot block it — and is
// still never published.
const MIB = 1024 * 1024;
const onDisk = (id: string, name: string) => path.join(root, 'projects', id, ...name.split('/'));
const plant = (id: string, name: string, bytes: string | Buffer) => {
  mkdirSync(path.dirname(onDisk(id, name)), { recursive: true });
  writeFileSync(onDisk(id, name), bytes);
};
const publish = (id: string, name: string, user = c) =>
  daemon.request({ method: 'POST', path: `/api/projects/${id}/files/${encodeURIComponent(name)}/publish-public`, cookie: user.cookie });
const expectRefused = (response: Awaited<ReturnType<typeof publish>>, status: number, refusedPath: string, reason: string) => {
  expect(response.status, response.text).toBe(status);
  expect(response.json.error).toMatchObject({ code: 'PUBLIC_LINK_FILE_REFUSED', data: { path: refusedPath, reason } });
  // Never a host path: neither the data root nor the projects directory.
  expect(response.text).not.toContain(root);
  expect(response.text).not.toContain(path.join(root, 'projects'));
};

it('ignores unsafe and oversized files the page does not reference, and never serves them', async () => {
  const id = await project(c);
  symlinkSync(path.join(root, 'app.sqlite'), path.join(root, 'projects', id, 'site', 'img', 'leak.svg'));
  mkdirSync(onDisk(id, 'venv/bin'), { recursive: true });
  symlinkSync('/usr/bin/env', onDisk(id, 'venv/bin/python'));
  symlinkSync(path.join(root, 'projects'), onDisk(id, 'site/linked-dir'));
  plant(id, 'notes/draft.txt', 'DRAFT');
  linkSync(onDisk(id, 'notes/draft.txt'), onDisk(id, 'notes/draft-hardlink.txt'));
  plant(id, 'recordings/session.webm', Buffer.alloc(26 * MIB, 1));
  const published = await publish(id, 'site/index.html');
  expect(published.status, published.text).toBe(200);
  const { url } = published.json;
  expect((await publicGet(url)).status).toBe(200);
  expect((await publicGet(url.replace(/index\.html$/, 'img/logo.svg'))).status).toBe(200);
  for (const unreachable of ['img/leak.svg', 'linked-dir/x', '../notes/draft.txt', '../notes/draft-hardlink.txt', '../secret.txt', '../recordings/session.webm', '../venv/bin/python']) {
    expect((await publicGet(url.replace(/index\.html$/, unreachable))).status, unreachable).toBe(404);
  }
});

it('refuses an unsafe or oversized entry with the file and the reason', async () => {
  const id = await project(c);
  symlinkSync(path.join(root, 'app.sqlite'), onDisk(id, 'site/evil.html'));
  expectRefused(await publish(id, 'site/evil.html'), 409, 'site/evil.html', 'symlink');
  // A symlinked directory on the way to the entry is refused, never followed.
  const target = await project(c);
  symlinkSync(path.join(root, 'projects', target, 'site'), onDisk(id, 'site/linked'));
  expectRefused(await publish(id, 'site/linked/index.html'), 409, 'site/linked', 'symlink');
  plant(id, 'site/huge.html', Buffer.alloc(25 * MIB + 1, 0x20));
  expectRefused(await publish(id, 'site/huge.html'), 413, 'site/huge.html', 'too_large');
  linkSync(onDisk(id, 'site/style.css'), onDisk(id, 'site/twin.css'));
  expectRefused(await publish(id, 'site/twin.css'), 409, 'site/twin.css', 'hard_link');
  // A FIFO is refused from its metadata; opening it could block the daemon.
  execFileSync('mkfifo', [onDisk(id, 'site/pipe.html')]);
  expectRefused(await publish(id, 'site/pipe.html'), 409, 'site/pipe.html', 'not_regular');
  // Missing entries keep their existing answer.
  expect((await publish(id, 'site/missing.html')).json.error.code).toBe('FILE_NOT_FOUND');
  expect((await daemon.request({ path: `/api/multiuser/projects/${id}/public-links`, cookie: c.cookie })).json.links).toEqual([]);
});

it('refuses a referenced asset that is unsafe or too large, and still skips outside and reserved references', async () => {
  const id = await project(c);
  const page = (html: string) => daemon.request({ method: 'POST', path: `/api/projects/${id}/files`, cookie: c.cookie, body: { name: 'site/index.html', content: html } });
  linkSync(onDisk(id, 'site/style.css'), onDisk(id, 'site/twin.css'));
  expect((await page('<link href="style.css" rel="stylesheet">')).status).toBe(200);
  expectRefused(await publish(id, 'site/index.html'), 409, 'site/style.css', 'hard_link');
  plant(id, 'site/big.png', Buffer.alloc(25 * MIB + 1, 2));
  expect((await page('<img src="big.png">')).status).toBe(200);
  expectRefused(await publish(id, 'site/index.html'), 413, 'site/big.png', 'too_large');
  plant(id, 'site/a.png', Buffer.alloc(17 * MIB, 3));
  plant(id, 'site/b.png', Buffer.alloc(17 * MIB, 4));
  expect((await page('<img src="a.png"><img src="b.png">')).status).toBe(200);
  expectRefused(await publish(id, 'site/index.html'), 413, 'site/b.png', 'bundle_too_large');
  // References outside the project, to reserved/hidden paths or to nothing
  // never block publishing and are never published.
  plant(id, 'outside.txt', 'OUTSIDE');
  plant(id, 'site/node_modules/lib.js', 'DEPENDENCY');
  plant(id, 'site/.hidden.css', 'HIDDEN');
  plant(id, 'site/page.artifact.json', '{}');
  expect((await page('<img src="img/logo.svg"><a href="../outside.txt">o</a><a href="../../../app.sqlite">d</a><script src="node_modules/lib.js"></script>'
    + '<link href=".hidden.css"><a href="page.artifact.json">m</a><img src="gone.png">')).status).toBe(200);
  const published = await publish(id, 'site/index.html');
  expect(published.status, published.text).toBe(200);
  const { url } = published.json;
  expect((await publicGet(url.replace(/index\.html$/, 'img/logo.svg'))).status).toBe(200);
  for (const unreachable of ['../outside.txt', 'node_modules/lib.js', '.hidden.css', 'page.artifact.json', 'a.png', 'twin.css']) {
    expect((await publicGet(url.replace(/index\.html$/, unreachable))).status, unreachable).toBe(404);
  }
});
