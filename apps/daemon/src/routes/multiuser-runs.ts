import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { Express, Request, Response } from 'express';
import { API_ERROR_CODES, isStudioCodexModel, isStudioCodexReasoning, MULTIUSER_PERSONAL_RUN_FIELD_POLICY, emittedRenderableQuestionForm, isStudioMessageIdInNamespace, parseStudioMessageFeedback, type ApiErrorCode, type ChatRunFeedbackResponse } from '@open-design/contracts';
import { PersonalRunEvents } from '../runtimes/personal-run-events.js';
import { formatProjectAttachmentHint, resolveSafeProjectAttachments } from '../runtimes/chat-prompt-inputs.js';
import { renderRunContextPrompt } from '../runtimes/chat-run-context.js';
import { classifyRunSteering } from '../runtimes/run-steering.js';
import { RESTART_ERROR_CODE } from '../runtimes/run-restart-recovery.js';
import type { MultiUserRun, MultiUserRunEvent, MultiUserRunStatus, MultiUserRunsResponse } from '@open-design/contracts';
import { getConversation, getMessage, getProject, updateProject } from '../db.js';
import { sendApiError } from '../http/api-errors.js';
import { multiUserActorOf } from '../http/multiuser-gate.js';
import { bindMultiUserStream, multiUserStreamAllowed } from '../http/multiuser-stream.js';
import { PROJECT_OWNERS_TABLE, ProjectOwnershipStore } from '../storage/project-ownership.js';
import { MultiUserStudioMessages } from '../storage/multiuser-studio-messages.js';
import { studioMessageIdPrefix } from '../http/studio-parity.js';
import { WorkerQuotaLedger } from '../storage/worker-quota-ledger.js';
import { AuthStore } from '../storage/auth-store.js';
import { isSafeId, kindFor, mimeFor } from '../projects.js';
import { diffRunArtifacts, snapshotProjectArtifacts, snapshotProjectArtifactsAsync, type ArtifactSnapshot } from '../run-artifact-fs.js';
import { createChatArtifactBlobStore } from '../chat-artifacts/blob-store.js';
import { captureRunChatArtifactSnapshots } from '../chat-artifacts/run-capture.js';
import { codexResolvedSandboxMode } from '../runtimes/defs/codex.js';
import { PROBLEM_ERRORS, runPersonalCodexTurn, type PersonalCodexAccounts } from '../services/personal-codex-accounts.js';
import type { PersonalRunLaneControls } from './multiuser-agent-accounts.js';
import type { MultiUserDesignRoutes } from './multiuser-design.js';
import { CompanyOpenAIConfigError, CompanyOpenAIStore } from '../storage/company-openai.js';
import { CompanyOpenAIWorker, runCompanyOpenAITurn } from '../runtimes/company-openai.js';
import type { StudioDesignCatalog } from './studio-design-catalog.js';
import type { StudioSettings } from '../storage/studio-settings.js';
import type { StudioCatalog } from './studio-catalog.js';
import { composeSystemPrompt } from '../prompts/system.js';
import { readStudioSkillPackages, stageStudioSkillPackages, type StudioSkillPackage } from '../services/studio-skill-packages.js';
import { createStudioSkillScriptRunner } from '../services/studio-skill-scripts.js';
import type { PersonalSandbox } from '../services/personal-sandbox.js';
import { internalMultiUserResponse, type InternalMultiUserResult } from '../http/multiuser-internal.js';
import type { AuthActor } from '../services/auth-service.js';

type RunRow = {
  id: string; owner_account_id: string; project_id: string; conversation_id: string;
  status: 'queued' | 'active' | 'succeeded' | 'failed' | 'canceled'; created_at: number; updated_at: number; output: string | null;
  request_json: string | null; queue_seq: number | null;
  execution_source: 'company_pool' | 'personal_subscription'; personal_account_id: string | null;
  credential_version: number | null; started_at: number | null; ended_at: number | null;
};
type RunEventData<E extends MultiUserRunEvent['event']> = Extract<MultiUserRunEvent, { event: E }>['data'];

const table = 'multiuser_runs';
/** Personal-subscription lane defaults (#18): host-wide worker ceiling and per-user queue. */
const PERSONAL_DEFAULT_CAPACITY = 4;
const PERSONAL_QUEUE_LIMIT = 3;
const RUN_PAGE_DEFAULT = 50;
const RUN_PAGE_MAX = 100;
/** The API names an active row `running`; every other status is stored as served. */
const STORED_STATUS: Record<MultiUserRunStatus, RunRow['status']> = {
  queued: 'queued', running: 'active', succeeded: 'succeeded', failed: 'failed', canceled: 'canceled',
};

/** Stored JSON is projected, never trusted: a damaged value reads as null instead of failing the owner's reads. */
function storedJson(text: string | null): unknown {
  if (!text) return null;
  try { return JSON.parse(text) as unknown; } catch { return null; }
}
/**
 * The stored request's string `message`, or null when the request is damaged
 * (missing, not JSON, or not an object with a string message). Both lanes'
 * dispatch refuses a null before it changes any state, never running an empty prompt.
 */
/** A daemon-authored turn instruction (routines) precedes the user's text for the agent only. */
function withInstruction<T extends string | null>(requestJson: string | null, text: T): T {
  const instruction = storedRequest(requestJson)?.instruction;
  return (typeof instruction === 'string' && instruction && text !== null ? `${instruction}\n\n${text}` : text) as T;
}
function storedMessage(requestJson: string | null): string | null {
  const request = storedJson(requestJson);
  const message = request && typeof request === 'object' ? (request as { message?: unknown }).message : null;
  return typeof message === 'string' ? message : null;
}

function storedRequest(requestJson: string | null): Record<string, unknown> | null {
  const value = storedJson(requestJson);
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

type PersonalRunFields = {
  /** The turn text the native thread receives. */
  text: string;
  turnIds: { userMessageId: string; assistantMessageId: string } | null;
  clientRequestId: string | null;
  skillId: string | null;
  skillIds: string[];
  designSystemId: string | null;
  /** Set only for `entryFrom: 'question_answer'`. */
  questionSourceRunId: string | null;
  /** Project-relative paths; resolved against the real project root at dispatch. */
  attachments: string[];
  /** The focused project files/folders (`context.workspaceItems`), already narrowed. */
  workspaceItems: Array<{ id: string; kind: 'design-files' | 'file' | 'folder'; label: string; path?: string }>;
  /** This turn's Codex model/effort; null leaves the choice to the user's Codex account. */
  model: string | null;
  reasoning: string | null;
};
type FieldRefusal = { status: number; code: ApiErrorCode; message: string };
/** A project-relative path: no root, drive, backslash, NUL, empty, `.` or `..` segment. */
const safeProjectRelative = (value: string) => value.length > 0 && value.length <= 512 && !value.includes('\0') && !value.startsWith('/')
  && !value.includes('\\') && !/^[A-Za-z]:/.test(value) && value.split('/').every((part) => part !== '..' && part !== '.' && part !== '');
const REQUEST_KEY = /^[A-Za-z0-9._:-]{1,128}$/;
const POLICY_FIELDS = new Set<string>([...MULTIUSER_PERSONAL_RUN_FIELD_POLICY.honored,
  ...MULTIUSER_PERSONAL_RUN_FIELD_POLICY.defaultOnly, ...MULTIUSER_PERSONAL_RUN_FIELD_POLICY.notApplied]);
const isDefault = (key: string, value: unknown): boolean => value === undefined || (
  ['skillIds', 'attachments', 'commentAttachments'].includes(key) ? Array.isArray(value) && value.length === 0
    : key === 'sessionMode' ? value === 'design' : value === null);

/**
 * `MULTIUSER_PERSONAL_RUN_FIELD_POLICY` applied to one admission body. Pure:
 * the caller has already resolved the owned target and any source run, so a
 * refusal here never distinguishes a foreign resource from a missing one.
 */
export function parsePersonalRunFields(body: Record<string, unknown>, messageIdPrefix: string): PersonalRunFields | FieldRefusal {
  const refuse = (status: number, code: ApiErrorCode, message: string): FieldRefusal => ({ status, code, message });
  if (body.agentId !== 'codex' || body.provider !== undefined) {
    return refuse(403, 'MULTIUSER_AGENT_FORBIDDEN', 'personal subscription runs use the linked Codex account only');
  }
  const unsupported = Object.keys(body).filter((key) => !POLICY_FIELDS.has(key)
    || ((MULTIUSER_PERSONAL_RUN_FIELD_POLICY.defaultOnly as readonly string[]).includes(key) && !isDefault(key, body[key])));
  if (unsupported.length) {
    return refuse(403, 'MULTIUSER_CAPABILITY_UNAVAILABLE', `not available for personal Studio runs: ${unsupported.sort().join(', ')}`);
  }
  const text = typeof body.currentPrompt === 'string' ? body.currentPrompt : body.message;
  if (typeof text !== 'string' || text.length > 64_000 || (body.message !== undefined && typeof body.message !== 'string')
    || (body.priorTranscript !== undefined && typeof body.priorTranscript !== 'string')
    || (body.locale !== undefined && (typeof body.locale !== 'string' || body.locale.length > 64))
    || (body.titleGeneration !== undefined && (!body.titleGeneration || typeof body.titleGeneration !== 'object' || Array.isArray(body.titleGeneration)))) {
    return refuse(400, 'BAD_REQUEST', 'invalid run request');
  }
  if (Buffer.byteLength(JSON.stringify({ message: text }), 'utf8') > 64 * 1024) return refuse(400, 'BAD_REQUEST', 'run request is too large');
  const optionalKey = (value: unknown) => value === undefined || value === null || (typeof value === 'string' && REQUEST_KEY.test(value));
  const userMessageId = body.userMessageId ?? null;
  const assistantMessageId = body.assistantMessageId ?? null;
  if ((userMessageId === null) !== (assistantMessageId === null) || userMessageId === assistantMessageId && userMessageId !== null
    || (userMessageId !== null && (!isStudioMessageIdInNamespace(userMessageId, messageIdPrefix) || !isStudioMessageIdInNamespace(assistantMessageId, messageIdPrefix)))) {
    return refuse(400, 'BAD_REQUEST', 'message ids must be a distinct pair in this account\'s namespace');
  }
  if (!optionalKey(body.clientRequestId) || !['skillId', 'designSystemId'].every((key) => body[key] === undefined || body[key] === null || typeof body[key] === 'string')) {
    return refuse(400, 'BAD_REQUEST', 'invalid run request');
  }
  const attachments = body.attachments ?? [];
  const skillIds = body.skillIds ?? [];
  const validSkillIds = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 12
    && value.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 256);
  if (!validSkillIds(skillIds)) return refuse(400, 'BAD_REQUEST', 'invalid skill selections');
  if (!Array.isArray(attachments) || attachments.length > 20 || attachments.some((value) => typeof value !== 'string' || !safeProjectRelative(value))) {
    return refuse(400, 'BAD_REQUEST', 'attachments must be project-relative paths');
  }
  const workspaceItems: PersonalRunFields['workspaceItems'] = [];
  const context = body.context;
  if (context !== undefined && context !== null) {
    if (typeof context !== 'object' || Array.isArray(context)) return refuse(400, 'BAD_REQUEST', 'invalid run context');
    const record = context as Record<string, unknown>;
    const selections = ['pluginIds', 'mcpServerIds', 'connectorIds'];
    if (record.skillIds !== undefined && !validSkillIds(record.skillIds)) return refuse(400, 'BAD_REQUEST', 'invalid skill selections');
    if (Object.keys(record).some((key) => ![...selections, 'skillIds', 'workspaceItems'].includes(key))
      || selections.some((key) => record[key] !== undefined && !(Array.isArray(record[key]) && (record[key] as unknown[]).length === 0))) {
      return refuse(403, 'MULTIUSER_CAPABILITY_UNAVAILABLE', 'not available for personal Studio runs: context selections');
    }
    const items = record.workspaceItems ?? [];
    if (!Array.isArray(items) || items.length > 20) return refuse(400, 'BAD_REQUEST', 'invalid run context');
    for (const item of items) {
      const value = item as Record<string, unknown> | null;
      if (!value || typeof value !== 'object' || typeof value.id !== 'string' || typeof value.label !== 'string'
        || value.id.length > 256 || value.label.length > 256) return refuse(400, 'BAD_REQUEST', 'invalid run context');
      // Host-side contexts (local code, browser, terminal, …) and absolute paths have no Web owner yet.
      if (!['design-files', 'file', 'folder'].includes(String(value.kind)) || value.absolutePath !== undefined || value.url !== undefined) {
        return refuse(403, 'MULTIUSER_CAPABILITY_UNAVAILABLE', `not available for personal Studio runs: ${String(value.kind)} context`);
      }
      if (value.path !== undefined && (typeof value.path !== 'string' || !safeProjectRelative(value.path))) return refuse(400, 'BAD_REQUEST', 'invalid run context');
      workspaceItems.push({ id: value.id, kind: value.kind as 'design-files' | 'file' | 'folder', label: value.label,
        ...(typeof value.path === 'string' ? { path: value.path } : {}) });
    }
  }
  const selectedSkillIds = [...new Set([...skillIds, ...((context as { skillIds?: string[] } | null)?.skillIds ?? [])])];
  if (selectedSkillIds.length > 12) return refuse(400, 'BAD_REQUEST', 'too many skill selections');
  const choice = (key: 'model' | 'reasoning', valid: (value: unknown) => boolean): string | null | false => {
    const value = body[key];
    if (value === undefined || value === null || value === 'default') return null;
    return valid(value) ? value as string : false;
  };
  const model = choice('model', isStudioCodexModel);
  const reasoning = choice('reasoning', isStudioCodexReasoning);
  if (model === false || reasoning === false) return refuse(400, 'BAD_REQUEST', 'unsupported model or reasoning choice');
  const hints = body.analyticsHints;
  if (hints !== undefined && (!hints || typeof hints !== 'object' || Array.isArray(hints) || JSON.stringify(hints).length > 4096)) {
    return refuse(400, 'BAD_REQUEST', 'invalid question answer');
  }
  const answer = (hints as Record<string, unknown> | undefined)?.entryFrom === 'question_answer';
  const sourceRunId = (hints as Record<string, unknown> | undefined)?.sourceRunId;
  if (answer && typeof sourceRunId !== 'string') return refuse(400, 'BAD_REQUEST', 'invalid question answer');
  return {
    text, clientRequestId: (body.clientRequestId as string | null | undefined) ?? null,
    turnIds: userMessageId === null ? null : { userMessageId: userMessageId as string, assistantMessageId: assistantMessageId as string },
    skillId: (body.skillId as string | null | undefined) ?? null, designSystemId: (body.designSystemId as string | null | undefined) ?? null,
    skillIds: selectedSkillIds,
    questionSourceRunId: answer ? sourceRunId as string : null,
    attachments: [...new Set(attachments as string[])],
    workspaceItems, model, reasoning,
  };
}

