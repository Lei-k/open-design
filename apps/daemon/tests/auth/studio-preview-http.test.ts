import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { cleanupIsolatedDataRoot, loadIsolatedServerModule, provisionAccounts,
  startMultiUserDaemon, type Principal, type StartedMultiUserDaemon } from './multiuser-harness.js';

// S6 (#59): the standard preview URL a shared Studio viewer asks for mints the
// owner/session-bound capability on the dedicated preview origin.
let daemon: StartedMultiUserDaemon;
let a: Principal;
let b: Principal;

async function project(user = a) {
  const id = randomUUID();
  expect((await daemon.request({ method: 'POST', path: '/api/projects', cookie: user.cookie, body: { id, name: id } })).status).toBe(200);
  for (const [name, content] of [['site/index.html', '<link rel="stylesheet" href="style.css"><h1>A-PREVIEW</h1>'], ['site/style.css', 'h1{color:red}']]) {
    expect((await daemon.request({ method: 'POST', path: `/api/projects/${id}/files`, cookie: user.cookie, body: { name, content } })).status).toBe(200);
  }
  return id;
}
const previewUrl = (projectId: string, user: Principal, file = 'site/index.html') =>
  daemon.request({ path: `/api/projects/${projectId}/preview-url?file=${encodeURIComponent(file)}`, cookie: user.cookie });

beforeAll(async () => {
  await loadIsolatedServerModule();
  daemon = await startMultiUserDaemon();
  const accounts = await provisionAccounts(daemon, ['preview-a', 'preview-b']);
  [a, b] = accounts.users as [Principal, Principal];
}, 120_000);
afterAll(async () => { await daemon?.close(); cleanupIsolatedDataRoot(); });

it('answers the standard preview URL with a capability on the preview origin, never the app origin', async () => {
  const projectId = await project();
  const issued = await previewUrl(projectId, a);
  expect(issued.status, issued.text).toBe(200);
  expect(issued.json).toMatchObject({ file: 'site/index.html', opaqueOrigin: true, iframeSandbox: 'allow-scripts allow-forms' });
  expect(issued.json.csp).toContain("connect-src 'none'");
  const url = new URL(issued.json.url as string);
  expect(url.protocol).toBe('https:');
  expect(url.host).not.toBe(new URL(daemon.baseUrl).host);
  expect(url.pathname).toMatch(new RegExp(`^/api/multiuser/projects/${projectId}/preview/[A-Za-z0-9_-]{32,}/site/index\\.html$`));
  // The directory is the srcDoc base: sibling assets resolve through the same capability.
  const asset = await daemon.request({ path: url.pathname.replace(/index\.html$/u, 'style.css'), headers: { host: url.host, origin: 'null' } });
  expect(asset.status).toBe(200);
  expect(asset.text).toContain('color:red');
  expect(asset.headers['access-control-allow-origin']).toBe('*');
  expect(asset.headers['set-cookie']).toBeUndefined();
  // Renewal is host-only, owner- and session-bound.
  const renew = (user: Principal, headers: Record<string, string>) => daemon.request({ method: 'POST', path: issued.json.renewUrl as string,
    cookie: user.cookie, headers, body: {} });
  expect((await renew(a, { 'preview-scope-renewal': '1', 'x-od-preview-scope-renewal': '1' })).status).toBe(200);
  expect((await renew(a, {})).status).toBe(403);
  expect((await renew(b, { 'preview-scope-renewal': '1' })).status).toBe(404);
});

it('hides foreign and missing projects identically and keeps both hosts separate', async () => {
  const projectId = await project(a);
  const foreign = await previewUrl(projectId, b);
  const missing = await previewUrl(randomUUID(), b);
  expect(foreign.status).toBe(404);
  expect(foreign.json).toEqual(missing.json);
  expect(foreign.text).not.toContain('preview/');
  const issued = await previewUrl(projectId, a);
  const url = new URL(issued.json.url as string);
  // Capability bytes are inert on the app host; the app API is inert on the preview host.
  expect((await daemon.request({ path: url.pathname, cookie: a.cookie })).status).toBe(404);
  expect((await daemon.request({ path: `/api/projects/${projectId}/preview-url?file=site/index.html`, headers: { host: url.host }, cookie: a.cookie })).status).toBe(404);
  expect((await previewUrl(projectId, a, 'site/missing.html')).status).toBe(404);
  expect((await previewUrl(projectId, a, '../../etc/passwd')).status).toBe(404);
});

it('revokes outstanding capabilities with the issuing session', async () => {
  const projectId = await project(b);
  const issued = await previewUrl(projectId, b);
  const url = new URL(issued.json.url as string);
  expect((await daemon.request({ path: url.pathname, headers: { host: url.host } })).status).toBe(200);
  expect((await daemon.request({ method: 'POST', path: '/api/auth/logout', cookie: b.cookie, body: {} })).status).toBe(204);
  expect((await daemon.request({ path: url.pathname, headers: { host: url.host } })).status).toBe(404);
});
