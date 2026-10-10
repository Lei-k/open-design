// Bundled plugin catalog and apply for multi-user Studio accounts (#61, S41).
//
// Product decision 2026-10-09 (option b): an account may apply a bundled
// plugin only when every step it declares runs in a Studio turn today. All
// other bundled plugins stay listed with typed reasons. Availability is
// computed by evaluating the one capability registry below against each
// manifest's declarations; there is no per-plugin list. When a capability
// lands on Web, adding it here makes more plugins applicable.

import type { ApplyResult } from '../plugins/apply.js';
import type { InstalledPluginRecord } from '../plugins/installed.js';
import type { PluginPipeline } from '../plugins/manifest.js';

/** Session-bound URL to captured bundled bytes on the isolated preview origin. */
export interface StudioPluginPreviewResponse {
  pluginId: string;
  version: string;
  entry: string;
  sha256: string;
  url: string;
  expiresAt: number;
}

/** Upper bound on an ordered Studio plugin pipeline (finite stage runner, S42). */
export const STUDIO_PIPELINE_MAX_STAGES = 32;

/** The finite, ordered pipeline subset executed on every Studio source. */
export function isStudioOrderedPipeline(value: unknown): value is PluginPipeline {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const stages = (value as Record<string, unknown>).stages;
  if (!Array.isArray(stages) || stages.length > STUDIO_PIPELINE_MAX_STAGES || Object.keys(value).some((key) => key !== 'stages')) return false;
  const ids = new Set<string>();
  return stages.every((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const stage = item as Record<string, unknown>;
    if (typeof stage.id !== 'string' || !/^[\w.-]{1,128}$/.test(stage.id) || ids.has(stage.id)) return false;
    ids.add(stage.id);
    return Array.isArray(stage.atoms) && stage.atoms.length <= 32
      && stage.atoms.every((atom) => typeof atom === 'string' && STUDIO_WEB_PLUGIN_CAPABILITIES.atoms.includes(atom))
      && (stage.repeat === undefined || stage.repeat === false) && stage.until === undefined
      && (stage.onFailure === undefined || stage.onFailure === 'abort')
      && Object.keys(stage).every((key) => ['id', 'atoms', 'repeat', 'onFailure'].includes(key));
  });
}

/** Daemon-authored cursor; a question answer resumes the unfinished stage. */
export interface StudioPipelineProgress {
  snapshotId: string;
  stageIndex: number;
  stageCount: number;
  awaitingInput: boolean;
}

/**
 * What Studio turns run today, on every execution source (personal Codex,
 * the company OpenAI pool and the account's own key).
 *
 * - `atoms`: first-party atoms the turn performs itself. File reads and
 *   writes run through the project-scoped workspace or file tools, and
 *   `<question-form>` clarifications render and continue on every source.
 *   Plans use native Codex updates or the bounded OpenAI `update_plan` tool,
 *   both persisted and rendered through the shared todo event contract.
 * - `capabilities`: manifest `od.capabilities` entries the turn honours.
 * - `pipelines`: a finite ordered stage runner. Every stage invokes the
 *   turn's pinned provider with prior-stage context and renders its active
 *   stage in the standard transcript. Questions pause at that stage.
 * - `pipelineDevloop`: repeat/until stages need the devloop scheduler and
 *   stage workers, which Studio turns do not run.
 * - `context`: captured into the immutable apply snapshot. Only the plugin's
 *   own SKILL.md files, authorized catalog skills, bundled side files,
 *   requested craft rulebooks and design documents/packages are captured at apply.
 * - `strategy`, `genui`, `connectors`, `mcp`: not run by Studio turns.
 */
export interface StudioWebPluginCapabilities {
  atoms: readonly string[];
  capabilities: readonly string[];
  pipelines: boolean;
  pipelineDevloop: boolean;
  strategy: boolean;
  genui: boolean;
  connectors: boolean;
  mcp: boolean;
  context: {
    localSkills: boolean; skillRefs: boolean; designSystem: boolean;
    craft: boolean; assets: boolean; claudePlugins: boolean;
  };
  /** Install sources a Web account may apply from. Third-party installs stay refused. */
  sourceKinds: readonly string[];
}

