import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '@open-design/components';
import type { StudioPilotState, AuthAccount, AuthAccountListResponse, AuthAuditListResponse, AuthCreateAccountResponse, AuthIssueSetupCredentialResponse, AuthSetupCredential } from '@open-design/contracts';
import { useI18n, useT } from '../i18n';
import { CookieSession, RequestFailure } from '../multiuser/session';
import styles from '../multiuser/MultiUserApp.module.css';
function failureKey(error: unknown) {
  if (error instanceof RequestFailure) {
    if (error.status === 409) return 'multiuser.conflict' as const;
    if (error.status === 403) return 'multiuser.denied' as const;
    if (error.status === 400) return 'multiuser.invalid' as const;
  }
  return 'multiuser.requestError' as const;
}
function isAborted(error: unknown) { return error instanceof DOMException && error.name === 'AbortError'; }
function Alert({ children }: { children: React.ReactNode }) { return <p className={styles.error} role="alert">{children}</p>; }
type OwnedProps = { session: CookieSession; account: AuthAccount; generation: number };
/** Component requests are tied to both the live session generation and mount. */
export function useOwnedLoad<T>(props: OwnedProps, url: string, revision = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true; setData(null); setError(false);
    const release = props.session.bindResource(() => { active = false; setData(null); setError(false); }, props.generation);
    void props.session.request<T>(url, undefined, props.generation).then((value) => { if (active) setData(value); }).catch((e) => { if (active && !isAborted(e)) setError(true); });
    return () => { active = false; release(); };
  }, [props.session, props.generation, url, revision]);
  return { data, error };
}
function SetupLink({ setup, dismiss }: { setup: AuthSetupCredential; dismiss: () => void }) {
  const { t, locale } = useI18n();
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const link = `${window.location.origin}/setup#${setup.token}`;
  return <section className={styles.linkPanel} aria-label={t('multiuser.setupLink')}><h2>{t('multiuser.setupLink')}</h2><p>{t('multiuser.linkHelp')}</p>
    <label>{t('multiuser.setupLink')}<input value={link} readOnly onFocus={(event) => event.currentTarget.select()} /></label>
    <p>{t('multiuser.expires', { time: new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(setup.expiresAt) })}</p>
    <div className={styles.actions}><Button onClick={() => { void navigator.clipboard.writeText(link).then(() => setCopied(true)).catch(() => setFailed(true)); }}>{t('multiuser.copy')}</Button><Button onClick={dismiss}>{t('multiuser.dismiss')}</Button></div>
    <p role="status">{copied ? t('multiuser.copied') : failed ? t('multiuser.copyFailed') : ''}</p></section>;
}

