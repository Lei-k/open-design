import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { Button, VisuallyHidden } from '@open-design/components';
import type { PersonalAccountStatus, PersonalAgentAccountsResponse, StudioProviderKeysResponse } from '@open-design/contracts';
import { useT } from '../i18n';
import type { Dict } from '../i18n/types';
import type { AgentModelChoice } from '../types';
import { useStudioCapabilities } from './studio-capabilities';
import { studioFetch, studioRequestAvailable } from './studio-transport';
import { subscribeStudioProviderKeysChanged } from './studio-research';
import { studioSourceOptions, type StudioSourceAgentId, type StudioSourceBlock, type StudioSourceOption } from './studio-source-options';
import { StudioCodexPickers } from './StudioExecutionSource';
import styles from './StudioComposerSource.module.css';

const KEYS = '/api/multiuser/settings/provider-keys';
const LABEL: Record<StudioSourceAgentId, keyof Dict> = {
  codex: 'multiuser.executionSourcePersonalCodex', openai: 'multiuser.executionSourceCompanyOpenAI', 'openai-byok': 'multiuser.executionSourcePersonalKey',
};
const REASON: Record<StudioSourceBlock, keyof Dict> = {
  'server-disabled': 'studio.source.serverDisabled', 'company-disabled': 'studio.source.companyDisabled',
  'codex-unlinked': 'studio.source.codexUnlinked', 'codex-reauth': 'studio.source.codexReauth', 'codex-disabled': 'studio.source.codexDisabled',
  'key-missing': 'studio.source.keyMissing',
};
const FIX: Partial<Record<StudioSourceBlock, keyof Dict>> = {
  'codex-unlinked': 'studio.source.linkCodex', 'codex-disabled': 'studio.source.linkCodex', 'codex-reauth': 'studio.source.reauthCodex',
  'key-missing': 'studio.source.addKey',
};

/** Account facts the source picker needs; `undefined` while unknown. */
function useStudioSourceFacts(needCodex: boolean, needKey: boolean) {
  const studio = useStudioCapabilities();
  const [facts, setFacts] = useState<{ codex?: PersonalAccountStatus | null; key?: boolean }>({});
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => { setFacts({}); }, [studio.session, studio.generation]);
  useEffect(() => {
    const session = studio.session;
    if (studio.hostServices || !session) return;
    const controller = new AbortController();
    // The same reads Settings → Agent accounts uses; failures stay unknown.
    if (needCodex) void session.request<PersonalAgentAccountsResponse>('/api/agent-accounts', { signal: controller.signal }, studio.generation)
      .then((body) => {
        if (controller.signal.aborted || !body?.codex || typeof body.codex !== 'object') return;
        setFacts((current) => ({ ...current, codex: body.codex.account?.status ?? null }));
      }).catch(() => {});
    if (needKey && studioRequestAvailable('GET', KEYS)) void studioFetch(KEYS, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return;
        const { keys } = await response.json() as StudioProviderKeysResponse;
        if (!controller.signal.aborted && Array.isArray(keys)) setFacts((current) => ({ ...current, key: keys.some((key) => key.provider === 'openai' && key.configured) }));
      }).catch(() => {});
    return () => controller.abort();
  }, [studio.session, studio.generation, studio.hostServices, needCodex, needKey, revision]);
  // Links and keys change in Settings (same page) or a provider tab (focus returns).
  useEffect(() => {
    const release = subscribeStudioProviderKeysChanged(refresh);
    window.addEventListener('focus', refresh);
    return () => { release(); window.removeEventListener('focus', refresh); };
  }, [refresh]);
  return { facts, refresh };
}

/**
 * The Studio Composer's execution-source picker (S74, #111). All three sources
 * are listed; one that cannot run now is disabled with its reason and, where
 * the account can fix it, an entry. A conversation's first turn pins its
 * source (native thread and billing), so a pinned conversation shows that
 * source as fixed and offers a new conversation on another source instead.
 */
