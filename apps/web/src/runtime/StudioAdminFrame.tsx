import type { ReactNode } from 'react';
import { useT } from '../i18n';
import { navigate } from '../router';
import { Icon } from '../components/Icon';
import { StudioAccountMenu } from './StudioAccountMenu';
import styles from './StudioAdminFrame.module.css';

/** Admin pages sit outside the entry rail; they keep the shell's account
 * control and a way home instead of a separate multi-user top bar. */
export function StudioAdminFrame({ children }: { children: ReactNode }) {
  const t = useT();
  return <div className={styles.page}>
    <header className={styles.head}>
      <button type="button" className={styles.back} onClick={() => navigate({ kind: 'home', view: 'home' })}>
        <Icon name="arrow-left" size={15} /><span>{t('settings.pageBackToHome')}</span>
      </button>
      <StudioAccountMenu placement="page" />
    </header>
    {children}
  </div>;
}
