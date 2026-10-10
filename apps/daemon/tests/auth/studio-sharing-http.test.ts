import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupIsolatedDataRoot, loadIsolatedServerModule, multiUserOptions, provisionAccounts,
  startMultiUserDaemon, login, type Principal, type StartedMultiUserDaemon } from './multiuser-harness.js';

// S32 (#65): project sharing between accounts of one deployment — view,
// comment and edit grants, session-stamped presence and comment authors,
// conversation authorship, and revocation that reaches open streams and runs.
let daemon: StartedMultiUserDaemon;
let owner: Principal; let viewer: Principal; let commenter: Principal; let editor: Principal; let stranger: Principal; let admin: Principal;

beforeAll(async () => {
  await loadIsolatedServerModule();
  daemon = await startMultiUserDaemon(multiUserOptions({ testMockAgentScript: path.resolve('../..', 'mocks/run-isolation-agent.ts') }));
  const accounts = await provisionAccounts(daemon, ['share-owner', 'share-viewer', 'share-commenter', 'share-editor', 'share-stranger']);
  [owner, viewer, commenter, editor, stranger] = accounts.users as [Principal, Principal, Principal, Principal, Principal];
  admin = accounts.admin;
}, 120_000);
afterAll(async () => { await daemon?.close(); cleanupIsolatedDataRoot(); });

type Target = { id: string; cid: string };
async function sharedProject(grants: Array<[Principal, 'view' | 'comment' | 'edit']> = []): Promise<Target> {
  const id = randomUUID();
  const made = await daemon.request({ method: 'POST', path: '/api/projects', cookie: owner.cookie, body: { id, name: `shared ${id}` } });
  expect(made.status, made.text).toBe(200);
  const written = await daemon.request({ method: 'POST', path: `/api/projects/${id}/files`, cookie: owner.cookie, body: { name: 'index.html', content: '<h1>Hi</h1>' } });
  expect(written.status, written.text).toBe(200);
  for (const [user, role] of grants) {
    const shared = await share(id, user.username, role);
    expect(shared.status, shared.text).toBe(200);
  }
  return { id, cid: made.json.conversationId as string };
}
const share = (id: string, username: string, role: string, by = owner) =>
  daemon.request({ method: 'PUT', path: `/api/multiuser/projects/${id}/shares`, cookie: by.cookie, body: { username, role } });
const commentTarget = { filePath: 'index.html', elementId: 'h', selector: 'h1', label: 'h1', text: 'Hi', position: { x: 1, y: 1, width: 1, height: 1 }, htmlHint: '<h1>' };
const comment = (t: Target, user: Principal, note: string) => daemon.request({ method: 'POST', path: `/api/projects/${t.id}/conversations/${t.cid}/comments`,
  cookie: user.cookie, body: { target: commentTarget, note } });
const conversation = async (t: Target, user: Principal) => {
  const made = await daemon.request({ method: 'POST', path: `/api/projects/${t.id}/conversations`, cookie: user.cookie, body: { title: `${user.username} thread` } });
  expect(made.status, made.text).toBe(200);
  expect(made.json.conversation.studioCanWrite).toBe(true);
  return made.json.conversation.id as string;
};
const run = (t: Target, cid: string, user: Principal, delayMs = 0) => daemon.request({ method: 'POST', path: '/api/runs', cookie: user.cookie,
  body: { projectId: t.id, conversationId: cid, agentId: 'test-mock', message: `${user.username} turn`, delayMs } });
