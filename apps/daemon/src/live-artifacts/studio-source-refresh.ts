import { randomUUID } from 'node:crypto';
import { STUDIO_LIVE_ARTIFACT_SOURCE_LIMITS as LIMITS, type LiveArtifactRefreshResponse, type StudioLiveArtifactSourceCatalog,
  type StudioLiveArtifactSourceTool } from '@open-design/contracts';
import type Database from 'better-sqlite3';
import type { AuthActor } from '../services/auth-service.js';
import { toolTokenRegistry as defaultTokens, type ToolTokenGrant, type ToolTokenRegistry } from '../tool-tokens.js';
import { StudioConnectorRuntimeError, type StudioConnectorRuntime } from '../connectors/studio-runtime.js';
import { StudioMcpRuntimeError, studioMcpToolName, type StudioMcpRuntime } from '../mcp-client/studio-runtime.js';
import { getStaticComposioCatalogDefinitions } from '../connectors/composio.js';
import { CompanyComposioStore, StudioConnectorStore } from '../storage/studio-connectors.js';
import { StudioMcpStore } from '../storage/studio-mcp.js';
import { StudioLiveArtifactRefusal, studioRefreshChanged, studioSourceNotReadOnly, studioSourceReconfirm, type StudioLiveArtifacts,
  type StudioSourceSnapshot } from '../storage/studio-live-artifacts.js';

/**
 * Live Artifact refresh from the REFRESHING account's own connector or remote
 * MCP server (#63, S62). Read-only actor source:
 *
 * - Authority is the refreshing actor's only: the person pressing Refresh (an
 *   owner/editor of the project, with a live session), or — for an admitted
 *   agent refresh — the run owner within that run's authority. Never the
 *   artifact creator's, another collaborator's, an administrator's or a
 *   host-global connection. The descriptor holds ids only; the ids resolve
 *   among the actor's own connections/servers through the S59/S61 runtimes'
 *   `capture`, so a missing, disconnected, disabled or foreign id gets one
 *   non-enumerating refusal and nothing is sent.
 * - A short-lived refresh grant (tool token bound to the actor and the
 *   pinned connection / server instance, generation, settings revision and
 *   token version; session for interactive actors) is minted per refresh with
 *   a one-call budget and the refresh deadline as its TTL, and registered as an
 *   ephemeral grant id (never a run id) with the runtime. The runtime's
 *   `beforeConnect`, liveness and budget checks therefore apply unchanged.
 * - Only read-only tools: the S59 connector safety classifier (read/auto), or
 *   the MCP server's own `annotations.readOnlyHint === true` together with the
 *   REFRESHING account's own stored confirmation. A confirmation is bound to
 *   the server instance and generation (endpoint) it was given for, the tool,
 *   and the readOnlyHint it accepted (true); after a server is replaced,
 *   re-pointed or deleted and recreated under the same id — or for an account
 *   that never confirmed — the refresh is refused with
 *   `LIVE_ARTIFACT_SOURCE_RECONFIRM_REQUIRED` before anything is sent or
 *   written, until that account confirms again (S62 Repair 1). MCP annotations
 *   are untrusted hints; the call still runs only with the actor's own
 *   authority.
 * - The caller's authority (project write access; the run for an agent), the
 *   refresh grant itself (token not revoked or expired, account authority), the
 *   artifact revision and descriptor are re-checked after every await, by the
 *   runtime before every outbound request, and synchronously inside the
 *   transaction that writes. A refresh that loses authority writes nothing at
 *   all — not even a failed-refresh record; only its audit row remains. A
 *   controlled deadline or a source failure while authority holds records a
 *   failed refresh and keeps the previous data (S62 Repair 1).
 * - Tool output is scrubbed by the runtime (known credential representations),
 *   bounded, mapped (S53) and rendered before the atomic replace; provenance
 *   records kind, id, tool, actor, byte count and SHA-256 of the mapped input.
 * - Every attempt appends one immutable audit row (artifact, kind, id, tool,
 *   outcome, duration; no arguments or results).
 */
export interface StudioSourceRefreshActor {
  /** Whose own connection/server is used. Interactive actors' sessions are re-checked on every request. */
  actor: AuthActor;
  /** Synchronous: may this actor still refresh in this project (edit role, live run for agents)? */
  authorized(): boolean;
}

/** How long a refresh grant's token outlives the refresh deadline (see `grant`). */
const DEADLINE_GRACE_MS = 5_000;
const unavailable = () => new StudioLiveArtifactRefusal(409, 'this source is not available to your account', 'LIVE_ARTIFACT_SOURCE_UNAVAILABLE');
const failed = (reason: string) => new StudioLiveArtifactRefusal(502, 'the source could not be refreshed', 'LIVE_ARTIFACT_SOURCE_FAILED', { reason });
type RuntimeError = StudioConnectorRuntimeError | StudioMcpRuntimeError;
const runtimeError = (error: unknown): error is RuntimeError => error instanceof StudioConnectorRuntimeError || error instanceof StudioMcpRuntimeError;

