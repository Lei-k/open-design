import { useEffect, useState } from 'react';
import { Button } from '@open-design/components';
import { ArrowLeft } from 'lucide-react';
import type { ConversationsResponse, MultiUserRun, MultiUserRunRequest, MultiUserRunResponse, MultiUserRunsResponse, PersonalAgentAccountsResponse, ProjectDetailResponse, RunExecutionSource } from '@open-design/contracts';
import { useI18n, useT } from '../i18n';
import { useOwnedRequest, useOwnedResource, type OwnedSession } from './owned';
import { RunComposer } from './RunComposer';
import { watchRunEvents } from './run-stream';
import { isAbort, runErrorKey } from './run-errors';
import styles from './Runs.module.css';

const activeRun = (run: MultiUserRun) => run.status === 'queued' || run.status === 'running';
const HISTORY_PAGE = 20;
function outputText(output: unknown): string {
  if (!output || typeof output !== 'object') return '';
  const value = output as Record<string, unknown>;
  if (typeof value.message === 'string') return value.message;
  if (typeof value.text !== 'string') return '';
  // The personal test mock replies with a diagnostic envelope. Keep runtime
  // paths and environment inventory out of the conversation presentation.
  try {
    const mock = JSON.parse(value.text) as Record<string, unknown>;
    if (typeof mock.codexHome === 'string' && typeof mock.message === 'string') return mock.message;
  } catch { /* Normal agent text is not JSON. */ }
  return value.text;
}
function failureReason(output: unknown): unknown {
  return output && typeof output === 'object' ? (output as Record<string, unknown>).reason : null;
}