type RunListQuery = {
  limit: number; cursor: { createdAt: number; id: string } | null;
  projectId?: string; conversationId?: string; status?: RunRow['status'] | 'nonterminal';
};
/**
 * Strict `GET /api/runs` query. Repeated or non-string parameters, a malformed
 * limit/cursor and an unknown status are refused rather than silently widening
 * the list. Id filters accept any single string (an unowned id matches nothing);
 * unknown names are ignored.
 */
function parseRunListQuery(query: Request['query']): RunListQuery | null {
  const one = (name: string): string | undefined | null => {
    const value = query[name];
    return value === undefined ? undefined : typeof value === 'string' ? value : null;
  };
  const [limit, cursor, projectId, conversationId, status] = ['limit', 'cursor', 'projectId', 'conversationId', 'status'].map(one);
  if ([limit, cursor, projectId, conversationId, status].includes(null)) return null;
  const parsed: RunListQuery = { limit: RUN_PAGE_DEFAULT, cursor: null };
  if (limit !== undefined) {
    if (!/^[1-9]\d{0,2}$/.test(limit!) || Number(limit) > RUN_PAGE_MAX) return null;
    parsed.limit = Number(limit);
  }
  if (cursor !== undefined) {
    // Opaque to clients: `<createdAt>:<id>` of the last row served.
    const match = /^(0|[1-9]\d{0,15}):([A-Za-z0-9-]{1,64})$/.exec(cursor!);
    if (!match || !Number.isSafeInteger(Number(match[1]))) return null;
    parsed.cursor = { createdAt: Number(match[1]), id: match[2]! };
  }
  if (status !== undefined) {
    // `active` is the single-user filter for every non-terminal run.
    if (status === 'active') parsed.status = 'nonterminal';
    else if (!Object.hasOwn(STORED_STATUS, status!)) return null;
    else parsed.status = STORED_STATUS[status as MultiUserRunStatus];
  }
  if (projectId !== undefined) parsed.projectId = projectId!;
  if (conversationId !== undefined) parsed.conversationId = conversationId!;
  return parsed;
}

/** Stored reasons that name a run-engine condition, not a contract code. */
const ENGINE_REASON_CODES: Record<string, ApiErrorCode> = {
  shutdown_timeout: 'MULTIUSER_RUN_SHUTDOWN_TIMEOUT',
  ledger_admission_replayed: 'MULTIUSER_RUN_ADMISSION_REPLAYED',
};
/**
 * #79: the public code of a failed run's terminal error. A stored contract
 * code passes through unless it is personal-lane specific on a company run;
 * an engine reason maps to its own code; anything else (no reason, free text)
 * becomes the generic failure of the run's own execution source. Stored
 * reasons are never echoed otherwise, so no provider prose or secret leaks.
 */
export function multiUserTerminalErrorCode(source: 'company_pool' | 'personal_subscription', reason: unknown): ApiErrorCode {
  const personal = source === 'personal_subscription';
  if (typeof reason === 'string' && Object.hasOwn(ENGINE_REASON_CODES, reason)) return ENGINE_REASON_CODES[reason]!;
  if (typeof reason === 'string' && (API_ERROR_CODES as readonly string[]).includes(reason)
    && (personal || !reason.startsWith('MULTIUSER_PERSONAL_'))) return reason as ApiErrorCode;
  return personal ? 'MULTIUSER_PERSONAL_RUN_FAILED' : 'MULTIUSER_RUN_FAILED';
}

/**
 * Actor-scoped execution plane. Company OpenAI runs use bounded project file
 * tools and a server-owned key; fixture rows use the repository test mock. Personal rows
 * run through the owner's own CODEX_HOME on a separate queue and ceiling, never
 * the company slots or the company worker-time ledger.
 */
