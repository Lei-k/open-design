import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Express, Request, Response } from 'express';
import type {
  AppliedPluginSnapshot, InstalledPluginRecord, StudioPluginApplyRefusalDetails, StudioPluginApplyRequest,
  StudioPluginApplyResponse, StudioPluginRecord, PluginPipeline,
} from '@open-design/contracts';
import { parseStudioPluginSkillReferences, renderPluginBlock, resolveLocalizedText } from '@open-design/contracts';
import { multiUserActorOf } from '../http/multiuser-gate.js';
import { multiUserStreamAllowed } from '../http/multiuser-stream.js';
import { sendApiError } from '../http/api-errors.js';
import { applyPlugin, MissingInputError } from '../plugins/apply.js';
import { FIRST_PARTY_ATOMS } from '../plugins/atoms.js';
import { bundledScenarioRegistry } from '../plugins/bundled-scenarios.js';
import { getMarketplace, listMarketplaces } from '../plugins/marketplaces.js';
import { getInstalledPlugin, listInstalledPlugins } from '../plugins/registry.js';
import { createSnapshot, linkSnapshotToProject } from '../plugins/snapshots.js';
import { evaluateStudioPluginAvailability } from '../plugins/studio-availability.js';
import { captureStudioCraft } from '../plugins/studio-craft.js';
import { captureStudioPluginResources, type StudioPluginResources } from '../plugins/studio-resources.js';
import { readStudioSkillPackages, type StudioSkillPackage } from '../services/studio-skill-packages.js';
import { captureStudioPluginDesignContext, type StudioPluginDesignContext } from '../plugins/studio-design-context.js';
import { captureStudioPluginSkillContext, type StudioPluginSkillContext } from '../plugins/studio-skill-context.js';
import type { StudioDesignCatalog } from './studio-design-catalog.js';
import type { StudioCatalog } from './studio-catalog.js';
import type { StudioCatalogGrants } from '../storage/studio-catalog-grants.js';
import { AuthStore } from '../storage/auth-store.js';
import { ProjectAccessStore, projectRoleAtLeast } from '../storage/project-access.js';

const TABLE = 'studio_plugin_applications';
const PLUGIN_PROMPT_MAX_BYTES = 1024 * 1024;

