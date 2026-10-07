import { AgentAccountsPage } from '../multiuser/AgentAccountsPage';
import { useEffect, useState } from 'react';
import type { StudioParityLaneId, StudioSettingsResponse } from '@open-design/contracts';
import { useT } from '../i18n';
import { SkillsSection } from '../components/SkillsSection';
import { MemorySection } from '../components/MemorySection';
import { CustomInstructionsSection } from '../components/CustomInstructionsSection';
import { NotificationsSection } from '../components/NotificationsSection';
import { SettingsLanguageField } from '../components/SettingsLanguageField';
import { SettingsAppearanceField } from '../components/SettingsAppearanceField';
import { SettingsFrame, SettingsNavItem, SettingsSectionHeader } from '../components/SettingsFrame';
import type { SettingsSection } from '../components/SettingsDialog';
import { studioFetch, studioRequestAvailable } from './studio-transport';
import type { AppConfig } from '../types';
import { useStudioCapabilities, StudioUnavailable } from './studio-capabilities';

/** Account sections, plus the desktop sections whose lane is still open: those
 * stay in the navigation with the server's reason instead of disappearing. */
type StudioSettingsSection = 'agentAccounts' | 'skills' | 'general' | 'instructions' | 'memory' | 'media' | 'integrations' | 'privacy';
const PENDING: Partial<Record<StudioSettingsSection, StudioParityLaneId>> = { media: 'generation', integrations: 'settings', privacy: 'settings' };

function studioSection(section: SettingsSection): StudioSettingsSection {
  switch (section) {
    case 'execution': case 'agentAccounts': return 'agentAccounts';
    case 'designSystems': return 'skills';
    case 'instructions': case 'memory': case 'media': case 'privacy': return section;
    case 'integrations': case 'mcpClient': case 'composio': return 'integrations';
    default: return 'general';
  }
}

export function StudioAccountSettings({ presentation, initialSection, onClose, initial, onSkillsChanged, onPersist }: {
  presentation: 'modal' | 'page'; initialSection: SettingsSection; onClose: () => void;
  initial: AppConfig; onSkillsChanged?: (id?: string) => void; onPersist: (config: AppConfig) => Promise<void> | void }) {
  const studio = useStudioCapabilities();
  const t = useT();
  const [section, setSection] = useState<StudioSettingsSection>(() => studioSection(initialSection));
  useEffect(() => { setSection(studioSection(initialSection)); }, [initialSection]);
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
      setSettings(data); setInstructions(data.config.customInstructions); setConfig((current) => ({ ...current, ...data.config })); setStatus(null);
    } catch (error) { if (!(error instanceof DOMException && error.name === 'AbortError')) setStatus('error'); }
    finally { setBusy(false); }
  };
  useEffect(() => { if (usable) void load(); }, [usable]);
  const save = async () => {
    if (!settings) return;
    setBusy(true);
    try {
      const response = await studioFetch('/api/app-config', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customInstructions: instructions, accentColor: config.accentColor,
          notifications: config.notifications, revision: settings.revision }) });
      if (!response.ok) { setStatus(response.status === 409 ? 'conflict' : 'error'); return; }
      const saved = await response.json() as StudioSettingsResponse;
      setSettings(saved); setConfig((current) => ({ ...current, ...saved.config }));
      await onPersist({ ...config, ...saved.config }); setStatus('saved');
    } catch (error) { if (!(error instanceof DOMException && error.name === 'AbortError')) setStatus('error'); }
    finally { setBusy(false); }
  };
  if (!studio.actor || !studio.session) return null;
  const headers: Record<StudioSettingsSection, { title: string; subtitle: string }> = {
    agentAccounts: { title: t('agentAccounts.navTitle'), subtitle: t('agentAccounts.navHint') },
    skills: { title: t('settings.skills'), subtitle: t('settings.skillsHint') },
    general: { title: t('settings.general'), subtitle: t('settings.generalHint') },
    instructions: { title: t('settings.instructionsTitle'), subtitle: t('settings.instructionsNavSub') },
    memory: { title: t('settings.memory'), subtitle: t('settings.memoryHint') },
    media: { title: t('settings.mediaProviders'), subtitle: 'Image / video / audio' },
    integrations: { title: t('settings.mcpServerTitle'), subtitle: t('settings.mcpServerHint') },
    privacy: { title: t('settings.privacy'), subtitle: t('settings.privacyHint') },
  };
  const item = (id: StudioSettingsSection, icon: Parameters<typeof SettingsNavItem>[0]['icon']) =>
    <SettingsNavItem active={section === id} onClick={() => setSection(id)} icon={icon} title={headers[id].title}
      hint={headers[id].subtitle} testId={`studio-settings-nav-${id}`} />;
  const actions = <div className="settings-section">
    <button type="button" data-testid="studio-instructions-save" className="primary" disabled={busy || !settings} onClick={() => void save()}>{t('common.save')}</button>
    <button type="button" data-testid="studio-instructions-reload" className="ghost" disabled={busy} onClick={() => void load()}>{t('studio.settingsReload')}</button>
    {status && <p role="status">{t(status === 'saved' ? 'studio.settingsSaved' : status === 'conflict' ? 'studio.settingsConflict' : 'studio.settingsError')}</p>}
  </div>;
  const pending = PENDING[section];
  return <SettingsFrame presentation={presentation} onClose={onClose}
    header={<SettingsSectionHeader title={headers[section].title} subtitle={headers[section].subtitle} />}
    nav={<>
      {item('agentAccounts', 'key')}
      {studio.available('catalogs') && item('skills', 'puzzle')}
      {item('general', 'settings')}
      {item('instructions', 'edit')}
      {item('memory', 'brain')}
      {item('media', 'image')}
      {item('integrations', 'puzzle')}
      {item('privacy', 'eye')}
    </>}>
    {section === 'agentAccounts' && <AgentAccountsPage session={studio.session} generation={studio.generation} />}
    {section === 'skills' && (studio.available('catalogs')
      ? <SkillsSection cfg={config} setCfg={setConfig} onSkillsChanged={onSkillsChanged} />
      : <StudioUnavailable lane="catalogs" />)}
    {(section === 'general' || section === 'instructions' || section === 'memory') && !usable && <StudioUnavailable lane="settings" />}
    {usable && section === 'general' && <>
      <section className="settings-section settings-general-section">
        <SettingsLanguageField />
        <SettingsAppearanceField cfg={config} setCfg={setConfig} />
        <div className="settings-general-block">
          <div className="settings-general-block-head">
            <h3>{t('settings.systemPrefsTitle')}</h3>
            <p className="hint">{t('settings.systemPrefsHint')}</p>
          </div>
          <NotificationsSection cfg={config} setCfg={setConfig} />
        </div>
      </section>
      {actions}
    </>}
    {usable && section === 'instructions' && <>
      <CustomInstructionsSection value={instructions} onChange={setInstructions} />
      {actions}
    </>}
    {usable && section === 'memory' && <MemorySection />}
    {pending && <StudioUnavailable lane={pending} />}
  </SettingsFrame>;
}
