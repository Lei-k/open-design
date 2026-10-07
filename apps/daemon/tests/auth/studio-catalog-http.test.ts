import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { cleanupIsolatedDataRoot, loadIsolatedServerModule, multiUserOptions, provisionAccounts,
  startMultiUserDaemon, type Principal, type StartedMultiUserDaemon } from './multiuser-harness.js';
import { PERSONAL_CODEX_MOCK, codexHome, linkCodex, setTurnMode, until } from './personal-codex-helpers.js';

let daemon: StartedMultiUserDaemon;
let root: string;
let a: Principal;
let b: Principal;
let admin: Principal;
beforeAll(async () => {
  ({ dataRoot: root } = await loadIsolatedServerModule());
  const global = path.join(root, 'skills', 'host-private');
  mkdirSync(global, { recursive: true });
  writeFileSync(path.join(global, 'SKILL.md'), '---\nname: Host Private\ndescription: HOST_PRIVATE_MARKER\n---\nHOST_PRIVATE_BODY');
  daemon = await startMultiUserDaemon(multiUserOptions({ testPersonalCodexAppServer: PERSONAL_CODEX_MOCK }));
  const accounts = await provisionAccounts(daemon, ['catalog-a', 'catalog-b']);
  [a, b] = accounts.users as [Principal, Principal]; admin = accounts.admin;
  await linkCodex(daemon, root, a, 'catalog-a@example.test');
}, 120_000);
afterAll(async () => { await daemon?.close(); cleanupIsolatedDataRoot(); });

async function skill(name: string, body: string, user = a) {
  const result = await daemon.request({ method: 'POST', path: '/api/skills/import', cookie: user.cookie, body: { name, body } });
  expect(result.status, result.text).toBe(201);
  return result.json.skill.id as string;
}
async function project() {
  const projectId = randomUUID();
  const result = await daemon.request({ method: 'POST', path: '/api/projects', cookie: a.cookie, body: { id: projectId, name: 'Private skills' } });
  expect(result.status).toBe(200);
  return { projectId, conversationId: result.json.conversationId as string };
}
async function run(target: Awaited<ReturnType<typeof project>>, message: string, extra: Record<string, unknown> = {}) {
  return daemon.request({ method: 'POST', path: '/api/runs', cookie: a.cookie, body: {
    ...target, message, agentId: 'codex', executionSource: 'personal_subscription', ...extra,
  } });
}
async function finish(id: string) {
  const events = await daemon.request({ path: `/api/runs/${id}/events`, cookie: a.cookie });
  expect(events.text).toContain('"status":"succeeded"');
}

it('serves bundled inspection and only the actor’s private skills without host paths or host-installed content', async () => {
  const id = await skill('Shared name', 'A_PRIVATE_MARKER');
  const other = await skill('Shared name', 'B_PRIVATE_MARKER', b);
  expect(other).not.toBe(id);
  for (const user of [a, b, admin]) {
    const result = await daemon.request({ path: '/api/skills', cookie: user.cookie });
    expect(result.status).toBe(200);
    expect(result.text).not.toContain(root);
    expect(result.text).not.toContain('HOST_PRIVATE');
    const privateIds = result.json.skills.filter((item: { source: string }) => item.source === 'user').map((item: { id: string }) => item.id);
    expect(privateIds).toEqual(user === a ? [id] : user === b ? [other] : []);
    const builtins = result.json.skills.filter((item: { source: string }) => item.source === 'built-in');
    expect(builtins.length).toBeGreaterThan(0);
    expect(builtins.every((item: { selectable: boolean }) => item.selectable === true)).toBe(true);
  }
  expect((await daemon.request({ path: `/api/skills/${encodeURIComponent(id)}`, cookie: a.cookie })).json.body).toBe('A_PRIVATE_MARKER');
  expect((await daemon.request({ path: `/api/skills/${encodeURIComponent(id)}/files`, cookie: a.cookie })).json.files)
    .toEqual([{ path: 'SKILL.md', kind: 'file', size: 16 }]);
  for (const user of [b, admin]) for (const [method, suffix, body] of [
    ['GET', '', undefined], ['GET', '/files', undefined], ['PUT', '', { body: 'foreign edit' }], ['DELETE', '', {}],
  ] as const) {
    const request = { method, cookie: user.cookie, ...(body ? { body } : {}) };
    const foreign = await daemon.request({ ...request, path: `/api/skills/${encodeURIComponent(id)}${suffix}` });
    const missing = await daemon.request({ ...request, path: `/api/skills/${encodeURIComponent('studio-skill:' + randomUUID())}${suffix}` });
    expect(foreign.status).toBe(404);
    expect(foreign.json).toEqual(missing.json);
  }
});

