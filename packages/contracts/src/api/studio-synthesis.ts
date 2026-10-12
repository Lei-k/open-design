import type { RunExecutionSource } from './personal-agent-accounts.js';

/** Studio never accepts provider credentials, endpoints, protocols or models. */
export interface StudioFinalizeRequest {
  executionSource?: RunExecutionSource;
  maxTokens?: number;
  /** Optional optimistic version check, obtained from GET project synthesis. */
  digest?: string;
}
export interface StudioHandoffRequest extends StudioFinalizeRequest { conversationId: string }
export type StudioSynthesisAction = 'finalize' | 'handoff';
export const STUDIO_SYNTHESIS_REFUSALS = ['personal-codex', 'source-required', 'provider-disabled', 'key-missing', 'quota-exhausted', 'project-read-only'] as const;
export type StudioSynthesisRefusal = typeof STUDIO_SYNTHESIS_REFUSALS[number];
export interface StudioSynthesisSource {
  executionSource: RunExecutionSource;
  available: boolean;
  reason: StudioSynthesisRefusal | null;
}
export interface StudioSynthesisResult {
  id: string;
  projectId: string;
  action: StudioSynthesisAction;
  conversationId: string | null;
  executionSource: 'company_pool' | 'personal_api_key';
  fileName: 'DESIGN.md' | 'HANDOFF.md';
  digest: string;
  current: boolean;
  createdAt: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  transcriptMessageCount: number;
  /** Returned only by the immediate handoff response, never by the state read. */
  prompt?: string;
}
export type StudioFinalizeResponse = StudioSynthesisResult;
export type StudioHandoffResponse = StudioSynthesisResult & { prompt: string };
export interface StudioSynthesisState {
  digest: string;
  defaultSource: RunExecutionSource | null;
  sources: StudioSynthesisSource[];
  results: Partial<Record<StudioSynthesisAction, StudioSynthesisResult>>;
}
