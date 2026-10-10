import { StudioConnectorRuntimeError, type StudioConnectorRuntime } from '../connectors/studio-runtime.js';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import type Database from 'better-sqlite3';
import type { Express, Request, Response } from 'express';
import { STUDIO_MCP_NOT_IN_RUNS_REASON, automationTemplateRoutinePrompt, studioRoutineAgentId, studioRoutineExecutionSource, type StudioExecutionSource,
  type CreateRoutineRequest, type Routine, type RoutineRun, type RoutineSchedule, type RoutineProjectTarget, type UpdateRoutineRequest } from '@open-design/contracts';
import { getProject, insertConversation, insertProject } from '../db.js';
import { multiUserActorOf } from '../http/multiuser-gate.js';
import { multiUserStreamAllowed } from '../http/multiuser-stream.js';
import { sendApiError } from '../http/api-errors.js';
import type { InternalMultiUserResult } from '../http/multiuser-internal.js';
import { RoutineService, nextRunAtForSchedule, validateSchedule, validateTarget, type RoutineRunCompletion } from '../routines.js';
import { AuthStore } from '../storage/auth-store.js';
import { ProjectOwnershipStore } from '../storage/project-ownership.js';
import { migrateStudioRoutines } from '../storage/studio-routines.js';
import { StudioAutomationTemplates } from '../storage/studio-automation-templates.js';
import { isSafeId, projectDir } from '../projects.js';
import type { AuthActor } from '../services/auth-service.js';
import { AutomationRefusal, studioRunnableAutomationTemplate, type StudioAutomations } from './studio-automations.js';

const ROUTINE_LIMIT = 20;
const POLL_MS = 1_000;
type Source = StudioExecutionSource['source'];
interface RoutineRow {
  id: string; owner_account_id: string; name: string; prompt: string; schedule_json: string; target_json: string;
  connector_ids_json: string; skill_ids_json: string; execution_source: Source; enabled: number; created_at: number; updated_at: number; template_id: string | null;
}
interface RunRow {
  id: string; routine_id: string; trigger: RoutineRun['trigger']; status: RoutineRun['status']; project_id: string;
  conversation_id: string; agent_run_id: string; started_at: number; completed_at: number | null;
  summary: string | null; error: string | null; error_code: string | null;
}
export interface StudioRoutineRuns {
  admitInternal(actor: AuthActor, request: Record<string, unknown>, allowed: () => boolean, instruction?: string): Promise<InternalMultiUserResult>;
  runState(runId: string, accountId: string): { status: string; text: string | null; reason: string | null } | null;
}

class RoutineRefusal extends Error {
  constructor(readonly status: number, message: string, readonly details?: { capability: string; reason: string }) { super(message); }
}

/**
 * Account-owned Automations. Every routine, run and claim row carries the
 * owner; a dispatch re-resolves the owner's account, pilot state, project
 * ownership and execution source before admitting a standard run through the
 * same policy as POST /api/runs. There is no host agent, config or credential
 * fallback, and nothing here reads the host-global routine tables.
 */
