import type { InstalledPluginRecord } from '@open-design/contracts';
import { useI18n } from '../i18n';
import { studioPluginAvailability, studioPluginReasonTokens } from '../runtime/studio-plugins';
import styles from './PluginWebAvailability.module.css';

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
    return (
      <span className={`${styles.availability} ${styles.applicable}`} data-testid={`plugin-web-availability-${record.id}`} data-applicable="true">
        <span className={styles.badge}>{t('pluginsView.webApplyFromProject')}</span>
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
