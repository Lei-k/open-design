import { useId, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  Button, Dialog, DialogBody, DialogDescription, DialogFooter, DialogTitle, Input, Select,
} from '@open-design/components';
import type { StudioProjectAccessRole, StudioProjectShareRole } from '@open-design/contracts';
import { useT } from '../i18n';
import type { StudioProjectSharing } from './studio-project-sharing';
import styles from './StudioShareDialog.module.css';

type Translate = ReturnType<typeof useT>;
export function studioRoleLabel(role: StudioProjectAccessRole, t: Translate): string {
  return t(role === 'owner' ? 'studio.share.roleOwner' : role === 'edit' ? 'studio.share.roleEdit'
    : role === 'comment' ? 'studio.share.roleComment' : 'studio.share.roleView');
}

/**
 * Project sharing between accounts of this deployment (#65). The owner adds
 * an account by username with a role, changes roles and revokes; everyone
 * else sees who has access and may leave. Authority stays on the daemon.
 */
export function StudioShareDialog({ sharing, onClose, onLeft }: { sharing: StudioProjectSharing; onClose: () => void; onLeft: () => void }) {
  const t = useT();
  const titleId = useId();
  const [username, setUsername] = useState('');
  const [role, setRole] = useState<StudioProjectShareRole>('comment');
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
    setStatus({ error: true, text: t(outcome === 'not-found' ? 'studio.share.notFound' : outcome === 'limit' ? 'studio.share.limit' : 'studio.share.failed') });
  };
  const changeRole = async (name: string, next: StudioProjectShareRole) => {
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
      <DialogTitle id={titleId}>{t('studio.share.title')}</DialogTitle>
      <DialogDescription>{t(isOwner ? 'studio.share.ownerHint' : 'studio.share.memberHint')}</DialogDescription>
      <DialogBody>
        {isOwner ? (
          <form className={styles.form} onSubmit={(event) => { void submit(event); }}>
            <label className={styles.field}>
              {t('studio.share.username')}
              <Input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="off"
                spellCheck={false} maxLength={64} data-testid="studio-share-username" />
            </label>
            <label className={styles.field}>
              {t('studio.share.role')}
              <Select value={role} onChange={(event) => setRole(event.target.value as StudioProjectShareRole)} data-testid="studio-share-role">
                {(['view', 'comment', 'edit'] as const).map((value) => <option key={value} value={value}>{studioRoleLabel(value, t)}</option>)}
              </Select>
            </label>
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
                  <Select className={styles.memberRole} aria-label={t('studio.share.roleFor', { name: member.username })} value={member.role} disabled={busy}
                    onChange={(event) => { void changeRole(member.username, event.target.value as StudioProjectShareRole); }}>
                    {(['view', 'comment', 'edit'] as const).map((value) => <option key={value} value={value}>{studioRoleLabel(value, t)}</option>)}
                  </Select>
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => { void revoke(member.accountId); }}
                    data-testid="studio-share-revoke">{t('studio.share.remove')}</Button>
                </>
              ) : <span className={styles.role}>{studioRoleLabel(member.role, t)}</span>}
            </li>
          ))}
        </ul>
      </DialogBody>
      <DialogFooter className="row">
        {access && !isOwner ? <Button variant="ghost" disabled={busy} onClick={() => { void leave(); }} data-testid="studio-share-leave">{t('studio.share.leave')}</Button> : null}
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
