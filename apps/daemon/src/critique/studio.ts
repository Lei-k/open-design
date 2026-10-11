import path from 'node:path';
import { mkdir, realpath } from 'node:fs/promises';
import type Database from 'better-sqlite3';
import { defaultCritiqueConfig, type CritiqueSseEvent } from '@open-design/contracts/critique';
import { renderPanelPrompt } from '../prompts/panel.js';
import { listCompanyProjectFiles, readCompanyProjectFile } from '../services/company-project-files.js';
import { runOrchestrator } from './orchestrator.js';

/** Bounded Studio policy, independent from host rollout, adapters and app config. */
export const STUDIO_CRITIQUE_MAX_BYTES = 4 * 1024 * 1024;
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
export function studioCritiqueDirectory(dataRoot: string, owner: string, project: string, run: string): string {
  if (![owner, project, run].every((id) => /^[A-Za-z0-9_-]{1,128}$/.test(id))) throw new Error('critique_identity_invalid');
  return path.join(dataRoot, 'critique-artifacts', 'studio', owner, project, run);
}

/** The ordinary source worker executes the Jury prompt; only its text feeds
 * the existing parser/orchestrator. No host adapter or global provider lookup. */
export async function runStudioCritique<T>(input: {
  db: Database.Database; dataRootCanonical: string; owner: string; projectId: string; conversationId: string; runId: string;
  authorized(): boolean; cancel(): void; emit(event: CritiqueSseEvent): void;
  runStage(directive: string, onText: (text: string) => void): Promise<{ value: T; ok: boolean; text: string }>;
}): Promise<{ value: T; progress?: undefined }> {
  const abort = new AbortController();
  const check = () => { if (!input.authorized()) { abort.abort(); input.cancel(); } };
  check(); abort.signal.throwIfAborted();
  const directory = studioCritiqueDirectory(input.dataRootCanonical, input.owner, input.projectId, input.runId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (await realpath(directory) !== directory || !directory.startsWith(`${input.dataRootCanonical}${path.sep}`)) throw new Error('critique_directory_refused');
  check(); abort.signal.throwIfAborted();
  const cfg = { ...defaultCritiqueConfig(), enabled: true, parserMaxBlockBytes: STUDIO_CRITIQUE_MAX_BYTES };
  const queue: string[] = [];
  let wake: (() => void) | undefined;
  let ended = false; let bytes = 0; let eventBytes = 0;
  const stdout = { async *[Symbol.asyncIterator]() {
    while (!ended || queue.length) {
      if (queue.length) yield queue.shift()!;
      else await new Promise<void>((resolve) => { wake = resolve; });
    }
  } };
  const timer = setInterval(check, 250); timer.unref();
  const orchestration = runOrchestrator({ db: input.db, runId: input.runId, projectId: input.projectId,
    conversationId: input.conversationId, artifactId: input.runId, artifactDir: directory, cfg,
    adapter: 'studio-source', stdout, signal: abort.signal, authorized: input.authorized,
    child: { kill() { input.cancel(); return true; } }, bus: { emit(event) {
      eventBytes += Buffer.byteLength(JSON.stringify(event));
      if (eventBytes > MAX_TRANSCRIPT_BYTES) { abort.abort(); input.cancel(); throw new Error('critique_transcript_limit'); }
      if (input.authorized()) input.emit(event);
    } },
  });
  void orchestration.catch(() => {});
  try {
    const result = await input.runStage(renderPanelPrompt({ cfg,
      brand: { name: 'Project design', design_md: 'Use the design context already captured for this turn.' },
      skill: { id: 'design-jury' } }), (text) => {
      check(); abort.signal.throwIfAborted();
      bytes += Buffer.byteLength(text);
      if (bytes > MAX_TRANSCRIPT_BYTES) { abort.abort(); input.cancel(); throw new Error('critique_output_limit'); }
      queue.push(text); wake?.(); wake = undefined;
    });
    ended = true; wake?.();
    const outcome = await orchestration;
    check(); abort.signal.throwIfAborted();
    if (!result.ok || !['shipped', 'below_threshold'].includes(outcome.status)) throw new Error('critique_not_shipped');
    return { value: result.value };
  } finally {
    ended = true; wake?.(); abort.abort(); clearInterval(timer);
    await orchestration;
  }
}

/** Codex Jury exposes only bounded project reads through daemon authority. */
export function studioCritiqueProjectTools(projectsRoot: string, projectId: string, authorized: () => boolean) {
  const tools = [
    { name: 'list_project_files', description: 'List this project context.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
    { name: 'read_project_file', description: 'Read one UTF-8 project context file.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } },
  ];
  return { tools, execute(name: string, args: Record<string, unknown>) {
    if (!authorized()) throw new Error('critique_authority_changed');
    if (name === 'list_project_files' && Object.keys(args).length === 0) return listCompanyProjectFiles(projectsRoot, projectId);
    if (name === 'read_project_file' && Object.keys(args).length === 1 && typeof args.path === 'string') return readCompanyProjectFile(projectsRoot, projectId, args.path);
    throw new Error('critique_tool_refused');
  } };
}
