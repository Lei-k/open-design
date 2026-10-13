import type { PersonalAccountStatus, RunExecutionSource, StudioExecutionSource } from '@open-design/contracts';

/** The three Studio execution sources, in the daemon's advertisement order. */
const SOURCES = [
  { source: 'personal_subscription', agentId: 'codex' },
  { source: 'company_pool', agentId: 'openai' },
  { source: 'personal_api_key', agentId: 'openai-byok' },
] as const satisfies readonly StudioExecutionSource[];

export type StudioSourceAgentId = StudioExecutionSource['agentId'];

/** Why a source cannot run a turn for this account right now. */
export type StudioSourceBlock =
  /** A personal source this deployment has not enabled; administrators own it. */
  | 'server-disabled'
  /** The company pool is off or unconfigured; administrators own it. */
  | 'company-disabled'
  | 'codex-unlinked'
  | 'codex-reauth'
  /** The provider workspace refused the linked Codex account. */
  | 'codex-disabled'
  | 'key-missing';

export interface StudioSourceOption {
  agentId: StudioSourceAgentId;
  source: RunExecutionSource;
  available: boolean;
  block: StudioSourceBlock | null;
  /** Where the account can fix the block itself; null when only an administrator can. */
  fix: 'agent-accounts' | null;
}

export interface StudioSourceFacts {
  /** `capabilities.executionSources` from the authenticated session read. */
  advertised: readonly StudioExecutionSource[];
  mediaOnly?: boolean;
  /** `GET /api/agent-accounts` codex link; `null` unlinked, `undefined` unknown. */
  codexAccountStatus?: PersonalAccountStatus | null;
  /** `GET /api/multiuser/settings/provider-keys` openai entry; `undefined` unknown. */
  openaiKeyConfigured?: boolean;
}

/**
 * Every Studio source with whether this account can start a conversation on it
 * now. A presentation hint only: daemon admission stays the authority, so an
 * account fact that could not be read is left to admission rather than shown
 * as a refusal. Media-only projects never list personal Codex (#63).
 */
export function studioSourceOptions(facts: StudioSourceFacts): StudioSourceOption[] {
  const advertised = new Set(facts.advertised.map((choice) => choice.agentId));
  return SOURCES.filter((choice) => !(facts.mediaOnly && choice.agentId === 'codex')).map((choice): StudioSourceOption => {
    const block = blockOf(choice.agentId, advertised.has(choice.agentId), facts);
    return { agentId: choice.agentId, source: choice.source, available: block === null, block,
      fix: block === 'codex-unlinked' || block === 'codex-reauth' || block === 'codex-disabled' || block === 'key-missing' ? 'agent-accounts' : null };
  });
}

function blockOf(agentId: StudioSourceAgentId, advertised: boolean, facts: StudioSourceFacts): StudioSourceBlock | null {
  if (!advertised) return agentId === 'openai' ? 'company-disabled' : 'server-disabled';
  if (agentId === 'codex') {
    if (facts.codexAccountStatus === null) return 'codex-unlinked';
    if (facts.codexAccountStatus === 'requires_reauth') return 'codex-reauth';
    if (facts.codexAccountStatus === 'disabled') return 'codex-disabled';
  }
  if (agentId === 'openai-byok' && facts.openaiKeyConfigured === false) return 'key-missing';
  return null;
}

/** The run execution source an agent id pins, or null for non-Studio agents. */
export function studioAgentExecutionSource(agentId: string | null | undefined): RunExecutionSource | null {
  return SOURCES.find((choice) => choice.agentId === agentId)?.source ?? null;
}
