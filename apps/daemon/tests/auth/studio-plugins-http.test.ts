// S41 (#61): the bundled plugin catalog and apply for Studio accounts.
//
// - Every Studio account reads the same bundled catalog. Each plugin carries
//   `availability`, computed from one Web capability registry against the
//   plugin's declared pipeline, atoms, strategy and context; nothing is
//   hard-coded per plugin and nothing that cannot run is applied.
// - Apply is owner-only onto the actor's own project and captures an
//   immutable snapshot there. Removing or upgrading the bundled plugin never
//   changes that project, an admitted run or a conversation pin.
// - Host-global install/upgrade/uninstall, marketplace fetch, doctor and trust
//   are refused with the typed capability code.
// - Finite ordered stages execute on each pinned source; questions pause and
//   resume the unfinished stage. A no-pipeline test fixture isolates pin tests.
//   A turn whose plugin choice read the live
//   project pin, empty or not, is refused when the pin changes before its
//   commit, on every execution source (F2).
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupIsolatedDataRoot, loadIsolatedServerModule, multiUserOptions, provisionAccounts,
  startMultiUserDaemon, type Principal, type StartedMultiUserDaemon } from './multiuser-harness.js';
import { PERSONAL_CODEX_MOCK, actorDir, codexHome, linkCodex, setTurnMode, until } from './personal-codex-helpers.js';
import { FIXTURE_PLUGIN_ID, FIXTURE_RESOURCE_MARKER, FIXTURE_SKILL_MARKER, PIPELINE_ONLY_PLUGIN_ID, installStudioFixturePlugin } from './studio-plugin-fixture.js';

/** Test-only no-pipeline plugin, isolating immutable captures and pin races. */
const APPLICABLE = FIXTURE_PLUGIN_ID;
/** Bundled plugin opened by the finite stage runner. */
const PIPELINE_ONLY = PIPELINE_ONLY_PLUGIN_ID;
const REPO_ROOT = path.resolve('../..');

/**
 * Research fixture: a turn's paid search runs after plugin selection and
 * before the admission commit. While `researchHold` is set every search waits
 * on it, so a test can change the project's applied plugin inside that window.
 */
let researchHold: Promise<void> | null = null;
let researchCalls = 0;
const tavily: typeof fetch = async () => {
  researchCalls += 1;
  if (researchHold) await researchHold;
  return Response.json({ answer: 'PLUGIN_RACE_FINDINGS', results: [{ title: 'Note', url: 'https://example.test/note', content: 'note' }] });
};
const questionForm = '<question-form id="brief" title="Brief">{"questions":[{"id":"color","label":"Color","type":"text"}]}</question-form>';
const openai: typeof fetch = async (_url, init) => {
  const input = JSON.parse(String(init?.body)).input as Array<{ role?: string; content?: string; type?: string; call_id?: string; output?: string }>;
  const prompt = [...input].reverse().find((item) => item.role === 'user')?.content ?? '';
  if (prompt.includes('[plugin-resource]')) {
    const read = input.find((item) => item.type === 'function_call_output' && item.call_id === 'plugin-fixture-read');
    const output = read ? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: String(read.output) }] }]
      : [{ type: 'function_call', name: 'read_skill_file', call_id: 'plugin-fixture-read',
        arguments: JSON.stringify({ skillId: `studio-plugin:${FIXTURE_PLUGIN_ID}@1.0.0`, path: 'references/rules.md' }) }];
    const frames = [...(read ? [{ type: 'response.output_text.delta', delta: String(read.output) }] : []),
      { type: 'response.completed', response: { output } }];
    return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''),
      { headers: { 'content-type': 'text/event-stream' } });
  }
  const text = prompt.includes('[pipeline-question]') ? questionForm : 'Noted.';
  return new Response([{ type: 'response.output_text.delta', delta: text }, { type: 'response.completed', response: {
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] } }]
    .map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
};

