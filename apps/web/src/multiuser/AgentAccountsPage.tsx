import { useMemo } from 'react';
import type { PersonalAgentAccountsResponse, PersonalLoginAttempt, PersonalAgentAccount } from '@open-design/contracts';
import { Button } from '@open-design/components';
import { AgentAccountsSection, type AgentAccountsApi } from '../components/AgentAccountsSection';
import type { AgentAccountResult } from '../providers/agent-accounts';
import { useT } from '../i18n';
import { RequestFailure } from './session';
import { useOwnedRequest, useOwnedResource, type OwnedSession } from './owned';
import { runErrorKey } from './run-errors';
import styles from './MultiUserApp.module.css';
import runStyles from './Runs.module.css';

export function AgentAccountsPage(props: OwnedSession) {
  const t = useT();
  const request = useOwnedRequest(props);
  const { data, error } = useOwnedResource<PersonalAgentAccountsResponse>(request, '/api/agent-accounts');
  const api = useMemo<AgentAccountsApi>(() => {
    async function call<T>(url: string, method: string, pick: (body: Record<string, unknown>) => T, body?: unknown): Promise<AgentAccountResult<T>> {
      try { return { ok: true, value: pick(await request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })) }; }
      catch (e) { return { ok: false, status: e instanceof RequestFailure ? e.status : 0, code: e instanceof RequestFailure ? e.code : null }; }
    }
    const login = '/api/agent-accounts/codex/logins';
    const account = (id: string) => `/api/agent-accounts/codex/accounts/${encodeURIComponent(id)}`;
    return {
      fetchPersonalAgentAccounts: () => request<PersonalAgentAccountsResponse>('/api/agent-accounts').catch(() => null),
      startCodexLogin: () => call(login, 'POST', (body) => body.attempt as PersonalLoginAttempt, {}),
      readCodexLogin: (id) => call(`${login}/${encodeURIComponent(id)}`, 'GET', (body) => body.attempt as PersonalLoginAttempt),
      cancelCodexLogin: (id) => call(`${login}/${encodeURIComponent(id)}/cancel`, 'POST', (body) => body.attempt as PersonalLoginAttempt, {}),
      verifyCodexAccount: (id) => call(`${account(id)}/verify`, 'POST', (body) => body.account as PersonalAgentAccount, { consentToUsePlan: true }),
      unlinkCodexAccount: (id) => call(account(id), 'DELETE', () => true as const),
    };
  }, [request]);
  return <><h1>{t('agentAccounts.navTitle')}</h1>
    {error ? <><p role="alert" className={styles.error}>{t(runErrorKey(error))}</p><Button onClick={() => window.location.reload()}>{t('multiuser.retry')}</Button></>
      : !data ? <p role="status">{t('multiuser.loading')}</p> : <div className={runStyles.accounts}><AgentAccountsSection initial={data} api={api} errorText={(code) => t(runErrorKey(code))} /></div>}
  </>;
}