it('captures bundled references for the selected conversation and stages the same immutable bytes on later turns', async () => {
  const id = 'writing-guidelines';
  const detail = await daemon.request({ path: `/api/skills/${id}`, cookie: a.cookie });
  expect(detail.status, detail.text).toBe(200);
  expect(detail.text).not.toContain('Skill root (absolute fallback)');
  expect(detail.text).not.toContain(path.resolve('../..', 'skills'));
  expect(detail.json).not.toHaveProperty('package');
  const target = await project();
  const admitted = await run(target, 'Use the captured writing rules', { skillIds: [id] });
  expect(admitted.status, admitted.text).toBe(202); await finish(admitted.json.runId);
  const db = new Database(path.join(root, 'app.sqlite'));
  try {
    const capture = (runId: string) => JSON.parse((db.prepare('SELECT request_json FROM multiuser_runs WHERE id = ?').get(runId) as { request_json: string }).request_json).skillSnapshots[0];
    const original = capture(admitted.json.runId);
    expect(original.package.files.some((file: { path: string }) => file.path === 'references/guidelines.md')).toBe(true);
    const staged = path.join(root, 'multiuser-runtime', (await import('node:crypto')).createHash('sha256').update(a.id).digest('hex'), admitted.json.runId, 'skill-packages', original.package.key, 'references/guidelines.md');
    const captured = original.package.files.find((file: { path: string }) => file.path === 'references/guidelines.md');
    expect(readFileSync(staged).toString('base64')).toBe(captured.data);
    const continued = await run(target, 'Continue using the same revision', { skillIds: [id] });
    expect(continued.status).toBe(202); await finish(continued.json.runId);
    expect(capture(continued.json.runId)).toEqual(original);
    expect((await daemon.request({ path: `/api/runs/${admitted.json.runId}`, cookie: b.cookie })).status).toBe(404);
  } finally { db.close(); }
});

it('rejects body authority and host-install fields, and does not permit bundled mutation', async () => {
  for (const extra of [{ ownerId: b.id }, { source: 'built-in' }, { dir: '/host' }, { path: '../escape' }]) {
    const result = await daemon.request({ method: 'POST', path: '/api/skills/import', cookie: a.cookie,
      body: { name: 'Injected', body: 'text', ...extra } });
    expect(result.status).toBe(400);
  }
  expect((await daemon.request({ method: 'POST', path: '/api/skills/import', cookie: a.cookie, body: { body: 'text' } })).status).toBe(400);
  const listed = await daemon.request({ path: '/api/skills', cookie: a.cookie });
  const builtin = listed.json.skills.find((item: { source: string }) => item.source === 'built-in');
  expect((await daemon.request({ method: 'PUT', path: `/api/skills/${builtin.id}`, cookie: a.cookie, body: { body: 'override' } })).status).toBe(404);
  expect((await daemon.request({ method: 'DELETE', path: `/api/skills/${builtin.id}`, cookie: a.cookie, body: {} })).status).toBe(404);
});

it('executes the admitted skill text even when a queued skill is edited and deleted before execution', async () => {
  const first = await run(await project(), '[mock-delay-ms=5000] occupy worker');
  expect(first.status).toBe(202);
  await until(() => daemon.request({ path: `/api/runs/${first.json.runId}`, cookie: a.cookie }), (r) => r.json.status === 'running');
  const id = await skill('Queued skill', 'QUEUED_ORIGINAL_MARKER');
  const target = await project();
  const queued = await run(target, 'execute captured skill', { context: { skillIds: [id] } });
  expect(queued.status, queued.text).toBe(202);
  expect((await daemon.request({ path: `/api/runs/${queued.json.runId}`, cookie: a.cookie })).json.status).toBe('queued');
  expect((await daemon.request({ method: 'PUT', path: `/api/skills/${encodeURIComponent(id)}`, cookie: a.cookie, body: { body: 'QUEUED_REPLACEMENT_MARKER' } })).status).toBe(200);
  expect((await daemon.request({ method: 'DELETE', path: `/api/skills/${encodeURIComponent(id)}`, cookie: a.cookie, body: {} })).status).toBe(200);
  await finish(first.json.runId);
  await finish(queued.json.runId);
  const evidence = JSON.parse(readFileSync(path.join(codexHome(root, a.id), 'mock-turn-evidence.json'), 'utf8'));
  expect(evidence.message).toContain('QUEUED_ORIGINAL_MARKER');
  expect(evidence.message).not.toContain('QUEUED_REPLACEMENT_MARKER');
  const db = new Database(path.join(root, 'app.sqlite'));
  try {
    expect(db.prepare('SELECT body FROM studio_skill_revisions WHERE skill_id = ? ORDER BY revision').all(id))
      .toEqual([{ body: 'QUEUED_ORIGINAL_MARKER' }, { body: 'QUEUED_REPLACEMENT_MARKER' }]);
    expect(() => db.prepare('UPDATE studio_skill_revisions SET body = ? WHERE skill_id = ?').run('tamper', id)).toThrow('immutable');
  } finally { db.close(); }
  const continued = await run(target, 'captured deleted skill', { skillIds: [id] });
  expect(continued.status, continued.text).toBe(202); await finish(continued.json.runId);
  expect((await run(await project(), 'deleted skill in a new conversation', { skillIds: [id] })).status).toBe(404);
}, 20_000);

