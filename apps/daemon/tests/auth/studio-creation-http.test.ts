import { randomUUID } from 'node:crypto';
import { linkSync, symlinkSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import JSZip from 'jszip';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { cleanupIsolatedDataRoot, loadIsolatedServerModule, provisionAccounts, startMultiUserDaemon,
  type Principal, type StartedMultiUserDaemon } from './multiuser-harness.js';

let daemon: StartedMultiUserDaemon; let root: string; let a: Principal; let b: Principal; let admin: Principal;
beforeAll(async () => {
  ({ dataRoot: root } = await loadIsolatedServerModule());
  daemon = await startMultiUserDaemon();
  const accounts = await provisionAccounts(daemon, ['creator-a', 'creator-b']);
  [a, b] = accounts.users as [Principal, Principal]; admin = accounts.admin;
}, 120_000);
afterAll(async () => { await daemon?.close(); cleanupIsolatedDataRoot(); });
const request = (owner: Principal, method: string, url: string, body?: unknown) =>
  daemon.request({ cookie: owner.cookie, method, path: url, ...(body === undefined ? {} : { body }) });
async function project(owner = a) {
  const response = await request(owner, 'POST', '/api/projects', { id: randomUUID(), name: 'Original', metadata: { kind: 'deck', speakerNotes: true } });
  expect(response.status, response.text).toBe(200);
  return response.json.project.id as string;
}
async function write(id: string, name: string, content: string, encoding = 'utf8') {
  const response = await request(a, 'POST', `/api/projects/${id}/files`, { name, content, encoding });
  expect(response.status, response.text).toBe(200);
}
async function save(id: string, prefix = '/api/templates') {
  const response = await request(a, 'POST', prefix, { name: 'Private template', sourceProjectId: id, description: 'Captured once' });
  expect(response.status, response.text).toBe(201); return response.json.template;
}
async function use(templateId: string, owner = a) {
  return request(owner, 'POST', '/api/projects', { id: randomUUID(), name: 'From captured files', metadata: { kind: 'template', templateId } });
}
async function archive(bytes: Buffer, fields = '') {
  const boundary = 'studio-archive-boundary';
  const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="browser.zip"\r\nContent-Type: application/zip\r\n\r\n`),
    bytes, Buffer.from(`\r\n${fields}--${boundary}--\r\n`)]);
  return daemon.request({ method: 'POST', path: '/api/import/claude-design', cookie: a.cookie,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, rawBody: body });
}
async function directory(entries: Array<[string, string]>) {
  const boundary = 'studio-directory-boundary';
  const body = Buffer.from(entries.map(([name, content]) => `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n${content}\r\n`).join('') + `--${boundary}--\r\n`);
  return daemon.request({ method: 'POST', path: '/api/import/files', cookie: a.cookie,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, rawBody: body });
}

it('copies text and binary assets, keeps descriptive setup and starts a fresh conversation', async () => {
  const source = await project();
  await write(source, 'slides/index.html', '<h1>Original deck</h1>');
  await write(source, 'slides/photo.png', Buffer.from([0, 255, 32, 128]).toString('base64'), 'base64');
  const copied = await request(a, 'POST', `/api/projects/${source}/duplicate`, { name: 'Copy' });
  expect(copied.status, copied.text).toBe(200);
  expect(copied.json.project).toMatchObject({ name: 'Copy', metadata: { kind: 'deck', speakerNotes: true } });
  expect(copied.json.project.pendingPrompt).toBeUndefined();
  expect(copied.json.copiedFiles).toEqual(['slides/index.html', 'slides/photo.png']);
  const id = copied.json.project.id;
  expect((await request(a, 'GET', `/api/projects/${id}/files/slides/index.html`)).text).toBe('<h1>Original deck</h1>');
  expect((await request(a, 'GET', `/api/projects/${id}/raw/slides/photo.png`)).text).toBe((await request(a, 'GET', `/api/projects/${source}/raw/slides/photo.png`)).text);
  await write(source, 'slides/index.html', 'Changed original');
  expect((await request(a, 'GET', `/api/projects/${id}/files/slides/index.html`)).text).toBe('<h1>Original deck</h1>');
  expect((await request(a, 'GET', `/api/projects/${id}/conversations/${copied.json.conversationId}/messages`)).json.messages).toEqual([]);
});

it('templates survive source edits/deletion, retain binary assets, and withdraw only future uses', async () => {
  const source = await project(); await write(source, 'index.html', 'Captured HTML');
  await write(source, 'audio.mp3', 'AP8BAg==', 'base64');
  const template = await save(source);
  const summary = (await request(a, 'GET', '/api/templates')).json.templates.find((item: { id: string }) => item.id === template.id);
  expect(summary).toMatchObject({ fileCount: 2, files: [] });
  expect(template.files).toContainEqual({ name: 'audio.mp3', content: 'AP8BAg==', encoding: 'base64' });
  await write(source, 'index.html', 'Replacement');
  expect((await request(a, 'DELETE', `/api/projects/${source}`)).status).toBe(200);
  for (const prefix of ['/api/templates', '/api/multiuser/catalog/templates']) {
    expect((await request(a, 'GET', `${prefix}/${template.id}`)).json.template).toEqual(template);
    expect((await request(a, 'GET', prefix)).json.templates).toContainEqual(expect.objectContaining({ id: template.id, files: [] }));
  }
  const made = await use(template.id); expect(made.status, made.text).toBe(200);
  expect(made.json.project.metadata.templateLabel).toBe('Private template');
  expect((await request(a, 'GET', `/api/projects/${made.json.project.id}/files/index.html`)).text).toBe('Captured HTML');
  expect((await request(a, 'GET', `/api/projects/${made.json.project.id}/raw/audio.mp3`)).status).toBe(200);
  expect((await request(a, 'DELETE', `/api/templates/${template.id}`)).status).toBe(200);
  expect((await use(template.id)).status).toBe(404);
  expect((await request(a, 'GET', `/api/projects/${made.json.project.id}/files/index.html`)).text).toBe('Captured HTML');
});

it('A/B/admin cannot enumerate, capture, duplicate, delete or use foreign resources through either alias', async () => {
  for (const owner of [a, b]) {
    const source = await project(owner); const templateResponse = await request(owner, 'POST', '/api/templates', { sourceProjectId: source, name: 'Own blank' });
    expect(templateResponse.status, templateResponse.text).toBe(201); const id = templateResponse.json.template.id;
    for (const foreign of [owner === a ? b : a, admin]) {
      for (const prefix of ['/api/projects', '/api/multiuser/projects']) {
        const real = await request(foreign, 'POST', `${prefix}/${source}/duplicate`, {});
        const missing = await request(foreign, 'POST', `${prefix}/${randomUUID()}/duplicate`, {});
        expect(real.status).toBe(404); expect(real.json).toEqual(missing.json);
      }
      for (const prefix of ['/api/templates', '/api/multiuser/catalog/templates']) {
        for (const method of ['GET', 'DELETE']) {
          const real = await request(foreign, method, `${prefix}/${id}`);
          const missing = await request(foreign, method, `${prefix}/studio-template:${randomUUID()}`);
          expect(real.status).toBe(404); expect(real.json).toEqual(missing.json);
        }
        expect((await request(foreign, 'GET', prefix)).text).not.toContain(id);
        const real = await request(foreign, 'POST', prefix, { name: 'Guess', sourceProjectId: source });
        const missing = await request(foreign, 'POST', prefix, { name: 'Guess', sourceProjectId: randomUUID() });
        expect(real.status).toBe(404); expect(real.json).toEqual(missing.json);
      }
      const real = await use(id, foreign); const missing = await use(`studio-template:${randomUUID()}`, foreign);
      expect(real.status).toBe(404); expect(real.json).toEqual(missing.json);
    }
  }
});

it('rejects symlink and hard-link sources without copying host bytes or leaving unowned projects', async () => {
  for (const kind of ['symlink', 'hardlink']) {
    const source = await project(); const outside = path.join(root, `secret-${randomUUID()}`); writeFileSync(outside, 'HOST SECRET');
    const target = path.join(root, 'projects', source, 'foreign.txt');
    if (kind === 'symlink') symlinkSync(outside, target); else linkSync(outside, target);
    const before = (await request(a, 'GET', '/api/projects')).json.projects.length;
    const copied = await request(a, 'POST', `/api/projects/${source}/duplicate`, {});
    expect(copied.status, copied.text).toBe(400); expect(copied.text).not.toContain('HOST SECRET');
    expect((await request(a, 'GET', '/api/projects')).json.projects).toHaveLength(before);
    expect((await request(a, 'POST', '/api/templates', { name: 'Bad snapshot', sourceProjectId: source })).status).toBe(400);
  }
});

it('imports a real browser ZIP with relative assets and an owned preview entry, with no host path response', async () => {
  const zip = new JSZip(); zip.file('index.html', '<img src="assets/logo.svg">'); zip.file('assets/logo.svg', '<svg/>');
  const imported = await archive(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  expect(imported.status, imported.text).toBe(200); expect(imported.json.entryFile).toBe('index.html');
  expect(imported.text).not.toContain(root); const id = imported.json.project.id;
  expect((await request(a, 'GET', `/api/projects/${id}/files/assets/logo.svg`)).text).toBe('<svg/>');
  expect((await request(b, 'GET', `/api/projects/${id}`)).status).toBe(404);
});

it('invalid archives, path traversal and extra multipart authority leave no projects or staging files', async () => {
  const before = (await request(a, 'GET', '/api/projects')).json.projects.length;
  const evil = new JSZip(); evil.file('../escape.html', '<h1>escape</h1>');
  const good = new JSZip(); good.file('index.html', '<h1>good</h1>');
  for (const [bytes, fields] of [[Buffer.from('invalid zip'), ''], [await evil.generateAsync({ type: 'nodebuffer' }), ''],
    [await good.generateAsync({ type: 'nodebuffer' }), '--studio-archive-boundary\r\nContent-Disposition: form-data; name="ownerId"\r\n\r\nforged\r\n']] as const) {
    const result = await archive(bytes, fields); expect(result.status, result.text).toBe(400);
  }
  expect((await request(a, 'GET', '/api/projects')).json.projects).toHaveLength(before);
  expect(readdirSync(path.join(root, 'studio-project-staging'))).toEqual([]);
  expect(existsSync(path.join(root, 'escape.html'))).toBe(false);
});

it('browser directory upload keeps nested names and rejects traversal, internal files and duplicate paths atomically', async () => {
  const imported = await directory([['src/App.tsx', 'export const App = () => null'], ['assets/logo.svg', '<svg/>']]);
  expect(imported.status, imported.text).toBe(200);
  expect(imported.json.entryFile).toBeNull();
  expect(imported.text).not.toContain(root);
  expect((await request(a, 'GET', `/api/projects/${imported.json.project.id}/files/src/App.tsx`)).text).toBe('export const App = () => null');
  expect((await request(b, 'GET', `/api/projects/${imported.json.project.id}/files/src/App.tsx`)).status).toBe(404);
  const before = (await request(a, 'GET', '/api/projects')).json.projects.length;
  for (const files of [[['../escape.html', 'bad']], [['.file-versions/fake', 'bad']], [['.env', 'secret']],
    [['same.txt', 'a'], ['same.txt', 'b']], [['a', 'file'], ['a/index.html', 'collision']]] as Array<Array<[string, string]>>) {
    expect((await directory(files)).status).toBe(400);
    expect((await request(a, 'GET', '/api/projects')).json.projects).toHaveLength(before);
  }
  expect(readdirSync(path.join(root, 'studio-project-staging'))).toEqual([]);
});

it('rejects client ownership, files, labels, host locations and collisions without altering existing files', async () => {
  const id = await project(); await write(id, 'index.html', 'Keep existing');
  const template = await save(id);
  const collision = await request(a, 'POST', '/api/projects', { id, name: 'Collision', metadata: { kind: 'template', templateId: template.id } });
  expect(collision.status).toBe(409);
  expect((await request(a, 'GET', `/api/projects/${id}/files/index.html`)).text).toBe('Keep existing');
  for (const patch of [{ ownerId: b.id }, { files: [] }, { metadata: { kind: 'template', templateId: template.id, templateLabel: 'Spoof' } },
    { metadata: { kind: 'prototype', baseDir: '/host' } }]) {
    const rejected = await request(a, 'POST', '/api/projects', { id: randomUUID(), name: 'Reject', ...patch });
    expect(rejected.status).toBe(400);
  }
  for (const patch of [{ files: [] }, { ownerId: b.id }, { name: 'x'.repeat(101) }])
    expect((await request(a, 'POST', '/api/templates', { name: 'Template', sourceProjectId: id, ...patch })).status).toBe(400);
  const db = new Database(path.join(root, 'app.sqlite'));
  try { expect(() => db.prepare('UPDATE studio_templates SET snapshot_json = ? WHERE id = ?').run('{}', template.id)).toThrow('immutable'); }
  finally { db.close(); }
});

it('publishes one project for concurrent identical ids and leaves no orphan after an interrupted upload', async () => {
  const id = randomUUID();
  const outcomes = await Promise.all([1, 2].map(() => request(a, 'POST', '/api/projects', { id, name: 'Concurrent create' })));
  expect(outcomes.map((result) => result.status).sort()).toEqual([200, 409]);
  const before = (await request(a, 'GET', '/api/projects')).json.projects.length;
  const { request: httpRequest } = await import('node:http');
  await new Promise<void>((resolve) => {
    const upload = httpRequest(new URL('/api/import/files', daemon.baseUrl), { method: 'POST', agent: false, headers: {
      cookie: a.cookie, 'content-type': 'multipart/form-data; boundary=interrupted-directory',
    } });
    upload.once('error', () => resolve());
    upload.once('close', () => resolve());
    upload.once('socket', (socket) => socket.once('connect', () => {
      upload.write('--interrupted-directory\r\nContent-Disposition: form-data; name="files"; filename="index.html"\r\n\r\npartial');
      upload.flushHeaders();
      setTimeout(() => upload.destroy(new Error('User cancelled upload')), 25);
    }));
    upload.flushHeaders();
  });
  expect((await request(a, 'GET', '/api/projects')).json.projects).toHaveLength(before);
  expect(readdirSync(path.join(root, 'studio-project-staging'))).toEqual([]);
});
