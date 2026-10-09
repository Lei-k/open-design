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
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupIsolatedDataRoot, loadIsolatedServerModule, multiUserOptions, provisionAccounts,
  startMultiUserDaemon, type Principal, type StartedMultiUserDaemon } from './multiuser-harness.js';
import { PERSONAL_CODEX_MOCK, codexHome, linkCodex } from './personal-codex-helpers.js';

const APPLICABLE = 'od-share-to-community';
const REPO_ROOT = path.resolve('../..');

let daemon: StartedMultiUserDaemon; let root: string;
let a: Principal; let b: Principal; let admin: Principal;
beforeAll(async () => {
  ({ dataRoot: root } = await loadIsolatedServerModule());
  daemon = await startMultiUserDaemon(multiUserOptions({ testPersonalCodexAppServer: PERSONAL_CODEX_MOCK }));
  const accounts = await provisionAccounts(daemon, ['plugins-a', 'plugins-b']);
  [a, b] = accounts.users as [Principal, Principal]; admin = accounts.admin;
  await linkCodex(daemon, root, a, 'plugins-a@example.test');
  await linkCodex(daemon, root, b, 'plugins-b@example.test');
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
    // Declared steps decide availability: file-read/file-write run on Web.
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
    const unavailable = listed.find((plugin) => !plugin.availability.applicable)!;
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
    expect(first).toContain('generated-plugin/');
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
      ['POST', `/api/plugins/${APPLICABLE}/upgrade`, {}],
      ['POST', `/api/plugins/${APPLICABLE}/uninstall`, {}],
      ['POST', `/api/plugins/${APPLICABLE}/doctor`, {}],
      ['POST', `/api/plugins/${APPLICABLE}/trust`, { capabilities: ['subprocess'] }],
      ['POST', `/api/plugins/${APPLICABLE}/apply-local`, { source: '/tmp/x' }],
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
});