it('continues a question on its captured skill and native thread after the skill is deleted', async () => {
  const id = await skill('Question skill', 'QUESTION_ORIGINAL_MARKER');
  const target = await project();
  setTurnMode(root, a, { reply: '<question-form id="brief">{"questions":[{"id":"color","label":"Color","type":"text"}]}</question-form>' });
  const source = await run(target, 'ask about color', { skillIds: [id] });
  expect(source.status).toBe(202);
  await finish(source.json.runId);
  expect((await daemon.request({ method: 'DELETE', path: `/api/skills/${encodeURIComponent(id)}`, cookie: a.cookie, body: {} })).status).toBe(200);
  setTurnMode(root, a, {});
  const answer = await run(target, '[form answers — brief]\nColor: blue', { analyticsHints: { entryFrom: 'question_answer', sourceRunId: source.json.runId } });
  expect(answer.status, answer.text).toBe(202);
  await finish(answer.json.runId);
  const first = await daemon.request({ path: `/api/runs/${source.json.runId}`, cookie: a.cookie });
  const next = await daemon.request({ path: `/api/runs/${answer.json.runId}`, cookie: a.cookie });
  expect(next.json.output.threadId).toBe(first.json.output.threadId);
});

it('rejects another actor’s selection and bounds the combined top-level and context selections before admission', async () => {
  const foreign = await skill('Foreign only', 'B_ONLY', b);
  const target = await project();
  const refused = await run(target, 'foreign', { skillIds: [foreign] });
  const missing = await run(target, 'missing', { skillIds: ['studio-skill:' + randomUUID()] });
  expect(refused.status).toBe(404);
  expect(refused.json).toEqual(missing.json);
  const tooMany = await run(target, 'too many', { skillIds: Array.from({ length: 12 }, (_, i) => `a${i}`), context: { skillIds: ['b'] } });
  expect(tooMany.status).toBe(400);
});

async function folder(entries: Array<[string, string | Buffer]>, user: Principal | null = a) {
  const boundary = 'studio-skill-folder-boundary';
  const body = Buffer.concat(entries.flatMap(([name, content]) => [
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    Buffer.isBuffer(content) ? content : Buffer.from(content), Buffer.from('\r\n')]).concat(Buffer.from(`--${boundary}--\r\n`)));
  return daemon.request({ method: 'POST', path: '/api/skills/import-files', ...(user ? { cookie: user.cookie } : {}),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, rawBody: body });
}

it('imports a private skill folder as an immutable package that runs with its side files', async () => {
  const logo = Buffer.from([0, 159, 146, 150, 255]);
  const made = await folder([
    ['brand-kit/SKILL.md', '---\nname: Brand kit folder\ndescription: Folder import\n---\nUse assets/logo.bin and FOLDER_SKILL_MARKER.'],
    ['brand-kit/assets/logo.bin', logo],
    ['brand-kit/scripts/build.py', 'print("ok")'],
  ]);
  expect(made.status, made.text).toBe(201);
  expect(made.json.skill).toMatchObject({ name: 'Brand kit folder', description: 'Folder import', source: 'user' });
  const id = made.json.skill.id as string;
  const files = await daemon.request({ path: `/api/skills/${encodeURIComponent(id)}/files`, cookie: a.cookie });
  expect(files.json.files.map((file: { path: string }) => file.path).sort()).toEqual(['SKILL.md', 'assets/logo.bin', 'scripts/build.py']);
  expect((await daemon.request({ path: `/api/skills/${encodeURIComponent(id)}`, cookie: b.cookie })).status).toBe(404);
  expect((await daemon.request({ path: `/api/skills/${encodeURIComponent(id)}/files`, cookie: b.cookie })).status).toBe(404);
  expect(JSON.stringify((await daemon.request({ path: '/api/skills', cookie: b.cookie })).json)).not.toContain('Brand kit folder');

  const target = await project();
  const started = await run(target, 'use the folder skill', { skillIds: [id] });
  expect(started.status, started.text).toBe(202);
  await finish(started.json.runId);
  const evidence = JSON.parse(readFileSync(path.join(codexHome(root, a.id), 'mock-turn-evidence.json'), 'utf8'));
  expect(evidence.message).toContain('FOLDER_SKILL_MARKER');
  expect(evidence.message).toMatch(new RegExp(`- ${id}: /\\S+/skill-packages/[0-9a-f]{32}`));

  // A text edit keeps side files and rewrites the package's SKILL.md; the earlier revision is unchanged.
  expect((await daemon.request({ method: 'PUT', path: `/api/skills/${encodeURIComponent(id)}`, cookie: a.cookie, body: { body: 'EDITED_FOLDER_BODY' } })).status).toBe(200);
  const db = new Database(path.join(root, 'app.sqlite'));
  try {
    const revisions = (db.prepare('SELECT package_json FROM studio_skill_revisions WHERE skill_id = ? ORDER BY revision').all(id) as Array<{ package_json: string }>)
      .map((row) => JSON.parse(row.package_json) as { files: Array<{ path: string; data: string }> });
    const document = (index: number) => Buffer.from(revisions[index]!.files.find((file) => file.path === 'SKILL.md')!.data, 'base64').toString();
    expect(document(0)).toContain('FOLDER_SKILL_MARKER');
    expect(document(1)).toContain('EDITED_FOLDER_BODY');
    expect(Buffer.from(revisions[1]!.files.find((file) => file.path === 'assets/logo.bin')!.data, 'base64')).toEqual(logo);
  } finally { db.close(); }
  expect((await folder([['again/SKILL.md', '---\nname: Brand kit folder\n---\nduplicate']])).status).toBe(409);
}, 20_000);

