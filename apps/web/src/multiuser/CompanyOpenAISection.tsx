import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '@open-design/components';
import type { CompanyOpenAIConfig, CompanyOpenAIConfigResponse, UpdateCompanyOpenAIConfigRequest } from '@open-design/contracts';
import { useT } from '../i18n';
import { CookieSession, RequestFailure } from './session';
import styles from './MultiUserApp.module.css';

/** Write-only credentials use the admin's current cookie generation. */
export function CompanyOpenAISection({ session, generation }: { session: CookieSession; generation: number }) {
  const t = useT();
  const [config, setConfig] = useState<CompanyOpenAIConfig | null>(null);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [revoke, setRevoke] = useState(false);
  const [confirmChange, setConfirmChange] = useState(false);
  const pendingChange = useRef<UpdateCompanyOpenAIConfigRequest | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const cancelChange = () => { pendingChange.current = null; setConfirmChange(false); };
  useEffect(() => {
    let active = true;
    setConfig(null); setError(null);
    const release = session.bindResource(() => {
      active = false; pendingChange.current = null; formRef.current?.reset();
      const key = formRef.current?.elements.namedItem('apiKey') as HTMLInputElement | null;
      if (key) key.value = '';
      setConfig(null); setRevoke(false); setConfirmChange(false);
    }, generation);
    void session.request<CompanyOpenAIConfigResponse>('/api/admin/pool/openai', undefined, generation)
      .then(({ provider }) => { if (active) setConfig(provider); })
      .catch((e) => { if (active && !(e instanceof DOMException && e.name === 'AbortError')) setError(t('multiuser.requestError')); });
    return () => { active = false; pendingChange.current = null; release(); };
  }, [session, generation, revision, t]);
  async function save(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (!config || busy) return;
    const form = event?.currentTarget;
    const fields = form ? new FormData(form) : null;
    const keyInput = form?.elements.namedItem('apiKey') as HTMLInputElement | null;
    const apiKey = String(fields?.get('apiKey') ?? '').trim();
    // Clear the DOM immediately; neither read responses nor saved UI state hold a key.
    if (keyInput) keyInput.value = '';
    const change: UpdateCompanyOpenAIConfigRequest = {
      revision: config.revision, model: fields ? String(fields.get('model')).trim() : config.model,
      capacity: fields ? Number(fields.get('capacity')) : config.capacity,
      enabled: fields ? fields.get('enabled') === 'on' : false,
      ...(fields ? apiKey ? { apiKey } : {} : { apiKey: null }),
    };
    if (fields && (config.enabled && !change.enabled || change.capacity < config.capacity
      || config.configured && (apiKey || change.model !== config.model))) {
      pendingChange.current = change; setConfirmChange(true); return;
    }
    await apply(change);
  }
  async function apply(change: UpdateCompanyOpenAIConfigRequest) {
    pendingChange.current = null; setConfirmChange(false);
    setBusy(true); setError(null); setSaved(false);
    try {
      const { provider } = await session.request<CompanyOpenAIConfigResponse>('/api/admin/pool/openai', { method: 'PUT', body: JSON.stringify(change) }, generation);
      setConfig(provider); setRevoke(false); setSaved(true);
      // Existing sessions learn that an execution source appeared or disappeared.
      void session.verify();
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) {
        if (e instanceof RequestFailure && e.status === 409) setConfig(null);
        setError(t(e instanceof RequestFailure && e.status === 409 ? 'multiuser.conflict' : 'multiuser.requestError'));
      }
    } finally { setBusy(false); }
  }
  return <section aria-label={t('multiuser.companyOpenAI')} data-testid="company-openai-settings">
    <h2>{t('multiuser.companyOpenAI')}</h2><p>{t('multiuser.companyOpenAIHelp')}</p>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {!config ? <Button onClick={() => setRevision((value) => value + 1)}>{t('multiuser.retry')}</Button> : <>
      <p>{t(config.configured ? 'multiuser.companyKeyConfigured' : 'multiuser.companyKeyMissing')}</p>
      <form ref={formRef} key={config.revision} className={styles.inlineForm} onSubmit={(event) => void save(event)}>
        <label>{t('multiuser.companyModel')}<input name="model" required maxLength={128} defaultValue={config.model} autoComplete="off" /></label>
        <label>{t('multiuser.companyCapacity')}<input name="capacity" type="number" min={0} max={16} required defaultValue={config.capacity} /></label>
        <label>{t('multiuser.companyEnabled')}<input name="enabled" type="checkbox" defaultChecked={config.enabled} /></label>
        <label>{t('multiuser.companyKey')}<input name="apiKey" type="password" autoComplete="new-password" maxLength={4096} /></label>
        <Button type="submit" variant="primary" disabled={busy || confirmChange}>{t(busy ? 'multiuser.saving' : 'common.save')}</Button>
      </form>
      {confirmChange && <section className={styles.confirm} aria-label={t('multiuser.confirmAction')}
        onKeyDown={(event) => { if (event.key === 'Escape') cancelChange(); }}>
        <h3>{t('multiuser.confirmAction')}</h3><p>{t('studio.admin.capacityWarning')}</p><p>{t('multiuser.companyOpenAIHelp')}</p>
        <Button autoFocus disabled={busy} onClick={() => { if (pendingChange.current) void apply(pendingChange.current); }}>{t('multiuser.confirm')}</Button>
        <Button disabled={busy} onClick={cancelChange}>{t('multiuser.cancel')}</Button>
      </section>}
      {config.configured && <Button disabled={busy} onClick={() => { cancelChange(); setRevoke(true); }}>{t('multiuser.companyRevokeKey')}</Button>}
      {revoke && <div className={styles.confirm} aria-label={t('multiuser.confirmAction')} onKeyDown={(event) => { if (event.key === 'Escape') setRevoke(false); }}><p>{t('multiuser.companyRevokeWarning')}</p><Button disabled={busy} onClick={() => void save()}>{t('multiuser.confirm')}</Button><Button disabled={busy} onClick={() => setRevoke(false)}>{t('multiuser.cancel')}</Button></div>}
    </>}
    {saved && <p role="status">{t('multiuser.saved')}</p>}
  </section>;
}
