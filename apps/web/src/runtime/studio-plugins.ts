// Bundled plugin availability on Web (#61, S41). The daemon computes it from
// its capability registry; this module only reads the additive field. Desktop
// records carry no `availability`, so they read as unknown (null) here and
// every existing desktop path is unchanged.
import type { InstalledPluginRecord, StudioPluginAvailability, StudioPluginUnavailableReason } from '@open-design/contracts';

export function studioPluginAvailability(record: InstalledPluginRecord | null | undefined): StudioPluginAvailability | null {
  const value = (record as { availability?: unknown } | null | undefined)?.availability;
  if (!value || typeof value !== 'object') return null;
  const { applicable, reasons } = value as { applicable?: unknown; reasons?: unknown };
  if (typeof applicable !== 'boolean' || !Array.isArray(reasons)) return null;
  return { applicable, reasons: reasons.filter((reason): reason is StudioPluginUnavailableReason =>
    Boolean(reason) && typeof (reason as { code?: unknown }).code === 'string') };
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
