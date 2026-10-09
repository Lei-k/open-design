import { EventEmitter } from 'node:events';
import { listCompanyProjectFiles, readCompanyProjectFile, writeCompanyProjectBytes, writeCompanyProjectFile } from '../services/company-project-files.js';
import type { StudioSkillPackage } from '../services/studio-skill-packages.js';
import type { StudioSkillScriptRunner } from '../services/studio-skill-scripts.js';
import { STUDIO_LIVE_ARTIFACT_TOOLS, type StudioLiveArtifactTools } from '../live-artifacts/studio-tools.js';
import { STUDIO_MEDIA_TOOLS, STUDIO_MEDIA_TOOL_NAMES, StudioMediaError, emptyStudioMediaUsage, runStudioMediaTool, type StudioMediaUsage } from './studio-media.js';

type Json = Record<string, unknown>;
const RESPONSE_BYTES_LIMIT = 4 * 1024 * 1024;
const FILE_BYTES_LIMIT = 1024 * 1024;
const MAX_REQUESTS = 12;
const tools = [
  { name: 'update_plan', description: 'Record the complete current task plan before substantial work and update it as work progresses. At most 32 tasks, each with at most 200 characters of content. Use pending, in_progress or completed; mark a task completed only after its work is done. Keep blockers in the plan.',
    properties: { todos: { type: 'array', items: { type: 'object', properties: { content: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] } },
      required: ['content', 'status'], additionalProperties: false } } }, required: ['todos'] },
  { name: 'list_skill_files', description: 'List immutable resources of the skills selected for this conversation. Each result identifies the skill and its relative resource paths.', properties: {}, required: [] },
  { name: 'read_skill_file', description: 'Read a UTF-8 resource from a selected skill’s captured revision. Resolve relative skill references here.',
    properties: { skillId: { type: 'string' }, path: { type: 'string' } }, required: ['skillId', 'path'] },
  { name: 'copy_skill_file', description: 'Copy a captured resource (text or binary, such as a font, image or template) from a selected skill into the current project.',
    properties: { skillId: { type: 'string' }, path: { type: 'string' }, destination: { type: 'string' } }, required: ['skillId', 'path', 'destination'] },
  { name: 'run_skill_script', description: 'Run a script shipped by a selected skill in an offline sandbox. The working directory is the current project, which the script may read and write; $OD_SKILL_DIR is the skill’s read-only directory. Returns exit code, stdout and stderr.',
    properties: { skillId: { type: 'string' }, path: { type: 'string' }, args: { type: 'array', items: { type: 'string' } } }, required: ['skillId', 'path', 'args'] },
  { name: 'list_project_files', description: 'List files in the current project.', properties: {}, required: [] },
  { name: 'read_project_file', description: 'Read a UTF-8 text file in the current project.', properties: { path: { type: 'string' } }, required: ['path'] },
  { name: 'write_project_file', description: 'Create or replace a UTF-8 text file in the current project. Use HTML with inline assets for browser designs.',
    properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
].map(({ properties, required, ...tool }) => ({ ...tool, type: 'function', strict: true,
  parameters: { type: 'object', properties, required, additionalProperties: false } }));
const mediaTools = STUDIO_MEDIA_TOOLS.map(({ properties, required, ...tool }) => ({ ...tool, type: 'function', strict: true,
  parameters: { type: 'object', properties, required: [...required], additionalProperties: false } }));
const artifactTools = STUDIO_LIVE_ARTIFACT_TOOLS.map(({ properties, required, ...tool }) => ({ ...tool, type: 'function', strict: true,
  parameters: { type: 'object', properties, required: [...required], additionalProperties: false } }));

export interface CompanyOpenAITurnResult { ok: boolean; input: Json[]; files: string[]; usage: { inputTokens: number; outputTokens: number }; media: StudioMediaUsage }

/** Same lifecycle the scheduler uses for native children, without giving an
 * agent process the company API key. The daemon executes only bounded,
 * project-scoped file functions and, when the host provides one, captured
 * skill scripts in an offline sandbox; there is no host shell or client endpoint. */
export class CompanyOpenAIWorker extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly abort = new AbortController();
  kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    if (this.exitCode !== null || this.signalCode !== null) return false;
    this.abort.abort();
    this.pendingSignal = typeof signal === 'string' ? signal : 'SIGTERM';
    return true;
  }
  private pendingSignal: NodeJS.Signals | null = null;
  close(ok: boolean): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    if (this.pendingSignal) this.signalCode = this.pendingSignal;
    else this.exitCode = ok ? 0 : 1;
    this.emit('close', this.exitCode, this.signalCode);
  }
}

/** Official Responses API function-call cycle, using stateless owner history.
 * https://developers.openai.com/api/docs/guides/function-calling
 * HTTP errors, provider prose and credentials never enter run events. */
