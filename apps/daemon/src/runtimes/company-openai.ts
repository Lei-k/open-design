import { EventEmitter } from 'node:events';
import { listCompanyProjectFiles, readCompanyProjectFile, writeCompanyProjectFile } from '../services/company-project-files.js';

type Json = Record<string, unknown>;
const RESPONSE_BYTES_LIMIT = 4 * 1024 * 1024;
const FILE_BYTES_LIMIT = 1024 * 1024;
const MAX_REQUESTS = 12;
const tools = [
  { name: 'list_project_files', description: 'List files in the current project.', properties: {}, required: [] },
  { name: 'read_project_file', description: 'Read a UTF-8 text file in the current project.', properties: { path: { type: 'string' } }, required: ['path'] },
  { name: 'write_project_file', description: 'Create or replace a UTF-8 text file in the current project. Use HTML with inline assets for browser designs.',
    properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
].map(({ properties, required, ...tool }) => ({ ...tool, type: 'function', strict: true,
  parameters: { type: 'object', properties, required, additionalProperties: false } }));

export interface CompanyOpenAITurnResult { ok: boolean; input: Json[]; files: string[]; usage: { inputTokens: number; outputTokens: number } }

/** Same lifecycle the scheduler uses for native children, without giving an
 * agent process the company API key. The daemon executes only bounded,
 * project-scoped file functions; there is no host shell or client endpoint. */
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
  authorized: () => boolean; onAgentEvent: (event: Json) => void;
  fetch?: typeof fetch;
}): Promise<CompanyOpenAITurnResult> {
  const signal = AbortSignal.any([input.worker.abort.signal, AbortSignal.timeout(10 * 60_000)]);
  const check = () => { signal.throwIfAborted(); if (!input.authorized()) throw new Error('company_authority_changed'); };
  const history: Json[] = [...(input.systemPrompt ? [{ role: 'developer', content: input.systemPrompt }] : []),
    ...input.history.filter((item) => item.role !== 'developer'), { role: 'user', content: input.prompt }];
  const files = new Set<string>(); const usage = { inputTokens: 0, outputTokens: 0 };
  const emit = (event: Json) => { check(); input.onAgentEvent(event); };
  const safePath = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 1024
    && !value.includes('\0') && !value.startsWith('/') && !value.includes('\\') && !value.split('/').some((part) => !part || part === '..');
  for (let count = 0; count < MAX_REQUESTS; count++) {
    check();
    if (Buffer.byteLength(JSON.stringify(history)) > RESPONSE_BYTES_LIMIT) throw new Error('company_history_limit');
    const response = await (input.fetch ?? fetch)('https://api.openai.com/v1/responses', {
      method: 'POST', signal, redirect: 'error', headers: { authorization: `Bearer ${input.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: input.model, store: false, stream: true, input: history,
        include: ['reasoning.encrypted_content'], max_output_tokens: 8192, tools, parallel_tool_calls: false }),
    });
    check();
    if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
      await response.body?.cancel(); throw new Error('company_provider_failed');
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
    if (calls.length === 0) return { ok: true, input: history, files: [...files], usage };
    if (calls.length > 12) throw new Error('company_tool_limit');
    for (const call of calls) {
      check();
      if (typeof call.call_id !== 'string' || typeof call.name !== 'string' || typeof call.arguments !== 'string') throw new Error('company_invalid_tool');
      let result: unknown; let failed = false;
      try {
        const args = JSON.parse(call.arguments) as Json;
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('invalid tool arguments');
        emit({ type: 'tool_use', id: call.call_id, name: call.name,
          input: { ...(typeof args.path === 'string' ? { file_path: args.path } : {}) } });
        if (call.name === 'list_project_files' && Object.keys(args).length === 0) {
          result = listCompanyProjectFiles(input.projectsRoot, input.projectId);
        } else if (call.name === 'read_project_file' && safePath(args.path) && Object.keys(args).every((key) => key === 'path')) {
          check(); result = readCompanyProjectFile(input.projectsRoot, input.projectId, args.path);
        } else if (call.name === 'write_project_file' && safePath(args.path) && typeof args.content === 'string'
          && Buffer.byteLength(args.content) <= FILE_BYTES_LIMIT && Object.keys(args).every((key) => ['path', 'content'].includes(key))) {
          check(); writeCompanyProjectFile(input.projectsRoot, input.projectId, args.path, args.content);
          files.add(args.path); result = { written: args.path };
        } else throw new Error('unsupported tool');
        check();
      } catch { check(); failed = true; result = { error: 'PROJECT_TOOL_REFUSED' }; }
      emit({ type: 'tool_result', toolUseId: call.call_id, isError: failed, content: typeof result === 'string' ? result : JSON.stringify(result) });
      history.push({ type: 'function_call_output', call_id: call.call_id, output: typeof result === 'string' ? result : JSON.stringify(result) });
    }
  }
  throw new Error('company_step_limit');
}
