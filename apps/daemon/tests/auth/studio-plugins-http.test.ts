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
// - Review repairs: Studio turns run no pipeline stages, so no bundled plugin
//   is applicable today (F1); apply is covered with a test-only fixture row
//   evaluated by the same registry. A turn whose plugin choice read the live
//   project pin, empty or not, is refused when the pin changes before its
//   commit, on every execution source (F2).
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupIsolatedDataRoot, loadIsolatedServerModule, multiUserOptions, provisionAccounts,
  startMultiUserDaemon, type Principal, type StartedMultiUserDaemon } from './multiuser-harness.js';
import { PERSONAL_CODEX_MOCK, codexHome, linkCodex, until } from './personal-codex-helpers.js';
import { FIXTURE_PLUGIN_ID, FIXTURE_SKILL_MARKER, PIPELINE_ONLY_PLUGIN_ID, installStudioFixturePlugin } from './studio-plugin-fixture.js';

/** Test-only applicable plugin (see studio-plugin-fixture.ts); no bundled plugin is applicable on Web today. */
const APPLICABLE = FIXTURE_PLUGIN_ID;
/** Bundled, and unavailable on Web only because Studio turns do not run its pipeline. */
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
const openai: typeof fetch = async () => new Response(`data: ${JSON.stringify({ type: 'response.completed', response: {
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Noted.' }] }] } })}\n\n`,
{ headers: { 'content-type': 'text/event-stream' } });

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
    // Studio turns run no pipeline stages: a pipeline of Web atoms (file-read,
    // file-write) is still unavailable, with the typed `pipeline` reason.
    expect(byId.get(PIPELINE_ONLY)?.availability).toEqual({ applicable: false, reasons: [{ code: 'pipeline' }] });
    // No bundled plugin is applicable today; only the test-only fixture row is.
    expect(listed.filter((plugin) => plugin.availability.applicable).map((plugin) => plugin.id)).toEqual([APPLICABLE]);
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
    const unavailable = listed.find((plugin) => plugin.id === PIPELINE_ONLY)!;
    expect(unavailable.availability.reasons).toEqual([{ code: 'pipeline' }]);
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
