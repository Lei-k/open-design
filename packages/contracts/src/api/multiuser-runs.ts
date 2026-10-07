import type { ChatSseEvent } from '../sse/chat.js';
import type { ChatRequest } from './chat.js';
import type { RunExecutionSource } from './personal-agent-accounts.js';
import type { MultiUserRunOutput } from './multiuser-design.js';

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
  /** Daemon-issued ids for the standard Studio transcript; older daemons omit them. */
  userMessageId?: string;
  assistantMessageId?: string;
  output: MultiUserRunOutput | Record<string, unknown> | null;
  /** Omitted on existing company-pool responses. */
  executionSource?: RunExecutionSource;
}
export interface MultiUserRunRequest {
  projectId: string;
  conversationId: string;
  agentId: 'test-mock' | 'codex';
  message: string;
  executionSource: RunExecutionSource;
  /** Fixed by the conversation on its first turn; later turns may omit both. */
  skillId?: string;
  designSystemId?: string;
  /** `entryFrom: 'question_answer'` + `sourceRunId` claim a pending question;
   * other analytics keys are not applied. */
  analyticsHints?: Pick<NonNullable<ChatRequest['analyticsHints']>, 'entryFrom' | 'sourceRunId'>;
  /** The turn text; preferred over `message` (see MULTIUSER_PERSONAL_RUN_FIELD_POLICY). */
  currentPrompt?: string;
  /** Proposed transcript ids; must lie in the actor's `studioMessageIdPrefix`. */
  userMessageId?: string | null;
  assistantMessageId?: string | null;
  /** Idempotency key: the same owner+conversation+key returns the first run. */
  clientRequestId?: string | null;
}
/**
 * Personal-subscription admission also accepts the standard `ChatRequest` the
 * shared Studio sends, so the App needs no multi-user request fork. Every
 * standard field has exactly one policy; a field outside this table, or a
 * `defaultOnly` field carrying a non-default value, is refused with
 * `MULTIUSER_CAPABILITY_UNAVAILABLE` rather than silently dropped.
 *
 * - `honored`: applied to the run (`currentPrompt` is the turn text; the
 *   personal native thread already holds earlier turns, so `message` is used
 *   only when `currentPrompt` is absent).
 * - `defaultOnly`: accepted only at the value the Studio sends when the
 *   capability is not used (empty list, null, `false`, or `design` mode).
 * - `notApplied`: accepted for request-shape compatibility and not applied:
 *   the stitched transcript (the native thread is the context), the UI locale,
 *   title generation, and analytics-only hints. None of them changes what
 *   runs or who pays for it.
 */
export const MULTIUSER_PERSONAL_RUN_FIELD_POLICY = {
  honored: ['projectId', 'conversationId', 'agentId', 'executionSource', 'message', 'currentPrompt', 'userMessageId',
    'assistantMessageId', 'clientRequestId', 'skillId', 'designSystemId', 'analyticsHints'],
  defaultOnly: ['skillIds', 'attachments', 'commentAttachments', 'model', 'reasoning', 'serviceTier',
    'appliedPluginSnapshotId', 'sessionMode'],
  notApplied: ['priorTranscript', 'locale', 'titleGeneration'],
} as const;

export interface MultiUserRunResponse { run: MultiUserRun }
/** Standard run admission identity, additive to the legacy response. */
export interface MultiUserRunCreateResponse extends MultiUserRunResponse { runId: string }
/**
 * `GET /api/runs`: the owner's runs, newest first, `limit` (1-100, default 50)
 * per page. Pass `nextCursor` back as `cursor` for the next older page; it is
 * opaque and `null` on the last page.
 */
export interface MultiUserRunsResponse {
  runs: MultiUserRun[];
  awaitingInputProjectIds: string[];
  nextCursor: string | null;
  /**
   * Present only when the list is filtered by `conversationId`. True when the
   * conversation is pinned to a personal account that is no longer the owner's
   * linked account (unlinked, or replaced by a new link): personal runs there
   * are refused and never fall back to the company pool.
   */
  personalPinStale?: boolean;
}
export type MultiUserRunEvent = ChatSseEvent;
