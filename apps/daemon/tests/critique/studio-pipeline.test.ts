import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { PluginPipelineStageEvent } from '@open-design/contracts';
import { runStudioPipeline } from '../../src/services/studio-pipeline.js';
import { runStudioPipelineCritique } from '../../src/critique/studio.js';
import { migrateCritique } from '../../src/critique/persistence.js';
import { runCompanyOpenAITurn, CompanyOpenAIWorker } from '../../src/runtimes/company-openai.js';
import { syntheticGoodTranscript } from '../../src/critique/__fixtures__/adapters/synthetic-good.js';

let db: Database.Database; let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 's70-jury-')));
  mkdirSync(path.join(root, 'project'));
  db = new Database(':memory:');
  db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY); CREATE TABLE conversations (id TEXT PRIMARY KEY); INSERT INTO projects VALUES ('project'); INSERT INTO conversations VALUES ('conversation');");
  migrateCritique(db);
  db.exec(`CREATE TABLE run_devloop_iterations (id TEXT, run_id TEXT, stage_id TEXT, iteration INTEGER,
    artifact_diff_summary TEXT, critique_summary TEXT, tokens_used INTEGER, ended_at INTEGER)`);
});
afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

it.each(['company-openai', 'account-openai'])('uses the S66 daemon score, read-only tools and the pinned bill on %s', async (source) => {
  const requests: Array<{ key: string; tools: string[] }> = [];
  const usage = { inputTokens: 0, outputTokens: 0 };
  const events: PluginPipelineStageEvent[] = [];
  const worker = new CompanyOpenAIWorker();
  const fetcher: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    requests.push({ key: new Headers(init?.headers).get('authorization')!, tools: body.tools.map((tool: { name: string }) => tool.name) });
    // First iteration scores below 4/5, second passes. No provider-claimed
    // composite/SHIP score is trusted: the S66 scoreboard computes it.
    const text = requests.length === 1 ? syntheticGoodTranscript().replace(/score="[\d.]+"/g, 'score="2"') : syntheticGoodTranscript();
    const frames = [{ type: 'response.output_text.delta', delta: text }, { type: 'response.completed', response: {
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 17, output_tokens: 23 } } }];
    return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    const result = await runStudioPipeline({ db, runId: 'parent', snapshot: { snapshotId: 'pin', pipeline: { stages: [
      { id: 'critique', atoms: ['critique-theater'], repeat: true, until: 'critique.score>=4 || iterations>=3' }] } },
      check() {}, emit: (event) => events.push(event), runStage: async () => { throw new Error('Jury must run the Jury worker'); },
      runCritique: (directive, cursor) => runStudioPipelineCritique({ db, dataRootCanonical: root,
        owner: 'owner', projectId: 'project', conversationId: 'conversation', runId: 'parent', authorized: () => true,
        cancel: () => worker.kill('SIGTERM'), emit: () => { throw new Error('raw Jury frames must stay private'); },
        runStage: async (panel, onText) => {
          let text = '';
          const value = await runCompanyOpenAITurn({ apiKey: `fixture-${source}`, model: 'fixture-model',
            prompt: panel + directive, history: [], projectsRoot: root, projectId: 'project', worker, authorized: () => true,
            projectReadOnly: true, fetch: fetcher, onAgentEvent: (event) => {
              if (event.type === 'text_delta' && typeof event.delta === 'string') { text += event.delta; onText(event.delta); }
            } });
          usage.inputTokens += value.usage.inputTokens; usage.outputTokens += value.usage.outputTokens;
          return { value, ok: value.ok, text, tokensUsed: value.usage.inputTokens + value.usage.outputTokens };
        },
      }, cursor),
    });
    expect(result.progress?.stageIndex).toBe(1);
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.key === `Bearer fixture-${source}`)).toBe(true);
    expect(requests.every((request) => request.tools.includes('read_project_file') && !request.tools.includes('write_project_file') && !request.tools.includes('generate_image'))).toBe(true);
    expect(usage).toEqual({ inputTokens: 34, outputTokens: 46 });
    const completed = events.filter((event) => event.kind === 'pipeline_stage_completed');
    expect(completed.map((event) => event.converged)).toEqual([false, true]);
    expect(completed[0]!.critiqueScore).toBe(1);
    expect(completed[1]!.critiqueScore).toBeGreaterThanOrEqual(4);
    expect(completed[1]!.critiqueScore).toBeLessThanOrEqual(5);
    expect(db.prepare('SELECT tokens_used FROM run_devloop_iterations ORDER BY rowid').all()).toEqual([{ tokens_used: 40 }, { tokens_used: 40 }]);
    expect(db.prepare('SELECT * FROM critique_runs').all()).toEqual([]);
  } finally { worker.close(true); }
});