function RunCard({ initial, ...owner }: OwnedSession & { initial: MultiUserRun }) {
  const { t, locale } = useI18n();
  const request = useOwnedRequest(owner);
  const [run, setRun] = useState(initial);
  const [text, setText] = useState(outputText(initial.output));
  const [reconnecting, setReconnecting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [canceling, setCanceling] = useState(false);
  const active = activeRun(run);
  useEffect(() => {
    if (!active) return;
    return watchRunEvents(owner, initial.id, (frame) => {
      if (frame.event === 'queued') setRun((current) => ({ ...current, status: 'queued' }));
      if (frame.event === 'start') setRun((current) => ({ ...current, status: 'running', queuePosition: null }));
      if (frame.event === 'agent') setText((current) => current + outputText(frame.data));
      if (frame.event === 'end') {
        const status = frame.data.status;
        if (status !== 'succeeded' && status !== 'failed' && status !== 'canceled') return;
        setRun((current) => ({ ...current, status, queuePosition: null, output: frame.data.output ?? current.output }));
        const finalText = outputText(frame.data.output);
        if (finalText) setText(finalText);
        setReconnecting(false);
      }
    }, (value) => { setReconnecting(value); if (!value) setError(null); }, setError);
  }, [owner.session, owner.generation, initial.id, active]);
  // Queue positions change without run events. The owner read also reconciles
  // a terminal run after a broken stream; it never overwrites a terminal event.
  useEffect(() => {
    if (!activeRun(run)) return;
    const controller = new AbortController();
    const timer = setInterval(() => {
      void request<MultiUserRun>(`/api/runs/${encodeURIComponent(run.id)}`, { signal: controller.signal }).then((next) => {
        if (controller.signal.aborted || !request.active()) return;
        setRun((current) => activeRun(current) ? next : current);
        if (!activeRun(next) && outputText(next.output)) setText(outputText(next.output));
      }).catch((e) => { if (!controller.signal.aborted && request.active() && !isAbort(e)) setError(e); });
    }, 3000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [request, run.id, run.status]);
  async function cancel() {
    setCanceling(true); setError(null);
    try {
      const next = await request<MultiUserRun>(`/api/runs/${encodeURIComponent(run.id)}/cancel`, { method: 'POST' });
      if (request.active()) setRun((current) => activeRun(current) ? next : current);
    } catch (e) { if (request.active() && !isAbort(e)) setError(e); }
    finally { if (request.active()) setCanceling(false); }
  }
  return <li className={styles.run}>
    <div className={styles.metadata}><span>{t(run.executionSource === 'personal_subscription' ? 'multiuserRuns.personal' : 'multiuserRuns.company')}</span><time dateTime={new Date(run.createdAt).toISOString()}>{new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(run.createdAt)}</time></div>
    <p role="status" aria-live="polite">{t(`multiuserRuns.${run.status}`)}{run.status === 'queued' && run.queuePosition !== null && <> · {t('multiuserRuns.position', { position: run.queuePosition })}</>}</p>
    {(run.message || text) && <dl className={styles.exchange}>
      {run.message && <><dt>{t('multiuserRuns.prompt')}</dt><dd className={styles.prompt}>{run.message}</dd></>}
      {text && <><dt>{t('multiuserRuns.output')}</dt><dd><pre className={styles.output}>{text}</pre></dd></>}
    </dl>}
    {run.status === 'failed' && <p role="alert" className={styles.error}>{t(runErrorKey(failureReason(run.output)))}</p>}
    {/* Transport and cancel notices concern a live run; a terminal run has closed its stream. */}
    {active && reconnecting && <p role="status">{t('multiuserRuns.reconnecting')}</p>}
    {active && Boolean(error) && <p role="alert" className={styles.error}>{t(runErrorKey(error))}</p>}
    {activeRun(run) && <Button disabled={canceling} onClick={() => void cancel()}>{t('multiuserRuns.cancel')}</Button>}
  </li>;
}

export function ConversationRuns(props: OwnedSession & { projectId: string; conversationId: string }) {
  const t = useT();
  const request = useOwnedRequest(props);
  const [revision, setRevision] = useState(0);
  const [added, setAdded] = useState<MultiUserRun[]>([]);
  const base = `/api/projects/${encodeURIComponent(props.projectId)}`;
  const project = useOwnedResource<ProjectDetailResponse>(request, base, revision);
  const conversations = useOwnedResource<ConversationsResponse>(request, `${base}/conversations`, revision);
  const historyUrl = `/api/runs?projectId=${encodeURIComponent(props.projectId)}&conversationId=${encodeURIComponent(props.conversationId)}&limit=${HISTORY_PAGE}`;
  const history = useOwnedResource<MultiUserRunsResponse>(request, historyUrl, revision);
  const accounts = useOwnedResource<PersonalAgentAccountsResponse>(request, '/api/agent-accounts', revision);
  // Older pages continue from the newest page's cursor; a retry starts over.
  const [older, setOlder] = useState<{ runs: MultiUserRun[]; cursor: string | null } | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<unknown>(null);
  const nextCursor = older ? older.cursor : history.data?.nextCursor ?? null;
  const runs = [...(history.data?.runs ?? []), ...(older?.runs ?? []), ...added].filter((run, index, all) => all.findIndex((other) => other.id === run.id) === index).sort((a, b) => a.createdAt - b.createdAt);
  // The server refuses a run on any other source or account, so every run of a
  // conversation shares its pin: the newest page names it without older history.
  const pinnedSource = runs.length ? runs[runs.length - 1]!.executionSource ?? 'company_pool' : null;
  const pinStale = pinnedSource === 'personal_subscription' && history.data?.personalPinStale === true;
  async function loadOlder() {
    if (!nextCursor || loadingOlder) return;
    setLoadingOlder(true); setOlderError(null);
    try {
      const page = await request<MultiUserRunsResponse>(`${historyUrl}&cursor=${encodeURIComponent(nextCursor)}`);
      if (request.active()) setOlder((current) => ({ runs: [...(current?.runs ?? []), ...page.runs], cursor: page.nextCursor }));
    } catch (e) { if (request.active() && !isAbort(e)) setOlderError(e); }
    finally { if (request.active()) setLoadingOlder(false); }
  }
  function retry() { setOlder(null); setOlderError(null); setRevision((n) => n + 1); }
  async function send(message: string, executionSource: RunExecutionSource) {
    const body: MultiUserRunRequest = { projectId: props.projectId, conversationId: props.conversationId, message, executionSource, agentId: executionSource === 'company_pool' ? 'test-mock' : 'codex' };
    const result = await request<MultiUserRunResponse>('/api/runs', { method: 'POST', body: JSON.stringify(body) });
    if (request.active()) setAdded((current) => [...current, result.run]);
  }
  const error = project.error || conversations.error || history.error;
  const conversation = conversations.data?.conversations.find((item) => item.id === props.conversationId);
  const ready = project.data && conversations.data && history.data;
  return <><a className={styles.back} href={`/projects/${encodeURIComponent(props.projectId)}`}><ArrowLeft size={16} aria-hidden="true" />{t('multiuserRuns.conversations')}</a>
    {error || (ready && !conversation) ? <><p role="alert" className={styles.error}>{t(runErrorKey(error || 'NOT_FOUND'))}</p><Button onClick={retry}>{t('multiuser.retry')}</Button></>
      : !ready ? <p role="status">{t('multiuser.loading')}</p> : <>
        <p className={styles.hint}>{project.data?.project.name}</p><h1>{conversation?.title || t('multiuserRuns.untitled')}</h1>
        <h2>{t('multiuserRuns.history')}</h2>
        {nextCursor && <div className={styles.older}><Button disabled={loadingOlder} onClick={() => void loadOlder()}>{t('multiuserRuns.loadOlder')}</Button></div>}
        {Boolean(olderError) && <p role="alert" className={styles.error}>{t(runErrorKey(olderError))}</p>}
        {runs.length === 0 ? <p>{t('multiuserRuns.noRuns')}</p> : <ol className={styles.history}>{runs.map((run) => <RunCard key={run.id} initial={run} session={props.session} generation={props.generation} />)}</ol>}
        {Boolean(accounts.error) && <p role="alert" className={styles.error}>{t(runErrorKey(accounts.error))}</p>}
        <RunComposer accounts={accounts.data} pinnedSource={pinnedSource} pinStale={pinStale} send={send} />
      </>}
  </>;
}
