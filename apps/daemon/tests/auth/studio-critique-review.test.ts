import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { syntheticGoodTranscript } from '../../src/critique/__fixtures__/adapters/synthetic-good.js';
import { PERSONAL_CODEX_MOCK, linkCodex, setTurnMode } from './personal-codex-helpers.js';
import { cleanupIsolatedDataRoot, loadIsolatedServerModule, login, multiUserOptions, provisionAccounts,
  startMultiUserDaemon, type Principal, type StartedMultiUserDaemon } from './multiuser-harness.js';
// Ported from the independent S66 review; diagnostic output remains fixture-only.
const note = (line: string) => console.info(line);

const gate = vi.hoisted(() => ({ wait: null as Promise<void> | null, entered: () => {} }));
vi.mock('../../src/critique/transcript.js', async (original) => {
  const module = await original<typeof import('../../src/critique/transcript.js')>();
  return { ...module, writeTranscript: async (...args: Parameters<typeof module.writeTranscript>) => {
    if (gate.wait) { gate.entered(); await gate.wait; }
    return module.writeTranscript(...args);
  } };
});

let daemon: StartedMultiUserDaemon; let root: string;
let a: Principal; let b: Principal; let admin: Principal;
let override: string | null = null;
const inputs: Array<Record<string, unknown>> = [];
const signals: AbortSignal[] = [];
const fixture: typeof fetch = async (_url, init) => {
  inputs.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
  if (init?.signal) signals.push(init.signal);
  const text = override ?? syntheticGoodTranscript();
  const output = [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }];
  return new Response([{ type: 'response.output_text.delta', delta: text },
    { type: 'response.completed', response: { output, usage: { input_tokens: 1, output_tokens: 1 } } }]
    .map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
};
async function settle(base: string, user: Principal) {
  for (let i = 0; i < 200; i++) {
    const s = await daemon.request({ path: base, cookie: user.cookie });
    if (s.status !== 200 || !['active', 'queued'].includes(s.json.status)) return s;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('run did not settle');
}
beforeAll(async () => {
  ({ dataRoot: root } = await loadIsolatedServerModule());
  daemon = await startMultiUserDaemon(multiUserOptions({ testCompanyOpenAIFetch: fixture, testPersonalCodexAppServer: PERSONAL_CODEX_MOCK }));
  const accounts = await provisionAccounts(daemon, ['rv-a', 'rv-b']);
  [a, b] = accounts.users as [Principal, Principal]; admin = accounts.admin;
  for (const user of [a, b]) expect((await daemon.request({ method: 'PUT', path: '/api/multiuser/settings/provider-keys/openai', cookie: user.cookie,
    body: { revision: 0, apiKey: `sk-review-${user.username}-0123456789abcdef` } })).status).toBe(200);
}, 120_000);
afterAll(async () => { await daemon?.close(); cleanupIsolatedDataRoot(); });

async function project(user: Principal) {
  const id = randomUUID();
  const made = await daemon.request({ method: 'POST', path: '/api/projects', cookie: user.cookie, body: { id, name: 'R' } });
  expect(made.status).toBe(200);
  return { id, conversationId: made.json.conversationId as string };
}

it.each(['rotate-key', 'logout-relogin'] as const)('R1 %s after an emitted SHIP leaves exactly one terminal state', async (mode) => {
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { gate.entered = resolve; });
  gate.wait = new Promise<void>((resolve) => { release = resolve; });
  const p = await project(a);
  try {
    const run = await daemon.request({ method: 'POST', path: `/api/projects/${p.id}/critique`, cookie: a.cookie,
      body: { conversationId: p.conversationId, agentId: 'openai-byok', message: 'Review' } });
    expect(run.status, run.text).toBe(202);
    const base = `/api/projects/${p.id}/critique/${run.json.runId}`;
    const ok = await Promise.race([entered.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 15000))]);
    if (!ok) {
      const st = await daemon.request({ path: base, cookie: a.cookie });
      const db = new Database(path.join(root, 'app.sqlite'), { readonly: true });
      try { note(`[R1 diag] status=${st.text} events=${JSON.stringify(db.prepare('SELECT seq,event FROM studio_critique_events WHERE run_id=?').all(run.json.runId))}`); } finally { db.close(); }
      release(); gate.wait = null; throw new Error('transcript gate not entered');
    }
    { const db = new Database(path.join(root, 'app.sqlite'), { readonly: true });
      try { note(`[R1 ${mode}] during pause events=${JSON.stringify(db.prepare('SELECT seq,event FROM studio_critique_events WHERE run_id=?').all(run.json.runId).map((r: any) => r.event).slice(-2))}`); } finally { db.close(); } }
    if (mode === 'rotate-key') {
      const keys = await daemon.request({ path: '/api/multiuser/settings/provider-keys', cookie: a.cookie });
      const rev = (keys.json.keys as Array<{ provider: string; revision: number }>).find((k) => k.provider === 'openai')!.revision;
      const put = await daemon.request({ method: 'PUT', path: '/api/multiuser/settings/provider-keys/openai', cookie: a.cookie,
        body: { revision: rev, apiKey: 'sk-review-rotated-0123456789abcdef' } });
      expect(put.status, put.text).toBe(200);
    } else {
      expect((await daemon.request({ method: 'POST', path: '/api/auth/logout', cookie: a.cookie, body: {} })).status).toBe(204);
      a.cookie = await login(daemon, a.username, a.password);
    }
    release(); gate.wait = null;
    const parent = await settle(base, a);
    const transcript = await daemon.request({ path: `${base}/transcript`, cookie: a.cookie });
    const types = (transcript.json.events as Array<{ type: string }>).map((e) => e.type);
    const artifact = await daemon.request({ path: `${base}/artifact`, cookie: a.cookie });
    note(`[R1 ${mode}] parent=${parent.json.status} critique=${parent.json.critique?.status} artifactAvailable=${parent.json.critique?.artifactAvailable} replayTail=${types.slice(-2).join(',')} artifactHTTP=${artifact.status}`);
    expect(types).toContain('ship');
    expect(parent.json.critique.status).toBe('shipped'); expect(artifact.status).toBe(200);
    expect(types.filter((type) => ['ship', 'interrupted', 'failed', 'degraded'].includes(type))).toHaveLength(1);
  } finally { release(); gate.wait = null; }
});

