import type { InstalledPluginRecord, StudioPluginExecutionSource } from '@open-design/contracts';
import { useI18n } from '../i18n';
import type { Dict } from '../i18n/types';
import { studioPluginAvailability, studioPluginReasonTokens } from '../runtime/studio-plugins';
import styles from './PluginWebAvailability.module.css';

/** The Studio source picker's own labels name each execution source. */
const SOURCE_LABELS: Record<StudioPluginExecutionSource, keyof Dict> = {
  'personal-codex': 'multiuser.executionSourcePersonalCodex',
  'company-openai': 'multiuser.executionSourceCompanyOpenAI',
  'account-openai': 'multiuser.executionSourcePersonalKey',
};

/**
 * One label per execution source whose turns cannot run an applicable plugin
 * (S67), e.g. "Not on Codex · personal subscription · Needs: media-image".
 * The Plugins page, the composer picker/preview and the applied-plugin chip all
 * use these exact labels, as the CLI prints the same reasons.
 */
export function studioPluginRestrictionLabels(record: InstalledPluginRecord | null | undefined,
  t: (key: keyof Dict, vars?: Record<string, string | number>) => string): string[] {
  const availability = studioPluginAvailability(record);
  if (!availability?.applicable) return [];
  return (availability.sourceRestrictions ?? []).map((item) => t('pluginsView.webSourceRestricted', {
    source: t(SOURCE_LABELS[item.source]), reasons: studioPluginReasonTokens(item.reasons).join(', ') }));
}

/** The restriction labels as inline text; nothing when every source runs the plugin. */
export function PluginSourceRestrictions({ record }: { record: InstalledPluginRecord }) {
  const { t } = useI18n();
  const labels = studioPluginRestrictionLabels(record, t);
  if (!labels.length) return null;
  return (
    <span className={styles.restrictions} data-testid={`plugin-source-restrictions-${record.id}`}>
      {labels.map((label) => <span key={label} className={styles.reasons}>{label}</span>)}
    </span>
  );
}

/**
 * Whether a bundled plugin can be applied by a Web account, and why not (#61).
 * Renders nothing for desktop records, which carry no availability. Applicable
 * plugins are applied from a project's composer; the reasons of an unavailable
 * plugin name the atoms, stages or capabilities Studio turns do not run yet.
 */
export function PluginWebAvailability({ record }: { record: InstalledPluginRecord }) {
  const { t } = useI18n();
  const availability = studioPluginAvailability(record);
  if (!availability) return null;
  if (availability.applicable) {
    // S67: an applicable plugin some execution sources cannot run (media on personal Codex).
    const restrictions = availability.sourceRestrictions ?? [];
    return (
      <span className={`${styles.availability} ${styles.applicable}`} data-testid={`plugin-web-availability-${record.id}`} data-applicable="true"
        {...(restrictions.length ? { 'data-restricted-sources': restrictions.map((item) => item.source).join(' ') } : {})}>
        <span className={styles.badge}>{t('pluginsView.webApplyFromProject')}</span>
        {studioPluginRestrictionLabels(record, t).map((label) => <span key={label} className={styles.reasons}>{label}</span>)}
      </span>
    );
  }
  const all = studioPluginReasonTokens(availability.reasons, Number.POSITIVE_INFINITY).join(', ');
  return (
    <span className={styles.availability} data-testid={`plugin-web-availability-${record.id}`} data-applicable="false" title={all}>
      <span className={styles.badge}>{t('pluginsView.webUnavailable')}</span>
      <span className={styles.reasons}>{t('pluginsView.webUnavailableNeeds', { reasons: studioPluginReasonTokens(availability.reasons).join(', ') })}</span>
    </span>
  );
}
