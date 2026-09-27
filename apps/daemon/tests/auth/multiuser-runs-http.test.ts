import { randomUUID } from 'node:crypto';
import { mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupIsolatedDataRoot, loadIsolatedServerModule, login, multiUserOptions,
  provisionAccounts, startMultiUserDaemon, type Principal, type StartedMultiUserDaemon,
} from './multiuser-harness.js';

let daemon: StartedMultiUserDaemon;
let alice: Principal;
let bob: Principal;
let admin: Principal;
let dataRoot: string;

async function project(user: Principal): Promise<{ id: string; conversationId: string }> {
  const id = randomUUID();
  const response = await daemon.request({ method: 'POST', path: '/api/projects', cookie: user.cookie, body: { id, name: id } });
  expect(response.status, response.text).toBe(200);
  return { id, conversationId: response.json.conversationId };
}

beforeAll(async () => {
  delete process.env.OD_API_TOKEN;
  delete process.env.OD_DISABLE_API_AUTH;
  ({ dataRoot } = await loadIsolatedServerModule());
  daemon = await startMultiUserDaemon(multiUserOptions({
    testMockAgentScript: path.resolve('../..', 'mocks/run-isolation-agent.ts'),
  }));
  const accounts = await provisionAccounts(daemon, ['run-alice', 'run-bob']);
  admin = accounts.admin;
  [alice, bob] = accounts.users as [Principal, Principal];
}, 120_000);

afterAll(async () => {
  await daemon?.close();
  cleanupIsolatedDataRoot();
});

