import { Button } from '@open-design/components';
import { flushSync } from 'react-dom';
import { useT } from '../i18n';
import { navigate } from '../router';
import { useStudioCapabilities } from './studio-capabilities';

export function StudioAccountChrome() {
  const studio = useStudioCapabilities();
  const t = useT();
  if (!studio.actor || !studio.session) return null;
  return <nav aria-label={t('multiuser.navigation')} className="studio-account-chrome">
    <Button onClick={() => navigate({ kind: 'home', view: 'home' })}>OpenDesign</Button>
    <Button onClick={() => navigate({ kind: 'home', view: 'projects' })}>{t('multiuser.projects')}</Button>
    <Button onClick={() => navigate({ kind: 'home', view: 'settings' })}>{t('agentAccounts.navTitle')}</Button>
    <span>{studio.actor.username}</span>
    {studio.actor.role === 'admin' && <><a href="/admin/users">{t('multiuser.users')}</a><a href="/admin/audit">{t('multiuser.audit')}</a></>}
    <Button onClick={() => { flushSync(() => { void studio.session!.logout(); }); }}>{t('multiuser.signOut')}</Button>
  </nav>;
}
