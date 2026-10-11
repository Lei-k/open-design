import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '@open-design/components';
import { Folder, LogOut } from 'lucide-react';
import type { AuthAccount } from '@open-design/contracts';
import { STUDIO_PARITY_LANES, type StudioRuntimeCapabilities } from '@open-design/contracts';
import { useT } from '../i18n';
import { CookieSession, RequestFailure } from './session';
import { StudioSessionProvider, useStudioSession } from '../runtime/studio-session';
import { AgentAccountsPage } from './AgentAccountsPage';
import { ProjectConversations } from './ProjectConversations';
import { ConversationRuns } from './ConversationRuns';
import styles from './MultiUserApp.module.css';
import { lazy, Suspense } from 'react';
import { StudioCapabilitiesProvider } from '../runtime/studio-capabilities';
import { StudioLegacySettings as LegacySettings } from '../runtime/StudioLegacySettings';
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
  // Admin aliases and Settings use the shared frame even while legacy project
  // execution remains retained. This does not change effective shell policy.
  if (window.location.pathname.startsWith('/admin/') || window.location.pathname === '/settings') {
    const capabilities: StudioRuntimeCapabilities = state.studio ?? { schemaVersion: 1, shell: 'legacy-multiuser', features: Object.fromEntries(
      STUDIO_PARITY_LANES.map(({ id }) => [id, { status: 'unavailable', reason: t('multiuser.denied') }]),
    ) as StudioRuntimeCapabilities['features'] };
    return <>{outcome}<StudioCapabilitiesProvider key={state.generation} session={session} actor={state.account} generation={state.generation} capabilities={capabilities}>
      <Suspense fallback={<p role="status">{t('multiuser.loading')}</p>}><LegacySettings /></Suspense>
    </StudioCapabilitiesProvider></>;
  }
  return <>{outcome}<SignedIn key={`${state.generation}:${state.account.id}:${state.account.role}`} session={session} account={state.account} generation={state.generation} /></>;
}

type OwnedProps = { session: CookieSession; account: AuthAccount; generation: number };
function SignedIn(props: OwnedProps) {
  const t = useT();
  const route = window.location.pathname.replace(/\/$/, '') || '/';
  const projectRoute = /^\/projects\/([A-Za-z0-9_-]+)(?:\/conversations\/([A-Za-z0-9_-]+))?$/.exec(route);
  return <div className={styles.shell}><header className={styles.header}><Brand /><div className={styles.identity}><span>{props.account.username}</span><span className={styles.badge}>{t(props.account.role === 'admin' ? 'multiuser.admin' : 'multiuser.user')}</span><Button onClick={() => void props.session.logout()}><LogOut size={16} />{t('multiuser.signOut')}</Button></div></header>
    <div className={styles.body}><nav aria-label={t('multiuser.navigation')} className={styles.nav}>
      <a href="/projects" aria-current={route === '/projects' || projectRoute ? 'page' : undefined}><Folder size={18} />{t('multiuser.projects')}</a>
      <a href="/account/agents" aria-current={route === '/account/agents' ? 'page' : undefined}>{t('agentAccounts.navTitle')}</a>
      <a href="/settings">{t('settings.kicker')}</a>
    </nav><main className={styles.content}>
      <p className={styles.muted}>{t('multiuser.testOnly')}</p>
      {route === '/account/agents' ? <AgentAccountsPage {...props} /> : projectRoute?.[2] ? <ConversationRuns {...props} projectId={projectRoute[1]!} conversationId={projectRoute[2]} /> : projectRoute ? <ProjectConversations {...props} projectId={projectRoute[1]!} /> : <Projects {...props} />}
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
