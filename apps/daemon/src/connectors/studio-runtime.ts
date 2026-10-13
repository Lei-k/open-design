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
import { knownSecrets, scrubKnownSecrets, type KnownSecrets } from '../mcp-client/studio-untrusted.js';

export class StudioConnectorRuntimeError extends Error {
  constructor(readonly code: ApiErrorCode, readonly status = 403) { super(code); }
}
const unavailable = () => new StudioConnectorRuntimeError('CONNECTOR_NOT_GRANTED');
/**
 * Provider output with credential-named keys dropped and every known
 * representation of the company key (raw, percent/form/base64-encoded, or a
 * 12-character fragment) redacted from keys and values (S62 A5). Ordinary
 * content is never shape-filtered.
 */
function redactProvider(value: unknown, apiKey: string, depth = 0, secrets: KnownSecrets = knownSecrets([apiKey])): unknown {
  if (depth > 16) throw new StudioConnectorRuntimeError('CONNECTOR_OUTPUT_TOO_LARGE', 502);
  if (Array.isArray(value)) return value.map((item) => redactProvider(item, apiKey, depth + 1, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !isForbiddenConnectorOutputKey(key) && !['__proto__', 'constructor', 'prototype'].includes(key)
      && !/(?:api|access|private)[_-]?key/i.test(key))
    .map(([key, item]) => [scrubKnownSecrets(key, secrets), redactProvider(item, apiKey, depth + 1, secrets)]));
  return typeof value === 'string' ? scrubKnownSecrets(value, secrets) : value;
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

/** How long a failed provider discovery is remembered (S62 Repair 1): repeats inside it send nothing. */
export const STUDIO_CONNECTOR_DISCOVERY_FAILURE_TTL_MS = 10_000;

/**
 * One execute's budget slot (S62 Repair 1). It is reserved on first use — the
 * provider discovery the execute needs, or the provider call itself — and
 * covers both, like a remote MCP execute (discovery + call, one slot, one
 * audit row). Released once, after the audit row that counts it is written.
 */
interface CallSlot { take(): boolean; readonly taken: boolean; release(): void }

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
  /** Negative cache: a failed provider discovery per owner/key/connector, until the stored time. */
  private readonly discoveryFailed = new Map<string, number>();
  /** In-flight provider discoveries per run and connector; concurrent misses share one request. */
  private readonly discovering = new Map<string, Promise<ConnectorCatalogDefinition>>();
  /** In-flight provider requests per run; a cancel aborts them. */
  private readonly inflight = new Map<string, Set<AbortController>>();
  private runLive: (runId: string) => boolean = () => true;
  /** Short-lived non-run grants (Live Artifact refresh, S62), live only while registered. */
  private readonly ephemeral = new Set<string>();
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
  /** A non-run grant id (never a run id): live only between these two calls; release aborts its requests. */
  registerEphemeral(id: string): void { this.ephemeral.add(id); }
  releaseEphemeral(id: string): void { this.ephemeral.delete(id); this.abortRun(id); }
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
    if (!(this.ephemeral.has(grant.runId) || this.runLive(grant.runId))) throw new StudioConnectorRuntimeError('TOOL_TOKEN_INVALID', 401);
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
  private slot(grant: ToolTokenGrant): CallSlot {
    let release: (() => void) | null = null; let taken = false;
    return {
      take: () => {
        if (!taken) { taken = true; release = reserveStudioToolCall(grant.runId, this.grants.toolCalls(grant.runId), grant.callLimit ?? STUDIO_RUN_CONNECTOR_CALL_LIMIT); }
        return release !== null;
      },
      get taken() { return taken; },
      release: () => { const done = release; release = null; done?.(); },
    };
  }
  /**
   * The connector's tools: static ones, or provider metadata (S59). Provider
   * discovery is an outbound request like any other (S62 Repair 1, mirroring the
   * S62 A2 MCP rule): a miss takes a slot of the grant's call budget — the
   * calling execute's own slot, or for a list its own reserved slot — and is
   * refused with nothing sent once the budget is spent; a list's discovery is
   * audited (empty tool, outcome, duration). Successful metadata is cached for a
   * minute, a failure for `STUDIO_CONNECTOR_DISCOVERY_FAILURE_TTL_MS`, and
   * concurrent misses of one run share a single in-flight request.
   */
  private async hydrated(grant: ToolTokenGrant, id: string, live: () => void, signal: AbortSignal,
    options: { force?: boolean; slot?: CallSlot } = {}): Promise<ConnectorCatalogDefinition> {
    const bound = grant.studioConnectors!;
    live();
    const definition = this.definition(id);
    if (!definition || !bound.connectorIds.includes(id)) throw unavailable();
    if (definition.tools.length && !options.force) return definition;
    const cacheKey = `${bound.ownerAccountId}:${bound.credentialRevision}:${id}`;
    const cached = this.metadata.get(cacheKey);
    if (cached && cached.expires > Date.now()) return cached.definition;
    if ((this.discoveryFailed.get(cacheKey) ?? 0) > Date.now()) throw new StudioConnectorRuntimeError('MULTIUSER_CONNECTOR_PROVIDER_FAILED', 502);
    const flightKey = `${grant.runId}\0${cacheKey}`;
    const inflight = this.discovering.get(flightKey);
    if (inflight) {
      // Joined, not sent: this caller's own authority is re-checked once it settles.
      const joined = await inflight.catch((error: unknown) => { live(); throw error; });
      live(); return joined;
    }
    const attempt = this.discover(grant, id, definition, cacheKey, live, signal, options.slot);
    this.discovering.set(flightKey, attempt);
    try { return await attempt; } finally { if (this.discovering.get(flightKey) === attempt) this.discovering.delete(flightKey); }
  }
  private async discover(grant: ToolTokenGrant, id: string, definition: ConnectorCatalogDefinition, cacheKey: string, live: () => void,
    signal: AbortSignal, slot: CallSlot | undefined): Promise<ConnectorCatalogDefinition> {
    const bound = grant.studioConnectors!;
    const start = Date.now(); let outcome = 'MULTIUSER_CONNECTOR_PROVIDER_FAILED';
    const own = slot ? null : this.slot(grant);
    try {
      // Synchronous authority immediately before the reservation and discovery; no host provider/config.
      live();
      if (!(slot ?? own!).take()) throw new StudioConnectorRuntimeError('CONNECTOR_RATE_LIMITED', 429);
      const credential = this.company.credential();
      const slug = definition.providerConnectorId ?? id;
      live();
      let items: Record<string, unknown>[];
      try { items = await this.provider.toolMetadata(credential!.apiKey, slug, signal); }
      catch {
        live();
        if (!signal.aborted) {
          if (this.discoveryFailed.size >= 128) this.discoveryFailed.delete(this.discoveryFailed.keys().next().value!);
          this.discoveryFailed.set(cacheKey, Date.now() + STUDIO_CONNECTOR_DISCOVERY_FAILURE_TTL_MS);
        }
        throw new StudioConnectorRuntimeError('MULTIUSER_CONNECTOR_PROVIDER_FAILED', 502);
      }
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
      this.discoveryFailed.delete(cacheKey);
      outcome = 'ok';
      return hydrated;
    } catch (error) {
      outcome = error instanceof StudioConnectorRuntimeError ? error.code : outcome; throw error;
    } finally {
      // A list's own discovery is audited here (and then counts); an execute audits its slot once.
      if (own) {
        try { this.grants.appendToolAudit({ owner: bound.ownerAccountId, connectorId: id, toolSlug: '', runId: grant.runId, outcome, durationMs: Date.now() - start }); }
        finally { own.release(); }
      }
    }
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
    // One slot covers this execute's provider discovery (if any) and its provider call (S62 Repair 1).
    const slot = this.slot(grant); const start = Date.now(); let slug = '';
    const audit = (outcome: string) => this.grants.appendToolAudit({ owner: bound.ownerAccountId, connectorId: id, toolSlug: slug, runId: grant.runId,
      outcome, durationMs: Date.now() - start });
    try {
      let definition = await this.hydrated(grant, id, live, tracked.signal, { slot });
      if (!definition.tools.some((item) => item.name === args.toolName)) definition = await this.hydrated(grant, id, live, tracked.signal, { force: true, slot });
      const tool = definition.tools.find((item) => item.name === args.toolName && definition.allowedToolNames.includes(item.name)
        && item.safety.sideEffect === 'read' && item.safety.approval === 'auto');
      if (!tool) throw unavailable();
      const input = validateBoundedJsonObject(args.input ?? {}, 'input');
      if (!input.ok) throw new StudioConnectorRuntimeError('BAD_REQUEST', 400);
      try { assertJsonSchemaMatches(input.value, tool.inputSchemaJson); } catch { throw new StudioConnectorRuntimeError('CONNECTOR_INPUT_SCHEMA_MISMATCH', 400); }
      slug = tool.providerToolId ?? tool.name;
      const credential = this.company.credential();
      // No await between the authority/liveness check, the slot reservation and the provider request.
      live();
      if (!slot.take()) throw new StudioConnectorRuntimeError('CONNECTOR_RATE_LIMITED', 429);
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
      // Refused before any slot was asked for (local validation, cached metadata): nothing sent, nothing counted.
      if (!slot.taken) throw error;
      // Authority or liveness loss outranks a concurrent provider rejection.
      try { live(); } catch (refusal) {
        const safe = refusal instanceof StudioConnectorRuntimeError ? refusal : new StudioConnectorRuntimeError('MULTIUSER_CONNECTOR_AUTHORITY_CHANGED', 409);
        audit(safe.code); throw safe;
      }
      const safe = error instanceof StudioConnectorRuntimeError ? error : new StudioConnectorRuntimeError('MULTIUSER_CONNECTOR_PROVIDER_FAILED', 502);
      audit(safe.code); throw safe;
    } finally {
      // The audit row (written synchronously above) now counts this call; release its reservation.
      slot.release(); tracked.release();
    }
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
