import type { RunExecutionSource } from './personal-agent-accounts.js';

/** Test-only multi-user execution plane; independent of single-user chat runs. */
export type MultiUserRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
export interface MultiUserRun {
  id: string;
  projectId: string;
  conversationId: string;
  agentId: 'test-mock' | 'codex';
  status: MultiUserRunStatus;
  queuePosition: number | null;
  createdAt: number;
  updatedAt: number;
  /** Owner-only persisted prompt; legacy rows may have no request. */
  message: string | null;
  output: unknown;
  /** Omitted on existing company-pool responses. */
  executionSource?: RunExecutionSource;
}
export interface MultiUserRunRequest {
  projectId: string;
  conversationId: string;
  agentId: 'test-mock' | 'codex';
  message: string;
  executionSource: RunExecutionSource;
}
export interface MultiUserRunResponse { run: MultiUserRun }
export interface MultiUserRunsResponse { runs: MultiUserRun[]; awaitingInputProjectIds: string[] }
export type MultiUserRunEvent =
  | { event: 'queued'; data: { runId: string } }
  | { event: 'start'; data: { runId: string } }
  | { event: 'agent'; data: unknown }
  | { event: 'end'; data: { status: 'succeeded' | 'failed' | 'canceled'; output?: unknown } };