it('refuses skill folders without SKILL.md, with hidden or traversal paths, or without a session', async () => {
  expect((await folder([['kit/readme.md', 'no skill']])).status).toBe(400);
  expect((await folder([['kit/SKILL.md', 'body'], ['kit/.env', 'SECRET=1']])).status).toBe(400);
  expect((await folder([['kit/SKILL.md', 'body'], ['kit/../escape.md', 'x']])).status).toBe(400);
  expect((await folder([['kit/SKILL.md', '---\nname: Empty\n---\n']])).status).toBe(400);
  expect((await folder([['kit/SKILL.md', 'body']], null)).status).toBe(401);
});

it('applies an allowed per-turn Codex model and effort, and refuses unknown choices and company overrides', async () => {
  const target = await project();
  const chosen = await run(target, 'use a chosen model', { model: 'gpt-5.4', reasoning: 'high' });
  expect(chosen.status, chosen.text).toBe(202);
  await finish(chosen.json.runId);
  const evidence = JSON.parse(readFileSync(path.join(codexHome(root, a.id), 'mock-turn-evidence.json'), 'utf8'));
  expect(evidence).toMatchObject({ model: 'gpt-5.4', effort: 'high' });
  const defaulted = await run(target, 'account default', { model: 'default', reasoning: null });
  expect(defaulted.status, defaulted.text).toBe(202);
  await finish(defaulted.json.runId);
  const second = JSON.parse(readFileSync(path.join(codexHome(root, a.id), 'mock-turn-evidence.json'), 'utf8'));
  expect(second.model).toBeUndefined();
  expect(second.effort).toBeUndefined();
  for (const extra of [{ model: 'gpt-unknown' }, { reasoning: 'max' }, { model: 42 }]) {
    expect((await run(target, 'refused choice', extra)).status).toBe(400);
  }
  expect((await run(target, 'tier stays default only', { serviceTier: 'fast' })).status).toBe(403);
});

it('persists the account Codex model preference with revision checks and keeps it private', async () => {
  const current = await daemon.request({ path: '/api/app-config', cookie: a.cookie });
  expect(current.json.config.codexModel).toEqual({ model: 'default', reasoning: 'default' });
  const saved = await daemon.request({ method: 'PUT', path: '/api/app-config', cookie: a.cookie,
    body: { revision: current.json.revision, codexModel: { model: 'gpt-5.5', reasoning: 'medium' } } });
  expect(saved.status, saved.text).toBe(200);
  expect(saved.json.config.codexModel).toEqual({ model: 'gpt-5.5', reasoning: 'medium' });
  expect((await daemon.request({ path: '/api/app-config', cookie: b.cookie })).json.config.codexModel).toEqual({ model: 'default', reasoning: 'default' });
  for (const codexModel of [{ model: 'gpt-unknown', reasoning: 'low' }, { model: 'gpt-5.5' }, { model: 'gpt-5.5', reasoning: 'low', extra: 1 }]) {
    expect((await daemon.request({ method: 'PUT', path: '/api/app-config', cookie: a.cookie, body: { revision: saved.json.revision, codexModel } })).status).toBe(400);
  }
  const reset = await daemon.request({ method: 'PUT', path: '/api/app-config', cookie: a.cookie, body: { revision: saved.json.revision, codexModel: null } });
  expect(reset.json.config.codexModel).toEqual({ model: 'default', reasoning: 'default' });
});
