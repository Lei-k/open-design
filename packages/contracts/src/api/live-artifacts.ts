import type { JsonPrimitive } from '../common';

export type BoundedJsonValue =
  | JsonPrimitive
  | BoundedJsonValue[]
  | { [key: string]: BoundedJsonValue };

export interface BoundedJsonObject {
  [key: string]: BoundedJsonValue;
}

export type LiveArtifactStatus = 'active' | 'archived' | 'error';

export type LiveArtifactRefreshStatus = 'never' | 'idle' | 'running' | 'succeeded' | 'failed';

export type LiveArtifactPreviewType = 'html' | 'jsx' | 'markdown';

/** `mcp_tool` is Studio-only (S62): an account remote MCP server tool, refreshed with the refreshing account's own server. */
export type LiveArtifactSourceType = 'local_file' | 'daemon_tool' | 'connector_tool' | 'mcp_tool';

export type LiveArtifactConnectorApprovalPolicy =
  | 'read_only_auto'
  | 'manual_refresh_granted_for_read_only';

export type LiveArtifactRefreshPermission = 'none' | 'manual_refresh_granted_for_read_only';

export type LiveArtifactOutputTransform = 'identity' | 'compact_table' | 'metric_summary';

export type LiveArtifactProvenanceGenerator = 'agent' | 'refresh_runner';

export type LiveArtifactProvenanceSourceType = 'connector' | 'local_file' | 'user_input' | 'derived';

export interface LiveArtifactPreview {
  type: LiveArtifactPreviewType;
  entry: string;
}

export interface LiveArtifactDocument {
  format: 'html_template_v1';
  templatePath: 'template.html';
  generatedPreviewPath: 'index.html';
  dataPath: 'data.json';
  /** Desktop hydrates this from dataPath; Studio persists it in its canonical database. */
  dataJson: BoundedJsonObject;
  dataSchemaJson?: BoundedJsonObject;
  sourceJson?: LiveArtifactSource;
}

export interface LiveArtifactSource {
  type: LiveArtifactSourceType;
  toolName?: string;
  input: BoundedJsonObject;
  connector?: {
    connectorId: string;
    accountLabel?: string;
    toolName: string;
    approvalPolicy?: LiveArtifactConnectorApprovalPolicy;
  };
  /**
   * Studio `mcp_tool` sources (S62): ids only, never credentials or grants. A
   * refresh resolves `serverId` among the REFRESHING account's own servers.
   * `readOnlyConfirmed` records the creator's confirmation that the tool is
   * read-only; the server's own `annotations.readOnlyHint` must also be true
   * at every refresh (an untrusted hint, so both are required).
   */
  mcp?: {
    serverId: string;
    toolName: string;
    readOnlyConfirmed: true;
  };
  outputMapping?: {
    dataPaths?: Array<{ from: string; to: string }>;
    transform?: LiveArtifactOutputTransform;
  };
  refreshPermission: LiveArtifactRefreshPermission;
}

export interface LiveArtifactProvenanceSource {
  label: string;
  type: LiveArtifactProvenanceSourceType;
  ref?: string;
}

export interface LiveArtifactProvenance {
  generatedAt: string;
  generatedBy: LiveArtifactProvenanceGenerator;
  notes?: string;
  sources: LiveArtifactProvenanceSource[];
}

export interface LiveArtifact {
  schemaVersion: 1;
  id: string;
  projectId: string;
  sessionId?: string;
  createdByRunId?: string;
  title: string;
  slug: string;
  status: LiveArtifactStatus;
  pinned: boolean;
  preview: LiveArtifactPreview;
  refreshStatus: LiveArtifactRefreshStatus;
  createdAt: string;
  updatedAt: string;
  lastRefreshedAt?: string;
  document: LiveArtifactDocument;
  /** Studio database revision, used to refuse edits based on an outdated document. */
  studioRevision?: number;
  studioProvenance?: StudioLiveArtifactProvenance;
}

/** Daemon-stamped origin of the currently accepted Studio document/template.
 * Failed refreshes and metadata-only edits retain the previous accepted origin. */
export interface StudioLiveArtifactProvenance {
  updatedAt: string;
  origin: 'user' | 'agent' | 'project_file' | 'connector' | 'mcp';
  source?: { path: string; sha256: string; bytes: number };
  /**
   * A successful connector/MCP refresh (S62): the accepted source, the account
   * whose own connection/server produced it, and the byte count and SHA-256 of
   * the scrubbed tool output that was mapped. Never arguments or credentials.
   */
  toolSource?: StudioLiveArtifactToolSourceProvenance;
  conversationId?: string;
  runId?: string;
}

export interface StudioLiveArtifactToolSourceProvenance {
  kind: 'connector' | 'mcp';
  /** Connector id or the refreshing account's MCP server id. */
  id: string;
  tool: string;
  actorAccountId: string;
  bytes: number;
  sha256: string;
}

export type LiveArtifactDaemonOwnedInputField =
  | 'id'
  | 'projectId'
  | 'createdAt'
  | 'updatedAt'
  | 'createdByRunId'
  | 'schemaVersion'
  | 'refreshStatus'
  | 'lastRefreshedAt'
  | 'studioRevision'
  | 'studioProvenance';

