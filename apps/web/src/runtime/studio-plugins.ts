// Bundled plugin availability on Web (#61, S41). The daemon computes it from
// its capability registry; this module only reads the additive field. Desktop
// records carry no `availability`, so they read as unknown (null) here and
// every existing desktop path is unchanged.
import { STUDIO_PLUGIN_EXECUTION_SOURCES, type InstalledPluginRecord, type StudioPluginAvailability, type StudioPluginExecutionSource,
  type StudioPluginSourceRestriction, type StudioPluginUnavailableReason } from '@open-design/contracts';

const isReason = (reason: unknown): reason is StudioPluginUnavailableReason =>
  Boolean(reason) && typeof (reason as { code?: unknown }).code === 'string';

/** S67: sources whose turns refuse a plugin. Only known sources with typed reasons are kept. */
function parseSourceRestrictions(value: unknown): StudioPluginSourceRestriction[] {
  return Array.isArray(value) ? value.flatMap((item): StudioPluginSourceRestriction[] => {
    const { source, reasons: lacking } = (item ?? {}) as { source?: unknown; reasons?: unknown };
    if (!STUDIO_PLUGIN_EXECUTION_SOURCES.includes(source as StudioPluginExecutionSource) || !Array.isArray(lacking)) return [];
    const kept = lacking.filter(isReason);
    return kept.length ? [{ source: source as StudioPluginExecutionSource, reasons: kept }] : [];
  }) : [];
}

export function studioPluginAvailability(record: InstalledPluginRecord | null | undefined): StudioPluginAvailability | null {
  const value = (record as { availability?: unknown } | null | undefined)?.availability;
  if (!value || typeof value !== 'object') return null;
  const { applicable, reasons, sourceRestrictions } = value as { applicable?: unknown; reasons?: unknown; sourceRestrictions?: unknown };
  if (typeof applicable !== 'boolean' || !Array.isArray(reasons)) return null;
  const restrictions = applicable ? parseSourceRestrictions(sourceRestrictions) : [];
  return { applicable, reasons: reasons.filter(isReason), ...(restrictions.length ? { sourceRestrictions: restrictions } : {}) };
}

/**
 * The sources whose turns refuse an applied plugin, as the daemon derived them
 * from the application's pin (S67 repair 2): the `sourceRestrictions` of a
 * Studio apply response or of `GET /api/applied-plugins/:id`. These, not the
 * plugin's current catalog row, describe what admission enforces for that
 * application. Desktop responses carry none.
 */
export function studioAppliedPluginRestrictions(response: unknown): StudioPluginSourceRestriction[] {
  return response && typeof response === 'object' ? parseSourceRestrictions((response as { sourceRestrictions?: unknown }).sourceRestrictions) : [];
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
