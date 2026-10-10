import { useEffect, useRef, useState } from 'react';
import { Button, Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from '@open-design/components';
import type { BoundedJsonObject, LiveArtifact, StudioLiveArtifactCreateRequest } from '@open-design/contracts';
import { useT } from '../i18n';
import { studioFetch } from '../runtime/studio-transport';
import styles from './StudioLiveArtifactEditor.module.css';

/** The existing Files entry and LiveArtifactViewer both open this editor. */
export function StudioLiveArtifactEditor({ projectId, artifact, onClose, onSaved, onDeleted }: {
  projectId: string; artifact?: LiveArtifact; onClose(): void; onSaved(artifact: LiveArtifact): void; onDeleted?(): void;
}) {
  const t = useT();
  const [title, setTitle] = useState(artifact?.title ?? '');
  const [data, setData] = useState(() => JSON.stringify(artifact?.document.dataJson ?? { title: '' }, null, 2));
  const [template, setTemplate] = useState(artifact ? '' : '<h1>{{data.title}}</h1>');
  const [source, setSource] = useState(String(artifact?.document.sourceJson?.input.path ?? ''));
  const [mapping, setMapping] = useState(() => artifact?.document.sourceJson?.outputMapping
    ? JSON.stringify(artifact.document.sourceJson.outputMapping, null, 2) : '');
  const [baseRevision] = useState(artifact?.studioRevision);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(Boolean(artifact));
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const submitting = useRef(false); const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!artifact) return;
    let active = true;
    void studioFetch(`/api/live-artifacts/${encodeURIComponent(artifact.id)}/preview?projectId=${encodeURIComponent(projectId)}&variant=template`)
      .then(async (response) => { if (!response.ok) throw new Error(); const text = await response.text(); if (active) setTemplate(text); })
      .catch(() => { if (active) setError(t('liveArtifact.viewer.code.unavailable')); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [artifact?.id, projectId, t]);
  const save = async () => {
    if (submitting.current || loading || !title.trim() || !template.trim()) return;
    let dataJson: BoundedJsonObject;
    let outputMapping: NonNullable<StudioLiveArtifactCreateRequest['input']['document']['sourceJson']>['outputMapping'];
    try {
      dataJson = JSON.parse(data); if (!dataJson || typeof dataJson !== 'object' || Array.isArray(dataJson)) throw new Error();
      if (mapping.trim()) {
        outputMapping = JSON.parse(mapping);
        if (!outputMapping || typeof outputMapping !== 'object' || Array.isArray(outputMapping)) throw new Error();
        if (!source.trim()) { setError(t('studio.liveArtifact.sourceHint')); return; }
      }
    }
    catch { setError(t('studio.liveArtifact.invalidData')); return; }
    const document: StudioLiveArtifactCreateRequest['input']['document'] = { format: 'html_template_v1', templatePath: 'template.html',
      generatedPreviewPath: 'index.html', dataPath: 'data.json', dataJson,
      ...(artifact?.document.dataSchemaJson ? { dataSchemaJson: artifact.document.dataSchemaJson } : {}),
      ...(source.trim() ? { sourceJson: { type: 'local_file' as const, input: { path: source.trim() }, refreshPermission: 'manual_refresh_granted_for_read_only' as const,
        ...(outputMapping ? { outputMapping } : {}) } } : {}) };
    submitting.current = true; setBusy(true); setError(null);
    try {
      const response = await studioFetch(`/api/live-artifacts${artifact ? `/${encodeURIComponent(artifact.id)}` : ''}?projectId=${encodeURIComponent(projectId)}`, {
        method: artifact ? 'PATCH' : 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: { title, preview: { type: 'html', entry: 'index.html' }, document }, templateHtml: template,
          ...(artifact ? { expectedRevision: baseRevision } : {}) }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error?.message || t('studio.liveArtifact.saveFailed'));
      if (alive.current) onSaved(result.artifact);
    } catch (failure) { if (alive.current) setError(failure instanceof Error ? failure.message : t('studio.liveArtifact.saveFailed')); }
    finally { submitting.current = false; if (alive.current) setBusy(false); }
  };
  const remove = async () => {
    if (!artifact || !onDeleted || submitting.current) return;
    submitting.current = true; setBusy(true); setError(null);
    try {
      const response = await studioFetch(`/api/live-artifacts/${encodeURIComponent(artifact.id)}?projectId=${encodeURIComponent(projectId)}`, { method: 'DELETE' });
      if (!response.ok) throw new Error(t('studio.liveArtifact.saveFailed'));
      if (alive.current) onDeleted();
    } catch (failure) { if (alive.current) setError(failure instanceof Error ? failure.message : t('studio.liveArtifact.saveFailed')); }
    finally { submitting.current = false; if (alive.current) setBusy(false); }
  };
  return <Dialog ariaLabelledBy="studio-live-artifact-title" onClose={busy ? undefined : onClose} closeOnEscape={!busy}>
    <DialogHeader><DialogTitle id="studio-live-artifact-title">{t('tasks.primitive.liveArtifacts.title')}</DialogTitle></DialogHeader>
    <DialogBody className={styles.body}>
      <label>{t('studio.liveArtifact.title')}<input value={title} maxLength={200} disabled={busy} onChange={(event) => setTitle(event.target.value)} /></label>
      <label>{t('liveArtifact.viewer.code.templateHeading')}<textarea value={template} onChange={(event) => setTemplate(event.target.value)} disabled={busy || loading} rows={8} spellCheck={false} /></label>
      <label>{t('liveArtifact.viewer.tabData')}<textarea value={data} onChange={(event) => setData(event.target.value)} disabled={busy} rows={6} spellCheck={false} /></label>
      <label>{t('liveArtifact.refresh.docSourceTitle')}<input value={source} onChange={(event) => setSource(event.target.value)} disabled={busy} aria-describedby="studio-live-artifact-source-hint" /></label>
      <p id="studio-live-artifact-source-hint">{t('studio.liveArtifact.sourceHint')}</p>
      <label>{t('studio.liveArtifact.outputMapping')}<textarea value={mapping} onChange={(event) => setMapping(event.target.value)} disabled={busy} rows={3} spellCheck={false} aria-describedby="studio-live-artifact-mapping-hint" /></label>
      <p id="studio-live-artifact-mapping-hint">{t('studio.liveArtifact.mappingHint')}</p>
      {confirmDelete && artifact && <p role="status">{t('designs.deleteConfirm', { name: artifact.title })}</p>}
      {error && <p role="alert">{error}</p>}
    </DialogBody>
    <DialogFooter><Button onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
      {artifact && onDeleted && <Button onClick={() => confirmDelete ? void remove() : setConfirmDelete(true)} disabled={busy}>{t('common.delete')}</Button>}
      {!confirmDelete && <Button variant="primary" onClick={() => void save()} disabled={busy || loading || !title.trim() || !template.trim()}>{t(artifact ? 'common.save' : 'common.create')}</Button>}</DialogFooter>
  </Dialog>;
}