export async function runCompanyOpenAITurn(input: {
  apiKey: string; model: string; prompt: string; systemPrompt?: string; history: Json[];
  projectsRoot: string; projectId: string; worker: CompanyOpenAIWorker;
  skillPackages?: readonly StudioSkillPackage[];
  /** Present only when the host can build the offline script sandbox. */
  runSkillScript?: StudioSkillScriptRunner;
  authorized: () => boolean; onAgentEvent: (event: Json) => void;
  fetch?: typeof fetch;
  /** Image, speech and video functions on the same key and bill as the turn (#63). */
  media?: boolean;
  liveArtifacts?: StudioLiveArtifactTools;
}): Promise<CompanyOpenAITurnResult> {
  const signal = AbortSignal.any([input.worker.abort.signal, AbortSignal.timeout(10 * 60_000)]);
  const check = () => { signal.throwIfAborted(); if (!input.authorized()) throw new Error('company_authority_changed'); };
  const history: Json[] = [...(input.systemPrompt ? [{ role: 'developer', content: input.systemPrompt }] : []),
    ...input.history.filter((item) => item.role !== 'developer'), { role: 'user', content: input.prompt }];
  const files = new Set<string>(); const usage = { inputTokens: 0, outputTokens: 0 }; const media = emptyStudioMediaUsage();
  const emit = (event: Json) => { check(); input.onAgentEvent(event); };
  const safePath = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 1024
    && !value.includes('\0') && !value.startsWith('/') && !value.includes('\\') && !value.split('/').some((part) => !part || part === '..');
  for (let count = 0; count < MAX_REQUESTS; count++) {
    check();
    if (Buffer.byteLength(JSON.stringify(history)) > RESPONSE_BYTES_LIMIT) throw new Error('company_history_limit');
    const response = await (input.fetch ?? fetch)('https://api.openai.com/v1/responses', {
      method: 'POST', signal, redirect: 'error', headers: { authorization: `Bearer ${input.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: input.model, store: false, stream: true, input: history,
        include: ['reasoning.encrypted_content'], max_output_tokens: 8192, parallel_tool_calls: false,
        tools: [...tools.filter((tool) => tool.name !== 'run_skill_script' || input.runSkillScript), ...(input.media ? mediaTools : []),
          ...(input.liveArtifacts ? artifactTools : [])] }),
    });
    check();
    if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
      await response.body?.cancel();
      // Coarse, secret-free classes; the provider's own message is never kept.
      throw new Error(response.status === 401 || response.status === 403 ? 'provider_auth_rejected'
        : response.status === 429 ? 'provider_rate_limited' : 'company_provider_failed');
    }
    const reader = response.body.getReader(); const decoder = new TextDecoder();
    let bytes = 0; let buffer = ''; let completed: Json | null = null;
    try {
      for (;;) {
        const chunk = await reader.read(); check(); if (chunk.done) break;
        bytes += chunk.value.byteLength; if (bytes > RESPONSE_BYTES_LIMIT) throw new Error('company_response_limit');
        buffer = (buffer + decoder.decode(chunk.value, { stream: true })).replaceAll('\r\n', '\n');
        for (;;) {
          const end = buffer.indexOf('\n\n'); if (end < 0) break;
          const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
          if (!data || data === '[DONE]') continue;
          const event = JSON.parse(data) as Json;
          if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') emit({ type: 'text_delta', delta: event.delta });
          if (event.type === 'response.reasoning_summary_text.delta' && typeof event.delta === 'string') emit({ type: 'thinking_delta', delta: event.delta });
          if (event.type === 'error' || event.type === 'response.failed' || event.type === 'response.incomplete') throw new Error('company_provider_failed');
          if (event.type === 'response.completed' && event.response && typeof event.response === 'object') completed = event.response as Json;
        }
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    if (!completed || !Array.isArray(completed.output)) throw new Error('company_response_incomplete');
    const output = completed.output as Json[];
    const reported = completed.usage as Json | undefined;
    if (reported) for (const [wire, key] of [['input_tokens', 'inputTokens'], ['output_tokens', 'outputTokens']] as const) {
      const value = reported[wire]; if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) usage[key] += value;
    }
    history.push(...output);
    const calls = output.filter((item) => item.type === 'function_call');
    if (calls.length === 0) return { ok: true, input: history, files: [...files], usage, media };
    if (calls.length > 12) throw new Error('company_tool_limit');
    for (const call of calls) {
      check();
      if (typeof call.call_id !== 'string' || typeof call.name !== 'string' || typeof call.arguments !== 'string') throw new Error('company_invalid_tool');
      let result: unknown; let failed = false; let startupFailed = false; let planPublished = false;
      try {
        const args = JSON.parse(call.arguments) as Json;
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('invalid tool arguments');
        if (call.name !== 'update_plan') emit({ type: 'tool_use', id: call.call_id, name: call.name,
          input: { ...(typeof args.path === 'string' ? { file_path: args.path } : {}),
            ...(typeof args.destination === 'string' ? { destination: args.destination } : {}) } });
        if (call.name === 'update_plan') {
          if (Object.keys(args).some((key) => key !== 'todos') || !Array.isArray(args.todos) || args.todos.length > 32
            || Buffer.byteLength(JSON.stringify(args)) > 8 * 1024 || args.todos.some((item: unknown) => {
              if (!item || typeof item !== 'object' || Array.isArray(item)) return true;
              const todo = item as Json;
              return Object.keys(todo).some((key) => !['content', 'status'].includes(key)) || typeof todo.content !== 'string'
                || !todo.content.trim() || todo.content.length > 200 || /[\u0000-\u0008\u000b-\u001f]/u.test(todo.content)
                || !['pending', 'in_progress', 'completed'].includes(String(todo.status));
            })) throw new Error('invalid plan');
          // Only accepted snapshots carry the canonical name: a refused update
          // must not clear the last valid plan or its unfinished-work verdict.
          emit({ type: 'tool_use', id: call.call_id, name: 'update_plan', input: { todos: args.todos } });
          planPublished = true;
          result = { updated: args.todos.length };
        } else if (input.liveArtifacts && STUDIO_LIVE_ARTIFACT_TOOLS.some((tool) => tool.name === call.name)) {
          check(); result = input.liveArtifacts.execute(call.name, args);
        } else if (input.media && STUDIO_MEDIA_TOOL_NAMES.has(call.name)) {
          check();
          try {
            result = await runStudioMediaTool(call.name, args, { apiKey: input.apiKey, fetch: input.fetch ?? fetch, signal,
              projectsRoot: input.projectsRoot, projectId: input.projectId, check, usage: media });
            files.add((result as { saved: string }).saved);
          } catch (error) {
            check();
            if (!(error instanceof StudioMediaError)) throw error;
            failed = true; result = { error: error.code };
          }
        } else if (call.name === 'list_skill_files' && Object.keys(args).length === 0) {
          result = (input.skillPackages ?? []).map((resource) => ({ skillId: resource.id,
            files: resource.files.map((file) => ({ path: file.path, bytes: Buffer.byteLength(file.data, 'base64'), sha256: file.sha256 })) }));
        } else if (call.name === 'read_skill_file' && typeof args.skillId === 'string' && safePath(args.path)
          && Object.keys(args).every((key) => ['skillId', 'path'].includes(key))) {
          const file = input.skillPackages?.find((resource) => resource.id === args.skillId)?.files.find((entry) => entry.path === args.path);
          if (!file || Buffer.byteLength(file.data, 'base64') > FILE_BYTES_LIMIT) throw new Error('skill resource refused');
          result = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(file.data, 'base64'));
        } else if (call.name === 'copy_skill_file' && typeof args.skillId === 'string' && safePath(args.path) && safePath(args.destination)
          && Object.keys(args).every((key) => ['skillId', 'path', 'destination'].includes(key))) {
          const file = input.skillPackages?.find((resource) => resource.id === args.skillId)?.files.find((entry) => entry.path === args.path);
          if (!file) throw new Error('skill resource refused');
          check(); writeCompanyProjectBytes(input.projectsRoot, input.projectId, args.destination, Buffer.from(file.data, 'base64'));
          files.add(args.destination); result = { copied: args.destination };
        } else if (call.name === 'run_skill_script' && input.runSkillScript && typeof args.skillId === 'string' && safePath(args.path)
          && Array.isArray(args.args) && Object.keys(args).every((key) => ['skillId', 'path', 'args'].includes(key))) {
          check();
          const script = await input.runSkillScript({ skillId: args.skillId, path: args.path, args: args.args as string[], signal });
          result = script; failed = script.exitCode !== 0; startupFailed = script.exitCode === null && !script.timedOut;
        } else if (call.name === 'list_project_files' && Object.keys(args).length === 0) {
          result = listCompanyProjectFiles(input.projectsRoot, input.projectId);
        } else if (call.name === 'read_project_file' && safePath(args.path) && Object.keys(args).every((key) => key === 'path')) {
          check(); result = readCompanyProjectFile(input.projectsRoot, input.projectId, args.path);
        } else if (call.name === 'write_project_file' && safePath(args.path) && typeof args.content === 'string'
          && Buffer.byteLength(args.content) <= FILE_BYTES_LIMIT && Object.keys(args).every((key) => ['path', 'content'].includes(key))) {
          check(); writeCompanyProjectFile(input.projectsRoot, input.projectId, args.path, args.content);
          files.add(args.path); result = { written: args.path };
        } else throw new Error('unsupported tool');
        check();
      } catch (error) {
        check(); failed = true;
        // Validation refusals and a command's nonzero exit are not startup failures.
        startupFailed = call.name === 'run_skill_script' && ['ENOENT', 'EACCES', 'EPERM', 'ENOEXEC'].includes(String((error as NodeJS.ErrnoException | null)?.code)); result = { error: 'PROJECT_TOOL_REFUSED' };
        if (call.name === 'update_plan' && !planPublished) emit({ type: 'tool_use', id: call.call_id, name: 'plan_update_refused', input: {} });
      }
      emit({ type: 'tool_result', toolUseId: call.call_id, isError: failed, ...(startupFailed ? { startupFailed: true } : {}), content: typeof result === 'string' ? result : JSON.stringify(result) });
      history.push({ type: 'function_call_output', call_id: call.call_id, output: typeof result === 'string' ? result : JSON.stringify(result) });
    }
  }
  throw new Error('company_step_limit');
}
