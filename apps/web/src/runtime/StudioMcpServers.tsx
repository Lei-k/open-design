import { useCallback, useEffect, useState } from 'react';
import { Button } from '@open-design/components';
import type {
  CreateStudioMcpServerRequest, StudioMcpAuthMode, StudioMcpOAuthStartResponse, StudioMcpServer, StudioMcpServersResponse, StudioMcpTestResponse,
  StudioMcpTransport,
} from '@open-design/contracts';
import { useT } from '../i18n';
import { studioFetch } from './studio-transport';
import styles from './StudioMcpServers.module.css';

type Load = { status: 'loading' } | { status: 'error' } | { status: 'ready'; data: StudioMcpServersResponse };
type Notice = 'saved' | 'error' | 'errorOutbound' | 'errorAuthority' | 'errorLimit' | 'errorConflict' | 'errorProvider' | 'errorInvalid';
interface HeaderDraft { key: number; name: string; value: string }

const NOTICE_FOR_CODE: Record<string, Notice> = {
  MULTIUSER_MCP_OUTBOUND_REFUSED: 'errorOutbound', MULTIUSER_MCP_AUTHORITY_CHANGED: 'errorAuthority', MULTIUSER_MCP_LIMIT_REACHED: 'errorLimit',
  CONFLICT: 'errorConflict', MULTIUSER_MCP_PROVIDER_FAILED: 'errorProvider', VALIDATION_FAILED: 'errorInvalid', BAD_REQUEST: 'errorInvalid',
};
type DictKey = Parameters<ReturnType<typeof useT>>[0];
const NOTICE_KEYS: Record<Notice, DictKey> = {
  saved: 'studio.mcp.saved', error: 'studio.mcp.error', errorOutbound: 'studio.mcp.errorOutbound', errorAuthority: 'studio.mcp.errorAuthority',
  errorLimit: 'studio.mcp.errorLimit', errorConflict: 'studio.mcp.errorConflict', errorProvider: 'studio.mcp.errorProvider', errorInvalid: 'studio.mcp.errorInvalid',
};
let nextHeaderKey = 1;
const emptyHeader = (): HeaderDraft => ({ key: nextHeaderKey++, name: '', value: '' });

/**
 * Settings → MCP servers for Web accounts (#62, S60; owner decision 2A). Each
 * account adds its own REMOTE servers (streamable HTTP or SSE) with optional
 * static headers and OAuth. Header values are write-only: inputs are cleared
 * on every submit and the list shows only header names (and a long value's
 * last four characters). stdio servers are not offered; the server's reason is
 * shown instead. Servers are configurable here but not yet usable in runs.
 */
