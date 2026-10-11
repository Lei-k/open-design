import { useEffect, useRef, useState } from 'react';
import type { LibraryPairingStartResponse, StudioLibraryConnectionStatus } from '@open-design/contracts';
import { useT } from '../i18n';
import { useStudioCapabilities } from './studio-capabilities';
import { studioFetch } from './studio-transport';

/** Secrets and loaded metadata belong to the current session generation only. */
export function StudioLibrarySettings() {
  const studio = useStudioCapabilities(); const t = useT();
  const [connection, setConnection] = useState<StudioLibraryConnectionStatus | null>(null);
  const [pairing, setPairing] = useState<LibraryPairingStartResponse | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(false);
  const live = useRef(true);
  const current = () => live.current && studio.session?.snapshot().generation === studio.generation;
  const read = async () => {
    const response = await studioFetch('/api/library/connection'); if (!response.ok) throw new Error('refused');
    const result = await response.json() as StudioLibraryConnectionStatus; if (current()) setConnection(result);
  };
  useEffect(() => {
    live.current = true;
    const release = studio.session?.bindResource(() => { live.current = false; setPairing(null); setConnection(null); setBusy(false); setError(false); }, studio.generation);
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
  return <section className="settings-section" data-testid="studio-library-settings">
    <p>{t('studio.libraryHint')}</p>
    <button type="button" className="primary" data-testid="studio-library-pair" disabled={busy || !connection} onClick={() => void run('/api/library/pair', 'POST')}>{t('studio.libraryPair')}</button>
    {pairing && <p role="status"><code>{pairing.code}</code> · {t('studio.libraryExpires', { time: new Date(pairing.expiresAt).toLocaleTimeString() })}</p>}
    <p>{t('studio.libraryPairInstructions')}</p>
    {connection?.tokens.length === 0 && <p data-testid="studio-library-empty">{t('studio.libraryEmpty')}</p>}
    {connection?.tokens.map((token) => <div key={token.id}>
      <strong>{token.label}</strong> <span>{token.extensionOrigin}</span>
      <p>{t('studio.libraryLastUsed', { time: new Date(token.lastUsedAt).toLocaleString() })}</p>
      <button type="button" className="ghost" disabled={busy} data-testid={`studio-library-revoke-${token.id}`} onClick={() => void run(`/api/library/tokens/${encodeURIComponent(token.id)}`, 'DELETE')}>{t('studio.libraryRevoke')}</button>
    </div>)}
    {error && <p role="alert">{t('studio.libraryError')}</p>}
  </section>;
}