let daemon: StartedMultiUserDaemon; let root: string;
let a: Principal; let b: Principal; let admin: Principal;
beforeAll(async () => {
  ({ dataRoot: root } = await loadIsolatedServerModule());
  daemon = await startMultiUserDaemon(multiUserOptions({ testPersonalCodexAppServer: PERSONAL_CODEX_MOCK,
    testTavilyFetch: tavily, testCompanyOpenAIFetch: openai }));
  const accounts = await provisionAccounts(daemon, ['plugins-a', 'plugins-b']);
  [a, b] = accounts.users as [Principal, Principal]; admin = accounts.admin;
  await linkCodex(daemon, root, a, 'plugins-a@example.test');
  await linkCodex(daemon, root, b, 'plugins-b@example.test');
  const pool = await daemon.request({ path: '/api/admin/pool/openai', cookie: admin.cookie });
  expect((await daemon.request({ method: 'PUT', path: '/api/admin/pool/openai', cookie: admin.cookie, body: {
    revision: pool.json.provider.revision, model: 'company-model', enabled: true, capacity: 2, apiKey: 'sk-plugins-race-fixture-0123456789' } })).status).toBe(200);
  expect((await daemon.request({ method: 'PUT', path: '/api/multiuser/settings/provider-keys/tavily', cookie: a.cookie,
    body: { revision: 0, apiKey: 'tvly-plugins-a-fixture-0123456789' } })).status).toBe(200);
  expect((await daemon.request({ method: 'PUT', path: '/api/multiuser/settings/provider-keys/openai', cookie: a.cookie,
    body: { revision: 0, apiKey: 'sk-plugins-a-own-fixture-0123456789' } })).status).toBe(200);
  installStudioFixturePlugin(root);
}, 180_000);
afterAll(async () => { await daemon?.close(); cleanupIsolatedDataRoot(); });

const enc = encodeURIComponent;
const request = (user: Principal | null, method: string, route: string, body?: unknown) =>
  daemon.request({ method, path: route, ...(user ? { cookie: user.cookie } : {}), ...(body === undefined ? {} : { body }) });
async function project(user: Principal) {
  const id = randomUUID();
  const made = await request(user, 'POST', '/api/projects', { id, name: `plugins ${id.slice(0, 6)}` });
  expect(made.status, made.text).toBe(200);
  return { projectId: id, conversationId: made.json.conversationId as string };
}
type Reason = { code: string; subject?: string };
type Listed = { id: string; version: string; sourceKind: string; source: string; fsPath: string; availability: { applicable: boolean; reasons: Reason[] } };
async function catalog(user: Principal, route = '/api/plugins'): Promise<Listed[]> {
  const res = await request(user, 'GET', route);
  expect(res.status, res.text).toBe(200);
  return res.json.plugins as Listed[];
}
const apply = (user: Principal, pluginId: string, body: Record<string, unknown>) =>
  request(user, 'POST', `/api/plugins/${enc(pluginId)}/apply`, body);
const turn = (user: Principal, context: { projectId: string; conversationId: string }, extra: Record<string, unknown> = {}) =>
  request(user, 'POST', '/api/runs', { ...context, message: 'Package this work', agentId: 'codex', executionSource: 'personal_subscription', ...extra });
async function finish(user: Principal, started: { status: number; text: string; json: any }): Promise<string> {
  expect(started.status, started.text).toBe(202);
  expect((await request(user, 'GET', `/api/runs/${started.json.runId}/events`)).text).toContain('"status":"succeeded"');
  return JSON.parse(readFileSync(path.join(codexHome(root, user.id), 'mock-turn-evidence.json'), 'utf8')).message as string;
}
function withDb<T>(work: (db: Database.Database) => T): T {
  const db = new Database(path.join(root, 'app.sqlite'));
  try { return work(db); } finally { db.close(); }
}