function AdminUsersContent(props: OwnedProps) {
  const t = useT();
  const [query, setQuery] = useState(''); const [offset, setOffset] = useState(0); const [revision, setRevision] = useState(0);
  const { data, error } = useOwnedLoad<AuthAccountListResponse>(props, `/api/auth/users?limit=20&offset=${offset}${query ? `&q=${encodeURIComponent(query)}` : ''}`, revision);
  const [setup, setSetup] = useState<AuthSetupCredential | null>(null);
  const [busy, setBusy] = useState(false); const [notice, setNotice] = useState<string | null>(null); const [actionError, setActionError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ account: AuthAccount; action: 'reset' | 'revoke' | 'active' | 'role' } | null>(null);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const fields = new FormData(form);
    setBusy(true); setActionError(null); setSetup(null); setNotice(null);
    try {
      const result = await props.session.request<AuthCreateAccountResponse>('/api/auth/users', { method: 'POST', body: JSON.stringify({ username: fields.get('username'), role: fields.get('role') }) }, props.generation);
      form.reset(); setSetup(result.setup); setRevision((r) => r + 1);
    } catch (e) { if (!isAborted(e)) setActionError(t(failureKey(e))); } finally { setBusy(false); }
  }
  async function apply() {
    if (!confirm) return; const { account, action } = confirm;
    if (account.id === props.account.id && action !== 'revoke') return;
    setBusy(true); setActionError(null); setSetup(null); setNotice(null);
    const suffix = action === 'reset' ? '/password' : action === 'revoke' ? '/sessions/revoke' : '';
    const body = action === 'active' ? { active: !account.active, revision: account.updatedAt } : action === 'role' ? { role: account.role === 'admin' ? 'user' : 'admin', revision: account.updatedAt } : {};
    try {
      const result = await props.session.request<AuthIssueSetupCredentialResponse>(`/api/auth/users/${encodeURIComponent(account.id)}${suffix}`, { method: suffix ? 'POST' : 'PATCH', body: JSON.stringify(body) }, props.generation);
      setConfirm(null);
      if (account.id === props.account.id) { props.session.withdraw(); await props.session.verify(); return; }
      if (action === 'reset') setSetup(result.setup);
      setNotice(t('multiuser.saved')); setRevision((r) => r + 1);
    } catch (e) { if (!isAborted(e)) setActionError(t(failureKey(e))); } finally { setBusy(false); }
  }
  return <><h1>{t('multiuser.users')}</h1><p>{t('multiuser.usersHelp')}</p>
    <form className={styles.inlineForm} onSubmit={create}><label>{t('multiuser.username')}<input name="username" required pattern="[A-Za-z0-9_.-]{3,32}" maxLength={32} autoComplete="off" /></label><label>{t('multiuser.role')}<select name="role"><option value="user">{t('multiuser.user')}</option><option value="admin">{t('multiuser.admin')}</option></select></label><Button variant="primary" type="submit" disabled={busy}>{t('multiuser.createUser')}</Button></form>
    {setup && <SetupLink setup={setup} dismiss={() => setSetup(null)} />}
    {confirm && <section className={styles.confirm} aria-label={t('multiuser.confirmAction')} onKeyDown={(event) => { if (event.key === 'Escape') setConfirm(null); }}><h2>{t('multiuser.confirmAction')} · {confirm.account.username}</h2><p>{t(confirm.action === 'reset' ? 'multiuser.resetWarning' : confirm.action === 'role' ? 'studio.admin.roleWarning' : confirm.action === 'active' ? 'studio.admin.activeWarning' : 'multiuser.revokeWarning')}</p><div className={styles.actions}><Button autoFocus disabled={busy} onClick={() => void apply()}>{t('multiuser.confirm')}</Button><Button disabled={busy} onClick={() => setConfirm(null)}>{t('multiuser.cancel')}</Button></div></section>}
    {actionError && <Alert>{actionError}</Alert>}{notice && <p role="status">{notice}</p>}
    <Button onClick={() => { setConfirm(null); setSetup(null); setRevision((r) => r + 1); }}>{t('studio.settingsReload')}</Button>
    <form className={styles.inlineForm} onSubmit={(event) => { event.preventDefault(); setQuery(String(new FormData(event.currentTarget).get('q')).trim()); setOffset(0); setSetup(null); }}><label>{t('multiuser.searchUsers')}<input name="q" maxLength={32} pattern="[A-Za-z0-9_.-]*" /></label><Button type="submit">{t('multiuser.search')}</Button></form>
    {error ? <><Alert>{t('multiuser.requestError')}</Alert><Button onClick={() => setRevision((r) => r + 1)}>{t('multiuser.retry')}</Button></> : !data ? <p role="status">{t('multiuser.loading')}</p> : <>
      {data.accounts.length === 0 && <p>{t('multiuser.noUsers')}</p>}
      <ul className={styles.list}>{data.accounts.map((account) => <li key={account.id} className={styles.account}><div><strong>{account.username}</strong><p>{t(account.role === 'admin' ? 'multiuser.admin' : 'multiuser.user')} · {t(account.active ? 'multiuser.active' : 'multiuser.inactive')} · {t(account.passwordState === 'set' ? 'multiuser.passwordSet' : 'multiuser.passwordPending')}</p>{account.id === props.account.id && <p>{t('multiuser.selfAccess')}</p>}</div><div className={styles.actions}>
        <Button disabled={busy || !account.active || account.id === props.account.id} onClick={() => setConfirm({ account, action: 'reset' })}>{t('multiuser.resetLink')}</Button>
        <Button disabled={busy || account.id === props.account.id} onClick={() => setConfirm({ account, action: 'active' })}>{t(account.active ? 'multiuser.disable' : 'multiuser.enable')}</Button>
        <Button disabled={busy || account.id === props.account.id} onClick={() => setConfirm({ account, action: 'role' })}>{t(account.role === 'admin' ? 'multiuser.makeUser' : 'multiuser.makeAdmin')}</Button>
        <StudioPilotControl {...props} targetId={account.id} />
        <Button disabled={busy} onClick={() => setConfirm({ account, action: 'revoke' })}>{t('multiuser.revoke')}</Button>
      </div></li>)}</ul>
      <div className={styles.actions}><Button disabled={offset === 0} onClick={() => { setOffset(Math.max(0, offset - 20)); setSetup(null); }}>{t('multiuser.previous')}</Button><span>{t('multiuser.total', { count: data.page.total })}</span><Button disabled={offset + 20 >= data.page.total || offset >= 10000} onClick={() => { setOffset(offset + 20); setSetup(null); }}>{t('multiuser.next')}</Button></div>
    </>}
  </>;
}
function StudioPilotControl(props: OwnedProps & { targetId: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<StudioPilotState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const path = `/api/admin/users/${encodeURIComponent(props.targetId)}/studio-pilot`;
  async function read() {
    setOpen(true); setBusy(true); setError(null); setState(null);
    try {
      const result = await props.session.request<StudioPilotState>(path, undefined, props.generation);
      if (mounted.current) setState(result);
    } catch (e) { if (mounted.current && !isAborted(e)) setError(t(failureKey(e))); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function toggle() {
    if (!state || busy) return;
    setBusy(true); setError(null);
    try {
      const result = await props.session.request<StudioPilotState>(path, { method: 'PUT',
        body: JSON.stringify({ studioPilot: !state.studioPilot, revision: state.revision }) }, props.generation);
      if (mounted.current) setState(result);
      if (props.targetId === props.account.id) await props.session.verify();
    } catch (e) {
      if (mounted.current && !isAborted(e)) { setState(null); setError(t(failureKey(e))); }
    } finally { if (mounted.current) setBusy(false); }
  }
  return <div>
    {!open ? <Button onClick={() => void read()}>{t('multiuser.studioPilot')}</Button> : <>
      {state && <Button disabled={busy} onClick={() => void toggle()}>{t(state.studioPilot ? 'multiuser.disableStudioPilot' : 'multiuser.enableStudioPilot')}</Button>}
      {busy && <span role="status">{t('multiuser.loading')}</span>}
      {error && <><Alert>{error}</Alert><Button onClick={() => void read()}>{t('multiuser.retry')}</Button></>}
    </>}
  </div>;
}

function AuditContent(props: OwnedProps) {
  const [filter, setFilter] = useState('');
  const { t, locale } = useI18n(); const [before, setBefore] = useState<number | null>(null); const [revision, setRevision] = useState(0);
  const { data, error } = useOwnedLoad<AuthAuditListResponse>(props, `/api/auth/audit?limit=20${before === null ? '' : `&before=${before}`}`, revision);
  return <><h1>{t('multiuser.audit')}</h1><p>{t('multiuser.auditHelp')}</p>
    {error ? <><Alert>{t('multiuser.requestError')}</Alert><Button onClick={() => setRevision((r) => r + 1)}>{t('multiuser.retry')}</Button></> : !data ? <p role="status">{t('multiuser.loading')}</p> : <>
      {data.events.length === 0 && <p>{t('multiuser.noAudit')}</p>}
      <label>{t('studio.admin.auditFilter')}<input value={filter} onChange={(event) => setFilter(event.target.value)} maxLength={128} /></label>
      <ul className={styles.list}>{data.events.filter((event) => !filter || [event.action, event.actorAccountId, event.targetAccountId].some((value) => value?.toLowerCase().includes(filter.toLowerCase()))).map((event) => <li key={event.id} className={styles.audit}><strong>{event.action}</strong><time>{new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(event.at)}</time><span>{t('multiuser.actor')}: {event.actorAccountId ?? '—'}</span><span>{t('multiuser.target')}: {event.targetAccountId ?? '—'}</span><code>{JSON.stringify(event.metadata)}</code></li>)}</ul>
      <div className={styles.actions}><Button disabled={before === null} onClick={() => setBefore(null)}>{t('multiuser.latest')}</Button><Button disabled={data.nextBefore === null} onClick={() => setBefore(data.nextBefore)}>{t('multiuser.next')}</Button></div>
    </>}
  </>;
}

/** The session withdrawal registry retires every admin draft and cached panel.
 * Role is a presentation check only; the daemon authorizes every request. */
export function AdminBoundary({ session, account, generation, children }: OwnedProps & { children: React.ReactNode }) {
  const t = useT();
  const [live, setLive] = useState(true);
  useEffect(() => session.bindResource(() => setLive(false), generation), [session, generation]);
  return live && account.role === 'admin' ? <div className={styles.admin}>{children}</div> : <p role="alert">{t('multiuser.denied')}</p>;
}
export function AdminUsers(props: OwnedProps) { return <AdminBoundary {...props}><AdminUsersContent {...props} /></AdminBoundary>; }
export function Audit(props: OwnedProps) { return <AdminBoundary {...props}><AuditContent {...props} /></AdminBoundary>; }
