import { STUDIO_CODEX_MODELS, STUDIO_CODEX_REASONING } from '@open-design/contracts';
import { useT } from '../i18n';
import type { AgentModelChoice } from '../types';
import { useStudioCapabilities } from './studio-capabilities';
import { studioCodexModelChoice } from './studio-account-preferences';
import styles from './StudioExecutionSource.module.css';

/** Sources are server-advertised; the daemon pins each conversation at admission.
 * The personal Codex model/effort applies per turn and is an account preference. */
export function StudioExecutionSource({ agentId, onChange, modelChoice, onModelChange }: {
  agentId?: string | null; onChange?: (id: string) => void;
  modelChoice?: AgentModelChoice; onModelChange?: (choice: AgentModelChoice) => void;
} = {}) {
  const studio = useStudioCapabilities();
  const t = useT();
  const choices = studio.capabilities?.executionSources ?? (studio.executionAgentId === 'codex'
    ? [{ source: 'personal_subscription' as const, agentId: 'codex' as const }] : []);
  if (!choices.length) return null;
  const selected = agentId ?? studio.executionAgentId;
  const label = (id: string) => t(id === 'openai' ? 'multiuser.executionSourceCompanyOpenAI'
    : id === 'openai-byok' ? 'multiuser.executionSourcePersonalKey' : 'multiuser.executionSourcePersonalCodex');
  const codex = studioCodexModelChoice(modelChoice);
  const option = (value: string) => value === 'default' ? t('common.default') : value;
  return <span className={styles.source} data-testid="studio-execution-source">
    {onChange && choices.length > 1 ? <select className={styles.label} aria-label={t('multiuserRuns.source')}
      value={selected ?? ''} onChange={(event) => onChange(event.target.value)}>
      {!choices.some((choice) => choice.agentId === selected) && <option value={selected ?? ''} disabled>{t('multiuser.companySourceUnavailable')}</option>}
      {choices.map((choice) => <option key={choice.source} value={choice.agentId}>{label(choice.agentId)}</option>)}
    </select> : <span className={styles.label}>{label(selected ?? choices[0]!.agentId)}</span>}
    {selected === 'codex' && onModelChange ? <>
      <select className={styles.picker} aria-label={t('settings.model')} data-testid="studio-codex-model"
        value={codex.model} onChange={(event) => onModelChange({ ...modelChoice, model: event.target.value })}>
        {STUDIO_CODEX_MODELS.map((model) => <option key={model} value={model}>{option(model)}</option>)}
      </select>
      <select className={styles.picker} aria-label={t('settings.reasoningPicker')} data-testid="studio-codex-reasoning"
        value={codex.reasoning} onChange={(event) => onModelChange({ ...modelChoice, reasoning: event.target.value })}>
        {STUDIO_CODEX_REASONING.map((effort) => <option key={effort} value={effort}>{option(effort)}</option>)}
      </select>
    </> : null}
  </span>;
}
