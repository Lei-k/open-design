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
import { syntheticGoodTranscript } from '../../src/critique/__fixtures__/adapters/synthetic-good.js';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupIsolatedDataRoot, loadIsolatedServerModule, multiUserOptions, provisionAccounts,
  startMultiUserDaemon, type Principal, type StartedMultiUserDaemon } from './multiuser-harness.js';
import { PERSONAL_CODEX_MOCK, actorDir, codexHome, linkCodex, setTurnMode, until } from './personal-codex-helpers.js';
import { FIXTURE_LIVE_ARTIFACT_PLUGIN_ID, FIXTURE_MEDIA_PLUGIN_ID, FIXTURE_PIPELINE_PLUGIN_ID, FIXTURE_PLUGIN_ID, FIXTURE_RESOURCE_MARKER, FIXTURE_SKILL_MARKER,
  PIPELINE_ONLY_PLUGIN_ID, installStudioAtomFixturePlugins, installStudioFixturePlugin } from './studio-plugin-fixture.js';
import { buildStudioSkillPackage } from '../../src/services/studio-skill-packages.js';
import type { PluginPipeline, PluginPipelineStageEvent } from '@open-design/contracts';
import { S70_DEVLOOP_SAMPLE, S70_MEDIA_PNG_BASE64, s70MediaArtifactDraft } from './studio-devloop-sample.js';
import { projectDir } from '../../src/projects.js';

/** S67: bundled plugins whose every step (file-write, live-artifact, media surface) runs on Web. */
const S67_BUNDLED_APPLICABLE = ['example-frame-data-chart-nyt', 'example-frame-flowchart-sticky', 'example-frame-glitch-title',
  'example-frame-light-leak-cinema', 'example-frame-liquid-bg-hero', 'example-frame-logo-outro', 'example-frame-macos-notification',
  'example-image-poster', 'example-vfx-text-cursor', 'example-video-hyperframes'];
/** S67 repair 1: bundled plugins whose captured package needs a desktop-only core step, with the detector's typed reasons. */
const DEAD_CORE: ReadonlyArray<[string, string[]]> = [
  ['example-audio-jingle', ['desktop:music-sfx-audio']],
  ['example-hatch-pet', ['desktop:codex-tool', 'desktop:local-script']],
  ['example-hyperframes', ['desktop:html-video-render', 'desktop:local-script', 'desktop:media-scaffold', 'desktop:od-cli']],
  ['example-video-shortform', ['desktop:html-video-render']],
  ['od-share-to-community', ['desktop:od-cli']],
];
/** Test-only no-pipeline plugin, isolating immutable captures and pin races. */
const APPLICABLE = FIXTURE_PLUGIN_ID;
/** Bundled plugin opened by the finite stage runner, closed again by its desktop-only install step (S67 repair 1). */
const PIPELINE_ONLY = PIPELINE_ONLY_PLUGIN_ID;
/** Test-only copy of that finite pipeline with a benign skill. */
const PIPELINE = FIXTURE_PIPELINE_PLUGIN_ID;
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
/** S67 media fixture: every provider media request with the key that paid for it. */
const PNG = Buffer.from(S70_MEDIA_PNG_BASE64, 'base64');
const mediaCalls: Array<{ url: string; authorization: string }> = [];
/** S67: the tools and stage directive each OpenAI request carried, by marker. */
const atomRequests: Array<{ marker: string; tools: string[]; prompt: string; authorization: string }> = [];
const liveArtifactDraft = JSON.stringify({ input: { title: 'OpenAI live artifact', preview: { type: 'html', entry: 'index.html' },
  document: { format: 'html_template_v1', templatePath: 'template.html', generatedPreviewPath: 'index.html', dataPath: 'data.json',
    dataJson: { total: 5 } } }, templateHtml: '<h1>{{data.total}}</h1>' });
