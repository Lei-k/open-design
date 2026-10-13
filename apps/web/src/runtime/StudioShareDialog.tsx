import { useId, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  Button, Dialog, DialogBody, DialogDescription, DialogFooter, DialogTitle, Input, Select,
} from '@open-design/components';
import type { StudioCatalogAccessRole, StudioCatalogShareKind, StudioCatalogShareSummary, StudioProjectAccessRole, StudioProjectShareRole } from '@open-design/contracts';
import { useT } from '../i18n';
import type { Dict } from '../i18n/types';
import type { StudioProjectSharing } from './studio-project-sharing';
import { useStudioCatalogSharing } from './studio-catalog-sharing';
import styles from './StudioShareDialog.module.css';

type Translate = ReturnType<typeof useT>;
export function studioRoleLabel(role: StudioProjectAccessRole | StudioCatalogAccessRole, t: Translate): string {
  return t(role === 'owner' ? 'studio.share.roleOwner' : role === 'edit' ? 'studio.share.roleEdit'
    : role === 'comment' ? 'studio.share.roleComment' : role === 'use' ? 'studio.share.roleUse' : 'studio.share.roleView');
}

/** What the dialog needs from a shared resource: the daemon's member list and its grant calls. */
export interface StudioShareModel<R extends string> {
  access: { role: 'owner' | R; self: { accountId: string }; members: Array<{ accountId: string; username: string; role: 'owner' | R }> } | null;
  share: (username: string, role: R) => Promise<'ok' | 'not-found' | 'limit' | 'error'>;
  revoke: (accountId: string) => Promise<boolean>;
  leave: () => Promise<boolean>;
}
export interface StudioShareCopy { title: keyof Dict; ownerHint: keyof Dict; memberHint: keyof Dict; leave: keyof Dict; limit: keyof Dict }
const PROJECT_ROLES: readonly StudioProjectShareRole[] = ['view', 'comment', 'edit'];
const PROJECT_COPY: StudioShareCopy = { title: 'studio.share.title', ownerHint: 'studio.share.ownerHint',
  memberHint: 'studio.share.memberHint', leave: 'studio.share.leave', limit: 'studio.share.limit' };

/**
 * Sharing between accounts of this deployment: projects (#65) and private
 * catalog items (#61). The owner adds an account by username with a role,
 * changes roles and revokes; everyone else sees who has access and may leave.
 * A single-role resource shows no role pickers. Authority stays on the daemon.
 */
export function StudioShareDialog<R extends string = StudioProjectShareRole>({ sharing, onClose, onLeft,
  roles = PROJECT_ROLES as unknown as readonly R[], defaultRole, copy = PROJECT_COPY }: {
  sharing: StudioShareModel<R>; onClose: () => void; onLeft: () => void; roles?: readonly R[]; defaultRole?: R; copy?: StudioShareCopy;
}) {
  const t = useT();
  const titleId = useId();
  const [username, setUsername] = useState('');
  const [role, setRole] = useState<R>(defaultRole ?? (roles.includes('comment' as R) ? 'comment' as R : roles[0]!));
  const pickRole = roles.length > 1;
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ error: boolean; text: string } | null>(null);
  const access = sharing.access;
  const isOwner = access?.role === 'owner';

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!username.trim() || busy) return;
    setBusy(true);
    const outcome = await sharing.share(username, role);
    setBusy(false);
    if (outcome === 'ok') { setStatus({ error: false, text: t('studio.share.added', { name: username.trim() }) }); setUsername(''); return; }
    setStatus({ error: true, text: t(outcome === 'not-found' ? 'studio.share.notFound' : outcome === 'limit' ? copy.limit : 'studio.share.failed') });
  };
  const changeRole = async (name: string, next: R) => {
    setBusy(true);
    const outcome = await sharing.share(name, next);
    setBusy(false);
    if (outcome !== 'ok') setStatus({ error: true, text: t('studio.share.failed') });
  };
  const revoke = async (accountId: string) => {
    setBusy(true);
    if (!await sharing.revoke(accountId)) setStatus({ error: true, text: t('studio.share.failed') });
    setBusy(false);
  };
  const leave = async () => {
    setBusy(true);
    const left = await sharing.leave();
    setBusy(false);
    if (left) onLeft(); else setStatus({ error: true, text: t('studio.share.failed') });
  };

  const dialog = (
    <Dialog className={styles.dialog} onClose={onClose} closeOnEscape ariaLabelledBy={titleId} data-testid="studio-share-dialog">
      <DialogTitle id={titleId}>{t(copy.title)}</DialogTitle>
      <DialogDescription>{t(isOwner ? copy.ownerHint : copy.memberHint)}</DialogDescription>
      <DialogBody>
        {isOwner ? (
          <form className={styles.form} onSubmit={(event) => { void submit(event); }}>
            <label className={styles.field}>
              {t('studio.share.username')}
              <Input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="off"
                spellCheck={false} maxLength={64} data-testid="studio-share-username" />
            </label>
            {pickRole ? (
              <label className={styles.field}>
                {t('studio.share.role')}
                <Select value={role} onChange={(event) => setRole(event.target.value as R)} data-testid="studio-share-role">
                  {roles.map((value) => <option key={value} value={value}>{studioRoleLabel(value as StudioProjectShareRole, t)}</option>)}
                </Select>
              </label>
            ) : null}
            <Button type="submit" variant="primary" disabled={busy || !username.trim()} data-testid="studio-share-submit">{t('studio.share.add')}</Button>
          </form>
        ) : null}
        <p className={`${styles.status}${status?.error ? ` ${styles.error}` : ''}`} role="status" aria-live="polite">{status?.text ?? ''}</p>
        <ul className={styles.members} aria-label={t('studio.share.members')}>
          {(access?.members ?? []).map((member) => (
            <li key={member.accountId} className={styles.member} data-testid="studio-share-member">
              <span className={styles.name}>
                {member.username}{member.accountId === access?.self.accountId ? ` ${t('studio.share.you')}` : ''}
              </span>
              {isOwner && member.role !== 'owner' ? (
                <>
                  {pickRole ? (
                    <Select className={styles.memberRole} aria-label={t('studio.share.roleFor', { name: member.username })} value={member.role} disabled={busy}
                      onChange={(event) => { void changeRole(member.username, event.target.value as R); }}>
                      {roles.map((value) => <option key={value} value={value}>{studioRoleLabel(value as StudioProjectShareRole, t)}</option>)}
                    </Select>
                  ) : <span className={styles.role}>{studioRoleLabel(member.role as StudioCatalogAccessRole, t)}</span>}
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => { void revoke(member.accountId); }}
                    data-testid="studio-share-revoke">{t('studio.share.remove')}</Button>
                </>
              ) : <span className={styles.role}>{studioRoleLabel(member.role as StudioProjectAccessRole, t)}</span>}
            </li>
          ))}
        </ul>
      </DialogBody>
      <DialogFooter className="row">
        {access && !isOwner ? <Button variant="ghost" disabled={busy} onClick={() => { void leave(); }} data-testid="studio-share-leave">{t(copy.leave)}</Button> : null}
        <Button onClick={onClose}>{t('common.close')}</Button>
      </DialogFooter>
    </Dialog>
  );
  if (typeof document === 'undefined') return dialog;
  return createPortal(dialog, document.body);
}

