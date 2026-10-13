import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ApiErrorCode } from '@open-design/contracts';
import type { AuthActor } from '../services/auth-service.js';
import type { AuthStore } from '../storage/auth-store.js';
import { StudioMcpStore } from '../storage/studio-mcp.js';
import { StudioConnectorGrantStore } from '../storage/studio-connectors.js';
import { toolTokenRegistry, type ToolTokenGrant, type ToolTokenRegistry, type StudioMcpGrant } from '../tool-tokens.js';
import { createSafeOutboundFetch, OutboundRequestRefused, type SafeOutboundOptions } from '../http/safe-outbound-fetch.js';
import { STUDIO_RUN_CONNECTOR_CALL_LIMIT, STUDIO_RUN_CONNECTOR_GRANT_MAX_MS } from '../connectors/studio-runtime.js';
import { reserveStudioToolCall } from '../services/studio-tool-call-budget.js';
import { validateBoundedJsonObject, type BoundedJsonObject } from '../live-artifacts/schema.js';
import { assertJsonSchemaMatches } from '../connectors/service.js';
import { carriesSecret, knownSecrets, scrubKnownSecrets, type KnownSecrets } from './studio-untrusted.js';
import { studioMcpOutboundCredentials, studioMcpProbeHeaders } from './studio-remote.js';
import { studioMcpSession } from './studio-session.js';

export class StudioMcpRuntimeError extends Error {
  constructor(readonly code: ApiErrorCode, readonly status: number) { super(code); }
}
const missing = () => new StudioMcpRuntimeError('NOT_FOUND', 404);
const changed = () => new StudioMcpRuntimeError('MULTIUSER_MCP_AUTHORITY_CHANGED', 409);
const provider = () => new StudioMcpRuntimeError('MULTIUSER_MCP_PROVIDER_FAILED', 502);
export const STUDIO_MCP_RUNTIME_LIMITS = { tools: 64, schemaBytes: 16_384, discoveryBytes: 128 * 1024, resultBytes: 1024 * 1024, deadlineMs: 10_000 } as const;
/** Server ids are local validated slugs; hash avoids delimiter collisions across servers. */
export const studioMcpToolName = (serverId: string, name: string) => `mcp_${createHash('sha256').update(serverId).digest('hex').slice(0, 16)}_${name}`;
interface Tool { name: string; description: string; inputSchema: BoundedJsonObject; remoteName: string; readOnlyHint: boolean }
/** A discovered tool as `mcp_list` returns it; `readOnlyHint` only when the caller asked for hints. */
export type ListedTool = Omit<Tool, 'remoteName' | 'readOnlyHint'> & { readOnlyHint?: boolean };
/** Tool lists cached per grant (run or refresh) and pinned server version (S62 A2). */
const LIST_CACHE_LIMIT = 256;
export interface StudioMcpExecuteOptions {
  /**
   * Live Artifact refresh (S62): the tool must carry `annotations.readOnlyHint === true`
   * in this server's own tool list. Annotations are untrusted hints; the call
   * still runs only with the grant owner's own authority.
   */
  requireReadOnlyHint?: boolean;
}

