import type { ApiErrorCode, RunExecutionSource, StudioSynthesisSource } from '@open-design/contracts';

export class StudioSynthesisError extends Error {
  constructor(readonly status: number, readonly code: ApiErrorCode, readonly reason?: string) {
    super('Studio synthesis refused');
  }
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
