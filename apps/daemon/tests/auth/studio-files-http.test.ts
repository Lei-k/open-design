import { randomUUID } from 'node:crypto';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { cleanupIsolatedDataRoot, loadIsolatedServerModule, multiUserOptions, provisionAccounts,
  startMultiUserDaemon, type Principal, type StartedMultiUserDaemon } from './multiuser-harness.js';
import { PERSONAL_CODEX_MOCK, linkCodex } from './personal-codex-helpers.js';

// S5 (#58): the owner's project files through the standard file APIs.
let daemon: StartedMultiUserDaemon;
let root: string;
let a: Principal;
let b: Principal;
const enc = encodeURIComponent;

async function project(user = a) {
  const id = randomUUID();
  const made = await daemon.request({ method: 'POST', path: '/api/projects', cookie: user.cookie, body: { id, name: id } });
  expect(made.status).toBe(200);
  return { projectId: id, conversationId: made.json.conversationId as string };
}
const write = (projectId: string, name: string, content: string, user = a, extra: Record<string, unknown> = {}) =>
  daemon.request({ method: 'POST', path: `/api/projects/${projectId}/files`, cookie: user.cookie, body: { name, content, ...extra } });
function multipart(files: Array<{ name: string; body: string }>) {
  const boundary = `----od${randomUUID()}`;
  const parts = files.map((file) => `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n${file.body}\r\n`);
  return { body: Buffer.from(`${parts.join('')}--${boundary}--\r\n`), type: `multipart/form-data; boundary=${boundary}` };
}

beforeAll(async () => {
  ({ dataRoot: root } = await loadIsolatedServerModule());
  daemon = await startMultiUserDaemon(multiUserOptions({ testPersonalCodexAppServer: PERSONAL_CODEX_MOCK }));
  const accounts = await provisionAccounts(daemon, ['files-a', 'files-b']);
  [a, b] = accounts.users as [Principal, Principal];
  await linkCodex(daemon, root, a, 'files-a@example.test');
}, 120_000);
afterAll(async () => { await daemon?.close(); cleanupIsolatedDataRoot(); });

it('lets the owner write, read, rename, search, version and delete files', async () => {
  const { projectId } = await project();
  expect((await write(projectId, 'notes/hello.txt', 'hello world')).status).toBe(200);
  expect((await write(projectId, 'page.html', '<h1>v1</h1><script>alert(1)</script>')).status).toBe(200);
  const list = await daemon.request({ path: `/api/projects/${projectId}/files`, cookie: a.cookie });
  expect(list.json.files.map((file: { name: string }) => file.name)).toEqual(expect.arrayContaining(['notes/hello.txt', 'page.html']));
  expect((await daemon.request({ path: `/api/projects/${projectId}/files/notes/hello.txt`, cookie: a.cookie })).text).toBe('hello world');
  expect((await daemon.request({ path: `/api/projects/${projectId}/text-preview/notes/hello.txt`, cookie: a.cookie })).status).toBe(200);
  const search = await daemon.request({ path: `/api/projects/${projectId}/search?q=hello`, cookie: a.cookie });
  expect(search.status).toBe(200);
  expect(JSON.stringify(search.json)).toContain('notes/hello.txt');
  expect((await daemon.request({ method: 'POST', path: `/api/projects/${projectId}/folders`, cookie: a.cookie, body: { name: 'assets' } })).status).toBeLessThan(300);
  expect((await daemon.request({ path: `/api/projects/${projectId}/folders`, cookie: a.cookie })).text).toContain('assets');
  const renamed = await daemon.request({ method: 'POST', path: `/api/projects/${projectId}/files/rename`, cookie: a.cookie, body: { from: 'notes/hello.txt', to: 'notes/hi.txt' } });
  expect(renamed.status).toBe(200);
  expect((await daemon.request({ path: `/api/projects/${projectId}/files/notes/hi.txt`, cookie: a.cookie })).text).toBe('hello world');
  // Versions: capture, change, list, restore.
  expect((await daemon.request({ method: 'POST', path: `/api/projects/${projectId}/files/page.html/versions`, cookie: a.cookie, body: { label: 'first' } })).status).toBeLessThan(300);
  expect((await write(projectId, 'page.html', '<h1>v2</h1>')).status).toBe(200);
  const versions = await daemon.request({ path: `/api/projects/${projectId}/files/page.html/versions`, cookie: a.cookie });
  expect(versions.status).toBe(200);
  const first = (versions.json.versions as Array<{ id: string; label?: string | null }>).find((version) => version.label === 'first');
  expect(first).toBeTruthy();
  const restored = await daemon.request({ method: 'POST', path: `/api/projects/${projectId}/files/page.html/versions/${first!.id}/restore`, cookie: a.cookie });
  expect(restored.status).toBeLessThan(300);
  expect((await daemon.request({ path: `/api/projects/${projectId}/raw/page.html`, cookie: a.cookie })).text).toContain('v1');
  expect((await daemon.request({ method: 'DELETE', path: `/api/projects/${projectId}/files/${enc('notes/hi.txt')}`, cookie: a.cookie })).status).toBeLessThan(300);
  expect((await daemon.request({ method: 'DELETE', path: `/api/projects/${projectId}/raw/page.html`, cookie: a.cookie })).status).toBeLessThan(300);
  expect((await daemon.request({ method: 'DELETE', path: `/api/projects/${projectId}/folders`, cookie: a.cookie, body: { path: 'assets' } })).status).toBeLessThan(300);
  const after = await daemon.request({ path: `/api/projects/${projectId}/files`, cookie: a.cookie });
  expect(after.json.files.map((file: { name: string }) => file.name)).not.toEqual(expect.arrayContaining(['page.html']));
});

