import { randomUUID } from 'node:crypto';
import { symlinkSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { cleanupIsolatedDataRoot, loadIsolatedServerModule, multiUserOptions, provisionAccounts,
  startMultiUserDaemon, type Principal, type StartedMultiUserDaemon } from './multiuser-harness.js';

// Deployment-local public links (#66): owner-published captures served from the
// cookie-free preview origin, never from the app origin, never a live file.
const PREVIEW_ORIGIN = 'https://preview.od-mu.test.invalid';
let daemon: StartedMultiUserDaemon;
let root: string; let a: Principal; let b: Principal; let admin: Principal;
beforeAll(async () => {
  ({ dataRoot: root } = await loadIsolatedServerModule());
  daemon = await startMultiUserDaemon(multiUserOptions());
  const accounts = await provisionAccounts(daemon, ['public-a', 'public-b']);
  [a, b] = accounts.users as [Principal, Principal]; admin = accounts.admin;
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
  // A planted symlink makes the capture refuse instead of following it.
  const other = await project();
  symlinkSync(path.join(root, 'app.sqlite'), path.join(root, 'projects', other, 'site', 'img', 'leak.svg'));
  expect((await daemon.request({ method: 'POST', path: `/api/projects/${other}/files/${file}/publish-public`, cookie: a.cookie })).status).toBe(409);
  expect((await publicGet(`${PREVIEW_ORIGIN}/api/multiuser/public/${'x'.repeat(32)}/index.html`)).status).toBe(404);
  expect((await daemon.request({ method: 'PATCH', path: `/api/auth/users/${a.id}`, cookie: admin.cookie, body: { active: false } })).status).toBeLessThan(300);
  expect((await publicGet(published.json.url)).status).toBe(404);
  expect((await daemon.request({ method: 'PATCH', path: `/api/auth/users/${a.id}`, cookie: admin.cookie, body: { active: true } })).status).toBeLessThan(300);
  expect((await publicGet(published.json.url)).status).toBe(200);
});
