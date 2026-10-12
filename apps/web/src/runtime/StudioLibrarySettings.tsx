import { useEffect, useRef, useState } from 'react';
import { Button } from '@open-design/components';
import type { LibraryPairingStartResponse, StudioLibraryConnectionStatus } from '@open-design/contracts';
import { useT } from '../i18n';
import { useStudioCapabilities } from './studio-capabilities';
import { studioFetch } from './studio-transport';
import { copyToClipboard } from '../lib/copy-to-clipboard';
import styles from './StudioLibrarySettings.module.css';

/** Secrets and loaded metadata belong to the current session generation only. */
export function StudioLibrarySettings() {
  const studio = useStudioCapabilities(); const t = useT();
  const [connection, setConnection] = useState<StudioLibraryConnectionStatus | null>(null);
  const [pairing, setPairing] = useState<LibraryPairingStartResponse | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(false);
  const [origin, setOrigin] = useState('');
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const live = useRef(true);
  const current = () => live.current && studio.session?.snapshot().generation === studio.generation;
  useEffect(() => { setOrigin(window.location.origin); }, []);
  const copyOrigin = async () => {
    const copied = await copyToClipboard(origin);
    if (current()) setCopyState(copied ? 'copied' : 'failed');
  };
  const read = async () => {
    const response = await studioFetch('/api/library/connection'); if (!response.ok) throw new Error('refused');
    const result = await response.json() as StudioLibraryConnectionStatus; if (current()) setConnection(result);
  };
  useEffect(() => {
    live.current = true;
    const release = studio.session?.bindResource(() => { live.current = false; setPairing(null); setConnection(null); setBusy(false); setError(false); setCopyState('idle'); }, studio.generation);
    void read().catch(() => { if (current()) setError(true); });
    return () => { live.current = false; release?.(); };
  }, [studio.session, studio.generation]);
  useEffect(() => {
    if (!pairing) return;
    const timer = window.setTimeout(() => setPairing(null), Math.max(0, pairing.expiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [pairing]);
  const run = async (path: string, method: 'POST' | 'DELETE') => {
    setBusy(true); setError(false); setPairing(null);
    try {
      const response = await studioFetch(path, { method, ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: '{}' } : {}) });
      if (!response.ok) throw new Error('refused');
      if (method === 'POST') { const value = await response.json() as LibraryPairingStartResponse; if (current()) setPairing(value); }
      await read();
    } catch { if (current()) setError(true); }
    finally { if (current()) setBusy(false); }
  };
  return <section className={`settings-section settings-section-card ${styles.root}`} data-testid="studio-library-settings" aria-labelledby="studio-library-pair-title">
    <h2 id="studio-library-pair-title" className={styles.heading}>{t('studio.libraryPairTitle')}</h2>
    <div className={styles.urlField}>
      <label htmlFor="studio-library-url">{t('studio.libraryStudioUrl')}</label>
      <div className={styles.urlRow}>
        <input id="studio-library-url" data-testid="studio-library-url" value={origin} readOnly spellCheck={false} />
        <Button variant="secondary" disabled={!origin} onClick={() => void copyOrigin()}>{t('studio.libraryCopyUrl')}</Button>
      </div>
      {copyState !== 'idle' && <p role="status" className={styles.note}>{t(copyState === 'copied' ? 'studio.libraryUrlCopied' : 'studio.libraryUrlCopyFailed')}</p>}
    </div>
    <p className={styles.note}>{t('studio.libraryPairInstructions')}</p>
    <div className={styles.actions}>
      <Button variant="primary" data-testid="studio-library-pair" disabled={busy || !connection} onClick={() => void run('/api/library/pair', 'POST')}>{t('studio.libraryPair')}</Button>
    </div>
    {pairing && <p role="status" data-testid="studio-library-code" className={styles.code}><code>{pairing.code}</code> · {t('studio.libraryExpires', { time: new Date(pairing.expiresAt).toLocaleTimeString() })}</p>}
    <div className={styles.tokens}>
      <h3 className={styles.tokenHeading}>{t('studio.libraryPairedExtensions')}</h3>
      {connection?.tokens.length === 0 && <p className={styles.note} data-testid="studio-library-empty">{t('studio.libraryEmpty')}</p>}
      {connection && connection.tokens.length > 0 && <ul className={styles.tokenList}>{connection.tokens.map((token) => <li key={token.id} className={styles.token}>
        <div className={styles.metadata}>
          <strong>{token.label}</strong> <span className={styles.extensionOrigin}>{token.extensionOrigin}</span>
          <p>{t('studio.libraryLastUsed', { time: new Date(token.lastUsedAt).toLocaleString() })}</p>
        </div>
        <Button variant="secondary" disabled={busy} data-testid={`studio-library-revoke-${token.id}`} aria-label={t('studio.libraryRevokeLabel', { label: token.label })}
          onClick={() => void run(`/api/library/tokens/${encodeURIComponent(token.id)}`, 'DELETE')}>{t('studio.libraryRevoke')}</Button>
      </li>)}</ul>}
    </div>
    {error && <p role="alert">{t('studio.libraryError')}</p>}
  </section>;
}
