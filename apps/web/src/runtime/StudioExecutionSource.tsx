import { useT } from '../i18n';
import { useStudioCapabilities } from './studio-capabilities';
import styles from './StudioExecutionSource.module.css';

/**
 * The composer's agent slot for an actor without a host agent catalog: the
 * execution source is fixed by the server (personal Codex), so it is stated,
 * not chosen. The title carries why choosing is unavailable.
 */
export function StudioExecutionSource() {
  const studio = useStudioCapabilities();
  const t = useT();
  if (studio.executionAgentId !== 'codex') return null;
  return (
    <span className={styles.source} title={studio.reason('settings')} data-testid="studio-execution-source">
      <img className={styles.logo} src="/agent-icons/codex.svg" alt="" width={16} height={16} />
      <span className={styles.label}>{t('multiuser.executionSourcePersonalCodex')}</span>
    </span>
  );
}