export const STUDIO_WEB_PLUGIN_CAPABILITIES: StudioWebPluginCapabilities = {
  atoms: ['discovery-question-form', 'file-edit', 'file-read', 'file-write', 'todo-write'],
  capabilities: ['fs:read', 'fs:write', 'prompt:inject'],
  pipelines: true,
  pipelineDevloop: false,
  strategy: false,
  genui: false,
  connectors: false,
  mcp: false,
  context: { localSkills: true, skillRefs: true, designSystem: true, craft: true, assets: true, claudePlugins: false },
  sourceKinds: ['bundled'],
};

/** Bounded bundled rulebook identifiers; never filesystem paths or URLs. */
export function isStudioPluginCraftReferences(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 32 && new Set(value).size === value.length
    && value.every((slug) => typeof slug === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(slug));
}

/** Plugin-local files or directory trees; no host, hidden or parent paths. */
export function isStudioPluginAssetReferences(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 128 && value.every((entry) => {
    if (typeof entry !== 'string' || entry.length > 1024 || entry.includes('\\') || /[\u0000-\u001f]/u.test(entry)) return false;
    const relative = entry.startsWith('./') ? entry.slice(2) : entry;
    const segments = relative.split('/');
    return segments.length <= 17 && segments.every((part) => part.length > 0 && !part.startsWith('.') && part !== 'node_modules' && !part.includes(':'));
  });
}

export interface StudioPluginSkillReference { kind: 'local' | 'catalog'; id: string }

/** Same path/ref interpretation as standard apply, with closed declarations.
 * Catalog ids never name host paths; local files stay within the plugin tree.
 * Reject aliases of the same local path rather than composing a skill twice.
 */
export function parseStudioPluginSkillReferences(value: unknown): StudioPluginSkillReference[] | null {
  if (!Array.isArray(value) || value.length > 12) return null;
  const result: StudioPluginSkillReference[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const reference = item as Record<string, unknown>;
    if (Object.keys(reference).some((key) => !['ref', 'path'].includes(key))
      || (reference.ref !== undefined && reference.path !== undefined)) return null;
    const id = reference.ref ?? reference.path;
    if (typeof id !== 'string' || !id || id.trim() !== id) return null;
    const local = reference.ref === undefined && (id.startsWith('./') || id.startsWith('../') || id.includes('/'));
    if (local ? !isStudioPluginAssetReferences([id]) : !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) return null;
    const normalized = local && id.startsWith('./') ? id.slice(2) : id;
    const key = `${local ? 'local' : 'catalog'}:${normalized}`;
    if (seen.has(key)) return null;
    seen.add(key);
    result.push({ kind: local ? 'local' : 'catalog', id: normalized });
  }
  return result;
}

/** Explicit catalog id, or the project's selected primary design system.
 * The legacy registry normalizes some primary references to an empty object;
 * like apply's resolver, that form binds the active project selection.
 */
export function isStudioPluginDesignSystemReference(value: unknown): value is { ref?: string; primary?: boolean } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const reference = value as Record<string, unknown>;
  return Object.keys(reference).every((key) => ['ref', 'primary'].includes(key))
    && (reference.primary === undefined || typeof reference.primary === 'boolean')
    && (reference.ref === undefined || typeof reference.ref === 'string' && reference.ref.trim() === reference.ref
      && reference.ref.length > 0 && reference.ref.length <= 128 && /^[\w:-]+$/.test(reference.ref))
    && (typeof reference.ref === 'string' || reference.primary !== false);
}

/**
 * Why a plugin cannot be applied by a Web account.
 * - `atom`: a first-party atom the turn does not run (`subject` = atom id).
 * - `unknown-atom`: an atom the first-party catalog does not define.
 * - `pipeline`: apply would run a pipeline (declared or scenario fallback)
 *   while the capability registry disables its runner. Stage atoms are reported too.
 * - `pipeline-devloop`: a repeat/until stage (`subject` = stage id).
 * - `strategy`: an OD Next strategy binding.
 * - `genui`: a declared or derived GenUI surface (`subject` = surface id).
 * - `connector` / `mcp`: a connector or MCP server (`subject` = id/name).
 * - `capability`: an `od.capabilities` entry (`subject` = capability).
 * - `context`: context the apply snapshot cannot capture yet
 *   (`assets`, `craft`, `design-system`, `skill-ref`, `claude-plugin`).
 * - `manifest`: a declaration that does not parse (`subject` = field). Fails closed.
 * - `source`: not a bundled plugin (`subject` = source kind).
 */
