import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '@open-design/components';
import { Folder, LogOut, Users, ClipboardList } from 'lucide-react';
import type { StudioPilotState, AuthAccount, AuthAccountListResponse, AuthAuditListResponse, AuthCreateAccountResponse, AuthIssueSetupCredentialResponse, AuthSetupCredential } from '@open-design/contracts';
import { useI18n, useT } from '../i18n';
import { CookieSession, RequestFailure } from './session';
import { StudioSessionProvider, useStudioSession } from '../runtime/studio-session';
import { CompanyOpenAISection } from './CompanyOpenAISection';
import { AgentAccountsPage } from './AgentAccountsPage';
import { ProjectConversations } from './ProjectConversations';
import { ConversationRuns } from './ConversationRuns';
import styles from './MultiUserApp.module.css';
import { lazy, Suspense } from 'react';
import { StudioCapabilitiesProvider } from '../runtime/studio-capabilities';
const StudioApp = lazy(() => import('../App').then(({ App }) => ({ default: App })));

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
function Credentials({ setup, busy, submit }: { setup?: boolean; busy: boolean; submit: (username: string, password: string) => void }) {
  const t = useT();
  const [mismatch, setMismatch] = useState(false);
  function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const password = String(data.get('password'));
    if (setup && password !== data.get('confirmation')) { setMismatch(true); return; }
    setMismatch(false);
    submit(String(data.get('username') ?? ''), password);
    form.reset();
  }
  return <form className={styles.form} onSubmit={send}>
    {!setup && <label>{t('multiuser.username')}<input name="username" autoComplete="username" required maxLength={32} autoCapitalize="none" spellCheck={false} /></label>}
    <label>{t('multiuser.password')}<input name="password" type="password" autoComplete={setup ? 'new-password' : 'current-password'} required minLength={setup ? 12 : undefined} maxLength={1024} /></label>
    {setup && <><p>{t('multiuser.passwordPolicy')}</p><label>{t('multiuser.confirmPassword')}<input name="confirmation" type="password" autoComplete="new-password" required /></label></>}
    {mismatch && <Alert>{t('multiuser.mismatch')}</Alert>}
    <Button variant="primary" type="submit" disabled={busy}>{t(busy ? 'multiuser.saving' : setup ? 'multiuser.setPassword' : 'multiuser.signIn')}</Button>
  </form>;
}

function Setup({ token, clear }: { token: string | null; clear: () => void }) {
  const t = useT();
  const [session] = useState(() => new CookieSession());
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const currentToken = useRef(token);
  currentToken.current = token;
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { session.withdraw(); return () => session.dispose(); }, [session, token]);
  useEffect(() => { if (token) { setDone(false); setError(null); } }, [token]);
  async function submit(_username: string, password: string) {
    setBusy(true); setError(null);
    try {
      await session.request('/api/auth/setup', { method: 'POST', body: JSON.stringify({ token, password }) });
      if (currentToken.current !== token) return;
      clear(); setDone(true);
    } catch (e) {
      if (isAborted(e)) return;
      setError(t(e instanceof RequestFailure && e.status === 401 ? 'multiuser.setupInvalid' : failureKey(e)));
    } finally { setBusy(false); }
  }
  return <main className={styles.auth}><Brand /><h1>{t('multiuser.setPassword')}</h1>
    {done ? <p role="status">{t('multiuser.setupDone')}</p> : token ? <Credentials setup busy={busy} submit={submit} /> : <Alert>{t('multiuser.setupInvalid')}</Alert>}
    {error && <Alert>{error}</Alert>}<a href="/login" onClick={clear}>{t('multiuser.signIn')}</a></main>;
}
function Brand() { return <div className={styles.brand}><img src="/app-icon.png" alt="" width="32" height="32" />OpenDesign</div>; }

export function MultiUserApp({ setupToken, clearSetupToken = () => {} }: { setupToken: string | null; clearSetupToken?: () => void }) {
  const setup = window.location.pathname.replace(/\/$/, '') === '/setup';
  return <StudioSessionProvider paused={setup}><MultiUserEntry setupToken={setupToken} clearSetupToken={clearSetupToken} /></StudioSessionProvider>;
}

