import { randomUUID } from 'node:crypto';
import path from 'node:path';
import http from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  cleanupIsolatedDataRoot, loadIsolatedServerModule, provisionAccounts,
  startMultiUserDaemon, multiUserOptions, type Principal, type StartedMultiUserDaemon,
} from './multiuser-harness.js';

let daemon: StartedMultiUserDaemon;
let alice: Principal;
let bob: Principal;
let admin: Principal;
let streamUser: Principal;
let dataRoot: string;
beforeAll(async () => {
  ({ dataRoot } = await loadIsolatedServerModule());
  daemon = await startMultiUserDaemon(multiUserOptions({ testMockAgentScript: path.resolve('../..', 'mocks/run-isolation-agent.ts') }));
  const accounts = await provisionAccounts(daemon, ['alice', 'bob', 'stream-user']);
  admin = accounts.admin;
  [alice, bob, streamUser] = accounts.users as [Principal, Principal, Principal];
}, 120_000);
afterAll(async () => { await daemon?.close(); cleanupIsolatedDataRoot(); });

async function project(owner: Principal) {
  const id = randomUUID();
  const created = await daemon.request({ method: 'POST', path: '/api/projects', cookie: owner.cookie,
    body: { id, name: 'Studio project' } });
  expect(created.status, created.text).toBe(200);
  return { id, cid: created.json.conversationId as string };
}

async function turn(owner: Principal, target: { id: string; cid: string }, message: string, delayMs = 0) {
  const made = await daemon.request({ method: 'POST', path: '/api/runs', cookie: owner.cookie,
    body: { projectId: target.id, conversationId: target.cid, agentId: 'test-mock', message, delayMs } });
  expect(made.status, made.text).toBe(202);
  return made.json.run as { id: string; userMessageId: string; assistantMessageId: string };
}

