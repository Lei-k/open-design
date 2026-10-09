import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { STUDIO_LIVE_ARTIFACT_LIMITS as LIMITS, type LiveArtifact, type LiveArtifactSummary,
  type LiveArtifactRefreshLogEntry, type LiveArtifactRefreshResponse } from '@open-design/contracts';
import { validateBoundedJsonObject, validateLiveArtifactCreateInput, validateLiveArtifactUpdateInput } from '../live-artifacts/schema.js';
import { LiveArtifactRenderLimitError, renderHtmlTemplateV1 } from '../live-artifacts/render.js';
import { applyLiveArtifactOutputMapping } from '../live-artifacts/mapping.js';
import { captureStudioProject } from '../projects/studio-snapshot.js';
import { validateProjectPath } from '../projects.js';

export class StudioLiveArtifactRefusal extends Error {
  constructor(readonly status: 400 | 404 | 409 | 413, message: string) { super(message); }
}
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
    ); CREATE INDEX IF NOT EXISTS studio_live_artifact_refresh_artifact ON studio_live_artifact_refreshes(artifact_id);`);
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
      // Actor-owned connector execution is a separate closure. Never dispatch a host tool.
      if (source.type !== 'local_file' || source.toolName !== undefined || source.connector !== undefined
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
  create(project: string, value: unknown, lineage?: { conversationId: string; runId: string }): LiveArtifact {
    if (!closed(value, ['input', 'templateHtml']) || !closed(value.input, ['title', 'slug', 'sessionId', 'pinned', 'status', 'preview', 'document'])) throw invalid();
    const parsed = validateLiveArtifactCreateInput(value.input); if (!parsed.ok) throw invalid();
    const now = new Date().toISOString(); const input = parsed.value;
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
    const parsed = validateLiveArtifactUpdateInput(value.input); if (!parsed.ok) throw invalid();
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
    this.db.prepare('UPDATE studio_live_artifacts SET artifact_json = ?, template_html = ? WHERE project_id = ? AND id = ?')
      .run(JSON.stringify(artifact), template as string, project, id);
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
  refresh(project: string, id: string): LiveArtifactRefreshResponse {
    const row = this.row(project, id); const artifact: LiveArtifact = JSON.parse(row.artifact_json);
    const source = artifact.document.sourceJson;
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
      artifact.document = { ...artifact.document, dataJson: applyLiveArtifactOutputMapping({ source, output: parsed.value }) };
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
      ...(failure ? { error: { code: 'SOURCE_REFUSED', message: 'project JSON source could not be refreshed' } } : {}) };
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
}
