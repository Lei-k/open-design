import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@open-design/components';
import type {
  PersonalAgentAccount,
  PersonalAgentAccountsResponse,
  PersonalLoginAttempt,
  PersonalRateLimitWindow,
} from '@open-design/contracts';
import { useT } from '../i18n';
import type { Dict } from '../i18n/types';
import {
  cancelCodexLogin,
  fetchPersonalAgentAccounts,
  readCodexLogin,
  startCodexLogin,
  unlinkCodexAccount,
  verifyCodexAccount,
} from '../providers/agent-accounts';
import styles from './AgentAccountsSection.module.css';

export const AGENT_ACCOUNT_POLL_MS = 2_000;

const defaultApi = { fetchPersonalAgentAccounts, readCodexLogin, startCodexLogin, cancelCodexLogin, verifyCodexAccount, unlinkCodexAccount };
export type AgentAccountsApi = typeof defaultApi;

interface Props {
  /** Multi-user probe result; the section is never rendered without one. */
  initial: PersonalAgentAccountsResponse;
  api?: AgentAccountsApi;
  errorText?: (code: string | null) => string;
}

function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function outcomeKey(attempt: PersonalLoginAttempt): keyof Dict | null {
  if (attempt.status === 'denied') return 'agentAccounts.outcomeDenied';
  if (attempt.status === 'expired') return 'agentAccounts.outcomeExpired';
  if (attempt.status === 'canceled') return 'agentAccounts.outcomeCanceled';
  if (attempt.status !== 'failed') return null;
  if (attempt.failureCode === 'workspace_not_allowed') return 'agentAccounts.failureWorkspace';
  return 'agentAccounts.outcomeFailed';
}

/**
 * Settings → Agent accounts (multi-user mode only, #18). The user links THEIR
 * OWN Codex subscription through the provider's official device page; this
 * screen only shows the official URL and one-time code and never asks for a
 * password or token. Personal subscriptions are a separate execution source
 * from the company pool.
 */