describe('standard Studio project authority (#54)', () => {
  it('keeps transient focus session-scoped and checks owner before accepting or reading it', async () => {
    const a = await project(alice);
    const b = await project(bob);
    expect((await daemon.request({ path: '/api/active', cookie: alice.cookie })).json).toEqual({ active: false });
    const selected = await daemon.request({ method: 'POST', path: '/api/active', cookie: alice.cookie,
      body: { projectId: a.id, fileName: 'private.html' } });
    expect(selected.status, selected.text).toBe(200);
    for (const principal of [bob, admin]) {
      expect((await daemon.request({ path: '/api/active', cookie: principal.cookie })).json).toEqual({ active: false });
      const results = [];
      for (const id of [a.id, randomUUID()]) {
        const rejected = await daemon.request({ method: 'POST', path: '/api/active', cookie: principal.cookie,
          body: { projectId: id } });
        expect(rejected.status, rejected.text).toBe(404);
        results.push(rejected.json);
      }
      expect(results[0]).toEqual(results[1]);
    }
    expect((await daemon.request({ method: 'POST', path: '/api/active', cookie: bob.cookie,
      body: { projectId: b.id } })).status).toBe(200);
    expect((await daemon.request({ path: '/api/active', cookie: alice.cookie })).json).toMatchObject({ projectId: a.id, fileName: 'private.html' });
    const anotherSession = await daemon.request({ method: 'POST', path: '/api/auth/login',
      body: { username: alice.username, password: alice.password } });
    expect(anotherSession.status, anotherSession.text).toBe(200);
    const anotherCookie = anotherSession.setCookies[0]?.split(';')[0] ?? null;
    expect(anotherCookie).not.toBeNull();
    expect((await daemon.request({ path: '/api/active', cookie: anotherCookie })).json).toEqual({ active: false });
    expect((await daemon.request({ method: 'POST', path: '/api/active', cookie: alice.cookie,
      body: { projectId: a.id, ownerAccountId: bob.id } })).status).toBe(400);
    expect((await daemon.request({ method: 'DELETE', path: `/api/projects/${a.id}`, cookie: alice.cookie })).status).toBe(200);
    expect((await daemon.request({ path: '/api/active', cookie: alice.cookie })).json).toEqual({ active: false });
    expect((await daemon.request({ path: '/api/active', cookie: bob.cookie })).json).toMatchObject({ projectId: b.id });
  });

  it('persists conversation title and mode through the standard API', async () => {
    const { id, cid } = await project(alice);
    const changed = await daemon.request({ method: 'PATCH', path: `/api/projects/${id}/conversations/${cid}`,
      cookie: alice.cookie, body: { title: 'Design revision', sessionMode: 'plan' } });
    expect(changed.status, changed.text).toBe(200);
    expect(changed.json.conversation).toMatchObject({ id: cid, title: 'Design revision', sessionMode: 'plan' });
    const read = await daemon.request({ path: `/api/projects/${id}/conversations`, cookie: alice.cookie });
    expect(read.json.conversations).toContainEqual(expect.objectContaining({ id: cid, title: 'Design revision' }));
  });

  it('persists messages, forks only the authorized transcript and deletes the fork', async () => {
    const { id, cid } = await project(alice);
    const run = await turn(alice, { id, cid }, 'Initial design request');
    await daemon.request({ path: `/api/runs/${run.id}/events`, cookie: alice.cookie });
    const mid = run.userMessageId;
    const saved = await daemon.request({ method: 'PUT', path: `/api/projects/${id}/conversations/${cid}/messages/${mid}`,
      cookie: alice.cookie, body: { id: mid, role: 'user', content: 'Make the design accessible', createdAt: 1 } });
    expect(saved.status, saved.text).toBe(200);
    const edited = await daemon.request({ path: `/api/projects/${id}/conversations/${cid}/messages`, cookie: alice.cookie });
    expect(edited.json.messages[0].createdAt).not.toBe(1);
    const forgedRole = await daemon.request({ method: 'PUT', path: `/api/projects/${id}/conversations/${cid}/messages/${mid}`,
      cookie: alice.cookie, body: { role: 'assistant', content: 'Forged writer' } });
    expect(forgedRole.status, forgedRole.text).toBe(400);
    const fork = await daemon.request({ method: 'POST', path: `/api/projects/${id}/conversations`, cookie: alice.cookie,
      body: { seedFromConversationId: cid, forkAfterMessageId: mid } });
    expect(fork.status, fork.text).toBe(200);
    const forkId = fork.json.conversation.id;
    const transcript = await daemon.request({ path: `/api/projects/${id}/conversations/${forkId}/messages`, cookie: alice.cookie });
    expect(transcript.json.messages).toHaveLength(1);
    expect(transcript.json.messages[0]).toMatchObject({ role: 'user', content: 'Make the design accessible' });
    expect(transcript.json.messages[0].id).not.toBe(mid);
    const deleted = await daemon.request({ method: 'DELETE', path: `/api/projects/${id}/conversations/${forkId}`, cookie: alice.cookie });
    expect(deleted.status, deleted.text).toBe(200);
    expect((await daemon.request({ path: `/api/projects/${id}/conversations/${forkId}/messages`, cookie: alice.cookie })).status).toBe(404);
  });

  it('persists file tabs without sharing them with another project', async () => {
    const a = await project(alice);
    const b = await project(bob);
    const updated = await daemon.request({ method: 'PUT', path: `/api/projects/${a.id}/tabs`, cookie: alice.cookie,
      body: { tabs: ['index.html', 'style.css'], active: 'style.css' } });
    expect(updated.status, updated.text).toBe(200);
    const own = await daemon.request({ path: `/api/projects/${a.id}/tabs`, cookie: alice.cookie });
    expect(own.json).toMatchObject({ tabs: ['index.html', 'style.css'], active: 'style.css' });
    const other = await daemon.request({ path: `/api/projects/${b.id}/tabs`, cookie: bob.cookie });
    expect(other.json.tabs).toEqual([]);
  });

  it('streams only the owned project and closes an idle stream on persisted revocation', async () => {
    const user = streamUser;
    const a = await project(user);
    const b = await project(bob);
    mkdirSync(path.join(dataRoot, 'projects', a.id), { recursive: true });
    mkdirSync(path.join(dataRoot, 'projects', b.id), { recursive: true });
    let frames = '';
    let ended = false;
    const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = http.get(`${daemon.baseUrl}/api/projects/${a.id}/events`, { headers: { Cookie: user.cookie } }, (res) => {
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => { frames += chunk; });
        res.on('end', () => { ended = true; });
        resolve(res);
      });
      req.on('error', reject);
    });
    try {
      expect(response.statusCode).toBe(200);
      expect(response.headers['x-accel-buffering']).toBe('no');
      await vi.waitFor(() => expect(frames).toContain('event: ready'), { timeout: 4_000 });
      writeFileSync(path.join(dataRoot, 'projects', b.id, 'bob-secret.html'), 'Bob private');
      writeFileSync(path.join(dataRoot, 'projects', a.id, 'owned.html'), 'Owned design');
      await vi.waitFor(() => expect(frames).toContain('owned.html'), { timeout: 4_000 });
      expect(frames).not.toContain('bob-secret.html');
      const revoked = await daemon.request({ method: 'POST', path: `/api/auth/users/${user.id}/sessions/revoke`, cookie: admin.cookie, body: {} });
      expect(revoked.status, revoked.text).toBe(200);
      await vi.waitFor(() => expect(ended).toBe(true), { timeout: 2_000 });
      const atRevocation = frames;
      writeFileSync(path.join(dataRoot, 'projects', a.id, 'after-revoke.html'), 'Must never stream');
      expect(frames).toBe(atRevocation);
      expect((await daemon.request({ path: `/api/projects/${a.id}/events`, cookie: user.cookie })).status).toBe(401);
    } finally { response.destroy(); }
  });

  it('rejects foreign and missing project resources identically, including admin', async () => {
    const { id, cid } = await project(alice);
    const mid = randomUUID();
    for (const principal of [bob, admin]) {
      for (const [method, suffix, body] of [
        ['PATCH', `/conversations/${cid}`, { title: 'foreign' }],
        ['DELETE', `/conversations/${cid}`, undefined],
        ['PUT', `/conversations/${cid}/messages/${mid}`, { role: 'user', content: 'foreign' }],
        ['GET', '/tabs', undefined],
        ['PUT', '/tabs', { tabs: ['foreign.html'], active: 'foreign.html' }],
        ['GET', '/events', undefined],
      ] as const) {
        const foreign = await daemon.request({ method, path: `/api/projects/${id}${suffix}`, cookie: principal.cookie, body });
        const missing = await daemon.request({ method, path: `/api/projects/${randomUUID()}${suffix}`, cookie: principal.cookie, body });
        expect(foreign.status, `${method} ${suffix}: ${foreign.text}`).toBe(404);
        expect(foreign.json).toEqual(missing.json);
      }
    }
    const own = await daemon.request({ path: `/api/projects/${id}/conversations`, cookie: alice.cookie });
    expect(own.json.conversations).toContainEqual(expect.objectContaining({ id: cid }));
  });

  it('refuses message id collisions across conversations without changing the original', async () => {
    const a = await project(alice);
    const b = await project(bob);
    const run = await turn(bob, b, 'Bob private message');
    await daemon.request({ path: `/api/runs/${run.id}/events`, cookie: bob.cookie });
    const mid = run.userMessageId;
    const results = [];
    for (const collision of [mid, randomUUID()]) {
      const response = await daemon.request({ method: 'PUT', path: `/api/projects/${a.id}/conversations/${a.cid}/messages/${collision}`,
        cookie: alice.cookie, body: { role: 'user', content: 'Overwrite', createOnly: true } });
      expect(response.status, response.text).toBe(404);
      results.push(response.json);
    }
    expect(results[0]).toEqual(results[1]);
    const read = await daemon.request({ path: `/api/projects/${b.id}/conversations/${b.cid}/messages`, cookie: bob.cookie });
    expect(read.json.messages[0].content).toBe('Bob private message');
  });

  it('rejects foreign and missing fork sources without creating an empty conversation', async () => {
    const a = await project(alice);
    const b = await project(bob);
    const results = [];
    for (const source of [b.cid, randomUUID()]) {
      const response = await daemon.request({ method: 'POST', path: `/api/projects/${a.id}/conversations`, cookie: alice.cookie,
        body: { seedFromConversationId: source } });
      expect(response.status, response.text).toBe(404);
      results.push(response.json);
    }
    expect(results[0]).toEqual(results[1]);
    expect((await daemon.request({ path: `/api/projects/${a.id}/conversations`, cookie: alice.cookie })).json.conversations).toHaveLength(1);
  });

  it('keeps run admission and the standard transcript together and protects the assistant writer', async () => {
    const target = await project(alice);
    const run = await turn(alice, target, 'Accessible Studio');
    await daemon.request({ path: `/api/runs/${run.id}/events`, cookie: alice.cookie });
    const read = await daemon.request({ path: `/api/projects/${target.id}/conversations/${target.cid}/messages`, cookie: alice.cookie });
    expect(read.json.messages).toHaveLength(2);
    expect(read.json.messages[0]).toMatchObject({ id: run.userMessageId, role: 'user', content: 'Accessible Studio' });
    expect(read.json.messages[1]).toMatchObject({ id: run.assistantMessageId, role: 'assistant', runId: run.id, runStatus: 'succeeded' });
    const changed = await daemon.request({ method: 'PUT', path: `/api/projects/${target.id}/conversations/${target.cid}/messages/${run.assistantMessageId}`,
      cookie: alice.cookie, body: { role: 'user', content: 'Forged assistant output' } });
    expect(changed.json.message).toMatchObject({ role: 'assistant', runId: run.id, runStatus: 'succeeded' });
    expect(changed.json.message.content).not.toBe('Forged assistant output');
  });

  it('awaits isolated workers before deleting a conversation and leaves the other actor running', async () => {
    const a = await project(alice);
    const b = await project(bob);
    const ar = await turn(alice, a, 'cancel before deleting', 2_000);
    const br = await turn(bob, b, 'Bob continues', 350);
    const deleted = await daemon.request({ method: 'DELETE', path: `/api/projects/${a.id}/conversations/${a.cid}`, cookie: alice.cookie });
    expect(deleted.status, deleted.text).toBe(200);
    expect((await daemon.request({ path: `/api/runs/${ar.id}`, cookie: alice.cookie })).status).toBe(404);
    await daemon.request({ path: `/api/runs/${br.id}/events`, cookie: bob.cookie });
    expect((await daemon.request({ path: `/api/runs/${br.id}`, cookie: bob.cookie })).json.status).toBe('succeeded');
  });

  it('rejects forged run identity, ownership fields and host browser tabs', async () => {
    const { id, cid } = await project(alice);
    for (const body of [{ title: 'x', projectId: randomUUID() }, { title: 'x', ownerAccountId: bob.id }]) {
      expect((await daemon.request({ method: 'PATCH', path: `/api/projects/${id}/conversations/${cid}`,
        cookie: alice.cookie, body })).status).toBe(400);
    }
    for (const body of [{ role: 'user', content: 'x', runId: randomUUID() }, { role: 'system', content: 'x' }]) {
      expect((await daemon.request({ method: 'PUT', path: `/api/projects/${id}/conversations/${cid}/messages/${randomUUID()}`,
        cookie: alice.cookie, body })).status).toBe(400);
    }
    expect((await daemon.request({ method: 'PUT', path: `/api/projects/${id}/tabs`, cookie: alice.cookie,
      body: { tabs: [], browserTabs: [{ url: 'file:///etc/passwd' }] } })).status).toBe(400);
  });
});