export function registerMultiUserRunRoutes(app: Express, input: {
  db: Database.Database;
  dataRoot: string;
  projectsRoot: string;
  mockAgentScript?: string;
  companyFetch?: typeof fetch;
  /** The verified personal bubblewrap boundary; company skill scripts run only inside it, offline. */
  scriptSandbox?: PersonalSandbox;
  repositoryRoot: string;
  clock?: () => number;
  personal?: PersonalCodexAccounts;
  design?: MultiUserDesignRoutes;
  catalog?: StudioCatalog;
  settings?: StudioSettings;
  designCatalog?: StudioDesignCatalog;
}): { cancelAccountRuns(accountId: string): void; isRunOwner(runId: string, accountId: string): boolean;
  cancelProjectRuns(accountId: string, projectId: string, conversationId?: string): Promise<() => void>;
  cancelPersonalRuns(accountId: string): Promise<void>; forgetNativeSessions(accountId: string): void; personalLane: PersonalRunLaneControls; listAccountIds(): string[];
  /** Admit a run for a background actor through the same policy as POST /api/runs. */
  admitInternal(actor: AuthActor, request: Record<string, unknown>, allowed: () => boolean, instruction?: string): Promise<InternalMultiUserResult>;
  runState(runId: string, accountId: string): { status: string; text: string | null; reason: string | null } | null;
  beginShutdown(): void; shutdown(): Promise<void>; companyPoolAvailable: boolean; openaiPoolAvailable: boolean } {
  const { db, dataRoot, projectsRoot } = input;
  type DesignSnapshot = { id: string; hash: string; prompt: Pick<Parameters<typeof composeSystemPrompt>[0],
    'designSystemBody' | 'designSystemTitle' | 'designSystemUsageMd' | 'designSystemTokensCss' |
    'designSystemComponentsManifest' | 'designSystemFixtureHtml' | 'designSystemPullIndex' | 'designSystemImportMode'> };
  const captureDesign = async (owner: string, conversationId: string, requestedId: string | null, question?: RunRow): Promise<DesignSnapshot | null | false> => {
    const previous = question ?? (requestedId === null ? undefined : db.prepare(`SELECT * FROM multiuser_runs
      WHERE owner_account_id = ? AND conversation_id = ? AND json_valid(request_json)
        AND json_extract(request_json, '$.designSnapshot.id') = ? ORDER BY queue_seq DESC LIMIT 1`)
      .get(owner, conversationId, requestedId) as RunRow | undefined);
    const request = previous ? storedRequest(previous.request_json) : null;
    const captured = request?.designSnapshot as DesignSnapshot | undefined;
    if (question && requestedId !== null && requestedId !== captured?.id) return false;
    if (captured && typeof captured.id === 'string' && typeof captured.prompt?.designSystemBody === 'string'
      && (question && requestedId === null || requestedId === captured.id)) return captured;
    if (requestedId === null) return null;
    const system = await input.designCatalog?.readSystem(owner, requestedId);
    if (!system?.body.trim()) return false;
    const assets = await input.designCatalog!.readSystemAssets(system.id);
    const prompt: DesignSnapshot['prompt'] = { designSystemBody: system.body, designSystemTitle: system.title,
      designSystemUsageMd: assets.usageMd, designSystemTokensCss: assets.tokensCss,
      designSystemComponentsManifest: assets.componentsManifest, designSystemFixtureHtml: assets.fixtureHtml,
      designSystemPullIndex: assets.pullIndex, designSystemImportMode: assets.importMode };
    return { id: system.id, hash: createHash('sha256').update(JSON.stringify(prompt)).digest('hex'), prompt };
  };

  type SkillSnapshot = { id: string; name: string; body: string; mode?: Parameters<typeof composeSystemPrompt>[0]['skillMode']; hash: string; package?: StudioSkillPackage };
  const captureSkills = async (owner: string, conversationId: string, ids: readonly string[]): Promise<SkillSnapshot[] | null> => {
    if (ids.length > 12) return null;
    const snapshots: SkillSnapshot[] = [];
    for (const id of ids) {
      const previous = db.prepare(`SELECT request_json FROM multiuser_runs
        WHERE owner_account_id = ? AND conversation_id = ? AND json_valid(request_json)
          AND EXISTS (SELECT 1 FROM json_each(request_json, '$.skillSnapshots') item
            WHERE json_extract(item.value, '$.id') = ?) ORDER BY queue_seq DESC LIMIT 1`)
        .get(owner, conversationId, id) as { request_json: string } | undefined;
      const captured = previous ? storedRequest(previous.request_json)?.skillSnapshots : undefined;
      const snapshot = Array.isArray(captured) ? captured.find((item: SkillSnapshot) => item?.id === id) as SkillSnapshot | undefined : undefined;
      if (snapshot && typeof snapshot.body === 'string' && typeof snapshot.name === 'string' && typeof snapshot.hash === 'string') {
        snapshots.push(snapshot); continue;
      }
      const skills = await input.catalog?.readSkills(owner, [id]);
      if (!skills?.[0]) return null;
      const skill = skills[0];
      const text = { id: skill.id, name: skill.name, body: skill.body, mode: skill.mode, ...(skill.package ? { package: skill.package } : {}) };
      snapshots.push({ ...text, hash: createHash('sha256').update(JSON.stringify(text)).digest('hex') });
    }
    try { readStudioSkillPackages(snapshots); } catch { return null; }
    return snapshots;
  };
  /** A fixed-design conversation pins its primary skill package and bundled
   * design system on first admission, exactly like standard selections. Later
   * turns reuse those bytes; catalog upgrades never reach this conversation. */
  const captureFixedDesign = async (owner: string, conversationId: string, fixed: { skillId: string; designSystemId: string }):
    Promise<{ skill: SkillSnapshot; design: DesignSnapshot } | null> => {
    if (fixed.skillId.startsWith('studio-skill:') || fixed.designSystemId.startsWith('user:')) return null;
    const [skill] = await captureSkills(owner, conversationId, [fixed.skillId]) ?? [];
    const design = await captureDesign(owner, conversationId, fixed.designSystemId);
    return skill && design ? { skill, design } : null;
  };
  /** The primary package rides with the selected ones so workers stage it; its
   * body is already in the fixed stable prompt and is not composed twice. */
  const withFixedSkill = (fixed: SkillSnapshot | undefined, selected: SkillSnapshot[]): SkillSnapshot[] =>
    fixed ? [fixed, ...selected.filter((skill) => skill.id !== fixed.id)] : selected;
  const selectSkills = (fields: PersonalRunFields, projectId: string, fixed: boolean, question: boolean): string[] => {
    if (question) return fields.skillIds;
    const primary = fixed ? null : fields.skillId ?? getProject(db, projectId)?.skillId ?? null;
    return [...new Set([...(primary ? [primary] : []), ...fields.skillIds])];
  };

  const artifactBlobs = createChatArtifactBlobStore({ dataDir: dataRoot });
  const companyOpenAI = new CompanyOpenAIStore(db, dataRoot);
  db.exec(`CREATE TABLE IF NOT EXISTS multiuser_company_sessions (
    conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
    owner_account_id TEXT NOT NULL, provider_id TEXT NOT NULL, model TEXT NOT NULL,
    credential_revision INTEGER NOT NULL, history_json TEXT NOT NULL DEFAULT '[]'
  )`);
  // A deployed image ships no mocks. Only explicit programmatic fixtures
  // resolve this test worker; it is never a fallback for OpenAI.
  const mockAgentScript = input.mockAgentScript ? fs.realpathSync(input.mockAgentScript) : null;
  if (mockAgentScript && mockAgentScript !== fs.realpathSync(path.join(input.repositoryRoot, 'mocks/run-isolation-agent.ts'))) {
    throw new Error('multi-user mode refused: only the repository test mock may run');
  }
  const owners = new ProjectOwnershipStore(db);
  const ledger = new WorkerQuotaLedger({ dataRoot, ...(input.clock ? { clock: input.clock } : {}) });
  const accounts = AuthStore.open({ dataRoot });
  const now = input.clock ?? Date.now;
  const legacy = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string } | undefined;
  if (legacy && !legacy.sql.includes("'queued'")) {
    db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        db.exec(`CREATE TABLE multiuser_runs_next (
          id TEXT PRIMARY KEY, owner_account_id TEXT NOT NULL CHECK (length(owner_account_id) > 0),
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          status TEXT NOT NULL CHECK (status IN ('queued','active','succeeded','failed','canceled')),
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, output TEXT,
          request_json TEXT, queue_seq INTEGER
        );
        INSERT INTO multiuser_runs_next (id, owner_account_id, project_id, conversation_id, status, created_at, updated_at, output)
          SELECT id, owner_account_id, project_id, conversation_id, status, created_at, updated_at, output FROM multiuser_runs;
        DROP TABLE multiuser_runs;
        ALTER TABLE multiuser_runs_next RENAME TO multiuser_runs;`);
      }).immediate();
    } finally { db.pragma('foreign_keys = ON'); }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${table} (
      id TEXT PRIMARY KEY,
      owner_account_id TEXT NOT NULL CHECK (length(owner_account_id) > 0),
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('queued','active','succeeded','failed','canceled')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      output TEXT,
      request_json TEXT,
      queue_seq INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_${table}_owner ON ${table}(owner_account_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_${table}_queue ON ${table}(status, queue_seq);
    CREATE TRIGGER IF NOT EXISTS ${table}_binding_immutable BEFORE UPDATE OF owner_account_id, project_id, conversation_id ON ${table}
      BEGIN SELECT RAISE(ABORT, 'run binding is immutable'); END;
    CREATE TABLE IF NOT EXISTS multiuser_run_events (
      run_id TEXT NOT NULL REFERENCES ${table}(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      event TEXT NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (run_id, seq)
    );
    CREATE TABLE IF NOT EXISTS multiuser_pool_config (
      key TEXT PRIMARY KEY, value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS multiuser_pool_turns (
      account_id TEXT PRIMARY KEY, last_seq INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS multiuser_pool_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, actor_account_id TEXT NOT NULL,
      action TEXT NOT NULL, target_id TEXT NOT NULL, value INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS multiuser_pool_audit_immutable BEFORE UPDATE ON multiuser_pool_audit
      BEGIN SELECT RAISE(ABORT, 'pool audit is append only'); END;
    CREATE TRIGGER IF NOT EXISTS multiuser_pool_audit_no_delete BEFORE DELETE ON multiuser_pool_audit
      BEGIN SELECT RAISE(ABORT, 'pool audit is append only'); END;
  `);
  const runColumns = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name));
  for (const [name, ddl] of [
    ['execution_source', "TEXT NOT NULL DEFAULT 'company_pool' CHECK (execution_source IN ('company_pool','personal_subscription'))"],
    ['personal_account_id', 'TEXT'], ['credential_version', 'INTEGER'], ['started_at', 'INTEGER'], ['ended_at', 'INTEGER'],
  ] as const) {
    if (!runColumns.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
  }
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS ${table}_source_immutable BEFORE UPDATE OF execution_source, personal_account_id, credential_version ON ${table}
      BEGIN SELECT RAISE(ABORT, 'run binding is immutable'); END;
    CREATE TABLE IF NOT EXISTS multiuser_personal_turns (
      account_id TEXT PRIMARY KEY, last_seq INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS multiuser_personal_sessions (
      conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
      owner_account_id TEXT NOT NULL, personal_account_id TEXT NOT NULL, thread_id TEXT, stable_prompt_hash TEXT, updated_at INTEGER NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS multiuser_personal_sessions_binding_immutable
      BEFORE UPDATE OF owner_account_id, personal_account_id ON multiuser_personal_sessions
      BEGIN SELECT RAISE(ABORT, 'personal session binding is immutable'); END;
  `);
  const personalSessionColumns = new Set((db.prepare('PRAGMA table_info(multiuser_personal_sessions)').all() as Array<{ name: string }>).map((column) => column.name));
  if (!personalSessionColumns.has('stable_prompt_hash')) db.exec('ALTER TABLE multiuser_personal_sessions ADD COLUMN stable_prompt_hash TEXT');
  const personal = input.personal ?? null;
  const company = "execution_source = 'company_pool'";
  const personalRows = "execution_source = 'personal_subscription'";
  const recovery = db.prepare(`SELECT * FROM ${table} WHERE status = 'active'`).all() as RunRow[];
  const ledgerActive = ledger.activeRuns();
  const reconciled = new Set<string>();
  for (const run of recovery) {
    const entry = ledger.entry(run.id);
    if (entry?.status === 'active') {
      ledger.finish(entry.actorId, run.id);
      reconciled.add(run.id);
    }
  }
  const queuedRecovery = db.prepare(`SELECT * FROM ${table} WHERE status = 'queued'`).all() as RunRow[];
  // #79: settled through `finish` below, so a replay gets its error/end and transcript like any terminal.
  const replayed: RunRow[] = [];
  for (const run of queuedRecovery) {
    const entry = ledger.entry(run.id);
    if (!entry) continue;
    if (entry.status === 'active') {
      ledger.finish(entry.actorId, run.id);
      reconciled.add(run.id);
    }
    replayed.push(run);
  }
  for (const entry of ledgerActive) {
    if (!reconciled.has(entry.runId)) {
      ledger.finish(entry.actorId, entry.runId);
    }
  }
  interface RunWorker { exitCode: number | null; signalCode: NodeJS.Signals | null;
    kill(signal?: NodeJS.Signals | number): boolean; once(event: 'close', listener: () => void): unknown }
  const children = new Map<string, RunWorker>();
  /**
   * #78: a child is only waited on while its process is alive. Once it has
   * exited, its run is settling (e.g. the personal artifact snapshot) and a
   * new 'close' listener may never fire, so cancellers settle the run directly.
   */
  const running = (child: RunWorker) => child.exitCode === null && child.signalCode === null;
  const studioMessages = new MultiUserStudioMessages(db);
  const cancelPending = new Set<string>();
  const sourceInvalidated = new Set<string>();
  const failurePending = new Set<string>();
  let shuttingDown = false;
  let storesClosed = false;
  const listeners = new Map<string, Set<Response>>();
  const artifactBaselines = new Map<string, { cwd: string; before: ArtifactSnapshot }>();
  const projections = new Map<string, PersonalRunEvents>();
  const interrupts = new Map<string, () => void>();
  db.exec(`CREATE TABLE IF NOT EXISTS multiuser_run_questions (
    run_id TEXT PRIMARY KEY REFERENCES multiuser_runs(id) ON DELETE CASCADE,
    answered_by TEXT REFERENCES multiuser_runs(id) ON DELETE SET NULL
  )`);
  const row = (id: string) => db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as RunRow | undefined;
  const actor = (res: Response) => multiUserActorOf(res)?.accountId ?? '';
  const owned = (req: Request, res: Response): RunRow | null => {
    const id = String(req.params.id ?? '');
    const found = row(id);
    if (!found || found.owner_account_id !== actor(res) || !owners.isOwnedBy(found.project_id, actor(res))) {
      sendApiError(res, 404, 'NOT_FOUND', 'run not found');
      return null;
    }
    return found;
  };
  const queuePosition = (run: RunRow) => run.status === 'queued' ? (db.prepare(`SELECT COUNT(*) AS n FROM ${table}
    WHERE status = 'queued' AND owner_account_id = ? AND queue_seq <= ? AND execution_source = ?`)
    .get(run.owner_account_id, run.queue_seq, run.execution_source) as { n: number }).n : null;
  const isPersonal = (run: RunRow) => run.execution_source === 'personal_subscription';
  const isOpenAI = (run: RunRow) => !isPersonal(run) && storedRequest(run.request_json)?.companyProvider === 'openai';
  const agentOf = (run: RunRow): 'codex' | 'openai' | 'test-mock' => isPersonal(run) ? 'codex' : isOpenAI(run) ? 'openai' : 'test-mock';
  const body = (run: RunRow): MultiUserRun => ({
    id: run.id, projectId: run.project_id, conversationId: run.conversation_id,
    agentId: agentOf(run), status: run.status === 'active' ? 'running' : run.status,
    queuePosition: queuePosition(run), createdAt: run.created_at,
    updatedAt: run.updated_at, output: (() => {
      const value = storedJson(run.output);
      return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
    })(),
    message: storedMessage(run.request_json),
    ...studioMessages.ids(run.id),
    ...(isPersonal(run) ? { executionSource: 'personal_subscription' as const } : isOpenAI(run) ? { executionSource: 'company_pool' as const } : {}),
  });
  /**
   * Persist before publishing; start events participate in the row/turn transaction.
   * The transcript follows incrementally (#76); lifecycle edges call `reconcile`.
   */
  const persistEvent = <E extends MultiUserRunEvent['event']>(id: string, event: E, data: RunEventData<E>) => {
    const seq = (db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM multiuser_run_events WHERE run_id = ?').get(id) as { seq: number }).seq;
    const payload = JSON.stringify(data);
    db.prepare('INSERT INTO multiuser_run_events (run_id, seq, event, data) VALUES (?, ?, ?, ?)').run(id, seq, event, payload);
    studioMessages.append(id, row(id)!.conversation_id, seq, event, data);
    return `id: ${seq}\nevent: ${event}\ndata: ${payload}\n\n`;
  };
  const publishEvent = (id: string, frame: string) => {
    for (const res of listeners.get(id) ?? []) if (multiUserStreamAllowed(res)) res.write(frame);
  };
  const emit = <E extends MultiUserRunEvent['event']>(id: string, event: E, data: RunEventData<E>) => {
    publishEvent(id, db.transaction(() => persistEvent<E>(id, event, data))());
  };
  /** A run starts, consumes its lane's turn, and records its event together, before live publication. */
  const startRun = (run: RunRow) => {
    const frame = db.transaction(() => {
      const time = now();
      if (isPersonal(run)) {
        db.prepare(`UPDATE ${table} SET status = 'active', started_at = ?, updated_at = ? WHERE id = ?`).run(time, time, run.id);
      } else {
        db.prepare(`UPDATE ${table} SET status = 'active', updated_at = ? WHERE id = ?`).run(time, run.id);
      }
      const turnsTable = isPersonal(run) ? 'multiuser_personal_turns' : 'multiuser_pool_turns';
      db.prepare(`INSERT INTO ${turnsTable} (account_id, last_seq)
        VALUES (?, (SELECT COALESCE(MAX(last_seq), 0) + 1 FROM ${turnsTable}))
        ON CONFLICT(account_id) DO UPDATE SET last_seq = excluded.last_seq`).run(run.owner_account_id);
      studioMessages.reconcile(row(run.id)!);
      return persistEvent(run.id, 'start', { runId: run.id, bin: agentOf(run), agentId: agentOf(run), protocolVersion: 1 });
    })();
    publishEvent(run.id, frame);
  };
  let dispatching = false;
  let suspendDispatch = false;
  // Held through parent deletion, not just subprocess termination. Refcounts
  // allow overlapping project/conversation deletes without reopening admission.
  const deletingTargets = new Map<string, number>();
  const targetKey = (owner: string, projectId: string, conversationId?: string) => JSON.stringify([owner, projectId, conversationId ?? null]);
  const targetDeleting = (owner: string, projectId: string, conversationId: string) =>
    deletingTargets.has(targetKey(owner, projectId)) || deletingTargets.has(targetKey(owner, projectId, conversationId));
  let retryTimer: NodeJS.Timeout | null = null;
  let dispatch = () => {};
  let dispatchPersonal = () => {};
  /**
   * #72: a company worker span closes at most once, and only when the ledger
   * still holds it. A restored app DB without its ledger row is recorded with a
   * fixed code instead of aborting recovery; nothing is charged for it.
   */
  const closeLedgerSpan = (run: RunRow, status: 'succeeded' | 'failed' | 'canceled') => {
    const entry = ledger.entry(run.id);
    if (!entry || entry.actorId !== run.owner_account_id) return studioMessages.recordIssue(run.id, 'MULTIUSER_LEDGER_ENTRY_MISSING');
    if (entry.status !== 'active') return;
    if (status === 'canceled') ledger.cancel(run.owner_account_id, run.id);
    else ledger.finish(run.owner_account_id, run.id);
  };
  const finish = (id: string, status: 'succeeded' | 'failed' | 'canceled', output?: unknown) => {
    if (storesClosed) return;
    const existing = row(id);
    if (!existing || (existing.status !== 'active' && existing.status !== 'queued')) return;
    if (existing.status === 'active' && !isPersonal(existing)) closeLedgerSpan(existing, status);
    const projection = projections.get(id);
    projection?.flush();
    const result = { ...(projection ? { text: projection.text, textTruncated: projection.truncated } : {}),
      ...(output && typeof output === 'object' ? output : {}) } as Record<string, unknown>;
    const frames = db.transaction(() => {
      const time = now();
      db.prepare(`UPDATE ${table} SET status = ?, output = ?, updated_at = ?, ended_at = CASE WHEN started_at IS NOT NULL THEN ? ELSE ended_at END WHERE id = ?`)
        .run(status, Object.keys(result).length ? JSON.stringify(result) : null, time, time, id);
      const frames: string[] = [];
      if (status === 'failed' || result.reason === 'MULTIUSER_PERSONAL_UNAVAILABLE') {
        const reason = multiUserTerminalErrorCode(existing.execution_source, result.reason);
        frames.push(persistEvent(id, 'error', { message: reason, error: { code: reason, message: reason }, ...(projection?.errorDetail ? { codexErrorInfo: projection.errorDetail } : {}) }));
      }
      const files = Array.isArray(result.files) ? result.files as string[] : [];
      frames.push(persistEvent(id, 'end', { status, code: status === 'succeeded' ? 0 : status === 'failed' ? 1 : null,
        terminalAt: time, artifactPaths: files, artifactCount: files.length }));
      if (status === 'succeeded' && (isPersonal(existing) || isOpenAI(existing)) && emittedRenderableQuestionForm(String(result.text ?? ''))) {
        db.prepare('INSERT OR IGNORE INTO multiuser_run_questions (run_id) VALUES (?)').run(id);
      }
      studioMessages.reconcile(row(id)!);
      return frames;
    })();
    for (const frame of frames) publishEvent(id, frame);
    for (const res of listeners.get(id) ?? []) res.end();
    listeners.delete(id);
    children.delete(id);
    cancelPending.delete(id);
    sourceInvalidated.delete(id);
    failurePending.delete(id);
    artifactBaselines.delete(id);
    projections.delete(id);
    interrupts.delete(id);
    if (!shuttingDown && !suspendDispatch) { dispatch(); dispatchPersonal(); }
  };
  for (const run of recovery) finish(run.id, 'failed', { reason: RESTART_ERROR_CODE });
  for (const run of replayed) finish(run.id, 'failed', { reason: 'ledger_admission_replayed' });
  const capacity = () => mockAgentScript ? Number((db.prepare("SELECT value FROM multiuser_pool_config WHERE key = 'test-mock-capacity'").get() as { value: string } | undefined)?.value ?? '2') : 0;
  const providerCapacity = (run: RunRow) => isOpenAI(run) ? companyOpenAI.available() ? companyOpenAI.read().capacity : 0 : capacity();
  dispatch = () => {
    if (dispatching || shuttingDown || !(mockAgentScript || companyOpenAI.available())) return;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    dispatching = true;
    try {
      for (;;) {
        const active = db.prepare(`SELECT * FROM ${table} WHERE status = 'active' AND ${company}`).all() as RunRow[];
        const queued = db.prepare(`SELECT * FROM ${table} WHERE status = 'queued' AND ${company} ORDER BY queue_seq`).all() as RunRow[];
        const turns = new Map((db.prepare('SELECT account_id, last_seq FROM multiuser_pool_turns').all() as Array<{ account_id: string; last_seq: number }>)
          .map((turn) => [turn.account_id, turn.last_seq]));
        const eligible = queued.filter((run) => active.filter((other) => isOpenAI(other) === isOpenAI(run)).length < providerCapacity(run)
          && ledger.balance(run.owner_account_id).remainingMs > 0 &&
          !(db.prepare(`SELECT 1 FROM ${table} WHERE owner_account_id = ? AND status = 'active' AND ${company}`).get(run.owner_account_id)));
        const next = eligible.sort((a, b) => (turns.get(a.owner_account_id) ?? 0) - (turns.get(b.owner_account_id) ?? 0)
          || Number(a.queue_seq) - Number(b.queue_seq))[0];
        if (!next) break;
        const project = getProject(db, next.project_id);
        const conversation = getConversation(db, next.conversation_id);
        const cwd = path.join(projectsRoot, next.project_id);
        let realCwd: string | null = null;
        try { realCwd = fs.realpathSync(cwd); } catch { /* fail the queued run below */ }
        const metadata = project?.metadata as Record<string, unknown> | null | undefined;
        if (!accounts.getAccountById(next.owner_account_id)?.active) {
          finish(next.id, 'canceled');
          continue;
        }
        if (!owners.isOwnedBy(next.project_id, next.owner_account_id) ||
            conversation?.projectId !== next.project_id || metadata?.baseDir || metadata?.linkedDirs || metadata?.imported ||
            !realCwd || path.dirname(realCwd) !== fs.realpathSync(projectsRoot)) {
          finish(next.id, 'failed');
          continue;
        }
        if (storedMessage(next.request_json) === null) {
          finish(next.id, 'failed', { reason: 'MULTIUSER_RUN_REQUEST_INVALID' });
          continue;
        }
        const actorDir = createHash('sha256').update(next.owner_account_id).digest('hex');
        const runHome = path.join(dataRoot, 'multiuser-runtime', actorDir, next.id);
        const temp = path.join(runHome, 'tmp');
        fs.mkdirSync(temp, { recursive: true, mode: 0o700 });
        fs.chmodSync(path.dirname(runHome), 0o700);
        fs.chmodSync(runHome, 0o700);
        fs.chmodSync(temp, 0o700);
        const admission = ledger.start({ actorId: next.owner_account_id, runId: next.id, projectId: next.project_id, providerId: agentOf(next) });
        if (admission.status === 'replayed') {
          if (admission.run.status === 'active') ledger.finish(next.owner_account_id, next.id);
          finish(next.id, 'failed', { reason: 'ledger_admission_replayed' });
          continue;
        }
        if (admission.status !== 'started') break;
        if (isOpenAI(next)) {
          let execution: ReturnType<CompanyOpenAIStore['execution']>;
          try { execution = companyOpenAI.execution(); }
          catch { closeLedgerSpan(next, 'failed'); finish(next.id, 'failed', { reason: 'MULTIUSER_PROVIDER_DISABLED' }); continue; }
          const request = storedRequest(next.request_json)!;
          const session = db.prepare('SELECT * FROM multiuser_company_sessions WHERE conversation_id = ? AND owner_account_id = ?')
            .get(next.conversation_id, next.owner_account_id) as { model: string; credential_revision: number; history_json: string } | undefined;
          if (!execution || !session || execution.config.credentialRevision !== request.companyCredentialRevision
            || execution.config.model !== request.companyModel || session.model !== execution.config.model
            || session.credential_revision !== execution.config.credentialRevision) {
            closeLedgerSpan(next, 'failed'); finish(next.id, 'failed', { reason: 'MULTIUSER_PROVIDER_DISABLED' }); continue;
          }
          const worker = new CompanyOpenAIWorker();
          const projection = new PersonalRunEvents(realCwd, [dataRoot, realCwd, runHome],
            (event) => emit(next.id, event.event, event.data), undefined, 'company-pool');
          startRun(next); children.set(next.id, worker); projections.set(next.id, projection);
          const quotaWatch = setInterval(() => {
            if (!storesClosed && row(next.id)?.status === 'active' && ledger.balance(next.owner_account_id).remainingMs === 0) {
              failurePending.add(next.id); worker.kill('SIGTERM');
            }
          }, 1000);
          quotaWatch.unref();
          worker.once('close', () => clearInterval(quotaWatch));
          try {
            const history = JSON.parse(session.history_json) as Record<string, unknown>[];
            if (!Array.isArray(history)) throw new Error('invalid company history');
            const userPrompt = withInstruction(next.request_json, storedMessage(next.request_json)!);
            const stablePrompt = typeof request.stablePrompt === 'string' ? request.stablePrompt : '';
            const attached = formatProjectAttachmentHint(resolveSafeProjectAttachments(realCwd,
              Array.isArray(request.attachments) ? request.attachments.filter((item): item is string => typeof item === 'string') : []));
            const focused = Array.isArray(request.workspaceItems) && request.workspaceItems.length
              ? `\n\n${renderRunContextPrompt({ workspaceItems: request.workspaceItems }, null)}` : '';
            const skillPackages = readStudioSkillPackages(request.skillSnapshots);
            const skillRoot = input.scriptSandbox ? stageStudioSkillPackages(runHome, skillPackages) : undefined;
            artifactBaselines.set(next.id, { cwd: realCwd, before: snapshotProjectArtifacts(realCwd) });
            const authorized = () => {
              if (storesClosed) return false;
              const config = companyOpenAI.read();
              return !storesClosed && !shuttingDown && !cancelPending.has(next.id) && row(next.id)?.status === 'active'
                && accounts.getAccountById(next.owner_account_id)?.active === true && owners.isOwnedBy(next.project_id, next.owner_account_id)
                && config.enabled && config.configured && config.model === execution.config.model
                && config.credentialRevision === execution.config.credentialRevision;
            };
            void runCompanyOpenAITurn({ apiKey: execution.apiKey, model: execution.config.model,
              systemPrompt: stablePrompt, prompt: `${userPrompt}${attached}${focused}`,
              history, skillPackages, projectsRoot, projectId: next.project_id, worker, authorized,
              ...(skillRoot && input.scriptSandbox ? { runSkillScript: createStudioSkillScriptRunner({ sandbox: input.scriptSandbox,
                packages: skillPackages, skillRoot, runHome, cwd: realCwd }) } : {}),
              onAgentEvent: (event) => projection.accept(event), ...(input.companyFetch ? { fetch: input.companyFetch } : {}),
            }).then(async (result) => {
              if (!authorized()) { finish(next.id, 'canceled'); return; }
              const after = await snapshotProjectArtifactsAsync(realCwd);
              if (!authorized()) { finish(next.id, 'canceled'); return; }
              const files = diffRunArtifacts(artifactBaselines.get(next.id)!.before, after).touchedPaths
                .map((file) => path.relative(realCwd, file).replaceAll('\\', '/')).filter((file) => file && !file.startsWith('../')).slice(0, 128);
              const producedFiles = files.flatMap((name) => {
                const fingerprint = after.get(path.join(realCwd, name));
                return fingerprint ? [{ name, path: name, type: 'file' as const, size: fingerprint.size, mtime: fingerprint.mtimeMs, kind: kindFor(name), mime: mimeFor(name) }] : [];
              });
              const messageId = studioMessages.ids(next.id).assistantMessageId;
              if (getMessage(db, messageId)?.runId === next.id) await captureRunChatArtifactSnapshots({ db, blobs: artifactBlobs },
                { projectId: next.project_id, messageId, runId: next.id, projectRoot: realCwd, touchedPaths: files.map((file) => path.join(realCwd, file)) });
              if (!authorized()) { finish(next.id, 'canceled'); return; }
              db.prepare('UPDATE multiuser_company_sessions SET history_json = ? WHERE conversation_id = ? AND owner_account_id = ? AND credential_revision = ?')
                .run(JSON.stringify(result.input), next.conversation_id, next.owner_account_id, execution.config.credentialRevision);
              finish(next.id, 'succeeded', { files, producedFiles, usage: result.usage });
            }).catch(() => { finish(next.id, cancelPending.has(next.id) || shuttingDown ? 'canceled' : 'failed', { reason: failurePending.has(next.id) ? 'MULTIUSER_QUOTA_EXHAUSTED' : 'MULTIUSER_RUN_FAILED' }); })
              .finally(() => worker.close(!storesClosed && row(next.id)?.status === 'succeeded'));
          } catch { finish(next.id, cancelPending.has(next.id) ? 'canceled' : 'failed', { reason: 'MULTIUSER_RUN_START_FAILED' }); worker.close(false); }
          continue;
        }
        if (!mockAgentScript) { closeLedgerSpan(next, 'failed'); finish(next.id, 'failed', { reason: 'MULTIUSER_PROVIDER_DISABLED' }); continue; }
        let child: ChildProcessWithoutNullStreams;
        try {
          startRun(next);
          child = spawn(process.execPath, [mockAgentScript], {
            cwd: realCwd, env: { HOME: runHome, TMPDIR: temp, TMP: temp, TEMP: temp, OD_DATA_DIR: dataRoot },
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          children.set(next.id, child);
        } catch {
          // Admission is in a separate database: close it even when the run's start rolled back.
          if (!children.has(next.id)) {
            ledger.finish(next.owner_account_id, next.id);
            finish(next.id, 'failed', { reason: 'MULTIUSER_RUN_START_FAILED' });
          }
          continue;
        }
        let stdout = '';
        child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
        child.stderr.on('data', () => {});
        child.stdin.on('error', () => { failurePending.add(next.id); child.kill('SIGTERM'); });
        child.on('error', () => { failurePending.add(next.id); });
        child.on('close', (code) => {
          if (shuttingDown) return finish(next.id, 'canceled', { reason: 'daemon_shutdown' });
          if (cancelPending.has(next.id)) return finish(next.id, 'canceled');
          if (code !== 0 || failurePending.has(next.id)) return finish(next.id, 'failed');
          try {
            const output = JSON.parse(stdout.trim()) as unknown;
            if (row(next.id)?.status !== 'active') return;
            emit(next.id, 'agent', { type: 'text_delta', delta: typeof (output as { message?: unknown })?.message === 'string' ? (output as { message: string }).message : '' });
            finish(next.id, 'succeeded', output);
          } catch { finish(next.id, 'failed'); }
        });
        child.stdin.end(next.request_json!);
      }
    } finally {
      dispatching = false;
      const waiting = db.prepare(`SELECT 1 FROM ${table} WHERE status = 'queued' AND ${company} LIMIT 1`).get();
      const active = (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE status = 'active' AND ${company}`).get() as { n: number }).n;
      if (waiting && active < capacity() + (companyOpenAI.available() ? companyOpenAI.read().capacity : 0)) {
        retryTimer = setTimeout(() => { retryTimer = null; dispatch(); }, 60_000);
        retryTimer.unref();
      }
    }
  };
  const personalCapacity = () => Number((db.prepare("SELECT value FROM multiuser_pool_config WHERE key = 'personal-capacity'")
    .get() as { value: string } | undefined)?.value ?? String(PERSONAL_DEFAULT_CAPACITY));
  let personalDispatching = false;
  // Declared before the startup dispatch below, which may already need it.
  const personalSession = (conversationId: string) => db.prepare('SELECT * FROM multiuser_personal_sessions WHERE conversation_id = ?')
    .get(conversationId) as { owner_account_id: string; personal_account_id: string; thread_id: string | null; stable_prompt_hash: string | null } | undefined;
  /**
   * Personal lane: its own host-wide ceiling, one active run per user, FIFO per
   * user and round-robin across users by their last personal dispatch turn.
   * The company ledger and company slots are never touched.
   */
  dispatchPersonal = () => {
    const launch = personal?.appServerLaunch();
    if (personalDispatching || shuttingDown || !personal || !launch) return;
    personalDispatching = true;
    try {
      while ((db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE status = 'active' AND ${personalRows}`).get() as { n: number }).n < personalCapacity()) {
        const queued = db.prepare(`SELECT * FROM ${table} WHERE status = 'queued' AND ${personalRows} ORDER BY queue_seq`).all() as RunRow[];
        const turns = new Map((db.prepare('SELECT account_id, last_seq FROM multiuser_personal_turns').all() as Array<{ account_id: string; last_seq: number }>)
          .map((turn) => [turn.account_id, turn.last_seq]));
        const next = queued.filter((run) => !db.prepare(`SELECT 1 FROM ${table} WHERE owner_account_id = ? AND status = 'active' AND ${personalRows}`)
          .get(run.owner_account_id))
          .sort((a, b) => (turns.get(a.owner_account_id) ?? 0) - (turns.get(b.owner_account_id) ?? 0) || Number(a.queue_seq) - Number(b.queue_seq))[0];
        if (!next) break;
        if (!accounts.getAccountById(next.owner_account_id)?.active) { finish(next.id, 'canceled'); continue; }
        const project = getProject(db, next.project_id);
        const conversation = getConversation(db, next.conversation_id);
        const metadata = project?.metadata as Record<string, unknown> | null | undefined;
        let realCwd: string | null = null;
        try { realCwd = fs.realpathSync(path.join(projectsRoot, next.project_id)); } catch { /* failed below */ }
        if (!owners.isOwnedBy(next.project_id, next.owner_account_id) || conversation?.projectId !== next.project_id ||
            metadata?.baseDir || metadata?.linkedDirs || metadata?.imported || !realCwd || path.dirname(realCwd) !== fs.realpathSync(projectsRoot)) {
          finish(next.id, 'failed');
          continue;
        }
        // Re-validate the binding at dispatch: same account, same credential version, still usable.
        const account = personal.usableAccount(next.owner_account_id);
        const session = personalSession(next.conversation_id);
        if (!account || account.id !== next.personal_account_id || account.credentialVersion !== next.credential_version ||
            !session || session.personal_account_id !== next.personal_account_id) {
          personal.audit(next.owner_account_id, next.owner_account_id, 'run_rejected', 'MULTIUSER_PERSONAL_UNAVAILABLE', next.id);
          finish(next.id, 'failed', { reason: 'MULTIUSER_PERSONAL_UNAVAILABLE' });
          continue;
        }
        // A damaged request never starts: no runtime home, active mark, personal turn or start event.
        const request = storedRequest(next.request_json);
        const userPrompt = withInstruction(next.request_json, storedMessage(next.request_json));
        const stablePrompt = typeof request?.stablePrompt === 'string' ? request.stablePrompt : '';
        const stablePromptHash = typeof request?.stablePromptHash === 'string' ? request.stablePromptHash : '';
        if (userPrompt === null) {
          finish(next.id, 'failed', { reason: 'MULTIUSER_RUN_REQUEST_INVALID' });
          continue;
        }
        const runHome = path.join(dataRoot, 'multiuser-runtime', createHash('sha256').update(next.owner_account_id).digest('hex'), next.id);
        const temp = path.join(runHome, 'tmp');
        fs.mkdirSync(temp, { recursive: true, mode: 0o700 });
        for (const dir of [path.dirname(runHome), runHome, temp]) fs.chmodSync(dir, 0o700);
        const runId = next.id;
        try {
          const skillPackages = readStudioSkillPackages(request?.skillSnapshots);
          const skillRoot = stageStudioSkillPackages(runHome, skillPackages);
          artifactBaselines.set(runId, { cwd: realCwd, before: snapshotProjectArtifacts(realCwd) });
          startRun(next);
          const owner = next.owner_account_id;
          const accountId = account.id;
          const includeStable = Boolean(stablePrompt) && (!session.thread_id || session.stable_prompt_hash !== stablePromptHash);
          // Attachments were owner-checked at admission; re-resolve against the
          // real project root now, since files may have moved since.
          const attached = formatProjectAttachmentHint(resolveSafeProjectAttachments(realCwd,
            Array.isArray(request?.attachments) ? request.attachments.filter((value): value is string => typeof value === 'string') : []));
          // Narrowed at admission to project files/folders; rendered exactly like a standard run's context.
          const focused = Array.isArray(request?.workspaceItems) && request.workspaceItems.length
            ? `\n\n${renderRunContextPrompt({ workspaceItems: request.workspaceItems }, null)}` : '';
          const resources = skillRoot ? '\n\n# Captured skill resources\n\nThese directories are read-only, fixed to this conversation’s selected revision. Resolve each skill’s relative references and scripts from its own directory:\n'
            + skillPackages.map((resource) => `- ${resource.id}: ${path.join(skillRoot, resource.key)}`).join('\n') : '';
          const prompt = `${includeStable ? `${stablePrompt}\n\n---\n\n# User request\n\n${userPrompt}` : userPrompt}${attached}${focused}${resources}`;
          const projection = new PersonalRunEvents(realCwd, [dataRoot, account.codexHome, runHome, realCwd], (event) => emit(runId, event.event, event.data));
          projections.set(runId, projection);
          const turn = runPersonalCodexTurn({
            command: launch.command, sandbox: launch.sandbox, codexHome: account.codexHome, home: runHome, temp, cwd: realCwd, dataRoot,
            ...(skillRoot ? { skillPackages: skillRoot } : {}),
            prompt, resumeThreadId: session.thread_id,
            ...(isStudioCodexModel(request?.model) ? { model: request.model } : {}),
            ...(isStudioCodexReasoning(request?.reasoning) ? { reasoning: request.reasoning } : {}),
            // A real personal provider always runs inside the per-run bubblewrap
            // boundary. Its filesystem already contains only this account's
            // CODEX_HOME, run HOME/TMPDIR and project cwd, with system paths
            // read-only. Do not ask Codex to create a second Linux sandbox
            // inside it: unprivileged container hosts commonly reject that
            // nested sandbox and every file/command tool then fails to start.
            // `danger-full-access` is scoped to the outer boundary, not the
            // daemon container or host. Mock-only unsandboxed test lanes keep
            // the normal platform/operator-resolved Codex policy.
            sandboxMode: launch.sandbox ? 'danger-full-access' : codexResolvedSandboxMode(),
            onThread: (threadId) => db.prepare(`UPDATE multiuser_personal_sessions SET thread_id = ?, updated_at = ?
              WHERE conversation_id = ? AND personal_account_id = ?`).run(threadId, now(), next.conversation_id, accountId),
            onAgentEvent: (event) => projection.accept(event),
            onDone: (result) => { void (async () => {
              personal.secureHome(owner);
              /** #78: checked on both sides of the artifact snapshot; a terminal reached while it runs wins. */
              const settled = (): boolean => {
                if (row(runId)?.status !== 'active') return true;
                if (shuttingDown) { finish(runId, 'canceled', { reason: 'daemon_shutdown' }); return true; }
                if (!cancelPending.has(runId)) return false;
                finish(runId, 'canceled', sourceInvalidated.has(runId) ? { reason: 'MULTIUSER_PERSONAL_UNAVAILABLE' } : undefined);
                return true;
              };
              if (settled()) return;
              const baseline = artifactBaselines.get(runId);
              let files: string[] = [];
              let producedFiles: import('@open-design/contracts').ProjectFile[] = [];
              if (baseline) {
                try {
                  const after = await snapshotProjectArtifactsAsync(baseline.cwd);
                  files = diffRunArtifacts(baseline.before, after).touchedPaths.map((filePath) => path.relative(baseline.cwd, filePath).replaceAll('\\', '/'))
                    .filter((filePath) => filePath && filePath !== '..' && !filePath.startsWith('../') && !path.isAbsolute(filePath)).slice(0, 128);
                  producedFiles = files.flatMap((name) => {
                    const fingerprint = after.get(path.join(baseline.cwd, name));
                    return fingerprint ? [{ name, path: name, type: 'file' as const, size: fingerprint.size,
                      mtime: fingerprint.mtimeMs, kind: kindFor(name), mime: mimeFor(name) }] : [];
                  });
                  if (settled()) return;
                  const messageId = studioMessages.ids(runId).assistantMessageId;
                  // A damaged/quarantined transcript binding must never let a
                  // capture write refs onto another conversation's message.
                  if (getMessage(db, messageId, next.conversation_id)?.runId === runId) {
                    await captureRunChatArtifactSnapshots({ db, blobs: artifactBlobs }, {
                      projectId: next.project_id, projectRoot: baseline.cwd, messageId, runId,
                      touchedPaths: files.map((file) => path.join(baseline.cwd, file)),
                    });
                  }
                } catch {
                  // Artifact discovery is best-effort. A filesystem race must
                  // not leave a completed provider turn stuck as active.
                }
              }
              if (settled()) return;
              if (result.ok) {
                projection.flush();
                if (includeStable && stablePromptHash) {
                  db.prepare(`UPDATE multiuser_personal_sessions SET stable_prompt_hash = ?, updated_at = ?
                    WHERE conversation_id = ? AND personal_account_id = ?`).run(stablePromptHash, now(), next.conversation_id, accountId);
                }
                return finish(runId, 'succeeded', { text: projection.text, textTruncated: projection.truncated, files, producedFiles, threadId: result.threadId });
              }
              if (result.problem) personal.recordProblem(owner, accountId, result.problem);
              finish(runId, 'failed', { reason: result.problem ? PROBLEM_ERRORS[result.problem].code : 'MULTIUSER_PERSONAL_RUN_FAILED', files, producedFiles });
            })().catch(() => {
              if (row(runId)?.status === 'active') finish(runId, 'failed', { reason: 'MULTIUSER_PERSONAL_RUN_FAILED' });
            }); },
          });
          children.set(runId, turn.child);
          interrupts.set(runId, turn.interrupt);
        } catch {
          // A rolled-back start stays queued; a committed start keeps its turn and worker timestamps.
          if (!children.has(runId)) finish(runId, 'failed', { reason: 'MULTIUSER_PERSONAL_RUN_FAILED' });
        }
      }
    } finally {
      personalDispatching = false;
    }
  };
  const cancelPersonalRuns = async (accountId: string): Promise<void> => {
    const rows = db.prepare(`SELECT id FROM ${table} WHERE owner_account_id = ? AND status IN ('active','queued') AND ${personalRows}`)
      .all(accountId) as Array<{ id: string }>;
    const exits: Array<Promise<void>> = [];
    suspendDispatch = true;
    try {
      for (const run of rows) {
        sourceInvalidated.add(run.id);
        const child = children.get(run.id);
        if (child && running(child)) {
          cancelPending.add(run.id);
          exits.push(new Promise<void>((resolve) => child.once('close', () => resolve())));
          child.kill('SIGTERM');
        } else finish(run.id, 'canceled', { reason: 'MULTIUSER_PERSONAL_UNAVAILABLE' });
      }
    } finally { suspendDispatch = false; }
    await Promise.all(exits);
    dispatchPersonal();
  };
  const personalLane: PersonalRunLaneControls = {
    stats() {
      const count = (status: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE status = ? AND ${personalRows}`)
        .get(status) as { n: number }).n;
      const workerMsByOwner = new Map((db.prepare(`SELECT owner_account_id AS id,
          SUM(COALESCE(ended_at, CASE WHEN status = 'active' THEN NULL ELSE updated_at END, ?) - started_at) AS ms
        FROM ${table} WHERE ${personalRows} AND started_at IS NOT NULL GROUP BY owner_account_id`).all(now()) as Array<{ id: string; ms: number }>)
        .map((entry) => [entry.id, Math.max(0, Number(entry.ms))]));
      return { active: count('active'), queued: count('queued'), capacity: personalCapacity(), workerMsByOwner };
    },
    setCapacity(value, adminId) {
      db.transaction(() => {
        db.prepare("INSERT INTO multiuser_pool_config (key, value) VALUES ('personal-capacity', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
          .run(String(value));
        db.prepare('INSERT INTO multiuser_pool_audit (actor_account_id, action, target_id, value, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(adminId, 'capacity', 'personal-subscription', value, now());
      })();
      dispatchPersonal();
    },
  };
  app.get('/api/admin/pool', (_req, res) => {
    const rows = db.prepare(`SELECT * FROM ${table} WHERE status IN ('active', 'queued') AND ${company}`).all() as RunRow[];
    const counts = (openai: boolean, status: string) => rows.filter((run) => isOpenAI(run) === openai && run.status === status).length;
    const users: Record<string, { usedMs: number; budgetMs: number; remainingMs: number }> = {};
    for (const account of accounts.listAccounts()) {
      const balance = ledger.balance(account.id);
      users[account.id] = { usedMs: balance.usedMs, budgetMs: balance.budgetMs,
        remainingMs: balance.remainingMs };
    }
    res.json({ providers: { 'test-mock': { capacity: capacity(), active: counts(false, 'active'), queued: counts(false, 'queued') },
      openai: { ...companyOpenAI.read(), active: counts(true, 'active'), queued: counts(true, 'queued') }, claude: { capacity: 0, active: 0, queued: 0 }, codex: { capacity: 0, active: 0, queued: 0 } }, users });
  });
  app.get('/api/admin/pool/openai', (_req, res) => res.json({ provider: companyOpenAI.read() }));
  app.put('/api/admin/pool/openai', (req, res) => {
    try {
      const previous = companyOpenAI.read();
      const provider = companyOpenAI.update(actor(res), req.body);
      if (!provider.enabled || provider.credentialRevision !== previous.credentialRevision || provider.model !== previous.model) {
        const pending = db.prepare(`SELECT * FROM ${table} WHERE status IN ('active', 'queued') AND ${company}`).all() as RunRow[];
        suspendDispatch = true;
        try { for (const run of pending) if (isOpenAI(run)) {
          const child = children.get(run.id);
          if (child && running(child)) { cancelPending.add(run.id); child.kill('SIGTERM'); }
          else finish(run.id, 'failed', { reason: 'MULTIUSER_PROVIDER_DISABLED' });
        } } finally { suspendDispatch = false; }
      }
      void dispatch(); res.json({ provider });
    } catch (error) {
      if (error instanceof CompanyOpenAIConfigError) sendApiError(res, error.status, error.status === 409 ? 'CONFLICT' : 'BAD_REQUEST', error.message);
      else sendApiError(res, 500, 'INTERNAL_ERROR', 'company provider update failed');
    }
  });
  app.put('/api/admin/pool/providers/:providerId', (req, res) => {
    const providerId = String(req.params.providerId);
    const value = (req.body as { capacity?: unknown } | undefined)?.capacity;
    if (!['test-mock', 'claude', 'codex'].includes(providerId) || !Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 16) {
      return sendApiError(res, 400, 'BAD_REQUEST', 'invalid provider capacity');
    }
    if (providerId !== 'test-mock' && value !== 0) return sendApiError(res, 403, 'MULTIUSER_PROVIDER_DISABLED', 'real provider slots are disabled');
    if (providerId === 'test-mock') {
      db.transaction(() => {
        db.prepare("INSERT INTO multiuser_pool_config (key, value) VALUES ('test-mock-capacity', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
          .run(String(value));
        db.prepare('INSERT INTO multiuser_pool_audit (actor_account_id, action, target_id, value, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(actor(res), 'capacity', providerId, value, now());
      })();
      dispatch();
    }
    res.json({ providerId, capacity: value });
  });
  app.put('/api/admin/pool/users/:id/quota', (req, res) => {
    const accountId = String(req.params.id);
    const budgetMinutes = (req.body as { budgetMinutes?: unknown } | undefined)?.budgetMinutes;
    if (!accounts.getAccountById(accountId)) return sendApiError(res, 404, 'NOT_FOUND', 'account not found');
    if (!Number.isSafeInteger(budgetMinutes) || Number(budgetMinutes) < 0 || Number(budgetMinutes) > 10_080) {
      return sendApiError(res, 400, 'BAD_REQUEST', 'invalid quota');
    }
    ledger.setBudgetMs(accountId, Number(budgetMinutes) * 60_000, actor(res));
    dispatch();
    res.json({ accountId, budgetMinutes });
  });
  dispatch();
  dispatchPersonal();
  /** Owned managed project + conversation for a new run, or null after answering the error. */
  const managedTarget = (inputBody: Record<string, unknown>, res: Response): { projectId: string; conversationId: string } | null => {
    const fail = (status: number, code: 'NOT_FOUND' | 'MULTIUSER_IMPORTED_PROJECT_FORBIDDEN', message: string) => {
      sendApiError(res, status, code, message);
      return null;
    };
    const projectId = inputBody.projectId;
    const conversationId = inputBody.conversationId;
    if (typeof projectId !== 'string' || typeof conversationId !== 'string' ||
        !owners.isOwnedBy(projectId, actor(res))) return fail(404, 'NOT_FOUND', 'not found');
    const project = getProject(db, projectId);
    const conversation = getConversation(db, conversationId);
    if (!project || !conversation || conversation.projectId !== projectId || targetDeleting(actor(res), projectId, conversationId)) return fail(404, 'NOT_FOUND', 'not found');
    const metadata = project.metadata as Record<string, unknown> | null | undefined;
    if (metadata?.baseDir || metadata?.linkedDirs || metadata?.imported) return fail(403, 'MULTIUSER_IMPORTED_PROJECT_FORBIDDEN', 'managed projects only');
    if (!isSafeId(projectId)) return fail(404, 'NOT_FOUND', 'not found');
    const cwd = path.join(projectsRoot, projectId);
    const realRoot = fs.realpathSync(projectsRoot);
    // Project creation may leave the managed directory lazy until its first run.
    fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
    let realCwd: string;
    try { realCwd = fs.realpathSync(cwd); } catch { return fail(404, 'NOT_FOUND', 'not found'); }
    if (path.dirname(realCwd) !== realRoot) return fail(403, 'MULTIUSER_IMPORTED_PROJECT_FORBIDDEN', 'managed projects only');
    fs.chmodSync(realCwd, 0o700);
    return { projectId, conversationId };
  };
  db.exec(`CREATE TABLE IF NOT EXISTS multiuser_run_requests (
    owner_account_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    client_request_id TEXT NOT NULL,
    run_id TEXT NOT NULL REFERENCES ${table}(id) ON DELETE CASCADE,
    PRIMARY KEY (owner_account_id, conversation_id, client_request_id)
  )`);
  /** Idempotent admission: one logical send (same owner, conversation and key) is one run. */
  const requestedRun = (owner: string, conversationId: string, key: string | null): RunRow | undefined => {
    if (key === null) return undefined;
    const found = db.prepare('SELECT run_id AS id FROM multiuser_run_requests WHERE owner_account_id = ? AND conversation_id = ? AND client_request_id = ?')
      .get(owner, conversationId, key) as { id: string } | undefined;
    return found ? row(found.id) : undefined;
  };
  /**
   * Proposed turn ids are in the actor's namespace, so existence never reveals
   * another tenant's data. A new assistant id is required. The user id is new,
   * or it is the user turn of this conversation's newest run that failed or
   * was canceled: a retry answers the same turn again.
   */
  const turnIdsUsable = (conversationId: string, ids: { userMessageId: string; assistantMessageId: string }): boolean => {
    if (getMessage(db, ids.assistantMessageId)) return false;
    if (!getMessage(db, ids.userMessageId)) return true;
    const retried = studioMessages.runForUserMessage(conversationId, ids.userMessageId);
    const newest = db.prepare(`SELECT id, status FROM ${table} WHERE conversation_id = ? ORDER BY queue_seq DESC LIMIT 1`)
      .get(conversationId) as { id: string; status: RunRow['status'] } | undefined;
    return retried !== null && newest?.id === retried && (newest.status === 'failed' || newest.status === 'canceled');
  };
  /** `instruction` is daemon-authored (routines): sent to the agent with the turn, never shown as the user's message. */
  const createPersonalRun = async (inputBody: Record<string, unknown>, res: Response, instruction?: string) => {
    const target = managedTarget(inputBody, res);
    if (!target) return;
    const owner = actor(res);
    const hints = inputBody.analyticsHints;
    const sourceId = hints && typeof hints === 'object' && !Array.isArray(hints) ? (hints as Record<string, unknown>).sourceRunId : undefined;
    const source = typeof sourceId === 'string' ? row(sourceId) : undefined;
    // Owner first: a foreign or missing source run is the same 404 before any field is judged.
    if (sourceId !== undefined && (!source || source.owner_account_id !== owner || source.project_id !== target.projectId || source.conversation_id !== target.conversationId)) {
      return sendApiError(res, 404, 'NOT_FOUND', 'not found');
    }
    const fields = parsePersonalRunFields(inputBody, studioMessageIdPrefix(owner));
    if ('code' in fields) return sendApiError(res, fields.status, fields.code, fields.message);
    if (!personal?.enabled) return sendApiError(res, 403, 'MULTIUSER_PERSONAL_DISABLED', 'personal subscriptions are not enabled on this server');
    const replay = requestedRun(owner, target.conversationId, fields.clientRequestId);
    if (replay) { res.status(200).json({ runId: replay.id, run: body(replay) }); return; }
    const question = fields.questionSourceRunId === null ? undefined : source;
    const answerReady = () => !question || Boolean(db.prepare(`SELECT 1 FROM multiuser_run_questions q
      WHERE q.run_id = ? AND q.answered_by IS NULL AND NOT EXISTS (
        SELECT 1 FROM multiuser_runs newer WHERE newer.conversation_id = ? AND newer.queue_seq > ?)`)
      .get(question.id, target.conversationId, question.queue_seq));
    if (!answerReady()) return sendApiError(res, 409, 'CONFLICT', 'question is stale or already answered');
    const fixedDesign = input.design?.selection(target.conversationId, owner) ?? null;
    // null means "the conversation's pinned selection"; a named one must match it.
    if (fixedDesign && ((fields.skillId !== null && fields.skillId !== fixedDesign.skillId)
          || (fields.designSystemId !== null && fields.designSystemId !== fixedDesign.designSystemId))) {
      return sendApiError(res, 400, 'BAD_REQUEST', 'skillId and designSystemId must match the conversation design selection');
    }
    const fixedCapture = fixedDesign ? await captureFixedDesign(owner, target.conversationId, fixedDesign) : null;
    if (fixedDesign && !fixedCapture) return sendApiError(res, 400, 'BAD_REQUEST', 'skillId and designSystemId must match the conversation design selection');
    const designSnapshot = fixedCapture ? fixedCapture.design : await captureDesign(owner, target.conversationId, question ? fields.designSystemId : fields.designSystemId ?? getProject(db, target.projectId)?.designSystemId ?? null, question);
    if (designSnapshot === false) return sendApiError(res, 404, 'NOT_FOUND', 'selected design system not found or unavailable');
    const actorContext = await input.settings?.capture(owner) ?? { userInstructions: '', memoryBody: '' };
    let composed = fixedCapture
      ? await input.design?.composeStablePrompt({ conversationId: target.conversationId, ownerId: owner, projectId: target.projectId, ...actorContext,
        captured: { skill: fixedCapture.skill, design: { id: fixedCapture.design.id, ...fixedCapture.design.prompt } } })
      : null;
    if (fixedDesign && !composed) return sendApiError(res, 400, 'BAD_REQUEST', 'skillId and designSystemId must match the conversation design selection');
    const questionRequest = question ? storedRequest(question.request_json) : null;
    const inheritedSkillIds = Array.isArray(questionRequest?.skillIds) && questionRequest.skillIds.every((id) => typeof id === 'string')
      ? questionRequest.skillIds as string[] : [];
    fields.skillIds = selectSkills(fields, target.projectId, Boolean(fixedDesign), Boolean(question));
    if (question && ((!fixedDesign && fields.skillId !== null && !inheritedSkillIds.includes(fields.skillId))
      || fields.skillIds.length && JSON.stringify(fields.skillIds) !== JSON.stringify(inheritedSkillIds))) {
      return sendApiError(res, 409, 'CONFLICT', 'question skills changed');
    }
    const inheritsSkills = Boolean(question && (fields.skillIds.length === 0
      || JSON.stringify(fields.skillIds) === JSON.stringify(inheritedSkillIds)));
    if (inheritsSkills && typeof questionRequest?.stablePrompt === 'string' && typeof questionRequest.stablePromptHash === 'string') {
      composed = { prompt: questionRequest.stablePrompt, hash: questionRequest.stablePromptHash,
        selection: fixedDesign ?? { conversationId: target.conversationId, skillId: '', designSystemId: '', locale: 'en' } };
    }
    if (inheritsSkills && typeof questionRequest?.stablePrompt !== 'string') composed = null;
    const lastDesign = db.prepare('SELECT request_json FROM multiuser_runs WHERE owner_account_id = ? AND conversation_id = ? ORDER BY queue_seq DESC LIMIT 1')
      .get(owner, target.conversationId) as { request_json: string | null } | undefined;
    if (!inheritsSkills && !composed && (actorContext.userInstructions || actorContext.memoryBody || designSnapshot
      || lastDesign && storedRequest(lastDesign.request_json)?.designSnapshot)) {
      const prompt = composeSystemPrompt({ agentId: 'codex', streamFormat: 'json-event-stream',
        executionProfile: 'filesystem', promptCoreVariant: 'slim', sessionMode: 'design', locale: 'en',
        metadata: getProject(db, target.projectId)?.metadata, ...actorContext, ...designSnapshot?.prompt });
      composed = { prompt, hash: createHash('sha256').update(prompt).digest('hex'),
        selection: { conversationId: target.conversationId, skillId: '', designSystemId: '', locale: 'en' } };
    }
    const selectedSkills = fields.skillIds.length && !inheritsSkills ? await captureSkills(owner, target.conversationId, fields.skillIds) : [];
    if (!selectedSkills || fields.skillIds.length > 12) return sendApiError(res, 404, 'NOT_FOUND', 'selected skills not found or unavailable');
    if (selectedSkills.length) {
      // Resolve before queueing. Later edits/deletes cannot change this turn's
      // prompt; the run owns the immutable text, not a live catalog lookup.
      const skillPrompt = composed ? selectedSkills.map((skill) => `\n\n---\n\n## Composed skill — ${skill.name}\n\n${skill.body.trim()}`).join('') : composeSystemPrompt({ agentId: 'codex', streamFormat: 'json-event-stream',
        executionProfile: 'filesystem', promptCoreVariant: 'slim', sessionMode: 'design', locale: 'en',
        metadata: getProject(db, target.projectId)?.metadata,
        skillBody: selectedSkills.map((skill) => skill.body).join('\n\n---\n\n'),
        skillName: selectedSkills.map((skill) => skill.name).join(', '),
        skillMode: selectedSkills[0]?.mode, ...actorContext });
      const prompt = [composed?.prompt, skillPrompt].filter(Boolean).join('\n\n');
      composed = { prompt, hash: createHash('sha256').update(prompt).digest('hex'),
        selection: composed?.selection ?? { conversationId: target.conversationId, skillId: '', designSystemId: '', locale: 'en' } };
    }
    const skillSnapshots = inheritsSkills ? questionRequest?.skillSnapshots ?? [] : withFixedSkill(fixedCapture?.skill, selectedSkills);
    const request = JSON.stringify({ message: fields.text, ...(instruction ? { instruction } : {}), ...(fields.attachments.length ? { attachments: fields.attachments } : {}),
      ...(inheritsSkills || withFixedSkill(fixedCapture?.skill, selectedSkills).length ? { skillIds: inheritsSkills ? inheritedSkillIds : fields.skillIds, skillSnapshots } : {}),
      ...(fields.workspaceItems.length ? { workspaceItems: fields.workspaceItems } : {}),
      ...(fields.model ? { model: fields.model } : {}), ...(fields.reasoning ? { reasoning: fields.reasoning } : {}),
      ...(question ? { analyticsHints: { entryFrom: 'question_answer', sourceRunId: question.id } } : {}),
      ...(designSnapshot ? { designSnapshot } : {}),
      ...(composed ? { skillId: composed.selection.skillId, designSystemId: designSnapshot?.id ?? composed.selection.designSystemId,
        stablePrompt: composed.prompt, stablePromptHash: composed.hash } : {}) });
    // Prompt/catalog I/O yields: deletion or session revocation may have won
    // while it was in flight. Recheck before persisting or spawning anything.
    if (!multiUserStreamAllowed(res) || !managedTarget(inputBody, res)) return;
    const raced = requestedRun(owner, target.conversationId, fields.clientRequestId);
    if (raced) { res.status(200).json({ runId: raced.id, run: body(raced) }); return; }
    // Never fall back: an unusable personal account is an error, not a company run.
    const account = personal.usableAccount(owner);
    if (!account) {
      personal.audit(owner, owner, 'run_rejected', 'MULTIUSER_PERSONAL_UNAVAILABLE');
      return sendApiError(res, 409, 'MULTIUSER_PERSONAL_UNAVAILABLE', 'no usable personal Codex account; link or re-authorize it');
    }
    const session = personalSession(target.conversationId);
    const companyHistory = db.prepare(`SELECT 1 FROM ${table} WHERE conversation_id = ? AND ${company} LIMIT 1`).get(target.conversationId);
    if ((session && session.personal_account_id !== account.id) || companyHistory) {
      personal.audit(owner, owner, 'run_rejected', 'MULTIUSER_EXECUTION_SOURCE_MISMATCH');
      return sendApiError(res, 409, 'MULTIUSER_EXECUTION_SOURCE_MISMATCH', 'this conversation continues on another execution source or account');
    }
    if (question && (!answerReady() || question.personal_account_id !== account.id || question.credential_version !== account.credentialVersion
      || storedRequest(question.request_json)?.stablePromptHash !== composed?.hash
      || (storedJson(question.output) as { threadId?: string } | null)?.threadId !== session?.thread_id)) {
      return sendApiError(res, 409, 'CONFLICT', 'question continuation is stale');
    }
    if (fields.turnIds && !turnIdsUsable(target.conversationId, fields.turnIds)) {
      return sendApiError(res, 409, 'CONFLICT', 'message ids are already used by another turn');
    }
    const queuedCount = (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE owner_account_id = ? AND status = 'queued' AND ${personalRows}`)
      .get(owner) as { n: number }).n;
    if (queuedCount >= PERSONAL_QUEUE_LIMIT) return sendApiError(res, 409, 'MULTIUSER_PERSONAL_QUEUE_LIMIT', 'personal queue limit reached');
    const id = randomUUID();
    const createdAt = now();
    const queuedFrame = db.transaction(() => {
      db.prepare(`INSERT INTO ${table} (id, owner_account_id, project_id, conversation_id, status, created_at, updated_at, request_json,
        queue_seq, execution_source, personal_account_id, credential_version)
        VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, (SELECT COALESCE(MAX(queue_seq), 0) + 1 FROM ${table}), 'personal_subscription', ?, ?)`)
        .run(id, owner, target.projectId, target.conversationId, createdAt, createdAt, request, account.id, account.credentialVersion);
      if (fields.clientRequestId !== null) {
        db.prepare('INSERT INTO multiuser_run_requests (owner_account_id, conversation_id, client_request_id, run_id) VALUES (?, ?, ?, ?)')
          .run(owner, target.conversationId, fields.clientRequestId, id);
      }
      if (question) db.prepare('UPDATE multiuser_run_questions SET answered_by = ? WHERE run_id = ? AND answered_by IS NULL').run(id, question.id);
      // The first personal run pins the conversation to this account and its native session.
      db.prepare(`INSERT OR IGNORE INTO multiuser_personal_sessions (conversation_id, owner_account_id, personal_account_id, updated_at)
        VALUES (?, ?, ?, ?)`).run(target.conversationId, owner, account.id, createdAt);
      studioMessages.reconcile(row(id)!, fields.turnIds ?? undefined);
      // The project list orders by activity; admission is that activity.
      updateProject(db, target.projectId, {});
      return persistEvent(id, 'queued', { runId: id });
    })();
    personal.audit(owner, owner, 'run_routed', 'personal_subscription', id);
    publishEvent(id, queuedFrame);
    dispatchPersonal();
    res.status(202).json({ runId: id, run: body(row(id)!) });
  };
  const createOpenAIRun = async (inputBody: Record<string, unknown>, res: Response, instruction?: string) => {
    const target = managedTarget(inputBody, res); if (!target) return;
    const owner = actor(res);
    const hints = inputBody.analyticsHints;
    const sourceId = hints && typeof hints === 'object' && !Array.isArray(hints) ? (hints as Record<string, unknown>).sourceRunId : undefined;
    const source = typeof sourceId === 'string' ? row(sourceId) : undefined;
    if (sourceId !== undefined && (!source || source.owner_account_id !== owner || source.project_id !== target.projectId || source.conversation_id !== target.conversationId)) {
      return sendApiError(res, 404, 'NOT_FOUND', 'not found');
    }
    const fields = parsePersonalRunFields({ ...inputBody, agentId: 'codex', executionSource: 'personal_subscription' }, studioMessageIdPrefix(owner));
    if ('code' in fields) return sendApiError(res, fields.status, fields.code, fields.message);
    // The company model is admin-owned; a per-turn choice applies only to personal Codex.
    if (fields.model || fields.reasoning) return sendApiError(res, 403, 'MULTIUSER_CAPABILITY_UNAVAILABLE', 'not available for company pool runs: model, reasoning');
    const replay = requestedRun(owner, target.conversationId, fields.clientRequestId);
    if (replay) { res.status(200).json({ runId: replay.id, run: body(replay) }); return; }
    if (personalSession(target.conversationId)) return sendApiError(res, 409, 'MULTIUSER_EXECUTION_SOURCE_MISMATCH', 'this conversation uses a personal subscription');
    const config = companyOpenAI.read();
    if (!config.enabled || !config.configured) return sendApiError(res, 403, 'MULTIUSER_PROVIDER_DISABLED', 'company OpenAI provider is not configured');
    const session = db.prepare('SELECT * FROM multiuser_company_sessions WHERE conversation_id = ?').get(target.conversationId) as { owner_account_id: string; model: string; credential_revision: number } | undefined;
    if (session && (session.owner_account_id !== owner || session.model !== config.model || session.credential_revision !== config.credentialRevision)) {
      return sendApiError(res, 409, 'MULTIUSER_EXECUTION_SOURCE_MISMATCH', 'company provider binding changed; create a new conversation');
    }
    const question = fields.questionSourceRunId === null ? undefined : source;
    const answerReady = () => !question || Boolean(isOpenAI(question) && question.status === 'succeeded'
      && db.prepare(`SELECT 1 FROM multiuser_run_questions q WHERE q.run_id = ? AND q.answered_by IS NULL
        AND NOT EXISTS (SELECT 1 FROM multiuser_runs newer WHERE newer.conversation_id = ? AND newer.queue_seq > ?)`)
        .get(question.id, target.conversationId, question.queue_seq));
    if (!answerReady()) return sendApiError(res, 409, 'CONFLICT', 'question is stale or already answered');
    const previousRequest = question ? storedRequest(question.request_json) : null;
    const capturedSkillIds = Array.isArray(previousRequest?.skillIds) ? previousRequest.skillIds : [];
    const fixed = input.design?.selection(target.conversationId, owner) ?? null;
    fields.skillIds = selectSkills(fields, target.projectId, Boolean(fixed), Boolean(question));
    if (question && ((!fixed && fields.skillId !== null && !capturedSkillIds.includes(fields.skillId))
      || fields.skillIds.length && JSON.stringify(fields.skillIds) !== JSON.stringify(capturedSkillIds))) {
      return sendApiError(res, 409, 'CONFLICT', 'question skills changed');
    }
    if (fixed &&
      (fields.skillId !== null && fields.skillId !== fixed.skillId || fields.designSystemId !== null && fields.designSystemId !== fixed.designSystemId)) {
      return sendApiError(res, 400, 'BAD_REQUEST', 'design selection mismatch');
    }
    const fixedCapture = fixed && !question ? await captureFixedDesign(owner, target.conversationId, fixed) : null;
    if (fixed && !question && !fixedCapture) return sendApiError(res, 400, 'BAD_REQUEST', 'design selection unavailable');
    const designSnapshot = fixedCapture ? fixedCapture.design : fixed ? null : await captureDesign(owner, target.conversationId, question ? fields.designSystemId : fields.designSystemId ?? getProject(db, target.projectId)?.designSystemId ?? null, question);
    if (designSnapshot === false) return sendApiError(res, 404, 'NOT_FOUND', 'selected design system not found or unavailable');
    const selected = !question && fields.skillIds.length ? await captureSkills(owner, target.conversationId, fields.skillIds) : [];
    if (!selected) return sendApiError(res, 404, 'NOT_FOUND', 'selected skills not found or unavailable');
    const actorContext = await input.settings?.capture(owner) ?? { userInstructions: '', memoryBody: '' };
    const design = fixedCapture ? await input.design?.composeStablePrompt({ ...target, ownerId: owner, ...actorContext,
      captured: { skill: fixedCapture.skill, design: { id: fixedCapture.design.id, ...fixedCapture.design.prompt } } }) : null;
    if (fixed && question && typeof previousRequest?.stablePrompt !== 'string') return sendApiError(res, 400, 'BAD_REQUEST', 'design selection unavailable');
    if (fixedCapture && !design) return sendApiError(res, 400, 'BAD_REQUEST', 'design selection unavailable');
    const stablePrompt = design?.prompt ?? composeSystemPrompt({ agentId: 'codex', streamFormat: 'json-event-stream',
      executionProfile: 'filesystem', promptCoreVariant: 'slim', sessionMode: 'design', locale: 'en', metadata: getProject(db, target.projectId)?.metadata, ...actorContext, ...designSnapshot?.prompt });
    const prompt = question && typeof previousRequest?.stablePrompt === 'string' ? previousRequest.stablePrompt : stablePrompt + selected.map((skill) => `\n\n---\n\n## Composed skill — ${skill.name}\n\n${skill.body.trim()}`).join('');
    if (!multiUserStreamAllowed(res) || !managedTarget(inputBody, res)) return;
    if (personalSession(target.conversationId)) return sendApiError(res, 409, 'MULTIUSER_EXECUTION_SOURCE_MISMATCH', 'this conversation uses a personal subscription');
    if (!answerReady()) return sendApiError(res, 409, 'CONFLICT', 'question is stale or already answered');
    const currentSession = db.prepare('SELECT * FROM multiuser_company_sessions WHERE conversation_id = ?').get(target.conversationId) as typeof session;
    if (currentSession && (currentSession.owner_account_id !== owner || currentSession.model !== config.model || currentSession.credential_revision !== config.credentialRevision)) {
      return sendApiError(res, 409, 'MULTIUSER_EXECUTION_SOURCE_MISMATCH', 'company provider binding changed');
    }
    const oldCompany = db.prepare(`SELECT * FROM ${table} WHERE conversation_id = ? AND ${company} LIMIT 1`).get(target.conversationId) as RunRow | undefined;
    if (oldCompany && !isOpenAI(oldCompany)) return sendApiError(res, 409, 'MULTIUSER_EXECUTION_SOURCE_MISMATCH', 'this conversation uses another company provider');
    const current = companyOpenAI.read();
    if (!current.enabled || current.model !== config.model || current.credentialRevision !== config.credentialRevision) return sendApiError(res, 409, 'CONFLICT', 'company provider changed');
    const raced = requestedRun(owner, target.conversationId, fields.clientRequestId);
    if (raced) { res.status(200).json({ runId: raced.id, run: body(raced) }); return; }
    if (fields.turnIds && !turnIdsUsable(target.conversationId, fields.turnIds)) return sendApiError(res, 409, 'CONFLICT', 'message ids already used');
    if (ledger.balance(owner).remainingMs === 0) return sendApiError(res, 429, 'MULTIUSER_QUOTA_EXHAUSTED', 'worker quota exhausted');
    const queued = (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE owner_account_id = ? AND status = 'queued' AND ${company}`).get(owner) as { n: number }).n;
    if (queued >= 3) return sendApiError(res, 409, 'MULTIUSER_QUEUE_LIMIT', 'queue limit reached');
    const id = randomUUID(); const createdAt = now();
    const request = JSON.stringify({ message: fields.text, ...(instruction ? { instruction } : {}), companyProvider: 'openai', companyModel: config.model,
      companyCredentialRevision: config.credentialRevision, stablePrompt: prompt, stablePromptHash: createHash('sha256').update(prompt).digest('hex'),
      skillIds: question ? capturedSkillIds : fields.skillIds,
      skillSnapshots: question ? previousRequest?.skillSnapshots ?? [] : withFixedSkill(fixedCapture?.skill, selected),
      ...(designSnapshot ? { designSnapshot, designSystemId: designSnapshot.id } : {}),
      ...(question ? { analyticsHints: { entryFrom: 'question_answer', sourceRunId: question.id } } : {}),
      attachments: fields.attachments, workspaceItems: fields.workspaceItems });
    const frame = db.transaction(() => {
      db.prepare(`INSERT OR IGNORE INTO multiuser_company_sessions (conversation_id, owner_account_id, provider_id, model, credential_revision) VALUES (?, ?, 'openai', ?, ?)`)
        .run(target.conversationId, owner, config.model, config.credentialRevision);
      db.prepare(`INSERT INTO ${table} (id, owner_account_id, project_id, conversation_id, status, created_at, updated_at, request_json, queue_seq)
        VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, (SELECT COALESCE(MAX(queue_seq), 0) + 1 FROM ${table}))`)
        .run(id, owner, target.projectId, target.conversationId, createdAt, createdAt, request);
      if (fields.clientRequestId !== null) db.prepare('INSERT INTO multiuser_run_requests (owner_account_id, conversation_id, client_request_id, run_id) VALUES (?, ?, ?, ?)')
        .run(owner, target.conversationId, fields.clientRequestId, id);
      if (question) db.prepare('UPDATE multiuser_run_questions SET answered_by = ? WHERE run_id = ? AND answered_by IS NULL').run(id, question.id);
      updateProject(db, target.projectId, {});
      studioMessages.reconcile(row(id)!, fields.turnIds ?? undefined);
      return persistEvent(id, 'queued', { runId: id });
    }).immediate();
    publishEvent(id, frame); dispatch(); res.status(202).json({ runId: id, run: body(row(id)!) });
  };
  app.post('/api/runs', async (req, res) => {
    const inputBody = req.body as Record<string, unknown> | null;
    if (!inputBody || typeof inputBody !== 'object' || Array.isArray(inputBody)) return sendApiError(res, 400, 'BAD_REQUEST', 'invalid run request');
    const source = inputBody.executionSource;
    if (source !== undefined && source !== 'company_pool' && source !== 'personal_subscription') {
      return sendApiError(res, 400, 'BAD_REQUEST', 'invalid execution source');
    }
    // The shared Studio sends the standard request without a source: codex is personal-only here.
    if (inputBody.agentId === 'openai' && (source === undefined || source === 'company_pool')) return createOpenAIRun(inputBody, res);
    if (source === 'personal_subscription' || (source === undefined && inputBody.agentId === 'codex')) return createPersonalRun(inputBody, res);
    if (inputBody.agentId !== 'test-mock' || inputBody.model !== undefined || inputBody.provider !== undefined ||
        Object.keys(inputBody).some((key) => !['projectId', 'conversationId', 'agentId', 'message', 'delayMs', 'executionSource'].includes(key))) {
      return sendApiError(res, 403, 'MULTIUSER_AGENT_FORBIDDEN', 'only the test mock is available');
    }
    if (!mockAgentScript) return sendApiError(res, 403, 'MULTIUSER_AGENT_FORBIDDEN', 'test mock is unavailable');
    const target = managedTarget(inputBody, res);
    if (!target) return;
    const { projectId, conversationId } = target;
    if (input.design?.selection(conversationId, actor(res))) {
      return sendApiError(res, 409, 'MULTIUSER_EXECUTION_SOURCE_MISMATCH', 'design conversations use the linked personal Codex subscription');
    }
    if (personalSession(conversationId)) {
      return sendApiError(res, 409, 'MULTIUSER_EXECUTION_SOURCE_MISMATCH', 'this conversation continues on a personal subscription');
    }
    if (typeof inputBody.message !== 'string' || inputBody.message.length > 64_000 ||
        (inputBody.delayMs !== undefined && (!Number.isInteger(inputBody.delayMs) || Number(inputBody.delayMs) < 0 || Number(inputBody.delayMs) > 2000))) {
      return sendApiError(res, 400, 'BAD_REQUEST', 'invalid mock request');
    }
    const mockRequest = JSON.stringify({ message: inputBody.message, delayMs: inputBody.delayMs });
    if (Buffer.byteLength(mockRequest, 'utf8') > 64 * 1024) {
      return sendApiError(res, 400, 'BAD_REQUEST', 'mock request is too large');
    }
    if (ledger.balance(actor(res)).remainingMs === 0) return sendApiError(res, 429, 'MULTIUSER_QUOTA_EXHAUSTED', 'worker quota exhausted');
    const queuedCount = (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE owner_account_id = ? AND status = 'queued' AND ${company}`)
      .get(actor(res)) as { n: number }).n;
    if (queuedCount >= 3) return sendApiError(res, 409, 'MULTIUSER_QUEUE_LIMIT', 'queue limit reached');
    const id = randomUUID();
    const createdAt = now();
    db.transaction(() => {
      db.prepare(`INSERT INTO ${table} (id, owner_account_id, project_id, conversation_id, status, created_at, updated_at, request_json, queue_seq)
        VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, (SELECT COALESCE(MAX(queue_seq), 0) + 1 FROM ${table}))`)
        .run(id, actor(res), projectId, conversationId, createdAt, createdAt, mockRequest);
      studioMessages.reconcile(row(id)!);
    })();
    emit(id, 'queued', { runId: id });
    dispatch();
    res.status(202).json({ runId: id, run: body(row(id)!) });
  });
  /**
   * Owner-only: the conversation is pinned to a personal account that is no
   * longer the owner's linked account. Re-authorization keeps the account row,
   * so only unlink (and any later new link) makes a pin stale. Foreign, missing
   * and unpinned conversations all answer false.
   */
  const personalPinStale = (owner: string, conversationId: string): boolean => {
    const pin = personalSession(conversationId);
    const projectId = pin ? getConversation(db, conversationId)?.projectId : undefined;
    if (!pin || !personal || pin.owner_account_id !== owner || !projectId || !owners.isOwnedBy(projectId, owner)) return false;
    return !personal.isOwner('accountId', pin.personal_account_id, owner);
  };
  app.get('/api/runs', (req, res) => {
    const query = parseRunListQuery(req.query);
    if (!query) return sendApiError(res, 400, 'BAD_REQUEST', 'invalid run list query');
    const owner = actor(res);
    // Ownership and filters apply in SQL before the limit, so a page is never short of the owner's rows.
    const where = ['r.owner_account_id = ?', 'o.owner_account_id = ?'];
    const args: Array<string | number> = [owner, owner];
    if (query.projectId !== undefined) { where.push('r.project_id = ?'); args.push(query.projectId); }
    if (query.conversationId !== undefined) { where.push('r.conversation_id = ?'); args.push(query.conversationId); }
    if (query.status === 'nonterminal') where.push("r.status IN ('queued','active')");
    else if (query.status !== undefined) { where.push('r.status = ?'); args.push(query.status); }
    if (query.cursor) {
      where.push('(r.created_at < ? OR (r.created_at = ? AND r.id < ?))');
      args.push(query.cursor.createdAt, query.cursor.createdAt, query.cursor.id);
    }
    const rows = db.prepare(`SELECT r.* FROM ${table} r JOIN ${PROJECT_OWNERS_TABLE} o ON o.project_id = r.project_id
      WHERE ${where.join(' AND ')} ORDER BY r.created_at DESC, r.id DESC LIMIT ?`).all(...args, query.limit + 1) as RunRow[];
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    const response: MultiUserRunsResponse = {
      runs: page.map(body), awaitingInputProjectIds: (db.prepare(`SELECT DISTINCT r.project_id AS id FROM multiuser_run_questions q
        JOIN multiuser_runs r ON r.id = q.run_id JOIN ${PROJECT_OWNERS_TABLE} o ON o.project_id = r.project_id
        WHERE r.owner_account_id = ? AND o.owner_account_id = ? AND q.answered_by IS NULL
        AND NOT EXISTS (SELECT 1 FROM multiuser_runs newer WHERE newer.conversation_id = r.conversation_id AND newer.queue_seq > r.queue_seq)`)
        .all(actor(res), actor(res)) as Array<{ id: string }>).map((value) => value.id),
      nextCursor: rows.length > query.limit && last ? `${last.created_at}:${last.id}` : null,
      ...(query.conversationId === undefined ? {} : { personalPinStale: personalPinStale(owner, query.conversationId) }),
    };
    res.json(response);
  });
  app.get('/api/runs/:id', (req, res) => { const run = owned(req, res); if (run) res.json(body(run)); });
  app.get('/api/runs/:id/events', (req, res) => {
    const run = owned(req, res);
    if (!run) return;
    // Same cursor contract as the single-user stream: header or `?after=`.
    const header = req.get('Last-Event-ID');
    const after = req.query.after;
    if (after !== undefined && (typeof after !== 'string' || (header !== undefined && header !== after))) {
      sendApiError(res, 400, 'BAD_REQUEST', 'invalid event cursor');
      return;
    }
    const cursor = header ?? after;
    if (cursor !== undefined && (!/^\d{1,15}$/.test(cursor) || !Number.isSafeInteger(Number(cursor)))) {
      sendApiError(res, 400, 'BAD_REQUEST', 'invalid event cursor');
      return;
    }
    const since = Number(cursor ?? 0);
    const last = (db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM multiuser_run_events WHERE run_id = ?').get(run.id) as { seq: number }).seq;
    if (since > last) { sendApiError(res, 400, 'BAD_REQUEST', 'invalid event cursor'); return; }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Accel-Buffering', 'no');
    bindMultiUserStream(res);
    const events = db.prepare('SELECT seq, event, data FROM multiuser_run_events WHERE run_id = ? AND seq > ? ORDER BY seq').all(run.id, since) as Array<{ seq: number; event: string; data: string }>;
    for (const event of events) {
      if (!multiUserStreamAllowed(res)) return;
      res.write(`id: ${event.seq}\nevent: ${event.event}\ndata: ${event.data}\n\n`);
    }
    if (run.status !== 'active' && run.status !== 'queued') { res.end(); return; }
    const set = listeners.get(run.id) ?? new Set<Response>();
    set.add(res);
    listeners.set(run.id, set);
    res.on('close', () => { set.delete(res); if (set.size === 0) listeners.delete(run.id); });
  });
  app.post('/api/runs/:id/cancel', (req, res) => {
    const run = owned(req, res);
    if (!run) return;
    if (run.status === 'active') {
      const child = children.get(run.id);
      if (child && running(child)) {
        cancelPending.add(run.id);
        child.once('close', () => res.json(body(row(run.id)!)));
        const interrupt = interrupts.get(run.id);
        if (interrupt) {
          interrupt();
          const fallback = setTimeout(() => { if (children.get(run.id) === child) child.kill('SIGKILL'); }, 2000);
          child.once('close', () => clearTimeout(fallback));
        } else child.kill('SIGTERM');
        return;
      }
    }
    finish(run.id, 'canceled');
    res.json(body(row(run.id)!));
  });
  app.post('/api/runs/:id/steer', (req, res) => {
    const run = owned(req, res);
    if (!run) return;
    const body = req.body as Record<string, unknown> | null;
    if (!body || Array.isArray(body) || Object.keys(body).some((key) => key !== 'text')
      || typeof body.text !== 'string' || !body.text.trim() || Buffer.byteLength(body.text) > 64 * 1024) {
      return sendApiError(res, 400, 'BAD_REQUEST', 'text is required; other fields are not accepted');
    }
    const verdict = classifyRunSteering({ runtimeAccepts: false, terminal: !['active', 'queued'].includes(run.status), stdinOpen: false });
    if (!verdict.ok) return sendApiError(res, 409, 'RUN_STEERING_UNSUPPORTED', 'this execution source does not support mid-turn steering',
      { retryable: false, details: { refusal: verdict.refusal } });
  });
  // Telemetry side channel only: the rating itself is the owner's message
  // write. Multi-user mode has no private-content telemetry egress, so a valid
  // request is acknowledged as skipped; ownership is still checked first.
  app.post('/api/runs/:id/feedback', (req, res) => {
    const run = owned(req, res);
    if (!run) return;
    const input = req.body as Record<string, unknown> | null;
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || ['projectId', 'conversationId', 'assistantMessageId'].some((key) => Object.hasOwn(input, key))
      || Object.keys(input).some((key) => !['rating', 'reasonCodes', 'hasCustomReason', 'customReason'].includes(key))
      || parseStudioMessageFeedback({ rating: input.rating, createdAt: 0,
        ...(input.reasonCodes === undefined ? {} : { reasonCodes: input.reasonCodes }),
        ...(input.customReason === undefined ? {} : { customReason: input.customReason }) }) === undefined
      || (input.hasCustomReason !== undefined && typeof input.hasCustomReason !== 'boolean')) {
      return sendApiError(res, 400, 'BAD_REQUEST', 'invalid feedback');
    }
    res.status(202).json({ status: 'skipped_no_sink' } satisfies ChatRunFeedbackResponse);
  });
  const beginShutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    for (const set of listeners.values()) for (const res of set) res.end();
    listeners.clear();
  };
  let shutdownPromise: Promise<void> | null = null;
  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    beginShutdown();
    shutdownPromise = (async () => {
      // An exited child's run is settling, not running: settle it like its close handler would.
      for (const [id, child] of [...children]) if (!running(child)) finish(id, 'canceled', { reason: 'daemon_shutdown' });
      const exits = [...children.values()].map((child) => new Promise<void>((resolve) => child.once('close', () => resolve())));
      const wait = async (ms: number) => {
        if (children.size === 0) return;
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([Promise.all(exits), new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); })]);
        if (timer) clearTimeout(timer);
      };
      for (const child of children.values()) child.kill('SIGTERM');
      await wait(2_000);
      if (children.size > 0) {
        for (const child of children.values()) child.kill('SIGKILL');
        await wait(1_000);
      }
      for (const id of children.keys()) finish(id, 'failed', { reason: 'shutdown_timeout' });
      storesClosed = true;
      ledger.close();
      accounts.close();
    })();
    return shutdownPromise;
  };
  return {
    async admitInternal(actorRecord, request, allowed, instruction) {
      const { res, result } = internalMultiUserResponse(actorRecord, allowed);
      if (request.executionSource === 'company_pool') await createOpenAIRun({ ...request, agentId: 'openai' }, res, instruction);
      else await createPersonalRun({ ...request, agentId: 'codex', executionSource: 'personal_subscription' }, res, instruction);
      return result() ?? { status: 499, body: null };
    },
    runState(runId, accountId) {
      const found = row(runId);
      if (!found || found.owner_account_id !== accountId) return null;
      const run = body(found);
      const output = run.output as { text?: unknown; reason?: unknown } | null;
      return { status: run.status, text: typeof output?.text === 'string' ? output.text : null,
        reason: typeof output?.reason === 'string' ? output.reason : null };
    },
    isRunOwner(runId, accountId) {
      const found = row(runId);
      return !!found && found.owner_account_id === accountId && owners.isOwnedBy(found.project_id, accountId);
    },
    cancelAccountRuns(accountId) {
      const active = db.prepare(`SELECT id FROM ${table} WHERE owner_account_id = ? AND status IN ('active','queued')`).all(accountId) as Array<{ id: string }>;
      suspendDispatch = true;
      try {
        for (const run of active) {
          const child = children.get(run.id);
          if (child && running(child)) { cancelPending.add(run.id); child.kill('SIGTERM'); }
          else finish(run.id, 'canceled');
        }
      } finally { suspendDispatch = false; }
      dispatch();
      dispatchPersonal();
    },
    cancelPersonalRuns,
    async cancelProjectRuns(accountId, projectId, conversationId) {
      const key = targetKey(accountId, projectId, conversationId);
      deletingTargets.set(key, (deletingTargets.get(key) ?? 0) + 1);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        const remaining = (deletingTargets.get(key) ?? 1) - 1;
        if (remaining > 0) deletingTargets.set(key, remaining);
        else deletingTargets.delete(key);
      };
      let keepFence = false;
      try {
        const rows = db.prepare(`SELECT id FROM ${table}
          WHERE owner_account_id = ? AND project_id = ? AND status IN ('active','queued')
          ${conversationId === undefined ? '' : 'AND conversation_id = ?'}`)
          .all(...(conversationId === undefined ? [accountId, projectId] : [accountId, projectId, conversationId])) as Array<{ id: string }>;
        const exits: Promise<void>[] = [];
        suspendDispatch = true;
        try {
          for (const run of rows) {
            const child = children.get(run.id);
            if (!child || !running(child)) { finish(run.id, 'canceled'); continue; }
            cancelPending.add(run.id);
            exits.push(new Promise<void>((resolve) => {
              const deadline = setTimeout(() => { child.kill('SIGKILL'); }, 2_000);
              deadline.unref();
              child.once('close', () => { clearTimeout(deadline); resolve(); });
            }));
            child.kill('SIGTERM');
          }
        } finally { suspendDispatch = false; }
        await Promise.all(exits);
        dispatch();
        dispatchPersonal();
        keepFence = true;
        return release;
      } finally { if (!keepFence) release(); }
    },
    // A subscription switch: pinned conversations keep their account but start a fresh native thread.
    forgetNativeSessions(accountId) {
      db.prepare('UPDATE multiuser_personal_sessions SET thread_id = NULL, updated_at = ? WHERE owner_account_id = ?').run(now(), accountId);
    },
    personalLane,
    listAccountIds: () => accounts.listAccounts().map((account) => account.id),
    beginShutdown,
    shutdown,
    get openaiPoolAvailable() { return companyOpenAI.enabled(); },
    get companyPoolAvailable() { return mockAgentScript !== null || companyOpenAI.enabled(); },
  };
}
