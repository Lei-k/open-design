import { describe, expect, it } from 'vitest';
import type { StudioExecutionSource } from '@open-design/contracts';
import { studioAgentExecutionSource, studioSourceOptions } from '../../src/runtime/studio-source-options';

const all: StudioExecutionSource[] = [
  { source: 'personal_subscription', agentId: 'codex' }, { source: 'company_pool', agentId: 'openai' },
  { source: 'personal_api_key', agentId: 'openai-byok' },
];
const pick = (options: ReturnType<typeof studioSourceOptions>) => options.map(({ agentId, available, block, fix }) => ({ agentId, available, block, fix }));

describe('studioSourceOptions (S74)', () => {
  it('always lists the three sources in server order, usable when advertised and ready', () => {
    expect(pick(studioSourceOptions({ advertised: all, codexAccountStatus: 'connected', openaiKeyConfigured: true }))).toEqual([
      { agentId: 'codex', available: true, block: null, fix: null },
      { agentId: 'openai', available: true, block: null, fix: null },
      { agentId: 'openai-byok', available: true, block: null, fix: null },
    ]);
  });

  it('keeps sources the server does not advertise, disabled with an administrator reason and no entry', () => {
    expect(pick(studioSourceOptions({ advertised: [], codexAccountStatus: null, openaiKeyConfigured: false }))).toEqual([
      { agentId: 'codex', available: false, block: 'server-disabled', fix: null },
      { agentId: 'openai', available: false, block: 'company-disabled', fix: null },
      { agentId: 'openai-byok', available: false, block: 'server-disabled', fix: null },
    ]);
  });

  it('points an unlinked, expired or provider-disabled Codex link at Agent accounts', () => {
    const codex = (status: 'connected' | 'requires_reauth' | 'disabled' | null) => pick(studioSourceOptions({ advertised: all, codexAccountStatus: status }))[0];
    expect(codex(null)).toEqual({ agentId: 'codex', available: false, block: 'codex-unlinked', fix: 'agent-accounts' });
    expect(codex('requires_reauth')).toEqual({ agentId: 'codex', available: false, block: 'codex-reauth', fix: 'agent-accounts' });
    expect(codex('disabled')).toEqual({ agentId: 'codex', available: false, block: 'codex-disabled', fix: 'agent-accounts' });
  });

  it('points a missing own key at Agent accounts', () => {
    expect(pick(studioSourceOptions({ advertised: all, openaiKeyConfigured: false }))[2])
      .toEqual({ agentId: 'openai-byok', available: false, block: 'key-missing', fix: 'agent-accounts' });
  });

  it('leaves unknown account facts to daemon admission instead of guessing a refusal', () => {
    expect(pick(studioSourceOptions({ advertised: all })).every((option) => option.available)).toBe(true);
  });

  it('drops personal Codex from media-only projects (#63)', () => {
    expect(studioSourceOptions({ advertised: all, mediaOnly: true }).map((option) => option.agentId)).toEqual(['openai', 'openai-byok']);
  });

  it('maps agents to their run execution source', () => {
    expect(['codex', 'openai', 'openai-byok', 'claude', null].map(studioAgentExecutionSource))
      .toEqual(['personal_subscription', 'company_pool', 'personal_api_key', null, null]);
  });
});
