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

/**
 * What Studio turns run today, on every execution source (personal Codex,
 * the company OpenAI pool and the account's own key).
 *
 * - `atoms`: first-party atoms the turn performs itself. File reads and
 *   writes run through the project-scoped workspace or file tools, and
 *   `<question-form>` clarifications render and continue on every source.
 *   TodoWrite is personal-Codex only, so it is not listed.
 * - `capabilities`: manifest `od.capabilities` entries the turn honours.
 * - `pipelines`: a stage runner. Studio turns capture the plugin block and
 *   SKILL.md only; they neither run a plugin's ordered stages nor render the
 *   active stage, so any pipeline apply would run (declared or scenario
 *   fallback, repeating or not) is unavailable until they do.
 * - `pipelineDevloop`: repeat/until stages need the devloop scheduler and
 *   stage workers, which Studio turns do not run.
 * - `context`: captured into the immutable apply snapshot. Only the plugin's
 *   own SKILL.md files are captured today.
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
  atoms: ['discovery-question-form', 'file-edit', 'file-read', 'file-write'],
  capabilities: ['fs:read', 'fs:write', 'prompt:inject'],
  pipelines: false,
  pipelineDevloop: false,
  strategy: false,
  genui: false,
  connectors: false,
  mcp: false,
  context: { localSkills: true, skillRefs: false, designSystem: false, craft: false, assets: false, claudePlugins: false },
  sourceKinds: ['bundled'],
};

/**
 * Why a plugin cannot be applied by a Web account.
 * - `atom`: a first-party atom the turn does not run (`subject` = atom id).
 * - `unknown-atom`: an atom the first-party catalog does not define.
 * - `pipeline`: apply would run a pipeline (declared or scenario fallback)
 *   and Studio turns have no stage runner. The stage atoms are reported too.
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
