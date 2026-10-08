import { useEffect, useId, useState } from 'react';
import { Button, Input } from '@open-design/components';
import {
  STUDIO_PROVIDER_KEY_MODELS, type StudioProviderKeyResponse, type StudioProviderKeySummary, type StudioProviderKeysResponse,
} from '@open-design/contracts';
import { useT } from '../i18n';
import { studioFetch, studioRequestAvailable } from './studio-transport';
import styles from './StudioProviderKeys.module.css';

const PATH = '/api/multiuser/settings/provider-keys';

/**
 * The account's own OpenAI API key (#62/#63). Write-only: the server answers
 * with "configured" and the last four characters, never the key, and the input
 * clears after every save. Turns on this source bill the account's OpenAI
 * account; the server never falls back to the company pool.
 */
export function StudioProviderKeys() {
  const t = useT();
  const keyId = useId();
  const modelId = useId();
  const listId = useId();
  const usable = studioRequestAvailable('GET', PATH);
  const [summary, setSummary] = useState<StudioProviderKeySummary | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ error: boolean; key: 'studio.keys.saved' | 'studio.keys.removed' | 'studio.keys.invalid' | 'studio.keys.conflict' | 'studio.keys.error' } | null>(null);

  const load = async () => {
    try {
      const response = await studioFetch(PATH);
      if (!response.ok) return;
      const next = (await response.json() as StudioProviderKeysResponse).keys.find((key) => key.provider === 'openai') ?? null;
      setSummary(next); setModel(next?.model ?? '');
    } catch { /* the section stays in its last state */ }
  };
  useEffect(() => { if (usable) void load(); }, [usable]);
  if (!usable) return null;

  const write = async (body: { apiKey?: string | null; model?: string }, done: 'studio.keys.saved' | 'studio.keys.removed') => {
    if (!summary || busy) return;
    setBusy(true);
    try {
      const response = await studioFetch(`${PATH}/openai`, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision: summary.revision, ...body }) });
      if (response.ok) {
        const saved = (await response.json() as StudioProviderKeyResponse).key;
        setSummary(saved); setModel(saved.model); setApiKey(''); setStatus({ error: false, key: done });
      } else if (response.status === 409) { setStatus({ error: true, key: 'studio.keys.conflict' }); await load(); }
      else setStatus({ error: true, key: response.status === 400 ? 'studio.keys.invalid' : 'studio.keys.error' });
    } catch { setStatus({ error: true, key: 'studio.keys.error' }); }
    finally { setBusy(false); }
  };
  const trimmedModel = model.trim();
  const changed = Boolean(apiKey.trim()) || (summary !== null && trimmedModel !== '' && trimmedModel !== summary.model);

  return <section className={`settings-section ${styles.section}`} data-testid="studio-provider-keys">
    <h3>{t('studio.keys.title')}</h3>
    <p className="hint">{t('studio.keys.hint')}</p>
    <p className={styles.state} data-testid="studio-provider-key-state">
      {summary?.configured ? t('studio.keys.statusSaved', { last4: summary.last4 ?? '' }) : t('studio.keys.statusNone')}
    </p>
    <form className={styles.form} onSubmit={(event) => {
      event.preventDefault();
      if (changed) void write({ ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}), ...(trimmedModel ? { model: trimmedModel } : {}) }, 'studio.keys.saved');
    }}>
      <label className={styles.field} htmlFor={keyId}>{t('studio.keys.apiKey')}</label>
      <Input id={keyId} type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="off"
        spellCheck={false} maxLength={4096} placeholder={summary?.configured ? `•••• ${summary.last4 ?? ''}` : 'sk-…'} data-testid="studio-provider-key-input" />
      <label className={styles.field} htmlFor={modelId}>{t('studio.keys.model')}</label>
      <Input id={modelId} value={model} onChange={(event) => setModel(event.target.value)} list={listId} autoComplete="off"
        spellCheck={false} maxLength={128} data-testid="studio-provider-key-model" />
      <datalist id={listId}>{STUDIO_PROVIDER_KEY_MODELS.map((name) => <option key={name} value={name} />)}</datalist>
      <div className={styles.actions}>
        <Button type="submit" variant="primary" disabled={busy || !summary || !changed} data-testid="studio-provider-key-save">{t('studio.keys.save')}</Button>
        {summary?.configured ? <Button type="button" variant="ghost" disabled={busy} data-testid="studio-provider-key-remove"
          onClick={() => void write({ apiKey: null }, 'studio.keys.removed')}>{t('studio.keys.remove')}</Button> : null}
      </div>
    </form>
    <p className={`${styles.status}${status?.error ? ` ${styles.error}` : ''}`} role="status" aria-live="polite">{status ? t(status.key) : ''}</p>
  </section>;
}