it('R2 list in a shared project returns only the caller\'s runs; edit member cannot read owner run', async () => {
  const p = await project(a);
  await daemon.request({ method: 'PUT', path: `/api/multiuser/projects/${p.id}/shares`, cookie: a.cookie, body: { username: b.username, role: 'edit' } });
  const run = await daemon.request({ method: 'POST', path: `/api/projects/${p.id}/critique`, cookie: a.cookie,
    body: { conversationId: p.conversationId, agentId: 'openai-byok', message: 'Secret jury prompt XYZZY' } });
  expect(run.status).toBe(202);
  await settle(`/api/projects/${p.id}/critique/${run.json.runId}`, a);
  const listB = await daemon.request({ path: `/api/projects/${p.id}/critique`, cookie: b.cookie });
  expect(listB.status).toBe(200); expect(listB.json.runs).toEqual([]);
  for (const s of ['', '/events', '/transcript', '/artifact']) expect((await daemon.request({ path: `/api/projects/${p.id}/critique/${run.json.runId}${s}`, cookie: b.cookie })).status).toBe(404);
  // B starting a Jury on A's conversation must be refused.
  const bOnA = await daemon.request({ method: 'POST', path: `/api/projects/${p.id}/critique`, cookie: b.cookie,
    body: { conversationId: p.conversationId, agentId: 'openai-byok', message: 'x' } });
  note(`[R2] B start on A conversation -> ${bOnA.status} ${bOnA.json?.error?.code}`);
  expect(bOnA.status).toBeGreaterThanOrEqual(400);
  // What does the shared conversation transcript show to the edit member?
  const msgs = await daemon.request({ path: `/api/projects/${p.id}/conversations/${p.conversationId}/messages`, cookie: b.cookie });
  note(`[R2] B GET A conversation messages -> ${msgs.status} containsPrompt=${msgs.text.includes('XYZZY')} containsArtifact=${msgs.text.includes('<ARTIFACT')}`);
  expect(msgs.status).toBe(200); expect(msgs.text).not.toContain('XYZZY');
  expect(msgs.text).not.toContain(run.json.runId); expect(msgs.json.messages).toEqual([]);
  const msgsA = await daemon.request({ path: `/api/projects/${p.id}/conversations/${p.conversationId}/messages`, cookie: a.cookie });
  expect(msgsA.json.messages).toEqual([]);
  note(`[R2] A GET own conversation messages -> ${msgsA.status} containsPrompt=${msgsA.text.includes('XYZZY')} containsArtifact=${msgsA.text.includes('<ARTIFACT')} body=${msgsA.text.slice(0, 600)}`);
});