export function AgentAccountsSection({ initial, api = defaultApi, errorText }: Props): JSX.Element {
  const t = useT();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [data, setData] = useState(initial);
  const [attempt, setAttempt] = useState<PersonalLoginAttempt | null>(initial.codex.pendingAttempt);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<'verify' | 'unlink' | null>(null);
  const [consent, setConsent] = useState(false);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const pending = attempt?.status === 'pending' ? attempt : null;
  const account = data.codex.account;

  const refresh = useCallback(async () => {
    const next = await api.fetchPersonalAgentAccounts();
    if (mounted.current && next) setData(next);
  }, [api]);
  const fail = (code: string | null) => setError(errorText ? errorText(code) : t('agentAccounts.actionFailed', { code: code ?? 'network' }));

  // A pending attempt from the summary carries no code; the owner's read does.
  const pendingId = pending?.id ?? null;
  const pendingHasCode = Boolean(pending?.userCode);
  useEffect(() => {
    if (!pendingId) return undefined;
    let active = true;
    const settle = (next: PersonalLoginAttempt) => {
      if (!active) return;
      if (next.status === 'pending') {
        if (next.userCode) setAttempt(next);
        return;
      }
      setAttempt(null);
      const key = outcomeKey(next);
      setNotice(key ? t(key) : null);
      void refresh();
    };
    if (!pendingHasCode) void api.readCodexLogin(pendingId).then((r) => { if (r.ok) settle(r.value); });
    const poll = setInterval(() => {
      void api.readCodexLogin(pendingId).then((r) => { if (r.ok) settle(r.value); });
    }, AGENT_ACCOUNT_POLL_MS);
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    return () => { active = false; clearInterval(poll); clearInterval(tick); };
  }, [api, pendingId, pendingHasCode, refresh, t]);

  async function link(): Promise<void> {
    setBusy(true); setError(null); setNotice(null); setConfirm(null);
    const result = await api.startCodexLogin();
    if (!mounted.current) return;
    setBusy(false);
    if (result.ok) { setNow(Date.now()); setAttempt(result.value); } else fail(result.code);
  }

  async function cancel(): Promise<void> {
    if (!pending) return;
    setBusy(true);
    const result = await api.cancelCodexLogin(pending.id);
    if (!mounted.current) return;
    setBusy(false);
    if (!result.ok) return fail(result.code);
    setAttempt(null);
    setNotice(t('agentAccounts.outcomeCanceled'));
    await refresh();
  }

  async function verify(target: PersonalAgentAccount): Promise<void> {
    setBusy(true); setError(null); setNotice(null);
    const result = await api.verifyCodexAccount(target.id);
    if (!mounted.current) return;
    setBusy(false); setConfirm(null); setConsent(false);
    if (result.ok) setNotice(t('agentAccounts.verifySucceeded')); else fail(result.code);
    await refresh();
  }

  async function unlink(target: PersonalAgentAccount): Promise<void> {
    setBusy(true); setError(null); setNotice(null);
    const result = await api.unlinkCodexAccount(target.id);
    if (!mounted.current) return;
    setBusy(false); setConfirm(null);
    if (!result.ok) fail(result.code);
    await refresh();
  }

  async function copyCode(code: string): Promise<void> {
    try { await navigator.clipboard?.writeText(code); setCopied(true); } catch { setCopied(false); }
  }

  const statusLabel = pending ? t('agentAccounts.statusPending')
    : !account ? t('agentAccounts.statusNotLinked')
    : account.status === 'connected' ? t('agentAccounts.statusConnected')
    : account.status === 'requires_reauth' ? t('agentAccounts.statusRequiresReauth')
    : t('agentAccounts.statusDisabled');

  const windowText = (w: PersonalRateLimitWindow | null) => (w ? t('agentAccounts.rateLimitUsed', { percent: Math.round(w.usedPercent) }) : null);
  const limits = account?.rateLimits
    ? [windowText(account.rateLimits.primary), windowText(account.rateLimits.secondary)].filter(Boolean).join(' · ')
    : '';

  return (
    <section className="settings-section" aria-labelledby="agent-accounts-title">
      <p className={styles.intro} id="agent-accounts-title">{t('agentAccounts.intro')}</p>
      {!data.personalSubscriptionsEnabled ? (
        <p className={styles.banner} role="note">{t('agentAccounts.featureDisabled')}</p>
      ) : null}
      {notice ? <p className={styles.notice} role="status">{notice}</p> : null}
      {error ? <p className={styles.error} role="alert">{error}</p> : null}

      <article className={styles.card} aria-label={t('agentAccounts.codexTitle')}>
        <header className={styles.cardHead}>
          <h4 className={styles.cardTitle}>{t('agentAccounts.codexTitle')}</h4>
          <span className={styles.badge}>{t('agentAccounts.personalBadge')}</span>
          <span className={styles.status} data-status={pending ? 'pending' : account?.status ?? 'not_linked'}>{statusLabel}</span>
        </header>

        {pending ? (
          <div className={styles.pending}>
            <p className={styles.hint}>{t('agentAccounts.pendingInstructions')}</p>
            {pending.expiresAt > now && pending.verificationUrl ? (
              <a className={styles.link} href={pending.verificationUrl} target="_blank" rel="noopener noreferrer">
                {t('agentAccounts.openVerification')}
              </a>
            ) : null}
            {pending.expiresAt > now && pending.userCode ? (
              <div className={styles.codeRow}>
                <span className={styles.label}>{t('agentAccounts.userCodeLabel')}</span>
                <code className={styles.code} aria-label={t('agentAccounts.userCodeLabel')}>{pending.userCode}</code>
                <Button size="sm" variant="secondary" onClick={() => void copyCode(pending.userCode!)}>
                  {copied ? t('agentAccounts.copied') : t('agentAccounts.copyCode')}
                </Button>
              </div>
            ) : null}
            <p className={styles.hint}>{t('agentAccounts.expiresIn', { time: formatCountdown(pending.expiresAt - now) })}</p>
            <p className={styles.waiting} role="status" aria-live="polite">{t('agentAccounts.waiting')}</p>
            <div className={styles.actions}>
              <Button variant="ghost" disabled={busy} onClick={() => void cancel()}>{t('agentAccounts.cancel')}</Button>
            </div>
          </div>
        ) : account ? (
          <>
            <dl className={styles.facts}>
              <div><dt>{t('agentAccounts.accountLabel')}</dt><dd>{account.maskedIdentity}</dd></div>
              <div><dt>{t('agentAccounts.planLabel')}</dt><dd>{account.planType ?? t('agentAccounts.rateLimitsUnknown')}</dd></div>
              <div><dt>{t('agentAccounts.linkedAtLabel')}</dt><dd>{new Date(account.linkedAt).toLocaleString()}</dd></div>
              <div><dt>{t('agentAccounts.verifiedAtLabel')}</dt>
                <dd>{account.verifiedAt ? new Date(account.verifiedAt).toLocaleString() : t('agentAccounts.notVerified')}</dd></div>
              <div><dt>{t('agentAccounts.rateLimitsLabel')}</dt><dd>{limits || t('agentAccounts.rateLimitsUnknown')}</dd></div>
            </dl>
            {account.status === 'requires_reauth' ? <p className={styles.warning} role="note">{t('agentAccounts.reauthHint')}</p> : null}
            {account.status === 'disabled' ? <p className={styles.warning} role="note">{t('agentAccounts.disabledHint')}</p> : null}
            {account.status === 'connected' && account.lastProblem === 'usage_limit_reached'
              ? <p className={styles.warning} role="note">{t('agentAccounts.usageLimitHint')}</p> : null}

            {confirm === 'verify' ? (
              <div className={styles.confirm} role="group" aria-label={t('agentAccounts.verify')}>
                <label className={styles.consent}>
                  <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
                  <span>{t('agentAccounts.verifyConsent')}</span>
                </label>
                <div className={styles.actions}>
                  <Button variant="primary" disabled={!consent || busy} onClick={() => void verify(account)}>{t('agentAccounts.verifyConfirm')}</Button>
                  <Button variant="ghost" onClick={() => { setConfirm(null); setConsent(false); }}>{t('agentAccounts.cancel')}</Button>
                </div>
              </div>
            ) : confirm === 'unlink' ? (
              <div className={styles.confirm} role="group" aria-label={t('agentAccounts.unlink')}>
                <p className={styles.hint}>{t('agentAccounts.unlinkConfirm')}</p>
                <p className={styles.hint}>{t('agentAccounts.unlinkRevokeHint')}</p>
                <div className={styles.actions}>
                  <Button variant="primary" disabled={busy} onClick={() => void unlink(account)}>{t('agentAccounts.unlinkConfirmAction')}</Button>
                  <Button variant="ghost" onClick={() => setConfirm(null)}>{t('agentAccounts.keep')}</Button>
                </div>
              </div>
            ) : (
              <div className={styles.actions}>
                {account.status === 'connected' ? (
                  <Button variant="secondary" disabled={busy || !data.personalSubscriptionsEnabled} onClick={() => setConfirm('verify')}>
                    {t('agentAccounts.verify')}
                  </Button>
                ) : null}
                <Button variant="secondary" disabled={busy || !data.personalSubscriptionsEnabled} onClick={() => void link()}>
                  {t('agentAccounts.reauthorize')}
                </Button>
                <Button variant="ghost" disabled={busy} onClick={() => setConfirm('unlink')}>{t('agentAccounts.unlink')}</Button>
              </div>
            )}
          </>
        ) : (
          <div className={styles.actions}>
            <Button variant="primary" disabled={busy || !data.personalSubscriptionsEnabled} onClick={() => void link()}>
              {t('agentAccounts.link')}
            </Button>
          </div>
        )}
      </article>

      <article className={styles.card} aria-label={t('agentAccounts.claudeTitle')} aria-disabled="true">
        <header className={styles.cardHead}>
          <h4 className={styles.cardTitle}>{t('agentAccounts.claudeTitle')}</h4>
          <span className={styles.status} data-status="coming_later">{t('agentAccounts.comingLater')}</span>
        </header>
        <p className={styles.hint}>{t('agentAccounts.claudeComingLaterHint')}</p>
      </article>
    </section>
  );
}
