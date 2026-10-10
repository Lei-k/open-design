import type { AutomationSourceKind, AutomationTemplate } from './automations.js';
import type { StudioExecutionSource } from './studio-parity.js';

/** Routine agent ids name exactly one source; dispatch never substitutes another. */
export const STUDIO_ROUTINE_EXECUTION_SOURCES = {
  codex: 'personal_subscription', openai: 'company_pool', 'openai-byok': 'personal_api_key',
} as const satisfies Record<StudioExecutionSource['agentId'], StudioExecutionSource['source']>;

export function studioRoutineExecutionSource(agentId: unknown): StudioExecutionSource['source'] | null {
  return typeof agentId === 'string' && Object.hasOwn(STUDIO_ROUTINE_EXECUTION_SOURCES, agentId)
    ? STUDIO_ROUTINE_EXECUTION_SOURCES[agentId as keyof typeof STUDIO_ROUTINE_EXECUTION_SOURCES] : null;
}

export function studioRoutineAgentId(source: StudioExecutionSource['source']): StudioExecutionSource['agentId'] {
  const agent = (Object.keys(STUDIO_ROUTINE_EXECUTION_SOURCES) as StudioExecutionSource['agentId'][])
    .find((id) => STUDIO_ROUTINE_EXECUTION_SOURCES[id] === source);
  if (!agent) throw new Error('invalid Studio routine execution source');
  return agent;
}

/**
 * Account-owned automation self-evolution for the shared Studio (#64).
 *
 * Source packets, ingestions and proposals are private to the Web account
 * that created them. Bundled automation templates are the same read for every
 * account; private templates are created, updated and deleted through reviewable
 * proposals. A routine created from either runs on that account's own routine and
 * execution source. Applying a proposal writes only into the account's own
 * memory, private skills, design documents or automation templates. S59 admits
 * owner-connected app context for manual/scheduled routines, including templates.
 * Connector ingestion and connector event triggers remain refused with
 * `MULTIUSER_CAPABILITY_UNAVAILABLE`: they have no admitted-run grant lifecycle.
 */

/** Source kinds a Web account may ingest; they are recorded as labels, never fetched. */
export const STUDIO_AUTOMATION_SOURCE_KINDS = ['upload', 'url', 'repo', 'artifact', 'chat'] as const satisfies readonly AutomationSourceKind[];
/** Proposal targets that apply into account-owned stores. */
export const STUDIO_AUTOMATION_PROPOSAL_TARGETS = ['memory-node', 'skill', 'design-system', 'automation-template'] as const;
export const STUDIO_AUTOMATION_PROPOSAL_ACTIONS = ['create', 'update', 'delete'] as const;

/** Closed request fields (the gate refuses anything else before the handler). */
export const STUDIO_AUTOMATION_INGESTION_FIELDS = ['templateId', 'triggerKind', 'sourceKind', 'sourceRef', 'title', 'bodyMarkdown',
  'projectId', 'connectorId', 'accountLabel', 'artifactId', 'conversationId', 'sensitivity', 'capabilityHints', 'candidateSinks',
  'reviewPolicy', 'tokenCompression', 'memoryType', 'metadata'] as const;
export const STUDIO_AUTOMATION_PROPOSAL_FIELDS = ['title', 'summary', 'targetKind', 'action', 'reviewPolicy', 'sourcePacketIds',
  'automationRunId', 'targetRef', 'patch', 'confidence', 'compressionReport', 'metadata', 'status'] as const;

export const STUDIO_AUTOMATION_LIMITS = {
  /** Private templates kept per account. */
  templates: 100,
  /** Source packets kept per account. */
  packets: 500,
  /** Proposals kept per account (any status). */
  proposals: 1000,
  /** Ingested markdown and proposal patch bodies. */
  bodyBytes: 256 * 1024,
  /** Request body ceiling at the gate. */
  requestBytes: 300 * 1024,
} as const;

export type StudioAutomationTemplateUnavailable = {
  code: 'MULTIUSER_CAPABILITY_UNAVAILABLE';
  /** What the template needs that Web accounts do not have yet. */
  requires: 'connectors';
};

/** A bundled or private template as listed to a Web account. */
export type StudioAutomationTemplate = AutomationTemplate & { unavailable?: StudioAutomationTemplateUnavailable; studioOwned?: boolean };

/**
 * Manual/scheduled templates may select owner connectors at routine admission.
 * Templates that only fire from connector events still lack a run grant lifecycle.
 */
export function studioAutomationTemplateUnavailable(template: Pick<AutomationTemplate, 'sourceKinds' | 'triggerKinds'>): StudioAutomationTemplateUnavailable | null {
  const readable = template.sourceKinds.length > 0;
  const triggerable = template.triggerKinds.some((kind) => kind === 'manual' || kind === 'schedule');
  return readable && triggerable ? null : { code: 'MULTIUSER_CAPABILITY_UNAVAILABLE', requires: 'connectors' };
}

/**
 * The routine prompt for a bundled template. One source for the shared
 * Automations UI and `od automation create --template`, so a routine created
 * from either surface carries the same instruction.
 */
export function automationTemplateRoutinePrompt(template: AutomationTemplate): string {
  const stages = template.stages.map((stage) => stage.title).join(' -> ');
  return [
    `Use Automation template "${template.id}".`,
    `Purpose: ${template.purpose}`,
    `Sources: ${template.sourceKinds.join(', ')}.`,
    `Trigger modes: ${template.triggerKinds.join(', ')}.`,
    `Pipeline: ${stages}.`,
    `Outputs: ${template.outputSinks.join(', ')}.`,
    `Review policy: ${template.reviewPolicy}. Token compression: ${template.tokenCompression}.`,
    'Produce reviewable proposals with provenance before applying durable memory, skill, automation, or design-system changes.',
  ].join('\n');
}
