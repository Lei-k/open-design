import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@open-design/components';
import { ArrowLeft } from 'lucide-react';
import type { DaemonAgentPayload, ConversationsResponse, MultiUserDesignCatalogResponse, MultiUserDesignSelectionResponse, MultiUserPreviewRenewResponse, MultiUserPreviewUrlResponse, MultiUserRun, MultiUserRunOutput, MultiUserRunProgressEvent, MultiUserRunRequest, MultiUserRunResponse, MultiUserRunsResponse, PersonalAgentAccountsResponse, ProjectDetailResponse, ProjectFile, ProjectFilesResponse, RunExecutionSource } from '@open-design/contracts';
import { useI18n, useT } from '../i18n';
import { splitOnQuestionForms } from '../artifacts/question-form';
import { QuestionFormView } from '../components/QuestionForm';
import { useOwnedRequest, useOwnedResource, type OwnedSession } from './owned';
import { RunComposer } from './RunComposer';
import { runProgress } from './run-progress';
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
function outputFiles(output: unknown): string[] {
  if (!output || typeof output !== 'object' || !Array.isArray((output as Partial<MultiUserRunOutput>).files)) return [];
  return (output as Partial<MultiUserRunOutput>).files!.filter((value): value is string => typeof value === 'string');
}
function outputTruncated(output: unknown): boolean {
  return Boolean(output && typeof output === 'object' && (output as Partial<MultiUserRunOutput>).textTruncated === true);
}
function failureReason(output: unknown): unknown {
  return output && typeof output === 'object' ? (output as Record<string, unknown>).reason : null;
}

