import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { useT } from '../i18n';
import { navigate } from '../router';
import { Icon } from '../components/Icon';
import { workspaceChromeAccountActionsHost } from '../components/workspaceChromeActions';
import { useStudioCapabilities } from './studio-capabilities';
import styles from './StudioAccountMenu.module.css';

/**
 * The signed-in Web account in the shared shell's account position: the foot
 * of the entry rail, or the workspace chrome's account slot on a project. It
 * replaces a separate multi-user top bar; identity comes only from the
 * authenticated session provider.
 */
export function StudioAccountMenu({ placement }: { placement: 'rail' | 'chrome' | 'page' }) {
  const studio = useStudioCapabilities();
  const t = useT();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => { if (placement === 'chrome') setHost(workspaceChromeAccountActionsHost()); }, [placement]);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close); document.addEventListener('keydown', close);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close); };
  }, [open]);
  if (!studio.actor || !studio.session) return null;
  const session = studio.session;
  const name = studio.actor.username;
  const go = (action: () => void) => () => { setOpen(false); action(); };
  const menu = <div ref={root} className={`${styles.account} ${styles[placement]}`} data-testid="studio-account-menu">
    <button type="button" className={styles.trigger} aria-haspopup="menu" aria-expanded={open}
      onClick={() => setOpen((value) => !value)} data-testid="studio-account-trigger">
      <span className={styles.avatar} aria-hidden>{name.charAt(0).toUpperCase() || '·'}</span>
      <span className={styles.name}>{name}</span>
    </button>
    {open ? <div role="menu" aria-label={t('multiuser.navigation')} className={styles.menu}>
      <button type="button" role="menuitem" onClick={go(() => navigate({ kind: 'home', view: 'home' }))}>
        <Icon name="home" size={14} /><span>{t('settings.pageBackToHome')}</span>
      </button>
      <button type="button" role="menuitem" onClick={go(() => navigate({ kind: 'home', view: 'settings' }))}>
        <Icon name="settings" size={14} /><span>{t('settings.kicker')}</span>
      </button>
      {studio.actor.role === 'admin' ? <>
        <a role="menuitem" href="/admin/users"><Icon name="users" size={14} /><span>{t('multiuser.users')}</span></a>
        <a role="menuitem" href="/admin/audit"><Icon name="eye" size={14} /><span>{t('multiuser.audit')}</span></a>
      </> : null}
      <button type="button" role="menuitem" onClick={go(() => { flushSync(() => { void session.logout(); }); })}>
        <Icon name="arrow-left" size={14} /><span>{t('multiuser.signOut')}</span>
      </button>
    </div> : null}
  </div>;
  if (placement === 'chrome') return host ? createPortal(menu, host) : null;
  return menu;
}
