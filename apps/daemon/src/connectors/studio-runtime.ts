import type Database from 'better-sqlite3';
import type { ApiErrorCode } from '@open-design/contracts';
import type { AuthActor } from '../services/auth-service.js';
import type { StudioConnectorGrant, ToolTokenGrant } from '../tool-tokens.js';
import { AuthStore } from '../storage/auth-store.js';
import { CompanyComposioStore, StudioConnectorStore } from '../storage/studio-connectors.js';
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


/** A run uses exactly its owner's captured connections. All checks are synchronous
 * at the provider boundary. Host credentials and client identities never enter it. */
export class StudioConnectorRuntime {
  private readonly company: CompanyComposioStore;
  private readonly store: StudioConnectorStore;
  private readonly auth: AuthStore;
  private readonly provider: StudioComposioClient;
  private readonly metadata = new Map<string, { expires: number; definition: ConnectorCatalogDefinition }>();
  constructor(private readonly deps: { db: Database.Database; dataRoot: string; sessionCurrent(actor: AuthActor): boolean; fetch?: typeof fetch }) {
    this.company = new CompanyComposioStore(deps.db, deps.dataRoot);
    this.store = new StudioConnectorStore(deps.db);
    this.auth = AuthStore.open({ dataRoot: deps.dataRoot });
    this.provider = new StudioComposioClient(deps.fetch ?? fetch);
    deps.db.exec(`CREATE TABLE IF NOT EXISTS studio_connector_grant_epochs (account_id TEXT PRIMARY KEY, version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS studio_connector_tool_audit (id INTEGER PRIMARY KEY, actor_account_id TEXT NOT NULL,
        connector_id TEXT NOT NULL, tool_slug TEXT NOT NULL, run_id TEXT NOT NULL, outcome TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TRIGGER IF NOT EXISTS studio_connector_tool_audit_immutable BEFORE UPDATE ON studio_connector_tool_audit
        BEGIN SELECT RAISE(ABORT, 'audit rows are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS studio_connector_tool_audit_no_delete BEFORE DELETE ON studio_connector_tool_audit
        BEGIN SELECT RAISE(ABORT, 'audit rows are immutable'); END;`);
  }
  private epoch(owner: string): number {
    return (this.deps.db.prepare('SELECT version FROM studio_connector_grant_epochs WHERE account_id = ?').get(owner) as { version: number } | undefined)?.version ?? 0;
  }
  invalidateAccount(owner: string): void {
    this.deps.db.prepare(`INSERT INTO studio_connector_grant_epochs VALUES (?, 1)
      ON CONFLICT(account_id) DO UPDATE SET version = version + 1`).run(owner);
  }
  close(): void { this.auth.close(); }
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
      credentialRevision: key.credentialRevision, revocationVersion: this.epoch(actor.accountId),
      pilotRevision: this.auth.getStudioPilot(actor.accountId).revision, role: actor.role,
      ...(actor.sessionId.startsWith('routine:') ? {} : { actor: { ...actor } }) };
    this.assert(grant);
    return grant;
  }
  private definition(id: string) { return getStaticComposioCatalogDefinitions().find((item) => item.id === id && item.authentication === 'composio'); }
  assert(grant: StudioConnectorGrant): void {
    const account = this.auth.getAccountById(grant.ownerAccountId);
    const pilot = this.auth.getStudioPilot(grant.ownerAccountId);
    if (!account?.active || account.passwordState !== 'set' || account.role !== grant.role || !pilot.studioPilot
      || pilot.revision !== grant.pilotRevision || this.epoch(grant.ownerAccountId) !== grant.revocationVersion
      || grant.actor && !this.deps.sessionCurrent(grant.actor)) throw new StudioConnectorRuntimeError('MULTIUSER_CONNECTOR_AUTHORITY_CHANGED', 409);
    const key = this.company.read();
    if (!key.configured || key.credentialRevision !== grant.credentialRevision) throw new StudioConnectorRuntimeError('MULTIUSER_CONNECTOR_AUTHORITY_CHANGED', 409);
    for (const bound of grant.connections) {
      const row = this.store.connection(grant.ownerAccountId, bound.connectorId);
      if (row?.status !== 'connected' || row.provider_connection_id !== bound.providerConnectionId || row.credential_revision !== grant.credentialRevision)
        throw new StudioConnectorRuntimeError('MULTIUSER_CONNECTOR_AUTHORITY_CHANGED', 409);
    }
  }
  private async hydrated(bound: StudioConnectorGrant, id: string, force = false): Promise<ConnectorCatalogDefinition> {
    this.assert(bound);
    const definition = this.definition(id);
    if (!definition || !bound.connectorIds.includes(id)) throw unavailable();
    if (definition.tools.length && !force) return definition;
    const cacheKey = `${bound.ownerAccountId}:${bound.credentialRevision}:${id}`;
    const cached = this.metadata.get(cacheKey);
    if (cached && cached.expires > Date.now()) return cached.definition;
    const credential = this.company.credential();
    const slug = definition.providerConnectorId ?? id;
    // Synchronous authority immediately before discovery too; no host provider/config.
    this.assert(bound);
    let items: Record<string, unknown>[];
    try { items = await this.provider.toolMetadata(credential!.apiKey, slug); }
    catch { this.assert(bound); throw new StudioConnectorRuntimeError('MULTIUSER_CONNECTOR_PROVIDER_FAILED', 502); }
    this.assert(bound);
    const live = items.filter((item) => {
      const toolkit = item.toolkit as { slug?: unknown } | undefined;
      return (toolkit?.slug === undefined || String(toolkit.slug).toLowerCase() === slug.toLowerCase())
        && typeof item.slug === 'string' && /^[A-Za-z0-9_]{1,200}$/.test(item.slug)
        && item.slug.replace(/[^a-z0-9]/gi, '').toLowerCase().startsWith(slug.replace(/[^a-z0-9]/gi, '').toLowerCase());
    }).map((item) => composioToolDefinition(id, redactProvider(item, credential!.apiKey) as Record<string, unknown>));
    const safe = live;
    const merged = new Map(definition.tools.map((tool) => [tool.name, tool]));
    for (const tool of safe) if (!merged.has(tool.name) && tool.safety.sideEffect === 'read' && tool.safety.approval === 'auto') merged.set(tool.name, tool);
    const hydrated = { ...definition, tools: [...merged.values()], allowedToolNames: [...merged.keys()] };
    if (this.metadata.size >= 128) this.metadata.delete(this.metadata.keys().next().value!);
    this.metadata.set(cacheKey, { expires: Date.now() + 60_000, definition: hydrated });
    return hydrated;
  }
  async list(grant: ToolTokenGrant, useCase?: unknown) {
    if (useCase !== undefined && useCase !== 'personal_daily_digest') throw new StudioConnectorRuntimeError('BAD_REQUEST', 400);
    const bound = grant.studioConnectors;
    if (!bound?.connectorIds.length) throw unavailable();
    this.assert(bound);
    const connectors = [];
    for (const id of bound.connectorIds) {
      const definition = await this.hydrated(bound, id);
      const detail = connectorDefinitionToDetail(definition);
      const tools = detail.tools.filter((tool) => definition.allowedToolNames.includes(tool.name)
        && tool.safety.sideEffect === 'read' && tool.safety.approval === 'auto'
        && (useCase === undefined || tool.curation?.useCases?.includes(useCase)));
      if (tools.length) connectors.push({ ...detail, status: 'connected', auth: { provider: 'composio', configured: true }, tools });
    }
    this.assert(bound);
    if (!connectors.length) throw unavailable();
    return { connectors };
  }
  async execute(grant: ToolTokenGrant, args: Record<string, unknown>) {
    const bound = grant.studioConnectors;
    const id = typeof args.connectorId === 'string' ? args.connectorId : '';
    if (!bound || !bound.connectorIds.includes(id) || typeof args.toolName !== 'string' || !args.toolName.startsWith(`${id}.`)) throw unavailable();
    if (Object.keys(args).some((key) => !['connectorId', 'toolName', 'input'].includes(key))) throw new StudioConnectorRuntimeError('BAD_REQUEST', 400);
    let definition = await this.hydrated(bound, id);
    if (!definition.tools.some((item) => item.name === args.toolName)) definition = await this.hydrated(bound, id, true);
    const tool = definition.tools.find((item) => item.name === args.toolName && definition.allowedToolNames.includes(item.name)
      && item.safety.sideEffect === 'read' && item.safety.approval === 'auto');
    if (!tool) throw unavailable();
    const input = validateBoundedJsonObject(args.input ?? {}, 'input');
    if (!input.ok) throw new StudioConnectorRuntimeError('BAD_REQUEST', 400);
    try { assertJsonSchemaMatches(input.value, tool.inputSchemaJson); } catch { throw new StudioConnectorRuntimeError('CONNECTOR_INPUT_SCHEMA_MISMATCH', 400); }
    const slug = tool.providerToolId ?? tool.name;
    const audit = (outcome: string) => this.deps.db.prepare(`INSERT INTO studio_connector_tool_audit
      (actor_account_id, connector_id, tool_slug, run_id, outcome, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(bound.ownerAccountId, id, slug, grant.runId, outcome, Date.now());
    try {
      const credential = this.company.credential();
      this.assert(bound);
      // No await between authority and the provider request.
      const count = this.deps.db.prepare('SELECT COUNT(*) AS n FROM studio_connector_tool_audit WHERE run_id = ?').get(grant.runId) as { n: number };
      if (count.n >= 60) throw new StudioConnectorRuntimeError('CONNECTOR_RATE_LIMITED', 429);
      const result = await this.provider.executeTool(credential!.apiKey, slug, this.store.entityFor(bound.ownerAccountId),
        bound.connections.find((row) => row.connectorId === id)!.providerConnectionId, input.value);
      this.assert(bound);
      const withoutKey = redactProvider(result, credential!.apiKey);
      const parsed = validateBoundedJsonValue(withoutKey, 'output');
      if (!parsed.ok) throw new StudioConnectorRuntimeError('CONNECTOR_OUTPUT_TOO_LARGE', 502);
      const protectedOutput = protectConnectorOutput(parsed.value);
      audit('ok');
      return { ok: true, connectorId: id, toolName: tool.name, output: protectedOutput.output };
    } catch (error) {
      // Authority loss outranks a concurrent provider rejection.
      try { this.assert(bound); } catch (authority) { audit('MULTIUSER_CONNECTOR_AUTHORITY_CHANGED'); throw authority; }
      const safe = error instanceof StudioConnectorRuntimeError ? error : new StudioConnectorRuntimeError('MULTIUSER_CONNECTOR_PROVIDER_FAILED', 502);
      audit(safe.code); throw safe;
    }
  }
  tools(grant: ToolTokenGrant) {
    return { execute: async (name: string, args: Record<string, unknown>) => {
      if (name === 'connectors_list') {
        if (Object.keys(args).some((key) => key !== 'useCase') || args.useCase !== undefined && args.useCase !== 'personal_daily_digest')
          throw new StudioConnectorRuntimeError('BAD_REQUEST', 400);
        return this.list(grant, args.useCase);
      }
      if (name === 'connectors_execute') return this.execute(grant, args);
      throw unavailable();
    } };
  }
}
