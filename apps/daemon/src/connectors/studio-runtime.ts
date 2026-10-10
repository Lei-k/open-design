import { reserveStudioToolCall } from '../services/studio-tool-call-budget.js';
import type Database from 'better-sqlite3';
import type { ApiErrorCode } from '@open-design/contracts';
import type { AuthActor } from '../services/auth-service.js';
import { toolTokenRegistry as defaultToolTokenRegistry, type StudioConnectorGrant, type ToolTokenGrant, type ToolTokenRegistry } from '../tool-tokens.js';
import type { AuthStore } from '../storage/auth-store.js';
import { CompanyComposioStore, StudioConnectorGrantStore, StudioConnectorStore } from '../storage/studio-connectors.js';
import { composioToolDefinition, getStaticComposioCatalogDefinitions } from './composio.js';
import { connectorDefinitionToDetail, type ConnectorCatalogDefinition } from './catalog.js';
import { assertJsonSchemaMatches, isForbiddenConnectorOutputKey, protectConnectorOutput } from './service.js';
import { validateBoundedJsonObject, validateBoundedJsonValue } from '../live-artifacts/schema.js';
import { StudioComposioClient } from './studio-composio.js';

export class StudioConnectorRuntimeError extends Error {
  constructor(readonly code: ApiErrorCode, readonly status = 403) { super(code); }
}
const unavailable = () => new StudioConnectorRuntimeError('CONNECTOR_NOT_GRANTED');
function redactProvider(value: unknown, apiKey: string, depth = 0): unknown {
  if (depth > 16) throw new StudioConnectorRuntimeError('CONNECTOR_OUTPUT_TOO_LARGE', 502);
  if (Array.isArray(value)) return value.map((item) => redactProvider(item, apiKey, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !isForbiddenConnectorOutputKey(key) && !['__proto__', 'constructor', 'prototype'].includes(key)
      && !/(?:api|access|private)[_-]?key/i.test(key))
    .map(([key, item]) => [key, redactProvider(item, apiKey, depth + 1)]));
  return typeof value === 'string' ? value.split(apiKey).join('[redacted]') : value;
}

/**
 * Upper bound on a run's connector grant (S60 A2). The grant is revoked when
 * the run reaches a terminal state (or is cancelled); this ceiling only stops a
 * run that never settles from holding a grant forever. It covers the longest
 * bounded run: a full ordered pipeline (`STUDIO_PIPELINE_MAX_STAGES` = 32) of
 * company/own-key turns at `COMPANY_OPENAI_TURN_TIMEOUT_MS` (10 min) each is
 * 5 h 20 min. Personal Codex turns have no wall-clock limit; past this ceiling
 * their connector calls get the typed `TOOL_TOKEN_EXPIRED` refusal.
 */
export const STUDIO_RUN_CONNECTOR_GRANT_MAX_MS = 6 * 60 * 60 * 1000;
/** Provider calls one run may make, counted with completed and in-flight calls (S60 A5). */
export const STUDIO_RUN_CONNECTOR_CALL_LIMIT = 60;

/**
 * A synchronous check supplied by the caller (the run worker's own authority:
 * not cancelled, still active, still authorized). It throws a typed
 * `StudioConnectorRuntimeError` to refuse. The runtime evaluates it together
 * with the grant's account authority and the tool token's liveness before
 * every provider request and after every await.
 */
export type StudioConnectorLiveness = () => void;

const LIST = { endpoint: '/api/tools/connectors/list', operation: 'connectors:list' } as const;
const EXECUTE = { endpoint: '/api/tools/connectors/execute', operation: 'connectors:execute' } as const;

/** A run uses exactly its owner's captured connections. All checks are synchronous
 * at the provider boundary. Host credentials and client identities never enter it. */
