import type { ApiErrorCode, RunExecutionSource, StudioSynthesisSource } from '@open-design/contracts';

export class StudioSynthesisError extends Error {
  constructor(readonly status: number, readonly code: ApiErrorCode, readonly reason?: string) {
    super('Studio synthesis refused');
  }
}
/** A successful HTTP response must contain a complete, usable Studio document.
 * A reasoning-only, truncated, refused or failed result never becomes a receipt. */
export function assertStudioChatCompletion(payload: unknown): void {
  const value = payload as { error?: unknown; choices?: Array<{ finish_reason?: unknown; message?: { content?: unknown; refusal?: unknown } }> } | null;
  const choice = value?.choices?.[0];
  if (!value || value.error != null || !Array.isArray(value.choices) || value.choices.length !== 1
    || !choice || choice.finish_reason !== 'stop'
    || choice.message?.refusal != null || typeof choice.message?.content !== 'string' || !choice.message.content.trim())
    throw new StudioSynthesisError(502, 'MULTIUSER_SYNTHESIS_PROVIDER_FAILED');
}
/** Internal only: credentials never enter a DTO, event or stored job. */
export interface StudioSynthesisLease {
  id: string;
  apiKey: string;
  model: string;
  signal: AbortSignal;
  check(): void;
  finish(): void;
}
export interface StudioSynthesisPool {
  synthesisSource(accountId: string, source: RunExecutionSource): StudioSynthesisSource;
  beginSynthesis(accountId: string, projectId: string, source: 'company_pool' | 'personal_api_key', checkAuthority: () => void): StudioSynthesisLease;
}
