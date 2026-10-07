import { useT } from '../i18n';
import { useStudioCapabilities } from './studio-capabilities';
import styles from './StudioExecutionSource.module.css';

/** Sources are server-advertised; the daemon pins each conversation at admission. */
export function StudioExecutionSource({ agentId, onChange }: { agentId?: string | null; onChange?: (id: string) => void } = {}) {
  const studio = useStudioCapabilities();
  const t = useT();
  const choices = studio.capabilities?.executionSources ?? (studio.executionAgentId === 'codex'
    ? [{ source: 'personal_subscription' as const, agentId: 'codex' as const }] : []);
  if (!choices.length) return null;
  const selected = agentId ?? studio.executionAgentId;
  const label = (id: string) => t(id === 'openai' ? 'multiuser.executionSourceCompanyOpenAI' : 'multiuser.executionSourcePersonalCodex');
  return <span className={styles.source} data-testid="studio-execution-source">
    {onChange && choices.length > 1 ? <select className={styles.label} aria-label={t('multiuserRuns.source')}
      value={selected ?? ''} onChange={(event) => onChange(event.target.value)}>
      {!choices.some((choice) => choice.agentId === selected) && <option value={selected ?? ''} disabled>{t('multiuser.companySourceUnavailable')}</option>}
      {choices.map((choice) => <option key={choice.source} value={choice.agentId}>{label(choice.agentId)}</option>)}
    </select> : <span className={styles.label}>{label(selected ?? choices[0]!.agentId)}</span>}
  </span>;
}
