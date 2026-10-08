import type { Project } from '@open-design/contracts';
import { useT } from '../i18n';
import styles from './ProjectShareBadge.module.css';

/**
 * Multi-user Studio (#65): marks a project shared between accounts — "Shared
 * by {owner}" for a grantee, "Share · N" for an owner who shared it.
 */
export function ProjectShareBadge({ project }: { project: Pick<Project, 'studioShare'> }) {
  const t = useT();
  const share = project.studioShare;
  if (!share) return null;
  const label = share.role === 'owner'
    ? `${t('studio.share.button')} · ${share.memberCount}`
    : t('studio.share.sharedBy', { owner: share.ownerUsername });
  return <span className={styles.badge} title={label} data-testid="project-share-badge">{label}</span>;
}
