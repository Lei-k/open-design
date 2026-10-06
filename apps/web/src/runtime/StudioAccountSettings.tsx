import { AgentAccountsPage } from '../multiuser/AgentAccountsPage';
import { useStudioCapabilities, StudioUnavailable } from './studio-capabilities';

export function StudioAccountSettings() {
  const studio = useStudioCapabilities();
  if (!studio.actor || !studio.session) return null;
  return <section className="settings-page-shell">
    <AgentAccountsPage session={studio.session} generation={studio.generation} />
    <StudioUnavailable lane="settings" />
  </section>;
}