function MultiUserEntry({ setupToken, clearSetupToken }: { setupToken: string | null; clearSetupToken: () => void }) {
  const t = useT();
  const { session, state } = useStudioSession();
  const [loginError, setLoginError] = useState(false);
  const setup = window.location.pathname.replace(/\/$/, '') === '/setup';
  const outcome = state.outcomeUnknown && <div className={styles.operationNotice} role="alert"><p>{t('multiuser.outcomeUnknown')}</p><Button onClick={session.clearOutcomeUnknown}>{t('multiuser.dismissNotice')}</Button></div>;
  if (setup) return <Setup token={setupToken} clear={clearSetupToken} />;
  if (state.status === 'checking' || state.status === 'error') return <>{outcome}<main className={styles.auth}><Brand /><p role="status">{t(state.status === 'error' ? 'multiuser.connectionError' : 'multiuser.checking')}</p>
    {state.status === 'error' && <><Button onClick={() => void session.verify()}>{t('multiuser.retry')}</Button><Button onClick={() => void session.logout()}>{t('multiuser.signOut')}</Button></>}</main></>;
  if (!state.account) return <>{outcome}<main className={styles.auth}><Brand /><h1>{t('multiuser.signIn')}</h1><p>{t('multiuser.inviteOnly')}</p>
    <Credentials busy={false} submit={(username, password) => { setLoginError(false); void session.login(username, password).catch(() => setLoginError(true)); }} />
    {loginError && <Alert>{t('multiuser.loginError')}</Alert>}<p className={styles.muted}>{t('multiuser.testOnly')}</p></main></>;
  if (state.studio?.shell === 'studio') return <>{outcome}<StudioCapabilitiesProvider key={`${state.generation}:${state.account.id}:${state.account.role}`} session={session} actor={state.account} capabilities={state.studio} generation={state.generation} messageIdPrefix={state.studioMessageIdPrefix}>
    <Suspense fallback={<p role="status">{t('multiuser.loading')}</p>}><StudioApp /></Suspense>
  </StudioCapabilitiesProvider></>;
  return <>{outcome}<SignedIn key={`${state.generation}:${state.account.id}:${state.account.role}`} session={session} account={state.account} generation={state.generation} /></>;
}

type OwnedProps = { session: CookieSession; account: AuthAccount; generation: number };
function SignedIn(props: OwnedProps) {
  const t = useT();
  const route = window.location.pathname.replace(/\/$/, '') || '/';
  const adminPage = route.startsWith('/admin');
  const projectRoute = /^\/projects\/([A-Za-z0-9_-]+)(?:\/conversations\/([A-Za-z0-9_-]+))?$/.exec(route);
  return <div className={styles.shell}><header className={styles.header}><Brand /><div className={styles.identity}><span>{props.account.username}</span><span className={styles.badge}>{t(props.account.role === 'admin' ? 'multiuser.admin' : 'multiuser.user')}</span><Button onClick={() => void props.session.logout()}><LogOut size={16} />{t('multiuser.signOut')}</Button></div></header>
    <div className={styles.body}><nav aria-label={t('multiuser.navigation')} className={styles.nav}>
      <a href="/projects" aria-current={route === '/projects' || projectRoute ? 'page' : undefined}><Folder size={18} />{t('multiuser.projects')}</a>
      <a href="/account/agents" aria-current={route === '/account/agents' ? 'page' : undefined}>{t('agentAccounts.navTitle')}</a>
      {props.account.role === 'admin' && <><a href="/admin/users" aria-current={route === '/admin/users' ? 'page' : undefined}><Users size={18} />{t('multiuser.users')}</a><a href="/admin/audit" aria-current={route === '/admin/audit' ? 'page' : undefined}><ClipboardList size={18} />{t('multiuser.audit')}</a></>}
    </nav><main className={styles.content}>
      <p className={styles.muted}>{t('multiuser.testOnly')}</p>
      {adminPage && props.account.role !== 'admin' ? <><h1>{t('multiuser.denied')}</h1><p>{t('multiuser.adminOnly')}</p></> : route === '/admin/users' ? <AdminUsers {...props} /> : route === '/admin/audit' ? <Audit {...props} /> : route === '/account/agents' ? <AgentAccountsPage {...props} /> : projectRoute?.[2] ? <ConversationRuns {...props} projectId={projectRoute[1]!} conversationId={projectRoute[2]} /> : projectRoute ? <ProjectConversations {...props} projectId={projectRoute[1]!} /> : <Projects {...props} />}
    </main></div></div>;
}

