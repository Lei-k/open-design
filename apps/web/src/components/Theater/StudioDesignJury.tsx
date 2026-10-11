import { useCallback, useEffect, useRef, useState } from 'react';
import type { MultiUserRunCreateResponse, StudioCritiqueRunsResponse, StudioCritiqueResponse, StudioCritiqueTranscriptResponse } from '@open-design/contracts';
import { Button } from '@open-design/components';
import { CRITIQUE_SSE_EVENT_NAMES } from '@open-design/contracts/critique';
import { useT } from '../../i18n';
import { useStudioCapabilities } from '../../runtime/studio-capabilities';
import { studioFetch, studioEventSourceCtor } from '../../runtime/studio-transport';
import { CritiqueTheaterMount } from './CritiqueTheaterMount';
import { TheaterTranscript } from './TheaterTranscript';
import { useCritiqueReplay, type ReplaySpeed } from './hooks/useCritiqueReplay';
import { sseToPanelEvent } from './state/sse';
import type { UseCritiqueStreamOptions } from './hooks/useCritiqueStream';

type Props = { projectId: string; conversationId: string | null; agentId: string | null; canWrite: boolean };
export function StudioDesignJury(props: Props) {
  const studio = useStudioCapabilities();
  if (!studio.available('execution')) return <p role="status">{studio.reason('execution')}</p>;
  return <Jury key={`${studio.generation}:${props.projectId}:${props.conversationId}`} {...props} />;
}
function Jury({ projectId, conversationId, agentId, canWrite }: Props) {
  const t = useT();
  const [prompt, setPrompt] = useState('');
  const [runId, setRunId] = useState<string | null>(null);
  const [runs, setRuns] = useState<StudioCritiqueRunsResponse['runs']>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [artifactRun, setArtifactRun] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [terminalRun, setTerminalRun] = useState<string | null>(null);
  const [replayOpen, setReplayOpen] = useState(false);
  const startedRun = useRef<string | null>(null);
  const live = useRef(true);
  const revision = useRef(0);
  const base = `/api/projects/${encodeURIComponent(projectId)}/critique`;
  useEffect(() => {
    live.current = true;
    const current = revision.current;
    void studioFetch(base).then((res) => res.ok ? res.json() : Promise.reject()).then((value) => {
      if (live.current && revision.current === current) {
        const owned = (value as StudioCritiqueRunsResponse).runs;
        setRuns(owned); setRunId(owned[0]?.id ?? null);
      }
    }).catch(() => { if (live.current) setError(true); });
    return () => { live.current = false; };
  }, [base]);
  useEffect(() => {
    if (!runId) return;
    let active = true;
    void studioFetch(`${base}/${encodeURIComponent(runId)}`).then((res) => res.ok ? res.json() : Promise.reject()).then((value: StudioCritiqueResponse) => {
      if (active && live.current && startedRun.current !== runId) {
        setWaiting(['active', 'queued'].includes(value.status));
        if (['succeeded', 'failed', 'canceled'].includes(value.status)) setTerminalRun(runId);
      }
    }).catch(() => { if (active && live.current) setError(true); });
    return () => { active = false; };
  }, [base, runId]);
  const start = async () => {
    if (busy || !prompt.trim() || !conversationId || !canWrite || !['codex', 'openai', 'openai-byok'].includes(agentId ?? '')) return;
    revision.current++; setBusy(true); setError(false); setArtifactRun(null);
    try {
      const res = await studioFetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId, agentId, message: prompt }) });
      if (!res.ok) throw new Error('jury_refused');
      const value = await res.json();
      if (live.current) {
        const id = (value as MultiUserRunCreateResponse).runId;
        setRuns((previous) => [{ id }, ...previous.filter((run) => run.id !== id)].slice(0, 50));
        setRunId(id); setPrompt(''); setReplayOpen(false);
      }
    } catch { if (live.current) setError(true); }
    finally { if (live.current) setBusy(false); }
  };
  const connectionFactory: NonNullable<UseCritiqueStreamOptions['connectionFactory']> = useCallback((_project, send) => {
    if (!runId) return { close() {} };
    let active = true;
    const EventSourceCtor = studioEventSourceCtor();
    if (!EventSourceCtor) return { close() {} };
    const source = new EventSourceCtor(`${base}/${encodeURIComponent(runId)}/events`);
    for (const eventName of CRITIQUE_SSE_EVENT_NAMES) source.addEventListener(eventName, ((event: MessageEvent) => {
      if (!active || !live.current) return;
      try {
        const action = sseToPanelEvent(eventName, JSON.parse(event.data));
        if (!action) return;
        startedRun.current = runId; setWaiting(false);
        if (action.type === 'ship' && ['shipped', 'below_threshold'].includes(action.status)) setArtifactRun(runId);
        send(action);
        if (['ship', 'interrupted', 'failed', 'degraded'].includes(action.type)) { setTerminalRun(runId); source.close(); }
      } catch { setError(true); }
    }) as EventListener);
    return { close() { active = false; source.close(); } };
  }, [base, runId]);
  return <section aria-label={t('critiqueTheater.userFacingName')}>
    {canWrite && <form onSubmit={(event) => { event.preventDefault(); void start(); }}>
      <label>{t('critiqueTheater.studioPrompt')}<textarea value={prompt} maxLength={64000} onChange={(event) => setPrompt(event.target.value)} /></label>
      <Button type="submit" disabled={busy || !prompt.trim() || !conversationId || !['codex', 'openai', 'openai-byok'].includes(agentId ?? '')}>
        {t(busy ? 'common.loading' : 'critiqueTheater.studioStart')}
      </Button>
    </form>}
    {error && <p role="alert">{t('critiqueTheater.transcriptError')}</p>}
    {runId && runs.length > 1 && <label>{t('critiqueTheater.replay')}<select aria-label={t('critiqueTheater.replay')} value={runId} onChange={(event) => {
      setRunId(event.target.value); setReplayOpen(false); setWaiting(false); setError(false);
    }}>{runs.map((run, index) => <option key={run.id} value={run.id}>{t('critiqueTheater.userFacingName')} {runs.length - index}</option>)}</select></label>}
    {runId && waiting && <div role="status">{t('common.loading')} <Button onClick={() => {
      void studioFetch(`${base}/${encodeURIComponent(runId)}/interrupt`, { method: 'POST' }).then((res) => {
        if (!live.current) return;
        if (res.ok) setWaiting(false); else setError(true);
      }).catch(() => { if (live.current) setError(true); });
    }}>{t('critiqueTheater.interrupt')}</Button></div>}
    {runId && <CritiqueTheaterMount key={`stream:${runId}`} projectId={projectId} enabled workspaceContext={null} connectionFactory={connectionFactory} />}
    {runId && terminalRun === runId && <Button aria-expanded={replayOpen} onClick={() => setReplayOpen((open) => !open)}>{t('critiqueTheater.replay')}</Button>}
    {runId && replayOpen && <JuryReplay key={`replay:${runId}`} url={`${base}/${encodeURIComponent(runId)}/transcript`} />}
    {runId && artifactRun === runId && <a href={`${base}/${encodeURIComponent(runId)}/artifact`} target="_blank" rel="noopener noreferrer">{t('critiqueTheater.studioArtifact')}</a>}
  </section>;
}

