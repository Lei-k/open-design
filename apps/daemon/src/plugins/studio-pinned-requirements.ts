// What a pinned Studio plugin application needs from each execution source
// (S67, #61/#63). One derivation serves run admission, the apply response and
// `GET /api/applied-plugins/:id`, so the restrictions an application discloses
// are exactly the ones admission enforces (S67 repair 2). It reads only the
// immutable application — its pinned requirements and captured package —
// never the plugin's current catalog row: a catalog upgrade changes neither.

import type {
  PluginPipeline, StudioPluginExecutionSource, StudioPluginRequirements, StudioPluginSourceRestriction, StudioPluginUnavailableReason,
} from '@open-design/contracts';
import { STUDIO_PLUGIN_EXECUTION_SOURCES, studioPluginSourceReasons } from '@open-design/contracts';
import type { StudioSkillPackage } from '../services/studio-skill-packages.js';
import { studioDevloop } from './studio-devloop.js';
import { detectStudioDesktopSteps, STUDIO_PLUGIN_PACKAGE_UNREADABLE, studioPluginPackageDocuments } from './studio-desktop-steps.js';

/** The parts of an application (or a run's captured copy of it) the derivation reads. */
export interface StudioPinnedPlugin {
  /** Pinned at apply; captures from before S67 carry none and fall back to their stage atoms. */
  requirements?: StudioPluginRequirements;
  pipeline?: PluginPipeline;
  resourcePackage?: StudioSkillPackage;
}

/** Deployment facts the derivation needs: whether the canonical Live Artifact registrar is mounted. */
export interface StudioPinnedPluginRuntime {
  liveArtifacts: boolean;
}

/**
 * The pinned requirements plus the desktop-only steps the detector finds in
 * the pinned package (so an application captured before a rule existed cannot
 * run a dead core step), and the fixed refusals that hold for every source.
 */
function pinnedNeeds(pin: StudioPinnedPlugin, runtime: StudioPinnedPluginRuntime) {
  const pinned = pin.requirements
    ?? { atoms: [...new Set((pin.pipeline?.stages ?? []).flatMap((stage) => stage.atoms ?? []))], capabilities: [] };
  const documents = studioPluginPackageDocuments(pin.resourcePackage);
  const requirements: StudioPluginRequirements = { atoms: pinned.atoms, capabilities: [...new Set([...pinned.capabilities,
    ...(documents ? detectStudioDesktopSteps(documents) : []).map((reason) => reason.subject!)])] };
  const always: StudioPluginUnavailableReason[] = [
    ...(pin.pipeline?.stages ?? []).flatMap((stage) => studioDevloop(stage).reasons),
    ...(!runtime.liveArtifacts && requirements.atoms.includes('live-artifact') ? [{ code: 'atom' as const, subject: 'live-artifact' }] : []),
    ...(documents ? [] : [STUDIO_PLUGIN_PACKAGE_UNREADABLE]),
  ];
  return { requirements, always };
}

/** Typed reasons a turn on `source` cannot run this application; empty when it can. */
export function studioPinnedPluginSourceReasons(pin: StudioPinnedPlugin, source: StudioPluginExecutionSource,
  runtime: StudioPinnedPluginRuntime): StudioPluginUnavailableReason[] {
  const { requirements, always } = pinnedNeeds(pin, runtime);
  return [...always, ...studioPluginSourceReasons(requirements, source)];
}

/** Every source whose turns refuse this application, in source order; empty when all run it. */
export function studioPinnedPluginSourceRestrictions(pin: StudioPinnedPlugin, runtime: StudioPinnedPluginRuntime): StudioPluginSourceRestriction[] {
  const { requirements, always } = pinnedNeeds(pin, runtime);
  return STUDIO_PLUGIN_EXECUTION_SOURCES.flatMap((source) => {
    const reasons = [...always, ...studioPluginSourceReasons(requirements, source)];
    return reasons.length ? [{ source, reasons }] : [];
  });
}