export class StudioLiveArtifactSourceRefresh {
  private readonly tokens: ToolTokenRegistry;
  private readonly connections: StudioConnectorStore;
  private readonly company: CompanyComposioStore;
  private readonly servers: StudioMcpStore;
  constructor(private readonly deps: { db: Database.Database; dataRoot: string; store: StudioLiveArtifacts;
    connectors?: StudioConnectorRuntime; mcp?: StudioMcpRuntime; tokens?: ToolTokenRegistry; deadlineMs?: number }) {
    this.tokens = deps.tokens ?? defaultTokens;
    this.connections = new StudioConnectorStore(deps.db); this.company = new CompanyComposioStore(deps.db, deps.dataRoot);
    this.servers = new StudioMcpStore(deps.db, deps.dataRoot);
  }
  private get deadlineMs() { return this.deps.deadlineMs ?? LIMITS.deadlineMs; }

  /** The actor's own sources for the editor: static catalog + own connections, own MCP servers. No provider call. */
  catalog(accountId: string): StudioLiveArtifactSourceCatalog {
    const key = this.company.read();
    const connectors = this.deps.connectors ? getStaticComposioCatalogDefinitions().filter((definition) => definition.authentication === 'composio').map((definition) => {
      const row = this.connections.connection(accountId, definition.id);
      const connected = key.configured && row?.status === 'connected' && row.credential_revision === key.credentialRevision;
      return { connectorId: definition.id, name: definition.name, available: connected,
        ...(connected ? {} : { reason: key.configured ? 'not_connected' as const : 'not_configured' as const }),
        tools: definition.tools.map((tool) => ({ name: tool.name, ...(tool.title ? { title: tool.title } : {}),
          readOnly: tool.safety.sideEffect === 'read' && tool.safety.approval === 'auto' })) };
    }).sort((left, right) => Number(right.available) - Number(left.available) || left.name.localeCompare(right.name)) : [];
    const mcpServers = this.deps.mcp ? this.servers.list(accountId).map((row) => {
      const token = this.servers.tokenMeta(accountId, row.server_id);
      const signedIn = row.auth_mode !== 'oauth' || !!token && token.instance_id === row.instance_id && token.generation === row.generation
        && (token.expires_at === null || token.expires_at > Date.now());
      const reason = !row.enabled ? 'disabled' as const : !signedIn ? 'sign_in' as const : undefined;
      return { serverId: row.server_id, label: row.label ?? null, available: !reason, ...(reason ? { reason } : {}) };
    }) : [];
    return { connectors, mcpServers };
  }

  /**
   * Record the actor's own read-only confirmation of the artifact's MCP source,
   * bound to the actor's current server instance and generation and the tool
   * (S62 Repair 1). Called after an owner/editor saves the descriptor with the
   * confirmation ticked (Web editor, CLI `--confirm-read-only`). No provider
   * call; without a usable server of that id nothing is recorded (a refresh
   * then answers SOURCE_UNAVAILABLE). Agent-written descriptors record nothing:
   * the confirmation is a person's.
   */
  confirmMcpSource(projectId: string, artifactId: string, actor: AuthActor): boolean {
    if (!this.deps.mcp) return false;
    const { source } = this.deps.store.sourceSnapshot(projectId, artifactId);
    if (source.type !== 'mcp_tool') return false;
    let server;
    try { server = this.deps.mcp.capture(actor, [source.mcp.serverId])?.servers[0]; } catch { return false; }
    if (!server) return false;
    this.deps.store.confirmMcpSource(projectId, artifactId, actor.accountId,
      { serverId: source.mcp.serverId, instanceId: server.instanceId, generation: server.generation, toolName: source.mcp.toolName, readOnlyHint: true });
    return true;
  }

