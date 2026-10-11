import { useState, type FormEvent } from 'react';
import { Button } from '@open-design/components';
import type { AdminPoolResponse, AdminPersonalAccountsResponse, AuthAccount } from '@open-design/contracts';
import type { CookieSession } from '../multiuser/session';
import { RequestFailure } from '../multiuser/session';
import { CompanyOpenAISection } from '../multiuser/CompanyOpenAISection';
import { AdminBoundary, useOwnedLoad } from './StudioAdminPages';
import { useT } from '../i18n';
import styles from '../multiuser/MultiUserApp.module.css';

type Props = { session: CookieSession; account: AuthAccount; generation: number };
export function StudioAdminOperations(props: Props & { personal?: boolean }) {
  return <AdminBoundary {...props}><OperationsContent {...props} /></AdminBoundary>;
}
function OperationsContent(props: Props & { personal?: boolean }) {
  const t = useT();
  const [revision, setRevision] = useState(0);
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const url = props.personal ? '/api/admin/agent-accounts' : '/api/admin/pool';
  const { data, error } = useOwnedLoad<AdminPoolResponse | AdminPersonalAccountsResponse>(props, url, revision);
  const [pending, setPending] = useState<{ url: string; body: object; field: 'capacity' | 'budgetMinutes'; value: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<'saved' | 'error' | 'conflict' | null>(null);
  const propose = (event: FormEvent<HTMLFormElement>, path: string, field: 'capacity' | 'budgetMinutes') => {
    event.preventDefault(); setStatus(null);
    const value = Number(new FormData(event.currentTarget).get(field));
    setPending({ url: path, body: { [field]: value }, field, value });
  };
  async function apply() {
    if (!pending || busy) return;
    setBusy(true); setStatus(null);
    try {
      await props.session.request(pending.url, { method: 'PUT', body: JSON.stringify(pending.body) }, props.generation);
      setPending(null); setRevision((r) => r + 1); setStatus('saved');
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) setStatus(error instanceof RequestFailure && error.status === 409 ? 'conflict' : 'error');
    } finally { setBusy(false); }
  }
  const users = data ? Object.entries(data.users).filter(([id, user]) => [id, user.username].some((value) => value.toLowerCase().includes(search.toLowerCase()))) : [];
  const pageIds = new Set(users.slice(offset, offset + 20).map(([id]) => id));
  const slotForm = (path: string, capacity: number) => <form className={styles.inlineForm} onSubmit={(event) => propose(event, path, 'capacity')}>
    <label>{t('multiuser.companyCapacity')}<input name="capacity" type="number" min={0} max={16} required defaultValue={capacity} /></label>
    <Button type="submit" disabled={busy}>{t('common.save')}</Button>
  </form>;
  return <section aria-label={t(props.personal ? 'studio.admin.personal' : 'multiuser.companyOpenAI')}>
    <p>{t('studio.admin.operationsHelp')}</p>
    {!props.personal && <CompanyOpenAISection session={props.session} generation={props.generation} />}
    <Button onClick={() => { setPending(null); setRevision((r) => r + 1); }}>{t('studio.settingsReload')}</Button>
    {pending && <section className={styles.confirm} aria-label={t('multiuser.confirmAction')} onKeyDown={(event) => { if (event.key === 'Escape') setPending(null); }}>
      <h3>{t('multiuser.confirmAction')}</h3><p>{t('studio.admin.capacityWarning')}</p><p>{t(pending.field === 'capacity' ? 'multiuser.companyCapacity' : 'studio.admin.budget')} · {pending.value}</p>
      <Button autoFocus disabled={busy} onClick={() => void apply()}>{t('multiuser.confirm')}</Button>
      <Button disabled={busy} onClick={() => setPending(null)}>{t('multiuser.cancel')}</Button>
    </section>}
    {status && <p role={status === 'saved' ? 'status' : 'alert'}>{t(status === 'saved' ? 'multiuser.saved' : status === 'conflict' ? 'multiuser.conflict' : 'multiuser.requestError')}</p>}
    <label>{t('common.search')}<input value={search} onChange={(event) => { setSearch(event.target.value); setOffset(0); setPending(null); }} maxLength={128} /></label>
    {error ? <p role="alert">{t('multiuser.requestError')}</p> : !data ? <p role="status">{t('multiuser.loading')}</p> : 'providers' in data ? <>
      <ul className={styles.list}>{Object.entries(data.providers).map(([id, provider]) => <li key={id}><div>
        <h3>{id}</h3><dl>
          <dt>{t('multiuser.companyCapacity')}</dt><dd>{provider.capacity}</dd>
          <dt>{t('multiuserRuns.running')}</dt><dd>{provider.active}</dd>
          <dt>{t('multiuserRuns.queued')}</dt><dd>{provider.queued}</dd>
        </dl>
        {id === 'test-mock' && slotForm(`/api/admin/pool/providers/${id}`, provider.capacity)}
      </div></li>)}</ul>
      <ul className={styles.list}>{Object.entries(data.users).filter(([id]) => pageIds.has(id)).map(([id, usage]) => <li key={id}><div>
        <h3>{usage.username}</h3><dl><dt>{t('studio.admin.used')}</dt><dd>{usage.usedMs}</dd><dt>{t('studio.admin.remaining')}</dt><dd>{usage.remainingMs}</dd></dl>
        <form className={styles.inlineForm} onSubmit={(event) => propose(event, `/api/admin/pool/users/${encodeURIComponent(id)}/quota`, 'budgetMinutes')}>
          <label>{t('studio.admin.budget')}<input type="number" name="budgetMinutes" min={0} max={10080} required defaultValue={Math.floor(usage.budgetMs / 60000)} /></label>
          <Button type="submit" disabled={busy}>{t('common.save')}</Button>
        </form>
      </div></li>)}</ul>
    </> : <>
      {slotForm('/api/admin/agent-accounts/personal-capacity', data.personalWorkerCapacity)}
      <dl><dt>{t('multiuserRuns.running')}</dt><dd>{data.activePersonalRuns}</dd><dt>{t('multiuserRuns.queued')}</dt><dd>{data.queuedPersonalRuns}</dd></dl>
      <ul className={styles.list}>{Object.entries(data.users).filter(([id]) => pageIds.has(id)).map(([id, user]) => <li key={id}><div><h3>{user.username}</h3>
        <p>{t(!user.codex.linked ? 'agentAccounts.statusNotLinked' : user.codex.status === 'requires_reauth' ? 'agentAccounts.statusRequiresReauth' : user.codex.status === 'disabled' ? 'agentAccounts.statusDisabled' : 'agentAccounts.statusConnected')}</p>
        <dl><dt>{t('studio.admin.used')}</dt><dd>{user.personalWorkerMs}</dd></dl>
      </div></li>)}</ul>
    </>}
    {data && <div className={styles.actions}><Button disabled={offset === 0} onClick={() => { setOffset(Math.max(0, offset - 20)); setPending(null); }}>{t('multiuser.previous')}</Button><span>{t('multiuser.total', { count: users.length })}</span><Button disabled={offset + 20 >= users.length} onClick={() => { setOffset(offset + 20); setPending(null); }}>{t('multiuser.next')}</Button></div>}
  </section>;
}