it('R3 artifact headers and project deletion leaves no bytes under the data root', async () => {
  const p = await project(a);
  const run = await daemon.request({ method: 'POST', path: `/api/projects/${p.id}/critique`, cookie: a.cookie,
    body: { conversationId: p.conversationId, agentId: 'openai-byok', message: 'Review' } });
  const base = `/api/projects/${p.id}/critique/${run.json.runId}`;
  await settle(base, a);
  const art = await daemon.request({ path: `${base}/artifact`, cookie: a.cookie });
  note(`[R3] artifact ${art.status} ct=${art.headers['content-type']} csp=${art.headers['content-security-policy']} nosniff=${art.headers['x-content-type-options']}`);
  const dir = path.join(root, 'critique-artifacts', 'studio', a.id, p.id, run.json.runId);
  expect(existsSync(dir)).toBe(true);
  expect((await daemon.request({ method: 'DELETE', path: `/api/projects/${p.id}`, cookie: a.cookie })).status).toBeLessThan(300);
  const db = new Database(path.join(root, 'app.sqlite'));
  try {
    const rows = {
      run: db.prepare('SELECT COUNT(*) n FROM multiuser_runs WHERE id = ?').get(run.json.runId),
      critique: db.prepare('SELECT COUNT(*) n FROM critique_runs WHERE id = ?').get(run.json.runId),
      events: db.prepare('SELECT COUNT(*) n FROM studio_critique_events WHERE run_id = ?').get(run.json.runId),
    };
    note(`[R3] after project delete: dirExists=${existsSync(dir)} rows=${JSON.stringify(rows)}`);
  } finally { db.close(); }
  expect(existsSync(dir)).toBe(false);
});

it('R4 ordinary POST /api/runs with critique:true and cancel route parity', async () => {
  const p = await project(a);
  const run = await daemon.request({ method: 'POST', path: '/api/runs', cookie: a.cookie,
    body: { projectId: p.id, conversationId: p.conversationId, agentId: 'openai-byok', message: 'Review', critique: true } });
  expect(run.status).toBe(403); expect(run.json.error.code).toBe('MULTIUSER_CAPABILITY_UNAVAILABLE');
  if (run.status === 202) {
    const base = `/api/projects/${p.id}/critique/${run.json.runId}`;
    const s = await settle(base, a);
    note(`[R4] critique visible via jury route: ${s.status} critique=${s.json?.critique?.status}`);
  }
});