  /** Grant for one refresh/discovery: the actor's own connection/server, a one-call budget, the deadline as TTL. */
  private grant(kind: 'connector' | 'mcp', sourceId: string, projectId: string, who: StudioSourceRefreshActor, operation: 'list' | 'execute') {
    const runtime = kind === 'connector' ? this.deps.connectors : this.deps.mcp;
    if (!runtime) throw unavailable();
    let bound;
    try { bound = runtime.capture(who.actor, [sourceId]); }
    catch (error) {
      if (runtimeError(error) && error.code.endsWith('_AUTHORITY_CHANGED')) throw studioRefreshChanged();
      throw unavailable();
    }
    if (!bound) throw unavailable();
    const id = `live-artifact-refresh:${randomUUID()}`;
    const endpoint = `/api/tools/${kind === 'connector' ? 'connectors' : 'mcp'}/${operation}`;
    // The token outlives the controlled deadline by a short grace, so the deadline (not the
    // token's own expiry) always ends a slow refresh; any other loss of the token is a revocation.
    const grant = this.tokens.mint({ runId: id, projectId, ttlMs: this.deadlineMs + DEADLINE_GRACE_MS, callLimit: LIMITS.calls,
      allowedEndpoints: [endpoint], allowedOperations: [`${kind === 'connector' ? 'connectors' : 'mcp'}:${operation}`],
      ...(kind === 'connector' ? { studioConnectors: bound as NonNullable<ToolTokenGrant['studioConnectors']> } : { studioMcp: bound as NonNullable<ToolTokenGrant['studioMcp']> }) });
    runtime.registerEphemeral(id);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; runtime.abortRun(id); this.tokens.revokeToken(grant.token); }, this.deadlineMs); timer.unref?.();
    return {
      grant, runtime,
      timedOut: () => timedOut,
      /**
       * The grant itself: its token still valid (not revoked, not expired) unless the
       * controlled deadline retired it, and its account authority (account, role,
       * pilot, epoch, session, connection/server versions).
       */
      assert: () => {
        if (!timedOut && !this.tokens.validate(grant.token).ok) throw studioRefreshChanged();
        kind === 'connector' ? this.deps.connectors!.assert(grant.studioConnectors!) : this.deps.mcp!.assert(grant.studioMcp!);
      },
      release: () => { clearTimeout(timer); this.tokens.revokeToken(grant.token); runtime.releaseEphemeral(id); },
    };
  }

  async refresh(projectId: string, artifactId: string, who: StudioSourceRefreshActor): Promise<LiveArtifactRefreshResponse> {
    const started = Date.now(); const startedAt = new Date(started).toISOString();
    if (!who.authorized()) throw studioRefreshChanged();
    const snapshot: StudioSourceSnapshot = this.deps.store.sourceSnapshot(projectId, artifactId);
    const { source } = snapshot; const kind = source.type === 'connector_tool' ? 'connector' as const : 'mcp' as const;
    const sourceId = source.type === 'connector_tool' ? source.connector.connectorId : source.mcp.serverId;
    const tool = source.type === 'connector_tool' ? source.connector.toolName : source.mcp.toolName;
    let outcome = 'refused';
    let lease: ReturnType<StudioLiveArtifactSourceRefresh['grant']> | null = null;
    /** The actor's own MCP confirmation still matches the pinned server instance/generation and tool. */
    const confirmed = () => {
      if (kind !== 'mcp' || !lease) return;
      const server = lease.grant.studioMcp!.servers[0]!; const confirmation = this.deps.store.mcpConfirmation(artifactId, who.actor.accountId);
      if (!confirmation || confirmation.serverId !== sourceId || confirmation.toolName !== tool || confirmation.readOnlyHint !== true
        || confirmation.instanceId !== server.instanceId || confirmation.generation !== server.generation) throw studioSourceReconfirm();
    };
    /** Caller authority, project access, revision and descriptor; then the grant's own authority and the confirmation once minted. */
    const current = () => {
      if (!who.authorized()) throw studioRefreshChanged();
      this.deps.store.assertSourceCurrent(projectId, artifactId, snapshot.revision, snapshot.key);
      try { lease?.assert(); } catch { throw studioRefreshChanged(); }
      confirmed();
    };
    try {
      lease = this.grant(kind, sourceId, projectId, who, 'execute');
      current();
      const refreshId = lease.grant.runId;
      let output: unknown;
      try {
        if (kind === 'connector') {
          const result = await this.deps.connectors!.execute(lease.grant, { connectorId: sourceId, toolName: tool, input: source.input }, current);
          output = result.output;
        } else {
          const result = await this.deps.mcp!.execute(lease.grant, { serverId: sourceId, toolName: studioMcpToolName(sourceId, tool), input: source.input },
            current, { requireReadOnlyHint: true });
          output = result.output;
        }
        current();
      } catch (error) {
        // Authority loss outranks whatever the runtime reported: nothing is written.
        try { current(); } catch (refusal) { if (!lease.timedOut()) throw refusal; }
        const code = error instanceof StudioLiveArtifactRefusal ? error.code : runtimeError(error) ? error.code : undefined;
        if (code === 'LIVE_ARTIFACT_REFRESH_AUTHORITY_CHANGED' && !lease.timedOut()) throw error;
        // A connector tool that is not (or no longer) a read/auto tool is invisible to the runtime.
        if (code === 'LIVE_ARTIFACT_SOURCE_NOT_READ_ONLY' || kind === 'connector' && code === 'CONNECTOR_NOT_GRANTED') throw studioSourceNotReadOnly();
        if (kind === 'mcp' && code === 'NOT_FOUND') throw unavailable();
        const reason = lease.timedOut() ? 'deadline' : code === 'CONNECTOR_INPUT_SCHEMA_MISMATCH' || code === 'BAD_REQUEST' ? 'arguments'
          : code === 'MULTIUSER_MCP_OUTBOUND_REFUSED' || code === 'CONNECTOR_OUTPUT_TOO_LARGE' ? 'bounds' : 'provider';
        // Record the failed attempt only while authority still holds (re-checked in the transaction).
        this.deps.store.recordSourceFailure(projectId, artifactId, { snapshot, refreshId, startedAt, code: reason === 'deadline' ? 'SOURCE_TIMEOUT' : 'SOURCE_FAILED',
          authorize: () => { if (!who.authorized()) throw studioRefreshChanged(); try { lease!.assert(); } catch { throw studioRefreshChanged(); } } });
        throw failed(reason);
      }
      if (output === null || typeof output !== 'object' || Array.isArray(output)) {
        this.deps.store.recordSourceFailure(projectId, artifactId, { snapshot, refreshId, startedAt, code: 'SOURCE_OUTPUT_REFUSED', authorize: current });
        throw failed('output');
      }
      // The atomic replace re-checks everything synchronously inside its transaction.
      const response = this.deps.store.commitSourceRefresh(projectId, artifactId, { snapshot, output, refreshId, startedAt,
        actorAccountId: who.actor.accountId, authorize: current });
      outcome = 'ok';
      return response;
    } catch (error) {
      if (outcome !== 'ok') outcome = error instanceof StudioLiveArtifactRefusal && error.code ? `${error.code}${error.details?.reason ? `:${error.details.reason}` : ''}` : 'LIVE_ARTIFACT_SOURCE_FAILED';
      if (error instanceof StudioLiveArtifactRefusal) throw error;
      throw failed('provider');
    } finally {
      lease?.release();
      this.deps.store.appendSourceAudit({ actor: who.actor.accountId, projectId, artifactId, kind, sourceId, tool, outcome, durationMs: Date.now() - started });
    }
  }

  /**
   * Discovery for the editor with the actor's own connection/server: only
   * read-only tools are usable; the rest are listed unavailable. One-call
   * budget, refresh deadline, the same runtime guarantees as a refresh.
   */
  async tools(kind: 'connector' | 'mcp', sourceId: string, projectId: string, who: StudioSourceRefreshActor): Promise<StudioLiveArtifactSourceTool[]> {
    if (!who.authorized()) throw studioRefreshChanged();
    const lease = this.grant(kind, sourceId, projectId, who, 'list');
    const live = () => { if (!who.authorized()) throw studioRefreshChanged(); };
    try {
      if (kind === 'connector') {
        const listed = await this.deps.connectors!.list(lease.grant, undefined, live).catch((error: unknown) => {
          if (runtimeError(error) && error.code === 'CONNECTOR_NOT_GRANTED') return { connectors: [] };
          throw error;
        });
        live();
        const definition = getStaticComposioCatalogDefinitions().find((item) => item.id === sourceId);
        const readOnly = new Set(listed.connectors.flatMap((connector) => connector.tools.map((tool) => tool.name)));
        const statics = (definition?.tools ?? []).filter((tool) => !readOnly.has(tool.name)).map((tool) => ({ name: tool.name, readOnly: false }));
        return [...listed.connectors.flatMap((connector) => connector.tools.map((tool) => ({ name: tool.name, ...(tool.title ? { title: tool.title } : {}), readOnly: true }))), ...statics];
      }
      const listed = await this.deps.mcp!.list(lease.grant, live, { readOnlyHints: true });
      live();
      return (listed.servers[0]?.tools ?? []).map((tool) => {
        const remote = tool.name.replace(/^mcp_[0-9a-f]{16}_/, '');
        return { name: remote, readOnly: tool.readOnlyHint === true };
      });
    } catch (error) {
      try { live(); lease.assert(); } catch { throw studioRefreshChanged(); }
      if (error instanceof StudioLiveArtifactRefusal) throw error;
      if (runtimeError(error) && (error.code === 'NOT_FOUND' || error.code === 'CONNECTOR_NOT_GRANTED')) throw unavailable();
      throw failed(lease.timedOut() ? 'deadline' : 'provider');
    } finally { lease.release(); }
  }
}
