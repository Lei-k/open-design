// Studio (multi-user Web) plugin availability, #61 / S41.
//
// One capability registry (`STUDIO_WEB_PLUGIN_CAPABILITIES`, contracts) is
// evaluated against what a plugin declares. The pipeline evaluated is the one
// desktop apply would run: the declared pipeline, or the bundled scenario it
// falls back to, plus the core plan/critique stages apply adds
// (`ensureCoreQualityStages`). A plugin is applicable only when every step,
// atom, capability and context item it declares runs in a Studio turn; nothing
// is keyed by plugin id. Declarations that do not parse fail closed.
//
// Studio turns have no stage runner today (`pipelines: false`): a turn carries
// the captured plugin block and SKILL.md, never the ordered stages. Any
// non-empty pipeline is therefore its own `pipeline` reason, whatever its
// atoms; applying it would silently drop the stages it declares.

import type {
  InstalledPluginRecord,
  PluginPipeline,
  StudioPluginAvailability,
  StudioPluginUnavailableReason,
  StudioWebPluginCapabilities,
} from '@open-design/contracts';
import { STUDIO_WEB_PLUGIN_CAPABILITIES } from '@open-design/contracts';
import { resolveAppliedPipeline, type ScenarioRegistryEntry } from '@open-design/plugin-runtime';
import { isKnownAtom } from './atoms.js';
import { deriveAutoAtomSurfaces } from './atoms/auto-surfaces.js';
import { ensureCoreQualityStages } from './ensure-core-stages.js';
import { isInternalBundledStrategyV2 } from './strategy-provenance.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

/** The declared pipeline, or the field name that does not parse. */
function declaredPipeline(od: Record<string, unknown>): PluginPipeline | undefined | 'invalid' {
  if (od.pipeline === undefined) return undefined;
  if (!isRecord(od.pipeline) || !Array.isArray(od.pipeline.stages)) return 'invalid';
  const valid = od.pipeline.stages.every((stage) => isRecord(stage) && typeof stage.id === 'string' && stage.id.length > 0
    && isStringArray(stage.atoms) && (stage.repeat === undefined || typeof stage.repeat === 'boolean')
    && (stage.until === undefined || typeof stage.until === 'string'));
  return valid ? od.pipeline as PluginPipeline : 'invalid';
}

