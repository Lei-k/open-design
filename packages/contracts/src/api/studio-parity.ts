import type { ChatMessageFeedback, ChatMessageFeedbackReasonCode } from './chat.js';
/** Delivery ledger for #51. This describes readiness; it never grants authority. */
export const STUDIO_PARITY_LANES = [
  { id: 'baseline', issue: 52, dependsOn: [], owner: 'contracts', component: 'App', data: 'public', credentials: 'none', web: 'shared', acceptance: 'Every registered route and desktop bridge has a lane and a decision.' },
  { id: 'shell', issue: 53, dependsOn: [52], owner: 'web/session', component: 'App / EntryShell', data: 'actor', credentials: 'session', web: 'adapter', acceptance: 'Same App tree; identity withdrawal removes caches, drafts, streams and frames synchronously.' },
  { id: 'projects', issue: 54, dependsOn: [52], owner: 'daemon/project', component: 'ProjectView', data: 'project', credentials: 'session', web: 'adapter', acceptance: 'Standard projects, conversations, messages, tabs and events reject foreign and missing ids identically.' },
  { id: 'execution', issue: 55, dependsOn: [52, 54], owner: 'daemon/runs', component: 'runtime/chat', data: 'run', credentials: 'actor-provider', web: 'adapter', acceptance: 'Standard persisted messages and normalized events; account pin, replay, cancellation and restart recovery.' },
  { id: 'chat', issue: 56, dependsOn: [53, 54, 55], owner: 'web/chat', component: 'ChatPane / ChatRoot', data: 'conversation', credentials: 'session', web: 'shared', acceptance: 'Formal chat state matrix, question forms, history, errors, queue, reconnect and continuation.' },
  { id: 'composer', issue: 57, dependsOn: [53, 54, 55, 56], owner: 'web/composer', component: 'Composer', data: 'actor-project', credentials: 'actor-provider', web: 'adapter', acceptance: 'Shared rich composer, attachments and execution controls; exactly once Home handoff.' },
  { id: 'files', issue: 58, dependsOn: [54, 55], owner: 'daemon/files', component: 'FileViewer', data: 'project', credentials: 'session', web: 'adapter', acceptance: 'File CRUD, folders, versions, search and watcher invalidation with path and size controls.' },
  { id: 'preview', issue: 59, dependsOn: [54, 55, 56, 58], owner: 'daemon/artifacts', component: 'FileViewer / ArtifactCard', data: 'artifact', credentials: 'preview-capability', web: 'adapter', acceptance: 'All preview types, editing and immutable snapshots; separate origin and revoked session capabilities.' },
  { id: 'home', issue: 60, dependsOn: [53, 54, 57, 58, 61], owner: 'web/entry', component: 'HomeView / NewProjectPanel', data: 'actor-project', credentials: 'session', web: 'adapter', acceptance: 'Six creation types, templates and browser import without accepting server paths.' },
  { id: 'catalogs', issue: 61, dependsOn: [52, 54], owner: 'daemon/registry', component: 'DesignSystemFlow / MarketplaceView', data: 'public-actor-workspace', credentials: 'actor-provider', web: 'adapter', acceptance: 'Bundled reads and private install, create, revision, preview and apply with immutable project snapshots.' },
  { id: 'settings', issue: 62, dependsOn: [52, 53, 54], owner: 'daemon/settings', component: 'SettingsDialog / IntegrationsView', data: 'actor', credentials: 'actor-provider', web: 'adapter', acceptance: 'Actor config, memory, library, MCP and OAuth isolation; redaction and revocation.' },
  { id: 'generation', issue: 63, dependsOn: [54, 55, 58, 59, 62], owner: 'daemon/media', component: 'Media / LiveArtifacts / GenUI', data: 'actor-project-run', credentials: 'actor-provider', web: 'adapter', acceptance: 'Media, live artifacts, research and critique close create to progress to output to revision.' },
  { id: 'automations', issue: 64, dependsOn: [54, 55, 62, 68], owner: 'daemon/routines', component: 'TasksView', data: 'actor', credentials: 'actor-provider', web: 'adapter', acceptance: 'Owned schedules, proposals and output; every dispatch revalidates authority and credentials.' },
  { id: 'collaboration', issue: 65, dependsOn: [53, 54, 58, 59, 61], owner: 'daemon/collab', component: 'Workspace / Comments', data: 'workspace', credentials: 'workspace-binding', web: 'decision', acceptance: 'Explicit local account to workspace binding; membership removal revokes open resources and streams.' },
  { id: 'delivery', issue: 66, dependsOn: [54, 58, 59, 62], owner: 'daemon/export', component: 'FileViewer export / Deploy', data: 'project-version', credentials: 'actor-provider', web: 'daemon', acceptance: 'Isolated headless exports, share and deploy; output bound to owner and version digest.' },
  { id: 'web-host', issue: 67, dependsOn: [52, 53, 54, 58, 59, 66], owner: 'host', component: 'Host bridge', data: 'actor-or-admin', credentials: 'session', web: 'decision', acceptance: 'Every native bridge has a secure Web equivalent or an explicit product decision.' },
  { id: 'cli', issue: 68, dependsOn: [53, 54, 55], owner: 'daemon/cli', component: 'od', data: 'actor', credentials: 'session', web: 'adapter', acceptance: 'Remote origin pinned sessions, JSON, prompt files and resumable streams use the same HTTP contracts.' },
  { id: 'admin', issue: 69, dependsOn: [53, 62], owner: 'daemon/auth', component: 'AdminUsers / Audit / Pool', data: 'admin-metadata', credentials: 'admin', web: 'shared', acceptance: 'Admin integrated into the shared shell; no private content bypass and no secret reads.' },
  { id: 'acceptance', issue: 70, dependsOn: Array.from({ length: 18 }, (_, index) => 52 + index), owner: 'e2e', component: 'Studio acceptance', data: 'test', credentials: 'two-sessions', web: 'shared', acceptance: 'All applicable rows pass; rollout and rollback verified before removing the legacy product tree.' },
] as const;