it('aborts a failed Jury iteration before recording completion or scheduling another worker', async () => {
  let calls = 0; const events: PluginPipelineStageEvent[] = [];
  await expect(runStudioPipeline({ db, runId: 'parent', snapshot: { snapshotId: 'pin', pipeline: { stages: [
    { id: 'critique', atoms: ['critique-theater'], repeat: true, until: 'iterations>=3' }, { id: 'publish', atoms: ['file-write'] }] } },
    check() {}, emit: (event) => events.push(event), runStage: async () => { throw new Error('must not publish'); },
    runCritique: (_directive, cursor) => runStudioPipelineCritique({ db, dataRootCanonical: root, owner: 'owner',
      projectId: 'project', conversationId: 'conversation', runId: 'parent', authorized: () => true, cancel() {}, emit() {},
      runStage: async (_panel, onText) => { calls++; onText('malformed Jury output'); return { value: 'bad', ok: true, text: 'malformed Jury output' }; },
    }, cursor),
  })).rejects.toThrow('critique_not_shipped');
  expect(calls).toBe(1); expect(events.map((event) => event.kind)).toEqual(['pipeline_stage_started']);
  expect(db.prepare('SELECT * FROM run_devloop_iterations').all()).toEqual([]);
});


it('pauses a Jury-only iteration on a renderable question and resumes the same iteration', async () => {
  const question = '<question-form id="review" title="Review">{"questions":[{"id":"goal","label":"Goal","type":"text"}]}</question-form>';
  let answer = false; let cancels = 0;
  const runCritique = (directive: string, cursor: { stageIndex: number; iteration: number }) => runStudioPipelineCritique({
    db, dataRootCanonical: root, owner: 'owner', projectId: 'project', conversationId: 'conversation', runId: answer ? 'answer' : 'parent',
    authorized: () => true, cancel: () => { cancels++; }, emit() {}, runStage: async (_panel, onText) => {
      const text = answer ? syntheticGoodTranscript() : question; onText(text); return { value: text, ok: true, text };
    },
  }, cursor);
  const input = { db, runId: 'parent', snapshot: { snapshotId: 'pin', pipeline: { stages: [
    { id: 'critique', atoms: ['critique-theater'], repeat: true, until: 'critique.score>=4 || iterations>=3' }] } },
    check() {}, emit() {}, runStage: async () => { throw new Error('not a normal worker'); }, runCritique };
  const paused = await runStudioPipeline(input);
  expect(paused.progress).toMatchObject({ awaitingInput: true, iteration: 0, stageIndex: 0 });
  expect(db.prepare('SELECT * FROM run_devloop_iterations').all()).toEqual([]);
  expect(cancels).toBe(0);
  answer = true;
  const completed = await runStudioPipeline({ ...input, runId: 'answer', resumeStage: 0, resumeIteration: paused.progress!.iteration });
  expect(completed.progress?.awaitingInput).toBe(false);
  expect(db.prepare('SELECT iteration FROM run_devloop_iterations').all()).toEqual([{ iteration: 1 }]);
});
