import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { cleanupIsolatedDataRoot, loadIsolatedServerModule, multiUserOptions, provisionAccounts,
  startMultiUserDaemon, type Principal, type StartedMultiUserDaemon } from './multiuser-harness.js';
import { PERSONAL_CODEX_MOCK, codexHome, linkCodex, setTurnMode } from './personal-codex-helpers.js';

const companyRequests: Array<Record<string, unknown>> = [];
let daemon: StartedMultiUserDaemon; let root: string; let a: Principal; let b: Principal; let admin: Principal;
beforeAll(async () => {
  ({ dataRoot: root } = await loadIsolatedServerModule());
  const global = path.join(root, 'design-systems', 'host-private');
  mkdirSync(global, { recursive: true });
  writeFileSync(path.join(global, 'DESIGN.md'), '# Host Private\nHOST_ONLY_DESIGN');
  daemon = await startMultiUserDaemon(multiUserOptions({ testPersonalCodexAppServer: PERSONAL_CODEX_MOCK,
    testCompanyOpenAIFetch: async (_url, init) => {
      companyRequests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response('data: ' + JSON.stringify({ type: 'response.completed', response: { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Company design completed.' }] }] } }) + '\n\n',
        { headers: { 'content-type': 'text/event-stream' } });
    } }));
  const accounts = await provisionAccounts(daemon, ['design-a', 'design-b']);
  [a, b] = accounts.users as [Principal, Principal]; admin = accounts.admin;
  await linkCodex(daemon, root, a, 'design-a@example.test');
}, 120_000);
afterAll(async () => { await daemon?.close(); cleanupIsolatedDataRoot(); });
async function create(body = '# Private\nDESIGN ORIGINAL MARKER', user = a) {
  const result = await daemon.request({ method: 'POST', path: '/api/design-systems', cookie: user.cookie, body: { title: 'Private', body } });
  expect(result.status, result.text).toBe(201); return result.json.designSystem.id as string;
}
async function target() {
  const projectId = randomUUID();
  const made = await daemon.request({ method: 'POST', path: '/api/projects', cookie: a.cookie, body: { id: projectId, name: 'Design version' } });
  expect(made.status).toBe(200); return { projectId, conversationId: made.json.conversationId as string };
}
async function run(context: Awaited<ReturnType<typeof target>>, extra: Record<string, unknown> = {}) {
  return daemon.request({ method: 'POST', path: '/api/runs', cookie: a.cookie, body: {
    ...context, message: 'Use selected design', agentId: 'codex', executionSource: 'personal_subscription', ...extra,
  } });
}
async function finish(id: string) { expect((await daemon.request({ path: `/api/runs/${id}/events`, cookie: a.cookie })).text).toContain('"status":"succeeded"'); }
it('serves only bundled catalogs and owner documents without global roots or host registry content', async () => {
  const id = await create(); const foreign = await create('B ONLY DESIGN', b);
  for (const user of [a, b, admin]) {
    const result = await daemon.request({ path: '/api/design-systems', cookie: user.cookie });
    expect(result.status, result.text).toBe(200); expect(result.text).not.toContain(root); expect(result.text).not.toContain('HOST_ONLY');
    expect(result.json.designSystems.filter((item: { source: string }) => item.source === 'user').map((item: { id: string }) => item.id))
      .toEqual(user === a ? [id] : user === b ? [foreign] : []);
  }
  for (const resource of ['design-templates', 'prompt-templates', 'craft']) {
    const response = await daemon.request({ path: `/api/${resource}`, cookie: a.cookie });
    expect(response.status, response.text).toBe(200); expect(response.text).not.toContain(root);
  }
  expect((await daemon.request({ path: `/api/design-systems/${id}/file?path=DESIGN.md`, cookie: a.cookie })).json.file.content).toContain('DESIGN ORIGINAL');
  expect((await daemon.request({ path: `/api/design-systems/${id}/file?path=../app.sqlite`, cookie: a.cookie })).status).toBe(404);
  for (const resource of ['preview', 'showcase']) {
    const response = await daemon.request({ path: `/api/design-systems/${id}/${resource}`, cookie: a.cookie });
    expect(response.status, response.text).toBe(200); expect(response.headers['content-security-policy']).toContain('sandbox');
    expect(response.headers['cache-control']).toContain('no-store');
  }
});
it('foreign documents are indistinguishable from missing for members and admin, on both API aliases', async () => {
  const id = await create();
  for (const user of [b, admin]) for (const prefix of ['/api/design-systems', '/api/multiuser/catalog/design-systems'])
    for (const [method, suffix, body] of [['GET', '', undefined], ['GET', '/revisions', undefined], ['GET', '/files', undefined],
      ['GET', '/file?path=DESIGN.md', undefined], ['GET', '/preview', undefined], ['GET', '/showcase', undefined],
      ['PATCH', '', { body: 'foreign' }], ['DELETE', '', {}]] as const) {
      const req = { method, cookie: user.cookie, ...(body ? { body } : {}) };
      const foreign = await daemon.request({ ...req, path: `${prefix}/${id}${suffix}` });
      const missing = await daemon.request({ ...req, path: `${prefix}/user:studio_${randomUUID()}${suffix}` });
      expect(foreign.status, foreign.text).toBe(404); expect(foreign.json).toEqual(missing.json);
    }
});
it('bounds document fields and rejects host authority, paths and built-in writes', async () => {
  for (const extra of [{ ownerId: b.id }, { source: 'built-in' }, { path: '/host' }, { provenance: {} }, { artifactMode: 'generated' },
    { body: 'a'.repeat(256001) }, { title: 123 }, { surface: 'native' }, { category: null }]) {
    expect((await daemon.request({ method: 'POST', path: '/api/design-systems', cookie: a.cookie, body: { title: 'x', body: 'x', ...extra } })).status).toBe(400);
  }
  const builtin = (await daemon.request({ path: '/api/design-systems', cookie: a.cookie })).json.designSystems.find((item: { source: string }) => item.source === 'built-in');
  for (const method of ['PATCH', 'DELETE']) expect((await daemon.request({ method, path: `/api/design-systems/${builtin.id}`, cookie: a.cookie,
    body: method === 'PATCH' ? { body: 'shadow' } : {} })).status).toBe(404);
});
it('captures immutable design text and continues the same version after edit and delete', async () => {
  const id = await create(); const context = await target();
  const first = await run(context, { designSystemId: id }); expect(first.status, first.text).toBe(202); await finish(first.json.runId);
  let evidence = JSON.parse(readFileSync(path.join(codexHome(root, a.id), 'mock-turn-evidence.json'), 'utf8'));
  expect(evidence.message).toContain('DESIGN ORIGINAL MARKER');
  expect((await daemon.request({ method: 'PATCH', path: `/api/design-systems/${id}`, cookie: a.cookie, body: { body: 'DESIGN REPLACEMENT MARKER' } })).status).toBe(200);
  const versions = await daemon.request({ path: `/api/design-systems/${id}/revisions`, cookie: a.cookie });
  expect(versions.json.revisions.map((version: { proposedBody: string }) => version.proposedBody)).toEqual(['# Private\nDESIGN ORIGINAL MARKER', 'DESIGN REPLACEMENT MARKER']);
  expect((await daemon.request({ method: 'DELETE', path: `/api/design-systems/${id}`, cookie: a.cookie, body: {} })).status).toBe(200);
  const other = await create('SECOND DESIGN');
  const switched = await run(context, { designSystemId: other }); expect(switched.status, switched.text).toBe(202); await finish(switched.json.runId);
  const second = await run(context, { designSystemId: id }); expect(second.status, second.text).toBe(202); await finish(second.json.runId);
  const db = new Database(path.join(root, 'app.sqlite'));
  try {
    const requests = db.prepare('SELECT request_json FROM multiuser_runs WHERE conversation_id = ? ORDER BY queue_seq').all(context.conversationId) as Array<{ request_json: string }>;
    expect(JSON.parse(requests[2]!.request_json).designSnapshot).toEqual(JSON.parse(requests[0]!.request_json).designSnapshot);
    expect(() => db.prepare('UPDATE studio_design_system_versions SET document_json = ? WHERE design_system_id = ?').run('{}', id)).toThrow('immutable');
  } finally { db.close(); }
  expect((await run(await target(), { designSystemId: id })).status).toBe(404);
  const foreign = await create('FOREIGN DESIGN', b);
  expect((await run(await target(), { designSystemId: foreign })).status).toBe(404);
});
it('question answers inherit the design version and reject a different selection', async () => {
  const id = await create(); const context = await target();
  setTurnMode(root, a, { reply: '<question-form id="brief">{"questions":[{"id":"color","label":"Color","type":"text"}]}</question-form>' });
  const source = await run(context, { designSystemId: id }); expect(source.status, source.text).toBe(202); await finish(source.json.runId);
  await daemon.request({ method: 'DELETE', path: `/api/design-systems/${id}`, cookie: a.cookie, body: {} });
  const extra = { analyticsHints: { entryFrom: 'question_answer', sourceRunId: source.json.runId } };
  expect((await run(context, { ...extra, designSystemId: await create('new') })).status).toBe(404);
  setTurnMode(root, a, {});
  const answer = await run(context, extra); expect(answer.status, answer.text).toBe(202); await finish(answer.json.runId);
});


it('selects only visible project design systems and clears the selection through the standard project API', async () => {
  const context = await target(); const id = await create(); const foreign = await create('foreign', b);
  const endpoint = `/api/projects/${context.projectId}`;
  const patch = (designSystemId: string | null) => daemon.request({ method: 'PATCH', path: endpoint, cookie: a.cookie, body: { designSystemId } });
  expect((await patch(foreign)).status).toBe(404);
  expect((await patch('user:studio_missing')).json).toEqual((await patch(foreign)).json);
  expect((await patch(id)).json.project.designSystemId).toBe(id);
  const first = await run(context); expect(first.status, first.text).toBe(202); await finish(first.json.runId);
  expect((await patch(null)).json.project.designSystemId).toBeNull();
  const cleared = await run(context); expect(cleared.status, cleared.text).toBe(202); await finish(cleared.json.runId);
  const evidence = JSON.parse(readFileSync(path.join(codexHome(root, a.id), 'mock-turn-evidence.json'), 'utf8'));
  expect(evidence.message).not.toContain('DESIGN ORIGINAL MARKER');
});
it('company admission captures the same design version while queued and after deletion', async () => {
  const current = await daemon.request({ path: '/api/admin/pool/openai', cookie: admin.cookie });
  const configure = (revision: number, capacity: number, apiKey?: string) => daemon.request({ method: 'PUT', path: '/api/admin/pool/openai', cookie: admin.cookie,
    body: { revision, capacity, enabled: true, model: 'fixture-model', ...(apiKey ? { apiKey } : {}) } });
  const configured = await configure(current.json.provider.revision, 0, 'sk-private-design-fixture-12345678901234567890');
  expect(configured.status, configured.text).toBe(200);
  const id = await create(); const context = await target();
  const queued = await run(context, { agentId: 'openai', executionSource: 'company_pool', designSystemId: id });
  expect(queued.status, queued.text).toBe(202);
  await daemon.request({ method: 'PATCH', path: `/api/design-systems/${id}`, cookie: a.cookie, body: { body: 'DESIGN REPLACEMENT MARKER' } });
  await daemon.request({ method: 'DELETE', path: `/api/design-systems/${id}`, cookie: a.cookie, body: {} });
  expect((await configure(configured.json.provider.revision, 1)).status).toBe(200);
  await finish(queued.json.runId);
  expect(JSON.stringify(companyRequests.at(-1)?.input)).toContain('DESIGN ORIGINAL MARKER');
  expect(JSON.stringify(companyRequests.at(-1)?.input)).not.toContain('DESIGN REPLACEMENT MARKER');
  const next = await run(context, { agentId: 'openai', executionSource: 'company_pool', designSystemId: id });
  expect(next.status, next.text).toBe(202); await finish(next.json.runId);
  expect(JSON.stringify(companyRequests.at(-1)?.input)).toContain('DESIGN ORIGINAL MARKER');
});


it('creates an owned project with formal setup and captures its default private skill and design system', async () => {
  const designSystemId = await create();
  const imported = await daemon.request({ method: 'POST', path: '/api/skills/import', cookie: a.cookie,
    body: { name: 'project-default-' + randomUUID(), body: 'PROJECT DEFAULT SKILL ORIGINAL' } });
  expect(imported.status, imported.text).toBe(201); const skillId = imported.json.skill.id as string;
  const metadata = { kind: 'prototype', fidelity: 'wireframe', platform: 'responsive',
    platformTargets: ['responsive', 'mobile-ios'], includeLandingPage: true, nameSource: 'user', slideCount: '8–12' };
  const projectId = randomUUID();
  const made = await daemon.request({ method: 'POST', path: '/api/projects', cookie: a.cookie,
    body: { id: projectId, name: 'Formal setup', skillId, designSystemId, metadata, pendingPrompt: 'Project brief' } });
  expect(made.status, made.text).toBe(200);
  expect(made.json.project).toMatchObject({ skillId, designSystemId, metadata, pendingPrompt: 'Project brief' });
  const context = { projectId, conversationId: made.json.conversationId as string };
  const first = await run(context); expect(first.status, first.text).toBe(202); await finish(first.json.runId);
  const evidence = JSON.parse(readFileSync(path.join(codexHome(root, a.id), 'mock-turn-evidence.json'), 'utf8'));
  expect(evidence.message).toContain('PROJECT DEFAULT SKILL ORIGINAL');
  expect(evidence.message).toContain('DESIGN ORIGINAL MARKER');
  await daemon.request({ method: 'PUT', path: '/api/skills/' + encodeURIComponent(skillId), cookie: a.cookie,
    body: { body: 'PROJECT DEFAULT SKILL REPLACEMENT' } });
  await daemon.request({ method: 'DELETE', path: '/api/skills/' + encodeURIComponent(skillId), cookie: a.cookie, body: {} });
  const continued = await run(context); expect(continued.status, continued.text).toBe(202); await finish(continued.json.runId);
  const db = new Database(path.join(root, 'app.sqlite'));
  try {
    const rows = db.prepare('SELECT request_json FROM multiuser_runs WHERE conversation_id = ? ORDER BY queue_seq').all(context.conversationId) as Array<{ request_json: string }>;
    const initial = JSON.parse(rows[0]!.request_json); const continuation = JSON.parse(rows[1]!.request_json);
    expect(continuation.skillSnapshots).toEqual(initial.skillSnapshots);
    expect(continuation.stablePrompt).toBe(initial.stablePrompt);
    expect(continuation.stablePrompt).toContain('PROJECT DEFAULT SKILL ORIGINAL');
    expect(continuation.stablePrompt).not.toContain('PROJECT DEFAULT SKILL REPLACEMENT');
  } finally { db.close(); }
  expect((await run(await target(), { skillId })).status).toBe(404);
});
it('refuses foreign or missing project resources before creation and validates descriptive metadata types', async () => {
  const foreign = await create('B private', b);
  const foreignSkill = await daemon.request({ method: 'POST', path: '/api/skills/import', cookie: b.cookie,
    body: { name: 'foreign-' + randomUUID(), body: 'B private' } });
  const createProject = (body: Record<string, unknown>) => daemon.request({ method: 'POST', path: '/api/projects', cookie: a.cookie,
    body: { id: randomUUID(), name: 'Rejected setup', ...body } });
  expect((await createProject({ designSystemId: foreign })).json).toEqual((await createProject({ designSystemId: 'user:studio_missing' })).json);
  expect((await createProject({ skillId: foreignSkill.json.skill.id })).json).toEqual((await createProject({ skillId: 'studio-skill:missing' })).json);
  expect((await createProject({ skillId: foreignSkill.json.skill.id })).status).toBe(404);
  for (const metadata of [{ platformTargets: ['/host'] }, { speakerNotes: 'true' }, { slideCount: 8 },
    { nameSource: {} }, { fidelity: [] }, { platform: {} }, { platformTargets: Array(9).fill('responsive') }]) {
    expect((await createProject({ metadata })).status).toBe(400);
  }
  for (const kind of ['prototype', 'deck', 'other']) {
    const made = await createProject({ metadata: { kind, nameSource: 'user', speakerNotes: kind === 'deck' } });
    expect(made.status, made.text).toBe(200); expect(made.json.project.metadata.kind).toBe(kind);
  }
});

it('inherits a default skill plus mentions on question answers without rereading deleted resources', async () => {
  const ids: string[] = [];
  for (const name of ['Default', 'Mention']) {
    const imported = await daemon.request({ method: 'POST', path: '/api/skills/import', cookie: a.cookie,
      body: { name: name + '-' + randomUUID(), body: name + ' question capture' } });
    expect(imported.status, imported.text).toBe(201); ids.push(imported.json.skill.id);
  }
  const projectId = randomUUID();
  const made = await daemon.request({ method: 'POST', path: '/api/projects', cookie: a.cookie,
    body: { id: projectId, name: 'Default question', skillId: ids[0] } });
  expect(made.status, made.text).toBe(200); const context = { projectId, conversationId: made.json.conversationId as string };
  setTurnMode(root, a, { reply: '<question-form id="brief">{"questions":[{"id":"color","label":"Color","type":"text"}]}</question-form>' });
  const source = await run(context, { skillIds: [ids[1]] }); expect(source.status, source.text).toBe(202); await finish(source.json.runId);
  for (const id of ids) await daemon.request({ method: 'DELETE', path: '/api/skills/' + encodeURIComponent(id), cookie: a.cookie, body: {} });
  const hints = { analyticsHints: { entryFrom: 'question_answer', sourceRunId: source.json.runId } };
  expect((await run(context, { ...hints, skillId: 'studio-skill:changed' })).status).toBe(409);
  setTurnMode(root, a, {});
  const answer = await run(context, { ...hints, skillId: ids[0] }); expect(answer.status, answer.text).toBe(202); await finish(answer.json.runId);
});
