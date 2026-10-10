import { useRef, useState } from 'react';
import { Button, Dialog, DialogBody, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@open-design/components';
import type { StudioAutomationTemplate } from '@open-design/contracts';
import { useT } from '../i18n';
import { studioFetch } from '../runtime/studio-transport';
import styles from './StudioAutomationTemplates.module.css';

const draft = { title: '', description: '', purpose: '', triggerKinds: ['manual', 'schedule'], sourceKinds: ['chat'],
  stages: [{ id: 'propose', kind: 'propose', title: '' }], outputSinks: ['memory'], reviewPolicy: 'always', tokenCompression: 'balanced' };
const editable = ({ studioOwned: _owned, unavailable: _unavailable, ...template }: StudioAutomationTemplate) => template;

/** Templates remain reviewable proposals; the existing Automations review section applies them. */
export function StudioAutomationTemplates({ templates, onClose, onProposed }: {
  templates: StudioAutomationTemplate[]; onClose(): void; onProposed(): void;
}) {
  const t = useT();
  const [selected, setSelected] = useState('');
  const [body, setBody] = useState(() => JSON.stringify(draft, null, 2));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const template = templates.find((item) => item.studioOwned && item.id === selected);
  const propose = async (action: 'create' | 'update' | 'delete') => {
    if (submitting.current || action !== 'create' && !template) return;
    setError(null);
    let after: Record<string, unknown> | null = null;
    if (action !== 'delete') {
      try { after = JSON.parse(body); if (!after || typeof after !== 'object' || Array.isArray(after)) throw new Error(); }
      catch { setError(t('automations.templateInvalidJson')); return; }
    }
    submitting.current = true; setBusy(true);
    try {
      const response = await studioFetch('/api/automation-proposals', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: String(after?.title || template?.title || t('automations.proposalTargetTemplate')),
          summary: t('automations.templateReview'), targetKind: 'automation-template', action, reviewPolicy: 'always',
          ...(template ? { targetRef: template.id } : {}), patch: { format: 'json',
            ...(template ? { before: JSON.stringify(editable(template)) } : {}), ...(after ? { after: JSON.stringify(after) } : {}) } }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error?.message || t('automations.templateFailed'));
      onProposed(); onClose();
    } catch (failure) { setError(failure instanceof Error ? failure.message : t('automations.templateFailed')); }
    finally { submitting.current = false; setBusy(false); }
  };
  return <Dialog ariaLabelledBy="studio-template-title" onClose={busy ? undefined : onClose} closeOnEscape={!busy} data-testid="studio-template-dialog">
    <DialogHeader><DialogTitle id="studio-template-title">{t('automations.privateTemplates')}</DialogTitle>
      <DialogDescription>{t('automations.templateReview')}</DialogDescription></DialogHeader>
    <DialogBody className={styles.body}>
      <label>{t('automations.proposalTargetTemplate')}
        <select value={selected} disabled={busy} data-testid="studio-template-select" onChange={(event) => {
          const id = event.target.value; setSelected(id); setError(null);
          const next = templates.find((item) => item.studioOwned && item.id === id);
          setBody(JSON.stringify(next ? editable(next) : draft, null, 2));
        }}><option value="">{t('common.create')}</option>
          {templates.filter((item) => item.studioOwned).map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
        </select>
      </label>
      <label>{t('automations.templateDefinition')}
        <textarea value={body} onChange={(event) => setBody(event.target.value)} rows={18} disabled={busy} spellCheck={false}
          data-testid="studio-template-json" />
      </label>
      {error && <p role="alert">{error}</p>}
    </DialogBody>
    <DialogFooter>
      <Button onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
      {template && <Button onClick={() => void propose('delete')} disabled={busy} data-testid="studio-template-delete">{t('common.delete')}</Button>}
      <Button variant="primary" onClick={() => void propose(template ? 'update' : 'create')} disabled={busy} data-testid="studio-template-propose">
        {t('automations.templatePropose')}
      </Button>
    </DialogFooter>
  </Dialog>;
}
