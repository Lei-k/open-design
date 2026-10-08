import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Express, Request, Response } from 'express';
import {
  MEMORY_TYPES, STUDIO_AUTOMATION_LIMITS, STUDIO_AUTOMATION_PROPOSAL_ACTIONS, STUDIO_AUTOMATION_PROPOSAL_TARGETS,
  STUDIO_AUTOMATION_SOURCE_KINDS, studioAutomationTemplateUnavailable,
  type AutomationContentPacket, type AutomationEvolutionProposal, type AutomationProposalStatus, type AutomationSourceIngestionResponse,
  type AutomationTemplate, type CreateAutomationEvolutionProposalRequest, type CreateAutomationSourceIngestionRequest,
  type JsonValue, type MemoryType, type StudioAutomationTemplate,
} from '@open-design/contracts';
import { multiUserActorOf } from '../http/multiuser-gate.js';
import { multiUserStreamAllowed } from '../http/multiuser-stream.js';
import { sendApiError } from '../http/api-errors.js';
import { BUILT_IN_AUTOMATION_TEMPLATES } from '../automation-templates.js';
import { planAutomationIngestion } from '../automation-ingestions.js';
import { assertReviewable, buildAutomationProposal, memoryEntryFromProposal } from '../automation-proposals.js';
import { parseFrontmatter } from '../design-systems/frontmatter.js';
import { ProjectOwnershipStore } from '../storage/project-ownership.js';
import { StudioSkills } from '../storage/studio-skills.js';
import { StudioDesignSystems } from '../storage/studio-design-systems.js';
import type { StudioSettings } from '../storage/studio-settings.js';
import { readStudioMemoryEntry, saveStudioMemoryEntry } from '../storage/studio-settings.js';
import { deleteMemoryEntry, deriveMemoryId } from '../memory.js';
import { isSafeId } from '../projects.js';

/** A typed refusal from the account automation store (status maps to the shared error codes). */
export class AutomationRefusal extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409, message: string) { super(message); }
}
const notFound = () => new AutomationRefusal(404, 'resource not found');
const unavailable = (what: string) => new AutomationRefusal(403, `${what} are not available for Web accounts`);

const text = (value: unknown, max: number) => typeof value === 'string' && value.length <= max && !value.includes('\0');
const optionalText = (value: unknown, max: number) => value === undefined || value === null || text(value, max);
const jsonBounded = (value: unknown, max: number) => {
  try { return JSON.stringify(value).length <= max; } catch { return false; }
};
const plainObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const MEMORY_ID = /^[a-z0-9_]{1,128}$/;

export function studioAutomationTemplates(): StudioAutomationTemplate[] {
  return BUILT_IN_AUTOMATION_TEMPLATES.map((template) => {
    const refused = studioAutomationTemplateUnavailable(template);
    return refused ? { ...template, unavailable: refused } : { ...template };
  });
}
/** A bundled template a Web account may run, or a typed refusal. */
export function studioRunnableAutomationTemplate(id: unknown): AutomationTemplate {
  const template = typeof id === 'string' ? BUILT_IN_AUTOMATION_TEMPLATES.find((item) => item.id === id) : undefined;
  if (!template) throw notFound();
  if (studioAutomationTemplateUnavailable(template)) throw unavailable('connector-only automation templates');
  return template;
}

export interface StudioAutomations {
  /** Ingest one source for the owner; the caller has already resolved authority over every referenced resource. */
  ingest(owner: string, input: CreateAutomationSourceIngestionRequest): AutomationSourceIngestionResponse;
}

/**
 * Account-owned automation self-evolution (#64). Packets and proposals carry
 * their owner on every row and every lookup; foreign and missing ids are the
 * same 404 (admins included). Applying writes only into the owner's memory,
 * private skill packages and design documents. Nothing here reads or writes
 * the host-global automation stores, templates or catalogs.
 */