it('serves file bytes on the app origin only under the untrusted-content policy', async () => {
  const { projectId } = await project();
  await write(projectId, 'evil.html', '<script>fetch("/api/auth/me")</script>');
  await write(projectId, 'evil.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  for (const url of [`/api/projects/${projectId}/raw/evil.html`, `/api/projects/${projectId}/files/evil.svg`, `/api/projects/${projectId}/raw/evil.svg`]) {
    // Sandboxed (`null`-origin) frames are what the raw handler would otherwise open CORS for.
    const res = await daemon.request({ path: url, cookie: a.cookie, ...(url.includes('/raw/') ? { headers: { origin: 'null' } } : {}) });
    expect(res.status, url).toBe(200);
    expect(res.headers['content-security-policy'], url).toMatch(/^sandbox;/);
    expect(res.headers['x-content-type-options'], url).toBe('nosniff');
    expect(res.headers['access-control-allow-origin'], url).toBeUndefined();
  }
});

it('hides every file route of a foreign project exactly like a missing one', async () => {
  const { projectId } = await project(a);
  await write(projectId, 'secret.txt', 'A-PRIVATE-4242');
  await write(projectId, 'page.html', '<p>A</p>');
  const missing = randomUUID();
  const probes: Array<[string, string, unknown?]> = [
    ['GET', '/files'], ['GET', '/files/secret.txt'], ['GET', '/raw/secret.txt'], ['GET', '/text-preview/secret.txt'],
    ['GET', '/search?q=A'], ['GET', '/folders'], ['GET', '/files/page.html/versions'],
    ['POST', '/files', { name: 'x.txt', content: 'B' }], ['POST', '/files/rename', { from: 'secret.txt', to: 'b.txt' }],
    ['POST', '/folders', { name: 'b' }], ['DELETE', '/folders', { path: 'b' }], ['DELETE', '/files/secret.txt'], ['DELETE', '/raw/secret.txt'],
    ['POST', '/files/page.html/versions', {}],
  ];
  for (const [method, suffix, body] of probes) {
    const foreign = await daemon.request({ method, path: `/api/projects/${projectId}${suffix}`, cookie: b.cookie, ...(body === undefined ? {} : { body }) });
    const absent = await daemon.request({ method, path: `/api/projects/${missing}${suffix}`, cookie: b.cookie, ...(body === undefined ? {} : { body }) });
    expect([method, suffix, foreign.status]).toEqual([method, suffix, 404]);
    expect(foreign.json).toEqual(absent.json);
    expect(foreign.text).not.toContain('A-PRIVATE-4242');
  }
  const upload = multipart([{ name: 'b.txt', body: 'B' }]);
  const foreignUpload = await daemon.request({ method: 'POST', path: `/api/projects/${projectId}/upload`, cookie: b.cookie, rawBody: upload.body, headers: { 'content-type': upload.type } });
  expect(foreignUpload.status).toBe(404);
  const list = await daemon.request({ path: `/api/projects/${projectId}/files`, cookie: a.cookie });
  expect(list.json.files.map((file: { name: string }) => file.name).sort()).toEqual(['page.html', 'secret.txt']);
  expect((await daemon.request({ path: `/api/projects/${projectId}/files/secret.txt`, cookie: a.cookie })).text).toBe('A-PRIVATE-4242');
});

