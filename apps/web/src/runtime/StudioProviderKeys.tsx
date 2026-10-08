import { useEffect, useId, useState } from 'react';
import { Button, Input } from '@open-design/components';
import {
  STUDIO_PROVIDER_KEY_MODELS, type StudioProviderKeyProvider, type StudioProviderKeyResponse, type StudioProviderKeySummary, type StudioProviderKeysResponse,
} from '@open-design/contracts';
import { useT } from '../i18n';
import { studioFetch, studioRequestAvailable } from './studio-transport';
import { notifyStudioProviderKeysChanged } from './studio-research';
import styles from './StudioProviderKeys.module.css';

const PATH = '/api/multiuser/settings/provider-keys';

/**
 * One of the account's own provider keys (#62/#63). Write-only: the server
 * answers with "configured" and the last four characters, never the key, and
 * the input clears after every save. `openai` bills the account's own turns
 * and media (never a company-pool fallback); `tavily` bills its research.
 */
export function StudioProviderKeys({ provider = 'openai' }: { provider?: StudioProviderKeyProvider }) {
  const openai = provider === 'openai';
  // The OpenAI section keeps its original test ids; others are suffixed.
  const tid = (base: string) => openai ? base : `${base}-${provider}`;
  const t = useT();
  const keyId = useId();
  const modelId = useId();
  const listId = useId();
  const usable = studioRequestAvailable('GET', PATH);
  const [summary, setSummary] = useState<StudioProviderKeySummary | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);
  type StatusKey = 'studio.keys.saved' | 'studio.keys.removed' | 'studio.keys.tavilyRemoved' | 'studio.keys.invalid' | 'studio.keys.conflict' | 'studio.keys.error';
  const [status, setStatus] = useState<{ error: boolean; key: StatusKey } | null>(null);

  const load = async () => {
    try {
      const response = await studioFetch(PATH);
      if (!response.ok) return;
      const next = (await response.json() as StudioProviderKeysResponse).keys.find((key) => key.provider === provider) ?? null;
      setSummary(next); setModel(next?.model ?? '');
    } catch { /* the section stays in its last state */ }
  };
  useEffect(() => { if (usable) void load(); }, [usable, provider]);
  if (!usable) return null;

  const write = async (body: { apiKey?: string | null; model?: string }, done: 'studio.keys.saved' | 'studio.keys.removed' | 'studio.keys.tavilyRemoved') => {
    if (!summary || busy) return;
    setBusy(true);
    try {
      const response = await studioFetch(`${PATH}/${provider}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision: summary.revision, ...body }) });
      if (response.ok) {
        const saved = (await response.json() as StudioProviderKeyResponse).key;
        setSummary(saved); setModel(saved.model); setApiKey(''); setStatus({ error: false, key: done });
        notifyStudioProviderKeysChanged();
      } else if (response.status === 409) { setStatus({ error: true, key: 'studio.keys.conflict' }); await load(); }
      else setStatus({ error: true, key: response.status === 400 ? 'studio.keys.invalid' : 'studio.keys.error' });
    } catch { setStatus({ error: true, key: 'studio.keys.error' }); }
    finally { setBusy(false); }
  };
  const trimmedModel = openai ? model.trim() : '';
  const changed = Boolean(apiKey.trim()) || (summary !== null && trimmedModel !== '' && trimmedModel !== summary.model);

  return <section className={`settings-section ${styles.section}`} data-testid={tid('studio-provider-keys')}>
    <h3>{t(openai ? 'studio.keys.title' : 'studio.keys.tavilyTitle')}</h3>
    <p className="hint">{t(openai ? 'studio.keys.hint' : 'studio.keys.tavilyHint')}</p>
    <p className={styles.state} data-testid={tid('studio-provider-key-state')}>
      {summary?.configured ? t('studio.keys.statusSaved', { last4: summary.last4 ?? '' }) : t('studio.keys.statusNone')}
    </p>
    <form className={styles.form} onSubmit={(event) => {
      event.preventDefault();
      if (changed) void write({ ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}), ...(trimmedModel ? { model: trimmedModel } : {}) }, 'studio.keys.saved');
    }}>
      <label className={styles.field} htmlFor={keyId}>{t('studio.keys.apiKey')}</label>
      <Input id={keyId} type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="off"
        spellCheck={false} maxLength={4096} placeholder={summary?.configured ? `•••• ${summary.last4 ?? ''}` : openai ? 'sk-…' : 'tvly-…'} data-testid={tid('studio-provider-key-input')} />
      {openai ? <>
        <label className={styles.field} htmlFor={modelId}>{t('studio.keys.model')}</label>
        <Input id={modelId} value={model} onChange={(event) => setModel(event.target.value)} list={listId} autoComplete="off"
          spellCheck={false} maxLength={128} data-testid="studio-provider-key-model" />
        <datalist id={listId}>{STUDIO_PROVIDER_KEY_MODELS.map((name) => <option key={name} value={name} />)}</datalist>
      </> : null}
      <div className={styles.actions}>
        <Button type="submit" variant="primary" disabled={busy || !summary || !changed} data-testid={tid('studio-provider-key-save')}>{t('studio.keys.save')}</Button>
        {summary?.configured ? <Button type="button" variant="ghost" disabled={busy} data-testid={tid('studio-provider-key-remove')}
          onClick={() => void write({ apiKey: null }, openai ? 'studio.keys.removed' : 'studio.keys.tavilyRemoved')}>{t('studio.keys.remove')}</Button> : null}
      </div>
    </form>
    <p className={`${styles.status}${status?.error ? ` ${styles.error}` : ''}`} role="status" aria-live="polite">{status ? t(status.key) : ''}</p>
  </section>;
}
