import type { StudioCatalogShareSummary, StudioProjectShareSummary } from '@open-design/contracts';
import { useT } from '../i18n';
import styles from './ProjectShareBadge.module.css';

/**
 * Multi-user Studio: marks a project (#65) or a private catalog item (#61)
 * shared between accounts — "Shared by {owner}" for a grantee, "Share · N"
 * for an owner who shared it.
 */
export function ProjectShareBadge({ project, testId = 'project-share-badge' }: {
  project: { studioShare?: StudioProjectShareSummary | StudioCatalogShareSummary | undefined }; testId?: string;
}) {
  const t = useT();
  const share = project.studioShare;
  if (!share) return null;
  const label = share.role === 'owner'
    ? `${t('studio.share.button')} · ${share.memberCount}`
    : t('studio.share.sharedBy', { owner: share.ownerUsername });
  return <span className={styles.badge} title={label} data-testid={testId}>{label}</span>;
}