/** Run-owner only, with the same epoch/session/pilot authority as S59 connectors. */
export class StudioMcpRuntime {
  private readonly store: StudioMcpStore;
  private readonly grants: StudioConnectorGrantStore;
  private readonly safe;
  private readonly tokens: ToolTokenRegistry;
  private runLive: (id: string) => boolean = () => false;
  /** Short-lived non-run grants (Live Artifact refresh, S62) that are live while registered. */
  private readonly ephemeral = new Set<string>();
  private readonly inflight = new Map<string, Set<AbortController>>();
  private readonly listCache = new Map<string, { runId: string; tools: ListedTool[] }>();
  constructor(private readonly deps: { db: Database.Database; dataRoot: string; auth: AuthStore; sessionCurrent(actor: AuthActor): boolean;
    outbound?: SafeOutboundOptions; tokens?: ToolTokenRegistry }) {
    this.store = new StudioMcpStore(deps.db, deps.dataRoot); this.grants = new StudioConnectorGrantStore(deps.db);
    this.safe = createSafeOutboundFetch(deps.outbound); this.tokens = deps.tokens ?? toolTokenRegistry;
  }
  setRunLiveness(check: (id: string) => boolean): void { this.runLive = check; }
  /** A non-run grant id (never a run id) counts as live only between these two calls. */
  registerEphemeral(id: string): void { this.ephemeral.add(id); }
  releaseEphemeral(id: string): void { this.ephemeral.delete(id); this.abortRun(id); }
  abortRun(id: string): void {
    for (const controller of this.inflight.get(id) ?? []) controller.abort(); this.inflight.delete(id);
    for (const [key, entry] of this.listCache) if (entry.runId === id) this.listCache.delete(key);
  }
  close(): void { for (const id of this.inflight.keys()) this.abortRun(id); }
  /** The connector epoch is shared; the auth revocation hook invalidates it once. */
  invalidateAccount(owner: string): void {
    for (const [id, controllers] of this.inflight) for (const controller of controllers) {
      if ((controller as AbortController & { owner?: string }).owner === owner) controller.abort();
      if (controller.signal.aborted) controllers.delete(controller);
      if (!controllers.size) this.inflight.delete(id);
    }
  }
  private version(owner: string, serverId: string): string | null {
    const token = this.store.tokenMeta(owner, serverId);
    // Fingerprint the sealed version, never decrypt just to check identity.
    return token ? createHash('sha256').update(token.sealed).digest('hex') : null;
  }
  private usable(owner: string, serverId: string) {
    const row = this.store.get(owner, serverId); const token = this.store.tokenMeta(owner, serverId);
    if (!row?.enabled || row.auth_mode === 'oauth' && (!token || token.instance_id !== row.instance_id || token.generation !== row.generation
      || token.expires_at !== null && token.expires_at <= Date.now())) throw missing();
    return row;
  }
  capture(actor: AuthActor, ids: readonly string[]): StudioMcpGrant | undefined {
    if (!ids.length) return undefined;
    const bound: StudioMcpGrant = { ownerAccountId: actor.accountId, role: actor.role,
      pilotRevision: this.deps.auth.getStudioPilot(actor.accountId).revision, revocationVersion: this.grants.epoch(actor.accountId),
      ...(actor.sessionId.startsWith('routine:') ? {} : { actor: { ...actor } }),
      servers: [...new Set(ids)].map((serverId) => { const row = this.usable(actor.accountId, serverId);
        return { serverId, instanceId: row.instance_id, generation: row.generation, revision: row.revision, tokenVersion: this.version(actor.accountId, serverId) }; }) };
    this.assert(bound); return bound;
  }
  assert(bound: StudioMcpGrant): void {
    const account = this.deps.auth.getAccountById(bound.ownerAccountId); const pilot = this.deps.auth.getStudioPilot(bound.ownerAccountId);
    if (!account?.active || account.passwordState !== 'set' || account.role !== bound.role || !pilot.studioPilot || pilot.revision !== bound.pilotRevision
      || this.grants.epoch(bound.ownerAccountId) !== bound.revocationVersion || bound.actor && !this.deps.sessionCurrent(bound.actor)) throw changed();
    for (const server of bound.servers) {
      const row = this.usable(bound.ownerAccountId, server.serverId);
      if (row.instance_id !== server.instanceId || row.generation !== server.generation || row.revision !== server.revision
        || this.version(bound.ownerAccountId, server.serverId) !== server.tokenVersion) throw missing();
    }
  }
  private live(grant: ToolTokenGrant, operation: 'list' | 'execute', liveness?: () => void): void {
    const validation = this.tokens.validate(grant.token, { endpoint: `/api/tools/mcp/${operation}`, operation: `mcp:${operation}` });
    if (!validation.ok) throw new StudioMcpRuntimeError(validation.code, validation.code.endsWith('DENIED') ? 403 : 401);
    if (!(this.ephemeral.has(grant.runId) || this.runLive(grant.runId)) || Date.now() - Date.parse(grant.issuedAt) >= STUDIO_RUN_CONNECTOR_GRANT_MAX_MS) throw new StudioMcpRuntimeError('TOOL_TOKEN_INVALID', 401);
    liveness?.(); if (!grant.studioMcp) throw missing(); this.assert(grant.studioMcp);
  }
  private async session(grant: ToolTokenGrant, serverId: string, operation: 'list' | 'execute', liveness: (() => void) | undefined,
    work: (rpc: (method: string, params?: unknown) => Promise<unknown>, secrets: () => KnownSecrets) => Promise<unknown>) {
    const live = () => this.live(grant, operation, liveness); live();
    const bound = grant.studioMcp!; const server = bound.servers.find((item) => item.serverId === serverId); if (!server) throw missing();
    const row = this.usable(bound.ownerAccountId, serverId);
    const controller: AbortController & { owner?: string } = new AbortController(); controller.owner = bound.ownerAccountId;
    const controllers = this.inflight.get(grant.runId) ?? new Set<AbortController>(); controllers.add(controller); this.inflight.set(grant.runId, controllers);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(STUDIO_MCP_RUNTIME_LIMITS.deadlineMs)]);
    let secrets = knownSecrets([]);
    // Idle streams have no await boundary on which to observe a revoke. Check while open as well.
    const watch = setInterval(() => { try { live(); } catch { controller.abort(); } }, 20); watch.unref();
    try {
      const value = await studioMcpSession({ safe: this.safe, url: row.url, transport: row.transport, signal, live,
        endpointAllowed: (url) => !carriesSecret(url, secrets), beforeConnect: (hop) => {
          live();
          if (hop.phase !== 'dispatch') return;
          if (!hop.sameOrigin) throw missing();
          // Only this hook opens credentials, after DNS and the final authority check.
          const material = this.store.secretMaterial(bound.ownerAccountId, serverId);
          secrets = knownSecrets(studioMcpOutboundCredentials(material));
          return { headers: studioMcpProbeHeaders(material.headers, material.token?.accessToken ?? null) };
        } }, (rpc) => work(rpc, () => secrets));
      live(); return value;
    } catch (error) {
      live();
      if (error instanceof StudioMcpRuntimeError) throw error;
      if (error instanceof OutboundRequestRefused && error.reason !== 'authority') throw new StudioMcpRuntimeError('MULTIUSER_MCP_OUTBOUND_REFUSED', 400);
      throw provider();
    } finally {
      clearInterval(watch); controller.abort(); controllers.delete(controller); if (!controllers.size) this.inflight.delete(grant.runId);
    }
  }
  /**
   * Tool results and discovered metadata go to the model (or into Live Artifact
   * data): only the server's known credential representations are redacted
   * (S62 A5), never content that merely looks encoded.
   */
  private scrub(value: unknown, secrets: KnownSecrets, max: number): unknown {
    const raw = JSON.stringify(value); if (!raw || Buffer.byteLength(raw) > max) throw provider();
    // Scrub keys as well as values; JSON reparse rejects collisions/prototype keys below.
    const walk = (item: unknown, depth = 0): unknown => {
      if (depth > 24) throw provider();
      if (typeof item === 'string') return scrubKnownSecrets(item, secrets);
      if (Array.isArray(item)) return item.map((child) => walk(child, depth + 1));
      if (item && typeof item === 'object') {
        const entries = Object.entries(item).filter(([key]) => !['__proto__', 'constructor', 'prototype'].includes(key))
          .map(([key, child]) => [scrubKnownSecrets(key, secrets), walk(child, depth + 1)] as const);
        if (new Set(entries.map(([key]) => key)).size !== entries.length) throw provider();
        return Object.fromEntries(entries);
      }
      return item;
    };
    return walk(value);
  }
  private async discover(rpc: (method: string, params?: unknown) => Promise<unknown>, serverId: string, secrets: () => KnownSecrets): Promise<Tool[]> {
    const result = await rpc('tools/list', {});
    const clean = this.scrub(result, secrets(), STUDIO_MCP_RUNTIME_LIMITS.discoveryBytes) as { tools?: unknown; nextCursor?: unknown };
    if (!clean || !Array.isArray(clean.tools) || clean.tools.length > STUDIO_MCP_RUNTIME_LIMITS.tools || clean.nextCursor) throw provider();
    const names = new Set<string>();
    return clean.tools.map((item: unknown) => {
      const tool = item as Record<string, unknown> | null; const name = tool?.name;
      if (typeof name !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name) || names.has(name)
        || /^(?:mcp_|connectors_|live_artifacts_|update_plan$|read_project_file$|write_project_file$|list_project_files$)/.test(name)) throw provider();
      names.add(name);
      const schema = tool!.inputSchema;
      if (!schema || typeof schema !== 'object' || Array.isArray(schema) || (schema as Record<string, unknown>).type !== 'object'
        || Buffer.byteLength(JSON.stringify(schema)) > STUDIO_MCP_RUNTIME_LIMITS.schemaBytes) throw provider();
      const parsedSchema = validateBoundedJsonObject(schema, 'schema'); if (!parsedSchema.ok) throw provider();
      const annotations = tool!.annotations;
      return { name: studioMcpToolName(serverId, name), remoteName: name, description: typeof tool!.description === 'string' ? tool!.description.slice(0, 1024) : '', inputSchema: parsedSchema.value,
        readOnlyHint: !!annotations && typeof annotations === 'object' && (annotations as Record<string, unknown>).readOnlyHint === true };
    });
  }
  private limit(grant: ToolTokenGrant): number { return grant.callLimit ?? STUDIO_RUN_CONNECTOR_CALL_LIMIT; }
  /**
   * Discovery is an outbound session too (S62 A2): each uncached server list
   * reserves a slot of the grant's call budget, is refused once the budget is
   * spent (nothing sent), and is audited with an empty tool name, its outcome
   * and duration. A successful list is cached for the grant and the pinned
   * server version (instance, generation, settings revision, token version),
   * so repeating it sends nothing; the cache dies with the run/refresh.
   */
  async list(grant: ToolTokenGrant, liveness?: () => void, options: { readOnlyHints?: boolean } = {}) {
    this.live(grant, 'list', liveness); const servers = [];
    const bound = grant.studioMcp!;
    for (const server of bound.servers) {
      const key = [grant.runId, grant.token, server.serverId, server.instanceId, server.generation, server.revision, server.tokenVersion ?? '', options.readOnlyHints ? 'r' : ''].join('\0');
      const cached = this.listCache.get(key);
      if (cached) { this.live(grant, 'list', liveness); servers.push({ serverId: server.serverId, tools: cached.tools }); continue; }
      const start = Date.now(); let outcome = 'MULTIUSER_MCP_PROVIDER_FAILED';
      const release = reserveStudioToolCall(grant.runId, this.grants.toolCalls(grant.runId), this.limit(grant));
      try {
        if (!release) throw new StudioMcpRuntimeError('CONNECTOR_RATE_LIMITED', 429);
        const tools = await this.session(grant, server.serverId, 'list', liveness, async (rpc, secrets): Promise<ListedTool[]> =>
          (await this.discover(rpc, server.serverId, secrets)).map(({ remoteName: _remote, readOnlyHint, ...tool }) => (options.readOnlyHints ? { ...tool, readOnlyHint } : tool))) as ListedTool[];
        this.live(grant, 'list', liveness); outcome = 'ok';
        if (this.listCache.size >= LIST_CACHE_LIMIT) this.listCache.delete(this.listCache.keys().next().value!);
        this.listCache.set(key, { runId: grant.runId, tools });
        servers.push({ serverId: server.serverId, tools });
      } catch (error) {
        outcome = error instanceof StudioMcpRuntimeError ? error.code : outcome; throw error;
      } finally {
        try { this.grants.appendMcpAudit({ owner: bound.ownerAccountId, serverId: server.serverId, runId: grant.runId, toolName: '', outcome, durationMs: Date.now() - start }); }
        finally { release?.(); }
      }
    }
    return { servers };
  }
  async execute(grant: ToolTokenGrant, args: Record<string, unknown>, liveness?: () => void, options: StudioMcpExecuteOptions = {}) {
    this.live(grant, 'execute', liveness);
    const serverId = typeof args.serverId === 'string' ? args.serverId : '';
    if (!grant.studioMcp!.servers.some((server) => server.serverId === serverId)) throw missing();
    if (Object.keys(args).some((key) => !['serverId', 'toolName', 'input'].includes(key))) throw new StudioMcpRuntimeError('BAD_REQUEST', 400);
    const parsed = validateBoundedJsonObject(args.input ?? {}, 'input'); if (!parsed.ok) throw new StudioMcpRuntimeError('BAD_REQUEST', 400);
    let toolName = ''; let release: (() => void) | null = null; const start = Date.now(); let outcome = 'refused';
    try {
      // Count reservations before discovery as well; parallel invocations cannot bypass the ceiling.
      release = reserveStudioToolCall(grant.runId, this.grants.toolCalls(grant.runId), this.limit(grant));
      if (!release) throw new StudioMcpRuntimeError('CONNECTOR_RATE_LIMITED', 429);
      const output = await this.session(grant, serverId, 'execute', liveness, async (rpc, secrets) => {
        const tools = await this.discover(rpc, serverId, secrets); this.live(grant, 'execute', liveness);
        const tool = tools.find((tool) => tool.name === args.toolName); if (!tool) throw missing(); toolName = tool.name;
        if (options.requireReadOnlyHint && !tool.readOnlyHint) throw new StudioMcpRuntimeError('LIVE_ARTIFACT_SOURCE_NOT_READ_ONLY', 403);
        try { assertJsonSchemaMatches(parsed.value, tool.inputSchema); } catch { throw new StudioMcpRuntimeError('CONNECTOR_INPUT_SCHEMA_MISMATCH', 400); }
        const result = await rpc('tools/call', { name: tool.remoteName, arguments: parsed.value }); this.live(grant, 'execute', liveness);
        return this.scrub(result, secrets(), STUDIO_MCP_RUNTIME_LIMITS.resultBytes);
      });
      this.live(grant, 'execute', liveness); outcome = 'ok'; return { serverId, toolName, output };
    } catch (error) {
      outcome = error instanceof StudioMcpRuntimeError ? error.code : 'MULTIUSER_MCP_PROVIDER_FAILED'; throw error;
    } finally {
      // Only locally validated, scrubbed tool names; never request arguments or remote results.
      try { this.grants.appendMcpAudit({ owner: grant.studioMcp!.ownerAccountId, serverId, runId: grant.runId, toolName, outcome, durationMs: Date.now() - start }); }
      finally { release?.(); }
    }
  }
  tools(grant: ToolTokenGrant, liveness?: () => void) {
    return { execute: async (name: string, args: Record<string, unknown>) => {
      if (name === 'mcp_list' && !Object.keys(args).length) return this.list(grant, liveness);
      if (name === 'mcp_execute') return this.execute(grant, args, liveness);
      throw new StudioMcpRuntimeError('BAD_REQUEST', 400);
    } };
  }
}