export function registerStudioAutomationRoutes(app: Express, input: {
  db: Database.Database; settings: StudioSettings;
}): StudioAutomations {
  const { db } = input;
  const ownership = new ProjectOwnershipStore(db);
  const skills = new StudioSkills(db);
  const designs = new StudioDesignSystems(db);
  db.exec(`CREATE TABLE IF NOT EXISTS studio_automation_packets (
      id TEXT PRIMARY KEY, owner_account_id TEXT NOT NULL, packet_json TEXT NOT NULL, captured_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS studio_automation_packets_owner ON studio_automation_packets(owner_account_id, captured_at);
    CREATE TRIGGER IF NOT EXISTS studio_automation_packets_immutable BEFORE UPDATE ON studio_automation_packets
      BEGIN SELECT RAISE(ABORT, 'automation source packets are immutable'); END;
    CREATE TABLE IF NOT EXISTS studio_automation_proposals (
      id TEXT PRIMARY KEY, owner_account_id TEXT NOT NULL, status TEXT NOT NULL, proposal_json TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS studio_automation_proposals_owner ON studio_automation_proposals(owner_account_id, updated_at);`);

  const packetRow = (owner: string, id: unknown) => typeof id === 'string'
    ? db.prepare('SELECT packet_json FROM studio_automation_packets WHERE id = ? AND owner_account_id = ?').get(id, owner) as { packet_json: string } | undefined
    : undefined;
  const proposalOf = (owner: string, id: unknown): AutomationEvolutionProposal | null => {
    if (typeof id !== 'string') return null;
    const row = db.prepare('SELECT proposal_json FROM studio_automation_proposals WHERE id = ? AND owner_account_id = ?').get(id, owner) as { proposal_json: string } | undefined;
    return row ? JSON.parse(row.proposal_json) as AutomationEvolutionProposal : null;
  };
  const count = (table: string, owner: string) =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE owner_account_id = ?`).get(owner) as { n: number }).n;
  const insertProposal = (owner: string, proposal: AutomationEvolutionProposal) => {
    db.prepare('INSERT INTO studio_automation_proposals (id, owner_account_id, status, proposal_json, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(proposal.id, owner, proposal.status, JSON.stringify(proposal), proposal.updatedAt);
  };
  const conversationInProject = (projectId: string, conversationId: string) =>
    Boolean(db.prepare('SELECT 1 FROM conversations WHERE id = ? AND project_id = ?').get(conversationId, projectId));
  const routineRunOwned = (owner: string, runId: string) => {
    try {
      return Boolean(db.prepare('SELECT 1 FROM studio_routine_runs WHERE id = ? AND owner_account_id = ?').get(runId, owner));
    } catch { return false; }
  };

  /** Field checks that need the owner's resources; the gate already closed the field set. */
  const checkIngestion = (owner: string, body: CreateAutomationSourceIngestionRequest): AutomationTemplate | null => {
    if (!plainObject(body)) throw new AutomationRefusal(400, 'ingestion body is required');
    if (body.sourceKind === 'connector' || body.triggerKind === 'connector'
      || body.connectorId !== undefined && body.connectorId !== null || body.accountLabel !== undefined && body.accountLabel !== null) {
      throw unavailable('connector sources');
    }
    if (!(STUDIO_AUTOMATION_SOURCE_KINDS as readonly string[]).includes(String(body.sourceKind))) throw new AutomationRefusal(400, 'unsupported source kind');
    if (typeof body.bodyMarkdown !== 'string' || !body.bodyMarkdown.trim() || Buffer.byteLength(body.bodyMarkdown) > STUDIO_AUTOMATION_LIMITS.bodyBytes
      || body.bodyMarkdown.includes('\0')) throw new AutomationRefusal(400, 'bodyMarkdown is required and bounded');
    if (!optionalText(body.title, 200) || !optionalText(body.sourceRef, 2048) || !optionalText(body.artifactId, 128)
      || body.triggerKind !== undefined && !['manual', 'schedule', 'project-event'].includes(String(body.triggerKind))
      || body.memoryType !== undefined && !MEMORY_TYPES.includes(body.memoryType as MemoryType)
      || body.capabilityHints !== undefined && !(Array.isArray(body.capabilityHints) && body.capabilityHints.length <= 16
        && body.capabilityHints.every((hint) => text(hint, 128)))
      || body.candidateSinks !== undefined && !(Array.isArray(body.candidateSinks) && body.candidateSinks.length <= 5)
      || body.metadata !== undefined && !(plainObject(body.metadata) && jsonBounded(body.metadata, 16 * 1024))) {
      throw new AutomationRefusal(400, 'invalid ingestion field');
    }
    // Project and conversation references must be the owner's own; foreign ≡ missing.
    if (body.projectId !== undefined && body.projectId !== null) {
      if (!isSafeId(body.projectId) || !ownership.isOwnedBy(body.projectId, owner)) throw notFound();
    }
    if (body.conversationId !== undefined && body.conversationId !== null) {
      if (typeof body.conversationId !== 'string' || !body.projectId || !conversationInProject(body.projectId, body.conversationId)) throw notFound();
    }
    return body.templateId === undefined || body.templateId === null ? null : studioRunnableAutomationTemplate(body.templateId);
  };

  const ingest = (owner: string, body: CreateAutomationSourceIngestionRequest, template: AutomationTemplate | null): AutomationSourceIngestionResponse => {
    const plan = planAutomationIngestion(body, template, {
      packetId: `packet_${randomUUID()}`, sourceEventId: `source_event_${randomUUID()}`, capturedAt: new Date().toISOString(),
    });
    // Host-style relative targets are labels in the account store; creates carry none.
    const drafts = plan.proposals.map(({ targetRef: _targetRef, ...draft }) => draft);
    return db.transaction(() => {
      if (count('studio_automation_packets', owner) >= STUDIO_AUTOMATION_LIMITS.packets
        || count('studio_automation_proposals', owner) + drafts.length > STUDIO_AUTOMATION_LIMITS.proposals) {
        throw new AutomationRefusal(409, 'automation storage limit reached');
      }
      db.prepare('INSERT INTO studio_automation_packets (id, owner_account_id, packet_json, captured_at) VALUES (?, ?, ?, ?)')
        .run(plan.packet.id, owner, JSON.stringify(plan.packet), plan.packet.capturedAt);
      const proposals = drafts.map((draft) => buildAutomationProposal(draft));
      for (const proposal of proposals) insertProposal(owner, proposal);
      return { packet: plan.packet, compressionReport: plan.compressionReport, proposals };
    }).immediate();
  };

  const checkProposal = (owner: string, body: CreateAutomationEvolutionProposalRequest & { status?: AutomationProposalStatus }) => {
    if (!plainObject(body)) throw new AutomationRefusal(400, 'proposal body is required');
    if (body.targetKind === 'automation-template') throw unavailable('account automation templates');
    if (!(STUDIO_AUTOMATION_PROPOSAL_TARGETS as readonly string[]).includes(String(body.targetKind))
      || !(STUDIO_AUTOMATION_PROPOSAL_ACTIONS as readonly string[]).includes(String(body.action))
      || !text(body.title, 200) || !body.title.trim() || !text(body.summary, 2000) || !body.summary.trim()
      || body.status !== undefined && body.status !== 'draft' && body.status !== 'pending-review'
      || body.reviewPolicy !== undefined && !['always', 'trusted-source', 'auto-apply'].includes(String(body.reviewPolicy))
      || body.confidence !== undefined && !(typeof body.confidence === 'number' && body.confidence >= 0 && body.confidence <= 1)
      || body.compressionReport !== undefined && !(plainObject(body.compressionReport) && jsonBounded(body.compressionReport, 8 * 1024))
      || body.metadata !== undefined && !(plainObject(body.metadata) && jsonBounded(body.metadata, 16 * 1024))
      || !plainObject(body.patch) || !['markdown', 'json'].includes(String(body.patch.format))
      || Object.keys(body.patch).some((key) => !['format', 'before', 'after', 'diffSummary'].includes(key))
      || !optionalText(body.patch.before, STUDIO_AUTOMATION_LIMITS.bodyBytes) || !optionalText(body.patch.after, STUDIO_AUTOMATION_LIMITS.bodyBytes)
      || !optionalText(body.patch.diffSummary, 2000)
      || body.sourcePacketIds !== undefined && !(Array.isArray(body.sourcePacketIds) && body.sourcePacketIds.length <= 20)) {
      throw new AutomationRefusal(400, 'invalid proposal');
    }
    for (const packetId of body.sourcePacketIds ?? []) if (!packetRow(owner, packetId)) throw notFound();
    if (body.automationRunId !== undefined && body.automationRunId !== null
      && (typeof body.automationRunId !== 'string' || !routineRunOwned(owner, body.automationRunId))) throw notFound();
    // Updates and deletes name an existing resource of the owner; creates name none.
    if (body.action === 'create') {
      if (body.targetRef !== undefined && body.targetRef !== null) throw new AutomationRefusal(400, 'create proposals carry no target');
      if (body.patch.after === undefined || !String(body.patch.after).trim()) throw new AutomationRefusal(400, 'proposal patch.after is required');
    } else if (!targetExists(owner, body.targetKind, body.targetRef)) throw notFound();
  };
  const targetExists = (owner: string, kind: string, ref: unknown): boolean => {
    if (typeof ref !== 'string') return false;
    if (kind === 'skill') return ref.startsWith('studio-skill:') && Boolean(skills.read(owner, ref));
    if (kind === 'design-system') return ref.startsWith('user:studio_') && Boolean(designs.read(owner, ref));
    return MEMORY_ID.test(ref);
  };

  /** Serialize review per owner so one proposal applies once. */
  const reviewing = new Map<string, Promise<unknown>>();
  const serialized = <T>(owner: string, operation: () => Promise<T>): Promise<T> => {
    const next = (reviewing.get(owner) ?? Promise.resolve()).catch(() => {}).then(operation);
    reviewing.set(owner, next);
    return next.finally(() => { if (reviewing.get(owner) === next) reviewing.delete(owner); });
  };
  const finish = (owner: string, proposal: AutomationEvolutionProposal, status: AutomationProposalStatus, extra: Record<string, JsonValue>) => {
    const metadata = plainObject(proposal.metadata) ? proposal.metadata as Record<string, JsonValue> : {};
    const next: AutomationEvolutionProposal = { ...proposal, status, updatedAt: new Date().toISOString(), metadata: { ...metadata, ...extra } };
    const changed = db.prepare(`UPDATE studio_automation_proposals SET status = ?, proposal_json = ?, updated_at = ?
      WHERE id = ? AND owner_account_id = ? AND status IN ('draft', 'pending-review')`).run(status, JSON.stringify(next), next.updatedAt, proposal.id, owner).changes;
    if (!changed) throw new AutomationRefusal(409, 'proposal is no longer reviewable');
    return next;
  };

  const sourceMarkdown = (owner: string, proposal: AutomationEvolutionProposal) => proposal.sourcePacketIds
    .map((id) => packetRow(owner, id)).filter((row): row is { packet_json: string } => Boolean(row))
    .map((row) => JSON.parse(row.packet_json) as AutomationContentPacket)
    .map((packet) => `# ${packet.title}\n\nSource: ${packet.sourceKind} ${packet.sourceRef}\nSource packet: ${packet.id}\n\n${packet.bodyMarkdown}\n`).join('\n');

  const applySkill = (owner: string, proposal: AutomationEvolutionProposal): Record<string, JsonValue> => {
    if (proposal.action === 'delete') {
      if (!skills.delete(owner, String(proposal.targetRef))) throw notFound();
      return { skillId: String(proposal.targetRef), action: 'delete' };
    }
    const markdown = String(proposal.patch.after ?? '');
    const { data, body } = parseFrontmatter(markdown);
    const name = (typeof data.name === 'string' ? data.name.trim() : '') || proposal.title.replace(/^Skill:\s*/, '').trim();
    const description = typeof data.description === 'string' ? data.description.trim().slice(0, 1000) : '';
    const triggers = Array.isArray(data.triggers) ? data.triggers.filter((item): item is string => typeof item === 'string').slice(0, 32) : [];
    if (!name || name.length > 120 || !body.trim()) throw new AutomationRefusal(400, 'skill proposal needs a name and a body');
    if (proposal.action === 'update') {
      const updated = skills.update(owner, String(proposal.targetRef), { body: body.trim(), description, triggers });
      if (!updated) throw notFound();
      return { skillId: updated.id, action: proposal.action };
    }
    // A captured private package: SKILL.md plus the source material it was crystallized from.
    const source = sourceMarkdown(owner, proposal);
    const files = [{ path: 'SKILL.md', bytes: Buffer.from(markdown) },
      ...(source ? [{ path: 'references/source.md', bytes: Buffer.from(source) }] : [])];
    let created;
    try { created = skills.create(owner, { name, description, body: body.trim(), triggers }, files); }
    catch { throw new AutomationRefusal(400, 'skill proposal exceeds package limits'); }
    if (!created) throw new AutomationRefusal(409, 'a skill with this name already exists');
    return { skillId: created.id, action: 'create' };
  };
  const applyDesign = (owner: string, proposal: AutomationEvolutionProposal): Record<string, JsonValue> => {
    if (proposal.action === 'delete') {
      if (!designs.delete(owner, String(proposal.targetRef))) throw notFound();
      return { designSystemId: String(proposal.targetRef), action: 'delete' };
    }
    const markdown = String(proposal.patch.after ?? '').trimEnd() + '\n';
    if (Buffer.byteLength(markdown) > 256_000) throw new AutomationRefusal(400, 'design document too large');
    const title = (/^#\s+(.+)$/m.exec(markdown)?.[1] ?? proposal.title.replace(/^Design system:\s*/, '')).slice(0, 200).trim() || 'Untitled';
    const document = proposal.action === 'update'
      ? designs.update(owner, String(proposal.targetRef), { body: markdown })
      : designs.create(owner, { title, summary: proposal.summary.slice(0, 2000), body: markdown, status: 'draft' });
    if (!document) throw notFound();
    return { designSystemId: document.id, action: proposal.action };
  };
  const applyMemory = (owner: string, proposal: AutomationEvolutionProposal) => input.settings.withMemory(owner, async (root): Promise<Record<string, JsonValue>> => {
    if (proposal.action === 'delete') {
      const id = String(proposal.targetRef);
      if (!await readStudioMemoryEntry(root, id)) throw notFound();
      await deleteMemoryEntry(root, id);
      input.settings.publish(owner, { kind: 'delete', id });
      return { memoryId: id, action: 'delete' };
    }
    const before = proposal.targetRef ? await readStudioMemoryEntry(root, String(proposal.targetRef)) : null;
    if (proposal.action === 'update' && !before) throw notFound();
    const draft = memoryEntryFromProposal(proposal, before);
    const id = draft.id ?? deriveMemoryId(draft.type, draft.name);
    if (!MEMORY_ID.test(id)) throw new AutomationRefusal(400, 'invalid memory proposal');
    // A create never overwrites an existing entry of the account.
    if (proposal.action === 'create' && await readStudioMemoryEntry(root, id)) throw new AutomationRefusal(409, 'memory entry already exists');
    const entry = await saveStudioMemoryEntry(root, { ...draft, id });
    if (entry === 'invalid' || entry === 'limit') throw new AutomationRefusal(entry === 'limit' ? 409 : 400, entry === 'limit' ? 'memory limit reached' : 'invalid memory proposal');
    input.settings.publish(owner, { kind: 'upsert', id: entry.id });
    return { memoryId: entry.id, action: proposal.action };
  });

  const handle = (operation: (req: Request, res: Response, owner: string) => unknown) => async (req: Request, res: Response) => {
    const owner = multiUserActorOf(res)?.accountId;
    if (!owner) return sendApiError(res, 401, 'UNAUTHORIZED', 'authentication required');
    try { await operation(req, res, owner); }
    catch (error) {
      if (res.headersSent || !multiUserStreamAllowed(res)) return;
      if (error instanceof AutomationRefusal) return sendApiError(res, error.status, error.status === 404 ? 'NOT_FOUND'
        : error.status === 403 ? 'MULTIUSER_CAPABILITY_UNAVAILABLE' : error.status === 409 ? 'CONFLICT' : 'BAD_REQUEST', error.message);
      sendApiError(res, 400, 'BAD_REQUEST', 'automation request refused');
    }
  };
  const reply = (res: Response, status: number, body: unknown) => { if (multiUserStreamAllowed(res)) res.status(status).json(body); };

  app.get('/api/multiuser/automation-templates', handle((_req, res) => reply(res, 200, { templates: studioAutomationTemplates() })));
  app.get('/api/multiuser/automation-templates/:id', handle((req, res) => {
    const template = studioAutomationTemplates().find((item) => item.id === req.params.id);
    if (!template) throw notFound();
    reply(res, 200, { template });
  }));
  app.get('/api/multiuser/automation-source-packets', handle((req, res, owner) => {
    const limit = Math.min(STUDIO_AUTOMATION_LIMITS.packets, Math.max(1, Number(req.query.limit) || 100));
    const rows = db.prepare('SELECT packet_json FROM studio_automation_packets WHERE owner_account_id = ? ORDER BY captured_at DESC, rowid DESC LIMIT ?')
      .all(owner, limit) as Array<{ packet_json: string }>;
    reply(res, 200, { packets: rows.map((row) => JSON.parse(row.packet_json)) });
  }));
  app.get('/api/multiuser/automation-source-packets/:id', handle((req, res, owner) => {
    const row = packetRow(owner, req.params.id);
    if (!row) throw notFound();
    reply(res, 200, { packet: JSON.parse(row.packet_json) });
  }));
  app.post('/api/multiuser/automation-ingestions', handle((req, res, owner) => {
    const body = (req.body ?? {}) as CreateAutomationSourceIngestionRequest;
    reply(res, 200, ingest(owner, body, checkIngestion(owner, body)));
  }));
  app.get('/api/multiuser/automation-proposals', handle((req, res, owner) => {
    const status = typeof req.query.status === 'string' ? req.query.status : 'all';
    if (status !== 'all' && !['draft', 'pending-review', 'applied', 'rejected', 'superseded', 'failed'].includes(status)) throw new AutomationRefusal(400, 'invalid status');
    const rows = (status === 'all'
      ? db.prepare('SELECT proposal_json FROM studio_automation_proposals WHERE owner_account_id = ? ORDER BY updated_at DESC, rowid DESC').all(owner)
      : db.prepare('SELECT proposal_json FROM studio_automation_proposals WHERE owner_account_id = ? AND status = ? ORDER BY updated_at DESC, rowid DESC').all(owner, status)) as Array<{ proposal_json: string }>;
    reply(res, 200, { proposals: rows.map((row) => JSON.parse(row.proposal_json)) });
  }));
  app.post('/api/multiuser/automation-proposals', handle((req, res, owner) => {
    const body = (req.body ?? {}) as CreateAutomationEvolutionProposalRequest & { status?: AutomationProposalStatus };
    checkProposal(owner, body);
    const proposal = buildAutomationProposal({ ...body, sourcePacketIds: body.sourcePacketIds ?? [] });
    db.transaction(() => {
      if (count('studio_automation_proposals', owner) >= STUDIO_AUTOMATION_LIMITS.proposals) throw new AutomationRefusal(409, 'automation storage limit reached');
      insertProposal(owner, proposal);
    }).immediate();
    reply(res, 200, { proposal });
  }));
  app.get('/api/multiuser/automation-proposals/:id', handle((req, res, owner) => {
    const proposal = proposalOf(owner, req.params.id);
    if (!proposal) throw notFound();
    reply(res, 200, { proposal });
  }));
  app.post('/api/multiuser/automation-proposals/:id/apply', handle((req, res, owner) => serialized(owner, async () => {
    const proposal = proposalOf(owner, req.params.id);
    if (!proposal) throw notFound();
    try { assertReviewable(proposal); } catch { throw new AutomationRefusal(409, 'proposal is not reviewable'); }
    if (!multiUserStreamAllowed(res)) return;
    const result = proposal.targetKind === 'memory-node' ? await applyMemory(owner, proposal)
      : proposal.targetKind === 'skill' ? applySkill(owner, proposal)
        : proposal.targetKind === 'design-system' ? applyDesign(owner, proposal)
          : (() => { throw unavailable('account automation templates'); })();
    const next = finish(owner, proposal, 'applied', { appliedResult: result });
    reply(res, 200, { proposal: next, result });
  })));
  app.post('/api/multiuser/automation-proposals/:id/reject', handle((req, res, owner) => serialized(owner, async () => {
    const proposal = proposalOf(owner, req.params.id);
    if (!proposal) throw notFound();
    try { assertReviewable(proposal); } catch { throw new AutomationRefusal(409, 'proposal is not reviewable'); }
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 2000) : '';
    reply(res, 200, { proposal: finish(owner, proposal, 'rejected', reason ? { rejectedReason: reason } : {}) });
  })));

  return { ingest: (owner, body) => ingest(owner, body, checkIngestion(owner, body)) };
}
