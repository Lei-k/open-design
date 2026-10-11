import { useT } from '../i18n';
import { SettingsNavItem } from '../components/SettingsFrame';
import { useStudioCapabilities } from './studio-capabilities';
import { AdminUsers, Audit } from './StudioAdminPages';
import { StudioAdminOperations } from './StudioAdminOperations';
export type AdminSettingsSection = 'users' | 'audit' | 'company' | 'personal';
export function adminSettingsSection(): AdminSettingsSection | null {
  const path = window.location.pathname.replace(/\/$/, '');
  if (path === '/admin/users') return 'users';
  if (path === '/admin/audit') return 'audit';
  const section = new URLSearchParams(window.location.search).get('section');
  return path === '/settings' && isAdminSettingsSection(section) ? section : null;
}
export function isAdminSettingsSection(section: string | null): section is AdminSettingsSection { return ['users', 'audit', 'company', 'personal'].includes(section ?? ''); }
export function useAdminSettingsHeaders() {
  const t = useT();
  return {
    users: { title: t('multiuser.users'), subtitle: t('multiuser.usersHelp') },
    audit: { title: t('multiuser.audit'), subtitle: t('multiuser.auditHelp') },
    company: { title: t('multiuser.companyOpenAI'), subtitle: t('studio.admin.operationsHelp') },
    personal: { title: t('studio.admin.personal'), subtitle: t('studio.admin.operationsHelp') },
  };
}
/** One admin section declaration is shared with the retained legacy fallback. */
export function StudioAdminNavigation({ section, onSelect }: { section: string; onSelect: (section: AdminSettingsSection) => void }) {
  const studio = useStudioCapabilities();
  const headers = useAdminSettingsHeaders();
  if (studio.actor?.role !== 'admin') return null;
  return <>{(['users', 'audit', 'company', 'personal'] as const).map((id) => <SettingsNavItem key={id}
    active={section === id} onClick={() => onSelect(id)} title={headers[id].title} hint={headers[id].subtitle}
    icon={id === 'users' ? 'users' : id === 'audit' ? 'eye' : id === 'company' ? 'key' : 'settings'} testId={`studio-settings-nav-${id}`} />)}</>;
}
export function StudioAdminPanel({ section }: { section: AdminSettingsSection }) {
  const studio = useStudioCapabilities(); const t = useT();
  if (!studio.actor || !studio.session) return null;
  if (studio.actor.role !== 'admin') return <p role="alert">{t('multiuser.denied')}</p>;
  const props = { session: studio.session, account: studio.actor, generation: studio.generation };
  return section === 'users' ? <AdminUsers {...props} /> : section === 'audit' ? <Audit {...props} />
    : <StudioAdminOperations key={section} {...props} personal={section === 'personal'} />;
}