describe('multi-user run isolation over HTTP', () => {
  it('binds a mock run to its owner and hides every read/cancel/stream from other actors', async () => {
    const p = await project(alice);
    const made = await daemon.request({ method: 'POST', path: '/api/runs', cookie: alice.cookie,
      body: { projectId: p.id, conversationId: p.conversationId, agentId: 'test-mock', message: 'alice-private' } });
    expect(made.status, made.text).toBe(202);
    const id = made.json.run.id;
    const db = new Database(path.join(dataRoot, 'app.sqlite'));
    try {
      expect(() => db.prepare('UPDATE multiuser_runs SET owner_account_id = ? WHERE id = ?').run(bob.id, id))
        .toThrow(/immutable/);
    } finally { db.close(); }
    const own = await daemon.request({ path: `/api/runs/${id}`, cookie: alice.cookie });
    expect(own.status).toBe(200);
    const stream = await daemon.request({ path: `/api/runs/${id}/events`, cookie: alice.cookie });
    expect(stream.status).toBe(200);
    for (const user of [bob, admin]) {
      for (const [method, suffix] of [['GET', ''], ['GET', '/events'], ['POST', '/cancel']] as const) {
        const hidden = await daemon.request({ method, path: `/api/runs/${id}${suffix}`, cookie: user.cookie });
        const missing = await daemon.request({ method, path: `/api/runs/${randomUUID()}${suffix}`, cookie: user.cookie });
        expect(hidden.status).toBe(404);
        expect(hidden.json).toEqual(missing.json);
      }
      const list = await daemon.request({ path: '/api/runs', cookie: user.cookie });
      expect(list.status).toBe(200);
      expect(JSON.stringify(list.json)).not.toContain(id);
    }
    const canceled = await daemon.request({ method: 'POST', path: `/api/runs/${id}/cancel`, cookie: alice.cookie });
    expect(canceled.status).toBe(200);
  });

  it('refuses real providers and a foreign conversation', async () => {
    const a = await project(alice);
    const b = await project(bob);
    const real = await daemon.request({ method: 'POST', path: '/api/runs', cookie: alice.cookie,
      body: { projectId: a.id, conversationId: a.conversationId, agentId: 'claude', message: 'x' } });
    expect(real.status).toBe(403);
    expect(real.json.error.code).toBe('MULTIUSER_AGENT_FORBIDDEN');
    const foreign = await daemon.request({ method: 'POST', path: '/api/runs', cookie: alice.cookie,
      body: { projectId: a.id, conversationId: b.conversationId, agentId: 'test-mock', message: 'x' } });
    expect(foreign.status).toBe(404);
  });

  it('keeps concurrent mock cwd, home, environment and events separate', async () => {
    const a = await project(alice);
    const b = await project(bob);
    process.env.MULTIUSER_TEST_API_KEY = 'PLANTED_HOST_SECRET';
    try {
      const [ar, br] = await Promise.all([
        daemon.request({ method: 'POST', path: '/api/runs', cookie: alice.cookie,
          body: { projectId: a.id, conversationId: a.conversationId, agentId: 'test-mock', message: 'alice-only', delayMs: 350 } }),
        daemon.request({ method: 'POST', path: '/api/runs', cookie: bob.cookie,
          body: { projectId: b.id, conversationId: b.conversationId, agentId: 'test-mock', message: 'bob-only', delayMs: 350 } }),
      ]);
      expect(ar.status, ar.text).toBe(202);
      expect(br.status, br.text).toBe(202);
      const [as, bs] = await Promise.all([
        daemon.request({ path: `/api/runs/${ar.json.run.id}/events`, cookie: alice.cookie }),
        daemon.request({ path: `/api/runs/${br.json.run.id}/events`, cookie: bob.cookie }),
      ]);
      expect(as.status).toBe(200);
      expect(bs.status).toBe(200);
      expect(as.text).toContain('alice-only');
      expect(as.text).not.toContain('bob-only');
      expect(bs.text).toContain('bob-only');
      expect(bs.text).not.toContain('alice-only');
      const [ad, bd] = await Promise.all([
        daemon.request({ path: `/api/runs/${ar.json.run.id}`, cookie: alice.cookie }),
        daemon.request({ path: `/api/runs/${br.json.run.id}`, cookie: bob.cookie }),
      ]);
      for (const [detail, p] of [[ad, a], [bd, b]] as const) {
        expect(detail.json.status).toBe('succeeded');
        expect(detail.json.output.cwd).toBe(path.join(dataRoot, 'projects', p.id));
        expect(statSync(detail.json.output.cwd).mode & 0o777).toBe(0o700);
        expect(detail.json.output.home).toContain(detail.json.id);
        expect(detail.json.output.temp).toContain(detail.json.id);
        expect(detail.json.output.dataRoot).toBe(dataRoot);
        expect(detail.json.output.plantedSecret).toBeNull();
        expect(detail.json.output.envKeys).not.toContain('MULTIUSER_TEST_API_KEY');
        expect(statSync(detail.json.output.home).mode & 0o777).toBe(0o700);
      }
    } finally { delete process.env.MULTIUSER_TEST_API_KEY; }
  });

  it('rejects escaped input larger than the child stdin budget before spawning', async () => {
    const a = await project(alice);
    const before = await daemon.request({ path: '/api/runs', cookie: alice.cookie });
    // JSON escapes each control character into six bytes, even though the
    // JavaScript string remains below the character-count limit.
    const oversized = await daemon.request({ method: 'POST', path: '/api/runs', cookie: alice.cookie,
      body: { projectId: a.id, conversationId: a.conversationId, agentId: 'test-mock', message: '\u0001'.repeat(64_000) } });
    expect(oversized.status).toBe(400);
    expect(oversized.json.error.code).toBe('BAD_REQUEST');
    const listed = await daemon.request({ path: '/api/runs', cookie: alice.cookie });
    expect(listed.json.runs).toHaveLength(before.json.runs.length);
  });

  it('cancels one active run without changing another actor\'s concurrent run', async () => {
    const a = await project(alice);
    const b = await project(bob);
    const [ar, br] = await Promise.all([
      daemon.request({ method: 'POST', path: '/api/runs', cookie: alice.cookie,
        body: { projectId: a.id, conversationId: a.conversationId, agentId: 'test-mock', message: 'cancel-a', delayMs: 2000 } }),
      daemon.request({ method: 'POST', path: '/api/runs', cookie: bob.cookie,
        body: { projectId: b.id, conversationId: b.conversationId, agentId: 'test-mock', message: 'keep-b', delayMs: 350 } }),
    ]);
    expect(ar.status).toBe(202);
    expect(br.status).toBe(202);
    const canceled = await daemon.request({ method: 'POST', path: `/api/runs/${ar.json.run.id}/cancel`, cookie: alice.cookie });
    expect(canceled.status).toBe(200);
    expect(canceled.json.status).toBe('canceled');
    const bEvents = await daemon.request({ path: `/api/runs/${br.json.run.id}/events`, cookie: bob.cookie });
    expect(bEvents.text).toContain('keep-b');
    expect((await daemon.request({ path: `/api/runs/${br.json.run.id}`, cookie: bob.cookie })).json.status).toBe('succeeded');
  });

  it('refuses imported folders, resume options and another actor\'s native session conversation', async () => {
    const a = await project(alice);
    const b = await project(bob);
    const foreign = await daemon.request({ method: 'POST', path: '/api/runs', cookie: alice.cookie,
      body: { projectId: a.id, conversationId: b.conversationId, agentId: 'test-mock', message: 'resume', resume: true } });
    expect(foreign.status).toBe(403);
    const db = new Database(path.join(dataRoot, 'app.sqlite'));
    try {
      db.prepare('INSERT INTO agent_sessions (conversation_id, agent_id, session_id, updated_at) VALUES (?, ?, ?, ?)')
        .run(b.conversationId, 'test-mock', 'bob-native-session', Date.now());
      const cross = await daemon.request({ method: 'POST', path: '/api/runs', cookie: alice.cookie,
        body: { projectId: a.id, conversationId: b.conversationId, agentId: 'test-mock', message: 'resume' } });
      expect(cross.status).toBe(404);
      const external = path.join(dataRoot, 'imported-fixture');
      mkdirSync(external);
      db.prepare('UPDATE projects SET metadata_json = ? WHERE id = ?').run(JSON.stringify({ baseDir: external }), a.id);
      const imported = await daemon.request({ method: 'POST', path: '/api/runs', cookie: alice.cookie,
        body: { projectId: a.id, conversationId: a.conversationId, agentId: 'test-mock', message: 'x' } });
      expect(imported.status).toBe(403);
      expect(imported.json.error.code).toBe('MULTIUSER_IMPORTED_PROJECT_FORBIDDEN');
    } finally { db.close(); }
  });

  it('revocation cancels only the target actor\'s active run', async () => {
    const a = await project(alice);
    const b = await project(bob);
    const [ar, br] = await Promise.all([
      daemon.request({ method: 'POST', path: '/api/runs', cookie: alice.cookie,
        body: { projectId: a.id, conversationId: a.conversationId, agentId: 'test-mock', message: 'a', delayMs: 2000 } }),
      daemon.request({ method: 'POST', path: '/api/runs', cookie: bob.cookie,
        body: { projectId: b.id, conversationId: b.conversationId, agentId: 'test-mock', message: 'b', delayMs: 300 } }),
    ]);
    expect(ar.status).toBe(202);
    expect(br.status).toBe(202);
    const revoked = await daemon.request({ method: 'POST', path: `/api/auth/users/${alice.id}/sessions/revoke`, cookie: admin.cookie, body: {} });
    expect(revoked.status).toBe(200);
    expect((await daemon.request({ path: `/api/runs/${ar.json.run.id}`, cookie: admin.cookie })).status).toBe(404);
    alice.cookie = await login(daemon, alice.username, alice.password);
    expect((await daemon.request({ path: `/api/runs/${ar.json.run.id}`, cookie: alice.cookie })).json.status).toBe('canceled');
    const done = await daemon.request({ path: `/api/runs/${br.json.run.id}/events`, cookie: bob.cookie });
    expect(done.status).toBe(200);
    expect((await daemon.request({ path: `/api/runs/${br.json.run.id}`, cookie: bob.cookie })).json.status).toBe('succeeded');
    const second = await daemon.request({ method: 'POST', path: '/api/runs', cookie: alice.cookie,
      body: { projectId: a.id, conversationId: a.conversationId, agentId: 'test-mock', message: 'disabled', delayMs: 2000 } });
    expect(second.status).toBe(202);
    const disabled = await daemon.request({ method: 'PATCH', path: `/api/auth/users/${alice.id}`, cookie: admin.cookie, body: { active: false } });
    expect(disabled.status).toBe(200);
    expect((await daemon.request({ path: `/api/runs/${second.json.run.id}`, cookie: alice.cookie })).status).toBe(401);
    const enabled = await daemon.request({ method: 'PATCH', path: `/api/auth/users/${alice.id}`, cookie: admin.cookie, body: { active: true } });
    expect(enabled.status).toBe(200);
    alice.cookie = await login(daemon, alice.username, alice.password);
    expect((await daemon.request({ path: `/api/runs/${second.json.run.id}`, cookie: alice.cookie })).json.status).toBe('canceled');
  });

  it('recovers in-flight rows on restart without changing another actor\'s terminal run', async () => {
    alice.cookie = await login(daemon, alice.username, alice.password);
    const a = await project(alice);
    const b = await project(bob);
    const complete = await daemon.request({ method: 'POST', path: '/api/runs', cookie: bob.cookie,
      body: { projectId: b.id, conversationId: b.conversationId, agentId: 'test-mock', message: 'complete' } });
    expect(complete.status).toBe(202);
    await daemon.request({ path: `/api/runs/${complete.json.run.id}/events`, cookie: bob.cookie });
    const interrupted = await daemon.request({ method: 'POST', path: '/api/runs', cookie: alice.cookie,
      body: { projectId: a.id, conversationId: a.conversationId, agentId: 'test-mock', message: 'interrupted', delayMs: 2000 } });
    expect(interrupted.status).toBe(202);
    await daemon.close();
    daemon = await startMultiUserDaemon(multiUserOptions({ testMockAgentScript: path.resolve('../..', 'mocks/run-isolation-agent.ts') }));
    const failed = await daemon.request({ path: `/api/runs/${interrupted.json.run.id}`, cookie: alice.cookie });
    const intact = await daemon.request({ path: `/api/runs/${complete.json.run.id}`, cookie: bob.cookie });
    expect(failed.json.status).toBe('failed');
    expect(intact.json.status).toBe('succeeded');
  });
});
