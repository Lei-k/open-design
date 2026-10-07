import { AgentAccountsPage } from '../multiuser/AgentAccountsPage';
import { useEffect, useState } from 'react';
import type { StudioSettingsResponse } from '@open-design/contracts';
import { useT } from '../i18n';
import { SkillsSection } from '../components/SkillsSection';
import { MemorySection } from '../components/MemorySection';
import { CustomInstructionsSection } from '../components/CustomInstructionsSection';
import { studioFetch, studioRequestAvailable } from './studio-transport';
import type { AppConfig } from '../types';
import { useStudioCapabilities, StudioUnavailable } from './studio-capabilities';

export function StudioAccountSettings({ initial, onSkillsChanged }: { initial: AppConfig; onSkillsChanged?: (id?: string) => void }) {
  const studio = useStudioCapabilities();
  const t = useT();
  const [config, setConfig] = useState(initial);
  const [settings, setSettings] = useState<StudioSettingsResponse | null>(null);
  const [instructions, setInstructions] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<'saved' | 'error' | 'conflict' | null>(null);
  const usable = studioRequestAvailable('GET', '/api/app-config');
  const load = async () => {
    setBusy(true);
    try {
      const response = await studioFetch('/api/app-config');
      if (!response.ok) throw new Error('unavailable');
      const data = await response.json() as StudioSettingsResponse;
      setSettings(data); setInstructions(data.config.customInstructions); setStatus(null);
    } catch (error) { if (!(error instanceof DOMException && error.name === 'AbortError')) setStatus('error'); }
    finally { setBusy(false); }
  };
  useEffect(() => { if (usable) void load(); }, [usable]);
  const save = async () => {
    if (!settings) return;
    setBusy(true);
    try {
      const response = await studioFetch('/api/app-config', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customInstructions: instructions, revision: settings.revision }) });
      if (!response.ok) { setStatus(response.status === 409 ? 'conflict' : 'error'); return; }
      setSettings(await response.json() as StudioSettingsResponse); setStatus('saved');
    } catch (error) { if (!(error instanceof DOMException && error.name === 'AbortError')) setStatus('error'); }
    finally { setBusy(false); }
  };
  if (!studio.actor || !studio.session) return null;
  return <section className="settings-page-shell">
    <AgentAccountsPage session={studio.session} generation={studio.generation} />
    {studio.available('catalogs') && <SkillsSection cfg={config} setCfg={setConfig} onSkillsChanged={onSkillsChanged} />}
    {usable && <>
      <CustomInstructionsSection value={instructions} onChange={setInstructions} />
      <div className="settings-section">
        <button type="button" data-testid="studio-instructions-save" className="primary" disabled={busy || !settings} onClick={() => void save()}>{t('common.save')}</button>
        <button type="button" data-testid="studio-instructions-reload" className="ghost" disabled={busy} onClick={() => void load()}>{t('studio.settingsReload')}</button>
        {status && <p role="status">{t(status === 'saved' ? 'studio.settingsSaved' : status === 'conflict' ? 'studio.settingsConflict' : 'studio.settingsError')}</p>}
      </div>
      <MemorySection />
    </>}
    <StudioUnavailable lane="settings" />
  </section>;
}