export function StudioComposerSource({ agentId, pinned = false, mediaOnly = false, onChange, onNewConversation, onOpenSettings, modelChoice, onModelChange }: {
  agentId?: string | null;
  /** The conversation already ran on `agentId`; the daemon keeps it there. */
  pinned?: boolean;
  /** Media projects list only OpenAI sources; personal Codex has no media functions (#63). */
  mediaOnly?: boolean;
  onChange: (agentId: StudioSourceAgentId) => void;
  /** Absent when the actor cannot create a conversation in this project. */
  onNewConversation?: ((agentId: StudioSourceAgentId) => void) | undefined;
  onOpenSettings: (section: 'agentAccounts') => void;
  modelChoice?: AgentModelChoice | undefined;
  onModelChange?: ((choice: AgentModelChoice) => void) | undefined;
}) {
  const studio = useStudioCapabilities();
  const t = useT();
  const advertised = studio.capabilities?.executionSources ?? (studio.executionAgentId === 'codex'
    ? [{ source: 'personal_subscription' as const, agentId: 'codex' as const }] : []);
  const advertisedIds = new Set(advertised.map((choice) => choice.agentId));
  const { facts, refresh } = useStudioSourceFacts(advertisedIds.has('codex') && !mediaOnly, advertisedIds.has('openai-byok'));
  const options = studioSourceOptions({ advertised, mediaOnly, codexAccountStatus: facts.codex, openaiKeyConfigured: facts.key });
  const selected = (agentId ?? studio.executionAgentId ?? options.find((option) => option.available)?.agentId ?? options[0]?.agentId) as StudioSourceAgentId | undefined;
  const current = options.find((option) => option.agentId === selected);
  const label = (id: StudioSourceAgentId) => t(LABEL[id]);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({});
  const wrapRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const titleId = useId();
  const reasonId = useId();
  const radioName = useId();
  // Arrow keys move the radio selection (native behaviour) without closing the panel.
  const arrowRef = useRef(false);
  const close = (focusTrigger = true) => { setOpen(false); if (focusTrigger) triggerRef.current?.focus(); };

  useLayoutEffect(() => {
    if (!open) return;
    // Open upward inside the composer card (viewport margin as the floor), like the agent menu.
    const place = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const margin = 8;
      const shell = triggerRef.current?.closest('.composer-shell')?.getBoundingClientRect();
      const minLeft = Math.max(margin, shell?.left ?? margin);
      const maxRight = Math.min(window.innerWidth - margin, shell?.right ?? window.innerWidth - margin);
      const width = Math.min(340, Math.max(0, maxRight - minLeft));
      const left = Math.min(Math.max(rect.right - width, minLeft), maxRight - width);
      setPosition({ position: 'fixed', left, width, bottom: Math.max(margin, window.innerHeight - rect.top + margin),
        maxHeight: Math.max(160, rect.top - 2 * margin) });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    (panel?.querySelector<HTMLElement>('input:checked:not(:disabled)')
      ?? panel?.querySelector<HTMLElement>('input:not(:disabled), button:not(:disabled)') ?? panel)?.focus();
    const outside = (event: PointerEvent) => { if (!wrapRef.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  if (studio.hostServices) return null;
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { event.stopPropagation(); close(); }
    else if (event.key === 'Enter' && (event.target as HTMLElement).matches('input[type="radio"]')) { event.preventDefault(); close(); }
    else arrowRef.current = event.key.startsWith('Arrow');
  };
  const reason = (option: StudioSourceOption) => option.block ? <p id={`${reasonId}-${option.agentId}`} className={styles.reason}>{t(REASON[option.block])}</p> : null;
  const fix = (option: StudioSourceOption) => {
    const key = option.block ? FIX[option.block] : undefined;
    return key && option.fix === 'agent-accounts' ? <Button variant="ghost" className={styles.action}
      onClick={() => { close(false); onOpenSettings('agentAccounts'); }}>{t(key)}</Button> : null;
  };
  const currentLabel = selected ? label(selected) : t('multiuserRuns.source');
  const unavailable = current ? !current.available : false;
  const triggerLabel = t(pinned ? 'studio.source.triggerPinned' : unavailable ? 'studio.source.triggerUnavailable' : 'studio.source.trigger', { source: currentLabel });

  return <span className={styles.source} data-testid="studio-execution-source" ref={wrapRef}>
    <button ref={triggerRef} type="button" className={styles.trigger} aria-haspopup="dialog" aria-expanded={open}
      aria-controls={open ? panelId : undefined} aria-label={triggerLabel} title={triggerLabel}
      data-pinned={pinned || undefined} data-unavailable={unavailable || undefined}
      onClick={() => { if (!open) refresh(); setOpen(!open); }}>
      <span className={styles.triggerLabel}>{currentLabel}</span>
      {pinned ? <LockGlyph /> : null}
      {unavailable ? <span className={styles.warning} aria-hidden="true">!</span> : null}
      <ChevronGlyph />
    </button>
    {selected === 'codex' && onModelChange ? <StudioCodexPickers modelChoice={modelChoice} onModelChange={onModelChange} /> : null}
    {open ? <div ref={panelRef} id={panelId} role="dialog" aria-labelledby={titleId} tabIndex={-1} className={styles.panel}
      style={position} data-testid="studio-source-panel" onKeyDown={onKeyDown}>
      <h3 id={titleId} className={styles.title}>{t('multiuserRuns.source')}</h3>
      <p className={styles.hint}>{t(pinned ? 'studio.source.pinnedHint' : 'studio.source.chooseHint')}</p>
      {pinned ? <ul className={styles.list}>
        {options.map((option) => {
          const isCurrent = option.agentId === selected;
          return <li key={option.agentId} className={styles.row} data-source-agent={option.agentId} aria-current={isCurrent ? 'true' : undefined}>
            <span className={styles.name}>{label(option.agentId)}{isCurrent ? <span className={styles.badge}>{t('studio.source.current')}</span> : null}</span>
            {reason(option)}
            {!isCurrent && option.available && onNewConversation ? <Button variant="ghost" className={styles.action}
              aria-label={t('studio.source.newConversationWith', { source: label(option.agentId) })}
              onClick={() => { close(false); onNewConversation(option.agentId); }}>{t('studio.source.newConversation')}</Button> : null}
            {fix(option)}
          </li>;
        })}
      </ul> : <fieldset className={styles.list}>
        <legend><VisuallyHidden>{t('multiuserRuns.source')}</VisuallyHidden></legend>
        {options.map((option) => <div key={option.agentId} className={styles.row} data-source-agent={option.agentId}>
          <label className={styles.option}>
            <input type="radio" name={radioName} value={option.agentId} checked={option.agentId === selected} disabled={!option.available}
              aria-describedby={option.block ? `${reasonId}-${option.agentId}` : undefined}
              onChange={() => { onChange(option.agentId); if (!arrowRef.current) close(); arrowRef.current = false; }} />
            <span className={styles.name}>{label(option.agentId)}</span>
          </label>
          {reason(option)}
          {fix(option)}
        </div>)}
      </fieldset>}
    </div> : null}
  </span>;
}

function LockGlyph() {
  return <svg className={styles.glyph} width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <path fill="currentColor" d="M5 7V5a3 3 0 0 1 6 0v2h.5A1.5 1.5 0 0 1 13 8.5v5a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 13.5v-5A1.5 1.5 0 0 1 4.5 7H5Zm1.5 0h3V5a1.5 1.5 0 0 0-3 0v2Z" />
  </svg>;
}

function ChevronGlyph() {
  return <svg className={styles.glyph} width="10" height="10" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <path fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="m4 10 4-4 4 4" />
  </svg>;
}