/** Header entry point: owners share; members open the same dialog to see who has access. */
export function StudioShareButton({ sharing, onLeft }: { sharing: StudioProjectSharing; onLeft: () => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  if (!sharing.access) return null;
  const others = sharing.access.members.length - 1;
  return (
    <>
      <Button size="sm" variant={sharing.access.role === 'owner' ? 'secondary' : 'ghost'} className={styles.trigger}
        onClick={() => setOpen(true)} data-testid="studio-share-button"
        title={sharing.access.role === 'owner' ? t('studio.share.title') : studioRoleLabel(sharing.access.role, t)}>
        {sharing.access.role === 'owner' ? t('studio.share.button') : studioRoleLabel(sharing.access.role, t)}
        {others > 0 ? <span aria-hidden="true">{` · ${others + 1}`}</span> : null}
      </Button>
      {open ? <StudioShareDialog sharing={sharing} onClose={() => setOpen(false)} onLeft={() => { setOpen(false); onLeft(); }} /> : null}
    </>
  );
}

const CATALOG_ROLES = ['use'] as const;
const CATALOG_COPY: Record<StudioCatalogShareKind, StudioShareCopy> = {
  skill: { title: 'studio.share.skillTitle', ownerHint: 'studio.share.catalogOwnerHint', memberHint: 'studio.share.catalogMemberHint',
    leave: 'studio.share.catalogLeave', limit: 'studio.share.catalogLimit' },
  'design-system': { title: 'studio.share.designSystemTitle', ownerHint: 'studio.share.catalogOwnerHint', memberHint: 'studio.share.catalogMemberHint',
    leave: 'studio.share.catalogLeave', limit: 'studio.share.catalogLimit' },
};

/**
 * Team catalogs (#61/#65): the owner of a private skill or design document
 * lets other accounts of this deployment use it; a grantee sees who has
 * access and may remove it from its catalog. The member list loads only when
 * the dialog opens. Renders nothing where the session cannot share.
 */
export function StudioCatalogShareButton({ kind, resourceId, share, onChanged, className }: {
  kind: StudioCatalogShareKind; resourceId: string; share?: StudioCatalogShareSummary | undefined; onChanged?: () => void; className?: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const sharing = useStudioCatalogSharing(kind, resourceId, open);
  if (!sharing.available) return null;
  const granted = share?.role === 'use';
  const close = () => { setOpen(false); onChanged?.(); };
  return (
    <>
      <Button size="sm" variant={granted ? 'ghost' : 'secondary'} className={className ?? styles.trigger} onClick={() => setOpen(true)}
        data-testid="studio-catalog-share-button" title={t(CATALOG_COPY[kind].title)}>
        {granted ? studioRoleLabel('use', t) : t('studio.share.button')}
        {!granted && share && share.memberCount > 1 ? <span aria-hidden="true">{` · ${share.memberCount}`}</span> : null}
      </Button>
      {open ? <StudioShareDialog<'use'> sharing={sharing} roles={CATALOG_ROLES} defaultRole="use" copy={CATALOG_COPY[kind]}
        onClose={close} onLeft={close} /> : null}
    </>
  );
}
