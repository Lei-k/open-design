import { StudioAccountMenu } from './StudioAccountMenu';
import { useState } from 'react';
import { useT } from '../i18n';
import { AgentAccountsPage } from '../multiuser/AgentAccountsPage';
import { SettingsFrame, SettingsNavItem, SettingsSectionHeader } from '../components/SettingsFrame';
import { useStudioCapabilities } from './studio-capabilities';
import { adminSettingsSection, isAdminSettingsSection, StudioAdminNavigation, StudioAdminPanel, useAdminSettingsHeaders, type AdminSettingsSection } from './StudioAdminSections';
/** Only the legacy project shell is retained; account/admin presentation uses
 * the same Settings frame and admin section declaration as the Studio App. */
export function StudioLegacySettings() {
  const studio = useStudioCapabilities(); const t = useT();
  const [section, setSection] = useState<AdminSettingsSection | 'agentAccounts'>(() => adminSettingsSection() ?? 'agentAccounts');
  const headers = useAdminSettingsHeaders();
  const header = isAdminSettingsSection(section) ? headers[section] : { title: t('agentAccounts.navTitle'), subtitle: t('agentAccounts.navHint') };
  if (!studio.session || !studio.actor) return null;
  return <SettingsFrame accountControl={<StudioAccountMenu placement="page" />} presentation="page" header={<SettingsSectionHeader {...header} />} onClose={() => { window.location.href = '/projects'; }}
    nav={<><SettingsNavItem title={t('agentAccounts.navTitle')} hint={t('agentAccounts.navHint')} icon="key" active={section === 'agentAccounts'} onClick={() => setSection('agentAccounts')} />
      <StudioAdminNavigation section={section} onSelect={setSection} /></>}>
    {isAdminSettingsSection(section) ? <StudioAdminPanel section={section} /> : <AgentAccountsPage session={studio.session} generation={studio.generation} />}
  </SettingsFrame>;
}
