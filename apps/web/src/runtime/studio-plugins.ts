// Bundled plugin availability on Web (#61, S41). The daemon computes it from
// its capability registry; this module only reads the additive field. Desktop
// records carry no `availability`, so they read as unknown (null) here and
// every existing desktop path is unchanged.
import { STUDIO_PLUGIN_EXECUTION_SOURCES, type InstalledPluginRecord, type StudioPluginAvailability, type StudioPluginExecutionSource,
  type StudioPluginSourceRestriction, type StudioPluginUnavailableReason } from '@open-design/contracts';

const isReason = (reason: unknown): reason is StudioPluginUnavailableReason =>
  Boolean(reason) && typeof (reason as { code?: unknown }).code === 'string';

export function studioPluginAvailability(record: InstalledPluginRecord | null | undefined): StudioPluginAvailability | null {
  const value = (record as { availability?: unknown } | null | undefined)?.availability;
  if (!value || typeof value !== 'object') return null;
  const { applicable, reasons, sourceRestrictions } = value as { applicable?: unknown; reasons?: unknown; sourceRestrictions?: unknown };
  if (typeof applicable !== 'boolean' || !Array.isArray(reasons)) return null;
  // S67: sources whose turns refuse an applicable plugin. Only known sources with reasons are kept.
  const restrictions = applicable && Array.isArray(sourceRestrictions) ? sourceRestrictions.flatMap((item): StudioPluginSourceRestriction[] => {
    const { source, reasons: lacking } = (item ?? {}) as { source?: unknown; reasons?: unknown };
    if (!STUDIO_PLUGIN_EXECUTION_SOURCES.includes(source as StudioPluginExecutionSource) || !Array.isArray(lacking)) return [];
    const kept = lacking.filter(isReason);
    return kept.length ? [{ source: source as StudioPluginExecutionSource, reasons: kept }] : [];
  }) : [];
  return { applicable, reasons: reasons.filter(isReason), ...(restrictions.length ? { sourceRestrictions: restrictions } : {}) };
}

/** Desktop records (no availability) stay offered; a Web-unavailable plugin is not. */
export function studioPluginOffered(record: InstalledPluginRecord): boolean {
  return studioPluginAvailability(record)?.applicable !== false;
}

/**
 * Short identifiers for the reasons (atom ids, capabilities, stage ids), not
 * prose: they name what the plugin needs and need no translation.
 */
export function studioPluginReasonTokens(reasons: readonly StudioPluginUnavailableReason[], max = 4): string[] {
  const tokens = [...new Set(reasons.map((reason) => {
    switch (reason.code) {
      case 'pipeline-devloop': return `${reason.subject ?? 'stage'} ↻`;
      case 'strategy': return 'OD Next strategy';
      case 'genui': return 'GenUI';
      case 'manifest': return 'manifest';
      default: return reason.subject ?? reason.code;
    }
  }))];
  return tokens.length > max ? [...tokens.slice(0, max), `+${tokens.length - max}`] : tokens;
}