export function evaluateStudioPluginAvailability(
  plugin: InstalledPluginRecord,
  scenarios: ReadonlyArray<ScenarioRegistryEntry>,
  web: StudioWebPluginCapabilities = STUDIO_WEB_PLUGIN_CAPABILITIES,
): StudioPluginAvailability {
  if (!web.sourceKinds.includes(plugin.sourceKind)) {
    return { applicable: false, reasons: [{ code: 'source', subject: plugin.sourceKind }] };
  }
  const reasons = new Map<string, StudioPluginUnavailableReason>();
  const add = (reason: StudioPluginUnavailableReason) => {
    reasons.set(`${reason.code}\0${reason.subject ?? ''}`, reason);
  };
  const od = plugin.manifest?.od as unknown;
  if (od !== undefined && !isRecord(od)) add({ code: 'manifest', subject: 'od' });
  const decl: Record<string, unknown> = isRecord(od) ? od : {};

  if (!web.strategy && (decl.strategy !== undefined || isInternalBundledStrategyV2(plugin))) add({ code: 'strategy' });

  if (decl.capabilities !== undefined) {
    if (!isStringArray(decl.capabilities)) add({ code: 'manifest', subject: 'capabilities' });
    else for (const capability of decl.capabilities) if (!web.capabilities.includes(capability)) add({ code: 'capability', subject: capability });
  }

  if (decl.context !== undefined) {
    if (!isRecord(decl.context)) add({ code: 'manifest', subject: 'context' });
    else {
      const context = decl.context;
      const list = (key: string) => context[key] === undefined ? [] : Array.isArray(context[key]) ? context[key] as unknown[] : null;
      const skills = list('skills'); const assets = list('assets'); const craft = list('craft');
      const claudePlugins = list('claudePlugins'); const mcp = list('mcp'); const atoms = list('atoms');
      if (!skills || !assets || !craft || !claudePlugins || !mcp || !atoms
        || (context.designSystem !== undefined && !isRecord(context.designSystem))) add({ code: 'manifest', subject: 'context' });
      for (const ref of skills ?? []) {
        if (!isRecord(ref)) { add({ code: 'manifest', subject: 'context' }); continue; }
        // Same rule as apply (`pickFirstLocalSkillPath`): a relative path is the plugin's own file.
        const local = typeof ref.ref !== 'string' && typeof ref.path === 'string'
          && (ref.path.startsWith('./') || ref.path.startsWith('../') || ref.path.includes('/'));
        if (local ? !web.context.localSkills : !web.context.skillRefs) add({ code: 'context', subject: local ? 'local-skill' : 'skill-ref' });
      }
      if (assets?.length && !web.context.assets) add({ code: 'context', subject: 'assets' });
      if (craft?.length && !web.context.craft) add({ code: 'context', subject: 'craft' });
      if (claudePlugins?.length && !web.context.claudePlugins) add({ code: 'context', subject: 'claude-plugin' });
      if (context.designSystem !== undefined && !web.context.designSystem) add({ code: 'context', subject: 'design-system' });
      for (const server of mcp ?? []) {
        if (!isRecord(server) || typeof server.name !== 'string') add({ code: 'manifest', subject: 'context' });
        else if (!web.mcp) add({ code: 'mcp', subject: server.name });
      }
      for (const atom of atoms ?? []) {
        if (typeof atom !== 'string') add({ code: 'manifest', subject: 'context' });
        else if (!isKnownAtom(atom)) add({ code: 'unknown-atom', subject: atom });
        else if (!web.atoms.includes(atom)) add({ code: 'atom', subject: atom });
      }
    }
  }

  if (decl.connectors !== undefined) {
    if (!isRecord(decl.connectors)) add({ code: 'manifest', subject: 'connectors' });
    else for (const key of ['required', 'optional']) {
      const refs = decl.connectors[key];
      if (refs === undefined) continue;
      if (!Array.isArray(refs)) { add({ code: 'manifest', subject: 'connectors' }); continue; }
      for (const ref of refs) {
        if (!isRecord(ref) || typeof ref.id !== 'string') add({ code: 'manifest', subject: 'connectors' });
        else if (!web.connectors) add({ code: 'connector', subject: ref.id });
      }
    }
  }

  if (decl.genui !== undefined) {
    const surfaces = isRecord(decl.genui) ? decl.genui.surfaces : null;
    if (surfaces !== undefined && !Array.isArray(surfaces)) add({ code: 'manifest', subject: 'genui' });
    for (const surface of Array.isArray(surfaces) ? surfaces : []) {
      if (!isRecord(surface) || typeof surface.id !== 'string') add({ code: 'manifest', subject: 'genui' });
      else if (!web.genui) add({ code: 'genui', subject: surface.id });
    }
  }

  // The pipeline apply would run: declared, or the bundled scenario fallback,
  // with the core plan/critique floor apply adds.
  const declared = declaredPipeline(decl);
  if (declared === 'invalid') add({ code: 'manifest', subject: 'pipeline' });
  else {
    const resolution = resolveAppliedPipeline({ manifest: plugin.manifest, scenarios });
    const pipeline = ensureCoreQualityStages({
      pipeline: resolution.pipeline,
      taskKind: typeof decl.taskKind === 'string' ? decl.taskKind : 'new-generation',
      mode: typeof decl.mode === 'string' ? decl.mode : undefined,
      source: resolution.source,
    });
    if ((pipeline?.stages.length ?? 0) > 0 && !web.pipelines) add({ code: 'pipeline' });
    for (const stage of pipeline?.stages ?? []) {
      if ((stage.repeat || stage.until) && !web.pipelineDevloop) add({ code: 'pipeline-devloop', subject: stage.id });
      for (const atom of stage.atoms ?? []) {
        if (!isKnownAtom(atom)) add({ code: 'unknown-atom', subject: atom });
        else if (!web.atoms.includes(atom)) add({ code: 'atom', subject: atom });
      }
    }
    if (!web.genui) for (const surface of deriveAutoAtomSurfaces({ pipeline })) add({ code: 'genui', subject: surface.id });
  }

  const list = [...reasons.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, reason]) => reason);
  return { applicable: list.length === 0, reasons: list };
}

/** Counts for reporting: applicable/unavailable and how many plugins carry each reason. */
export function studioPluginReasonSummary(items: ReadonlyArray<StudioPluginAvailability>): {
  total: number; applicable: number; unavailable: number; byReason: Record<string, number>;
} {
  const byReason: Record<string, number> = {};
  for (const item of items) {
    for (const reason of item.reasons) {
      const key = reason.subject ? `${reason.code}:${reason.subject}` : reason.code;
      byReason[key] = (byReason[key] ?? 0) + 1;
    }
  }
  const applicable = items.filter((item) => item.applicable).length;
  return { total: items.length, applicable, unavailable: items.length - applicable,
    byReason: Object.fromEntries(Object.entries(byReason).sort(([a], [b]) => (a < b ? -1 : 1))) };
}
