/**
 * Studio account connectors control plane (#62, S58; owner decision
 * 2026-10-10): one company Composio key that only administrators set, rotate
 * or clear, and connections that belong to each account (its own OAuth, its
 * own server-derived Composio entity).
 *
 * The company key is write-only: no response carries it. Reads show whether a
 * key is configured and, to administrators only, its last four characters.
 * Connection rows never name another account or the provider entity.
 *
 * S58 is the control plane only. Connectors are connectable, listable and
 * disconnectable here but not yet usable in runs, tool calls, Live Artifact
 * sources or automation context; those keep `MULTIUSER_CAPABILITY_UNAVAILABLE`.
 */

/** Redacted company key state, visible to every Studio account. */
export interface StudioComposioConfig {
  /** A company Composio key is configured on this deployment. */
  configured: boolean;
  /** Last four characters; administrators only, empty for members. */
  apiKeyTail: string;
  /** Optimistic concurrency for the administrator update. */
  revision: number;
  /** Increments whenever the key itself is set, replaced or cleared. */
  credentialRevision: number;
  /** Whether the reading account may set, rotate or clear the key. */
  canManage: boolean;
}

export interface StudioComposioConfigResponse extends StudioComposioConfig {}

/**
 * Administrator update. `apiKey: null` clears the key; a string sets or
 * rotates it. Write-only: read it from a private file or stdin in the CLI.
 */
export interface UpdateStudioComposioConfigRequest {
  revision: number;
  apiKey: string | null;
}

/**
 * Reason a configured connection needs attention, carried in the standard
 * `ConnectorDetail.lastError` / `ConnectorStatusSummary.lastError`.
 * `MULTIUSER_CONNECTOR_RECHECK_REQUIRED`: the company key changed since the
 * account connected; reconnect (the connection may live in another Composio
 * project and is never silently rebound).
 */
export const STUDIO_CONNECTOR_RECHECK_REQUIRED = 'MULTIUSER_CONNECTOR_RECHECK_REQUIRED' as const;

/** Why an OAuth callback was refused (details.reason of `MULTIUSER_CONNECTOR_AUTHORIZATION_INVALID`). */
export type StudioConnectorCallbackRefusal =
  | 'state'
  | 'expired'
  | 'replayed'
  | 'session'
  | 'account'
  | 'key-changed'
  | 'provider'
  | 'not-completed';

/**
 * Why a connectors request stopped before its next provider call or local
 * change (details.reason of `MULTIUSER_CONNECTOR_AUTHORITY_CHANGED`, HTTP 409).
 * Authority is re-established immediately before every effect: `account` —
 * the account was disabled; `session` — the session was revoked, rotated or
 * expired, or the role or Studio pilot changed; `key-changed` — the company
 * key was rotated or cleared; `connection-changed` — the connection was
 * disconnected or replaced meanwhile.
 */
export type StudioConnectorAuthorityRefusal = 'account' | 'session' | 'key-changed' | 'connection-changed';

/** Fixed refusal shared by run admission, tool routes and connector sources until runs may use connectors (S59). */
export const STUDIO_CONNECTORS_NOT_USABLE_IN_RUNS =
  'connectors are connectable in Settings but not yet usable in runs, tools, Live Artifact sources or automations' as const;
