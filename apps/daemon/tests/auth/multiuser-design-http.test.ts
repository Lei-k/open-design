// Issue #39/#40-#45 — the public design flow uses built-in prompt inputs,
// owner-only files, and a cookie-free capability on a dedicated preview host.

import { randomUUID } from 'node:crypto';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupIsolatedDataRoot,
  loadIsolatedServerModule,
  provisionAccounts,
  startMultiUserDaemon,
  type Principal,
  type StartedMultiUserDaemon,
} from './multiuser-harness.js';

let daemon: StartedMultiUserDaemon;
let dataRoot: string;
let alice: Principal;
let bob: Principal;

async function createProject(user: Principal) {
  const id = randomUUID();
  const response = await daemon.request({
    method: 'POST',
    path: '/api/projects',
    cookie: user.cookie,
    body: { id, name: `design-${id}` },
  });
  expect(response.status, response.text).toBe(200);
  return { id, conversationId: response.json.conversationId as string };
}

beforeAll(async () => {
  delete process.env.OD_API_TOKEN;
  delete process.env.OD_DISABLE_API_AUTH;
  ({ dataRoot } = await loadIsolatedServerModule());
  daemon = await startMultiUserDaemon();
  const accounts = await provisionAccounts(daemon, ['design-alice', 'design-bob']);
  [alice, bob] = accounts.users as [Principal, Principal];
}, 120_000);

afterAll(async () => {
  await daemon?.close();
  cleanupIsolatedDataRoot();
});