/** Component requests are tied to both the live session generation and mount. */
function useOwnedLoad<T>(props: OwnedProps, url: string, revision = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true; setData(null); setError(false);
    void props.session.request<T>(url, undefined, props.generation).then((value) => { if (active) setData(value); }).catch((e) => { if (active && !isAborted(e)) setError(true); });
    return () => { active = false; };
  }, [props.session, props.generation, url, revision]);
  return { data, error };
}
function Projects(props: OwnedProps) {
  const t = useT();
  const [revision, setRevision] = useState(0);
  const { data, error } = useOwnedLoad<{ projects: Array<{ id: string; name: string }> }>(props, '/api/projects', revision);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const name = String(new FormData(form).get('name')).trim();
    if (!name) return; setBusy(true); setActionError(null);
    try { await props.session.request('/api/projects', { method: 'POST', body: JSON.stringify({ id: crypto.randomUUID(), name }) }, props.generation); form.reset(); setRevision((r) => r + 1); }
    catch (e) { if (!isAborted(e)) setActionError(t(failureKey(e))); }
    finally { setBusy(false); }
  }
  return <><h1>{t('multiuser.projects')}</h1><p>{t('multiuserRuns.projectsHelp')}</p>
    <form className={styles.inlineForm} onSubmit={create}><label>{t('multiuser.projectName')}<input name="name" required maxLength={120} /></label><Button variant="primary" type="submit" disabled={busy}>{t('multiuser.createProject')}</Button></form>
    {actionError && <Alert>{actionError}</Alert>}
    {error ? <><Alert>{t('multiuser.requestError')}</Alert><Button onClick={() => setRevision((r) => r + 1)}>{t('multiuser.retry')}</Button></> : !data ? <p role="status">{t('multiuser.loading')}</p> : data.projects.length === 0 ? <p className={styles.empty}>{t('multiuser.noProjects')}</p> : <ul className={styles.list}>{data.projects.map((project) => <li key={project.id}><Folder size={20} /><a href={`/projects/${encodeURIComponent(project.id)}`}><strong>{project.name}</strong></a></li>)}</ul>}
  </>;
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

export function AdminUsers(props: OwnedProps) {
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
    const body = action === 'active' ? { active: !account.active } : action === 'role' ? { role: account.role === 'admin' ? 'user' : 'admin' } : {};
    try {
      const result = await props.session.request<AuthIssueSetupCredentialResponse>(`/api/auth/users/${encodeURIComponent(account.id)}${suffix}`, { method: suffix ? 'POST' : 'PATCH', body: JSON.stringify(body) }, props.generation);
      setConfirm(null);
      if (account.id === props.account.id) { props.session.withdraw(); await props.session.verify(); return; }
      if (action === 'reset') setSetup(result.setup);
      setNotice(t('multiuser.saved')); setRevision((r) => r + 1);
    } catch (e) { if (!isAborted(e)) setActionError(t(failureKey(e))); } finally { setBusy(false); }
  }
  return <><CompanyOpenAISection session={props.session} generation={props.generation} /><h1>{t('multiuser.users')}</h1><p>{t('multiuser.usersHelp')}</p>
    <form className={styles.inlineForm} onSubmit={create}><label>{t('multiuser.username')}<input name="username" required pattern="[A-Za-z0-9_.-]{3,32}" maxLength={32} autoComplete="off" /></label><label>{t('multiuser.role')}<select name="role"><option value="user">{t('multiuser.user')}</option><option value="admin">{t('multiuser.admin')}</option></select></label><Button variant="primary" type="submit" disabled={busy}>{t('multiuser.createUser')}</Button></form>
    {setup && <SetupLink setup={setup} dismiss={() => setSetup(null)} />}
    {confirm && <section className={styles.confirm} aria-label={t('multiuser.confirmAction')}><h2>{t('multiuser.confirmAction')} · {confirm.account.username}</h2><p>{t(confirm.action === 'reset' ? 'multiuser.resetWarning' : 'multiuser.revokeWarning')}</p><div className={styles.actions}><Button disabled={busy} onClick={() => void apply()}>{t('multiuser.confirm')}</Button><Button disabled={busy} onClick={() => setConfirm(null)}>{t('multiuser.cancel')}</Button></div></section>}
    {actionError && <Alert>{actionError}</Alert>}{notice && <p role="status">{notice}</p>}
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

export function Audit(props: OwnedProps) {
  const { t, locale } = useI18n(); const [before, setBefore] = useState<number | null>(null); const [revision, setRevision] = useState(0);
  const { data, error } = useOwnedLoad<AuthAuditListResponse>(props, `/api/auth/audit?limit=20${before === null ? '' : `&before=${before}`}`, revision);
  return <><h1>{t('multiuser.audit')}</h1><p>{t('multiuser.auditHelp')}</p>
    {error ? <><Alert>{t('multiuser.requestError')}</Alert><Button onClick={() => setRevision((r) => r + 1)}>{t('multiuser.retry')}</Button></> : !data ? <p role="status">{t('multiuser.loading')}</p> : <>
      {data.events.length === 0 && <p>{t('multiuser.noAudit')}</p>}
      <ul className={styles.list}>{data.events.map((event) => <li key={event.id} className={styles.audit}><strong>{event.action}</strong><time>{new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(event.at)}</time><span>{t('multiuser.actor')}: {event.actorAccountId ?? '—'}</span><span>{t('multiuser.target')}: {event.targetAccountId ?? '—'}</span><code>{JSON.stringify(event.metadata)}</code></li>)}</ul>
      <div className={styles.actions}><Button disabled={before === null} onClick={() => setBefore(null)}>{t('multiuser.latest')}</Button><Button disabled={data.nextBefore === null} onClick={() => setBefore(data.nextBefore)}>{t('multiuser.next')}</Button></div>
    </>}
  </>;
}