export function registerStudioRoutineRoutes(app: Express, input: {
  db: Database.Database; dataRoot: string; projectsRoot: string; runs: StudioRoutineRuns; clock?: () => number;
  /** Account automation store for crystallize (#64). */
  automations?: StudioAutomations;
  connectors?: StudioConnectorRuntime;
}): { stop(): void } {
  const { db } = input;
  const now = input.clock ?? Date.now;
  const auth = AuthStore.open({ dataRoot: input.dataRoot });
  const ownership = new ProjectOwnershipStore(db);
  const templates = new StudioAutomationTemplates(db);
  migrateStudioRoutines(db);

  /** The owner may still run work: active, password set and in the Studio pilot. */
  const ownerUsable = (owner: string): AuthActor | null => {
    const account = auth.getAccountById(owner);
    if (!account?.active || account.passwordState !== 'set' || !auth.getStudioPilot(owner).studioPilot) return null;
    return { accountId: account.id, username: account.username, role: account.role, sessionId: `routine:${owner}`, sessionExpiresAt: now() + 3_600_000 };
  };
  const routineRow = (id: string) => db.prepare('SELECT * FROM studio_routines WHERE id = ?').get(id) as RoutineRow | undefined;
  const ownedRow = (owner: string, id: string) => {
    const found = routineRow(id);
    return found?.owner_account_id === owner ? found : undefined;
  };
  const runDto = (run: RunRow): RoutineRun => ({ id: run.id, routineId: run.routine_id, trigger: run.trigger, status: run.status,
    projectId: run.project_id, conversationId: run.conversation_id, agentRunId: run.agent_run_id, startedAt: run.started_at,
    completedAt: run.completed_at, summary: run.summary, error: run.error, errorCode: run.error_code });
  const latestRun = (routineId: string) => db.prepare('SELECT * FROM studio_routine_runs WHERE routine_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1')
    .get(routineId) as RunRow | undefined;
  let service: RoutineService;
  const dto = (found: RoutineRow): Routine => {
    const schedule = JSON.parse(found.schedule_json) as RoutineSchedule;
    const last = latestRun(found.id);
    const next = found.enabled ? service.nextRunAt(found.id) ?? nextRunAtForSchedule(schedule) : null;
    return { id: found.id, name: found.name, prompt: found.prompt, schedule, target: JSON.parse(found.target_json) as RoutineProjectTarget,
      skillId: (JSON.parse(found.skill_ids_json) as string[])[0] ?? null, agentId: studioRoutineAgentId(found.execution_source),
      context: { skillIds: JSON.parse(found.skill_ids_json) as string[], connectorIds: JSON.parse(found.connector_ids_json) as string[] }, enabled: found.enabled === 1,
      nextRunAt: next ? next.getTime() : null,
      lastRun: last ? { runId: last.id, status: last.status, trigger: last.trigger, startedAt: last.started_at,
        ...(last.completed_at ? { completedAt: last.completed_at } : {}), projectId: last.project_id, conversationId: last.conversation_id,
        agentRunId: last.agent_run_id, ...(last.summary ? { summary: last.summary } : {}), ...(last.error ? { error: last.error } : {}),
        ...(last.error_code ? { errorCode: last.error_code } : {}) } : null,
      createdAt: found.created_at, updatedAt: found.updated_at, templateId: found.template_id ?? null };
  };

  service = new RoutineService({
    // Only routines whose owner can still run are scheduled at all.
    list: () => (db.prepare('SELECT * FROM studio_routines ORDER BY created_at').all() as RoutineRow[])
      .filter((found) => ownerUsable(found.owner_account_id)).map((found) => dto(found) as never),
    insertRun(run, options) {
      const owner = routineRow(run.routineId)?.owner_account_id;
      if (!owner) return false;
      return db.transaction(() => {
        if (options?.scheduledSlotAt !== undefined && db.prepare('INSERT OR IGNORE INTO studio_routine_claims (routine_id, slot_at) VALUES (?, ?)')
          .run(run.routineId, options.scheduledSlotAt).changes === 0) return false;
        db.prepare(`INSERT INTO studio_routine_runs (id, routine_id, owner_account_id, trigger, status, project_id, conversation_id, agent_run_id, started_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(run.id, run.routineId, owner, run.trigger, run.status, run.projectId, run.conversationId, run.agentRunId, run.startedAt);
        return true;
      }).immediate();
    },
    updateRun(id, patch) {
      const columns: Record<string, string> = { status: 'status', projectId: 'project_id', conversationId: 'conversation_id', agentRunId: 'agent_run_id',
        completedAt: 'completed_at', summary: 'summary', error: 'error', errorCode: 'error_code' };
      const entries = Object.entries(patch).filter(([key]) => columns[key]);
      if (!entries.length) return;
      db.prepare(`UPDATE studio_routine_runs SET ${entries.map(([key]) => `${columns[key]} = ?`).join(', ')} WHERE id = ?`)
        .run(...entries.map(([, value]) => value ?? null), id);
    },
    getLatestRun: (routineId) => { const found = latestRun(routineId); return found ? runDto(found) as never : null; },
  });

  /** A fresh managed project/conversation per run (or a new conversation in an
   * owned project): a routine never continues a user's interactive thread. */
  const prepareTarget = (owner: string, routine: RoutineRow, startedAt: number): { projectId: string; conversationId: string; created: boolean } => {
    const target = JSON.parse(routine.target_json) as RoutineProjectTarget;
    const conversationId = randomUUID();
    if (target.mode === 'reuse') {
      if (!ownership.isOwnedBy(target.projectId, owner) || !getProject(db, target.projectId)) throw new Error('routine target project unavailable');
      db.transaction(() => insertConversation(db, { id: conversationId, projectId: target.projectId, title: routine.name,
        sessionMode: 'design', createdAt: startedAt, updatedAt: startedAt }))();
      return { projectId: target.projectId, conversationId, created: false };
    }
    const projectId = randomUUID();
    fs.mkdirSync(input.projectsRoot, { recursive: true });
    fs.mkdirSync(projectDir(input.projectsRoot, projectId), { mode: 0o700 });
    db.transaction(() => {
      insertProject(db, { id: projectId, name: `${routine.name} · ${new Date(startedAt).toISOString().slice(0, 16).replace('T', ' ')}`,
        skillId: null, designSystemId: null, customInstructions: null, pendingPrompt: null, metadata: { kind: 'prototype' },
        createdAt: startedAt, updatedAt: startedAt });
      insertConversation(db, { id: conversationId, projectId, title: routine.name, sessionMode: 'design', createdAt: startedAt, updatedAt: startedAt });
      ownership.bindOwner(projectId, owner, startedAt);
    }).immediate();
    return { projectId, conversationId, created: true };
  };
  const removeTarget = (prepared: { projectId: string; conversationId: string; created: boolean }) => {
    if (prepared.created) {
      db.prepare('DELETE FROM projects WHERE id = ?').run(prepared.projectId);
      fs.rmSync(projectDir(input.projectsRoot, prepared.projectId), { recursive: true, force: true });
    } else db.prepare('DELETE FROM conversations WHERE id = ?').run(prepared.conversationId);
  };

  service.setRunHandler(async ({ routine, startedAt, runId }) => {
    const found = routineRow(routine.id);
    const owner = found?.owner_account_id;
    if (!found || !owner || !ownerUsable(owner)) throw new Error('routine owner cannot run work');
    const prepared = prepareTarget(owner, found, startedAt);
    let settle!: (completion: RoutineRunCompletion) => void;
    const completion = new Promise<RoutineRunCompletion>((resolve) => { settle = resolve; });
    const templateUsable = () => {
      if (!found.template_id) return true;
      try { studioRunnableAutomationTemplate(found.template_id, templates.list(owner)); return true; }
      catch { return false; }
    };
    const allowed = () => Boolean(routineRow(found.id) && ownerUsable(owner) && ownership.isOwnedBy(prepared.projectId, owner) && templateUsable());
    return {
      projectId: prepared.projectId, conversationId: prepared.conversationId, agentRunId: '', completion,
      discardUnstarted: () => removeTarget(prepared),
      discard: () => settle({ status: 'canceled', error: 'routine run was not started' }),
      start: () => { void (async () => {
        const actor = ownerUsable(owner);
        if (!actor) return settle({ status: 'failed', error: 'routine owner cannot run work', errorCode: 'MULTIUSER_PERSONAL_UNAVAILABLE' });
        // A template routine runs only while its bundled or private template is still runnable for this owner.
        if (found.template_id) {
          try { studioRunnableAutomationTemplate(found.template_id, templates.list(owner)); }
          catch { return settle({ status: 'failed', error: 'routine template is not available', errorCode: 'MULTIUSER_CAPABILITY_UNAVAILABLE' }); }
        }
        if (!allowed()) return settle({ status: 'failed', error: 'routine authority changed', errorCode: 'MULTIUSER_PERSONAL_UNAVAILABLE' });
        const connectorIds = JSON.parse(found.connector_ids_json) as string[];
        try {
          if (connectorIds.length && !input.connectors) throw new StudioConnectorRuntimeError('CONNECTOR_NOT_GRANTED');
          input.connectors?.capture(actor, connectorIds);
        } catch (error) { return settle({ status: 'failed', error: 'routine connectors unavailable',
          errorCode: error instanceof StudioConnectorRuntimeError ? error.code : 'CONNECTOR_NOT_GRANTED' }); }
        const admitted = await input.runs.admitInternal(actor, { projectId: prepared.projectId, conversationId: prepared.conversationId,
          executionSource: found.execution_source, clientRequestId: `routine-${runId}`,
          skillIds: JSON.parse(found.skill_ids_json) as string[], context: { connectorIds }, message: found.prompt }, allowed,
          [`You are running an unattended scheduled routine named "${found.name}".`,
            'Do not ask follow-up questions, do not emit <question-form>, and do not wait for user input. Pick reasonable defaults and finish the task.'].join('\n'));
        const agentRunId = (admitted.body as { runId?: unknown } | null)?.runId;
        if (admitted.status >= 300 || typeof agentRunId !== 'string') {
          const code = (admitted.body as { error?: { code?: unknown } } | null)?.error?.code;
          return settle({ status: 'failed', error: 'routine run was refused', errorCode: typeof code === 'string' ? code : null });
        }
        db.prepare('UPDATE studio_routine_runs SET agent_run_id = ? WHERE id = ?').run(agentRunId, runId);
        const poll = setInterval(() => {
          const state = input.runs.runState(agentRunId, owner);
          if (!state) { clearInterval(poll); return settle({ status: 'failed', error: 'routine run disappeared' }); }
          if (!['succeeded', 'failed', 'canceled'].includes(state.status)) return;
          clearInterval(poll);
          settle({ status: state.status as RoutineRunCompletion['status'], ...(state.text ? { summary: state.text.slice(0, 2000) } : {}),
            ...(state.status === 'failed' ? { error: 'run failed', errorCode: state.reason } : {}) });
        }, POLL_MS);
        poll.unref();
      })().catch(() => settle({ status: 'failed', error: 'routine run failed to start' })); },
    };
  });

  const parse = (owner: string, body: Partial<CreateRoutineRequest & UpdateRoutineRequest>, existing?: RoutineRow) => {
    const record = body as Record<string, unknown>;
    if (Object.keys(record).some((key) => !['name', 'prompt', 'schedule', 'target', 'skillId', 'agentId', 'context', 'enabled', 'templateId'].includes(key)))
      throw new RoutineRefusal(400, 'unsupported routine field');
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw new RoutineRefusal(400, 'invalid enabled flag');
    const enabled = body.enabled ?? (existing ? existing.enabled === 1 : true);
    /**
     * Creation and enabling a disabled routine are the edits that may start
     * work, so (like every dispatch) they re-establish the routine's template
     * and connector authority. Other edits of an existing routine — disabling
     * it, renaming it, clearing its connectors — must stay possible after the
     * owner deleted a private template or disconnected an app (S60 A3/A4).
     */
    const enabling = !existing || (enabled && existing.enabled !== 1);
    // A readable template is chosen once, at creation; it supplies the captured default name and prompt.
    let templateId: string | null = existing?.template_id ?? null;
    let needsConnector = false;
    if (body.templateId !== undefined && body.templateId !== null || existing?.template_id) {
      if (existing && body.templateId != null && body.templateId !== existing.template_id) throw new RoutineRefusal(400, 'a routine keeps the template it was created from');
      let template;
      try { template = studioRunnableAutomationTemplate(body.templateId ?? existing?.template_id, templates.list(owner)); }
      catch (error) {
        if (enabling) throw new RoutineRefusal((error as { status?: number }).status === 403 ? 403 : 404, 'automation template not available');
        template = null;
      }
      if (template) {
        templateId = template.id;
        needsConnector = template.sourceKinds.every((kind) => kind === 'connector');
        if (!existing) {
          if (body.name === undefined) body = { ...body, name: template.title.slice(0, 100) };
          if (body.prompt === undefined) body = { ...body, prompt: automationTemplateRoutinePrompt(template) };
        }
      }
    }
    const text = (value: unknown, max: number) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !value.includes('\0');
    if ((!existing || body.name !== undefined) && !text(body.name, 100)) throw new RoutineRefusal(400, 'name is required');
    if ((!existing || body.prompt !== undefined) && !text(body.prompt, 32_000)) throw new RoutineRefusal(400, 'prompt is required');
    const schedule = body.schedule ?? (existing ? JSON.parse(existing.schedule_json) : undefined);
    const target = body.target ?? (existing ? JSON.parse(existing.target_json) : { mode: 'create_each_run' });
    try { validateSchedule(schedule); validateTarget(target); } catch (error) { throw new RoutineRefusal(400, error instanceof Error ? error.message : 'invalid schedule'); }
    if (Object.keys(target).some((key) => !['mode', 'projectId'].includes(key))
      || target.mode === 'reuse' && (!isSafeId(target.projectId) || !ownership.isOwnedBy(target.projectId, owner))) throw new RoutineRefusal(404, 'resource not found');
    const selectedSource = studioRoutineExecutionSource(body.agentId);
    if (body.agentId !== undefined && body.agentId !== null && selectedSource === null) {
      throw new RoutineRefusal(403, 'routines require personal Codex, the company OpenAI pool or the account\'s own OpenAI key');
    }
    const context = (body.context ?? {}) as Record<string, unknown>;
    const empty = (value: unknown) => value === undefined || value === null || Array.isArray(value) && value.length === 0;
    const connectorIds = (body.context ? context.connectorIds ?? [] : existing ? JSON.parse(existing.connector_ids_json) : []) as unknown;
    if (!Array.isArray(connectorIds) || connectorIds.length > 12 || connectorIds.some((id) => typeof id !== 'string' || !/^[a-z0-9_]{1,64}$/.test(id))) throw new RoutineRefusal(400, 'invalid connector selections');
    // A connector-only template needs a selection whenever the routine can run.
    if (needsConnector && !connectorIds.length && enabled) throw new StudioConnectorRuntimeError('CONNECTOR_NOT_GRANTED');
    const previous = new Set(existing ? JSON.parse(existing.connector_ids_json) as string[] : []);
    const selectionChanged = !existing || connectorIds.length !== previous.size || connectorIds.some((id) => !previous.has(id as string));
    // Re-checked only when the selection changes or the routine is created/enabled; clearing never needs a connection.
    if (connectorIds.length && (selectionChanged || enabling)) {
      const actor = ownerUsable(owner);
      if (!actor || !input.connectors) throw new StudioConnectorRuntimeError('CONNECTOR_NOT_GRANTED');
      input.connectors.capture(actor, connectorIds as string[]);
    }
    // Account MCP servers (#62, S60) are configurable in Settings; run-time use opens in S61.
    if (!empty(context.mcpServerIds)) throw new RoutineRefusal(403, STUDIO_MCP_NOT_IN_RUNS_REASON, { capability: 'mcp', reason: STUDIO_MCP_NOT_IN_RUNS_REASON });
    if (Object.keys(context).some((key) => !['skillIds', 'pluginIds', 'mcpServerIds', 'connectorIds', 'workspaceScope'].includes(key))
      || !empty(context.pluginIds) || !empty(context.workspaceScope))
      throw new RoutineRefusal(403, 'plugins and workspace scopes are not available for routines');
    // The standard form sends the primary skill both as skillId and inside context.skillIds.
    const listed = body.context || body.skillId !== undefined ? context.skillIds ?? [] : existing ? JSON.parse(existing.skill_ids_json) : [];
    if (body.skillId !== undefined && body.skillId !== null && typeof body.skillId !== 'string') throw new RoutineRefusal(400, 'invalid skills');
    const skillIds = Array.isArray(listed) ? [...new Set([...(body.skillId ? [body.skillId] : []), ...listed])] : listed;
    if (!Array.isArray(skillIds) || skillIds.length > 12 || skillIds.some((id) => typeof id !== 'string' || !id || id.length > 256)) throw new RoutineRefusal(400, 'invalid skills');
    const source: Source = selectedSource ?? existing?.execution_source ?? 'personal_subscription';
    return { name: body.name?.trim() ?? existing!.name, prompt: body.prompt ?? existing!.prompt, schedule, target, skillIds, connectorIds, source,
      enabled, templateId };
  };
  const handle = (operation: (req: Request, res: Response, owner: string) => unknown) => async (req: Request, res: Response) => {
    const owner = multiUserActorOf(res)?.accountId;
    if (!owner) return sendApiError(res, 401, 'UNAUTHORIZED', 'authentication required');
    try { await operation(req, res, owner); }
    catch (error) {
      if (res.headersSent) return;
      // Routine and automation-store refusals carry their own status (no stack or host detail).
      const status = (error as { status?: unknown } | null)?.status;
      if (error instanceof StudioConnectorRuntimeError) return sendApiError(res, error.status, error.code, 'routine connectors unavailable');
      if ((error instanceof RoutineRefusal || error instanceof AutomationRefusal) && typeof status === 'number') {
        const details = error instanceof RoutineRefusal && error.details ? { details: error.details } : {};
        return sendApiError(res, status, status === 404 ? 'NOT_FOUND' : status === 403 ? 'MULTIUSER_CAPABILITY_UNAVAILABLE'
          : status === 409 ? 'CONFLICT' : 'BAD_REQUEST', (error as Error).message, details);
      }
      sendApiError(res, 400, 'BAD_REQUEST', 'routine request refused');
    }
  };
  const owned = (owner: string, id: unknown) => {
    const found = typeof id === 'string' ? ownedRow(owner, id) : undefined;
    if (!found) throw new RoutineRefusal(404, 'routine not found');
    return found;
  };
  const prefix = '/api/multiuser/routines';
  app.get(prefix, handle((_req, res, owner) => {
    res.json({ routines: (db.prepare('SELECT * FROM studio_routines WHERE owner_account_id = ? ORDER BY created_at').all(owner) as RoutineRow[]).map(dto) });
  }));
  app.post(prefix, handle((req, res, owner) => {
    const fields = parse(owner, req.body ?? {});
    const count = (db.prepare('SELECT COUNT(*) AS n FROM studio_routines WHERE owner_account_id = ?').get(owner) as { n: number }).n;
    if (count >= ROUTINE_LIMIT) throw new RoutineRefusal(409, 'routine limit reached');
    const id = `studio-routine-${randomUUID()}`; const at = now();
    db.prepare(`INSERT INTO studio_routines (id, owner_account_id, name, prompt, schedule_json, target_json, skill_ids_json, execution_source, enabled, created_at, updated_at, template_id, connector_ids_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, owner, fields.name, fields.prompt, JSON.stringify(fields.schedule), JSON.stringify(fields.target),
      JSON.stringify(fields.skillIds), fields.source, fields.enabled ? 1 : 0, at, at, fields.templateId, JSON.stringify(fields.connectorIds));
    service.rescheduleOne(id);
    res.status(201).json({ routine: dto(routineRow(id)!) });
  }));
  app.get(`${prefix}/:id`, handle((req, res, owner) => { res.json({ routine: dto(owned(owner, req.params.id)) }); }));
  app.patch(`${prefix}/:id`, handle((req, res, owner) => {
    const existing = owned(owner, req.params.id);
    const fields = parse(owner, req.body ?? {}, existing);
    db.prepare(`UPDATE studio_routines SET name = ?, prompt = ?, schedule_json = ?, target_json = ?, skill_ids_json = ?, execution_source = ?, enabled = ?, updated_at = ?, connector_ids_json = ?
      WHERE id = ? AND owner_account_id = ?`).run(fields.name, fields.prompt, JSON.stringify(fields.schedule), JSON.stringify(fields.target),
      JSON.stringify(fields.skillIds), fields.source, fields.enabled ? 1 : 0, now(), JSON.stringify(fields.connectorIds), existing.id, owner);
    service.rescheduleOne(existing.id);
    res.json({ routine: dto(routineRow(existing.id)!) });
  }));
  app.delete(`${prefix}/:id`, handle((req, res, owner) => {
    const existing = owned(owner, req.params.id);
    service.unschedule(existing.id);
    db.prepare('DELETE FROM studio_routines WHERE id = ? AND owner_account_id = ?').run(existing.id, owner);
    res.json({ ok: true });
  }));
  app.post(`${prefix}/:id/run`, handle(async (req, res, owner) => {
    const existing = owned(owner, req.params.id);
    const started = await service.runNow(existing.id);
    if (!multiUserStreamAllowed(res)) return;
    const run = db.prepare('SELECT * FROM studio_routine_runs WHERE routine_id = ? AND project_id = ? ORDER BY started_at DESC LIMIT 1')
      .get(existing.id, started.projectId) as RunRow | undefined;
    if (!run) throw new RoutineRefusal(409, 'routine run was not recorded');
    // Same additive fields as the host route, so Run opens the new conversation.
    res.status(202).json({ routine: dto(routineRow(existing.id)!), run: runDto(run),
      projectId: run.project_id, conversationId: run.conversation_id, agentRunId: run.agent_run_id });
  }));
  app.get(`${prefix}/:id/runs`, handle((req, res, owner) => {
    const existing = owned(owner, req.params.id);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    res.json({ runs: (db.prepare('SELECT * FROM studio_routine_runs WHERE routine_id = ? AND owner_account_id = ? ORDER BY started_at DESC LIMIT ?')
      .all(existing.id, owner, limit) as RunRow[]).map(runDto) });
  }));
  // Crystallize (#64): a succeeded run of the owner's routine becomes reviewable
  // skill and memory proposals in the owner's automation store. The run, its
  // routine and its project are re-resolved for the owner; foreign ≡ missing.
  app.post(`${prefix}/:id/runs/:runId/crystallize`, handle((req, res, owner) => {
    const routine = owned(owner, req.params.id);
    const run = db.prepare('SELECT * FROM studio_routine_runs WHERE id = ? AND routine_id = ? AND owner_account_id = ?')
      .get(String(req.params.runId), routine.id, owner) as RunRow | undefined;
    if (!run || !ownership.isOwnedBy(run.project_id, owner) || !getProject(db, run.project_id)) throw new RoutineRefusal(404, 'routine run not found');
    if (run.status !== 'succeeded') throw new RoutineRefusal(409, 'only succeeded routine runs can be crystallized');
    if (!input.automations) throw new RoutineRefusal(403, 'automation proposals are not available');
    const bodyMarkdown = [`# ${routine.name} reusable workflow`, '', `Routine id: ${routine.id}`, `Routine run: ${run.id}`,
      `Project id: ${run.project_id}`, `Conversation id: ${run.conversation_id}`, `Agent run id: ${run.agent_run_id}`, '',
      '## Original Automation Prompt', '', routine.prompt, '', '## Run Summary', '',
      run.summary || 'No run summary was recorded; crystallize from the automation prompt and run metadata.'].join('\n');
    const result = input.automations.ingest(owner, { templateId: 'crystallize-run-into-skill', sourceKind: 'chat', sourceRef: `routine-run:${run.id}`,
      title: `${routine.name} run`, bodyMarkdown, projectId: run.project_id, conversationId: run.conversation_id, tokenCompression: 'balanced',
      metadata: { routineId: routine.id, routineRunId: run.id, agentRunId: run.agent_run_id } });
    if (multiUserStreamAllowed(res)) res.json({ ...result, routineId: routine.id, runId: run.id });
  }));
  service.start();
  return { stop() { service.stop(); auth.close(); } };
}