const runStatus = async (id: string, user: Principal) => (await daemon.request({ path: `/api/runs/${id}`, cookie: user.cookie })).json?.status as string;
async function until(check: () => Promise<boolean>, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('project sharing between accounts', () => {
  it('lists the project, members and roles for the owner and the grantee and nobody else', async () => {
    const t = await sharedProject([[viewer, 'view']]);
    const mine = (await daemon.request({ path: '/api/projects', cookie: owner.cookie })).json.projects.find((p: { id: string }) => p.id === t.id);
    expect(mine.studioShare).toEqual({ role: 'owner', ownerUsername: 'share-owner', memberCount: 2 });
    const theirs = (await daemon.request({ path: '/api/projects', cookie: viewer.cookie })).json.projects.find((p: { id: string }) => p.id === t.id);
    expect(theirs.studioShare).toEqual({ role: 'view', ownerUsername: 'share-owner', memberCount: 2 });
    for (const user of [stranger, admin]) {
      expect(JSON.stringify((await daemon.request({ path: '/api/projects', cookie: user.cookie })).json)).not.toContain(t.id);
    }
    const access = await daemon.request({ path: `/api/multiuser/projects/${t.id}/access`, cookie: viewer.cookie });
    expect(access.status).toBe(200);
    expect(access.json).toMatchObject({ projectId: t.id, role: 'view', shared: true,
      self: { accountId: viewer.id, username: 'share-viewer', role: 'view' }, owner: { accountId: owner.id, username: 'share-owner', role: 'owner' } });
    expect(access.json.members.map((m: { username: string; role: string }) => `${m.username}:${m.role}`)).toEqual(['share-owner:owner', 'share-viewer:view']);
    const missing = await daemon.request({ path: `/api/multiuser/projects/${randomUUID()}/access`, cookie: stranger.cookie });
    for (const user of [stranger, admin]) {
      const refused = await daemon.request({ path: `/api/multiuser/projects/${t.id}/access`, cookie: user.cookie });
      expect(refused.status).toBe(404);
      expect(refused.text).toBe(missing.text);
    }
  });

  it('refuses unknown, own and inactive usernames alike, and grants only from the owner', async () => {
    const t = await sharedProject([[editor, 'edit']]);
    const unknown = await share(t.id, 'nobody-here', 'view');
    expect(unknown.status).toBe(404);
    expect((await share(t.id, owner.username, 'view')).text).toBe(unknown.text);
    const inactive = await daemon.request({ method: 'POST', path: '/api/auth/users', cookie: admin.cookie, body: { username: 'share-gone', password: 'share-gone-password-battery', role: 'user' } });
    expect(inactive.status).toBe(201);
    const deactivated = await daemon.request({ method: 'PATCH', path: `/api/auth/users/${inactive.json.account.id}`, cookie: admin.cookie, body: { active: false } });
    expect(deactivated.status, deactivated.text).toBe(200);
    expect((await share(t.id, 'share-gone', 'view')).text).toBe(unknown.text);
    for (const body of [{ username: 'share-viewer', role: 'owner' }, { username: 'share-viewer', role: 'view', accountId: viewer.id }, { username: 'share-viewer' }]) {
      expect((await daemon.request({ method: 'PUT', path: `/api/multiuser/projects/${t.id}/shares`, cookie: owner.cookie, body })).status).toBe(400);
    }
    // An editor, a stranger and an admin cannot grant, revoke or read the grant list.
    for (const user of [editor, stranger, admin]) {
      expect((await share(t.id, 'share-viewer', 'view', user)).status).toBe(404);
      expect((await daemon.request({ method: 'DELETE', path: `/api/multiuser/projects/${t.id}/shares/${editor.id}`, cookie: user.cookie })).status).toBe(404);
    }
    expect((await daemon.request({ path: `/api/multiuser/projects/${t.id}/access`, cookie: viewer.cookie })).status).toBe(404);
  });

  it('enforces the view < comment < edit matrix on the standard endpoints', async () => {
    const t = await sharedProject([[viewer, 'view'], [commenter, 'comment'], [editor, 'edit']]);
    const rows: Array<[string, string, unknown, Record<string, number>]> = [
      ['GET', `/api/projects/${t.id}`, undefined, { viewer: 200, commenter: 200, editor: 200 }],
      ['GET', `/api/projects/${t.id}/files`, undefined, { viewer: 200, commenter: 200, editor: 200 }],
      ['GET', `/api/projects/${t.id}/raw/index.html`, undefined, { viewer: 200, commenter: 200, editor: 200 }],
      ['GET', `/api/projects/${t.id}/conversations`, undefined, { viewer: 200, commenter: 200, editor: 200 }],
      ['GET', `/api/projects/${t.id}/conversations/${t.cid}/comments`, undefined, { viewer: 200, commenter: 200, editor: 200 }],
      ['POST', `/api/projects/${t.id}/export/html`, { fileName: 'index.html' }, { viewer: 200, commenter: 200, editor: 200 }],
      ['POST', `/api/projects/${t.id}/files`, { name: 'notes.md', content: 'x', overwrite: true }, { viewer: 404, commenter: 404, editor: 200 }],
      ['POST', `/api/projects/${t.id}/conversations`, { title: 'mine' }, { viewer: 404, commenter: 404, editor: 200 }],
      // Owner-only whatever the grant.
      ['PATCH', `/api/projects/${t.id}`, { name: 'renamed' }, { viewer: 404, commenter: 404, editor: 404 }],
      ['PUT', `/api/projects/${t.id}/tabs`, { tabs: ['index.html'], active: 'index.html' }, { viewer: 404, commenter: 404, editor: 404 }],
      ['POST', `/api/projects/${t.id}/duplicate`, { name: 'copy' }, { viewer: 404, commenter: 404, editor: 404 }],
      ['DELETE', `/api/projects/${t.id}/conversations/${t.cid}`, undefined, { viewer: 404, commenter: 404, editor: 404 }],
      ['DELETE', `/api/projects/${t.id}`, undefined, { viewer: 404, commenter: 404, editor: 404 }],
    ];
    for (const [method, url, body, expected] of rows) {
      for (const [name, user] of [['viewer', viewer], ['commenter', commenter], ['editor', editor]] as const) {
        const response = await daemon.request({ method, path: url, cookie: user.cookie, ...(body === undefined ? {} : { body }) });
        expect([method, url, name, response.status]).toEqual([method, url, name, expected[name]]);
      }
    }
    expect((await comment(t, viewer, 'from viewer')).status).toBe(404);
    expect((await comment(t, commenter, 'from commenter')).status).toBe(200);
    expect((await daemon.request({ path: `/api/projects/${t.id}`, cookie: owner.cookie })).json.project.name).toBe(`shared ${t.id}`);
  });

  it('stamps comment authors from the session and limits edits and deletes to authors and the owner', async () => {
    const t = await sharedProject([[commenter, 'comment'], [editor, 'edit']]);
    const theirs = (await comment(t, commenter, 'commenter note')).json.comment;
    const ours = (await comment(t, owner, 'owner note')).json.comment;
    expect(theirs.authorMemberId).toBe(commenter.id);
    expect(ours.authorMemberId).toBe(owner.id);
    const listed = await daemon.request({ path: `/api/projects/${t.id}/conversations/${t.cid}/comments`, cookie: editor.cookie });
    expect(listed.json.comments.map((c: { authorMemberId: string }) => c.authorMemberId).sort()).toEqual([owner.id, commenter.id].sort());
    const base = `/api/projects/${t.id}/conversations/${t.cid}/comments`;
    // Only the author edits a note, and the author survives an edit.
    expect((await daemon.request({ method: 'POST', path: base, cookie: owner.cookie, body: { id: theirs.id, target: commentTarget, note: 'owner rewrite' } })).status).toBe(404);
    const edited = await daemon.request({ method: 'POST', path: base, cookie: commenter.cookie, body: { id: theirs.id, target: commentTarget, note: 'commenter rewrite' } });
    expect(edited.json.comment).toMatchObject({ note: 'commenter rewrite', authorMemberId: commenter.id });
    // Status: author, owner or editor; a commenter cannot resolve the owner's comment.
    expect((await daemon.request({ method: 'PATCH', path: `${base}/${ours.id}`, cookie: commenter.cookie, body: { status: 'resolved' } })).status).toBe(404);
    expect((await daemon.request({ method: 'PATCH', path: `${base}/${theirs.id}`, cookie: editor.cookie, body: { status: 'resolved' } })).status).toBe(200);
    // Delete: author or owner.
    expect((await daemon.request({ method: 'DELETE', path: `${base}/${ours.id}`, cookie: commenter.cookie })).status).toBe(404);
    expect((await daemon.request({ method: 'DELETE', path: `${base}/${ours.id}`, cookie: editor.cookie })).status).toBe(404);
    expect((await daemon.request({ method: 'DELETE', path: `${base}/${theirs.id}`, cookie: owner.cookie })).status).toBe(200);
    const after = await daemon.request({ path: base, cookie: owner.cookie });
    expect(after.json.comments.map((c: { id: string }) => c.id)).toEqual([ours.id]);
  });

  it('lets an editor run turns only in its own conversation and never write another account\'s transcript', async () => {
    const t = await sharedProject([[editor, 'edit'], [commenter, 'comment']]);
    expect((await run(t, t.cid, editor)).status).toBe(404);
    const theirs = await conversation(t, editor);
    const started = await run(t, theirs, editor);
    expect(started.status, started.text).toBe(202);
    await daemon.request({ path: `/api/runs/${started.json.run.id}/events`, cookie: editor.cookie });
    expect(await runStatus(started.json.run.id, editor)).toBe('succeeded');
    // The owner reads the editor's run history but neither runs nor writes in that conversation.
    expect((await run(t, theirs, owner)).status).toBe(404);
    expect((await daemon.request({ path: `/api/runs/${started.json.run.id}`, cookie: owner.cookie })).status).toBe(404);
    // Transcript writes (rename here; message rows share the rule) belong to the author alone.
    const rename = (user: Principal, cid: string) => daemon.request({ method: 'PATCH', path: `/api/projects/${t.id}/conversations/${cid}`,
      cookie: user.cookie, body: { title: `${user.username} rename` } });
    expect((await rename(editor, t.cid)).status).toBe(404);
    expect((await rename(owner, theirs)).status).toBe(404);
    expect((await rename(editor, theirs)).status).toBe(200);
    expect((await rename(owner, t.cid)).status).toBe(200);
    const listed = await daemon.request({ path: `/api/projects/${t.id}/conversations`, cookie: commenter.cookie });
    expect(listed.json.conversations.map((c: { title: string }) => c.title).sort()).toEqual(['share-editor rename', 'share-owner rename']);
    expect(listed.json.conversations.every((c: { studioCanWrite: boolean }) => c.studioCanWrite === false)).toBe(true);
    for (const [user, writable] of [[owner, t.cid], [editor, theirs]] as const) {
      const response = await daemon.request({ path: `/api/projects/${t.id}/conversations`, cookie: user.cookie });
      expect(response.json.conversations.map((c: { id: string; studioCanWrite: boolean }) => [c.id, c.studioCanWrite])
        .sort()).toEqual([[t.cid, writable === t.cid], [theirs, writable === theirs]].sort());
    }
    expect((await daemon.request({ path: `/api/projects/${t.id}/conversations/${theirs}/messages`, cookie: commenter.cookie })).status).toBe(200);
    const runs = await daemon.request({ path: `/api/runs?projectId=${t.id}`, cookie: editor.cookie });
    expect(runs.json.runs.map((r: { id: string }) => r.id)).toEqual([started.json.run.id]);
  });

  it('keeps presence identity on the server and drops members who leave or lose access', async () => {
    const t = await sharedProject([[viewer, 'view'], [editor, 'edit']]);
    const beat = (user: Principal, body: unknown) => daemon.request({ method: 'POST', path: `/api/projects/${t.id}/presence/heartbeat`, cookie: user.cookie, body });
    expect((await beat(owner, { clientId: 'tab-a', filePath: 'index.html' })).status).toBe(200);
    const roster = await beat(viewer, { clientId: 'tab-b' });
    expect(roster.json.present).toEqual(expect.arrayContaining([
      expect.objectContaining({ memberId: owner.id, name: 'share-owner', role: 'owner', filePath: 'index.html' }),
      expect.objectContaining({ memberId: viewer.id, name: 'share-viewer', role: 'member', filePath: null }),
    ]));
    for (const body of [{ clientId: 'tab-c', memberId: owner.id }, { clientId: 'tab-c', name: 'spoof' }, { clientId: '../x' }, { clientId: 'x', filePath: 'a\u0000b' }]) {
      expect((await beat(editor, body)).status).toBe(400);
    }
    expect((await beat(stranger, { clientId: 'tab-d' })).status).toBe(404);
    expect((await daemon.request({ path: `/api/projects/${t.id}/presence`, cookie: admin.cookie })).status).toBe(404);
    expect((await daemon.request({ method: 'POST', path: `/api/projects/${t.id}/presence/leave`, cookie: owner.cookie, body: { clientId: 'tab-a' } })).status).toBe(200);
    const left = await daemon.request({ path: `/api/projects/${t.id}/presence`, cookie: viewer.cookie });
    expect(left.json.present.map((m: { memberId: string }) => m.memberId)).toEqual([viewer.id]);
    expect((await daemon.request({ method: 'DELETE', path: `/api/multiuser/projects/${t.id}/shares/${viewer.id}`, cookie: owner.cookie })).status).toBe(200);
    expect((await daemon.request({ path: `/api/projects/${t.id}/presence`, cookie: owner.cookie })).json.present).toEqual([]);
  });

  it('signals committed shared messages without granting the reader private run access', async () => {
    const t = await sharedProject([[viewer, 'view']]);
    const signals: Array<Record<string, unknown>> = [];
    let wire = '';
    const stream = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const { port } = new URL(daemon.baseUrl);
      const request = http.request({ host: '127.0.0.1', port: Number(port), path: `/api/projects/${t.id}/events`, headers: { cookie: viewer.cookie } }, (res) => {
        expect(res.statusCode).toBe(200);
        res.on('data', (chunk: Buffer) => {
          wire += chunk.toString();
          for (;;) {
            const end = wire.indexOf('\n\n'); if (end < 0) break;
            const frame = wire.slice(0, end); wire = wire.slice(end + 2);
            const data = frame.split('\n').find((line) => line.startsWith('data:'))?.slice(5);
            if (!data) continue;
            const event = JSON.parse(data) as Record<string, unknown>;
            if (event.type === 'chat-messages-changed') signals.push(event);
          }
        });
        resolve(res);
      });
      request.on('error', reject); request.end();
    });
    try {
      const started = await run(t, t.cid, owner);
      expect(started.status, started.text).toBe(202);
      await until(async () => signals.some((event) => event.conversationId === t.cid));
      for (const event of signals) {
        expect(Object.keys(event).sort()).toEqual(['at', 'conversationId', 'projectId', 'type']);
        expect(event.projectId).toBe(t.id); expect(Number.isFinite(event.at)).toBe(true);
      }
      const messages = await daemon.request({ path: `/api/projects/${t.id}/conversations/${t.cid}/messages`, cookie: viewer.cookie });
      expect(messages.status).toBe(200);
      expect(messages.json.messages.some((message: { content: string }) => message.content.includes('share-owner turn'))).toBe(true);
      expect((await daemon.request({ path: `/api/runs/${started.json.run.id}`, cookie: viewer.cookie })).status).toBe(404);
    } finally { stream.destroy(); }
  });

  it('revokes at once: open event streams close, reads refuse, and the grantee\'s turns stop', async () => {
    const t = await sharedProject([[editor, 'edit']]);
    const cid = await conversation(t, editor);
    const ended = new Promise<number>((resolve, reject) => {
      const { port } = new URL(daemon.baseUrl);
      const request = http.request({ host: '127.0.0.1', port: Number(port), path: `/api/projects/${t.id}/events`, headers: { cookie: editor.cookie } }, (res) => {
        expect(res.statusCode).toBe(200);
        const opened = Date.now();
        res.on('data', () => {});
        res.on('end', () => resolve(Date.now() - opened));
        res.on('error', () => resolve(Date.now() - opened));
      });
      request.on('error', reject);
      request.end();
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const started = await run(t, cid, editor, 2_000);
    expect(started.status, started.text).toBe(202);
    await until(async () => ['running', 'queued'].includes(await runStatus(started.json.run.id, editor)));
    // Downgrading below edit stops the turn but keeps read access.
    expect((await share(t.id, editor.username, 'view')).status).toBe(200);
    await until(async () => (await runStatus(started.json.run.id, editor)) === 'canceled');
    expect((await daemon.request({ path: `/api/projects/${t.id}/files`, cookie: editor.cookie })).status).toBe(200);
    expect((await daemon.request({ method: 'POST', path: `/api/projects/${t.id}/files`, cookie: editor.cookie, body: { name: 'x.md', content: 'x' } })).status).toBe(404);
    expect((await daemon.request({ method: 'DELETE', path: `/api/multiuser/projects/${t.id}/shares/${editor.id}`, cookie: owner.cookie })).status).toBe(200);
    expect(await ended).toBeLessThan(5_000);
    for (const url of [`/api/projects/${t.id}`, `/api/projects/${t.id}/files`, `/api/projects/${t.id}/raw/index.html`, `/api/multiuser/projects/${t.id}/access`]) {
      expect((await daemon.request({ path: url, cookie: editor.cookie })).status).toBe(404);
    }
    expect(JSON.stringify((await daemon.request({ path: '/api/projects', cookie: editor.cookie })).json)).not.toContain(t.id);
  });

  it('lets a grantee leave, and stops collaborators\' turns when the owner deletes the project', async () => {
    const t = await sharedProject([[viewer, 'view'], [editor, 'edit']]);
    expect((await daemon.request({ method: 'DELETE', path: `/api/multiuser/projects/${t.id}/access`, cookie: owner.cookie })).status).toBe(409);
    expect((await daemon.request({ method: 'DELETE', path: `/api/multiuser/projects/${t.id}/access`, cookie: viewer.cookie })).status).toBe(200);
    expect((await daemon.request({ path: `/api/projects/${t.id}`, cookie: viewer.cookie })).status).toBe(404);
    const cid = await conversation(t, editor);
    const started = await run(t, cid, editor, 2_000);
    expect(started.status, started.text).toBe(202);
    await until(async () => ['running', 'queued'].includes(await runStatus(started.json.run.id, editor)));
    const deleted = await daemon.request({ method: 'DELETE', path: `/api/projects/${t.id}`, cookie: owner.cookie });
    expect(deleted.status, deleted.text).toBe(200);
    expect((await daemon.request({ path: `/api/projects/${t.id}`, cookie: editor.cookie })).status).toBe(404);
    expect((await daemon.request({ path: `/api/runs/${started.json.run.id}`, cookie: editor.cookie })).status).toBe(404);
  });

  it('suspends project grants and collaborators\' runs on owner deactivation, and restores grants on reactivation', async () => {
    const t = await sharedProject([[viewer, 'view'], [commenter, 'comment'], [editor, 'edit']]);
    const cid = await conversation(t, editor);
    // 2_000 ms is the mock's ceiling; a longer delay is refused as an invalid request.
    const started = await run(t, cid, editor, 2_000);
    expect(started.status, started.text).toBe(202);
    const runId = started.json.run.id as string;
    await until(async () => ['running', 'queued'].includes(await runStatus(runId, editor)));
    const streams = await Promise.all([viewer, commenter, editor].map((user) => new Promise<http.IncomingMessage>((resolve, reject) => {
      const { port } = new URL(daemon.baseUrl);
      const request = http.request({ host: '127.0.0.1', port: Number(port), path: `/api/projects/${t.id}/events`, headers: { cookie: user.cookie } }, (res) => {
        expect(res.statusCode).toBe(200); res.resume(); resolve(res);
      });
      request.on('error', reject); request.end();
    })));
    const closed = streams.map((stream) => new Promise<void>((resolve) => stream.once('close', resolve)));
    const patch = (active: boolean) => daemon.request({ method: 'PATCH', path: `/api/auth/users/${owner.id}`, cookie: admin.cookie, body: { active } });
    try {
      expect((await patch(false)).status).toBe(200);
      await Promise.all(closed);
      for (const user of [viewer, commenter, editor, admin]) {
        for (const url of [`/api/projects/${t.id}`, `/api/projects/${t.id}/files`, `/api/projects/${t.id}/raw/index.html`,
          `/api/projects/${t.id}/conversations/${cid}/messages`, `/api/multiuser/projects/${t.id}/access`,
          `/api/projects/${t.id}/presence`, `/api/projects/${t.id}/events`, `/api/runs/${runId}`]) {
          const refused = await daemon.request({ path: url, cookie: user.cookie });
          const missing = await daemon.request({ path: url.replace(t.id, randomUUID()).replace(runId, randomUUID()), cookie: user.cookie });
          expect(refused.status, url).toBe(404);
          expect(refused.text, url).toBe(missing.text);
        }
        expect(JSON.stringify((await daemon.request({ path: '/api/projects', cookie: user.cookie })).json)).not.toContain(t.id);
        const runs = await daemon.request({ path: `/api/runs?projectId=${t.id}`, cookie: user.cookie });
        expect(runs.json.runs).toEqual([]);
        expect(runs.json.awaitingInputProjectIds).not.toContain(t.id);
      }
      expect((await comment(t, commenter, 'inactive owner comment')).status).toBe(404);
      expect((await daemon.request({ method: 'POST', path: `/api/projects/${t.id}/files`, cookie: editor.cookie,
        body: { name: 'inactive.md', content: 'refused' } })).status).toBe(404);
      expect((await daemon.request({ path: `/api/projects/${t.id}/preview-url?file=index.html`, cookie: viewer.cookie })).status).toBe(404);
      expect((await run(t, cid, editor)).status).toBe(404);
      expect((await daemon.request({ method: 'POST', path: `/api/projects/${t.id}/conversations`, cookie: editor.cookie,
        body: { title: 'inactive owner' } })).status).toBe(404);
    } finally {
      for (const stream of streams) stream.destroy();
      expect((await patch(true)).status).toBe(200);
      owner.cookie = await login(daemon, owner.username, owner.password);
    }
    await until(async () => (await runStatus(runId, editor)) === 'canceled');
    const access = await daemon.request({ path: `/api/multiuser/projects/${t.id}/access`, cookie: editor.cookie });
    expect(access.json.role).toBe('edit');
    expect(access.json.members.map((member: { accountId: string }) => member.accountId).sort()).toEqual([owner.id, viewer.id, commenter.id, editor.id].sort());
    expect((await daemon.request({ path: `/api/projects/${t.id}/files`, cookie: viewer.cookie })).status).toBe(200);
  });
});
