import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { cleanupIsolatedDataRoot, loadIsolatedServerModule, multiUserOptions, provisionAccounts,
  startMultiUserDaemon, type Principal, type StartedMultiUserDaemon } from './multiuser-harness.js';
import { PERSONAL_CODEX_MOCK, codexHome, linkCodex } from './personal-codex-helpers.js';

// S26 (#59, #65): owner-only preview comments on the standard endpoints, and
// comment attachments honored by personal Studio runs.
let daemon: StartedMultiUserDaemon; let root: string; let a: Principal; let b: Principal; let admin: Principal;
let prefix = '';
type Target = { projectId: string; conversationId: string };

beforeAll(async () => {
  ({ dataRoot: root } = await loadIsolatedServerModule());
  daemon = await startMultiUserDaemon(multiUserOptions({ testPersonalCodexAppServer: PERSONAL_CODEX_MOCK }));
  const accounts = await provisionAccounts(daemon, ['comments-a', 'comments-b']);
  [a, b] = accounts.users as [Principal, Principal]; admin = accounts.admin;
  await linkCodex(daemon, root, a, 'comments-a@example.test');
  const current = await daemon.request({ path: `/api/admin/users/${a.id}/studio-pilot`, cookie: admin.cookie });
  expect((await daemon.request({ method: 'PUT', path: `/api/admin/users/${a.id}/studio-pilot`, cookie: admin.cookie,
    body: { studioPilot: true, revision: current.json.revision } })).status).toBe(200);
  prefix = (await daemon.request({ path: '/api/auth/me', cookie: a.cookie })).json.studioMessageIdPrefix;
}, 120_000);
afterAll(async () => { await daemon?.close(); cleanupIsolatedDataRoot(); });

async function project(user = a): Promise<Target> {
  const id = randomUUID();
  const made = await daemon.request({ method: 'POST', path: '/api/projects', cookie: user.cookie, body: { id, name: id } });
  expect(made.status, made.text).toBe(200);
  return { projectId: id, conversationId: made.json.conversationId as string };
}
const base = (t: Target, alias = false) => `/api/${alias ? 'multiuser/' : ''}projects/${t.projectId}/conversations/${t.conversationId}/comments`;
const target = { filePath: 'index.html', elementId: 'hero-title', selector: '#hero-title', label: 'h1.hero', text: 'Hello',
  position: { x: 10, y: 20, width: 300, height: 40 }, htmlHint: '<h1 id="hero-title">' };
const create = (t: Target, body: Record<string, unknown>, user = a, alias = false) =>
  daemon.request({ method: 'POST', path: base(t, alias), cookie: user.cookie, body });

it('lets the owner create, edit, list, anchor, reorder, change status and delete comments on both aliases', async () => {
  const t = await project();
  const made = await create(t, { target, note: 'Make the title red' });
  expect(made.status, made.text).toBe(200);
  const comment = made.json.comment;
  expect(comment).toMatchObject({ projectId: t.projectId, conversationId: t.conversationId, note: 'Make the title red', status: 'open' });
  expect(comment.authorMemberId).toBeUndefined();
  const edited = await create(t, { id: comment.id, target, note: 'Make it blue', attachments: [{ path: 'refs/shot.png', name: 'shot.png' }] }, a, true);
  expect(edited.status, edited.text).toBe(200);
  expect(edited.json.comment).toMatchObject({ id: comment.id, note: 'Make it blue', attachments: [{ path: 'refs/shot.png', name: 'shot.png' }] });
  const listed = await daemon.request({ path: base(t), cookie: a.cookie });
  expect(listed.status).toBe(200); expect(listed.headers['cache-control']).toBe('no-store');
  expect(listed.json.comments.map((c: { id: string }) => c.id)).toEqual([comment.id]);
  const patch = (suffix: string, body: unknown) => daemon.request({ method: 'PATCH', path: `${base(t)}/${comment.id}${suffix}`, cookie: a.cookie, body });
  expect((await patch('/anchor', { anchorState: 'stale', lastGoodPosition: { x: 1, y: 2, width: 3, height: 4 } })).json.comment.anchorState).toBe('stale');
  expect((await patch('/reorder', { sortKey: 42.5 })).json.comment.sortKey).toBe(42.5);
  expect((await patch('', { status: 'attached' })).json.comment.status).toBe('attached');
  expect((await daemon.request({ method: 'DELETE', path: `${base(t)}/${comment.id}`, cookie: a.cookie })).json).toEqual({ ok: true });
  expect((await daemon.request({ path: base(t, true), cookie: a.cookie })).json.comments).toEqual([]);
});