async function fetchJuryTranscript(url: string): Promise<string> {
  try {
    const response = await studioFetch(url);
    if (!response.ok) throw new Error();
    const value = await response.json() as StudioCritiqueTranscriptResponse;
    if (!Array.isArray(value.events)) throw new Error();
    return value.events.map((event) => JSON.stringify(event)).join('\n');
  } catch { throw new Error(); }
}
function JuryReplay({ url }: { url: string }) {
  const t = useT();
  const [speed, setSpeed] = useState<ReplaySpeed>('instant');
  const replay = useCritiqueReplay(url, speed, { fetchTranscript: fetchJuryTranscript, workspaceContext: null });
  const rounds = replay.state.phase === 'idle' ? [] : replay.state.rounds;
  return <>
    <TheaterTranscript state={replay.state} status={replay.status} error={replay.error} speed={speed} onSpeedChange={setSpeed} />
    {!!rounds.length && <ol aria-label={t('critiqueTheater.readOnly')}>{rounds.map((round) => <li key={round.n}>
      {round.decisionReason && <p>{round.decisionReason}</p>}
      {Object.entries(round.panelists).flatMap(([role, panelist]) => [
        ...(panelist?.dims ?? []).map((dim, index) => <div key={`dim:${role}:${index}`}><strong>{dim.name}</strong><p>{dim.note}</p></div>),
        ...(panelist?.mustFixes ?? []).map((text, index) => <p key={`fix:${role}:${index}`}>{text}</p>),
      ])}
    </li>)}</ol>}
  </>;
}
