import { STUDIO_LIVE_ARTIFACT_SOURCE_LIMITS, type LiveArtifactSource } from '@open-design/contracts';
import { validateBoundedJsonObject, validateLiveArtifactOutputMapping, type LiveArtifactValidationIssue } from './schema.js';

/**
 * Studio Live Artifact sources that read the REFRESHING account's own connector
 * or remote MCP server (#63, S62). The descriptor holds ids only — the
 * connector id and its tool, or the account-local MCP server id and the remote
 * tool name — plus bounded JSON arguments and the S53 mapping. It never holds
 * credentials, grants, provider connection ids, entities or account labels:
 * every refresh resolves the ids among the refreshing account's own resources.
 *
 * Desktop validation (`schema.ts`) is unchanged; these shapes are refused
 * there and accepted only by the Studio store.
 */
export type StudioToolSource = LiveArtifactSource & ({ type: 'connector_tool'; connector: NonNullable<LiveArtifactSource['connector']> }
  | { type: 'mcp_tool'; mcp: NonNullable<LiveArtifactSource['mcp']> });

export class StudioSourceInvalid extends Error { constructor(readonly reason: string) { super(reason); } }

const CONNECTOR_ID = /^[a-z0-9_]{1,64}$/;
const CONNECTOR_TOOL = /^[a-z0-9_]{1,64}\.[A-Za-z0-9_]{1,200}$/;
const SERVER_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MCP_TOOL = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const closed = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).every((key) => keys.includes(key));

/** True for a descriptor naming a connector or MCP tool (validated or not). */
export function isStudioToolSourceShape(value: unknown): boolean {
  const type = (value as { type?: unknown } | null)?.type;
  return type === 'connector_tool' || type === 'mcp_tool';
}

/** Validate and normalize a connector/MCP descriptor; throws `StudioSourceInvalid` with a fixed reason. */
export function validateStudioToolSource(value: unknown): StudioToolSource {
  if (!closed(value, ['type', 'toolName', 'input', 'connector', 'mcp', 'outputMapping', 'refreshPermission'])) throw new StudioSourceInvalid('source fields');
  if (value.refreshPermission !== 'manual_refresh_granted_for_read_only') throw new StudioSourceInvalid('refresh permission');
  const input = validateBoundedJsonObject(value.input ?? {}, 'input');
  if (!input.ok || Buffer.byteLength(JSON.stringify(input.value)) > STUDIO_LIVE_ARTIFACT_SOURCE_LIMITS.argumentBytes) throw new StudioSourceInvalid('arguments');
  let outputMapping: LiveArtifactSource['outputMapping'];
  if (value.outputMapping !== undefined) {
    const issues: LiveArtifactValidationIssue[] = [];
    outputMapping = validateLiveArtifactOutputMapping(value.outputMapping, 'outputMapping', issues);
    if (issues.length || !outputMapping) throw new StudioSourceInvalid('mapping');
  }
  const base = { input: input.value, refreshPermission: 'manual_refresh_granted_for_read_only' as const, ...(outputMapping ? { outputMapping } : {}) };
  if (value.type === 'connector_tool') {
    const connector = value.connector;
    // Ids only: no account label, approval override or provider ids.
    if (value.mcp !== undefined || !closed(connector, ['connectorId', 'toolName']) || typeof connector.connectorId !== 'string'
      || typeof connector.toolName !== 'string' || !CONNECTOR_ID.test(connector.connectorId) || !CONNECTOR_TOOL.test(connector.toolName)
      || !connector.toolName.startsWith(`${connector.connectorId}.`)
      || value.toolName !== undefined && value.toolName !== connector.toolName) throw new StudioSourceInvalid('connector');
    return { type: 'connector_tool', toolName: connector.toolName, connector: { connectorId: connector.connectorId, toolName: connector.toolName }, ...base };
  }
  if (value.type === 'mcp_tool') {
    const mcp = value.mcp;
    if (value.connector !== undefined || value.toolName !== undefined || !closed(mcp, ['serverId', 'toolName', 'readOnlyConfirmed'])
      || typeof mcp.serverId !== 'string' || typeof mcp.toolName !== 'string' || !SERVER_ID.test(mcp.serverId) || !MCP_TOOL.test(mcp.toolName)
      // Reserved prefixes can never be a remote tool (S61 shadowing rule).
      || /^(?:mcp_|connectors_|live_artifacts_)/.test(mcp.toolName)) throw new StudioSourceInvalid('mcp');
    // The creator's explicit confirmation is part of the read-only policy (MCP annotations are untrusted hints).
    if (mcp.readOnlyConfirmed !== true) throw new StudioSourceInvalid('read-only confirmation');
    return { type: 'mcp_tool', mcp: { serverId: mcp.serverId, toolName: mcp.toolName, readOnlyConfirmed: true }, ...base };
  }
  throw new StudioSourceInvalid('source type');
}

/** Stable identity of a descriptor; a refresh commits only while the stored descriptor still equals it. */
export function studioSourceKey(source: StudioToolSource): string {
  return JSON.stringify([source.type, source.type === 'connector_tool' ? source.connector : source.mcp, source.input, source.outputMapping ?? null]);
}