export function StudioMcpServers() {
  const t = useT();
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [tests, setTests] = useState<Record<string, StudioMcpTestResponse['result']>>({});
  const [draft, setDraft] = useState({ id: '', url: '', transport: 'http' as StudioMcpTransport, authMode: 'none' as StudioMcpAuthMode });
  const [headers, setHeaders] = useState<HeaderDraft[]>([]);

  const read = useCallback(async () => {
    try {
      const response = await studioFetch('/api/mcp/servers');
      if (!response.ok) throw new Error('unavailable');
      setLoad({ status: 'ready', data: await response.json() as StudioMcpServersResponse });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) setLoad({ status: 'error' });
    }
  }, []);
  useEffect(() => { void read(); }, [read]);
  // The OAuth popup posts only `{ type, serverId }` to this origin when it completes.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || (event.data as { type?: unknown } | null)?.type !== 'open-design:mcp-oauth') return;
      void read();
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [read]);

  const failed = async (response: Response) => {
    let code = '';
    try { code = String(((await response.json()) as { error?: { code?: string } }).error?.code ?? ''); } catch { /* fixed notice */ }
    setNotice(NOTICE_FOR_CODE[code] ?? 'error');
  };
  const run = async (key: string, action: () => Promise<Response>, after?: (response: Response) => Promise<void>) => {
    if (busy) return;
    setBusy(key); setNotice(null);
    try {
      const response = await action();
      if (!response.ok) { await failed(response); if (response.status === 409) await read(); return; }
      await after?.(response);
      await read(); window.dispatchEvent(new Event('studio-mcp-changed'));
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) setNotice('error');
    } finally { setBusy(null); }
  };
  const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  const add = () => {
    const values = Object.fromEntries(headers.filter((header) => header.name.trim() && header.value).map((header) => [header.name.trim(), header.value]));
    const body: CreateStudioMcpServerRequest = { id: draft.id.trim(), url: draft.url.trim(), transport: draft.transport, authMode: draft.authMode,
      ...(Object.keys(values).length ? { headers: values } : {}) };
    // Header values never outlive the submit, whatever the outcome.
    setHeaders([]);
    void run('add', () => studioFetch('/api/multiuser/mcp/servers', json('POST', body)), async () => {
      setDraft({ id: '', url: '', transport: 'http', authMode: 'none' }); setNotice('saved');
    });
  };
  const test = (server: StudioMcpServer) => run(`test:${server.id}`, () => studioFetch(`/api/multiuser/mcp/servers/${server.id}/test`, json('POST', {})),
    async (response) => {
      const result = (await response.json() as StudioMcpTestResponse).result;
      setTests((current) => ({ ...current, [server.id]: result }));
    });
  const toggle = (server: StudioMcpServer) => run(`toggle:${server.id}`, () => studioFetch(`/api/multiuser/mcp/servers/${server.id}`,
    json('PATCH', { revision: server.revision, enabled: !server.enabled })));
  const remove = (server: StudioMcpServer) => run(`delete:${server.id}`, () => studioFetch(`/api/multiuser/mcp/servers/${server.id}`, { method: 'DELETE' }));
  const connect = (server: StudioMcpServer) => run(`oauth:${server.id}`, () => studioFetch('/api/mcp/oauth/start', json('POST', { serverId: server.id })),
    async (response) => {
      const started = await response.json() as StudioMcpOAuthStartResponse;
      // A new tab: the daemon never opens a host browser for a Web account.
      window.open(started.authorizeUrl, '_blank', 'noopener');
    });
  const disconnect = (server: StudioMcpServer) => run(`oauth:${server.id}`, () => studioFetch('/api/mcp/oauth/disconnect', json('POST', { serverId: server.id })));
  const refresh = (server: StudioMcpServer) => run(`oauth:${server.id}`, () => studioFetch('/api/multiuser/mcp/oauth/refresh', json('POST', { serverId: server.id })));

  if (load.status === 'loading') return <section className="settings-section" data-testid="studio-mcp" aria-busy="true" />;
  if (load.status === 'error') {
    return <section className="settings-section" data-testid="studio-mcp">
      <p role="alert" data-testid="studio-mcp-error">{t('studio.mcp.error')}</p>
      <Button variant="ghost" onClick={() => { setLoad({ status: 'loading' }); void read(); }}>{t('studio.settingsReload')}</Button>
    </section>;
  }
  const { data } = load;
  const full = data.servers.length >= data.limits.maxServers;
  const canAdd = !busy && !full && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(draft.id.trim()) && draft.url.trim().length > 0;
  return <section className="settings-section" data-testid="studio-mcp">
    <p className="hint">{t('studio.mcp.intro')}</p>
    <p role="note" className={styles.note} data-testid="studio-mcp-stdio-unavailable">{t('studio.mcp.stdioUnavailable')}</p>
    <p className="hint" data-testid="studio-mcp-run-available">{t('studio.mcp.runAvailable')}</p>
    {notice && <p role="status" data-testid="studio-mcp-notice">{t(NOTICE_KEYS[notice])}</p>}
    {data.servers.length === 0
      ? <p className={styles.empty} data-testid="studio-mcp-empty">{t('studio.mcp.empty')}</p>
      : <ul className={styles.list} data-testid="studio-mcp-list">
        {data.servers.map((server) => {
          const result = tests[server.id];
          return <li key={server.id} className={styles.row} data-testid={`studio-mcp-server-${server.id}`}>
            <div className={styles.rowHead}>
              <strong>{server.label ?? server.id}</strong>
              <span className="field-status-badge">{server.transport === 'sse' ? t('studio.mcp.transportSse') : t('studio.mcp.transportHttp')}</span>
              {!server.enabled && <span className="field-status-badge" data-testid={`studio-mcp-disabled-${server.id}`}>{t('studio.mcp.disabled')}</span>}
              {server.authMode === 'oauth' && <span className="field-status-badge" data-testid={`studio-mcp-oauth-${server.id}`}>
                {t(server.oauth.status === 'connected' ? 'studio.mcp.oauthConnected' : server.oauth.status === 'expired' ? 'studio.mcp.oauthExpired' : 'studio.mcp.oauthNeeded')}</span>}
            </div>
            <code className={styles.url}>{server.url}</code>
            {server.headers.length > 0 && <ul className={styles.headers}>
              {server.headers.map((header) => <li key={header.name}>{header.tail
                ? t('studio.mcp.headerSavedTail', { name: header.name, tail: header.tail })
                : t('studio.mcp.headerSaved', { name: header.name })}</li>)}
            </ul>}
            {result && <p role="status" data-testid={`studio-mcp-test-${server.id}`}>
              {result.ok ? t('studio.mcp.testOk') : t('studio.mcp.testFailed', { code: result.code ?? 'failed' })}</p>}
            <div className={styles.actions}>
              <Button variant="ghost" disabled={!!busy || !server.enabled} onClick={() => void test(server)} data-testid={`studio-mcp-test-button-${server.id}`}>
                {t('studio.mcp.test')}</Button>
              {server.authMode === 'oauth' && server.enabled && (server.oauth.status === 'connected'
                ? <>
                  <Button variant="ghost" disabled={!!busy} onClick={() => void refresh(server)}>{t('studio.mcp.refresh')}</Button>
                  <Button variant="ghost" disabled={!!busy} onClick={() => void disconnect(server)} data-testid={`studio-mcp-disconnect-${server.id}`}>{t('studio.mcp.disconnect')}</Button>
                </>
                : <Button variant="primary" disabled={!!busy} onClick={() => void connect(server)} data-testid={`studio-mcp-connect-${server.id}`}>{t('studio.mcp.connect')}</Button>)}
              <Button variant="ghost" disabled={!!busy} onClick={() => void toggle(server)}>{t(server.enabled ? 'studio.mcp.disable' : 'studio.mcp.enable')}</Button>
              <Button variant="ghost" disabled={!!busy} onClick={() => void remove(server)} data-testid={`studio-mcp-delete-${server.id}`}>{t('studio.mcp.delete')}</Button>
            </div>
          </li>;
        })}
      </ul>}
    {!full && <form className={styles.form} data-testid="studio-mcp-add" onSubmit={(event) => { event.preventDefault(); if (canAdd) add(); }}>
      <h3>{t('studio.mcp.addTitle')}</h3>
      <label>{t('studio.mcp.id')}
        <input value={draft.id} spellCheck={false} autoComplete="off" data-testid="studio-mcp-add-id" maxLength={64}
          onChange={(event) => setDraft({ ...draft, id: event.target.value })} /></label>
      <label>{t('studio.mcp.url')}
        <input type="url" value={draft.url} spellCheck={false} autoComplete="off" data-testid="studio-mcp-add-url" maxLength={data.limits.maxUrlLength}
          placeholder="https://" onChange={(event) => setDraft({ ...draft, url: event.target.value })} /></label>
      <label>{t('studio.mcp.transport')}
        <select value={draft.transport} data-testid="studio-mcp-add-transport" onChange={(event) => setDraft({ ...draft, transport: event.target.value as StudioMcpTransport })}>
          <option value="http">{t('studio.mcp.transportHttp')}</option>
          <option value="sse">{t('studio.mcp.transportSse')}</option>
        </select></label>
      <label>{t('studio.mcp.auth')}
        <select value={draft.authMode} data-testid="studio-mcp-add-auth" onChange={(event) => setDraft({ ...draft, authMode: event.target.value as StudioMcpAuthMode })}>
          <option value="none">{t('studio.mcp.authNone')}</option>
          <option value="oauth">{t('studio.mcp.authOAuth')}</option>
        </select></label>
      {headers.map((header, index) => <div key={header.key} className={styles.headerRow}>
        <input aria-label={t('studio.mcp.headerName')} placeholder={t('studio.mcp.headerName')} value={header.name} spellCheck={false} autoComplete="off"
          data-testid={`studio-mcp-header-name-${index}`} onChange={(event) => setHeaders(headers.map((item) => item.key === header.key ? { ...item, name: event.target.value } : item))} />
        <input type="password" aria-label={t('studio.mcp.headerValue')} placeholder={t('studio.mcp.headerValue')} value={header.value} autoComplete="new-password"
          data-testid={`studio-mcp-header-value-${index}`} onChange={(event) => setHeaders(headers.map((item) => item.key === header.key ? { ...item, value: event.target.value } : item))} />
      </div>)}
      <div className={styles.actions}>
        {headers.length < data.limits.maxHeaders && <Button variant="ghost" type="button" data-testid="studio-mcp-add-header"
          onClick={() => setHeaders([...headers, emptyHeader()])}>{t('studio.mcp.addHeader')}</Button>}
        <Button variant="primary" type="submit" disabled={!canAdd} data-testid="studio-mcp-add-submit">{t('studio.mcp.add')}</Button>
      </div>
    </form>}
  </section>;
}