it('R5 SSE cursor and events for run in another project of same owner', async () => {
  const p1 = await project(a); const p2 = await project(a);
  const run = await daemon.request({ method: 'POST', path: `/api/projects/${p1.id}/critique`, cookie: a.cookie,
    body: { conversationId: p1.conversationId, agentId: 'openai-byok', message: 'Review' } });
  await settle(`/api/projects/${p1.id}/critique/${run.json.runId}`, a);
  for (const s of ['', '/events', '/transcript', '/artifact']) expect((await daemon.request({ path: `/api/projects/${p2.id}/critique/${run.json.runId}${s}`, cookie: a.cookie })).status).toBe(404);
  expect((await daemon.request({ method: 'POST', path: `/api/projects/${p2.id}/critique/${run.json.runId}/interrupt`, cookie: a.cookie })).status).toBe(404);
  const ev = await daemon.request({ path: `/api/projects/${p1.id}/critique/${run.json.runId}/events`, cookie: a.cookie, headers: { 'last-event-id': '999' } });
  note(`[R5] last-event-id 999 -> ${ev.status} ${ev.text.slice(0,200)}`);
  const evq = await daemon.request({ path: `/api/projects/${p1.id}/critique/${run.json.runId}/events?after=999`, cookie: a.cookie });
  note(`[R5] after=999 -> ${evq.status} ${evq.text.slice(0,200)}`);
  const ev2 = await daemon.request({ path: `/api/projects/${p1.id}/critique/${run.json.runId}/events?after=2`, cookie: a.cookie });
  expect(ev2.text.startsWith('id: 3')).toBe(true);
  // Conversation from another project in the body
  const cross = await daemon.request({ method: 'POST', path: `/api/projects/${p2.id}/critique`, cookie: a.cookie,
    body: { conversationId: p1.conversationId, agentId: 'openai-byok', message: 'x' } });
  note(`[R5] start with conversation of another project -> ${cross.status} ${cross.json?.error?.code}`);
  expect(cross.status).toBeGreaterThanOrEqual(400);
});


it.each(['openai-byok', 'openai'] as const)('R2 %s next ordinary turn carries no Jury history and Jury has only project read tools', async (agentId) => {
  if (agentId === 'openai') {
    const current = await daemon.request({ path: '/api/admin/pool/openai', cookie: admin.cookie });
    expect((await daemon.request({ method: 'PUT', path: '/api/admin/pool/openai', cookie: admin.cookie,
      body: { revision: current.json.provider.revision, enabled: true, capacity: 1, model: 'fixture-model', apiKey: 'sk-jury-company-fixture-0123456789' } })).status).toBe(200);
  }
  const p = await project(a);
  const before = inputs.length;
  const run = await daemon.request({ method: 'POST', path: `/api/projects/${p.id}/critique`, cookie: a.cookie,
    body: { conversationId: p.conversationId, agentId, message: 'PRIVATE_JURY_XYZZY' } });
  expect(run.status).toBe(202); await settle(`/api/projects/${p.id}/critique/${run.json.runId}`, a);
  const jury = inputs[before]!;
  const ordinary = await daemon.request({ method: 'POST', path: '/api/runs', cookie: a.cookie,
    body: { projectId: p.id, conversationId: p.conversationId, agentId, message: 'ORDINARY_AFTER_JURY' } });
  expect(ordinary.status).toBe(202);
  await daemon.request({ path: `/api/runs/${ordinary.json.runId}/events`, cookie: a.cookie });
  const next = inputs.at(-1)!;
  expect(JSON.stringify(next.input)).not.toContain('PRIVATE_JURY_XYZZY');
  expect(JSON.stringify(next.input)).not.toContain('<ARTIFACT');
  expect((jury.tools as Array<{ name: string }>).map((tool) => tool.name).sort()).toEqual(['list_project_files', 'read_project_file']);
});

