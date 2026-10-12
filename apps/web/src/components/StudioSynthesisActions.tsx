import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@open-design/components';
import type { RunExecutionSource, StudioHandoffRequest, StudioFinalizeRequest, StudioSynthesisState, StudioSynthesisResult, StudioSynthesisRefusal } from '@open-design/contracts';
import { useT } from '../i18n';
import { useStudioCapabilities } from '../runtime/studio-capabilities';
import { studioFetch, studioSetInterval } from '../runtime/studio-transport';
import styles from './StudioSynthesisActions.module.css';

/** Shared project/header and FileViewer delivery controls. Authority comes from the daemon. */
interface Props {
  projectId: string; conversationId?: string | null; canWrite?: boolean;
}
export function StudioSynthesisActions(props: Props) {
  const studio = useStudioCapabilities();
  // Drop private state during render, before effects run, on every identity
  // or project transition. Old in-flight responses are also aborted below.
  return <StudioSynthesisPanel key={JSON.stringify([studio.actor?.id, studio.generation, props.projectId, props.conversationId, props.canWrite])} {...props} />;
}
function StudioSynthesisPanel({ projectId, conversationId, canWrite = true }: Props) {
  const studio = useStudioCapabilities(); const t = useT(); const description = useId();
  const [state, setState] = useState<StudioSynthesisState | null>(null);
  const [selection, setSelection] = useState<RunExecutionSource | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<StudioSynthesisResult | null>(null);
  const lifetime = useRef<AbortController | null>(null);
  const revision = useRef(0);
  const performing = useRef(false);
  const selected = selection ?? state?.defaultSource ?? null;
  useEffect(() => { setReceipt(null); }, [selected]);
  const usable = !studio.hostServices && studio.available('delivery');
  const endpoint = `/api/projects/${encodeURIComponent(projectId)}`;
  useEffect(() => {
    setState(null); setReceipt(null); setSelection(null); setError(null); setBusy(null);
    if (!usable) return;
    const controller = new AbortController(); lifetime.current = controller;
    let reading = false;
    const read = async () => {
      if (reading || performing.current) return; reading = true;
      const version = revision.current;
      try {
        const response = await studioFetch(`${endpoint}/synthesis`, { signal: controller.signal });
        if (!response.ok) throw new Error('state');
        const body = await response.json() as StudioSynthesisState;
        if (!controller.signal.aborted && version === revision.current) setState(body);
      } catch { if (!controller.signal.aborted && version === revision.current) { setState(null); setError(t('studio.synthesis.failed')); } }
      finally { reading = false; }
    };
    void read();
    const timer = studioSetInterval(() => void read(), 5000);
    window.addEventListener('focus', read);
    return () => { controller.abort(); clearInterval(timer); window.removeEventListener('focus', read); if (lifetime.current === controller) lifetime.current = null; };
  }, [endpoint, usable, studio.generation, conversationId, t]);
  if (studio.hostServices) return null;
  const source = state?.sources.find((item) => item.executionSource === selected);
  const reason: StudioSynthesisRefusal | null = !canWrite ? 'project-read-only' : source?.reason
    ?? (selected ? state && !source ? 'provider-disabled' : null : 'source-required');
  const reasonKey: Record<StudioSynthesisRefusal, Parameters<typeof t>[0]> = {
    'personal-codex': 'studio.synthesis.personalCodex', 'source-required': 'studio.synthesis.chooseSource',
    'provider-disabled': 'studio.synthesis.providerDisabled', 'key-missing': 'studio.synthesis.keyMissing',
    'quota-exhausted': 'studio.synthesis.quotaExhausted', 'project-read-only': 'studio.synthesis.readOnly',
  };
  const reasonText = !usable ? studio.reason('delivery') : reason ? t(reasonKey[reason]) : !state ? t('common.loading') : '';
  const enabled = usable && canWrite && source?.available === true && !busy;
  const perform = async (action: 'finalize' | 'handoff') => {
    const controller = lifetime.current;
    if (!enabled || !state || !selected || !controller || controller.signal.aborted) return;
    // A pre-action poll belongs to the previous generation of receipt state.
    // It may finish, but must never replace this action's authoritative read.
    revision.current++; performing.current = true;
    setBusy(action); setError(null); setReceipt(null);
    const body: StudioFinalizeRequest | StudioHandoffRequest = { executionSource: selected, digest: state.digest,
      ...(action === 'handoff' && conversationId ? { conversationId } : {}) };
    try {
      const response = await studioFetch(`${endpoint}/${action === 'finalize' ? 'finalize/openai' : 'handoff'}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal,
      });
      const result = await response.json() as StudioSynthesisResult & { error?: { code?: string } };
      if (controller.signal.aborted) return;
      if (!response.ok) {
        setError(t(result.error?.code === 'MULTIUSER_SYNTHESIS_STALE' ? 'studio.synthesis.stale'
          : result.error?.code === 'MULTIUSER_SYNTHESIS_AUTHORITY_CHANGED' ? 'studio.synthesis.authorityChanged'
          : result.error?.code === 'MULTIUSER_QUOTA_EXHAUSTED' ? 'studio.synthesis.quotaExhausted' : 'studio.synthesis.failed'));
        return;
      }
      const latest = await studioFetch(`${endpoint}/synthesis`, { signal: controller.signal });
      if (!latest.ok) throw new Error('state');
      const next = await latest.json() as StudioSynthesisState;
      if (!controller.signal.aborted) { setState(next); setReceipt(result); }
    } catch { if (!controller.signal.aborted) setError(t('studio.synthesis.failed')); }
    finally { performing.current = false; if (!controller.signal.aborted) setBusy(null); }
  };
  const current = receipt && state?.results[receipt.action]?.id === receipt.id && state.results[receipt.action]?.current === true;
  const savedResults = Object.values(state?.results ?? {}).filter((result): result is StudioSynthesisResult => Boolean(result));
  return <div data-testid="studio-synthesis-actions" className={styles.actions}>
    <div data-synthesis-controls className={styles.controls}>
      <select aria-label={t('multiuserRuns.source')} value={selected ?? ''} disabled={!!busy || !usable || !state}
        className={styles.source} onChange={(event) => { setSelection(event.target.value as RunExecutionSource); setReceipt(null); setError(null); }}>
        <option value="" disabled>{t('studio.synthesis.chooseSource')}</option>
        {state?.sources.map((item) => <option key={item.executionSource} value={item.executionSource}>
          {t(item.executionSource === 'company_pool' ? 'multiuser.executionSourceCompanyOpenAI'
            : item.executionSource === 'personal_api_key' ? 'multiuser.executionSourcePersonalKey' : 'multiuser.executionSourcePersonalCodex')}
        </option>)}
      </select>
      <Button className={styles.button} disabled={!enabled} aria-describedby={description} onClick={() => void perform('finalize')}>
        {t('studio.synthesis.finalize')}
      </Button>
      {conversationId && <Button className={styles.button} disabled={!enabled} aria-describedby={description} onClick={() => void perform('handoff')}>{t('studio.synthesis.handoff')}</Button>}
    </div>
    <span id={description} role="status" data-refusal={reason ?? undefined}>{busy ? t('common.loading') : reasonText}</span>
    {error && <span role="alert">{error}</span>}
    {savedResults.map((result) => <span key={result.id} role="status" data-synthesis-result={result.action} data-current={result.current}>
      {result.fileName}: {t(result.current ? 'studio.synthesis.saved' : 'studio.synthesis.stale')}
    </span>)}
    {receipt && state?.results[receipt.action]?.id !== receipt.id && <span role="status">{t('studio.synthesis.stale')}</span>}
    {receipt?.prompt && current && <textarea className={styles.prompt} readOnly aria-label={t('studio.synthesis.handoff')} value={receipt.prompt} />}
  </div>;
}