describe('multi-user design boundary', () => {
  it('publishes only safe built-in metadata and atomically fixes a conversation selection', async () => {
    const project = await createProject(alice);
    const catalog = await daemon.request({ path: '/api/multiuser/design-catalog', cookie: alice.cookie });
    expect(catalog.status, catalog.text).toBe(200);
    expect(catalog.json.skills.length).toBeGreaterThan(0);
    expect(catalog.json.designSystems.length).toBeGreaterThan(0);
    for (const entry of [...catalog.json.skills, ...catalog.json.designSystems]) {
      expect(entry).not.toHaveProperty('body');
      expect(entry).not.toHaveProperty('dir');
      expect(entry).not.toHaveProperty('source');
    }

    const before = await daemon.request({ path: `/api/projects/${project.id}/conversations`, cookie: alice.cookie });
    const invalid = await daemon.request({
      method: 'POST',
      path: `/api/multiuser/projects/${project.id}/conversations`,
      cookie: alice.cookie,
      body: { title: 'invalid', skillId: 'user:private', designSystemId: 'user:private', locale: 'zh-TW' },
    });
    expect(invalid.status).toBe(400);
    const unchanged = await daemon.request({ path: `/api/projects/${project.id}/conversations`, cookie: alice.cookie });
    expect(unchanged.json.conversations).toHaveLength(before.json.conversations.length);

    const skillId = catalog.json.skills[0].id as string;
    const designSystemId = catalog.json.designSystems[0].id as string;
    const created = await daemon.request({
      method: 'POST',
      path: `/api/multiuser/projects/${project.id}/conversations`,
      cookie: alice.cookie,
      body: { title: 'Fixed design', skillId, designSystemId, locale: 'zh-TW' },
    });
    expect(created.status, created.text).toBe(201);
    expect(created.json.design).toMatchObject({ skillId, designSystemId, locale: 'zh-TW' });

    const selectionPath = `/api/multiuser/projects/${project.id}/conversations/${created.json.conversation.id}/design`;
    const selected = await daemon.request({ path: selectionPath, cookie: alice.cookie });
    expect(selected.status).toBe(200);
    expect(selected.json.design).toEqual(created.json.design);
    const hidden = await daemon.request({ path: selectionPath, cookie: bob.cookie });
    expect(hidden.status).toBe(404);
    const selections = await daemon.request({ path: `/api/multiuser/projects/${project.id}/design-selections`, cookie: alice.cookie });
    expect(selections.status).toBe(200);
    expect(selections.json.designs).toEqual([created.json.design]);
    expect(selections.json.designs.some((design: { conversationId: string }) => design.conversationId === project.conversationId)).toBe(false);
  });

  it('keeps file bytes owner-only and refuses traversal and symlink escapes', async () => {
    const project = await createProject(alice);
    const root = path.join(dataRoot, 'projects', project.id);
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'index.html'), '<h1>private preview</h1>');
    const outside = path.join(dataRoot, 'outside-secret.txt');
    writeFileSync(outside, 'outside secret');
    symlinkSync(outside, path.join(root, 'escape.txt'));

    const listed = await daemon.request({ path: `/api/projects/${project.id}/files`, cookie: alice.cookie });
    expect(listed.status, listed.text).toBe(200);
    expect(listed.json.files.some((file: { name: string }) => file.name === 'index.html')).toBe(true);
    expect((await daemon.request({ path: `/api/projects/${project.id}/files`, cookie: bob.cookie })).status).toBe(404);

    const contentPath = `/api/projects/${project.id}/file-content/index.html`;
    const content = await daemon.request({ path: contentPath, cookie: alice.cookie });
    expect(content.status, content.text).toBe(200);
    expect(content.text).toContain('private preview');
    expect(content.headers['content-type']).toContain('application/octet-stream');
    expect(content.headers['content-disposition']).toContain('attachment');
    expect(content.headers['cache-control']).toBe('no-store');
    expect(content.headers['x-content-type-options']).toBe('nosniff');
    expect(content.headers['access-control-allow-origin']).toBeUndefined();
    expect((await daemon.request({ path: contentPath, cookie: bob.cookie })).status).toBe(404);
    expect((await daemon.request({ path: `/api/projects/${project.id}/file-content/..%2Foutside-secret.txt`, cookie: alice.cookie })).status).toBe(404);
    expect((await daemon.request({ path: `/api/projects/${project.id}/file-content/escape.txt`, cookie: alice.cookie })).status).toBe(404);
  });

  it('serves preview bytes only through a session-bound capability on the preview host', async () => {
    const project = await createProject(alice);
    const root = path.join(dataRoot, 'projects', project.id);
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'index.html'), '<script>document.body.dataset.ready="yes"</script>');

    const issued = await daemon.request({
      path: `/api/multiuser/projects/${project.id}/preview-url?file=index.html`,
      cookie: alice.cookie,
    });
    expect(issued.status, issued.text).toBe(200);
    const preview = new URL(issued.json.url as string);
    expect(issued.json.renewUrl).toMatch(/^\/api\/multiuser\/projects\//u);
    expect(preview.protocol).toBe('https:');
    expect(preview.host).not.toBe(new URL(daemon.baseUrl).host);

    // The same capability path is inert on the main origin.
    expect((await daemon.request({ path: `${preview.pathname}${preview.search}`, cookie: alice.cookie })).status).toBe(404);
    const rendered = await daemon.request({ path: preview.pathname, headers: { host: preview.host } });
    expect(rendered.status, rendered.text).toBe(200);
    expect(rendered.text).toContain('dataset.ready');
    expect(rendered.headers['content-security-policy']).toContain('sandbox allow-scripts allow-forms');
    expect(rendered.headers['content-security-policy']).toContain("connect-src 'none'");
    expect(rendered.headers['cache-control']).toBe('no-store');
    expect(rendered.headers['x-content-type-options']).toBe('nosniff');
    expect(rendered.headers['set-cookie']).toBeUndefined();
    // Cookie-free bearer bytes: the Studio's opaque srcDoc frame needs CORS for
    // fonts and relative fetches (#59); credentials are never allowed.
    expect(rendered.headers['access-control-allow-origin']).toBe('*');
    expect(rendered.headers['access-control-allow-credentials']).toBeUndefined();

    const missingRenewalProof = await daemon.request({
      method: 'POST', path: issued.json.renewUrl as string, cookie: alice.cookie, body: {},
    });
    expect(missingRenewalProof.status).toBe(403);
    const renewed = await daemon.request({
      method: 'POST', path: issued.json.renewUrl as string, cookie: alice.cookie,
      headers: { 'preview-scope-renewal': '1' }, body: {},
    });
    expect(renewed.status, renewed.text).toBe(200);
    expect(renewed.json.expiresAt).toBeGreaterThanOrEqual(issued.json.expiresAt);
    expect((await daemon.request({
      method: 'POST', path: issued.json.renewUrl as string, cookie: bob.cookie,
      headers: { 'preview-scope-renewal': '1' }, body: {},
    })).status).toBe(404);
    expect((await daemon.request({
      method: 'POST', path: issued.json.renewUrl as string, cookie: alice.cookie,
      headers: { host: preview.host, 'preview-scope-renewal': '1' }, body: {},
    })).status).toBe(404);

    const tampered = preview.pathname.replace(project.id, randomUUID());
    expect((await daemon.request({ path: tampered, headers: { host: preview.host } })).status).toBe(404);
    expect((await daemon.request({ path: '/api/projects', headers: { host: preview.host } })).status).toBe(404);

    // Revoking the issuing session invalidates an otherwise unexpired URL.
    expect((await daemon.request({ method: 'POST', path: '/api/auth/logout', cookie: alice.cookie, body: {} })).status).toBe(204);
    expect((await daemon.request({ path: preview.pathname, headers: { host: preview.host } })).status).toBe(404);
  });
});