export type LiveArtifactRejectDaemonOwnedInputFields = {
  [Field in LiveArtifactDaemonOwnedInputField]?: never;
};

export type LiveArtifactCreateInput = LiveArtifactRejectDaemonOwnedInputFields & {
  title: string;
  slug?: string;
  sessionId?: string;
  pinned?: boolean;
  status?: LiveArtifactStatus;
  preview: LiveArtifactPreview;
  document: LiveArtifactDocument;
};

export type LiveArtifactUpdateInput = LiveArtifactRejectDaemonOwnedInputFields & {
  title?: string;
  slug?: string;
  pinned?: boolean;
  status?: LiveArtifactStatus;
  preview?: LiveArtifactPreview;
  document?: LiveArtifactDocument;
};

export type LiveArtifactSummary = Omit<LiveArtifact, 'document'> & {
  hasDocument: boolean;
};

export interface LiveArtifactListResponse {
  artifacts: LiveArtifactSummary[];
}

export interface LiveArtifactDetailResponse {
  artifact: LiveArtifact;
}

export interface LiveArtifactRefreshResponse {
  artifact: LiveArtifact;
  refresh: {
    id: string;
    status: 'succeeded';
    refreshedSourceCount: number;
  };
}

export type LiveArtifactRefreshStepStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'skipped';

export interface LiveArtifactRefreshErrorRecord {
  code?: string;
  message: string;
  path?: string;
}

export interface LiveArtifactRefreshSourceMetadata {
  sourceType: 'document';
  toolName?: string;
  connector?: {
    connectorId: string;
    accountLabel?: string;
    toolName: string;
    approvalPolicy?: LiveArtifactConnectorApprovalPolicy;
  };
}

export interface LiveArtifactRefreshLogEntry {
  schemaVersion: 1;
  projectId: string;
  artifactId: string;
  refreshId: string;
  sequence: number;
  step: string;
  status: LiveArtifactRefreshStepStatus;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  source?: LiveArtifactRefreshSourceMetadata;
  error?: LiveArtifactRefreshErrorRecord;
  metadata?: BoundedJsonObject;
  /** Studio: which kind of source this refresh read (S62); absent on older entries (project file). */
  studioSource?: { kind: 'project_file' | 'connector' | 'mcp'; id?: string; tool?: string };
  createdAt: string;
}

export interface LiveArtifactRefreshLogResponse {
  refreshes: LiveArtifactRefreshLogEntry[];
}

/** Studio stores canonical data in the daemon database, outside worker-writable projects. */
export const STUDIO_LIVE_ARTIFACT_LIMITS = { perProject: 100, templateBytes: 64 * 1024, renderedBytes: 2 * 1024 * 1024,
  bodyBytes: 512 * 1024, refreshHistory: 100 } as const;

export interface StudioLiveArtifactCreateRequest {
  input: LiveArtifactCreateInput;
  templateHtml: string;
}

export interface StudioLiveArtifactUpdateRequest {
  input: LiveArtifactUpdateInput;
  templateHtml?: string;
  /** Required when replacing the document or template. */
  expectedRevision?: number;
}

/**
 * The refreshing account's own sources a Studio Live Artifact may read (S62).
 * Nothing here belongs to another account: connectors are the static catalog
 * overlaid with this account's own connections; MCP servers are this account's
 * own remote servers. Unusable entries carry a fixed reason.
 */
export interface StudioLiveArtifactSourceCatalog {
  connectors: Array<{
    connectorId: string;
    name: string;
    available: boolean;
    /** Why it cannot be used now. */
    reason?: 'not_configured' | 'not_connected';
    /** Statically known read-only tools; more may be loaded with the actor's own connection. */
    tools: StudioLiveArtifactSourceTool[];
  }>;
  mcpServers: Array<{
    serverId: string;
    label: string | null;
    available: boolean;
    reason?: 'disabled' | 'sign_in';
  }>;
}

export interface StudioLiveArtifactSourceTool {
  name: string;
  title?: string;
  /** False when the tool cannot be a Live Artifact source (not classified read-only). */
  readOnly: boolean;
}

/** `POST /api/multiuser/live-artifact-sources/:kind/:id/tools` — discovery with the actor's own connection/server. */
export interface StudioLiveArtifactSourceToolsResponse {
  tools: StudioLiveArtifactSourceTool[];
}

/** Bounds for connector/MCP Live Artifact sources (S62). */
export const STUDIO_LIVE_ARTIFACT_SOURCE_LIMITS = {
  /** Serialized JSON tool arguments stored on the descriptor. */
  argumentBytes: 16 * 1024,
  /** Scrubbed tool output accepted for mapping. */
  outputBytes: 256 * 1024,
  /** Wall-clock deadline of one refresh (grant TTL), including discovery. */
  deadlineMs: 20_000,
  /** Provider tool calls one refresh (or one source-tool discovery) may make. */
  calls: 1,
} as const;

/** Precise refusal for connector/MCP refresh without a live refreshing actor (schedules, background work). */
export const STUDIO_LIVE_ARTIFACT_BACKGROUND_REFRESH_REFUSED =
  'connector and MCP Live Artifact sources refresh only for a live refreshing account (a person pressing Refresh, or an agent turn that account started in an open session); scheduled and background refresh has no live actor session' as const;
