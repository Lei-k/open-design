import { useState, type FormEvent } from 'react';
import { Button } from '@open-design/components';
import { Lock } from 'lucide-react';
import type { PersonalAgentAccountsResponse, RunExecutionSource } from '@open-design/contracts';
import { useT } from '../i18n';
import { isAbort, runErrorKey } from './run-errors';
import styles from './Runs.module.css';

export function validRunMessage(message: string): boolean {
  return message.trim().length > 0 && message.length <= 64_000
    && new TextEncoder().encode(JSON.stringify({ message })).byteLength <= 64 * 1024;
}

/**
 * A pinned conversation shows its source as locked, not as unavailable choices.
 * A stale personal pin (its account was unlinked or replaced) is refused by the
 * server, so the composer warns and offers no send instead of a doomed one.
 */
export function RunComposer({ accounts, pinnedSource, pinStale = false, send }: {
  accounts: PersonalAgentAccountsResponse | null;
  pinnedSource: RunExecutionSource | null;
  pinStale?: boolean;
  send: (message: string, source: RunExecutionSource) => Promise<void>;
}) {
  const t = useT();
  const [choice, setChoice] = useState<RunExecutionSource | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const source = pinnedSource ?? choice;
  const personalEnabled = accounts?.personalSubscriptionsEnabled === true && accounts.codex.account?.status === 'connected';
  // Older daemons omit the field; only an explicit false withdraws the company pool.
  const companyEnabled = accounts?.companyPoolAvailable !== false;
  const unavailableKey = !accounts ? 'multiuser.loading'
    : !accounts.personalSubscriptionsEnabled ? 'multiuserRuns.personalDisabled'
    : accounts.codex.account?.status === 'requires_reauth' ? 'multiuserRuns.personalReauth'
    : accounts.codex.account?.status === 'disabled' ? 'multiuserRuns.personalWorkspace'
    : 'multiuserRuns.personalUnavailable';
  const sourceLabel = (value: RunExecutionSource) => t(value === 'company_pool' ? 'multiuserRuns.company' : 'multiuserRuns.personal');
  const allowed = source !== null && !pinStale && (source === 'company_pool' ? companyEnabled : personalEnabled);
  const personalReason = !personalEnabled && !pinStale && pinnedSource !== 'company_pool';
  const companyReason = !companyEnabled && !pinStale && pinnedSource !== 'personal_subscription';
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!allowed || !source || !validRunMessage(message) || busy) return;
    setBusy(true); setError(null);
    try { await send(message, source); setMessage(''); }
    catch (e) { if (!isAbort(e)) setError(e); }
    finally { setBusy(false); }
  }
  return <form className={styles.composer} onSubmit={submit}>
    <fieldset className={styles.sources} aria-describedby={pinnedSource ? 'source-pinned' : undefined}><legend>{t('multiuserRuns.source')}</legend>
      {pinnedSource ? <p className={styles.locked}><Lock size={16} aria-hidden="true" />{t('multiuserRuns.lockedTo', { source: sourceLabel(pinnedSource) })}</p>
        : (['company_pool', 'personal_subscription'] as const).map((value) => <label key={value}>
          <input type="radio" name="execution-source" value={value} checked={source === value}
            disabled={busy || (value === 'personal_subscription' ? !personalEnabled : !companyEnabled)}
            aria-describedby={value === 'personal_subscription' ? (!personalEnabled ? 'personal-unavailable' : undefined)
              : (!companyEnabled ? 'company-unavailable' : undefined)}
            onChange={() => setChoice(value)} />
          <span>{sourceLabel(value)}</span>
        </label>)}
    </fieldset>
    {pinnedSource && <p id="source-pinned" className={styles.hint}>{t('multiuserRuns.pinned')}</p>}
    {pinStale && <p className={styles.warning} role="note">{t('multiuserRuns.pinStale')}</p>}
    {companyReason && <p id="company-unavailable" className={styles.hint}>{t('multiuserRuns.companyUnavailable')}</p>}
    {personalReason && <p id="personal-unavailable" className={styles.hint}>{t(unavailableKey)} <a href="/account/agents">{t('agentAccounts.navTitle')}</a></p>}
    <label className={styles.message}>{t('multiuserRuns.message')}<textarea value={message} rows={4} maxLength={64_000} aria-describedby="message-limit" onChange={(event) => setMessage(event.target.value)} /></label>
    <p id="message-limit" className={styles.hint}>{t('multiuserRuns.messageLimit')}</p>
    {Boolean(error) && <p role="alert" className={styles.error}>{t(runErrorKey(error))}</p>}
    <Button variant="primary" type="submit" disabled={busy || !allowed || !validRunMessage(message)}>{t(busy ? 'multiuser.saving' : 'multiuserRuns.send')}</Button>
  </form>;
}
