import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { Express, Request, Response } from 'express';
import type {
  AppliedPluginSnapshot, InstalledPluginRecord, StudioPluginApplyRefusalDetails, StudioPluginApplyRequest,
  StudioPluginApplyResponse, StudioPluginRecord,
} from '@open-design/contracts';
import { renderPluginBlock, resolveLocalizedText } from '@open-design/contracts';
import { multiUserActorOf } from '../http/multiuser-gate.js';
import { multiUserStreamAllowed } from '../http/multiuser-stream.js';
import { sendApiError } from '../http/api-errors.js';
import { applyPlugin, MissingInputError, pickFirstLocalSkillPath } from '../plugins/apply.js';
import { FIRST_PARTY_ATOMS } from '../plugins/atoms.js';
import { bundledScenarioRegistry } from '../plugins/bundled-scenarios.js';
import { getMarketplace, listMarketplaces } from '../plugins/marketplaces.js';
import { getInstalledPlugin, listInstalledPlugins } from '../plugins/registry.js';
import { createSnapshot, linkSnapshotToProject } from '../plugins/snapshots.js';
import { evaluateStudioPluginAvailability } from '../plugins/studio-availability.js';
import { AuthStore } from '../storage/auth-store.js';
import { ProjectAccessStore, projectRoleAtLeast } from '../storage/project-access.js';

/** A plugin's own SKILL.md is captured at apply; bounded like a captured skill document. */
const PLUGIN_SKILL_MAX_BYTES = 256 * 1024;
const TABLE = 'studio_plugin_applications';

/**
 * What a Studio turn captures from an applied plugin: the immutable prompt
 * rendered at apply (the single-user plugin block plus the plugin's own
 * SKILL.md), with the identity it was rendered from. Turns store this and
 * never read the bundled tree or the catalog row again.
 */
export interface StudioPluginCapture {
  snapshotId: string;
  projectId: string;
  pluginId: string;
  pluginVersion: string;
  manifestSourceDigest: string;
  prompt: string;
  promptSha256: string;
}

export interface StudioPlugins {
  /**
   * The project's current Studio apply snapshot as `actor` may use it in a
   * turn: the owner always; another account only while the project owner is
   * active (S40 deactivation semantics). Null when the project has none.
   */
  projectPin(projectId: string, actor: string): StudioPluginCapture | null;
  close(): void;
}

const isAbsoluteHostPath = (value: string) => value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || /^file:/i.test(value) || value.startsWith('\\\\');

/** A bundled plugin as a Web account reads it: no host folder, install source or path. */
function projectRecord(record: InstalledPluginRecord): InstalledPluginRecord {
  const source = `bundled:${record.id}`;
  return { ...record, source, fsPath: '', ...(record.resolvedSource !== undefined ? { resolvedSource: source } : {}) };
}

/** Marketplace rows are host configuration; Web accounts read them without host paths. */
function withoutHostPaths(value: unknown, hostRoots: readonly string[]): unknown {
  if (typeof value === 'string') return isAbsoluteHostPath(value) || hostRoots.some((root) => value.includes(root)) ? undefined : value;
  if (Array.isArray(value)) return value.map((item) => withoutHostPaths(item, hostRoots)).filter((item) => item !== undefined);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
      if (key === 'fsPath') return [];
      const kept = withoutHostPaths(item, hostRoots);
      return kept === undefined ? [] : [[key, kept]];
    }));
  }
  return value;
}

/**
 * Read the plugin's own SKILL.md from the trusted bundled folder: a regular,
 * single-link file inside the plugin folder, opened without following links
 * and bounded. Anything else refuses the apply rather than dropping the skill.
 */
function readPluginSkill(record: InstalledPluginRecord, relative: string): string {
  const folder = fs.realpathSync(record.fsPath);
  const target = path.resolve(folder, relative);
  if (!target.startsWith(`${folder}${path.sep}`)) throw new Error('plugin skill path escapes the plugin folder');
  const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > PLUGIN_SKILL_MAX_BYTES) throw new Error('plugin skill is not a bounded regular file');
    const buffer = Buffer.alloc(stat.size);
    fs.readSync(fd, buffer, 0, stat.size, 0);
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } finally { fs.closeSync(fd); }
}

