// The bundled scenarios apply may fall back to when a plugin omits
// `od.pipeline` (spec §23.3.3). Pure: callers pass the installed rows.
//
// Only rows the bundled boot walker wrote (`sourceKind === 'bundled'`) with
// `od.kind === 'scenario'` and a non-empty pipeline qualify, so a
// user-installed scenario never becomes a default. More than one bundled
// scenario may share a taskKind; the canonical id `od-<taskKind>` wins the
// fallback slot, otherwise the first one listed.

import type { InstalledPluginRecord, PluginManifest } from '@open-design/contracts';

export interface BundledScenarioEntry {
  id: string;
  taskKind: 'new-generation' | 'figma-migration' | 'code-migration' | 'tune-collab';
  pipeline: NonNullable<NonNullable<PluginManifest['od']>['pipeline']>;
}

export function bundledScenarioRegistry(rows: ReadonlyArray<Pick<InstalledPluginRecord, 'id' | 'sourceKind' | 'manifest'>>): BundledScenarioEntry[] {
  const byTaskKind = new Map<BundledScenarioEntry['taskKind'], BundledScenarioEntry>();
  for (const row of rows) {
    if (row.sourceKind !== 'bundled') continue;
    const od = row.manifest.od;
    if (!od || od.kind !== 'scenario') continue;
    if (!od.pipeline || !Array.isArray(od.pipeline.stages) || od.pipeline.stages.length === 0) continue;
    const taskKind = (od.taskKind ?? 'new-generation') as BundledScenarioEntry['taskKind'];
    if (taskKind !== 'new-generation' && taskKind !== 'figma-migration'
      && taskKind !== 'code-migration' && taskKind !== 'tune-collab') continue;
    const entry: BundledScenarioEntry = { id: row.id, taskKind, pipeline: od.pipeline };
    const existing = byTaskKind.get(taskKind);
    if (!existing || entry.id === `od-${taskKind}`) byTaskKind.set(taskKind, entry);
  }
  return Array.from(byTaskKind.values());
}
