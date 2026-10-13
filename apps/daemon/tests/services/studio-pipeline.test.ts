import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PluginPipelineStageEvent, PluginPipeline } from '@open-design/contracts';
import { runStudioPipeline } from '../../src/services/studio-pipeline.js';
import { runCompanyOpenAITurn, CompanyOpenAIWorker } from '../../src/runtimes/company-openai.js';
import { runPersonalCodexTurn } from '../../src/services/personal-codex-accounts.js';
import { daemonAgentPayloadToPersistedAgentEvent } from '../../src/runtimes/chat-run-messages.js';

const pipeline = { stages: [{ id: 'inspect', atoms: ['file-read'] }, { id: 'package', atoms: ['file-write'] }] };
const question = '<question-form id="brief" title="Brief">{"questions":[{"id":"color","label":"Color","type":"text"}]}</question-form>';
let db: Database.Database; let root: string;
beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE run_devloop_iterations (id TEXT, run_id TEXT, stage_id TEXT, iteration INTEGER,
    artifact_diff_summary TEXT, critique_summary TEXT, tokens_used INTEGER, ended_at INTEGER)`);
  root = mkdtempSync(path.join(tmpdir(), 'studio-pipeline-'));
});
afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
function options(extra: Partial<Parameters<typeof runStudioPipeline<string>>[0]> = {}) {
  const events: PluginPipelineStageEvent[] = [];
  const prompts: string[] = [];
  return { events, prompts, input: { db, runId: 'run', snapshot: { snapshotId: 'snapshot', pipeline }, check() {},
    emit: (event: PluginPipelineStageEvent) => events.push(event), runStage: async (directive: string) => {
      prompts.push(directive); return { value: directive, ok: true, text: 'Done' };
    }, ...extra } };
}
it('executes ordered workers, audits only settled stages, and persists typed edges identical to the live payload', async () => {
  const { events, prompts, input } = options();
  const result = await runStudioPipeline(input);
  expect(prompts).toHaveLength(2);
  expect(prompts[0]).toContain('Stage: inspect\nAtoms: file-read');
  expect(prompts[1]).toContain('Stage: package\nAtoms: file-write');
  expect(events.map((event) => [event.kind, event.stageId])).toEqual([
    ['pipeline_stage_started', 'inspect'], ['pipeline_stage_completed', 'inspect'],
    ['pipeline_stage_started', 'package'], ['pipeline_stage_completed', 'package']]);
  expect(events.map((stage) => daemonAgentPayloadToPersistedAgentEvent({ type: 'pipeline_stage', stage }))).toEqual(events);
  expect(db.prepare('SELECT stage_id FROM run_devloop_iterations ORDER BY rowid').all()).toEqual([{ stage_id: 'inspect' }, { stage_id: 'package' }]);
  expect(result.progress).toEqual({ snapshotId: 'snapshot', stageIndex: 2, stageCount: 2, awaitingInput: false });
});
it('stops on a question in a later stage and resumes only that stage', async () => {
  let calls = 0;
  const first = options({ runStage: async () => ({ value: 'answer', ok: true, text: ++calls === 2 ? question : 'Inspected' }) });
  const paused = await runStudioPipeline(first.input);
  expect(paused.progress).toEqual({ snapshotId: 'snapshot', stageIndex: 1, stageCount: 2, awaitingInput: true });
  expect(first.events.filter((event) => event.kind === 'pipeline_stage_completed').map((event) => event.stageId)).toEqual(['inspect']);
  const answer = options({ resumeStage: paused.progress!.stageIndex });
  expect((await runStudioPipeline(answer.input)).progress?.awaitingInput).toBe(false);
  expect(answer.prompts).toHaveLength(1); expect(answer.prompts[0]).toContain('Stage: package');
});
it('never completes a failed stage or advances to another worker', async () => {
  const { events, input } = options({ runStage: async () => ({ value: 'failed', ok: false, text: 'partial' }) });
  expect((await runStudioPipeline(input)).value).toBe('failed');
  expect(events.map((event) => event.kind)).toEqual(['pipeline_stage_started']);
  expect(db.prepare('SELECT * FROM run_devloop_iterations').all()).toEqual([]);
});
it('rechecks authority after provider work before any completion, audit or subsequent worker', async () => {
  let allowed = true;
  const { events, input } = options({ check: () => { if (!allowed) throw new Error('revoked'); },
    runStage: async () => { allowed = false; return { value: 'late', ok: true, text: 'Done' }; } });
  await expect(runStudioPipeline(input)).rejects.toThrow('revoked');
  expect(events).toHaveLength(1);
  expect(db.prepare('SELECT * FROM run_devloop_iterations').all()).toEqual([]);
});
it('does not start a worker if publishing the stage edge synchronously withdraws authority', async () => {
  let allowed = true;
  const { prompts, input } = options({ check: () => { if (!allowed) throw new Error('revoked'); }, emit: () => { allowed = false; } });
  await expect(runStudioPipeline(input)).rejects.toThrow('revoked');
  expect(prompts).toEqual([]);
  expect(db.prepare('SELECT * FROM run_devloop_iterations').all()).toEqual([]);
});
it.each([null, { snapshotId: 'empty', pipeline: { stages: [] } }])('preserves one ordinary provider turn without stage events for %j', async (snapshot) => {
  const { events, prompts, input } = options({ snapshot });
  expect(await runStudioPipeline(input)).toEqual({ value: '' });
  expect(prompts).toEqual(['']); expect(events).toEqual([]);
  expect(db.prepare('SELECT * FROM run_devloop_iterations').all()).toEqual([]);
});
it.each([
  { stages: [{ id: 'loop', atoms: ['file-read'], repeat: true, until: 'critique.score>=4' }] },
  { stages: [{ id: 'inspect', atoms: ['file-read'], onFailure: 'skip' }] },
  { stages: [{ id: 'inspect', atoms: ['file-read'], hiddenCondition: 'skip' }] },
  { stages: [{ id: 'inspect', atoms: ['critique-theater'] }] },
  { stages: [pipeline.stages[0], pipeline.stages[0]] },
])('rejects an unsupported/damaged pipeline before publishing or starting a worker: %j', async (invalid) => {
  const { events, prompts, input } = options({ snapshot: { snapshotId: 'snapshot', pipeline: invalid as PluginPipeline } });
  await expect(runStudioPipeline(input)).rejects.toThrow('studio_pipeline_invalid');
  expect(events).toEqual([]); expect(prompts).toEqual([]);
});
it.each([-1, 2, '1', 0.5])('rejects an invalid daemon cursor %j', async (resumeStage) => {
  const { events, prompts, input } = options({ resumeStage });
  await expect(runStudioPipeline(input)).rejects.toThrow('studio_pipeline_cursor_invalid');
  expect(events).toEqual([]); expect(prompts).toEqual([]);
});

describe('real provider adapters on a finite Studio pipeline (provider fixtures, no sockets)', () => {
  it.each(['company-pool', 'account-key'])('carries prior-stage history and writes through project-scoped tools on %s', async (source) => {
    mkdirSync(path.join(root, 'owner'));
    writeFileSync(path.join(root, 'owner', 'seed.txt'), 'OWNER_SEED');
    let history: Record<string, unknown>[] = [];
    const providerInputs: Array<Record<string, unknown>[]> = [];
    const apiKey = `${source}-fixture-secret`;
    const fetcher: typeof fetch = async (_url, init) => {
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${apiKey}`);
      const body = JSON.parse(String(init?.body));
      providerInputs.push(body.input);
      const prompt = [...body.input].reverse().find((item: Record<string, unknown>) => item.role === 'user').content;
      const inspect = prompt.includes('Stage: inspect');
      const output = body.input.at(-1).type === 'function_call_output' ? [] : [{ type: 'function_call', call_id: inspect ? 'read' : 'write',
        name: inspect ? 'read_project_file' : 'write_project_file', arguments: JSON.stringify(inspect
          ? { path: 'seed.txt' } : { path: 'package.md', content: 'PACKAGED_OWNER_SEED' }) }];
      const frames = [{ type: 'response.output_text.delta', delta: output.length ? '' : inspect ? 'Inspected owner seed.' : 'Packaged.' },
        { type: 'response.completed', response: { output, usage: { input_tokens: 3, output_tokens: 2 } } }];
      return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
    };
    const { input, events } = options();
    let billedTokens = 0;
    const { runCritique: _critique, ...workerInput } = input;
    const result = await runStudioPipeline({ ...workerInput, runStage: async (directive) => {
      let text = '';
      const value = await runCompanyOpenAITurn({ apiKey, model: 'fixture-model', prompt: `Package my work${directive}`,
        history, projectsRoot: root, projectId: 'owner', worker: new CompanyOpenAIWorker(), authorized: () => true,
        fetch: fetcher, onAgentEvent: (event) => { if (event.type === 'text_delta') text += event.delta; } });
      history = value.input;
      billedTokens += value.usage.inputTokens + value.usage.outputTokens;
      return { value, ok: value.ok, text };
    } });
    expect(result.progress?.stageIndex).toBe(2);
    expect(readFileSync(path.join(root, 'owner', 'package.md'), 'utf8')).toBe('PACKAGED_OWNER_SEED');
    expect(providerInputs).toHaveLength(4);
    expect(JSON.stringify(providerInputs[2])).toContain('OWNER_SEED');
    expect(billedTokens).toBe(20);
    expect(JSON.stringify(events)).not.toContain(apiKey);
  });
  const nodeChildRunsJavaScript = (() => {
    try { return execFileSync(process.execPath, ['-p', '40 + 2'], { encoding: 'utf8', timeout: 5000 }).trim() === '42'; }
    catch { return false; }
  })();
  it.skipIf(!nodeChildRunsJavaScript)('executes personal Codex stage workers as separate real app-server processes on the same native thread', async () => {
    const codexHome = path.join(root, 'codex'); const home = path.join(root, 'home'); const cwd = path.join(root, 'project');
    for (const folder of [codexHome, home, cwd]) mkdirSync(folder);
    writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify({ mock: true, email: 'fixture@example.test', planType: 'plus' }));
    writeFileSync(path.join(codexHome, 'mock-control.json'), JSON.stringify({ promptReplyMarkers: ['Stage: inspect', 'Stage: package'] }));
    let thread: string | null = null; const threads: Array<string | null> = [];
    const { input } = options();
    const { runCritique: _critique, ...workerInput } = input;
    const result = await runStudioPipeline({ ...workerInput, runStage: async (directive) => {
      const turn = await runPersonalCodexTurn({ command: [process.execPath, path.resolve('../../mocks/personal-codex-app-server.ts')],
        codexHome, home, temp: home, cwd, dataRoot: root, prompt: `Package${directive}`, resumeThreadId: thread, sandboxMode: 'workspace-write' });
      const value = await turn.done; thread = value.threadId; threads.push(thread);
      return { value, ok: value.ok, text: value.text };
    } });
    expect(result.value).toMatchObject({ ok: true });
    expect(result.progress?.stageIndex).toBe(2);
    expect(threads[0]).toBeTruthy(); expect(threads[1]).toBe(threads[0]);
    expect(result.value.text).toBe('Stage: package');
    expect(JSON.parse(readFileSync(path.join(codexHome, 'mock-turn-evidence.json'), 'utf8')).turnsInThread).toBe(2);
  });
});