export type StudioParityLaneId = (typeof STUDIO_PARITY_LANES)[number]['id'];
/**
 * `supported` is a deployment-wide completion promise. `pilot` is usable only by
 * the authenticated pilot actor that received it; it never appears in public
 * version discovery and its reason names the acceptance still outstanding.
 */
export type StudioAvailability =
  | { status: 'supported' }
  | { status: 'pilot' | 'unavailable' | 'admin-disabled'; reason: string };

export type StudioExecutionSource = { source: 'personal_subscription'; agentId: 'codex' } | { source: 'company_pool'; agentId: 'openai' }
  /** The actor's own OpenAI API key, stored encrypted per account (#62/#63). */
  | { source: 'personal_api_key'; agentId: 'openai-byok' };

export interface StudioRuntimeCapabilities {
  schemaVersion: 1;
  /** A legacy shell must never be advertised as full Studio parity. */
  shell: 'studio' | 'legacy-multiuser';
  features: Record<StudioParityLaneId, StudioAvailability>;
  /** Server-owned choices; absent on older deployments. */
  executionSources?: StudioExecutionSource[];
  /** The deployment renders PDF/PPTX/PNG exports server-side (#66); absent means not configured. */
  renderedExports?: boolean;
  /**
   * Research search (#63) runs for this account on its own Tavily key; the
   * composer's `/search` and `POST /api/research/search` depend on it. Absent
   * means unavailable. A key still has to be saved before a search succeeds.
   */
  researchSearch?: boolean;
}

export interface StudioRouteParity {
  key: string;
  lane: StudioParityLaneId;
  issue: number;
  routeClass: string;
  reason: string;
  singleUserApi: string | null;
  owner: string;
  component: string;
  /** Target ownership boundary, not a claim that the legacy API meets it. */
  targetData: string;
  credentialOwner: string;
  webStrategy: 'shared' | 'adapter' | 'daemon' | 'decision';
}

/** Restricted client writes; daemon-owned run fields arrive from the run engine.
 * `content` is applied to user rows only; `feedback` to assistant rows only. */
export interface StudioMessageWriteRequest {
  id?: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt?: number;
  createOnly?: boolean;
  feedback?: StudioMessageFeedback | null;
}

export type StudioMessageFeedback = ChatMessageFeedback;
const FEEDBACK_REASON_CODES = ['matched_request', 'strong_visual', 'useful_structure', 'easy_to_continue', 'followed_design_system',
  'missed_request', 'weak_visual', 'could_not_run', 'too_slow', 'incomplete_output', 'hard_to_use', 'missed_design_system',
  'other'] as const satisfies readonly ChatMessageFeedbackReasonCode[];
type MissingReasonCode = Exclude<ChatMessageFeedbackReasonCode, (typeof FEEDBACK_REASON_CODES)[number]>;
// Compile-time completeness: a new reason code must be listed above.
const feedbackReasonCodesComplete: MissingReasonCode extends never ? true : never = true;
void feedbackReasonCodesComplete;

