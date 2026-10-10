import { useCallback, useEffect, useState } from 'react';
import { Button } from '@open-design/components';
import type { StudioComposioConfigResponse, UpdateStudioComposioConfigRequest } from '@open-design/contracts';
import { useT } from '../i18n';
import { ConnectorsBrowser } from '../components/ConnectorsBrowser';
import { studioFetch } from './studio-transport';
import styles from './StudioConnectors.module.css';

type Load = { status: 'loading' } | { status: 'error' } | { status: 'ready'; config: StudioComposioConfigResponse };

/**
 * Settings → Connectors for Web accounts (#62, S58). Administrators set, rotate
 * or clear the one company Composio key (write-only: only the last four
 * characters ever come back). Every account connects its own apps through
 * the shared ConnectorsBrowser, whose standard `/api/connectors/*` requests
 * the daemon answers for the signed-in account only. Without a key the
 * section explains who can fix it and shows no dead controls.
 */
export function StudioConnectors() {
  const t = useT();
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<'saved' | 'conflict' | 'error' | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [nonce, setNonce] = useState(0);

  const read = useCallback(async () => {
    try {
      const response = await studioFetch('/api/connectors/composio/config');
      if (!response.ok) throw new Error('unavailable');
      setLoad({ status: 'ready', config: await response.json() as StudioComposioConfigResponse });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) setLoad({ status: 'error' });
    }
  }, []);
  useEffect(() => { void read(); }, [read]);

  const write = async (apiKey: string | null) => {
    if (load.status !== 'ready' || busy) return;
    setBusy(true); setNotice(null);
    try {
      const body: UpdateStudioComposioConfigRequest = { revision: load.config.revision, apiKey };
      const response = await studioFetch('/api/connectors/composio/config', { method: 'PUT',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      // The draft never survives a submit, whatever the outcome.
      setDraft('');
      if (response.status === 409) { setNotice('conflict'); await read(); return; }
      if (!response.ok) { setNotice('error'); return; }
      setLoad({ status: 'ready', config: await response.json() as StudioComposioConfigResponse });
      setConfirmClear(false); setNotice('saved'); setNonce((value) => value + 1);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) setNotice('error');
    } finally { setBusy(false); }
  };

  if (load.status === 'loading') return <section className="settings-section" data-testid="studio-connectors" aria-busy="true" />;
  if (load.status === 'error') {
    return <section className="settings-section" data-testid="studio-connectors">
      <p role="alert" data-testid="studio-connectors-error">{t('studio.connectors.error')}</p>
      <Button variant="ghost" onClick={() => { setLoad({ status: 'loading' }); void read(); }}>{t('studio.settingsReload')}</Button>
    </section>;
  }
  const { config } = load;
  return <section className="settings-section settings-section-connectors" data-testid="studio-connectors">
    {config.canManage && <div className={styles.key} data-testid="studio-connectors-key">
      <div className={styles.keyHead}>
        <h3>{t('studio.connectors.keyTitle')}</h3>
        {config.configured && <span className="field-status-badge" data-testid="studio-connectors-key-saved">
          {t('studio.connectors.keySaved', { tail: config.apiKeyTail })}</span>}
      </div>
      <p className="hint">{t('studio.connectors.keyHint')}</p>
      <form className={styles.keyRow} onSubmit={(event) => { event.preventDefault(); if (draft.trim().length >= 8) void write(draft.trim()); }}>
        <input type="password" autoComplete="off" spellCheck={false} aria-label={t('studio.connectors.keyTitle')} data-testid="studio-connectors-key-input"
          placeholder={t('studio.connectors.keyPlaceholder')} value={draft} disabled={busy} onChange={(event) => setDraft(event.target.value)} />
        <Button type="submit" variant="primary" data-testid="studio-connectors-key-save" disabled={busy || draft.trim().length < 8}>
          {t('studio.connectors.save')}</Button>
        {config.configured && <Button variant="ghost" data-testid="studio-connectors-key-clear" disabled={busy}
          onClick={() => setConfirmClear(true)}>{t('studio.connectors.clear')}</Button>}
      </form>
      {config.configured && <p className="hint">{t('studio.connectors.rotateNote')}</p>}
      {confirmClear && <div role="alertdialog" aria-modal="false" aria-labelledby="studio-connectors-clear" className={styles.confirm} data-testid="studio-connectors-clear-confirm">
        <p id="studio-connectors-clear">{t('studio.connectors.clearConfirm')}</p>
        <Button variant="ghost" onClick={() => setConfirmClear(false)}>{t('common.cancel')}</Button>
        <Button variant="primary" data-testid="studio-connectors-clear-commit" disabled={busy} onClick={() => void write(null)}>{t('studio.connectors.clear')}</Button>
      </div>}
      {notice && <p role="status" data-testid="studio-connectors-notice">{t(notice === 'saved' ? 'studio.connectors.saved'
        : notice === 'conflict' ? 'studio.connectors.conflict' : 'studio.connectors.error')}</p>}
    </div>}
    {!config.configured && <p role="status" className={styles.unavailable} data-testid="studio-connectors-unavailable">
      {t(config.canManage ? 'studio.connectors.unavailableAdmin' : 'studio.connectors.unavailableMember')}</p>}
    {config.configured && <>
      <p className="hint" data-testid="studio-connectors-not-in-runs">{t('studio.connectors.notInRuns')}</p>
      <ConnectorsBrowser composioConfigured catalogRefreshKey={`studio:${config.credentialRevision}:${nonce}`} />
    </>}
  </section>;
}
