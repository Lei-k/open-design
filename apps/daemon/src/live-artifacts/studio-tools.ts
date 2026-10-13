import type { LiveArtifact, LiveArtifactRefreshResponse } from '@open-design/contracts';
import type { StudioLiveArtifacts } from '../storage/studio-live-artifacts.js';

/** Closed envelopes keep arbitrary data JSON inside a bounded string rather than an
 * unbounded provider schema. UI, CLI and tools still use the same storage validators. */
export const STUDIO_LIVE_ARTIFACT_TOOLS = [
  { name: 'live_artifacts_create', description: 'Create a data-backed HTML live artifact in this project. requestJson is JSON {input:{title,preview:{type:"html",entry:"index.html"},document:{format:"html_template_v1",templatePath:"template.html",generatedPreviewPath:"index.html",dataPath:"data.json",dataJson:{...}}},templateHtml:"..."}. Bind escaped scalar values with {{data.field}}. Scripts are refused. Optional sourceJson: local_file with input:{path:"project-relative.json"}; or a read-only tool of the requesting account\'s own connected app (type:"connector_tool", connector:{connectorId,toolName}) or own remote MCP server (type:"mcp_tool", mcp:{serverId,toolName,readOnlyConfirmed:true}) with bounded JSON input arguments; always refreshPermission:"manual_refresh_granted_for_read_only". Never use host connectors or filesystem paths outside this project.',
    properties: { requestJson: { type: 'string' } }, required: ['requestJson'] },
  { name: 'live_artifacts_list', description: 'List live artifact summaries in this project.', properties: {}, required: [] },
  { name: 'live_artifacts_read', description: 'Read a live artifact with its current data, template and Studio revision.', properties: { artifactId: { type: 'string' } }, required: ['artifactId'] },
  { name: 'live_artifacts_update', description: 'Edit a live artifact. requestJson is JSON {input:{...},templateHtml?:"...",expectedRevision:number}. Read the current revision first; a stale edit is refused. The project and run are fixed by the daemon.',
    properties: { artifactId: { type: 'string' }, requestJson: { type: 'string' } }, required: ['artifactId', 'requestJson'] },
  { name: 'live_artifacts_refresh', description: 'Manually refresh an approved, read-only source: a project JSON file, or a connected-app/MCP tool read with this turn owner\'s own connection or server. Optional sourceJson.outputMapping supports dataPaths:[{from,to}] and transform:identity|compact_table|metric_summary. Refresh replaces data with the bounded mapped output and stamps its source provenance. A failed refresh retains the previous data and preview.',
    properties: { artifactId: { type: 'string' } }, required: ['artifactId'] },
] as const;

export interface StudioLiveArtifactTools { execute(name: string, args: Record<string, unknown>): unknown }

/** No endpoint/token reaches the worker. The daemon binds authority to the admitted run,
 * checks it before every call and emits metadata only after a successful mutation.
 * Connector/MCP sources (S62) refresh asynchronously through `refreshSource`, which
 * runs with the run owner's own connection/server inside the run's authority. */
export function createStudioLiveArtifactTools(input: {
  store: StudioLiveArtifacts; projectId: string; conversationId: string; runId: string; authorized(): boolean;
  onChanged(action: 'created' | 'updated', artifact: LiveArtifact): void;
  refreshSource?: (artifactId: string) => Promise<LiveArtifactRefreshResponse>;
}): StudioLiveArtifactTools {
  const changed = (action: 'created' | 'updated', artifact: LiveArtifact) => {
    try { input.onChanged(action, artifact); } catch { /* notification failure cannot undo or duplicate a committed document */ }
  };
  return { execute(name, args) {
    if (!input.authorized()) throw new Error('live artifact authority changed');
    const definition = STUDIO_LIVE_ARTIFACT_TOOLS.find((tool) => tool.name === name);
    if (!definition || Object.keys(args).some((key) => !(definition.required as readonly string[]).includes(key))
      || definition.required.some((key) => typeof args[key] !== 'string')) throw new Error('live artifact tool refused');
    const id = typeof args.artifactId === 'string' ? args.artifactId : '';
    let request: unknown;
    if (typeof args.requestJson === 'string') {
      if (Buffer.byteLength(args.requestJson) > 512 * 1024) throw new Error('live artifact request too large');
      request = JSON.parse(args.requestJson);
    }
    if (name === 'live_artifacts_list') return { artifacts: input.store.list(input.projectId) };
    if (name === 'live_artifacts_read') return { artifact: input.store.read(input.projectId, id), templateHtml: input.store.code(input.projectId, id, 'template') };
    if (name === 'live_artifacts_create') {
      const artifact = input.store.create(input.projectId, request, { conversationId: input.conversationId, runId: input.runId });
      changed('created', artifact); return { artifact };
    }
    if (name === 'live_artifacts_update') {
      const artifact = input.store.update(input.projectId, id, request, { conversationId: input.conversationId, runId: input.runId });
      changed('updated', artifact); return { artifact };
    }
    const kind = input.store.sourceKind(input.projectId, id);
    if (kind === 'connector' || kind === 'mcp') {
      if (!input.refreshSource) throw new Error('live artifact tool refused');
      const before = input.store.read(input.projectId, id).studioRevision;
      return input.refreshSource(id).then((result) => {
        if (!input.authorized()) throw new Error('live artifact authority changed');
        changed('updated', result.artifact); return result;
      }, (error: unknown) => {
        // A recorded failed attempt is shown to the shared viewer; an authority refusal wrote nothing.
        try { const artifact = input.store.read(input.projectId, id); if (artifact.studioRevision !== before) changed('updated', artifact); } catch { /* absent */ }
        throw error;
      });
    }
    try { const result = input.store.refresh(input.projectId, id); changed('updated', result.artifact); return result; }
    catch (error) {
      // Surface failed source attempts to the same shared viewer without releasing source bytes.
      try { const artifact = input.store.read(input.projectId, id); if (artifact.refreshStatus === 'failed') changed('updated', artifact); } catch { /* absent */ }
      throw error;
    }
  } };
}