// S67: a stage that declares Live Artifact or media atoms names the Studio tools
// that carry them out, never a desktop shell command; other stages are unchanged.
it('names the Studio tools of live-artifact and media atoms in the stage directive', async () => {
  const studioAtoms = { stages: [{ id: 'render', atoms: ['file-write', 'live-artifact', 'media-image', 'media-video', 'media-audio'] },
    { id: 'package', atoms: ['file-write'] }] };
  const { prompts, input } = options({ snapshot: { snapshotId: 'snapshot', pipeline: studioAtoms } });
  await runStudioPipeline(input);
  expect(prompts[0]).toContain('- live-artifact: live_artifacts_create, live_artifacts_list, live_artifacts_read, live_artifacts_update and live_artifacts_refresh');
  expect(prompts[0]).toContain('- media-image: generate_image');
  expect(prompts[0]).toContain('- media-video: generate_video');
  expect(prompts[0]).toContain('- media-audio: generate_speech (speech narration only)');
  expect(prompts[0]).toContain('instead of any desktop shell or `od` command');
  expect(prompts[1]).not.toContain('Studio tools for these atoms');
});

const loop = { stages: [{ id: 'inspect', atoms: ['file-read', 'critique-theater'], repeat: true, until: 'critique.score>=4 || iterations>=3' }] };
it('terminates a bounded loop on this iteration’s Jury score, with durable iteration edges', async () => {
  let calls = 0;
  const { input, events } = options({ snapshot: { snapshotId: 'snapshot', pipeline: loop },
    runCritique: async () => ({ value: 'done', ok: true, text: 'Done', score: ++calls === 2 ? 4.5 : 2 }) });
  await runStudioPipeline(input);
  expect(calls).toBe(2);
  expect(events.map((e) => e.iteration)).toEqual([0, 0, 1, 1]);
  expect(events.filter((e) => e.kind === 'pipeline_stage_completed').map((e) => e.converged)).toEqual([false, true]);
});
it('terminates on the daemon-owned iteration bound and never accepts a provider iteration signal', async () => {
  let calls = 0;
  const { input } = options({ snapshot: { snapshotId: 'snapshot', pipeline: loop },
    runCritique: async () => { calls++; return { value: 'done', ok: true, text: 'Done', score: 1, iterations: 500 }; } });
  await runStudioPipeline(input);
  expect(calls).toBe(3);
  expect(db.prepare('SELECT iteration FROM run_devloop_iterations ORDER BY rowid').all()).toEqual([{ iteration: 1 }, { iteration: 2 }, { iteration: 3 }]);
});
it.each(['canceled', 'revoked'])('prevents the next iteration when %s between completion and next start', async (reason) => {
  let allowed = true; let calls = 0;
  const { input } = options({ snapshot: { snapshotId: 'snapshot', pipeline: loop },
    check: () => { if (!allowed) throw new Error(reason); },
    emit: (event) => { if (event.kind === 'pipeline_stage_completed') allowed = false; },
    runCritique: async () => { calls++; return { value: 'done', ok: true, text: 'Done', score: 1 }; } });
  await expect(runStudioPipeline(input)).rejects.toThrow(reason);
  expect(calls).toBe(1);
});
it('pauses in the second iteration and resumes the daemon-owned iteration without resetting its ceiling', async () => {
  let calls = 0;
  const first = options({ snapshot: { snapshotId: 'snapshot', pipeline: loop },
    runStage: async () => ({ value: 'done', ok: true, text: ++calls === 2 ? question : 'Done' }),
    runCritique: async () => ({ value: 'done', ok: true, text: '', score: 1 }) });
  const paused = await runStudioPipeline(first.input);
  expect(paused.progress).toMatchObject({ stageIndex: 0, iteration: 1, awaitingInput: true });
  const second = options({ snapshot: { snapshotId: 'snapshot', pipeline: loop }, resumeStage: 0, resumeIteration: 1,
    runCritique: async () => ({ value: 'done', ok: true, text: '', score: 1 }) });
  await runStudioPipeline(second.input);
  expect(second.events.map((e) => e.iteration)).toEqual([1, 1, 2, 2]);
});