it('bounds uploads and refuses artifact manifests, traversal and symlink escapes', async () => {
  const { projectId } = await project();
  const ok = multipart([{ name: 'one.txt', body: '1' }, { name: 'two.png', body: 'png' }]);
  const uploaded = await daemon.request({ method: 'POST', path: `/api/projects/${projectId}/upload`, cookie: a.cookie, rawBody: ok.body, headers: { 'content-type': ok.type } });
  expect(uploaded.status).toBe(200);
  expect(uploaded.json.files.map((file: { path: string }) => file.path).sort()).toEqual(['one.txt', 'two.png']);
  // Declared-but-unsent bodies: the gate answers from the headers alone, before reading anything.
  const declared = async (headers: Record<string, string>) => new Promise<number>((resolve, reject) => {
    const url = new URL(daemon.baseUrl);
    const req = http.request({ host: url.hostname, port: Number(url.port), method: 'POST', path: `/api/projects/${projectId}/upload`,
      headers: { cookie: a.cookie, 'content-type': ok.type, ...headers } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); req.destroy(); });
    req.on('error', reject);
    req.flushHeaders();
  });
  expect(await declared({ 'content-length': String(65 * 1024 * 1024) })).toBe(413);
  expect(await declared({ 'transfer-encoding': 'chunked' })).toBe(413);
  const jsonUpload = await daemon.request({ method: 'POST', path: `/api/projects/${projectId}/upload`, cookie: a.cookie, body: { files: [] } });
  expect(jsonUpload.status).toBe(400);
  // Manifests are validated by the handler; server-side artifact creation stays unavailable.
  expect((await write(projectId, 'a.html', '<p/>', a, { artifactManifest: 'not-an-object' })).status).toBe(400);
  expect((await write(projectId, 'a.html', '<p/>', a, { artifactManifest: { kind: 'nope' } })).status).toBe(400);
  expect((await write(projectId, 'a.html', '<p/>', a, { artifact: true })).status).toBe(400);
  const outside = path.join(root, 'outside-secret.txt');
  writeFileSync(outside, 'HOST-SECRET-9999');
  const dir = path.join(root, 'projects', projectId);
  mkdirSync(dir, { recursive: true });
  symlinkSync(outside, path.join(dir, 'link.txt'));
  for (const url of [`/api/projects/${projectId}/raw/link.txt`, `/api/projects/${projectId}/files/link.txt`,
    `/api/projects/${projectId}/raw/..%2F..%2Foutside-secret.txt`, `/api/projects/${projectId}/raw/%2e%2e/%2e%2e/outside-secret.txt`,
    `/api/projects/${projectId}/text-preview/link.txt`]) {
    const res = await daemon.request({ path: url, cookie: a.cookie });
    expect(res.status, url).toBeGreaterThanOrEqual(400);
    expect(res.text, url).not.toContain('HOST-SECRET-9999');
  }
  const escapeWrite = await write(projectId, '../escape.txt', 'x');
  expect(escapeWrite.status).toBeGreaterThanOrEqual(400);
});

