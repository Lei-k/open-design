import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { STUDIO_LIVE_ARTIFACT_LIMITS as LIMITS, STUDIO_LIVE_ARTIFACT_SOURCE_LIMITS as SOURCE_LIMITS, type ApiErrorCode, type BoundedJsonObject,
  type LiveArtifact, type LiveArtifactSummary, type LiveArtifactRefreshLogEntry, type LiveArtifactRefreshResponse,
  type StudioLiveArtifactToolSourceProvenance } from '@open-design/contracts';
import { validateBoundedJsonObject, validateLiveArtifactCreateInput, validateLiveArtifactUpdateInput } from '../live-artifacts/schema.js';
import { isStudioToolSourceShape, studioSourceKey, StudioSourceInvalid, validateStudioToolSource, type StudioToolSource } from '../live-artifacts/studio-source.js';
import { getStaticComposioCatalogDefinitions } from '../connectors/composio.js';
import { LiveArtifactRenderLimitError, renderHtmlTemplateV1 } from '../live-artifacts/render.js';
import { applyLiveArtifactOutputMapping } from '../live-artifacts/mapping.js';
import { captureStudioProject } from '../projects/studio-snapshot.js';
import { validateProjectPath } from '../projects.js';

export class StudioLiveArtifactRefusal extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409 | 413 | 429 | 502, message: string, readonly code?: ApiErrorCode,
    readonly details?: Record<string, string>) { super(message); }
}
/** Authority, project access, the descriptor or the document changed while an actor-source refresh ran: nothing is written. */
export const studioRefreshChanged = () => new StudioLiveArtifactRefusal(409, 'the refresh lost its authority or the artifact changed; nothing was written',
  'LIVE_ARTIFACT_REFRESH_AUTHORITY_CHANGED');
export const studioSourceNotReadOnly = () => new StudioLiveArtifactRefusal(403,
  'only tools classified read-only can be a Live Artifact source', 'LIVE_ARTIFACT_SOURCE_NOT_READ_ONLY');
/** A Studio connector/MCP descriptor read at refresh time: what the refresh will commit against. */
export interface StudioSourceSnapshot { artifact: LiveArtifact; source: StudioToolSource; revision: number; key: string }
export interface StudioSourceAuditRow {
  actor: string; projectId: string; artifactId: string; kind: 'connector' | 'mcp'; sourceId: string; tool: string; outcome: string; durationMs: number;
}
/**
 * One account's read-only confirmation of an MCP source (S62 Repair 1): valid only for
 * the server instance and generation, and the tool, it was given for.
 */
export interface StudioMcpConfirmation { serverId: string; instanceId: string; generation: number; toolName: string; readOnlyHint: boolean }
/** The MCP server and tool a descriptor names (confirmations are void when it changes). */
const mcpIdentity = (source: LiveArtifact['document']['sourceJson']): string | null =>
  source?.type === 'mcp_tool' && source.mcp ? JSON.stringify([source.mcp.serverId, source.mcp.toolName]) : null;
/** The refreshing account has no valid confirmation for this MCP server instance/generation and tool. */
export const studioSourceReconfirm = () => new StudioLiveArtifactRefusal(409,
  'confirm again that this MCP tool only reads data: your confirmation is missing or was given for a different server instance, endpoint or tool. '
  + 'Re-save the source with the read-only confirmation ticked (CLI: od live-artifact update with --source-mcp and --confirm-read-only).',
  'LIVE_ARTIFACT_SOURCE_RECONFIRM_REQUIRED', { reason: 'reconfirm' });
const invalid = () => new StudioLiveArtifactRefusal(400, 'invalid live artifact');
const closed = (value: unknown, keys: string[]): value is Record<string, unknown> => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.keys(value).every((key) => keys.includes(key));
type RecordRow = { artifact_json: string; template_html: string };

/** Canonical documents and bounded history never read or write the legacy project store.
 * Callers must authorize the project before every operation. All mutations are synchronous:
 * no worker, session change or concurrent edit can interleave a validated commit. */