/** The skill body without its frontmatter, as captured skills are composed. */
function skillBody(document: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(document);
  return (match ? document.slice(match[0].length) : document).trim();
}

/**
 * Bundled plugin catalog and apply for Studio accounts (#61, S41). Standard
 * aliases terminate here; the host-global plugin registrar never runs for a
 * cookie actor.
 *
 * - Catalog: every account reads the same bundled plugins, each with
 *   `availability` from the Web capability evaluator. No host paths.
 * - Apply: owner-only onto the actor's own project, only for applicable
 *   plugins. The snapshot (and the rendered prompt) is captured once and is
 *   immutable; removing or upgrading the bundled plugin never changes it.
 * - Applied snapshots: readable by members of the project (owner, or a grantee
 *   while the owner is active); foreign and missing are one 404.
 * - Marketplaces: read-only, without host paths. Fetch and changes stay refused at the gate.
 */
export function registerStudioPluginRoutes(app: Express, input: {
  db: Database.Database; dataRoot: string; hostRoots: readonly string[]; clock?: () => number;
}): StudioPlugins {
  const { db } = input;
  const now = input.clock ?? Date.now;
  const projects = new ProjectAccessStore(db);
  const accounts = AuthStore.open({ dataRoot: input.dataRoot });
  db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (
      snapshot_id TEXT PRIMARY KEY,
      owner_account_id TEXT NOT NULL CHECK (length(owner_account_id) > 0),
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      plugin_id TEXT NOT NULL,
      plugin_version TEXT NOT NULL,
      manifest_source_digest TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      prompt TEXT NOT NULL,
      prompt_sha256 TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_project ON ${TABLE}(project_id, applied_at DESC);
    CREATE TRIGGER IF NOT EXISTS ${TABLE}_immutable BEFORE UPDATE ON ${TABLE}
      BEGIN SELECT RAISE(ABORT, 'a Studio plugin application is immutable'); END;`);

  type Row = { snapshot_id: string; owner_account_id: string; project_id: string; plugin_id: string; plugin_version: string;
    manifest_source_digest: string; snapshot_json: string; prompt: string; prompt_sha256: string };
  const readRow = (snapshotId: string) => db.prepare(`SELECT * FROM ${TABLE} WHERE snapshot_id = ?`).get(snapshotId) as Row | undefined;
  const capture = (row: Row): StudioPluginCapture => ({ snapshotId: row.snapshot_id, projectId: row.project_id, pluginId: row.plugin_id,
    pluginVersion: row.plugin_version, manifestSourceDigest: row.manifest_source_digest, prompt: row.prompt, promptSha256: row.prompt_sha256 });
  const ownerActive = (projectId: string) => {
    const owner = projects.ownership.ownerOf(projectId);
    return Boolean(owner && accounts.getAccountById(owner)?.active === true);
  };
  /** Owner, or a grantee of at least `view` while the project owner is active. */
  const canReadProject = (projectId: string, actor: string) => {
    const role = projects.roleOf(projectId, actor);
    return role === 'owner' || (projectRoleAtLeast(role, 'view') && ownerActive(projectId));
  };
  const bundled = () => listInstalledPlugins(db).filter((record) => record.sourceKind === 'bundled');
  const catalogEntry = (record: InstalledPluginRecord, scenarios: ReturnType<typeof bundledScenarioRegistry>): StudioPluginRecord =>
    ({ ...projectRecord(record), availability: evaluateStudioPluginAvailability(record, scenarios) });
  const handle = (operation: (req: Request, res: Response, actor: string) => unknown) => async (req: Request, res: Response) => {
    const actor = multiUserActorOf(res)?.accountId;
    if (!actor) return sendApiError(res, 401, 'UNAUTHORIZED', 'authentication required');
    res.setHeader('Cache-Control', 'no-store');
    try { await operation(req, res, actor); }
    catch { if (!res.headersSent) sendApiError(res, 500, 'INTERNAL_ERROR', 'plugin catalog operation failed'); }
  };
  const prefix = '/api/multiuser/catalog';

  app.get(`${prefix}/plugins`, handle((_req, res) => {
    const rows = bundled();
    const scenarios = bundledScenarioRegistry(rows);
    res.json({ plugins: rows.map((record) => catalogEntry(record, scenarios)) });
  }));

  app.get(`${prefix}/plugins/:id`, handle((req, res) => {
    const record = getInstalledPlugin(db, String(req.params.id));
    if (!record || record.sourceKind !== 'bundled') return sendApiError(res, 404, 'NOT_FOUND', 'plugin not found');
    res.json(catalogEntry(record, bundledScenarioRegistry(bundled())));
  }));

  app.post(`${prefix}/plugins/:id/apply`, handle((req, res, actor) => {
    const body = req.body as StudioPluginApplyRequest;
    const pluginId = String(req.params.id);
    // Owner-only (S32: project settings are the owner's). Foreign, shared and
    // missing projects are the same answer, for the admin as well.
    const owned = () => projects.ownership.ownerOf(body.projectId) === actor;
    if (!owned()) return sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'not found');
    const record = getInstalledPlugin(db, pluginId);
    if (!record || record.sourceKind !== 'bundled') return sendApiError(res, 404, 'NOT_FOUND', 'plugin not found');
    const rows = bundled();
    const scenarios = bundledScenarioRegistry(rows);
    const availability = evaluateStudioPluginAvailability(record, scenarios);
    if (!availability.applicable) {
      const details: StudioPluginApplyRefusalDetails = { pluginId, reasons: availability.reasons };
      return sendApiError(res, 403, 'MULTIUSER_CAPABILITY_UNAVAILABLE', 'this plugin declares steps Studio turns do not run yet',
        { details: JSON.parse(JSON.stringify(details)) });
    }
    const plugin = projectRecord(record);
    let computed: ReturnType<typeof applyPlugin>;
    try {
      computed = applyPlugin({ plugin, inputs: body.inputs ?? {}, locale: body.locale ?? undefined, registry: {
        skills: [], designSystems: [], craft: [], atoms: FIRST_PARTY_ATOMS.map((atom) => ({ id: atom.id, label: atom.label })), scenarios } });
    } catch (error) {
      if (error instanceof MissingInputError) return res.status(422).json({ error: 'missing_inputs', fields: error.fields });
      throw error;
    }
    // The plugin's own SKILL.md rides with the snapshot; it is never re-read.
    const skillPath = pickFirstLocalSkillPath(record.manifest);
    let skill = '';
    if (skillPath) {
      try { skill = skillBody(readPluginSkill(record, skillPath)); }
      catch { return sendApiError(res, 409, 'CONFLICT', 'plugin content is unavailable'); }
    }
    const title = computed.result.appliedPlugin.pluginTitle
      ?? (resolveLocalizedText(record.manifest.title_i18n, body.locale ?? undefined) || record.title);
    const prompt = [renderPluginBlock(computed.result.appliedPlugin).trim(), skill ? `## Composed skill — ${title}\n\n${skill}` : '']
      .filter(Boolean).join('\n\n---\n\n');
    // Authority and the catalog row are re-decided synchronously with the commit.
    if (!multiUserStreamAllowed(res)) return;
    const current = getInstalledPlugin(db, pluginId);
    if (!owned()) return sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'not found');
    if (!current || current.sourceKind !== 'bundled' || current.version !== record.version) return sendApiError(res, 404, 'NOT_FOUND', 'plugin not found');
    const snap = computed.result.appliedPlugin;
    const snapshot = db.transaction((): AppliedPluginSnapshot => {
      const created = createSnapshot(db, {
        projectId: body.projectId, pluginId: snap.pluginId, pluginSpecVersion: snap.pluginSpecVersion, pluginVersion: snap.pluginVersion,
        pluginTitle: snap.pluginTitle, pluginDescription: snap.pluginDescription, manifestSourceDigest: computed.manifestSourceDigest,
        sourceMarketplaceId: snap.sourceMarketplaceId, sourceMarketplaceEntryName: snap.sourceMarketplaceEntryName,
        sourceMarketplaceEntryVersion: snap.sourceMarketplaceEntryVersion, marketplaceTrust: snap.marketplaceTrust,
        resolvedSource: snap.resolvedSource, taskKind: snap.taskKind, inputs: snap.inputs, resolvedContext: snap.resolvedContext,
        craftRequires: snap.craftRequires, pipeline: snap.pipeline, genuiSurfaces: snap.genuiSurfaces,
        capabilitiesGranted: snap.capabilitiesGranted, capabilitiesRequired: snap.capabilitiesRequired, assetsStaged: snap.assetsStaged,
        connectorsRequired: snap.connectorsRequired, connectorsResolved: snap.connectorsResolved, mcpServers: snap.mcpServers, query: snap.query,
      });
      linkSnapshotToProject(db, created.snapshotId, body.projectId);
      db.prepare(`INSERT INTO ${TABLE} (snapshot_id, owner_account_id, project_id, plugin_id, plugin_version, manifest_source_digest,
          snapshot_json, prompt, prompt_sha256, applied_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(created.snapshotId, actor, body.projectId, created.pluginId, created.pluginVersion, created.manifestSourceDigest,
          JSON.stringify(created), prompt, createHash('sha256').update(prompt).digest('hex'), now());
      return created;
    })();
    const response: StudioPluginApplyResponse = { ok: true, ...computed.result, appliedPlugin: snapshot, projectId: body.projectId,
      snapshotId: snapshot.snapshotId, warnings: computed.warnings, manifestSourceDigest: computed.manifestSourceDigest };
    res.json(response);
  }));

  app.get(`${prefix}/applied-plugins/:snapshotId`, handle((req, res, actor) => {
    const row = readRow(String(req.params.snapshotId));
    if (!row || !canReadProject(row.project_id, actor)) return sendApiError(res, 404, 'NOT_FOUND', 'not found');
    res.json(JSON.parse(row.snapshot_json) as AppliedPluginSnapshot);
  }));

  const hostRoots = [input.dataRoot, ...input.hostRoots].filter((root) => root.length > 1);
  app.get(`${prefix}/marketplaces`, handle((_req, res) => {
    res.json({ marketplaces: listMarketplaces(db).map((row) => withoutHostPaths(row, hostRoots)) });
  }));
  app.get(`${prefix}/marketplaces/:id`, handle((req, res) => {
    const row = getMarketplace(db, String(req.params.id));
    if (!row) return sendApiError(res, 404, 'NOT_FOUND', 'marketplace not found');
    res.json(withoutHostPaths(row, hostRoots));
  }));
  app.get(`${prefix}/marketplaces/:id/plugins`, handle((req, res) => {
    const row = getMarketplace(db, String(req.params.id));
    if (!row) return sendApiError(res, 404, 'NOT_FOUND', 'marketplace not found');
    res.json({ plugins: withoutHostPaths(row.manifest.plugins ?? [], hostRoots) });
  }));

  return {
    projectPin(projectId, actor) {
      const pinned = (db.prepare('SELECT applied_plugin_snapshot_id AS id FROM projects WHERE id = ?').get(projectId) as { id: string | null } | undefined)?.id;
      const row = pinned ? readRow(pinned) : undefined;
      if (!row || row.project_id !== projectId) return null;
      const owner = projects.ownership.ownerOf(projectId);
      if (!owner || (owner !== actor && !ownerActive(projectId))) return null;
      return capture(row);
    },
    close() { accounts.close(); },
  };
}