describe('Studio bundled plugin catalog', () => {
  const sources = [
    { executionSource: 'personal_subscription', agentId: 'codex' },
    { executionSource: 'company_pool', agentId: 'openai' },
    { executionSource: 'personal_api_key', agentId: 'openai-byok' },
  ];
  it.each(sources)('transports the captured bundled resource into the worker on $executionSource', async (source) => {
    const target = await project(a);
    expect((await apply(a, APPLICABLE, { projectId: target.projectId })).status).toBe(200);
    const started = await turn(a, target, { ...source, message: '[plugin-resource] Read the captured rules.' });
    expect(started.status, started.text).toBe(202);
    const id = started.json.runId as string;
    const events = await request(a, 'GET', `/api/runs/${id}/events`);
    expect(events.text).toContain('"status":"succeeded"');
    const saved = withDb((db) => db.prepare('SELECT request_json FROM multiuser_runs WHERE id = ?').get(id) as { request_json: string });
    const resource = JSON.parse(saved.request_json).pluginSnapshot.resourcePackage;
    expect(Buffer.from(resource.files.find((file: { path: string }) => file.path === 'references/rules.md').data, 'base64').toString('utf8'))
      .toContain(FIXTURE_RESOURCE_MARKER);
    if (source.executionSource === 'personal_subscription') {
      const staged = path.join(actorDir(root, a.id), id, 'skill-packages', resource.key, 'references/rules.md');
      expect(readFileSync(staged, 'utf8')).toContain(FIXTURE_RESOURCE_MARKER);
      const evidence = JSON.parse(readFileSync(path.join(codexHome(root, a.id), 'mock-turn-evidence.json'), 'utf8'));
      expect(evidence.message).toContain(resource.id); expect(evidence.message).toContain(path.dirname(path.dirname(staged)));
    } else expect(events.text).toContain(FIXTURE_RESOURCE_MARKER);
  });
  it.each(sources)('keeps the authorized plugin brand capture after the private document is deleted on $executionSource', async (source) => {
    const target = await project(a);
    const design = await request(a, 'POST', '/api/design-systems', { title: 'Plugin brand', body: 'PINNED_PRIVATE_PLUGIN_BRAND' });
    expect(design.status, design.text).toBe(201);
    const designId = design.json.designSystem.id as string;
    const original = withDb((db) => db.prepare('SELECT manifest_json FROM installed_plugins WHERE id = ?').get(APPLICABLE) as { manifest_json: string });
    try {
      withDb((db) => db.prepare("UPDATE installed_plugins SET manifest_json = json_set(manifest_json, '$.od.context.designSystem', json(?)) WHERE id = ?")
        .run(JSON.stringify({ ref: designId }), APPLICABLE));
      expect((await apply(a, APPLICABLE, { projectId: target.projectId })).status).toBe(200);
    } finally {
      withDb((db) => db.prepare('UPDATE installed_plugins SET manifest_json = ? WHERE id = ?').run(original.manifest_json, APPLICABLE));
    }
    expect((await request(a, 'DELETE', `/api/design-systems/${enc(designId)}`)).status).toBe(200);
    const started = await turn(a, target, source); expect(started.status, started.text).toBe(202);
    expect((await request(a, 'GET', `/api/runs/${started.json.runId}/events`)).text).toContain('"status":"succeeded"');
    const saved = withDb((db) => db.prepare('SELECT request_json FROM multiuser_runs WHERE id = ?').get(started.json.runId) as { request_json: string });
    const captured = JSON.parse(saved.request_json);
    expect(captured.stablePrompt).toContain('PINNED_PRIVATE_PLUGIN_BRAND');
    const document = captured.pluginSnapshot.resourcePackage.files.find((file: { path: string }) => file.path.endsWith('/DESIGN.md'));
    expect(Buffer.from(document.data, 'base64').toString()).toBe('PINNED_PRIVATE_PLUGIN_BRAND');
    if (source.executionSource === 'personal_subscription') {
      const evidence = JSON.parse(readFileSync(path.join(codexHome(root, a.id), 'mock-turn-evidence.json'), 'utf8'));
      expect(evidence.message).toContain('PINNED_PRIVATE_PLUGIN_BRAND');
    }
  });
  it.each(sources)('keeps a shared catalog skill captured by the applied plugin after its use grant is revoked on $executionSource', async (source) => {
    const target = await project(a);
    const imported = await request(b, 'POST', '/api/skills/import', { name: `Plugin shared skill ${randomUUID()}`, body: 'PINNED_SHARED_PLUGIN_SKILL' });
    expect(imported.status, imported.text).toBe(201);
    const skillId = imported.json.skill.id as string;
    const original = withDb((db) => db.prepare('SELECT manifest_json FROM installed_plugins WHERE id = ?').get(APPLICABLE) as { manifest_json: string });
    let snapshotId: string;
    try {
      withDb((db) => db.prepare("UPDATE installed_plugins SET manifest_json = json_set(manifest_json, '$.od.context.skills', json(?)) WHERE id = ?")
        .run(JSON.stringify([{ path: './SKILL.md' }, { ref: skillId }]), APPLICABLE));
      expect((await apply(a, APPLICABLE, { projectId: target.projectId })).status).toBe(404);
      expect((await request(b, 'PUT', `/api/multiuser/catalog/skills/${enc(skillId)}/shares`, { username: a.username, role: 'use' })).status).toBe(200);
      const applied = await apply(a, APPLICABLE, { projectId: target.projectId }); expect(applied.status, applied.text).toBe(200);
      snapshotId = applied.json.snapshotId;
      expect(applied.json.appliedPlugin.resolvedContext.items).toContainEqual({ kind: 'skill', id: skillId, label: imported.json.skill.name });
      expect((await request(b, 'DELETE', `/api/multiuser/catalog/skills/${enc(skillId)}/shares/${a.id}`)).status).toBe(200);
      expect((await apply(a, APPLICABLE, { projectId: target.projectId })).status).toBe(404);
      expect((await request(b, 'DELETE', `/api/skills/${enc(skillId)}`)).status).toBe(200);
    } finally {
      withDb((db) => db.prepare('UPDATE installed_plugins SET manifest_json = ? WHERE id = ?').run(original.manifest_json, APPLICABLE));
    }
    const started = await turn(a, target, source); expect(started.status, started.text).toBe(202);
    expect((await request(a, 'GET', `/api/runs/${started.json.runId}/events`)).text).toContain('"status":"succeeded"');
    const saved = withDb((db) => db.prepare('SELECT request_json FROM multiuser_runs WHERE id = ?').get(started.json.runId) as { request_json: string });
    const captured = JSON.parse(saved.request_json);
    expect(captured.pluginSnapshot.snapshotId).toBe(snapshotId!);
    expect(captured.stablePrompt).toContain('PINNED_SHARED_PLUGIN_SKILL');
    const document = captured.pluginSnapshot.resourcePackage.files.find((file: { path: string }) => file.path.startsWith('opendesign-context/skill-') && file.path.endsWith('/SKILL.md'));
    expect(Buffer.from(document.data, 'base64').toString()).toBe('PINNED_SHARED_PLUGIN_SKILL');
    if (source.executionSource === 'personal_subscription') {
      const resource = captured.pluginSnapshot.resourcePackage;
      expect(readFileSync(path.join(actorDir(root, a.id), started.json.runId, 'skill-packages', resource.key, document.path), 'utf8'))
        .toBe('PINNED_SHARED_PLUGIN_SKILL');
    }
  });
  it.each(sources)('rechecks all nullable project-default transitions after held admission on $executionSource', async (source) => {
    for (const kind of ['skill', 'design'] as const) {
      const create = async () => {
        const made = kind === 'skill'
          ? await request(a, 'POST', '/api/skills/import', { name: `Defaults ${randomUUID()}`, body: 'DEFAULT_SKILL' })
          : await request(a, 'POST', '/api/design-systems', { title: `Defaults ${randomUUID()}`, body: '# Default\nDEFAULT_DESIGN' });
        expect(made.status, made.text).toBe(201);
        return (kind === 'skill' ? made.json.skill.id : made.json.designSystem.id) as string;
      };
      const first = await create(); const other = await create();
      const column = kind === 'skill' ? 'skill_id' : 'design_system_id';
      for (const [initial, changed] of [[null, first], [first, other], [first, null]]) {
        const target = await project(a);
        withDb((db) => db.prepare(`UPDATE projects SET ${column} = ? WHERE id = ?`).run(initial, target.projectId));
        let release!: () => void;
        researchHold = new Promise<void>((resolve) => { release = resolve; });
        const beforeCalls = researchCalls;
        const pending = turn(a, target, { ...source, research: { enabled: true, query: `defaults ${randomUUID()}` } });
        try {
          await until(() => researchCalls, (count) => count > beforeCalls, 'admission at held research');
          withDb((db) => db.prepare(`UPDATE projects SET ${column} = ? WHERE id = ?`).run(changed, target.projectId));
        } finally { researchHold = null; release(); }
        const refused = await pending;
        expect(refused.status, `${kind}: ${initial} → ${changed}: ${refused.text}`).toBe(409);
        expect(refused.json.error).toMatchObject({ code: 'CONFLICT', message: 'project defaults changed during admission' });
        expect(withDb((db) => db.prepare('SELECT id FROM multiuser_runs WHERE conversation_id = ?').all(target.conversationId))).toEqual([]);
        expect(withDb((db) => db.prepare('SELECT id FROM messages WHERE conversation_id = ?').all(target.conversationId))).toEqual([]);
      }
    }
  });

  it.each(sources)('executes the captured ordered pipeline and replays the same timeline on $executionSource', async (source) => {
    const target = await project(a);
    const applied = await apply(a, PIPELINE_ONLY, { projectId: target.projectId });
    expect(applied.status, applied.text).toBe(200);
    const started = await turn(a, target, source);
    expect(started.status, started.text).toBe(202);
    const id = started.json.runId as string;
    const stream = await request(a, 'GET', `/api/runs/${id}/events`);
    expect(stream.text).toContain('"status":"succeeded"');
    const run = (await request(a, 'GET', `/api/runs/${id}`)).json;
    expect(run.output.pipeline).toEqual({ snapshotId: applied.json.snapshotId, stageIndex: 2, stageCount: 2, awaitingInput: false });
    const frames = stream.text.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)));
    const timeline = frames.filter((frame) => frame.type === 'pipeline_stage').map((frame) => frame.stage);
    expect(timeline.map((stage) => [stage.kind, stage.stageId])).toEqual([
      ['pipeline_stage_started', 'inspect-project'], ['pipeline_stage_completed', 'inspect-project'],
      ['pipeline_stage_started', 'package-plugin'], ['pipeline_stage_completed', 'package-plugin']]);
    const transcript = await request(a, 'GET', `/api/projects/${target.projectId}/conversations/${target.conversationId}/messages`);
    const assistant = transcript.json.messages.find((message: any) => message.runId === id && message.role === 'assistant');
    expect(assistant.events.filter((event: any) => event.kind.startsWith('pipeline_stage_'))).toEqual(timeline);
    // Foreign and missing runs use the same refusal, including the administrator.
    for (const user of [b, admin]) {
      expect((await request(user, 'GET', `/api/runs/${id}/events`)).text)
        .toBe((await request(user, 'GET', `/api/runs/${randomUUID()}/events`)).text);
    }
  });

  it.each(sources)('pauses for a question and resumes the same captured stage on $executionSource', async (source) => {
    const target = await project(a);
    expect((await apply(a, PIPELINE_ONLY, { projectId: target.projectId })).status).toBe(200);
    if (source.executionSource === 'personal_subscription') setTurnMode(root, a, { reply: questionForm });
    try {
      const started = await turn(a, target, { ...source, message: '[pipeline-question]' });
      expect(started.status, started.text).toBe(202);
      const first = await request(a, 'GET', `/api/runs/${started.json.runId}/events`);
      expect(first.text).toContain('"status":"succeeded"');
      expect(first.text).not.toContain('pipeline_stage_completed');
      expect(first.text).not.toContain('"stageId":"package-plugin"');
      const progress = (await request(a, 'GET', `/api/runs/${started.json.runId}`)).json.output.pipeline;
      expect(progress).toMatchObject({ stageIndex: 0, stageCount: 2, awaitingInput: true });
      if (source.executionSource === 'personal_subscription') setTurnMode(root, a, { reply: 'Answered.' });
      const answered = await turn(a, target, { ...source, message: 'Use blue', analyticsHints: { entryFrom: 'question_answer', sourceRunId: started.json.runId } });
      expect(answered.status, answered.text).toBe(202);
      const second = await request(a, 'GET', `/api/runs/${answered.json.runId}/events`);
      expect(second.text).toContain('"status":"succeeded"');
      expect((await request(a, 'GET', `/api/runs/${answered.json.runId}`)).json.output.pipeline)
        .toMatchObject({ snapshotId: progress.snapshotId, stageIndex: 2, awaitingInput: false });
      expect((await turn(a, target, { ...source, message: 'again', analyticsHints: { entryFrom: 'question_answer', sourceRunId: started.json.runId } })).status).toBe(409);
    } finally { if (source.executionSource === 'personal_subscription') setTurnMode(root, a, {}); }
  });

  it('lists the same bundled catalog to every account with computed availability and no host paths', async () => {
    const listed = await catalog(a);
    expect(listed.length).toBeGreaterThan(100);
    expect(listed.every((plugin) => plugin.sourceKind === 'bundled')).toBe(true);
    // The OD Next strategy package is never a catalog plugin.
    expect(listed.some((plugin) => plugin.id === 'od-next-strategy')).toBe(false);
    const text = JSON.stringify(listed);
    for (const hostPath of [root, REPO_ROOT, path.join(REPO_ROOT, 'plugins', '_official')]) expect(text.includes(hostPath)).toBe(false);
    expect(listed.every((plugin) => plugin.fsPath === '' && !plugin.source.startsWith('/'))).toBe(true);
    // Same catalog for B and through the reviewed alias.
    expect((await catalog(b)).map((plugin) => [plugin.id, plugin.availability])).toEqual(listed.map((plugin) => [plugin.id, plugin.availability]));
    expect((await catalog(a, '/api/multiuser/catalog/plugins')).map((plugin) => plugin.id)).toEqual(listed.map((plugin) => plugin.id));

    const byId = new Map(listed.map((plugin) => [plugin.id, plugin]));
    // Finite stages of Web atoms now execute on every source.
    expect(byId.get(PIPELINE_ONLY)?.availability).toEqual({ applicable: true, reasons: [] });
    // This bundled pipeline and the no-pipeline fixture are applicable.
    expect(listed.filter((plugin) => plugin.availability.applicable).map((plugin) => plugin.id).sort()).toEqual([PIPELINE_ONLY, APPLICABLE].sort());
    expect(byId.get(APPLICABLE)?.availability).toEqual({ applicable: true, reasons: [] });
    // A live-artifact template: its declared atom and the critique loop the
    // apply pipeline adds do not run in Studio turns, and both are named.
    const liveArtifact = listed.find((plugin) => plugin.availability.reasons.some((reason) => reason.code === 'atom' && reason.subject === 'live-artifact'))!;
    expect(liveArtifact.availability.applicable).toBe(false);
    expect(liveArtifact.availability.reasons).toEqual(expect.arrayContaining([{ code: 'atom', subject: 'critique-theater' }]));
    // An atom the first-party catalog does not know fails closed.
    expect(byId.get('image-template-vr-headset-exploded-view-poster')?.availability).toEqual({
      applicable: false, reasons: expect.arrayContaining([{ code: 'unknown-atom', subject: 'image-generate' }]) });
    // Host-capability plugins name the capability.
    expect(byId.get('od-plugin-publish-github')?.availability.reasons).toEqual(expect.arrayContaining([{ code: 'capability', subject: 'subprocess' }]));
    // Unavailable is never applicable, and applicable has no reasons.
    expect(listed.every((plugin) => plugin.availability.applicable === (plugin.availability.reasons.length === 0))).toBe(true);

    const detail = await request(a, 'GET', `/api/plugins/${APPLICABLE}`);
    expect(detail.status, detail.text).toBe(200);
    expect(detail.json).toMatchObject({ id: APPLICABLE, fsPath: '', availability: { applicable: true, reasons: [] } });
    expect(detail.text.includes(REPO_ROOT)).toBe(false);
    expect(detail.text.includes(root)).toBe(false);
    expect((await request(a, 'GET', '/api/plugins/no-such-plugin')).status).toBe(404);
    expect((await request(null, 'GET', '/api/plugins')).status).toBe(401);
  });

  it('applies an applicable plugin onto the owner\'s project only; B, an editor and the admin cannot apply or read it', async () => {
    const target = await project(a);
    const applied = await apply(a, APPLICABLE, { projectId: target.projectId, inputs: {}, grantCaps: [], locale: 'en' });
    expect(applied.status, applied.text).toBe(200);
    const snapshotId = applied.json.snapshotId as string;
    expect(snapshotId).toMatch(/^[0-9a-f-]{36}$/);
    expect(applied.json).toMatchObject({ ok: true, projectId: target.projectId, appliedPlugin: { snapshotId, pluginId: APPLICABLE } });
    expect(applied.text.includes(REPO_ROOT)).toBe(false);
    expect((await request(a, 'GET', `/api/projects/${target.projectId}`)).json.project.appliedPluginSnapshotId).toBe(snapshotId);
    const snapshot = await request(a, 'GET', `/api/applied-plugins/${snapshotId}`);
    expect(snapshot.status, snapshot.text).toBe(200);
    expect(snapshot.json).toMatchObject({ snapshotId, pluginId: APPLICABLE });

    // B and the admin: A's project and snapshot are the same 404 as missing ones.
    const missingProject = await apply(b, APPLICABLE, { projectId: randomUUID() });
    expect(missingProject.status).toBe(404);
    const missingSnapshot = await request(b, 'GET', `/api/applied-plugins/${randomUUID()}`);
    expect(missingSnapshot.status).toBe(404);
    for (const user of [b, admin]) {
      const foreign = await apply(user, APPLICABLE, { projectId: target.projectId });
      expect(foreign.status).toBe(missingProject.status);
      expect(foreign.text).toBe(missingProject.text);
      expect((await request(user, 'GET', `/api/applied-plugins/${snapshotId}`)).text).toBe(missingSnapshot.text);
    }
    // An editor of a shared project reads the pin but cannot change it (owner-only, S32).
    expect((await request(a, 'PUT', `/api/multiuser/projects/${target.projectId}/shares`, { username: b.username, role: 'edit' })).status).toBe(200);
    expect((await apply(b, APPLICABLE, { projectId: target.projectId })).text).toBe(missingProject.text);
    expect((await request(b, 'GET', `/api/applied-plugins/${snapshotId}`)).status).toBe(200);
    expect((await request(a, 'DELETE', `/api/multiuser/projects/${target.projectId}/shares/${b.id}`)).status).toBe(200);
    expect((await request(b, 'GET', `/api/applied-plugins/${snapshotId}`)).text).toBe(missingSnapshot.text);
    expect((await request(a, 'GET', `/api/projects/${target.projectId}`)).json.project.appliedPluginSnapshotId).toBe(snapshotId);
  });

  it('refuses an unavailable plugin server-side with its typed reasons and persists nothing', async () => {
    const target = await project(a);
    const listed = await catalog(a);
    const unavailable = listed.find((plugin) => plugin.id === 'example-article-magazine')!;
    expect(unavailable.availability.reasons).toEqual(expect.arrayContaining([{ code: 'atom', subject: 'live-artifact' }]));
    const before = withDb((db) => (db.prepare('SELECT COUNT(*) AS n FROM applied_plugin_snapshots').get() as { n: number }).n);
    const refused = await apply(a, unavailable.id, { projectId: target.projectId });
    expect(refused.status, refused.text).toBe(403);
    expect(refused.json.error).toMatchObject({ code: 'MULTIUSER_CAPABILITY_UNAVAILABLE', details: { pluginId: unavailable.id, reasons: unavailable.availability.reasons } });
    expect(withDb((db) => (db.prepare('SELECT COUNT(*) AS n FROM applied_plugin_snapshots').get() as { n: number }).n)).toBe(before);
    expect((await request(a, 'GET', `/api/projects/${target.projectId}`)).json.project.appliedPluginSnapshotId ?? null).toBeNull();
    // Body policy: no host source, no capability grants, a project is required.
    for (const body of [{ projectId: target.projectId, source: '/tmp/plugin' }, { projectId: target.projectId, grantCaps: ['subprocess'] },
      {}, { projectId: target.projectId, inputs: { nested: { deep: true } } }]) {
      expect((await apply(a, APPLICABLE, body)).status, JSON.stringify(body)).toBe(400);
    }
  });

  it('captures the plugin into turns and keeps project, run and conversation pins when the bundled plugin is upgraded or removed', async () => {
    const target = await project(a);
    const applied = await apply(a, APPLICABLE, { projectId: target.projectId });
    expect(applied.status, applied.text).toBe(200);
    const snapshotId = applied.json.snapshotId as string;
    const first = await finish(a, await turn(a, target, { appliedPluginSnapshotId: snapshotId, context: { pluginIds: [APPLICABLE] } }));
    expect(first).toContain('## Active plugin');
    expect(first).toContain(`${APPLICABLE}@`);
    // The plugin-local SKILL.md body is captured with it.
    expect(first).toContain(FIXTURE_SKILL_MARKER);
    // A turn naming another snapshot is refused rather than silently swapped.
    expect((await turn(a, target, { appliedPluginSnapshotId: randomUUID() })).status).toBe(409);
    expect((await turn(a, target, { context: { pluginIds: ['some-other-plugin'] } })).status).toBe(409);

    const original = withDb((db) => db.prepare('SELECT * FROM installed_plugins WHERE id = ?').get(APPLICABLE) as Record<string, unknown>);
    try {
      // Upgrade: the catalog row changes; the project's snapshot and the conversation do not.
      withDb((db) => db.prepare('UPDATE installed_plugins SET version = ?, manifest_json = json_set(manifest_json, \'$.version\', ?, \'$.title\', ?) WHERE id = ?')
        .run('9.9.9', '9.9.9', 'Upgraded title', APPLICABLE));
      expect((await request(a, 'GET', `/api/plugins/${APPLICABLE}`)).json.version).toBe('9.9.9');
      const pinned = await request(a, 'GET', `/api/applied-plugins/${snapshotId}`);
      expect(pinned.json.pluginVersion).toBe(original.version);
      const second = await finish(a, await turn(a, target));
      expect(second).not.toContain('9.9.9');
      // Removal: the catalog no longer offers it and apply is a 404; pins remain.
      withDb((db) => db.prepare('DELETE FROM installed_plugins WHERE id = ?').run(APPLICABLE));
      expect((await request(a, 'GET', `/api/plugins/${APPLICABLE}`)).status).toBe(404);
      expect((await apply(a, APPLICABLE, { projectId: target.projectId })).status).toBe(404);
      expect((await request(a, 'GET', `/api/applied-plugins/${snapshotId}`)).json.pluginVersion).toBe(original.version);
      expect((await request(a, 'GET', `/api/projects/${target.projectId}`)).json.project.appliedPluginSnapshotId).toBe(snapshotId);
      const third = await finish(a, await turn(a, target, { appliedPluginSnapshotId: snapshotId }));
      expect(third).not.toContain('9.9.9');
      const requests = withDb((db) => db.prepare('SELECT request_json FROM multiuser_runs WHERE conversation_id = ? ORDER BY queue_seq')
        .all(target.conversationId) as Array<{ request_json: string }>).map((row) => JSON.parse(row.request_json) as { pluginSnapshot?: { snapshotId: string; pluginVersion: string } });
      expect(requests.length).toBe(3);
      expect(requests.every((item) => item.pluginSnapshot?.snapshotId === snapshotId && item.pluginSnapshot.pluginVersion === original.version)).toBe(true);
    } finally {
      withDb((db) => {
        const columns = Object.keys(original);
        db.prepare(`INSERT OR REPLACE INTO installed_plugins (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(...columns.map((key) => original[key]));
      });
    }
  });

  it('refuses host-global plugin operations with the typed capability code', async () => {
    const cases: Array<[string, string, unknown]> = [
      ['POST', '/api/plugins/install', { source: 'github:example/plugin' }],
      ['POST', '/api/plugins/upload-zip', {}],
      ['POST', '/api/plugins/upload-folder', {}],
      ['POST', `/api/plugins/${PIPELINE_ONLY}/upgrade`, {}],
      ['POST', `/api/plugins/${PIPELINE_ONLY}/uninstall`, {}],
      ['POST', `/api/plugins/${PIPELINE_ONLY}/doctor`, {}],
      ['POST', `/api/plugins/${PIPELINE_ONLY}/trust`, { capabilities: ['subprocess'] }],
      ['POST', `/api/plugins/${PIPELINE_ONLY}/apply-local`, { source: '/tmp/x' }],
      ['POST', '/api/marketplaces', { url: 'https://example.test/marketplace.json' }],
      ['POST', '/api/marketplaces/official/refresh', {}],
      ['POST', '/api/marketplaces/official/trust', { trust: 'trusted' }],
      ['DELETE', '/api/marketplaces/official', undefined],
    ];
    for (const user of [a, admin]) {
      for (const [method, route, body] of cases) {
        const refused = await request(user, method, route, body);
        expect(refused.status, `${method} ${route}`).toBe(403);
        expect(refused.json.error.code, `${method} ${route}`).toBe('MULTIUSER_CAPABILITY_UNAVAILABLE');
        expect(typeof refused.json.error.details.capability).toBe('string');
      }
    }
  });

  it('lists marketplace sources read-only without host paths', async () => {
    const listed = await request(a, 'GET', '/api/marketplaces');
    expect(listed.status, listed.text).toBe(200);
    expect(Array.isArray(listed.json.marketplaces)).toBe(true);
    for (const hostPath of [root, REPO_ROOT]) expect(listed.text.includes(hostPath)).toBe(false);
    expect((await request(null, 'GET', '/api/marketplaces')).status).toBe(401);
    const missing = await request(a, 'GET', '/api/marketplaces/no-such-marketplace');
    expect(missing.status).toBe(404);
  });
  it.each([
    { agentId: 'codex', executionSource: 'personal_subscription' },
    { agentId: 'openai', executionSource: 'company_pool' },
    { agentId: 'openai-byok', executionSource: 'personal_api_key' },
  ])('refuses a turn whose project plugin pin changed while admission yielded ($executionSource)', async (source) => {
    const conversationRows = (conversationId: string) => withDb((db) => ({
      runs: (db.prepare('SELECT COUNT(*) AS n FROM multiuser_runs WHERE conversation_id = ?').get(conversationId) as { n: number }).n,
      messages: (db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(conversationId) as { n: number }).n,
    }));
    const pluginOf = (runId: string) => withDb((db) => (JSON.parse((db.prepare('SELECT request_json FROM multiuser_runs WHERE id = ?')
      .get(runId) as { request_json: string }).request_json) as { pluginSnapshot?: { snapshotId: string } }).pluginSnapshot?.snapshotId ?? null);
    const settled = (runId: string, label: string) => until(() => request(a, 'GET', `/api/runs/${runId}`),
      (r) => ['succeeded', 'failed', 'canceled'].includes(r.json.status), `${label}: run settles`, 30_000);
    // `before`: the project pin when the turn is admitted (the conversation has no plugin of its own).
    const cases: Array<{ label: string; before: boolean; change: boolean }> = [
      { label: 'pin replaced', before: true, change: true },
      { label: 'empty pin -> applied', before: false, change: true },
      { label: 'control, empty pin', before: false, change: false },
      { label: 'control, pinned', before: true, change: false },
    ];
    for (const item of cases) {
      const label = `${source.executionSource} / ${item.label}`;
      const target = await project(a);
      const applyNow = async () => {
        const applied = await apply(a, APPLICABLE, { projectId: target.projectId });
        expect(applied.status, `${label}: ${applied.text}`).toBe(200);
        return applied.json.snapshotId as string;
      };
      const initial = item.before ? await applyNow() : null;
      let release!: () => void;
      researchHold = new Promise<void>((resolve) => { release = resolve; });
      const callsBefore = researchCalls;
      let changed: string | null = null;
      try {
        const pending = request(a, 'POST', '/api/runs', { ...target, ...source, message: 'Plugin race',
          clientRequestId: `plugin-race-${randomUUID()}`, research: { enabled: true, query: 'race' } });
        // Plugin selection already read the project pin; the commit has not happened.
        await until(() => researchCalls, (count) => count > callsBefore, `${label}: held search`);
        if (item.change) changed = await applyNow();
        release(); researchHold = null;
        const reply = await pending;
        if (!item.change) {
          expect(reply.status, `${label}: ${reply.text}`).toBe(202);
          expect(pluginOf(reply.json.runId), label).toBe(initial);
          await settled(reply.json.runId, label);
          continue;
        }
        expect(reply.status, `${label}: ${reply.text}`).toBe(409);
        expect(reply.json.error.code, label).toBe('CONFLICT');
        expect(reply.json?.runId, label).toBeUndefined();
        expect(conversationRows(target.conversationId), label).toEqual({ runs: 0, messages: 0 });
      } finally { release(); researchHold = null; }
      // Nothing was dropped: the next turn takes the project's current plugin
      // (after a refusal) or keeps the plugin its conversation captured.
      const retry = await request(a, 'POST', '/api/runs', { ...target, ...source, message: 'Plugin race retry' });
      expect(retry.status, `${label}: ${retry.text}`).toBe(202);
      expect(pluginOf(retry.json.runId), label).toBe(item.change ? changed : initial);
      await settled(retry.json.runId, label);
    }
  }, 120_000);
});