export type StudioPluginUnavailableCode =
  | 'atom' | 'unknown-atom' | 'pipeline' | 'pipeline-devloop' | 'strategy' | 'genui'
  | 'connector' | 'mcp' | 'capability' | 'context' | 'manifest' | 'source';

export interface StudioPluginUnavailableReason {
  code: StudioPluginUnavailableCode;
  subject?: string;
}

/** `applicable` is true exactly when `reasons` is empty. */
export interface StudioPluginAvailability {
  applicable: boolean;
  reasons: StudioPluginUnavailableReason[];
}

/**
 * A bundled plugin as a Studio account reads it. Host locations are removed:
 * `fsPath` is empty and `source`/`resolvedSource` name the bundle, never a
 * filesystem path. `availability` is additive to the single-user record.
 */
export type StudioPluginRecord = InstalledPluginRecord & { availability: StudioPluginAvailability };

/** GET /api/plugins (Studio alias /api/multiuser/catalog/plugins). */
export interface StudioPluginListResponse {
  plugins: StudioPluginRecord[];
}

/**
 * POST /api/plugins/:id/apply for a Studio account. Owner-only: the project
 * must be the actor's own (an S32 editor cannot change project settings).
 * `grantCaps` is accepted only empty; host capability grants stay refused.
 */
export interface StudioPluginApplyRequest {
  projectId: string;
  inputs?: Record<string, string | number | boolean>;
  grantCaps?: [];
  locale?: string;
}

/** The single-user ApplyResult with the persisted, project-pinned snapshot. */
export type StudioPluginApplyResponse = ApplyResult & {
  ok: true;
  projectId: string;
  snapshotId: string;
  warnings: string[];
  manifestSourceDigest: string;
};

/** `error.details` of a refused apply (`403 MULTIUSER_CAPABILITY_UNAVAILABLE`). */
export interface StudioPluginApplyRefusalDetails {
  pluginId: string;
  reasons: StudioPluginUnavailableReason[];
}

/** Host-global plugin operations a Web account is refused, by typed capability. */
export type StudioPluginRefusedCapability =
  | 'plugin-install' | 'plugin-marketplace' | 'plugin-doctor' | 'plugin-trust' | 'plugin-scripts';

/** `error.details` of a refused host-global plugin operation. */
export interface StudioPluginCapabilityRefusalDetails {
  capability: StudioPluginRefusedCapability;
  reason: string;
}

export const STUDIO_PLUGIN_APPLY_FIELDS = ['projectId', 'inputs', 'grantCaps', 'locale'] as const;
export const STUDIO_PLUGIN_APPLY_MAX_INPUTS = 32;
export const STUDIO_PLUGIN_APPLY_MAX_INPUT_CHARS = 4000;

/** Pure shape check of an apply body (the gate's body policy). */
export function isStudioPluginApplyRequest(value: unknown): value is StudioPluginApplyRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  if (!Object.keys(body).every((key) => (STUDIO_PLUGIN_APPLY_FIELDS as readonly string[]).includes(key))) return false;
  if (typeof body.projectId !== 'string' || body.projectId.length === 0 || body.projectId.length > 128) return false;
  if (body.grantCaps !== undefined && !(Array.isArray(body.grantCaps) && body.grantCaps.length === 0)) return false;
  if (body.locale !== undefined && body.locale !== null && (typeof body.locale !== 'string' || body.locale.length > 64)) return false;
  if (body.inputs === undefined || body.inputs === null) return true;
  if (typeof body.inputs !== 'object' || Array.isArray(body.inputs)) return false;
  const entries = Object.entries(body.inputs as Record<string, unknown>);
  return entries.length <= STUDIO_PLUGIN_APPLY_MAX_INPUTS && entries.every(([key, input]) => key.length > 0 && key.length <= 128
    && (typeof input === 'boolean' || (typeof input === 'number' && Number.isFinite(input))
      || (typeof input === 'string' && input.length <= STUDIO_PLUGIN_APPLY_MAX_INPUT_CHARS)));
}
