import { useEffect, useRef, useState } from 'react';
import { Button, Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from '@open-design/components';
import type { BoundedJsonObject, LiveArtifact, LiveArtifactSource, StudioLiveArtifactCreateRequest, StudioLiveArtifactSourceCatalog,
  StudioLiveArtifactSourceTool } from '@open-design/contracts';
import { useT } from '../i18n';
import type { Dict } from '../i18n/types';
import { studioFetch, studioRequestAvailable } from '../runtime/studio-transport';
import styles from './StudioLiveArtifactEditor.module.css';

type SourceKind = 'file' | 'connector' | 'mcp';
type Mapping = NonNullable<LiveArtifactSource['outputMapping']>;
const REASON: Record<string, keyof Dict> = {
  not_connected: 'studio.liveArtifact.sourceUnavailableNotConnected', not_configured: 'studio.liveArtifact.sourceUnavailableNotConfigured',
  disabled: 'studio.liveArtifact.sourceUnavailableDisabled', sign_in: 'studio.liveArtifact.sourceUnavailableSignIn',
};
const kindOf = (source: LiveArtifactSource | undefined): SourceKind => source?.type === 'connector_tool' ? 'connector' : source?.type === 'mcp_tool' ? 'mcp' : 'file';

/**
 * The existing Files entry and LiveArtifactViewer both open this editor.
 * Connector/MCP sources (S62) list only the actor's OWN usable connected apps and
 * remote servers; others are shown unavailable with their reason. A refresh always
 * runs with the refreshing person's own connection or server.
 */
export function StudioLiveArtifactEditor({ projectId, artifact, onClose, onSaved, onDeleted, toolSources }: {
  projectId: string; artifact?: LiveArtifact; onClose(): void; onSaved(artifact: LiveArtifact): void; onDeleted?(): void;
  /** Which tool-source kinds this deployment/actor offers; defaults to the Studio transport's availability. */
  toolSources?: { connectors: boolean; mcp: boolean };
}) {
  const t = useT();
  const existing = artifact?.document.sourceJson;
  const offered = toolSources ?? {
    connectors: studioRequestAvailable('POST', '/api/multiuser/live-artifact-sources/connector/github/tools'),
    mcp: studioRequestAvailable('POST', '/api/multiuser/live-artifact-sources/mcp/server/tools'),
  };
  const [title, setTitle] = useState(artifact?.title ?? '');
  const [data, setData] = useState(() => JSON.stringify(artifact?.document.dataJson ?? { title: '' }, null, 2));
  const [template, setTemplate] = useState(artifact ? '' : '<h1>{{data.title}}</h1>');
  const [kind, setKind] = useState<SourceKind>(() => kindOf(existing));
  const [source, setSource] = useState(String(existing?.type === 'local_file' ? existing.input.path ?? '' : ''));
  const [sourceId, setSourceId] = useState(existing?.connector?.connectorId ?? existing?.mcp?.serverId ?? '');
  const [tool, setTool] = useState(existing?.connector?.toolName ?? existing?.mcp?.toolName ?? '');
  const [args, setArgs] = useState(() => existing && existing.type !== 'local_file' ? JSON.stringify(existing.input, null, 2) : '{}');
  const [confirmed, setConfirmed] = useState(existing?.mcp?.readOnlyConfirmed === true);
  const [catalog, setCatalog] = useState<StudioLiveArtifactSourceCatalog | null>(null);
  const [loadedTools, setLoadedTools] = useState<{ key: string; tools: StudioLiveArtifactSourceTool[] } | null>(null);
  const [toolsBusy, setToolsBusy] = useState(false);
  const [mapping, setMapping] = useState(() => existing?.outputMapping ? JSON.stringify(existing.outputMapping, null, 2) : '');
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
  // The actor's own sources, fetched once when a tool source is chosen.
  useEffect(() => {
    if (kind === 'file' || catalog) return;
    let active = true;
    void studioFetch(`/api/multiuser/live-artifact-sources?projectId=${encodeURIComponent(projectId)}`)
      .then(async (response) => { if (!response.ok) throw new Error(); const value = await response.json() as StudioLiveArtifactSourceCatalog; if (active) setCatalog(value); })
      .catch(() => { if (active) setError(t('studio.liveArtifact.sourceToolsFailed')); });
    return () => { active = false; };
  }, [kind, catalog, projectId, t]);
  const chooseKind = (next: SourceKind) => { setKind(next); setSourceId(''); setTool(''); setLoadedTools(null); setConfirmed(false); setError(null); };
  const entries = kind === 'connector'
    ? (catalog?.connectors ?? []).map((item) => ({ id: item.connectorId, label: item.name, available: item.available, reason: item.reason }))
    : (catalog?.mcpServers ?? []).map((item) => ({ id: item.serverId, label: item.label ?? item.serverId, available: item.available, reason: item.reason }));
  const toolKey = `${kind}:${sourceId}`;
  const tools: StudioLiveArtifactSourceTool[] = loadedTools?.key === toolKey ? loadedTools.tools
    : kind === 'connector' ? catalog?.connectors.find((item) => item.connectorId === sourceId)?.tools ?? [] : [];
  const toolOptions = tool && !tools.some((item) => item.name === tool) ? [{ name: tool, readOnly: true }, ...tools] : tools;
  const loadTools = async () => {
    if (!sourceId || toolsBusy || kind === 'file') return;
    setToolsBusy(true); setError(null);
    try {
      const response = await studioFetch(`/api/multiuser/live-artifact-sources/${kind}/${encodeURIComponent(sourceId)}/tools?projectId=${encodeURIComponent(projectId)}`, { method: 'POST' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error?.message || t('studio.liveArtifact.sourceToolsFailed'));
      if (alive.current) setLoadedTools({ key: toolKey, tools: result.tools });
    } catch (failure) { if (alive.current) setError(failure instanceof Error ? failure.message : t('studio.liveArtifact.sourceToolsFailed')); }
    finally { if (alive.current) setToolsBusy(false); }
  };
  const save = async () => {
    if (submitting.current || loading || !title.trim() || !template.trim()) return;
    let dataJson: BoundedJsonObject;
    let outputMapping: Mapping | undefined;
    let sourceJson: LiveArtifactSource | undefined;
    try {
      dataJson = JSON.parse(data); if (!dataJson || typeof dataJson !== 'object' || Array.isArray(dataJson)) throw new Error();
      if (mapping.trim()) {
        outputMapping = JSON.parse(mapping);
        if (!outputMapping || typeof outputMapping !== 'object' || Array.isArray(outputMapping)) throw new Error();
        if (kind === 'file' && !source.trim()) { setError(t('studio.liveArtifact.sourceHint')); return; }
      }
    }
    catch { setError(t('studio.liveArtifact.invalidData')); return; }
    const common = { refreshPermission: 'manual_refresh_granted_for_read_only' as const, ...(outputMapping ? { outputMapping } : {}) };
    if (kind === 'file') {
      if (source.trim()) sourceJson = { type: 'local_file', input: { path: source.trim() }, ...common };
    } else {
      let input: BoundedJsonObject;
      try { input = JSON.parse(args || '{}'); if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(); }
      catch { setError(t('studio.liveArtifact.sourceIncomplete')); return; }
      if (!sourceId || !tool || kind === 'mcp' && !confirmed) { setError(t('studio.liveArtifact.sourceIncomplete')); return; }
      sourceJson = kind === 'connector'
        ? { type: 'connector_tool', connector: { connectorId: sourceId, toolName: tool }, input, ...common }
        : { type: 'mcp_tool', mcp: { serverId: sourceId, toolName: tool, readOnlyConfirmed: true }, input, ...common };
    }
    const document: StudioLiveArtifactCreateRequest['input']['document'] = { format: 'html_template_v1', templatePath: 'template.html',
      generatedPreviewPath: 'index.html', dataPath: 'data.json', dataJson,
      ...(artifact?.document.dataSchemaJson ? { dataSchemaJson: artifact.document.dataSchemaJson } : {}),
      ...(sourceJson ? { sourceJson } : {}) };
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
  const offersTools = offered.connectors || offered.mcp || kind !== 'file';
  return <Dialog ariaLabelledBy="studio-live-artifact-title" onClose={busy ? undefined : onClose} closeOnEscape={!busy}>
    <DialogHeader><DialogTitle id="studio-live-artifact-title">{t('tasks.primitive.liveArtifacts.title')}</DialogTitle></DialogHeader>
    <DialogBody className={styles.body}>
      <label>{t('studio.liveArtifact.title')}<input value={title} maxLength={200} disabled={busy} onChange={(event) => setTitle(event.target.value)} /></label>
      <label>{t('liveArtifact.viewer.code.templateHeading')}<textarea value={template} onChange={(event) => setTemplate(event.target.value)} disabled={busy || loading} rows={8} spellCheck={false} /></label>
      <label>{t('liveArtifact.viewer.tabData')}<textarea value={data} onChange={(event) => setData(event.target.value)} disabled={busy} rows={6} spellCheck={false} /></label>
      {offersTools && <label>{t('studio.liveArtifact.sourceKind')}
        <select aria-label={t('studio.liveArtifact.sourceKind')} value={kind} disabled={busy} onChange={(event) => chooseKind(event.target.value as SourceKind)}>
          <option value="file">{t('studio.liveArtifact.sourceKindFile')}</option>
          {(offered.connectors || kind === 'connector') && <option value="connector">{t('studio.liveArtifact.sourceKindConnector')}</option>}
          {(offered.mcp || kind === 'mcp') && <option value="mcp">{t('studio.liveArtifact.sourceKindMcp')}</option>}
        </select></label>}
      {kind === 'file' ? <>
        <label>{t('liveArtifact.refresh.docSourceTitle')}<input value={source} onChange={(event) => setSource(event.target.value)} disabled={busy} aria-describedby="studio-live-artifact-source-hint" /></label>
        <p id="studio-live-artifact-source-hint">{t('studio.liveArtifact.sourceHint')}</p>
      </> : <fieldset className={styles.source} disabled={busy}>
        <label>{t(kind === 'connector' ? 'studio.liveArtifact.sourceKindConnector' : 'studio.liveArtifact.sourceKindMcp')}
          <select aria-label={t(kind === 'connector' ? 'studio.liveArtifact.sourceKindConnector' : 'studio.liveArtifact.sourceKindMcp')} value={sourceId}
            onChange={(event) => { setSourceId(event.target.value); setTool(''); setConfirmed(false); }}>
            <option value="">{t('studio.liveArtifact.sourceChoose')}</option>
            {sourceId && !entries.some((entry) => entry.id === sourceId) && <option value={sourceId}>{sourceId}</option>}
            {entries.map((entry) => <option key={entry.id} value={entry.id} disabled={!entry.available}>
              {entry.available ? entry.label : `${entry.label} — ${t(REASON[entry.reason ?? 'disabled'] ?? 'studio.liveArtifact.sourceUnavailableDisabled')}`}</option>)}
          </select></label>
        <div className={styles.toolRow}>
          <label>{t('studio.liveArtifact.sourceTool')}
            <select aria-label={t('studio.liveArtifact.sourceTool')} value={tool} onChange={(event) => { setTool(event.target.value); setConfirmed(false); }} disabled={!sourceId}>
              <option value="">{t('studio.liveArtifact.sourceChoose')}</option>
              {toolOptions.map((item) => <option key={item.name} value={item.name} disabled={!item.readOnly}>
                {item.readOnly ? item.title ?? item.name : `${item.title ?? item.name} — ${t('studio.liveArtifact.sourceNotReadOnly')}`}</option>)}
            </select></label>
          <Button onClick={() => void loadTools()} disabled={!sourceId || toolsBusy}>{t('studio.liveArtifact.sourceLoadTools')}</Button>
        </div>
        <label>{t('studio.liveArtifact.sourceArguments')}<textarea value={args} onChange={(event) => setArgs(event.target.value)} rows={3} spellCheck={false} /></label>
        {kind === 'mcp' && <label className={styles.confirm}><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
          {t('studio.liveArtifact.sourceConfirmReadOnly')}</label>}
        <p>{t('studio.liveArtifact.sourceActorHint')}</p>
      </fieldset>}
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