export class StudioLiveArtifacts {
  constructor(private readonly db: Database.Database, private readonly projectsRoot: string) {
    db.exec(`CREATE TABLE IF NOT EXISTS studio_live_artifacts (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      artifact_json TEXT NOT NULL, template_html TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS studio_live_artifacts_project ON studio_live_artifacts(project_id);
    CREATE TABLE IF NOT EXISTS studio_live_artifact_refreshes (
      ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
      artifact_id TEXT NOT NULL REFERENCES studio_live_artifacts(id) ON DELETE CASCADE,
      entry_json TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS studio_live_artifact_refresh_artifact ON studio_live_artifact_refreshes(artifact_id);
    -- S62: append-only record of every connector/MCP source attempt (ids, outcome, duration; never arguments or results).
    CREATE TABLE IF NOT EXISTS studio_live_artifact_source_audit (id INTEGER PRIMARY KEY, actor_account_id TEXT NOT NULL,
      project_id TEXT NOT NULL, artifact_id TEXT NOT NULL, source_kind TEXT NOT NULL, source_id TEXT NOT NULL, tool TEXT NOT NULL,
      outcome TEXT NOT NULL, duration_ms INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS studio_live_artifact_source_audit_artifact ON studio_live_artifact_source_audit (artifact_id);
    CREATE TRIGGER IF NOT EXISTS studio_live_artifact_source_audit_immutable BEFORE UPDATE ON studio_live_artifact_source_audit
      BEGIN SELECT RAISE(ABORT, 'audit rows are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS studio_live_artifact_source_audit_no_delete BEFORE DELETE ON studio_live_artifact_source_audit
      BEGIN SELECT RAISE(ABORT, 'audit rows are immutable'); END;
    -- S62 Repair 1: each refreshing account's own read-only confirmation of an MCP source, bound to the
    -- server instance and generation it confirmed, the tool and the readOnlyHint it saw (ids only).
    CREATE TABLE IF NOT EXISTS studio_live_artifact_mcp_confirmations (
      artifact_id TEXT NOT NULL REFERENCES studio_live_artifacts(id) ON DELETE CASCADE, account_id TEXT NOT NULL,
      server_id TEXT NOT NULL, instance_id TEXT NOT NULL, generation INTEGER NOT NULL, tool_name TEXT NOT NULL,
      read_only_hint INTEGER NOT NULL, confirmed_at INTEGER NOT NULL, PRIMARY KEY (artifact_id, account_id));`);
  }
  private row(project: string, id: string): RecordRow {
    const row = this.db.prepare('SELECT artifact_json, template_html FROM studio_live_artifacts WHERE project_id = ? AND id = ?')
      .get(project, id) as RecordRow | undefined;
    if (!row) throw new StudioLiveArtifactRefusal(404, 'resource not found');
    return row;
  }
  read(project: string, id: string): LiveArtifact { return JSON.parse(this.row(project, id).artifact_json); }
  list(project: string): LiveArtifactSummary[] {
    return (this.db.prepare('SELECT artifact_json FROM studio_live_artifacts WHERE project_id = ? ORDER BY rowid DESC')
      .all(project) as Array<{ artifact_json: string }>).map((row) => {
      const { document: _document, ...artifact } = JSON.parse(row.artifact_json) as LiveArtifact;
      return { ...artifact, hasDocument: true };
    });
  }
  private validateDocument(artifact: Pick<LiveArtifact, 'preview' | 'document'>): void {
    if (artifact.preview.type !== 'html' || artifact.preview.entry !== 'index.html') throw invalid();
    const source = artifact.document.sourceJson;
    if (source) {
      // Connector/MCP sources (S62) are ids only and refresh with the REFRESHING account's own
      // connection or server; never a host tool, the creator's credentials or a run grant.
      if (isStudioToolSourceShape(source)) { this.toolSource(source); return; }
      if (source.type !== 'local_file' || source.toolName !== undefined || source.connector !== undefined || source.mcp !== undefined
        || !closed(source.input, ['path']) || typeof source.input.path !== 'string') throw invalid();
      const normalized = validateProjectPath(source.input.path);
      if (normalized !== source.input.path || source.input.path.split('/').some((part) => part.startsWith('.'))
        || !source.input.path.endsWith('.json')) throw invalid();
    }
  }
  private render(artifact: LiveArtifact, template: unknown): string {
    if (typeof template !== 'string' || !template.trim()) throw invalid();
    if (Buffer.byteLength(template) > LIMITS.templateBytes) throw new StudioLiveArtifactRefusal(413, 'live artifact template is too large');
    let html: string;
    try { html = renderHtmlTemplateV1({ templateHtml: template, dataJson: artifact.document.dataJson, maxRenderedBytes: LIMITS.renderedBytes }).html; }
    catch (error) {
      if (error instanceof LiveArtifactRenderLimitError) throw new StudioLiveArtifactRefusal(413, error.message);
      throw invalid();
    }
    if (Buffer.byteLength(html) > LIMITS.renderedBytes) throw new StudioLiveArtifactRefusal(413, 'live artifact preview is too large');
    return html;
  }
  /** Validated Studio connector/MCP descriptor; static connector tools must be classified read-only. */
  private toolSource(value: unknown): StudioToolSource {
    let source: StudioToolSource;
    try { source = validateStudioToolSource(value); } catch (error) {
      if (error instanceof StudioSourceInvalid && error.reason === 'read-only confirmation') {
        throw new StudioLiveArtifactRefusal(400, 'an MCP source needs the read-only confirmation');
      }
      throw invalid();
    }
    if (source.type === 'connector_tool') {
      const definition = getStaticComposioCatalogDefinitions().find((item) => item.id === source.connector.connectorId && item.authentication === 'composio');
      if (!definition) throw invalid();
      // Statically known tools are judged now; discovered ones at every refresh by the S59 classifier.
      const known = definition.tools.find((tool) => tool.name === source.connector.toolName);
      if (known && !(known.safety.sideEffect === 'read' && known.safety.approval === 'auto')) throw studioSourceNotReadOnly();
    }
    return source;
  }
  /**
   * Legacy stored MCP refresh sources (`toolName: mcp_…` on a local/daemon
   * source) never ran with an account authority; they stay refused (S61/S62).
   */
  private refuseMcpSource(value: unknown): void {
    const source = (value as { document?: { sourceJson?: { type?: unknown; toolName?: unknown } } } | null)?.document?.sourceJson;
    if (source && source.type !== 'mcp_tool' && typeof source.toolName === 'string' && source.toolName.startsWith('mcp_')) {
      throw new StudioLiveArtifactRefusal(403, 'legacy MCP refresh sources never carried a refreshing-actor grant and stay refused; an mcp_tool source names one of the refreshing account\'s own servers');
    }
  }
  /** Split a Studio tool source off the input so the shared (desktop) validator never sees it. */
  private withToolSource<T>(input: Record<string, unknown>, validate: (input: unknown) => { ok: true; value: T } | { ok: false }): T {
    const document = input.document as { sourceJson?: unknown } | undefined;
    if (!document || typeof document !== 'object' || !isStudioToolSourceShape(document.sourceJson)) {
      const parsed = validate(input); if (!parsed.ok) throw invalid(); return parsed.value;
    }
    const source = this.toolSource(document.sourceJson);
    const { sourceJson: _source, ...rest } = document as Record<string, unknown>;
    const parsed = validate({ ...input, document: rest }); if (!parsed.ok) throw invalid();
    const value = parsed.value as T & { document?: LiveArtifact['document'] };
    return { ...value, document: { ...value.document!, sourceJson: source } } as T;
  }
  create(project: string, value: unknown, lineage?: { conversationId: string; runId: string }): LiveArtifact {
    if (!closed(value, ['input', 'templateHtml']) || !closed(value.input, ['title', 'slug', 'sessionId', 'pinned', 'status', 'preview', 'document'])) throw invalid();
    this.refuseMcpSource(value.input);
    const input = this.withToolSource(value.input, validateLiveArtifactCreateInput) as unknown as LiveArtifact;
    const now = new Date().toISOString();
    const artifact: LiveArtifact = { ...input, ...(lineage ? { sessionId: lineage.conversationId, createdByRunId: lineage.runId } : {}),
      schemaVersion: 1, id: `live-${randomUUID()}`, projectId: project,
      slug: input.slug ?? (input.title.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 128) || 'artifact'),
      pinned: input.pinned ?? false, status: input.status ?? 'active', refreshStatus: 'never', createdAt: now, updatedAt: now, studioRevision: 1,
      studioProvenance: { updatedAt: now, origin: lineage ? 'agent' : 'user', ...lineage } };
    this.validateDocument(artifact); this.render(artifact, value.templateHtml);
    return this.db.transaction(() => {
      const count = (this.db.prepare('SELECT count(*) AS n FROM studio_live_artifacts WHERE project_id = ?').get(project) as { n: number }).n;
      if (count >= LIMITS.perProject) throw new StudioLiveArtifactRefusal(409, 'live artifact limit reached');
      this.db.prepare('INSERT INTO studio_live_artifacts (id, project_id, artifact_json, template_html) VALUES (?, ?, ?, ?)')
        .run(artifact.id, project, JSON.stringify(artifact), value.templateHtml as string);
      return artifact;
    })();
  }
  update(project: string, id: string, value: unknown, lineage?: { conversationId: string; runId: string }): LiveArtifact {
    const previous = this.row(project, id);
    if (!closed(value, ['input', 'templateHtml', 'expectedRevision']) || !closed(value.input, ['title', 'slug', 'pinned', 'status', 'preview', 'document'])) throw invalid();
    this.refuseMcpSource(value.input);
    const parsed = { value: this.withToolSource(value.input, validateLiveArtifactUpdateInput) as unknown as Partial<LiveArtifact> };
    const current: LiveArtifact = JSON.parse(previous.artifact_json);
    if (value.expectedRevision !== undefined && (!Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 1)
      || (parsed.value.document !== undefined || value.templateHtml !== undefined) && value.expectedRevision === undefined) throw invalid();
    if (value.expectedRevision !== undefined && value.expectedRevision !== current.studioRevision) {
      throw new StudioLiveArtifactRefusal(409, 'live artifact changed; reopen the editor before saving');
    }
    const artifact: LiveArtifact = { ...current, ...parsed.value, updatedAt: new Date().toISOString(), studioRevision: (current.studioRevision ?? 0) + 1 };
    if (parsed.value.document !== undefined || value.templateHtml !== undefined) {
      artifact.studioProvenance = { updatedAt: artifact.updatedAt, origin: lineage ? 'agent' : 'user', ...lineage };
    }
    const template = value.templateHtml === undefined ? previous.template_html : value.templateHtml;
    this.validateDocument(artifact); this.render(artifact, template);
    this.db.transaction(() => {
      this.db.prepare('UPDATE studio_live_artifacts SET artifact_json = ?, template_html = ? WHERE project_id = ? AND id = ?')
        .run(JSON.stringify(artifact), template as string, project, id);
      // A different MCP server or tool (or no MCP source) voids every account's confirmation.
      if (mcpIdentity(current.document.sourceJson) !== mcpIdentity(artifact.document.sourceJson)) {
        this.db.prepare('DELETE FROM studio_live_artifact_mcp_confirmations WHERE artifact_id = ?').run(id);
      }
    })();
    return artifact;
  }
  code(project: string, id: string, variant: 'template' | 'rendered'): string {
    const row = this.row(project, id);
    return variant === 'template' ? row.template_html : this.render(JSON.parse(row.artifact_json), row.template_html);
  }
  delete(project: string, id: string): void {
    this.row(project, id);
    this.db.prepare('DELETE FROM studio_live_artifacts WHERE project_id = ? AND id = ?').run(project, id);
  }
  history(project: string, id: string): LiveArtifactRefreshLogEntry[] {
    this.row(project, id);
    return (this.db.prepare('SELECT entry_json FROM studio_live_artifact_refreshes WHERE artifact_id = ? ORDER BY ordinal DESC LIMIT ?')
      .all(id, LIMITS.refreshHistory) as Array<{ entry_json: string }>).reverse().map((row) => JSON.parse(row.entry_json));
  }
  /** The stored source kind: the route sends connector/MCP sources to the asynchronous actor refresh. */
  sourceKind(project: string, id: string): 'project_file' | 'connector' | 'mcp' | null {
    const source = this.read(project, id).document.sourceJson;
    return !source ? null : source.type === 'connector_tool' ? 'connector' : source.type === 'mcp_tool' ? 'mcp' : 'project_file';
  }
  refresh(project: string, id: string): LiveArtifactRefreshResponse {
    const row = this.row(project, id); const artifact: LiveArtifact = JSON.parse(row.artifact_json);
    this.refuseMcpSource(artifact);
    const source = artifact.document.sourceJson;
    // Connector/MCP sources need the refreshing actor's own asynchronous grant (StudioLiveArtifactSourceRefresh).
    if (source && isStudioToolSourceShape(source)) throw new StudioLiveArtifactRefusal(409, 'this source refreshes with the refreshing account\'s own connection or server');
    if (!source || source.refreshPermission !== 'manual_refresh_granted_for_read_only') {
      throw new StudioLiveArtifactRefusal(409, 'manual refresh requires an approved read-only source');
    }
    this.validateDocument(artifact);
    const startedAt = new Date().toISOString(); const refreshId = randomUUID();
    let failure = false;
    try {
      // Descriptor-held capture rejects links, devices, hidden paths and replacement races.
      const bytes = captureStudioProject(this.projectsRoot, project).find((file) => file.name === source.input.path)?.bytes;
      if (!bytes || bytes.length > 256 * 1024) throw invalid();
      const parsed = validateBoundedJsonObject(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); if (!parsed.ok) throw invalid();
      artifact.document = { ...artifact.document, dataJson: applyLiveArtifactOutputMapping({ source: source as never, output: parsed.value }) };
      this.render(artifact, row.template_html);
      artifact.studioProvenance = { updatedAt: new Date().toISOString(), origin: 'project_file',
        source: { path: source.input.path as string, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } };
    } catch { failure = true; }
    const finishedAt = new Date().toISOString();
    const studioRevision = (artifact.studioRevision ?? 0) + 1;
    const saved: LiveArtifact = failure ? { ...JSON.parse(row.artifact_json), refreshStatus: 'failed', updatedAt: finishedAt, studioRevision }
      : { ...artifact, refreshStatus: 'succeeded', lastRefreshedAt: finishedAt, updatedAt: finishedAt, studioRevision };
    const entry: LiveArtifactRefreshLogEntry = { schemaVersion: 1, projectId: project, artifactId: id, refreshId, sequence: 0,
      step: 'refresh:complete', status: failure ? 'failed' : 'succeeded', startedAt, finishedAt, createdAt: finishedAt,
      durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
      ...(failure ? { error: { code: 'SOURCE_REFUSED', message: 'project JSON source could not be refreshed' } } : {}),
      studioSource: { kind: 'project_file' } };
    this.db.transaction(() => {
      this.db.prepare('UPDATE studio_live_artifacts SET artifact_json = ? WHERE project_id = ? AND id = ?').run(JSON.stringify(saved), project, id);
      this.db.prepare('INSERT INTO studio_live_artifact_refreshes (artifact_id, entry_json) VALUES (?, ?)').run(id, JSON.stringify(entry));
      this.db.prepare(`DELETE FROM studio_live_artifact_refreshes WHERE artifact_id = ? AND ordinal NOT IN
        (SELECT ordinal FROM studio_live_artifact_refreshes WHERE artifact_id = ? ORDER BY ordinal DESC LIMIT ?)`)
        .run(id, id, LIMITS.refreshHistory);
    })();
    if (failure) throw new StudioLiveArtifactRefusal(409, 'project JSON source could not be refreshed');
    return { artifact: saved, refresh: { id: refreshId, status: 'succeeded', refreshedSourceCount: 1 } };
  }

  // ---- S62: connector/MCP sources refreshed with the refreshing account's own authority ----

  /** Read the descriptor a refresh will run against; only a validated connector/MCP source with manual permission. */
  sourceSnapshot(project: string, id: string): StudioSourceSnapshot {
    const artifact = this.read(project, id); const raw = artifact.document.sourceJson;
    if (!raw || !isStudioToolSourceShape(raw)) throw new StudioLiveArtifactRefusal(409, 'manual refresh requires an approved read-only source');
    const source = this.toolSource(raw);
    return { artifact, source, revision: artifact.studioRevision ?? 0, key: studioSourceKey(source) };
  }
  /** Throws `studioRefreshChanged` unless the stored artifact still has this revision and descriptor. */
  assertSourceCurrent(project: string, id: string, revision: number, key: string): void {
    const row = this.db.prepare('SELECT artifact_json FROM studio_live_artifacts WHERE project_id = ? AND id = ?').get(project, id) as { artifact_json: string } | undefined;
    if (!row) throw studioRefreshChanged();
    const artifact = JSON.parse(row.artifact_json) as LiveArtifact; const source = artifact.document.sourceJson;
    let current: string | null = null;
    try { current = source && isStudioToolSourceShape(source) ? studioSourceKey(validateStudioToolSource(source)) : null; } catch { current = null; }
    if ((artifact.studioRevision ?? 0) !== revision || current !== key) throw studioRefreshChanged();
  }
  private historyEntry(project: string, id: string, refreshId: string, startedAt: string, finishedAt: string, failure: { code: string; message: string } | null,
    source: StudioToolSource): LiveArtifactRefreshLogEntry {
    return { schemaVersion: 1, projectId: project, artifactId: id, refreshId, sequence: 0, step: 'refresh:complete', status: failure ? 'failed' : 'succeeded',
      startedAt, finishedAt, createdAt: finishedAt, durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
      ...(failure ? { error: failure } : {}),
      studioSource: source.type === 'connector_tool' ? { kind: 'connector', id: source.connector.connectorId, tool: source.connector.toolName }
        : { kind: 'mcp', id: source.mcp.serverId, tool: source.mcp.toolName } };
  }
  private writeRefresh(project: string, id: string, saved: LiveArtifact, entry: LiveArtifactRefreshLogEntry): void {
    this.db.prepare('UPDATE studio_live_artifacts SET artifact_json = ? WHERE project_id = ? AND id = ?').run(JSON.stringify(saved), project, id);
    this.db.prepare('INSERT INTO studio_live_artifact_refreshes (artifact_id, entry_json) VALUES (?, ?)').run(id, JSON.stringify(entry));
    this.db.prepare(`DELETE FROM studio_live_artifact_refreshes WHERE artifact_id = ? AND ordinal NOT IN
      (SELECT ordinal FROM studio_live_artifact_refreshes WHERE artifact_id = ? ORDER BY ordinal DESC LIMIT ?)`)
      .run(id, id, LIMITS.refreshHistory);
  }
  /**
   * The atomic data replace of a connector/MCP refresh. `authorize` (the
   * caller's synchronous authority check) runs inside the transaction, then the
   * revision and descriptor are re-read; any change writes nothing. `output`
   * is the scrubbed tool output; it is bounded, mapped with the S53 mapper and
   * rendered before anything is written. A mapping/render failure records a
   * failed refresh instead (`LIVE_ARTIFACT_SOURCE_FAILED`), keeping the data.
   */
  commitSourceRefresh(project: string, id: string, input: { snapshot: StudioSourceSnapshot; output: unknown; refreshId: string; startedAt: string;
    actorAccountId: string; authorize(): void }): LiveArtifactRefreshResponse {
    const { snapshot } = input;
    let mapped: BoundedJsonObject | null = null; let provenance: StudioLiveArtifactToolSourceProvenance | null = null;
    const raw = JSON.stringify(input.output ?? null);
    const bytes = Buffer.byteLength(raw);
    const parsed = bytes <= SOURCE_LIMITS.outputBytes ? validateBoundedJsonObject(input.output, 'output') : { ok: false as const };
    if (parsed.ok) {
      try {
        mapped = applyLiveArtifactOutputMapping({ source: snapshot.source as never, output: parsed.value });
        const source = snapshot.source;
        provenance = { kind: source.type === 'connector_tool' ? 'connector' : 'mcp', id: source.type === 'connector_tool' ? source.connector.connectorId : source.mcp.serverId,
          tool: source.type === 'connector_tool' ? source.connector.toolName : source.mcp.toolName, actorAccountId: input.actorAccountId,
          bytes, sha256: createHash('sha256').update(raw).digest('hex') };
      } catch { mapped = null; }
    }
    // The failed attempt is committed with the transaction; the refusal is thrown only after it.
    const committed = this.db.transaction(() => {
      input.authorize();
      this.assertSourceCurrent(project, id, snapshot.revision, snapshot.key);
      const row = this.row(project, id); const current = JSON.parse(row.artifact_json) as LiveArtifact;
      const finishedAt = new Date().toISOString(); const studioRevision = (current.studioRevision ?? 0) + 1;
      let failure: { code: string; message: string } | null = mapped && provenance ? null : { code: 'SOURCE_OUTPUT_REFUSED', message: 'source output could not be mapped' };
      let saved: LiveArtifact = current;
      if (!failure) {
        const candidate: LiveArtifact = { ...current, document: { ...current.document, dataJson: mapped! } };
        try { this.render(candidate, row.template_html); } catch { failure = { code: 'SOURCE_OUTPUT_REFUSED', message: 'source output could not be rendered' }; }
        saved = { ...candidate, refreshStatus: 'succeeded', lastRefreshedAt: finishedAt, updatedAt: finishedAt, studioRevision,
          studioProvenance: { updatedAt: finishedAt, origin: provenance!.kind, toolSource: provenance! } };
      }
      if (failure) saved = { ...current, refreshStatus: 'failed', updatedAt: finishedAt, studioRevision };
      this.writeRefresh(project, id, saved, this.historyEntry(project, id, input.refreshId, input.startedAt, finishedAt, failure, snapshot.source));
      return failure ? null : { artifact: saved, refresh: { id: input.refreshId, status: 'succeeded' as const, refreshedSourceCount: 1 } };
    })();
    if (!committed) throw new StudioLiveArtifactRefusal(502, 'the source output could not be refreshed', 'LIVE_ARTIFACT_SOURCE_FAILED', { reason: 'output' });
    return committed;
  }
  /**
   * A source that failed (provider error, deadline, size) while authority held:
   * record the failed attempt and keep the previous data. Re-checks authority,
   * revision and descriptor in the same transaction; on any change nothing is written.
   */
  recordSourceFailure(project: string, id: string, input: { snapshot: StudioSourceSnapshot; refreshId: string; startedAt: string; code: string; authorize(): void }): LiveArtifact {
    return this.db.transaction(() => {
      input.authorize();
      this.assertSourceCurrent(project, id, input.snapshot.revision, input.snapshot.key);
      const current = this.read(project, id); const finishedAt = new Date().toISOString();
      const saved: LiveArtifact = { ...current, refreshStatus: 'failed', updatedAt: finishedAt, studioRevision: (current.studioRevision ?? 0) + 1 };
      this.writeRefresh(project, id, saved, this.historyEntry(project, id, input.refreshId, input.startedAt, finishedAt,
        { code: input.code, message: 'the source could not be refreshed' }, input.snapshot.source));
      return saved;
    })();
  }
  /**
   * Record `accountId`'s own read-only confirmation of the artifact's MCP source,
   * bound to the server instance/generation it was given for (S62 Repair 1).
   * Only for the stored descriptor's server and tool; replaces that account's
   * previous confirmation.
   */
  confirmMcpSource(project: string, id: string, accountId: string, binding: StudioMcpConfirmation): void {
    const source = this.read(project, id).document.sourceJson;
    if (source?.type !== 'mcp_tool' || source.mcp?.serverId !== binding.serverId || source.mcp.toolName !== binding.toolName || binding.readOnlyHint !== true) {
      throw new StudioLiveArtifactRefusal(409, 'the source changed; nothing was confirmed');
    }
    this.db.prepare(`INSERT INTO studio_live_artifact_mcp_confirmations (artifact_id, account_id, server_id, instance_id, generation, tool_name, read_only_hint, confirmed_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?) ON CONFLICT(artifact_id, account_id) DO UPDATE SET server_id = excluded.server_id, instance_id = excluded.instance_id,
      generation = excluded.generation, tool_name = excluded.tool_name, read_only_hint = excluded.read_only_hint, confirmed_at = excluded.confirmed_at`)
      .run(id, accountId, binding.serverId, binding.instanceId, binding.generation, binding.toolName, Date.now());
  }
  /** `accountId`'s stored confirmation of this artifact's MCP source, if any. */
  mcpConfirmation(id: string, accountId: string): StudioMcpConfirmation | null {
    const row = this.db.prepare(`SELECT server_id, instance_id, generation, tool_name, read_only_hint FROM studio_live_artifact_mcp_confirmations
      WHERE artifact_id = ? AND account_id = ?`).get(id, accountId) as { server_id: string; instance_id: string; generation: number; tool_name: string; read_only_hint: number } | undefined;
    return row ? { serverId: row.server_id, instanceId: row.instance_id, generation: row.generation, toolName: row.tool_name, readOnlyHint: row.read_only_hint === 1 } : null;
  }
  appendSourceAudit(row: StudioSourceAuditRow): void {
    this.db.prepare(`INSERT INTO studio_live_artifact_source_audit (actor_account_id, project_id, artifact_id, source_kind, source_id, tool, outcome, duration_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(row.actor, row.projectId, row.artifactId, row.kind, row.sourceId, row.tool, row.outcome, row.durationMs, Date.now());
  }
}
