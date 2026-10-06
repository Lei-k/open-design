import { mkdirSync, writeFileSync, symlinkSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { cleanupIsolatedDataRoot, loadIsolatedServerModule, startMultiUserDaemon, type StartedMultiUserDaemon } from './multiuser-harness.js';
let daemon: StartedMultiUserDaemon;
let staticRoot: string;
beforeAll(async () => {
  const { dataRoot } = await loadIsolatedServerModule();
  const root = path.join(dataRoot, 'static');
  staticRoot = root;
  for (const dir of ['_next/static/chunks', 'api/projects', 'artifacts', 'fonts']) mkdirSync(path.join(root, dir), { recursive: true });
  writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>Public shell</title>');
  writeFileSync(path.join(root, '_next/static/chunks/app.js'), '/* public build */');
  writeFileSync(path.join(root, 'fonts/AlbertSans-VariableFont_wght.ttf'), 'font');
  for (const file of ['api/projects/index.html', 'artifacts/private.html', 'secret.txt', '_next/static/chunks/private.map']) writeFileSync(path.join(root, file), 'PRIVATE');
  writeFileSync(path.join(dataRoot, 'private.js'), 'PRIVATE');
  symlinkSync(path.join(dataRoot, 'private.js'), path.join(root, '_next/static/chunks/escape.js'));
  symlinkSync(path.join(dataRoot), path.join(root, '_next/static/escape'));
  daemon = await startMultiUserDaemon(undefined, root);
}, 120_000);
afterAll(async () => { await daemon?.close(); cleanupIsolatedDataRoot(); });
it('serves only explicit public shell paths and required assets without a session', async () => {
  for (const url of ['/', '/login', '/setup', '/projects', '/admin/users', '/admin/audit', '/account/agents', '/projects/p-1', '/projects/p-1/conversations/c-1', '/settings', '/design-systems/user%3Abrand', '/projects/p-1/files/hello%20world.html', '/design-systems', '/projects/p-1/files/index.html', '/projects/p-1/conversations/c-1/files/index.html', '/_next/static/chunks/app.js', '/fonts/AlbertSans-VariableFont_wght.ttf']) {
    const get = await daemon.request({ path: url });
    expect(get.status, url).toBe(200);
    expect(get.headers['x-content-type-options']).toBe('nosniff');
    expect(get.headers['x-frame-options']).toBe('DENY');
    expect((await daemon.request({ path: url, method: 'HEAD' })).status, url).toBe(200);
  }
});
it('never serves planted API files, private files, maps, symlinks, traversal or unsupported methods', async () => {
  for (const url of ['/api/projects', '/API/projects', '/api/missing', '/artifacts/private.html', '/frames/x', '/api/plugin-previews/x', '/secret.txt', '/unknown', '/_next/static/chunks/private.map', '/_next/static/chunks/escape.js', '/_next/static/escape/private.js', '/_next/static/../index.html', '/_next/static/%2e%2e/index.html', '/_next/static/chunks%2fescape.js', '/_next/static/%252e%252e/private.js', '/_next/static/%ZZ', '//setup', '/%73etup', '/projects/p-1/extra', '/projects/p-1/conversations/c-1/extra', '/projects/%70-1', '/projects/p%2f1', '/projects/..', '/projects/%2e%2e', '/projects/p-1/conversations/%252e%252e', '/account/agents/extra', '/projects/p-1/files/%2Fsecret', '/projects/p-1/files/a%5Cb', '/projects/p-1/files/%2e%2e/secret', '/projects/p-1/files/../secret', '/projects/p-1/files/%252Fsecret', '/projects/p-1/files/hello%20world.html/..']) {
    const res = await daemon.request({ path: url });
    expect(res.status, url).toBeGreaterThanOrEqual(400);
    expect(res.text, url).not.toContain('PRIVATE');
    expect(res.text, url).not.toContain('Public shell');
  }
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) expect((await daemon.request({ path: '/setup', method })).status).toBeGreaterThanOrEqual(400);
});
it('keeps each added shell route in the startup inventory', () => {
  for (const route of ['/account/agents', '/projects/:projectId', '/projects/:projectId/conversations/:conversationId']) {
    expect(daemon.routeInventory).toContainEqual({ method: 'GET', path: route });
  }
});

it('refuses a symlinked shell on every new deep link and keeps unknown/API denials JSON', async () => {
  const index = path.join(staticRoot, 'index.html');
  const original = path.join(staticRoot, 'original.html');
  renameSync(index, original);
  symlinkSync(original, index);
  try {
    for (const url of ['/account/agents', '/projects/p-1', '/projects/p-1/conversations/c-1']) {
      const response = await daemon.request({ path: url });
      expect(response.status).toBe(404);
      expect(response.text).not.toContain('Public shell');
    }
  } finally { unlinkSync(index); renameSync(original, index); }
  for (const url of ['/api', '/api/missing', '/unknown', '/projects/p-1/extra']) {
    const response = await daemon.request({ path: url });
    expect(response.status).toBe(401);
    expect(response.headers['content-type']).toContain('application/json');
  }
});