export class StudioConnectorRuntime {
  private readonly company: CompanyComposioStore;
  private readonly store: StudioConnectorStore;
  private readonly grants: StudioConnectorGrantStore;
  private readonly auth: AuthStore;
  private readonly tokens: ToolTokenRegistry;
  private readonly provider: StudioComposioClient;
  private readonly metadata = new Map<string, { expires: number; definition: ConnectorCatalogDefinition }>();
  /** In-flight provider requests per run; a cancel aborts them. */
  private readonly inflight = new Map<string, Set<AbortController>>();
  private runLive: (runId: string) => boolean = () => true;
  constructor(private readonly deps: {
    db: Database.Database; dataRoot: string;
    /** The daemon's existing auth store handle (never a second one). */
    auth: AuthStore;
    sessionCurrent(actor: AuthActor): boolean; fetch?: typeof fetch;
    /** The registry that issued the run's tool tokens; the process-wide one by default. */
    tokens?: ToolTokenRegistry;
  }) {
    this.company = new CompanyComposioStore(deps.db, deps.dataRoot);
    this.store = new StudioConnectorStore(deps.db);
    this.grants = new StudioConnectorGrantStore(deps.db);
    this.auth = deps.auth;
    this.tokens = deps.tokens ?? defaultToolTokenRegistry;
    this.provider = new StudioComposioClient(deps.fetch ?? fetch);
  }
  /** Run state as the run service sees it: false once a run is cancelled or terminal. */
  setRunLiveness(check: (runId: string) => boolean): void { this.runLive = check; }
  /** A cancel or terminal transition: abort the run's in-flight discovery and provider calls. */
  abortRun(runId: string): void {
    const controllers = this.inflight.get(runId);
    this.inflight.delete(runId);
    for (const controller of controllers ?? []) controller.abort();
  }
  invalidateAccount(owner: string): void { this.grants.invalidate(owner); }
  /** The auth store is shared and owned by the daemon; only in-flight work stops here. */
  close(): void { for (const runId of [...this.inflight.keys()]) this.abortRun(runId); }
  capture(actor: AuthActor, ids: readonly string[]): StudioConnectorGrant | undefined {
    if (!ids.length) return undefined;
    const key = this.company.read();
    const connections = [...new Set(ids)].map((connectorId) => {
      const row = this.store.connection(actor.accountId, connectorId);
      const definition = this.definition(connectorId);
      if (!key.configured || !definition || row?.status !== 'connected' || !row.provider_connection_id
        || row.credential_revision !== key.credentialRevision) throw unavailable();
      return { connectorId, providerConnectionId: row.provider_connection_id };
    });
    const grant: StudioConnectorGrant = { ownerAccountId: actor.accountId, connectorIds: connections.map((row) => row.connectorId), connections,
      credentialRevision: key.credentialRevision, revocationVersion: this.grants.epoch(actor.accountId),
      pilotRevision: this.auth.getStudioPilot(actor.accountId).revision, role: actor.role,
      ...(actor.sessionId.startsWith('routine:') ? {} : { actor: { ...actor } }) };
    this.assert(grant);
    return grant;
  }
  private definition(id: string) { return getStaticComposioCatalogDefinitions().find((item) => item.id === id && item.authentication === 'composio'); }
  /** The grant's account authority: account, password, role, pilot, epoch, session, key and bindings. */
  assert(grant: StudioConnectorGrant): void {
    const account = this.auth.getAccountById(grant.ownerAccountId);
    const pilot = this.auth.getStudioPilot(grant.ownerAccountId);
    if (!account?.active || account.passwordState !== 'set' || account.role !== grant.role || !pilot.studioPilot
      || pilot.revision !== grant.pilotRevision || this.grants.epoch(grant.ownerAccountId) !== grant.revocationVersion
      || grant.actor && !this.deps.sessionCurrent(grant.actor)) throw new StudioConnectorRuntimeError('MULTIUSER_CONNECTOR_AUTHORITY_CHANGED', 409);
    const key = this.company.read();
    if (!key.configured || key.credentialRevision !== grant.credentialRevision) throw new StudioConnectorRuntimeError('MULTIUSER_CONNECTOR_AUTHORITY_CHANGED', 409);
    for (const bound of grant.connections) {
      const row = this.store.connection(grant.ownerAccountId, bound.connectorId);
      if (row?.status !== 'connected' || row.provider_connection_id !== bound.providerConnectionId || row.credential_revision !== grant.credentialRevision)
        throw new StudioConnectorRuntimeError('MULTIUSER_CONNECTOR_AUTHORITY_CHANGED', 409);
    }
  }
  /**
   * Invariant (S60 A1): a provider request is made only while, at that very
   * instant, the run's tool token is still valid (not revoked by a cancel or
   * terminal state, not expired, still scoped to this endpoint), the run is
   * still live, the caller's own authority holds, and the grant's account
   * authority holds. Call it synchronously immediately before every provider
   * request and again after every await; on failure nothing more is sent.
   */
  private assertLive(grant: ToolTokenGrant, scope: typeof LIST | typeof EXECUTE, liveness?: StudioConnectorLiveness): void {
    const validation = this.tokens.validate(grant.token, scope);
    if (!validation.ok) throw new StudioConnectorRuntimeError(validation.code, validation.code.endsWith('DENIED') ? 403 : 401);
    if (!this.runLive(grant.runId)) throw new StudioConnectorRuntimeError('TOOL_TOKEN_INVALID', 401);
    liveness?.();
    this.assert(grant.studioConnectors!);
  }
  private track(runId: string): { signal: AbortSignal; release(): void } {
    const controller = new AbortController();
    const set = this.inflight.get(runId) ?? new Set<AbortController>();
    set.add(controller); this.inflight.set(runId, set);
    return { signal: controller.signal, release: () => {
      const current = this.inflight.get(runId);
      current?.delete(controller);
      if (current?.size === 0) this.inflight.delete(runId);
    } };
  }
  private async hydrated(grant: ToolTokenGrant, id: string, live: () => void, signal: AbortSignal, force = false): Promise<ConnectorCatalogDefinition> {
    const bound = grant.studioConnectors!;
    live();
    const definition = this.definition(id);
    if (!definition || !bound.connectorIds.includes(id)) throw unavailable();
    if (definition.tools.length && !force) return definition;
    const cacheKey = `${bound.ownerAccountId}:${bound.credentialRevision}:${id}`;
    const cached = this.metadata.get(cacheKey);
    if (cached && cached.expires > Date.now()) return cached.definition;
    const credential = this.company.credential();
    const slug = definition.providerConnectorId ?? id;
    // Synchronous authority immediately before discovery too; no host provider/config.
    live();
    let items: Record<string, unknown>[];
    try { items = await this.provider.toolMetadata(credential!.apiKey, slug, signal); }
    catch { live(); throw new StudioConnectorRuntimeError('MULTIUSER_CONNECTOR_PROVIDER_FAILED', 502); }
    live();
    const live_ = items.filter((item) => {
      const toolkit = item.toolkit as { slug?: unknown } | undefined;
      return (toolkit?.slug === undefined || String(toolkit.slug).toLowerCase() === slug.toLowerCase())
        && typeof item.slug === 'string' && /^[A-Za-z0-9_]{1,200}$/.test(item.slug)
        && item.slug.replace(/[^a-z0-9]/gi, '').toLowerCase().startsWith(slug.replace(/[^a-z0-9]/gi, '').toLowerCase());
    }).map((item) => composioToolDefinition(id, redactProvider(item, credential!.apiKey) as Record<string, unknown>));
    const merged = new Map(definition.tools.map((tool) => [tool.name, tool]));
    for (const tool of live_) if (!merged.has(tool.name) && tool.safety.sideEffect === 'read' && tool.safety.approval === 'auto') merged.set(tool.name, tool);
    const hydrated = { ...definition, tools: [...merged.values()], allowedToolNames: [...merged.keys()] };
    if (this.metadata.size >= 128) this.metadata.delete(this.metadata.keys().next().value!);
    this.metadata.set(cacheKey, { expires: Date.now() + 60_000, definition: hydrated });
    return hydrated;
  }
  async list(grant: ToolTokenGrant, useCase?: unknown, liveness?: StudioConnectorLiveness) {
    if (useCase !== undefined && useCase !== 'personal_daily_digest') throw new StudioConnectorRuntimeError('BAD_REQUEST', 400);
    const bound = grant.studioConnectors;
    if (!bound?.connectorIds.length) throw unavailable();
    const live = () => this.assertLive(grant, LIST, liveness);
    live();
    const tracked = this.track(grant.runId);
    try {
      const connectors = [];
      for (const id of bound.connectorIds) {
        const definition = await this.hydrated(grant, id, live, tracked.signal);
        const detail = connectorDefinitionToDetail(definition);
        const tools = detail.tools.filter((tool) => definition.allowedToolNames.includes(tool.name)
          && tool.safety.sideEffect === 'read' && tool.safety.approval === 'auto'
          && (useCase === undefined || tool.curation?.useCases?.includes(useCase)));
        if (tools.length) connectors.push({ ...detail, status: 'connected', auth: { provider: 'composio', configured: true }, tools });
      }
      live();
      if (!connectors.length) throw unavailable();
      return { connectors };
    } finally { tracked.release(); }
  }
  async execute(grant: ToolTokenGrant, args: Record<string, unknown>, liveness?: StudioConnectorLiveness) {
    const bound = grant.studioConnectors;
    const id = typeof args.connectorId === 'string' ? args.connectorId : '';
    if (!bound || !bound.connectorIds.includes(id) || typeof args.toolName !== 'string' || !args.toolName.startsWith(`${id}.`)) throw unavailable();
    if (Object.keys(args).some((key) => !['connectorId', 'toolName', 'input'].includes(key))) throw new StudioConnectorRuntimeError('BAD_REQUEST', 400);
    const live = () => this.assertLive(grant, EXECUTE, liveness);
    live();
    const tracked = this.track(grant.runId);
    try {
      let definition = await this.hydrated(grant, id, live, tracked.signal);
      if (!definition.tools.some((item) => item.name === args.toolName)) definition = await this.hydrated(grant, id, live, tracked.signal, true);
      const tool = definition.tools.find((item) => item.name === args.toolName && definition.allowedToolNames.includes(item.name)
        && item.safety.sideEffect === 'read' && item.safety.approval === 'auto');
      if (!tool) throw unavailable();
      const input = validateBoundedJsonObject(args.input ?? {}, 'input');
      if (!input.ok) throw new StudioConnectorRuntimeError('BAD_REQUEST', 400);
      try { assertJsonSchemaMatches(input.value, tool.inputSchemaJson); } catch { throw new StudioConnectorRuntimeError('CONNECTOR_INPUT_SCHEMA_MISMATCH', 400); }
      const slug = tool.providerToolId ?? tool.name;
      const audit = (outcome: string) => this.grants.appendToolAudit({ owner: bound.ownerAccountId, connectorId: id, toolSlug: slug, runId: grant.runId, outcome });
      let releaseSlot: (() => void) | null = null;
      try {
        const credential = this.company.credential();
        // No await between the authority/liveness check, the slot reservation and the provider request.
        live();
        releaseSlot = reserveStudioToolCall(grant.runId, this.grants.toolCalls(grant.runId), STUDIO_RUN_CONNECTOR_CALL_LIMIT);
        if (!releaseSlot) throw new StudioConnectorRuntimeError('CONNECTOR_RATE_LIMITED', 429);
        const result = await this.provider.executeTool(credential!.apiKey, slug, this.store.entityFor(bound.ownerAccountId),
          bound.connections.find((row) => row.connectorId === id)!.providerConnectionId, input.value, tracked.signal);
        live();
        const withoutKey = redactProvider(result, credential!.apiKey);
        const parsed = validateBoundedJsonValue(withoutKey, 'output');
        if (!parsed.ok) throw new StudioConnectorRuntimeError('CONNECTOR_OUTPUT_TOO_LARGE', 502);
        const protectedOutput = protectConnectorOutput(parsed.value);
        audit('ok');
        return { ok: true, connectorId: id, toolName: tool.name, output: protectedOutput.output };
      } catch (error) {
        // Authority or liveness loss outranks a concurrent provider rejection.
        try { live(); } catch (refusal) {
          const safe = refusal instanceof StudioConnectorRuntimeError ? refusal : new StudioConnectorRuntimeError('MULTIUSER_CONNECTOR_AUTHORITY_CHANGED', 409);
          audit(safe.code); throw safe;
        }
        const safe = error instanceof StudioConnectorRuntimeError ? error : new StudioConnectorRuntimeError('MULTIUSER_CONNECTOR_PROVIDER_FAILED', 502);
        audit(safe.code); throw safe;
      } finally {
        // The audit row (written synchronously above) now counts this call; release its reservation.
        releaseSlot?.();
      }
    } finally { tracked.release(); }
  }
  tools(grant: ToolTokenGrant, liveness?: StudioConnectorLiveness) {
    return { execute: async (name: string, args: Record<string, unknown>) => {
      if (name === 'connectors_list') {
        if (Object.keys(args).some((key) => key !== 'useCase') || args.useCase !== undefined && args.useCase !== 'personal_daily_digest')
          throw new StudioConnectorRuntimeError('BAD_REQUEST', 400);
        return this.list(grant, args.useCase, liveness);
      }
      if (name === 'connectors_execute') return this.execute(grant, args, liveness);
      throw unavailable();
    } };
  }
}
