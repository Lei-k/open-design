import { AgentAccountsPage } from '../multiuser/AgentAccountsPage';
import { useState } from 'react';
import { SkillsSection } from '../components/SkillsSection';
import type { AppConfig } from '../types';
import { useStudioCapabilities, StudioUnavailable } from './studio-capabilities';

export function StudioAccountSettings({ initial, onSkillsChanged }: { initial: AppConfig; onSkillsChanged?: (id?: string) => void }) {
  const studio = useStudioCapabilities();
  const [config, setConfig] = useState(initial);
  if (!studio.actor || !studio.session) return null;
  return <section className="settings-page-shell">
    <AgentAccountsPage session={studio.session} generation={studio.generation} />
    {studio.available('catalogs') && <SkillsSection cfg={config} setCfg={setConfig} onSkillsChanged={onSkillsChanged} />}
    <StudioUnavailable lane="settings" />
  </section>;
}