it('gives foreign accounts, admins and missing projects/conversations/comments one refusal and changes nothing', async () => {
  const t = await project();
  const owned = (await create(t, { target, note: 'private note' })).json.comment;
  const other = await project();
  const missing = { projectId: randomUUID(), conversationId: randomUUID() };
  const probes = (x: Target, id: string) => [
    { method: 'GET', path: base(x) },
    { method: 'POST', path: base(x), body: { target, note: 'intrusion' } },
    { method: 'POST', path: base(x), body: { id, target, note: 'intrusion' } },
    { method: 'PATCH', path: `${base(x)}/${id}`, body: { status: 'resolved' } },
    { method: 'PATCH', path: `${base(x)}/${id}/anchor`, body: { anchorState: 'lost' } },
    { method: 'PATCH', path: `${base(x)}/${id}/reorder`, body: { sortKey: 1 } },
    { method: 'DELETE', path: `${base(x)}/${id}` },
  ];
  const reference = await daemon.request({ path: base(missing), cookie: b.cookie });
  expect(reference.status).toBe(404);
  for (const user of [b, admin]) for (const probe of [...probes(t, owned.id), ...probes(missing, owned.id)]) {
    const response = await daemon.request({ ...probe, cookie: user.cookie });
    expect([probe.method, probe.path, response.status]).toEqual([probe.method, probe.path, 404]);
    expect(response.text).toBe(reference.text);
  }
  // A conversation of another owned project, and a comment id from another conversation.
  expect((await daemon.request({ path: `/api/projects/${t.projectId}/conversations/${other.conversationId}/comments`, cookie: a.cookie })).status).toBe(404);
  expect((await daemon.request({ method: 'PATCH', path: `${base(other)}/${owned.id}`, cookie: a.cookie, body: { status: 'resolved' } })).status).toBe(404);
  const after = await daemon.request({ path: base(t), cookie: a.cookie });
  expect(after.json.comments).toEqual([expect.objectContaining({ id: owned.id, note: 'private note', status: 'open' })]);
});

it('refuses client identity, chosen ids, unsafe attachment paths and unknown fields', async () => {
  const t = await project();
  expect((await create(t, { id: 'chosen-id', target, note: 'x' })).status).toBe(404);
  for (const body of [
    { target, note: 'x', authorMemberId: 'member-1' },
    { target, note: 'x', attachments: [{ path: '../secret.png', name: 'x' }] },
    { target, note: 'x', attachments: [{ path: '/etc/passwd', name: 'x' }] },
    { target, note: 'x', attachments: [{ path: 'ok.png', name: 'x', url: 'https://example.test' }] },
    { target: { ...target, position: { x: 'far' } }, note: 'x' },
    { target, note: 'x'.repeat(10_001) },
  ]) expect((await create(t, body)).status).toBe(400);
  expect((await create(t, { target, note: '' })).status).toBe(400);
  const made = (await create(t, { target, note: 'x' })).json.comment;
  expect((await daemon.request({ method: 'PATCH', path: `${base(t)}/${made.id}`, cookie: a.cookie, body: { status: 'done' } })).status).toBe(400);
  expect((await daemon.request({ method: 'PATCH', path: `${base(t)}/${made.id}/reorder`, cookie: a.cookie, body: { sortKey: 'top' } })).status).toBe(400);
});

it('sends comment attachments to the personal agent as scoped targets and refuses unsafe ones', async () => {
  const t = await project();
  const run = (commentAttachments: unknown[]) => daemon.request({ method: 'POST', path: '/api/runs', cookie: a.cookie, body: {
    agentId: 'codex', message: 'fix it', currentPrompt: 'fix it', ...t, userMessageId: `${prefix}${randomUUID()}`,
    assistantMessageId: `${prefix}${randomUUID()}`, clientRequestId: randomUUID(), attachments: [], commentAttachments } });
  const attachment = { id: 'c1', order: 1, filePath: 'index.html', elementId: 'hero-title', selector: '#hero-title', label: 'h1.hero',
    comment: 'Make the title red', currentText: 'Hello', pagePosition: { x: 1, y: 2, width: 30, height: 4 }, htmlHint: '<h1>' };
  for (const unsafe of [{ ...attachment, filePath: '../other/index.html' }, { ...attachment, screenshotPath: '/tmp/x.png', selectionKind: 'visual' },
    { ...attachment, imageAttachments: [{ path: '../../x.png', name: 'x' }] }, 'not-an-object']) {
    expect((await run([unsafe])).status).toBe(400);
  }
  const made = await run([attachment]);
  expect(made.status, made.text).toBe(202);
  await daemon.request({ path: `/api/runs/${made.json.runId}/events`, cookie: a.cookie });
  const evidence = JSON.parse(readFileSync(path.join(codexHome(root, a.id), 'mock-turn-evidence.json'), 'utf8'));
  expect(evidence.message).toContain('<attached-preview-comments>');
  expect(evidence.message).toContain('file: index.html');
  expect(evidence.message).toContain('comment: Make the title red');
});