it('hands owned attachments to the personal run and shows them on the user turn', async () => {
  const target = await project();
  await write(target.projectId, 'brief.md', '# brief');
  const refused = await daemon.request({ method: 'POST', path: '/api/runs', cookie: a.cookie, body: {
    ...target, agentId: 'codex', executionSource: 'personal_subscription', message: 'x', attachments: ['../other/secret.txt'] } });
  expect(refused.status).toBe(400);
  const made = await daemon.request({ method: 'POST', path: '/api/runs', cookie: a.cookie, body: {
    ...target, agentId: 'codex', executionSource: 'personal_subscription', message: 'read the brief', attachments: ['brief.md', 'missing.md'] } });
  expect(made.status).toBe(202);
  await daemon.request({ path: `/api/runs/${made.json.runId}/events`, cookie: a.cookie });
  const run = await daemon.request({ path: `/api/runs/${made.json.runId}`, cookie: a.cookie });
  const reply = JSON.parse(run.json.output.text) as { message: string };
  expect(reply.message).toContain('Attached project files in user-visible order:');
  expect(reply.message).toContain('`brief.md`');
  expect(reply.message).not.toContain('missing.md');
  const messages = (await daemon.request({ path: `/api/projects/${target.projectId}/conversations/${target.conversationId}/messages`, cookie: a.cookie })).json.messages;
  expect(messages[0]).toMatchObject({ role: 'user', content: 'read the brief',
    attachments: [{ path: 'brief.md', name: 'brief.md', kind: 'file', order: 0 }, { path: 'missing.md', name: 'missing.md', kind: 'file', order: 1 }] });
});

it('narrows run context to the owner\'s project files and refuses host-side contexts', async () => {
  const target = await project();
  await write(target.projectId, 'page.html', '<p>focus</p>');
  const start = (context: unknown) => daemon.request({ method: 'POST', path: '/api/runs', cookie: a.cookie, body: {
    ...target, agentId: 'codex', executionSource: 'personal_subscription', message: `ctx ${randomUUID()}`, context } });
  for (const context of [{ workspaceItems: [{ id: 'x', kind: 'local-code', label: 'x', absolutePath: '/etc' }] },
    { workspaceItems: [{ id: 'x', kind: 'file', label: 'x', path: 'page.html', absolutePath: '/etc/passwd' }] },
    { workspaceItems: [{ id: 'x', kind: 'browser', label: 'x', url: 'http://169.254.169.254/' }] }, { skillIds: ['s'] }]) {
    const refused = await start(context);
    expect(refused.status).toBe(403);
    expect(refused.json.error.code).toBe('MULTIUSER_CAPABILITY_UNAVAILABLE');
  }
  expect((await start({ workspaceItems: [{ id: 'x', kind: 'file', label: 'x', path: '../secret' }] })).status).toBe(400);
  const made = await start({ skillIds: [], workspaceItems: [{ id: 'tab:page.html', kind: 'file', label: 'page.html', path: 'page.html' }] });
  expect(made.status).toBe(202);
  await daemon.request({ path: `/api/runs/${made.json.runId}/events`, cookie: a.cookie });
  const reply = JSON.parse((await daemon.request({ path: `/api/runs/${made.json.runId}`, cookie: a.cookie })).json.output.text) as { message: string };
  expect(reply.message).toContain('### Active workspace context');
  expect(reply.message).toContain('page.html');
});

it('never reveals daemon filesystem paths through project or file responses', async () => {
  const { projectId, conversationId } = await project();
  await write(projectId, 'dir/a.txt', 'a');
  await write(projectId, 'dir/p.html', '<p>a</p>');
  const upload = multipart([{ name: 'b.txt', body: 'b' }]);
  const responses = [
    await daemon.request({ path: `/api/projects/${projectId}`, cookie: a.cookie }),
    await daemon.request({ path: `/api/projects/${projectId}?ensureDir=1`, cookie: a.cookie }),
    await daemon.request({ path: '/api/projects', cookie: a.cookie }),
    await daemon.request({ path: `/api/projects/${projectId}/files`, cookie: a.cookie }),
    await daemon.request({ path: `/api/projects/${projectId}/folders`, cookie: a.cookie }),
    await daemon.request({ path: `/api/projects/${projectId}/search?q=a`, cookie: a.cookie }),
    await daemon.request({ path: `/api/projects/${projectId}/files/dir/p.html/versions`, cookie: a.cookie }),
    await write(projectId, 'dir/c.txt', 'c'),
    await daemon.request({ method: 'POST', path: `/api/projects/${projectId}/upload`, cookie: a.cookie, rawBody: upload.body, headers: { 'content-type': upload.type } }),
    await daemon.request({ path: `/api/projects/${projectId}/conversations/${conversationId}/messages`, cookie: a.cookie }),
  ];
  for (const [index, response] of responses.entries()) {
    expect(response.status, `${index} ${response.text.slice(0, 200)}`).toBeLessThan(300);
    expect(response.text, String(index)).not.toContain(root);
  }
  expect(responses[0]!.json.resolvedDir).toBeNull();
});