/**
 * What a Studio turn captures from an applied plugin: the immutable prompt
 * rendered at apply (the single-user plugin block plus the plugin's own
 * local/catalog skills, design context and craft rulebooks), with the identity it was rendered from. Turns store this and
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
  pipeline?: PluginPipeline;
  resourcePackage?: StudioSkillPackage;
}

export interface StudioPlugins {
  /**
   * The project's current Studio apply snapshot as `actor` may use it in a
   * turn: an active owner or project member while both accounts are active.
   * Null when the project has none or the actor cannot read it.
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
  db: Database.Database; dataRoot: string; hostRoots: readonly string[]; craftRoot?: string; clock?: () => number;
  designCatalog?: Pick<StudioDesignCatalog, 'readSystem'>;
  designSystemsRoot?: string;
  designAccess?: Pick<StudioCatalogGrants, 'roleOf'>;
  skillCatalog?: Pick<StudioCatalog, 'readSkills'>;
  skillAccess?: Pick<StudioCatalogGrants, 'roleOf'>;
}): StudioPlugins {
  const { db } = input;
  const now = input.clock ?? Date.now;
  const accounts = AuthStore.open({ dataRoot: input.dataRoot });
  const projects = new ProjectAccessStore(db, { accountActive: (id) => accounts.getAccountById(id)?.active === true });
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
      resource_package_json TEXT,
      applied_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_project ON ${TABLE}(project_id, applied_at DESC);
    CREATE TRIGGER IF NOT EXISTS ${TABLE}_immutable BEFORE UPDATE ON ${TABLE}
      BEGIN SELECT RAISE(ABORT, 'a Studio plugin application is immutable'); END;`);
  // Existing text-only applications remain readable without a live fallback.
  if (!(db.prepare(`PRAGMA table_info(${TABLE})`).all() as Array<{ name: string }>).some((column) => column.name === 'resource_package_json')) {
    db.exec(`ALTER TABLE ${TABLE} ADD COLUMN resource_package_json TEXT`);
  }

  type Row = { snapshot_id: string; owner_account_id: string; project_id: string; plugin_id: string; plugin_version: string;
    manifest_source_digest: string; snapshot_json: string; prompt: string; prompt_sha256: string; resource_package_json: string | null };
  const readRow = (snapshotId: string) => db.prepare(`SELECT * FROM ${TABLE} WHERE snapshot_id = ?`).get(snapshotId) as Row | undefined;
  const capture = (row: Row): StudioPluginCapture => {
    const pipeline = (JSON.parse(row.snapshot_json) as AppliedPluginSnapshot).pipeline;
    const resource = row.resource_package_json === null ? undefined : JSON.parse(row.resource_package_json) as StudioSkillPackage;
    if (resource) readStudioSkillPackages([{ id: resource.id, package: resource }]);
    return { snapshotId: row.snapshot_id, projectId: row.project_id, pluginId: row.plugin_id,
      pluginVersion: row.plugin_version, manifestSourceDigest: row.manifest_source_digest, prompt: row.prompt, promptSha256: row.prompt_sha256,
      ...(pipeline ? { pipeline } : {}), ...(resource ? { resourcePackage: resource } : {}) };
  };
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

  app.post(`${prefix}/plugins/:id/apply`, handle(async (req, res, actor) => {
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
    const skillIds = parseStudioPluginSkillReferences(record.manifest.od?.context?.skills ?? [])!
      .filter((ref) => ref.kind === 'catalog').map((ref) => ref.id);
    const privateSkillIds = skillIds.filter((id) => id.startsWith('studio-skill:'));
    const skillsAllowed = () => privateSkillIds.every((id) => ['owner', 'use'].includes(input.skillAccess?.roleOf('skill', id, actor) ?? ''));
    if (!skillsAllowed()) return sendApiError(res, 404, 'NOT_FOUND', 'referenced skill not found or unavailable');
    // Capture private revision stamps before the first asynchronous catalog
    // read. A concurrent edit must not publish a mixture of revisions.
    const skillRevision = (id: string) => (db.prepare('SELECT revision FROM studio_skills WHERE id = ? AND deleted_at IS NULL')
      .get(id) as { revision: number } | undefined)?.revision;
    const skillRevisions = new Map(privateSkillIds.map((id) => [id, skillRevision(id)]));
    const skillContexts: StudioPluginSkillContext[] = [];
    if (skillIds.length) {
      const skills = await input.skillCatalog?.readSkills(actor, skillIds);
      if (!skills || skills.length !== skillIds.length || skills.some((skill, i) => skill.id !== skillIds[i]
        || skill.source !== (skill.id.startsWith('studio-skill:') ? 'user' : 'built-in'))) {
        return sendApiError(res, 404, 'NOT_FOUND', 'referenced skill not found or unavailable');
      }
      try { skillContexts.push(...skills.map(captureStudioPluginSkillContext)); }
      catch { return sendApiError(res, 409, 'CONFLICT', 'plugin skill content is unavailable'); }
    }
    const reference = record.manifest.od?.context?.designSystem;
    const projectDesignId = () => {
      const project = db.prepare('SELECT design_system_id FROM projects WHERE id = ?').get(body.projectId) as { design_system_id: string | null } | undefined;
      return project?.design_system_id ?? null;
    };
    const inheritedDesignId = reference && !reference.ref ? projectDesignId() : undefined;
    const designId = reference ? reference.ref ?? inheritedDesignId : null;
    const designAllowed = () => !designId?.startsWith('user:')
      || ['owner', 'use'].includes(input.designAccess?.roleOf('design-system', designId, actor) ?? '');
    let design: StudioPluginDesignContext | undefined;
    if (reference) {
      if (!designId) return sendApiError(res, 409, 'CONFLICT', 'select a design system before applying this plugin');
      if (!designAllowed()) return sendApiError(res, 404, 'NOT_FOUND', 'selected design system not found or unavailable');
      const system = await input.designCatalog?.readSystem(actor, designId);
      if (!system || system.id !== designId) return sendApiError(res, 404, 'NOT_FOUND', 'selected design system not found or unavailable');
      try { design = captureStudioPluginDesignContext(system, input.designSystemsRoot); }
      catch { return sendApiError(res, 409, 'CONFLICT', 'plugin design content is unavailable'); }
    }
    let craft: ReturnType<typeof captureStudioCraft>;
    try { craft = captureStudioCraft(input.craftRoot, record.manifest.od?.context?.craft ?? []); }
    catch { return sendApiError(res, 409, 'CONFLICT', 'plugin craft content is unavailable'); }
    let computed: ReturnType<typeof applyPlugin>;
    try {
      computed = applyPlugin({ plugin, inputs: body.inputs ?? {}, locale: body.locale ?? undefined, registry: {
        skills: skillContexts.map((skill) => ({ id: skill.id, title: skill.title })),
        designSystems: design ? [{ id: design.id, title: design.title }] : [], craft: craft.sections.map((id) => ({ id })),
        atoms: FIRST_PARTY_ATOMS.map((atom) => ({ id: atom.id, label: atom.label })), scenarios },
        ...(design ? { activeProjectDesignSystem: { id: design.id, title: design.title } } : {}) });
    } catch (error) {
      if (error instanceof MissingInputError) return res.status(422).json({ error: 'missing_inputs', fields: error.fields });
      throw error;
    }
    let resources: StudioPluginResources;
    try { resources = captureStudioPluginResources(record, [...(design?.files ?? []), ...skillContexts.flatMap((skill) => skill.files)]); }
    catch { return sendApiError(res, 409, 'CONFLICT', 'plugin content is unavailable'); }
    const title = computed.result.appliedPlugin.pluginTitle
      ?? (resolveLocalizedText(record.manifest.title_i18n, body.locale ?? undefined) || record.title);
    const prompt = [renderPluginBlock(computed.result.appliedPlugin).trim(),
      design?.prompt ?? '',
      craft.body ? `## Craft references\n\n${craft.body}` : '',
      ...resources.skills.map((skill) => `## Composed skill — ${title} (${skill.path})\n\n${skill.body}`),
      ...skillContexts.map((skill) => skill.prompt),
      resources.package ? `## Captured plugin files\n\nResource id: ${resources.package.id}\nAll relative plugin references use this immutable resource package. Use the captured resource tools to list, read or copy files; never read the installed plugin tree.\n\nPackage SHA-256: ${resources.package.hash}` : '']
      .filter(Boolean).join('\n\n---\n\n');
    if (Buffer.byteLength(prompt) > PLUGIN_PROMPT_MAX_BYTES) return sendApiError(res, 409, 'CONFLICT', 'plugin prompt exceeds the context limit');
    // Authority and the catalog row are re-decided synchronously with the commit.
    if (!multiUserStreamAllowed(res)) return;
    if (!skillsAllowed()) return sendApiError(res, 404, 'NOT_FOUND', 'referenced skill not found or unavailable');
    if (privateSkillIds.some((id) => skillRevisions.get(id) !== skillRevision(id))) {
      return sendApiError(res, 409, 'CONFLICT', 'referenced skill changed during apply');
    }
    if (!designAllowed()) return sendApiError(res, 404, 'NOT_FOUND', 'selected design system not found or unavailable');
    if (inheritedDesignId !== undefined && projectDesignId() !== inheritedDesignId) {
      return sendApiError(res, 409, 'CONFLICT', 'project design selection changed during apply');
    }
    const current = getInstalledPlugin(db, pluginId);
    if (!owned()) return sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'not found');
    if (!current || current.sourceKind !== 'bundled' || current.version !== record.version) return sendApiError(res, 404, 'NOT_FOUND', 'plugin not found');
    if (current.fsPath !== record.fsPath || current.sourceDigest !== record.sourceDigest
      || JSON.stringify(current.manifest) !== JSON.stringify(record.manifest)) {
      return sendApiError(res, 409, 'CONFLICT', 'plugin changed during apply');
    }
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
          snapshot_json, prompt, prompt_sha256, resource_package_json, applied_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(created.snapshotId, actor, body.projectId, created.pluginId, created.pluginVersion, created.manifestSourceDigest,
          JSON.stringify(created), prompt, createHash('sha256').update(prompt).digest('hex'),
          resources.package ? JSON.stringify(resources.package) : null, now());
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
      if (!canReadProject(projectId, actor)) return null;
      return capture(row);
    },
    close() { accounts.close(); },
  };
}