it('R1 restart preserves a published SHIP even when the old writer crashed before finalizing metadata', async () => {
  const p = await project(a);
  const run = await daemon.request({ method: 'POST', path: `/api/projects/${p.id}/critique`, cookie: a.cookie,
    body: { conversationId: p.conversationId, agentId: 'openai-byok', message: 'Review' } });
  const base = `/api/projects/${p.id}/critique/${run.json.runId}`;
  await settle(base, a); await daemon.close();
  const db = new Database(path.join(root, 'app.sqlite'));
  try {
    db.prepare("UPDATE multiuser_runs SET status = 'active', critique_reconciled = 0 WHERE id = ?").run(run.json.runId);
    db.prepare("UPDATE critique_runs SET status = 'running', artifact_path = NULL WHERE id = ?").run(run.json.runId);
  } finally { db.close(); }
  daemon = await startMultiUserDaemon(multiUserOptions({ testCompanyOpenAIFetch: fixture, testPersonalCodexAppServer: PERSONAL_CODEX_MOCK }));
  expect((await daemon.request({ path: base, cookie: a.cookie })).json.critique.status).toBe('shipped');
  expect((await daemon.request({ path: `/api/runs/${run.json.runId}`, cookie: a.cookie })).json.status).toBe('succeeded');
  expect((await daemon.request({ path: `${base}/artifact`, cookie: a.cookie })).status).toBe(200);
  const replay = await daemon.request({ path: `${base}/transcript`, cookie: a.cookie });
  expect(replay.json.events.filter((event: { type: string }) => ['ship', 'interrupted', 'failed', 'degraded'].includes(event.type))).toHaveLength(1);
});
it('R2 personal Codex Jury never updates the conversation thread, and the next ordinary turn starts clean', async () => {
  await linkCodex(daemon, root, a, 'jury-private@example.test');
  setTurnMode(root, a, { reply: syntheticGoodTranscript() });
  const p = await project(a);
  const run = await daemon.request({ method: 'POST', path: `/api/projects/${p.id}/critique`, cookie: a.cookie,
    body: { conversationId: p.conversationId, agentId: 'codex', message: 'PRIVATE_NATIVE_JURY' } });
  await daemon.request({ path: `/api/projects/${p.id}/critique/${run.json.runId}/events`, cookie: a.cookie });
  const db = new Database(path.join(root, 'app.sqlite'), { readonly: true });
  try { expect((db.prepare('SELECT thread_id FROM multiuser_personal_sessions WHERE conversation_id = ?').get(p.conversationId) as { thread_id: string | null }).thread_id).toBeNull(); }
  finally { db.close(); }
  setTurnMode(root, a, {});
  const ordinary = await daemon.request({ method: 'POST', path: '/api/runs', cookie: a.cookie,
    body: { projectId: p.id, conversationId: p.conversationId, agentId: 'codex', message: 'ORDINARY_NATIVE' } });
  await daemon.request({ path: `/api/runs/${ordinary.json.runId}/events`, cookie: a.cookie });
  const result = await daemon.request({ path: `/api/runs/${ordinary.json.runId}`, cookie: a.cookie });
  expect(JSON.parse(result.json.output.text).turnsInThread).toBe(1);
  expect(JSON.parse(result.json.output.text).message).not.toContain('PRIVATE_NATIVE_JURY');
});
it.each(['deactivation', 'grant-revocation', 'project-delete'] as const)('R1 %s after SHIP keeps the terminal result and revokes reads', async (mode) => {
  const owner = mode === 'grant-revocation' ? b : a;
  const p = await project(a);
  if (mode === 'grant-revocation') {
    await daemon.request({ method: 'PUT', path: `/api/multiuser/projects/${p.id}/shares`, cookie: a.cookie, body: { username: b.username, role: 'edit' } });
    const conversation = await daemon.request({ method: 'POST', path: `/api/projects/${p.id}/conversations`, cookie: b.cookie, body: { title: 'Member Jury' } });
    p.conversationId = conversation.json.conversation.id;
  }
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { gate.entered = resolve; });
  gate.wait = new Promise<void>((resolve) => { release = resolve; });
  let runId = ''; let revocation: ReturnType<typeof daemon.request> | undefined; let deletion: ReturnType<typeof daemon.request> | undefined;
  try {
    const run = await daemon.request({ method: 'POST', path: `/api/projects/${p.id}/critique`, cookie: owner.cookie,
      body: { conversationId: p.conversationId, agentId: 'openai-byok', message: 'Review after SHIP' } });
    expect(run.status).toBe(202); runId = run.json.runId;
    await Promise.race([entered, new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('transcript gate not entered')), 15000); timer.unref();
    })]);
    const base = `/api/projects/${p.id}/critique/${runId}`;
    if (mode === 'deactivation') {
      expect((await daemon.request({ method: 'PATCH', path: `/api/auth/users/${a.id}`, cookie: admin.cookie, body: { active: false } })).status).toBe(200);
      expect((await daemon.request({ path: `${base}/artifact`, cookie: a.cookie })).status).toBe(401);
    } else if (mode === 'grant-revocation') {
      revocation = daemon.request({ method: 'DELETE', path: `/api/multiuser/projects/${p.id}/shares/${b.id}`, cookie: a.cookie });
      await vi.waitFor(() => expect(signals.at(-1)?.aborted).toBe(true), { timeout: 10000 });
    } else {
      deletion = daemon.request({ method: 'DELETE', path: `/api/projects/${p.id}`, cookie: a.cookie });
      await vi.waitFor(() => expect(signals.at(-1)?.aborted).toBe(true), { timeout: 10000 });
    }
    release(); gate.wait = null;
    if (revocation) {
      expect((await revocation).status).toBe(200);
      expect((await daemon.request({ path: `${base}/artifact`, cookie: b.cookie })).status).toBe(404);
    }
    if (deletion) {
      expect((await deletion).status).toBe(200);
      expect((await daemon.request({ path: base, cookie: owner.cookie })).status).toBe(404);
      expect(existsSync(path.join(root, 'critique-artifacts', 'studio', owner.id, p.id))).toBe(false);
    } else {
      const db = new Database(path.join(root, 'app.sqlite'), { readonly: true });
      try { await vi.waitFor(() => expect((db.prepare('SELECT status FROM multiuser_runs WHERE id = ?').get(runId) as { status: string }).status).not.toBe('active')); }
      finally { db.close(); }
      if (mode === 'deactivation') {
        await daemon.request({ method: 'PATCH', path: `/api/auth/users/${a.id}`, cookie: admin.cookie, body: { active: true } });
        a.cookie = await login(daemon, a.username, a.password);
      } else await daemon.request({ method: 'PUT', path: `/api/multiuser/projects/${p.id}/shares`, cookie: a.cookie, body: { username: b.username, role: 'edit' } });
      expect((await daemon.request({ path: base, cookie: owner.cookie })).json.critique.status).toBe('shipped');
      expect((await daemon.request({ path: `${base}/artifact`, cookie: owner.cookie })).status).toBe(200);
      const replay = await daemon.request({ path: `${base}/transcript`, cookie: owner.cookie });
      expect(replay.json.events.filter((event: { type: string }) => ['ship', 'interrupted', 'failed', 'degraded'].includes(event.type))).toHaveLength(1);
    }
  } finally {
    release(); gate.wait = null;
    if (mode === 'deactivation') {
      await daemon.request({ method: 'PATCH', path: `/api/auth/users/${a.id}`, cookie: admin.cookie, body: { active: true } });
      a.cookie = await login(daemon, a.username, a.password);
    }
  }
});
it('R3 boot purges private artifact directories for a deleted account', async () => {
  const p = await project(b);
  const run = await daemon.request({ method: 'POST', path: `/api/projects/${p.id}/critique`, cookie: b.cookie,
    body: { conversationId: p.conversationId, agentId: 'openai-byok', message: 'Review' } });
  await settle(`/api/projects/${p.id}/critique/${run.json.runId}`, b);
  const directory = path.join(root, 'critique-artifacts', 'studio', b.id);
  expect(existsSync(directory)).toBe(true);
  await daemon.close();
  // Accounts currently expose deactivation, not an HTTP delete action. Exercise
  // physical account removal as an offline recovery input, without inventing one.
  const auth = new Database(path.join(root, 'auth', 'auth.sqlite'));
  try { auth.prepare('DELETE FROM auth_accounts WHERE id = ?').run(b.id); } finally { auth.close(); }
  daemon = await startMultiUserDaemon(multiUserOptions({ testCompanyOpenAIFetch: fixture, testPersonalCodexAppServer: PERSONAL_CODEX_MOCK }));
  expect(existsSync(directory)).toBe(false);
});
