'use client';

import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import { Button } from '@open-design/components';
import { useT } from '../../src/i18n';
import { MultiUserApp } from '../../src/multiuser/MultiUserApp';
import styles from '../../src/multiuser/MultiUserApp.module.css';
import { recordBootVersion } from '../../src/runtime/studio-boot-version';

// Neither single-user modules nor their analytics/workspace effects load until
// a fresh, valid version response has established that boundary.
const SingleUserApp = dynamic(() => import('../../src/multiuser/SingleUserApp').then((m) => m.SingleUserApp), { ssr: false });

export function ClientApp() {
  const t = useT();
  const [mode, setMode] = useState<'initial' | 'loading' | 'error' | 'single' | 'multi'>('initial');
  const [attempt, setAttempt] = useState(0);
  const [setupToken, setSetupToken] = useState<string | null>(null);
  useEffect(() => {
    const consume = (navigation = false) => {
      if (window.location.pathname.replace(/\/$/, '') !== '/setup') return;
      const fragment = window.location.hash.slice(1);
      window.history.replaceState(null, '', '/setup');
      if (navigation || fragment) setSetupToken(/^[A-Za-z0-9_-]{43}$/.test(fragment) ? fragment : null);
    };
    consume();
    const hide = () => flushSync(() => setSetupToken(null));
    const onHashChange = () => consume(true);
    window.addEventListener('hashchange', onHashChange);
    window.addEventListener('pagehide', hide);
    return () => { window.removeEventListener('hashchange', onHashChange); window.removeEventListener('pagehide', hide); };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    const backoff = [250, 750, 1500];
    setMode('loading');
    async function probe(failures = 0) {
      let transient = true;
      try {
        const response = await fetch('/api/version', { credentials: 'omit', cache: 'no-store', signal: controller.signal });
        transient = response.status >= 500;
        if (!response.ok) throw new Error('Version unavailable');
        transient = false;
        const body = await response.json();
        if (controller.signal.aborted) return;
        const version = body?.version;
        if (!version || typeof version.version !== 'string' || !version.version) throw new Error('Invalid version');
        recordBootVersion(version);
        const capabilities = version.capabilities;
        if (capabilities !== undefined && (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities))) throw new Error('Invalid capabilities');
        const multi = capabilities?.multiUser;
        if (multi !== undefined && multi !== true) throw new Error('Invalid capability');
        setMode(multi === true ? 'multi' : 'single');
      } catch {
        if (controller.signal.aborted) return;
        if (transient && failures < backoff.length) retry = setTimeout(() => void probe(failures + 1), backoff[failures]);
        else setMode('error');
      }
    }
    void probe();
    return () => { controller.abort(); clearTimeout(retry); };
  }, [attempt]);
  if (mode === 'multi') return <MultiUserApp setupToken={setupToken} clearSetupToken={() => setSetupToken(null)} />;
  if (mode === 'single') return <SingleUserApp />;
  return <main className={styles.auth}><h1>OpenDesign</h1><p role="status">{mode === 'initial' ? 'Loading OpenDesign…' : t(mode === 'error' ? 'multiuser.connectionError' : 'multiuser.checking')}</p>
    {mode === 'error' && <Button onClick={() => setAttempt((n) => n + 1)}>{t('multiuser.retry')}</Button>}</main>;
}