/** Strict feedback projection for owner writes: `null` clears, `undefined` means invalid. */
export function parseStudioMessageFeedback(value: unknown): ChatMessageFeedback | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const time = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
  if (Object.keys(input).some((key) => !['rating', 'reasonCodes', 'customReason', 'reasonsSubmittedAt', 'createdAt', 'updatedAt'].includes(key))
    || (input.rating !== 'positive' && input.rating !== 'negative') || !time(input.createdAt)
    || (input.updatedAt !== undefined && !time(input.updatedAt)) || (input.reasonsSubmittedAt !== undefined && !time(input.reasonsSubmittedAt))
    || (input.customReason !== undefined && (typeof input.customReason !== 'string' || input.customReason.length > 2000))
    || (input.reasonCodes !== undefined && (!Array.isArray(input.reasonCodes) || input.reasonCodes.length > FEEDBACK_REASON_CODES.length
      || input.reasonCodes.some((code) => !(FEEDBACK_REASON_CODES as readonly unknown[]).includes(code))))) return undefined;
  return {
    rating: input.rating, createdAt: input.createdAt as number,
    ...(input.reasonCodes ? { reasonCodes: [...new Set(input.reasonCodes as ChatMessageFeedbackReasonCode[])] } : {}),
    ...(input.customReason !== undefined ? { customReason: input.customReason as string } : {}),
    ...(input.reasonsSubmittedAt !== undefined ? { reasonsSubmittedAt: input.reasonsSubmittedAt as number } : {}),
    ...(input.updatedAt !== undefined ? { updatedAt: input.updatedAt as number } : {}),
  };
}

/**
 * Client-proposed transcript ids are accepted only inside the actor's own
 * namespace, which the authenticated session read returns. Another actor's
 * ids can never be proposed, so admission cannot become a cross-tenant
 * existence oracle; daemon-minted ids keep their own disjoint prefix.
 */
export const STUDIO_MESSAGE_ID_PATTERN = /^mua_[0-9a-f]{24}_[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
export function isStudioMessageIdInNamespace(id: unknown, prefix: string): id is string {
  return typeof id === 'string' && id.startsWith(prefix) && STUDIO_MESSAGE_ID_PATTERN.test(id);
}

/** Validate and project the public capability fields; never forward unknown payload fields. */
export function parseStudioRuntimeCapabilities(value: unknown): StudioRuntimeCapabilities | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const studio = value as Partial<StudioRuntimeCapabilities>;
  if (studio.schemaVersion !== 1 || !['studio', 'legacy-multiuser'].includes(studio.shell ?? '')
    || !studio.features || typeof studio.features !== 'object' || Array.isArray(studio.features)) return null;
  const features = {} as StudioRuntimeCapabilities['features'];
  // A legacy shell has no pilot lanes; refuse a contradictory record outright.
  const pilotAllowed = studio.shell === 'studio';
  for (const { id } of STUDIO_PARITY_LANES) {
    const feature = studio.features[id];
    if (feature?.status === 'supported') features[id] = { status: 'supported' };
    else if (feature?.status === 'pilot' && !pilotAllowed) return null;
    else if ((feature?.status === 'pilot' || feature?.status === 'unavailable' || feature?.status === 'admin-disabled')
      && typeof feature.reason === 'string' && feature.reason.length > 0) {
      features[id] = { status: feature.status, reason: feature.reason };
    } else return null;
  }
  const choices = studio.executionSources;
  if (choices !== undefined && (!Array.isArray(choices) || choices.length > 3 || choices.some((choice) =>
    !choice || typeof choice !== 'object' || Object.keys(choice).some((key) => !['source', 'agentId'].includes(key))
    || !(choice.source === 'personal_subscription' && choice.agentId === 'codex'
      || choice.source === 'company_pool' && choice.agentId === 'openai'
      || choice.source === 'personal_api_key' && choice.agentId === 'openai-byok'))
    || new Set(choices.map((choice) => choice.source)).size !== choices.length)) return null;
  if (studio.renderedExports !== undefined && typeof studio.renderedExports !== 'boolean') return null;
  if (studio.researchSearch !== undefined && typeof studio.researchSearch !== 'boolean') return null;
  return { schemaVersion: 1, shell: studio.shell!, features,
    ...(choices !== undefined ? { executionSources: choices.map((choice) => ({ ...choice })) } : {}),
    ...(studio.renderedExports !== undefined ? { renderedExports: studio.renderedExports } : {}),
    ...(studio.researchSearch !== undefined ? { researchSearch: studio.researchSearch } : {}) };
}