function RunCard({ initial, interactive, submitAnswer, onTerminal, ...owner }: OwnedSession & {
  initial: MultiUserRun;
  interactive: boolean;
  submitAnswer: (message: string) => Promise<void>;
  onTerminal: (run: MultiUserRun) => void;
}) {
  const { t, locale } = useI18n();
  const request = useOwnedRequest(owner);
  const [run, setRun] = useState(initial);
  const runRef = useRef(run);
  runRef.current = run;
  const [text, setText] = useState(outputText(initial.output));
  const [reconnecting, setReconnecting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [canceling, setCanceling] = useState(false);
  const [answering, setAnswering] = useState(false);
  const [answerError, setAnswerError] = useState<unknown>(null);
  const [progress, setProgress] = useState<MultiUserRunProgressEvent[]>([]);
  const active = activeRun(run);
  useEffect(() => {
    if (!active) return;
    const tools = new Map<string, { name: string; path?: string }>();
    let accumulated = '';
    let reason: unknown = null;
    let truncated = false;
    return watchRunEvents(owner, initial.id, (frame) => {
      if (frame.event === 'queued') setRun((current) => ({ ...current, status: 'queued' }));
      if (frame.event === 'start') setRun((current) => ({ ...current, status: 'running', queuePosition: null }));
      if (frame.event === 'agent') {
        const event = frame.data as unknown as DaemonAgentPayload;
        if (event.type === 'text_delta') { accumulated += event.delta; setText(outputText({ text: accumulated })); }
        const next = runProgress(event, tools);
        if (next.length) setProgress((current) => [...current.slice(-19), ...next]);
      }
      if (frame.event === 'error') reason = (frame.data.error as { code?: unknown } | undefined)?.code;
      if (frame.event === 'diagnostic' && frame.data.type === 'personal_event_budget') truncated = true;
      if (frame.event === 'end') {
        const status = frame.data.status;
        if (status !== 'succeeded' && status !== 'failed' && status !== 'canceled') return;
        const streamedOutput = { text: accumulated, files: frame.data.artifactPaths ?? [], textTruncated: truncated, ...(reason ? { reason } : {}) };
        const next: MultiUserRun = { ...runRef.current, status, queuePosition: null, output: streamedOutput };
        setRun(next);
        onTerminal(next);
        const finalText = outputText(streamedOutput);
        if (finalText) setText(finalText);
        setReconnecting(false);
      }
    }, (value) => { setReconnecting(value); if (!value) setError(null); }, setError);
  }, [owner.session, owner.generation, initial.id, active, onTerminal]);
  // Queue positions change without run events. The owner read also reconciles
  // a terminal run after a broken stream; it never overwrites a terminal event.
  useEffect(() => {
    if (!activeRun(run)) return;
    const controller = new AbortController();
    const timer = setInterval(() => {
      void request<MultiUserRun>(`/api/runs/${encodeURIComponent(run.id)}`, { signal: controller.signal }).then((next) => {
        if (controller.signal.aborted || !request.active()) return;
        setRun((current) => activeRun(current) ? next : current);
        if (!activeRun(next)) {
          onTerminal(next);
          if (outputText(next.output)) setText(outputText(next.output));
        }
      }).catch((e) => { if (!controller.signal.aborted && request.active() && !isAbort(e)) setError(e); });
    }, 3000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [request, run.id, run.status, onTerminal]);
  async function cancel() {
    setCanceling(true); setError(null);
    try {
      const next = await request<MultiUserRun>(`/api/runs/${encodeURIComponent(run.id)}/cancel`, { method: 'POST' });
      if (request.active()) setRun((current) => activeRun(current) ? next : current);
    } catch (e) { if (request.active() && !isAbort(e)) setError(e); }
    finally { if (request.active()) setCanceling(false); }
  }
  async function answer(message: string) {
    if (answering) return;
    setAnswering(true); setAnswerError(null);
    try { await submitAnswer(message); }
    catch (e) { if (request.active() && !isAbort(e)) setAnswerError(e); }
    finally { if (request.active()) setAnswering(false); }
  }
  return <li className={styles.run}>
    <div className={styles.metadata}><span>{t(run.executionSource === 'personal_subscription' ? 'multiuserRuns.personal' : 'multiuserRuns.company')}</span><time dateTime={new Date(run.createdAt).toISOString()}>{new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(run.createdAt)}</time></div>
    <p role="status" aria-live="polite">{t(`multiuserRuns.${run.status}`)}{run.status === 'queued' && run.queuePosition !== null && <> · {t('multiuserRuns.position', { position: run.queuePosition })}</>}</p>
    {progress.length > 0 && <ul className={styles.progress} aria-label={t('multiuserRuns.running')}>{progress.map((item, index) => <li key={`${item.kind}-${index}`}>{item.kind === 'file' ? item.path : item.kind === 'command' ? `${item.name} · ${item.status}` : item.items.map((todo) => todo.content).join(' · ')}</li>)}</ul>}
    {(run.message || text) && <dl className={styles.exchange}>
      {run.message && <><dt>{t('multiuserRuns.prompt')}</dt><dd className={styles.prompt}>{run.message}</dd></>}
      {text && <><dt>{t('multiuserRuns.output')}</dt><dd>{splitOnQuestionForms(text).map((segment, index) => segment.kind === 'text'
        ? <pre key={index} className={styles.output}>{segment.text}</pre>
        : <QuestionFormView key={`${segment.form.id}-${index}`} form={segment.form} interactive={interactive} submitDisabled={activeRun(run) || answering} onSubmit={(message) => { void answer(message); }} />)}</dd></>}
    </dl>}
    {outputTruncated(run.output) && <p role="note" className={styles.warning}>{t('multiuserRuns.truncated')}</p>}
    {run.status === 'failed' && <p role="alert" className={styles.error}>{t(runErrorKey(failureReason(run.output)))}</p>}
    {/* Transport and cancel notices concern a live run; a terminal run has closed its stream. */}
    {active && reconnecting && <p role="status">{t('multiuserRuns.reconnecting')}</p>}
    {active && Boolean(error) && <p role="alert" className={styles.error}>{t(runErrorKey(error))}</p>}
    {Boolean(answerError) && <p role="alert" className={styles.error}>{t(runErrorKey(answerError))}</p>}
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
  const design = useOwnedResource<MultiUserDesignSelectionResponse>(request, `/api/multiuser/projects/${encodeURIComponent(props.projectId)}/conversations/${encodeURIComponent(props.conversationId)}/design`, revision);
  const catalog = useOwnedResource<MultiUserDesignCatalogResponse>(request, '/api/multiuser/design-catalog', revision);
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
  async function send(message: string, executionSource: RunExecutionSource, sourceRunId?: string) {
    if (!design.data) throw new Error('design selection unavailable');
    const body: MultiUserRunRequest = { ...(sourceRunId ? { analyticsHints: { entryFrom: 'question_answer', sourceRunId } } : {}), projectId: props.projectId, conversationId: props.conversationId, message, executionSource, agentId: executionSource === 'company_pool' ? 'test-mock' : 'codex',
      skillId: design.data.design.skillId, designSystemId: design.data.design.designSystemId };
    const result = await request<MultiUserRunResponse>('/api/runs', { method: 'POST', body: JSON.stringify(body) });
    if (request.active()) setAdded((current) => [...current, result.run]);
  }
  const error = project.error || conversations.error || history.error || design.error || catalog.error;
  const conversation = conversations.data?.conversations.find((item) => item.id === props.conversationId);
  const ready = project.data && conversations.data && history.data && design.data && catalog.data;
  const selectedSkill = catalog.data?.skills.find((item) => item.id === design.data?.design.skillId);
  const selectedSystem = catalog.data?.designSystems.find((item) => item.id === design.data?.design.designSystemId);
  const designLocale = design.data?.design.locale ?? 'en';
  const latestRunId = runs.at(-1)?.id ?? null;
  const generated = new Set(runs.flatMap((run) => outputFiles(run.output)));
  const terminalSignature = runs.map((run) => `${run.id}:${run.status}:${outputFiles(run.output).join(',')}`).join('|');
  const onTerminal = useCallback((next: MultiUserRun) => {
    setAdded((current) => current.map((run) => run.id === next.id ? next : run));
  }, []);
  return <><a className={styles.back} href={`/projects/${encodeURIComponent(props.projectId)}`}><ArrowLeft size={16} aria-hidden="true" />{t('multiuserRuns.conversations')}</a>
    {error || (ready && !conversation) ? <><p role="alert" className={styles.error}>{t(runErrorKey(error || 'NOT_FOUND'))}</p><Button onClick={retry}>{t('multiuser.retry')}</Button></>
      : !ready ? <p role="status">{t('multiuser.loading')}</p> : <>
        <p className={styles.hint}>{project.data?.project.name}</p><h1>{conversation?.title || t('multiuserRuns.untitled')}</h1>
        <p className={styles.selection}>{t('settings.skills')}: <strong>{selectedSkill?.displayName?.[designLocale] ?? selectedSkill?.name}</strong> · {t('settings.designSystems')}: <strong>{selectedSystem?.title}</strong></p>
        <div className={styles.workspace}>
          <section className={styles.conversationPane}>
            <h2>{t('multiuserRuns.history')}</h2>
            {nextCursor && <div className={styles.older}><Button disabled={loadingOlder} onClick={() => void loadOlder()}>{t('multiuserRuns.loadOlder')}</Button></div>}
            {Boolean(olderError) && <p role="alert" className={styles.error}>{t(runErrorKey(olderError))}</p>}
            {runs.length === 0 ? <p>{t('multiuserRuns.noRuns')}</p> : <ol className={styles.history}>{runs.map((run) => <RunCard key={run.id} initial={run} session={props.session} generation={props.generation}
              interactive={run.id === latestRunId && run.status === 'succeeded'} submitAnswer={(message) => send(message, 'personal_subscription', run.id)} onTerminal={onTerminal} />)}</ol>}
            {Boolean(accounts.error) && <p role="alert" className={styles.error}>{t(runErrorKey(accounts.error))}</p>}
            <RunComposer accounts={accounts.data} pinnedSource={pinnedSource} pinStale={pinStale} personalOnly send={send} />
          </section>
          <DesignWorkspace {...props} projectId={props.projectId} generated={generated} revisionKey={terminalSignature} />
        </div>
      </>}
  </>;
}

function DesignWorkspace(props: OwnedSession & { projectId: string; generated: Set<string>; revisionKey: string }) {
  const t = useT();
  const request = useOwnedRequest(props);
  const files = useOwnedResource<ProjectFilesResponse>(request, `/api/projects/${encodeURIComponent(props.projectId)}/files`, props.revisionKey);
  const [selected, setSelected] = useState<ProjectFile | null>(null);
  const [preview, setPreview] = useState<MultiUserPreviewUrlResponse | null>(null);
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (!files.data?.files.length) { setSelected(null); return; }
    setSelected((current) => files.data!.files.find((file) => file.name === current?.name) ?? files.data!.files[0]!);
  }, [files.data]);
  useEffect(() => {
    setPreview(null); setText(null);
    if (!selected) return;
    if (selected.kind === 'html') {
      const controller = new AbortController();
      let timer: number | null = null;
      const schedule = (scope: MultiUserPreviewUrlResponse) => {
        const delay = Math.max(1_000, scope.expiresAt - Date.now() - 60_000);
        timer = window.setTimeout(() => {
          void request<MultiUserPreviewRenewResponse>(scope.renewUrl, {
            method: 'POST', signal: controller.signal, headers: { 'preview-scope-renewal': '1' },
          }).then((renewed) => {
            if (controller.signal.aborted || !request.active()) return;
            const next = { ...scope, expiresAt: renewed.expiresAt };
            setPreview(next);
            schedule(next);
          }).catch(() => {
            if (controller.signal.aborted || !request.active()) return;
            // A revoked or expired scope is never reused. Minting a fresh one
            // also reloads the iframe and all of its relative subresources.
            void issue();
          });
        }, delay);
      };
      const issue = async () => {
        if (timer !== null) window.clearTimeout(timer);
        try {
          const next = await request<MultiUserPreviewUrlResponse>(`/api/multiuser/projects/${encodeURIComponent(props.projectId)}/preview-url?file=${encodeURIComponent(selected.name)}`, { signal: controller.signal });
          if (controller.signal.aborted || !request.active()) return;
          setPreview(next);
          schedule(next);
        } catch {
          if (!controller.signal.aborted && request.active()) setPreview(null);
        }
      };
      void issue();
      return () => { controller.abort(); if (timer !== null) window.clearTimeout(timer); };
    }
    if (selected.kind === 'text' || selected.kind === 'code') {
      const controller = new AbortController();
      void props.session.stream(`/api/projects/${encodeURIComponent(props.projectId)}/file-content/${selected.name.split('/').map(encodeURIComponent).join('/')}`, controller.signal, props.generation)
        .then((response) => response.text()).then((value) => { if (!controller.signal.aborted) setText(value); }).catch(() => { if (!controller.signal.aborted) setText(''); });
      return () => controller.abort();
    }
  }, [request, selected?.name, props.session, props.generation, props.projectId]);
  const fileUrl = selected ? `/api/projects/${encodeURIComponent(props.projectId)}/file-content/${selected.name.split('/').map(encodeURIComponent).join('/')}` : '';
  const inlineImage = selected?.kind === 'image' && selected.mime?.toLowerCase() !== 'image/svg+xml';
  return <aside className={styles.filePane} aria-label={t('settings.skillsFiles')}>
    <h2>{t('settings.skillsFiles')}</h2>
    {files.error ? <p role="alert" className={styles.error}>{t('multiuser.requestError')}</p> : !files.data ? <p role="status">{t('multiuser.loading')}</p>
      : files.data.files.length === 0 ? <p>{t('settings.skillsNoFiles')}</p> : <>
        <ul className={styles.files}>{files.data.files.map((file) => <li key={file.name}><button type="button" aria-current={selected?.name === file.name ? 'true' : undefined} onClick={() => setSelected(file)}>{file.name}{props.generated.has(file.name) ? ' •' : ''}</button></li>)}</ul>
        {selected && <div className={styles.preview}>
          {selected.kind === 'html' && (preview ? <iframe title={selected.name} src={preview.url} sandbox="allow-scripts allow-forms" referrerPolicy="no-referrer" /> : <p role="status">{t('multiuser.loading')}</p>)}
          {inlineImage && <img src={fileUrl} alt={selected.name} />}
          {(selected.kind === 'text' || selected.kind === 'code') && <pre>{text ?? t('multiuser.loading')}</pre>}
          {(!['html', 'image', 'text', 'code'].includes(selected.kind) || (selected.kind === 'image' && !inlineImage)) && <a href={`${fileUrl}?download=1`}>{t('updater.download')}</a>}
        </div>}
      </>}
  </aside>;
}
