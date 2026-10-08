import type { AutomationSourceKind, AutomationTemplate } from './automations.js';

/**
 * Account-owned automation self-evolution for the shared Studio (#64).
 *
 * Source packets, ingestions and proposals are private to the Web account
 * that created them. Bundled automation templates are the same read for every
 * account; a routine created from one runs on that account's own routine and
 * execution source. Applying a proposal writes only into the account's own
 * memory, private skills or design documents. Connector context is not
 * available to Web accounts, so connector-only templates and connector
 * sources are refused with `MULTIUSER_CAPABILITY_UNAVAILABLE`.
 */

/** Source kinds a Web account may ingest; they are recorded as labels, never fetched. */
export const STUDIO_AUTOMATION_SOURCE_KINDS = ['upload', 'url', 'repo', 'artifact', 'chat'] as const satisfies readonly AutomationSourceKind[];
/** Proposal targets that apply into account-owned stores. */
export const STUDIO_AUTOMATION_PROPOSAL_TARGETS = ['memory-node', 'skill', 'design-system'] as const;
export const STUDIO_AUTOMATION_PROPOSAL_ACTIONS = ['create', 'update', 'delete'] as const;

/** Closed request fields (the gate refuses anything else before the handler). */
export const STUDIO_AUTOMATION_INGESTION_FIELDS = ['templateId', 'triggerKind', 'sourceKind', 'sourceRef', 'title', 'bodyMarkdown',
  'projectId', 'connectorId', 'accountLabel', 'artifactId', 'conversationId', 'sensitivity', 'capabilityHints', 'candidateSinks',
  'reviewPolicy', 'tokenCompression', 'memoryType', 'metadata'] as const;
export const STUDIO_AUTOMATION_PROPOSAL_FIELDS = ['title', 'summary', 'targetKind', 'action', 'reviewPolicy', 'sourcePacketIds',
  'automationRunId', 'targetRef', 'patch', 'confidence', 'compressionReport', 'metadata', 'status'] as const;

export const STUDIO_AUTOMATION_LIMITS = {
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

/** A bundled template as listed to a Web account. */
export type StudioAutomationTemplate = AutomationTemplate & { unavailable?: StudioAutomationTemplateUnavailable };

/**
 * A bundled template needs connectors when it can only read connector sources
 * or only fire from connector events. Those stay closed for Web accounts.
 */
export function studioAutomationTemplateUnavailable(template: Pick<AutomationTemplate, 'sourceKinds' | 'triggerKinds'>): StudioAutomationTemplateUnavailable | null {
  const readable = template.sourceKinds.some((kind) => kind !== 'connector');
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