const questionForm = '<question-form id="brief" title="Brief">{"questions":[{"id":"color","label":"Color","type":"text"}]}</question-form>';
const sampleHtml = '<!doctype html><title>S70</title><h1>S70 design</h1>';
const lowJuryScore = syntheticGoodTranscript().replace(/score="[\d.]+"/g, 'score="2"');
const sampleRequests: Array<{ id: string; stage: string; iteration: number; authorization: string; tools: string[] }> = [];
const openai: typeof fetch = async (url, init) => {
  const authorization = new Headers(init?.headers).get('authorization') ?? '';
  if (String(url) !== 'https://api.openai.com/v1/responses') {
    mediaCalls.push({ url: String(url), authorization });
    return String(url).endsWith('/images/generations') ? Response.json({ data: [{ b64_json: PNG.toString('base64') }] })
      : new Response('unexpected', { status: 404 });
  }
  const requestBody = JSON.parse(String(init?.body)) as { tools?: Array<{ name: string }> };
  const input = JSON.parse(String(init?.body)).input as Array<{ role?: string; content?: string; type?: string; call_id?: string; output?: string }>;
  const prompt = [...input].reverse().find((item) => item.role === 'user')?.content ?? '';
  const sampleId = /\[s70-sample:([a-z0-9-]+)\]/.exec(prompt)?.[1];
  if (sampleId) {
    const sample = S70_DEVLOOP_SAMPLE.find((item) => item.id === sampleId)!;
    const stage = [...prompt.matchAll(/\nStage: ([^\n]+)\nAtoms:/g)].at(-1)?.[1] ?? '';
    const iteration = Number([...prompt.matchAll(/\nCurrent iteration: (\d+) \/ \d+\.\n/g)].at(-1)?.[1] ?? 0);
    sampleRequests.push({ id: sampleId, stage, iteration, authorization, tools: (requestBody.tools ?? []).map((tool) => tool.name) });
    let text = 'Stage complete.';
    let output: Record<string, unknown>[] = [];
    if (stage === 'critique') text = sample.ceiling || iteration === 1 ? lowJuryScore : syntheticGoodTranscript();
    else if (stage === 'generate') {
      const done = input.some((item) => item.type === 'function_call_output' && item.call_id === 's70-sample-live');
      if (!done) output = [
        ...(!sample.media ? [{ type: 'function_call', call_id: 's70-sample-design', name: 'write_project_file',
          arguments: JSON.stringify({ path: 'index.html', content: sampleHtml }) }] : []),
        ...(sample.media ? [{ type: 'function_call', call_id: 's70-sample-media', name: 'generate_image',
          arguments: JSON.stringify({ prompt: 'A calm product hero', path: 'assets/hero.png', size: '1024x1024' }) }] : []),
        { type: 'function_call', call_id: 's70-sample-live', name: 'live_artifacts_create', arguments: JSON.stringify({
          requestJson: sample.media ? JSON.stringify(s70MediaArtifactDraft(sample.expectedFiles[0]!)) : liveArtifactDraft }) },
      ];
    }
    return new Response([...(output.length ? [] : [{ type: 'response.output_text.delta', delta: text }]),
      { type: 'response.completed', response: { output: output.length ? output
        : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] } }]
      .map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  }
  for (const [marker, name, args] of [['[plugin-live-artifact]', 'live_artifacts_create', { requestJson: liveArtifactDraft }],
    ['[plugin-media]', 'generate_image', { prompt: 'A calm product hero', path: 'assets/hero.png', size: '1024x1024' }]] as const) {
    if (!prompt.includes(marker)) continue;
    const done = input.find((item) => item.type === 'function_call_output' && item.call_id === `atom-${name}`);
    if (!done) atomRequests.push({ marker, tools: (requestBody.tools ?? []).map((tool) => tool.name), prompt, authorization });
    const output = done ? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Atom done.' }] }]
      : [{ type: 'function_call', name, call_id: `atom-${name}`, arguments: JSON.stringify(args) }];
    return new Response([...(done ? [{ type: 'response.output_text.delta', delta: 'Atom done.' }] : []), { type: 'response.completed', response: { output } }]
      .map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  }
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
  const text = prompt.includes('CRITIQUE_RUN') ? syntheticGoodTranscript()
    : prompt.includes('[s70-question]') && prompt.includes('Current iteration: 2 / 3') ? questionForm
    : prompt.includes('[pipeline-question]') ? questionForm : 'Noted.';
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
  installStudioAtomFixturePlugins(root);
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
    const applied = await apply(a, PIPELINE, { projectId: target.projectId });
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
    expect((await apply(a, PIPELINE, { projectId: target.projectId })).status).toBe(200);
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
    // Finite stages of Web atoms execute on every source, but this bundled
    // pipeline's skill must run `od plugin validate|pack|install` (repair 1).
    expect(byId.get(PIPELINE_ONLY)?.availability).toEqual({ applicable: false, reasons: [{ code: 'capability', subject: 'desktop:od-cli' }] });
    expect(byId.get(PIPELINE)?.availability).toEqual({ applicable: true, reasons: [] });
    // The test fixtures and (S67) the runnable bundled Live Artifact examples
    // are applicable; no plugin is refused for live-artifact.
    expect(listed.filter((plugin) => plugin.availability.applicable)).toHaveLength(319);
    for (const id of [PIPELINE, APPLICABLE, FIXTURE_LIVE_ARTIFACT_PLUGIN_ID, FIXTURE_MEDIA_PLUGIN_ID, ...S67_BUNDLED_APPLICABLE])
      expect(byId.get(id)?.availability.applicable, id).toBe(true);
    expect(byId.get(APPLICABLE)?.availability).toEqual({ applicable: true, reasons: [] });
    expect(listed.some((plugin) => plugin.availability.reasons.some((reason) => reason.subject === 'live-artifact'))).toBe(false);
    // A live-artifact template still needs the critique loop the apply pipeline adds.
    expect(byId.get('example-article-magazine')?.availability).toEqual({ applicable: true, reasons: [] });
    // A declared image surface runs only where the S34 media functions exist.
    expect(byId.get('example-image-poster')?.availability).toEqual({ applicable: true, reasons: [],
      sourceRestrictions: [{ source: 'personal-codex', reasons: [{ code: 'atom', subject: 'media-image' }] }] });
    expect(byId.get(FIXTURE_LIVE_ARTIFACT_PLUGIN_ID)?.availability).toEqual({ applicable: true, reasons: [] });
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
    const unavailable = listed.find((plugin) => plugin.id === 'od-new-generation')!;
    expect(unavailable.availability.reasons).toEqual(expect.arrayContaining([{ code: 'atom', subject: 'direction-picker' }]));
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

// S67 (#61/#63/#68): a plugin stage that declares `live-artifact` gets the
// canonical Studio Live Artifact tools bound to the admitted project,
// conversation and run on every source; `media-image` gets the S34 function on
// the OpenAI sources, billed to the turn's own key. Personal Codex has no media
// function, so its turns are refused at admission with the typed reasons and
// nothing is written. A shared project's editor runs on the editor's own source.
describe('S67 plugin atoms on Studio execution sources', () => {
  const sources = [
    { executionSource: 'personal_subscription', agentId: 'codex' },
    { executionSource: 'company_pool', agentId: 'openai' },
    { executionSource: 'personal_api_key', agentId: 'openai-byok' },
  ];
  const liveArtifacts = (user: Principal, projectId: string) => request(user, 'GET', `/api/live-artifacts?projectId=${enc(projectId)}`);
  const rows = (conversationId: string) => withDb((db) => ({
    runs: (db.prepare('SELECT COUNT(*) AS n FROM multiuser_runs WHERE conversation_id = ?').get(conversationId) as { n: number }).n,
    messages: (db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(conversationId) as { n: number }).n,
  }));

  it.each(sources)('runs the live-artifact atom through the run-bound Studio tools on $executionSource', async (source) => {
    const target = await project(a);
    const applied = await apply(a, FIXTURE_LIVE_ARTIFACT_PLUGIN_ID, { projectId: target.projectId });
    expect(applied.status, applied.text).toBe(200);
    const pinned = withDb((db) => db.prepare('SELECT requirements_json FROM studio_plugin_applications WHERE snapshot_id = ?')
      .get(applied.json.snapshotId) as { requirements_json: string });
    expect(JSON.parse(pinned.requirements_json)).toEqual({ atoms: ['file-write', 'live-artifact'], capabilities: ['fs:write', 'prompt:inject'] });
    const before = atomRequests.length;
    const started = await turn(a, target, { ...source, message: '[plugin-live-artifact] [mock-live-artifact-create] Register the report.' });
    expect(started.status, started.text).toBe(202);
    const runId = started.json.runId as string;
    const events = await request(a, 'GET', `/api/runs/${runId}/events`);
    expect(events.text).toContain('"status":"succeeded"');
    expect(events.text).toContain('"type":"live_artifact"');
    const listed = await liveArtifacts(a, target.projectId);
    expect(listed.status, listed.text).toBe(200);
    expect(listed.json.artifacts).toHaveLength(1);
    expect(listed.json.artifacts[0]).toMatchObject({ projectId: target.projectId, sessionId: target.conversationId, createdByRunId: runId });
    const directive = '- live-artifact: live_artifacts_create, live_artifacts_list, live_artifacts_read, live_artifacts_update and live_artifacts_refresh';
    if (source.executionSource === 'personal_subscription') {
      expect(JSON.parse(readFileSync(path.join(codexHome(root, a.id), 'mock-turn-evidence.json'), 'utf8')).message).toContain(directive);
    } else {
      const sent = atomRequests.slice(before).find((item) => item.marker === '[plugin-live-artifact]')!;
      expect(sent.tools).toEqual(expect.arrayContaining(['live_artifacts_create', 'live_artifacts_refresh']));
      expect(sent.prompt).toContain(directive);
    }
    // B and the administrator: A's artifacts are the same refusal as a missing project.
    const missing = await liveArtifacts(b, randomUUID());
    for (const user of [b, admin]) expect((await liveArtifacts(user, target.projectId)).text).toBe(missing.text);
  });

  it.each(sources.slice(1))('runs the media-image atom on $executionSource, billed to the turn\'s own source', async (source) => {
    const target = await project(a);
    const applied = await apply(a, FIXTURE_MEDIA_PLUGIN_ID, { projectId: target.projectId });
    expect(applied.status, applied.text).toBe(200);
    const mediaBefore = mediaCalls.length; const before = atomRequests.length;
    const started = await turn(a, target, { ...source, message: '[plugin-media] Make the hero image.' });
    expect(started.status, started.text).toBe(202);
    const runId = started.json.runId as string;
    expect((await request(a, 'GET', `/api/runs/${runId}/events`)).text).toContain('"status":"succeeded"');
    const run = (await request(a, 'GET', `/api/runs/${runId}`)).json;
    expect(run.output.media).toEqual({ images: 1, speechCharacters: 0, videoSeconds: 0 });
    expect(run.output.files).toEqual(expect.arrayContaining(['assets/hero.png']));
    const key = source.executionSource === 'personal_api_key' ? 'sk-plugins-a-own-fixture-0123456789' : 'sk-plugins-race-fixture-0123456789';
    expect(mediaCalls.slice(mediaBefore).map((call) => call.authorization)).toEqual([`Bearer ${key}`]);
    const sent = atomRequests.slice(before).find((item) => item.marker === '[plugin-media]')!;
    expect(sent.tools).toEqual(expect.arrayContaining(['generate_image', 'live_artifacts_create']));
    expect(sent.prompt).toContain('- media-image: generate_image');
    expect((await request(a, 'GET', `/api/projects/${target.projectId}/raw/assets/hero.png`)).status).toBe(200);
    for (const user of [b, admin]) expect((await request(user, 'GET', `/api/projects/${target.projectId}/raw/assets/hero.png`)).status).toBe(404);
  });

  it('refuses a personal Codex turn of a media plugin at admission with typed reasons and writes nothing', async () => {
    const target = await project(a);
    const applied = await apply(a, FIXTURE_MEDIA_PLUGIN_ID, { projectId: target.projectId });
    expect(applied.status, applied.text).toBe(200);
    expect(applied.json.appliedPlugin.pluginId).toBe(FIXTURE_MEDIA_PLUGIN_ID);
    const refused = await turn(a, target, { message: '[plugin-media] Make the hero image.' });
    expect(refused.status, refused.text).toBe(409);
    expect(refused.json.error).toMatchObject({ code: 'MULTIUSER_CAPABILITY_UNAVAILABLE', details: { pluginId: FIXTURE_MEDIA_PLUGIN_ID,
      source: 'personal-codex', reasons: [{ code: 'atom', subject: 'media-image' }, { code: 'capability', subject: 'media:image' }] } });
    expect(rows(target.conversationId)).toEqual({ runs: 0, messages: 0 });
    // The pin is unchanged and still runs on an OpenAI source of the same conversation.
    expect((await request(a, 'GET', `/api/projects/${target.projectId}`)).json.project.appliedPluginSnapshotId).toBe(applied.json.snapshotId);
    const openaiTurn = await turn(a, target, { executionSource: 'personal_api_key', agentId: 'openai-byok', message: '[plugin-media] Make the hero image.' });
    expect(openaiTurn.status, openaiTurn.text).toBe(202);
    expect((await request(a, 'GET', `/api/runs/${openaiTurn.json.runId}/events`)).text).toContain('"status":"succeeded"');
  });

  // S67 repair 2 (review P2): the restrictions an application discloses come
  // from its pinned requirements, which admission enforces, not from whatever
  // the catalog says about the plugin today.
  it('discloses the pinned source restrictions of an application after the catalog drops the media requirement', async () => {
    const target = await project(a);
    const applied = await apply(a, FIXTURE_MEDIA_PLUGIN_ID, { projectId: target.projectId });
    expect(applied.status, applied.text).toBe(200);
    const pinnedRestriction = [{ source: 'personal-codex', reasons: [{ code: 'atom', subject: 'media-image' }, { code: 'capability', subject: 'media:image' }] }];
    expect(applied.json.sourceRestrictions).toEqual(pinnedRestriction);
    const snapshotId = applied.json.snapshotId as string;
    const original = withDb((db) => db.prepare('SELECT manifest_json FROM installed_plugins WHERE id = ?').get(FIXTURE_MEDIA_PLUGIN_ID) as { manifest_json: string });
    try {
      // v2 of the plugin no longer declares an image surface, capability or atom
      // (it declares what the every-source Live Artifact fixture declares).
      withDb((db) => db.prepare(`UPDATE installed_plugins SET manifest_json = json_set(manifest_json, '$.od',
          (SELECT json_extract(manifest_json, '$.od') FROM installed_plugins WHERE id = ?)) WHERE id = ?`)
        .run(FIXTURE_LIVE_ARTIFACT_PLUGIN_ID, FIXTURE_MEDIA_PLUGIN_ID));
      expect((await request(a, 'GET', `/api/plugins/${FIXTURE_MEDIA_PLUGIN_ID}`)).json.availability).toEqual({ applicable: true, reasons: [] });
      // The v1 application still needs media, so it still discloses the personal Codex restriction…
      for (const route of [`/api/applied-plugins/${snapshotId}`, `/api/multiuser/catalog/applied-plugins/${snapshotId}`]) {
        const pinned = await request(a, 'GET', route);
        expect(pinned.status, pinned.text).toBe(200);
        expect(pinned.json).toMatchObject({ snapshotId, pluginId: FIXTURE_MEDIA_PLUGIN_ID, sourceRestrictions: pinnedRestriction });
      }
      // …which is exactly what admission refuses.
      const refused = await turn(a, target, { message: '[plugin-media] v1 pin on Codex' });
      expect(refused.status, refused.text).toBe(409);
      expect(refused.json.error.details).toEqual({ pluginId: FIXTURE_MEDIA_PLUGIN_ID, ...pinnedRestriction[0] });
      expect(rows(target.conversationId)).toEqual({ runs: 0, messages: 0 });
    } finally {
      withDb((db) => db.prepare('UPDATE installed_plugins SET manifest_json = ? WHERE id = ?').run(original.manifest_json, FIXTURE_MEDIA_PLUGIN_ID));
    }
    // An application every source runs discloses none.
    const plain = await project(a);
    const everywhere = await apply(a, FIXTURE_LIVE_ARTIFACT_PLUGIN_ID, { projectId: plain.projectId });
    expect(everywhere.status, everywhere.text).toBe(200);
    expect(everywhere.json.sourceRestrictions).toBeUndefined();
    expect((await request(a, 'GET', `/api/applied-plugins/${everywhere.json.snapshotId}`)).json.sourceRestrictions).toBeUndefined();
  });

  it('keeps run-owner authority when an editor runs the owner\'s applied media plugin', async () => {
    const target = await project(a);
    expect((await apply(a, FIXTURE_MEDIA_PLUGIN_ID, { projectId: target.projectId })).status).toBe(200);
    expect((await request(a, 'PUT', `/api/multiuser/projects/${target.projectId}/shares`, { username: b.username, role: 'edit' })).status).toBe(200);
    try {
      const keyB = 'sk-plugins-b-own-fixture-0123456789';
      const state = await request(b, 'GET', '/api/multiuser/settings/provider-keys');
      const revision = state.json.keys?.find?.((item: { provider: string }) => item.provider === 'openai')?.revision ?? 0;
      const saved = await request(b, 'PUT', '/api/multiuser/settings/provider-keys/openai', { revision, apiKey: keyB });
      expect(saved.status, saved.text).toBe(200);
      const conversation = await request(b, 'POST', `/api/projects/${target.projectId}/conversations`, { title: 'B media' });
      expect(conversation.status, conversation.text).toBe(200);
      const own = { projectId: target.projectId, conversationId: conversation.json.conversation.id as string };
      // B cannot take A's plugin onto B's personal Codex source either.
      const refused = await turn(b, own, { message: '[plugin-media] B image' });
      expect(refused.status, refused.text).toBe(409);
      expect(refused.json.error.details).toMatchObject({ pluginId: FIXTURE_MEDIA_PLUGIN_ID, source: 'personal-codex' });
      const mediaBefore = mediaCalls.length;
      const started = await turn(b, own, { executionSource: 'personal_api_key', agentId: 'openai-byok', message: '[plugin-media] B image' });
      expect(started.status, started.text).toBe(202);
      expect((await request(b, 'GET', `/api/runs/${started.json.runId}/events`)).text).toContain('"status":"succeeded"');
      // The editor's own key pays; A cannot read or attach to B's run.
      expect(mediaCalls.slice(mediaBefore).map((call) => call.authorization)).toEqual([`Bearer ${keyB}`]);
      expect((await request(a, 'GET', `/api/runs/${started.json.runId}`)).status).toBe(404);
    } finally {
      expect((await request(a, 'DELETE', `/api/multiuser/projects/${target.projectId}/shares/${b.id}`)).status).toBe(200);
    }
  });
});

// S67 repair 1 (review P2 ×2): no dead plugins. A bundled plugin whose captured
// package instructs a desktop-only core step (media scaffold, HTML-to-video
// rendering, music/SFX, Codex-only tools, local scripts, `od` commands with no
// Studio function) is unavailable at catalog and apply with typed capability
// reasons, and run admission re-detects over the pinned package, so an
// application captured before the detector existed cannot start either.
describe('S67 repair 1: desktop-only core steps close plugins at catalog, apply and admission', () => {
  const designed = async () => {
    const target = await project(a);
    withDb((db) => db.prepare('UPDATE projects SET design_system_id = ? WHERE id = ?').run('airbnb', target.projectId));
    return target;
  };
  it.each(DEAD_CORE)('closes %s in the catalog and refuses its apply with typed reasons', async (id, subjects) => {
    const reasons = subjects.map((subject) => ({ code: 'capability', subject }));
    const detail = await request(a, 'GET', `/api/plugins/${id}`);
    expect(detail.status, detail.text).toBe(200);
    expect(detail.json.availability.applicable).toBe(false);
    expect(detail.json.availability.reasons).toEqual(expect.arrayContaining(reasons));
    expect(detail.json.availability.sourceRestrictions).toBeUndefined();
    const target = await designed();
    const before = withDb((db) => (db.prepare('SELECT COUNT(*) AS n FROM studio_plugin_applications').get() as { n: number }).n);
    const refused = await apply(a, id, { projectId: target.projectId });
    expect(refused.status, refused.text).toBe(403);
    expect(refused.json.error).toMatchObject({ code: 'MULTIUSER_CAPABILITY_UNAVAILABLE', details: { pluginId: id } });
    expect(refused.json.error.details.reasons).toEqual(expect.arrayContaining(reasons));
    expect(withDb((db) => (db.prepare('SELECT COUNT(*) AS n FROM studio_plugin_applications').get() as { n: number }).n)).toBe(before);
    expect((await request(a, 'GET', `/api/projects/${target.projectId}`)).json.project.appliedPluginSnapshotId ?? null).toBeNull();
  });

  it('keeps the runnable bundled media examples applicable on the OpenAI sources', async () => {
    for (const id of ['example-image-poster', 'example-frame-glitch-title', 'example-video-hyperframes']) {
      const detail = await request(a, 'GET', `/api/plugins/${id}`);
      expect(detail.json.availability, id).toMatchObject({ applicable: true, reasons: [] });
      const target = await designed();
      expect((await apply(a, id, { projectId: target.projectId })).status, id).toBe(200);
    }
  });

  it.each([
    { executionSource: 'personal_subscription', agentId: 'codex' },
    { executionSource: 'company_pool', agentId: 'openai' },
    { executionSource: 'personal_api_key', agentId: 'openai-byok' },
  ])('refuses an application captured before the detector existed on $executionSource and writes nothing', async (source) => {
    const target = await project(a);
    const applied = await apply(a, APPLICABLE, { projectId: target.projectId });
    expect(applied.status, applied.text).toBe(200);
    // The pre-detector application of od-share-to-community: its own SKILL.md
    // still tells the worker to install the generated plugin.
    const legacyId = randomUUID();
    const legacyPackage = buildStudioSkillPackage(`studio-plugin:${PIPELINE_ONLY}@0.1.0`, [{ path: 'SKILL.md', executable: false,
      bytes: Buffer.from('# Share\n\nRun `od plugin validate`, then `od plugin pack`, then `od plugin install --source <folder>`.\n') }]);
    withDb((db) => {
      const row = db.prepare('SELECT * FROM studio_plugin_applications WHERE snapshot_id = ?').get(applied.json.snapshotId) as Record<string, unknown>;
      const snapshot = { ...JSON.parse(String(row.snapshot_json)), snapshotId: legacyId, pluginId: PIPELINE_ONLY };
      const base = db.prepare('SELECT * FROM applied_plugin_snapshots WHERE id = ?').get(applied.json.snapshotId) as Record<string, unknown>;
      const copy: Record<string, unknown> = { ...base, id: legacyId, plugin_id: PIPELINE_ONLY };
      const columns = Object.keys(copy);
      db.prepare(`INSERT INTO applied_plugin_snapshots (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(...columns.map((key) => copy[key]));
      db.prepare(`INSERT INTO studio_plugin_applications (snapshot_id, owner_account_id, project_id, plugin_id, plugin_version, manifest_source_digest,
          snapshot_json, prompt, prompt_sha256, resource_package_json, requirements_json, applied_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(legacyId, a.id, target.projectId, PIPELINE_ONLY, row.plugin_version, row.manifest_source_digest, JSON.stringify(snapshot),
          row.prompt, row.prompt_sha256, JSON.stringify(legacyPackage),
          JSON.stringify({ atoms: ['file-read', 'file-write'], capabilities: ['fs:read', 'fs:write', 'prompt:inject'] }), Date.now());
      db.prepare('UPDATE projects SET applied_plugin_snapshot_id = ? WHERE id = ?').run(legacyId, target.projectId);
    });
    const eventCount = () => withDb((db) => (db.prepare('SELECT COUNT(*) AS n FROM multiuser_run_events').get() as { n: number }).n);
    const eventsBefore = eventCount();
    const refused = await turn(a, target, { ...source, message: 'Package and install this work' });
    expect(refused.status, refused.text).toBe(409);
    expect(refused.json.error).toMatchObject({ code: 'MULTIUSER_CAPABILITY_UNAVAILABLE', details: { pluginId: PIPELINE_ONLY,
      reasons: [{ code: 'capability', subject: 'desktop:od-cli' }] } });
    expect(refused.json.runId).toBeUndefined();
    expect(withDb((db) => db.prepare('SELECT id FROM multiuser_runs WHERE conversation_id = ?').all(target.conversationId))).toEqual([]);
    expect(withDb((db) => db.prepare('SELECT id FROM messages WHERE conversation_id = ?').all(target.conversationId))).toEqual([]);
    expect(eventCount()).toBe(eventsBefore);
    // S67 repair 2: the application discloses the same refusal for every source, from its pin.
    expect((await request(a, 'GET', `/api/applied-plugins/${legacyId}`)).json.sourceRestrictions).toEqual(['personal-codex', 'company-openai', 'account-openai']
      .map((item) => ({ source: item, reasons: [{ code: 'capability', subject: 'desktop:od-cli' }] })));
  });
});


describe('S70 HTTP plugin devloops on all pinned sources', () => {
  it.each([
    { executionSource: 'personal_subscription', agentId: 'codex' },
    { executionSource: 'company_pool', agentId: 'openai' },
    { executionSource: 'personal_api_key', agentId: 'openai-byok' },
  ])('runs the bounded Jury stage and persists its score on $executionSource', async (source) => {
    const target = await project(a);
    const original = withDb((db) => db.prepare('SELECT manifest_json FROM installed_plugins WHERE id = ?').get(PIPELINE) as { manifest_json: string });
    try {
      withDb((db) => db.prepare("UPDATE installed_plugins SET manifest_json = json_set(manifest_json, '$.od.pipeline', json(?)) WHERE id = ?")
        .run(JSON.stringify({ stages: [{ id: 'critique', atoms: ['critique-theater'], repeat: true, until: 'critique.score>=4 || iterations>=3' }] }), PIPELINE));
      expect((await apply(a, PIPELINE, { projectId: target.projectId })).status).toBe(200);
    } finally { withDb((db) => db.prepare('UPDATE installed_plugins SET manifest_json = ? WHERE id = ?').run(original.manifest_json, PIPELINE)); }
    setTurnMode(root, a, { reply: syntheticGoodTranscript() });
    try {
      const started = await turn(a, target, source);
      expect(started.status, started.text).toBe(202);
      const events = await request(a, 'GET', `/api/runs/${started.json.runId}/events`);
      expect(events.text).toContain('"status":"succeeded"');
      expect(events.text).toContain('"kind":"pipeline_stage_completed"');
      expect(events.text).toContain('"critiqueScore":');
      expect(events.text).toContain('"maxIterations":3');
      expect(events.text).not.toContain('ARTIFACT');
      const audits = withDb((db) => db.prepare('SELECT iteration, critique_summary FROM run_devloop_iterations WHERE run_id = ?').all(started.json.runId)) as Array<{ iteration: number; critique_summary: string }>;
      expect(audits).toHaveLength(1); expect(JSON.parse(audits[0]!.critique_summary).score).toBeGreaterThanOrEqual(4);
      const foreign = await request(b, 'GET', `/api/runs/${started.json.runId}/events`);
      expect(foreign.status).toBe(404);
    } finally { setTurnMode(root, a, {}); }
  });
  it.each(S70_DEVLOOP_SAMPLE.flatMap((sample) => sample.sources.map((source) => ({ ...sample, source }))))(
    'applies and terminates the sampled Web pipeline for $id on $source ($category)', async (sample) => {
      const target = await project(a);
      const body = { projectId: target.projectId, ...(sample.inputs ? { inputs: sample.inputs } : {}) };
      if (sample.projectDesign) {
        // Preserve S67 admission: an inherited brand is selected through the
        // same project API a Web user drives, never by changing DB/manifests.
        const missing = await apply(a, sample.id, body);
        expect(missing.status, missing.text).toBe(409);
        expect(missing.json.error).toMatchObject({ code: 'CONFLICT', message: 'select a design system before applying this plugin' });
        const design = await request(a, 'POST', '/api/design-systems', { title: 'S70 sample brand', body: '# S70 brand\nUse restrained typography and spacing.' });
        expect(design.status, design.text).toBe(201);
        const selected = await request(a, 'PATCH', `/api/projects/${target.projectId}`, { designSystemId: design.json.designSystem.id });
        expect(selected.status, selected.text).toBe(200);
        expect(selected.json.project.designSystemId).toBe(design.json.designSystem.id);
      }
      const applied = await apply(a, sample.id, body);
      expect(applied.status, applied.text).toBe(200);
      const pipeline = applied.json.appliedPlugin.pipeline as PluginPipeline;
      expect(pipeline.stages.find((stage) => stage.id === 'critique')).toMatchObject({ repeat: true, until: 'critique.score>=4 || iterations>=3' });
      const source = sample.source === 'personal-codex' ? { executionSource: 'personal_subscription', agentId: 'codex' }
        : sample.source === 'company-openai' ? { executionSource: 'company_pool', agentId: 'openai' }
        : { executionSource: 'personal_api_key', agentId: 'openai-byok' };
      const before = sampleRequests.length;
      setTurnMode(root, a, { reply: 'Stage complete.', stageResponses: {
        generate: { reply: 'Created the design.', artifactBytes: { 'index.html': Buffer.from(sampleHtml).toString('base64') }, liveArtifact: true },
        'critique:1': { reply: lowJuryScore },
        'critique:2': { reply: sample.ceiling ? lowJuryScore : syntheticGoodTranscript() },
        'critique:3': { reply: lowJuryScore },
      } });
      try {
        const started = await turn(a, target, { ...source, message: `[s70-sample:${sample.id}] Create the design from the captured resources. Audience: product team. Decision: approve the design. Content: a shipped product, 5 active users. Use image for the media kind.` });
        expect(started.status, started.text).toBe(202);
        const events = await request(a, 'GET', `/api/runs/${started.json.runId}/events`);
        expect(events.text).toContain('"status":"succeeded"');
        const frames = events.text.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)));
        const timeline: PluginPipelineStageEvent[] = frames.filter((frame) => frame.type === 'pipeline_stage').map((frame) => frame.stage);
        const completed = timeline.filter((stage) => stage.kind === 'pipeline_stage_completed');
        expect([...new Set(completed.map((stage) => stage.stageId))]).toEqual(pipeline.stages.map((stage) => stage.id));
        const critique = completed.filter((stage) => stage.stageId === 'critique');
        expect(critique.map((stage) => stage.iteration)).toEqual(sample.ceiling ? [0, 1, 2] : [0, 1]);
        expect(critique.map((stage) => stage.converged)).toEqual(sample.ceiling ? [false, false, true] : [false, true]);
        expect(critique.every((stage) => stage.maxIterations === 3 && stage.runId === started.json.runId && stage.snapshotId === applied.json.snapshotId)).toBe(true);
        expect(critique[0]!.critiqueScore).toBe(1);
        if (!sample.ceiling) expect(critique.at(-1)!.critiqueScore).toBeGreaterThanOrEqual(4);
        const starts = timeline.filter((stage) => stage.kind === 'pipeline_stage_started' && stage.stageId === 'critique');
        expect(starts.map((stage) => stage.iteration)).toEqual(critique.map((stage) => stage.iteration));
        const info = await request(a, 'GET', `/api/runs/${started.json.runId}`);
        expect(info.json.output.pipeline).toMatchObject({ stageIndex: pipeline.stages.length, awaitingInput: false });
        expect(info.json.output.files).toEqual(expect.arrayContaining(sample.expectedFiles));
        const artifacts = await request(a, 'GET', `/api/live-artifacts?projectId=${enc(target.projectId)}`);
        expect(artifacts.status, artifacts.text).toBe(200); expect(artifacts.json.artifacts).toHaveLength(1);
        const artifact = artifacts.json.artifacts[0];
        expect(artifact).toMatchObject({ projectId: target.projectId, sessionId: target.conversationId, createdByRunId: started.json.runId,
          preview: { type: 'html', entry: 'index.html' } });
        if (sample.media) {
          const mediaPath = sample.expectedFiles[0]!;
          expect(readFileSync(path.join(projectDir(path.join(root, 'projects'), target.projectId), mediaPath))).toEqual(PNG);
          const raw = `/api/projects/${target.projectId}/raw/${mediaPath}`;
          expect((await request(a, 'GET', raw)).status).toBe(200);
          for (const foreign of [b, admin]) expect((await request(foreign, 'GET', raw)).status).toBe(404);
          const preview = await request(a, 'GET', `/api/live-artifacts/${artifact.id}/preview?projectId=${enc(target.projectId)}&variant=rendered-source`);
          expect(preview.status, preview.text).toBe(200);
          expect(preview.text).toContain(`<img src="data:image/png;base64,${S70_MEDIA_PNG_BASE64}"`);
          expect(preview.text).toContain(mediaPath);
        }
        const audits = withDb((db) => db.prepare('SELECT iteration FROM run_devloop_iterations WHERE run_id = ? AND stage_id = ? ORDER BY rowid')
          .all(started.json.runId, 'critique'));
        expect(audits).toEqual(sample.ceiling ? [{ iteration: 1 }, { iteration: 2 }, { iteration: 3 }] : [{ iteration: 1 }, { iteration: 2 }]);
        const transcript = await request(a, 'GET', `/api/projects/${target.projectId}/conversations/${target.conversationId}/messages`);
        const assistant = transcript.json.messages.find((message: any) => message.runId === started.json.runId && message.role === 'assistant');
        expect(assistant.events.filter((event: any) => event.kind.startsWith('pipeline_stage_'))).toEqual(timeline);
        expect(assistant.events.filter((event: any) => event.kind === 'live_artifact')).toEqual([
          expect.objectContaining({ action: 'created', artifactId: artifact.id, projectId: target.projectId }),
        ]);
        if (sample.source !== 'personal-codex') {
          const calls = sampleRequests.slice(before);
          const key = sample.source === 'company-openai' ? 'sk-plugins-race-fixture-0123456789' : 'sk-plugins-a-own-fixture-0123456789';
          expect(calls.every((call) => call.authorization === `Bearer ${key}`)).toBe(true);
          expect(calls.filter((call) => call.stage === 'critique').map((call) => call.iteration)).toEqual(sample.ceiling ? [1, 2, 3] : [1, 2]);
          expect(calls.filter((call) => call.stage === 'critique').every((call) => !call.tools.includes('write_project_file') && !call.tools.includes('generate_image'))).toBe(true);
          if (sample.media) {
            expect(info.json.output.media.images).toBe(1);
            expect(info.json.output.files).toContain('assets/hero.png');
          }
        }
      } finally { setTurnMode(root, a, {}); }
  });
});


it.each([
  { executionSource: 'company_pool', agentId: 'openai' },
  { executionSource: 'personal_api_key', agentId: 'openai-byok' },
])('S70 resumes a question in iteration two without resetting its bound on $executionSource', async (source) => {
  const target = await project(a);
  const original = withDb((db) => db.prepare('SELECT manifest_json FROM installed_plugins WHERE id = ?').get(PIPELINE) as { manifest_json: string });
  try {
    withDb((db) => db.prepare("UPDATE installed_plugins SET manifest_json = json_set(manifest_json, '$.od.pipeline', json(?)) WHERE id = ?")
      .run(JSON.stringify({ stages: [{ id: 'critique', atoms: ['file-read', 'critique-theater'], repeat: true, until: 'critique.score>=5 || iterations>=3' }] }), PIPELINE));
    expect((await apply(a, PIPELINE, { projectId: target.projectId })).status).toBe(200);
  } finally { withDb((db) => db.prepare('UPDATE installed_plugins SET manifest_json = ? WHERE id = ?').run(original.manifest_json, PIPELINE)); }
  const started = await turn(a, target, { ...source, message: '[s70-question] Review the design' });
  expect(started.status, started.text).toBe(202);
  const events = await request(a, 'GET', `/api/runs/${started.json.runId}/events`);
  expect(events.text).toContain('"status":"succeeded"');
  const paused = await request(a, 'GET', `/api/runs/${started.json.runId}`);
  expect(paused.json.output.pipeline).toMatchObject({ awaitingInput: true, stageIndex: 0, iteration: 1 });
  const answered = await turn(a, target, { ...source, message: 'Use the current direction',
    analyticsHints: { entryFrom: 'question_answer', sourceRunId: started.json.runId } });
  expect(answered.status, answered.text).toBe(202);
  expect((await request(a, 'GET', `/api/runs/${answered.json.runId}/events`)).text).toContain('"status":"succeeded"');
  const iterations = withDb((db) => db.prepare('SELECT iteration FROM run_devloop_iterations WHERE run_id = ? ORDER BY rowid').all(answered.json.runId));
  expect(iterations).toEqual([{ iteration: 2 }, { iteration: 3 }]);
});
