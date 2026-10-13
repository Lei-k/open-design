import type Database from 'better-sqlite3';
import { emittedRenderableQuestionForm, isStudioOrderedPipeline,
  type PluginPipeline, type PluginPipelineStageEvent, type StudioPipelineProgress } from '@open-design/contracts';
import { recordIteration } from '../plugins/pipeline.js';
import { studioDevloop } from '../plugins/studio-devloop.js';
import { evaluateUntil } from '../plugins/until.js';
import { renderStudioPipelineStagePrompt } from '../prompts/studio-pipeline.js';

type Snapshot = { snapshotId: string; pipeline?: PluginPipeline };
type Result<T> = { value: T; ok: boolean; text: string; tokensUsed?: number };

/** Stage order, bounded iteration, authority, question cursor and timeline
 * belong to the daemon. Workers retain the turn's pinned source and bill. */
export async function runStudioPipeline<T>(input: {
  db: Database.Database; runId: string; snapshot: Snapshot | null;
  resumeStage?: unknown; resumeIteration?: unknown;
  check(): void;
  emit(event: PluginPipelineStageEvent): void;
  runStage(directive: string, onText?: (text: string) => void): Promise<Result<T>>;
  /** A daemon Jury result, never a provider-claimed score or client signal. */
  runCritique?(directive: string, cursor: { stageIndex: number; iteration: number }): Promise<Result<T> & { score?: number }>;
}): Promise<{ value: T; progress?: StudioPipelineProgress }> {
  input.check();
  const pipeline = input.snapshot?.pipeline;
  if (pipeline === undefined || (isStudioOrderedPipeline(pipeline) && pipeline.stages.length === 0)) {
    if (input.resumeStage !== undefined || input.resumeIteration !== undefined) throw new Error('studio_pipeline_cursor_invalid');
    const result = await input.runStage('');
    input.check();
    return { value: result.value };
  }
  if (!isStudioOrderedPipeline(pipeline)) throw new Error('studio_pipeline_invalid');
  const loops = pipeline.stages.map(studioDevloop);
  if (loops.some((loop) => loop.reasons.length) || pipeline.stages.some((stage) => stage.atoms.includes('critique-theater')) && !input.runCritique) {
    throw new Error('studio_pipeline_invalid');
  }
  const start = input.resumeStage ?? 0;
  const firstIteration = input.resumeIteration ?? 0;
  if (!Number.isInteger(start) || (start as number) < 0 || (start as number) >= pipeline.stages.length
    || !Number.isInteger(firstIteration) || (firstIteration as number) < 0 || (firstIteration as number) >= loops[start as number]!.max) {
    throw new Error('studio_pipeline_cursor_invalid');
  }
  const snapshotId = input.snapshot!.snapshotId;
  for (let index = start as number; index < pipeline.stages.length; index++) {
    const stage = pipeline.stages[index]!;
    const loop = loops[index]!;
    const edge = { runId: input.runId, snapshotId, stageId: stage.id,
      ...(stage.repeat ? { maxIterations: loop.max } : {}) };
    for (let iteration = index === start ? firstIteration as number : 0; iteration < loop.max; iteration++) {
      input.check();
      input.emit({ kind: 'pipeline_stage_started', ...edge, iteration, startedAt: Date.now() });
      input.check();
      const workAtoms = stage.atoms.filter((atom) => atom !== 'critique-theater');
      const directive = renderStudioPipelineStagePrompt(stage, index, pipeline.stages.length)
        + (stage.repeat ? `\nCurrent iteration: ${iteration + 1} / ${loop.max}.\n` : '');
      let result: Result<T> & { score?: number };
      let tokensUsed: number | undefined;
      if (workAtoms.length || !stage.atoms.includes('critique-theater')) {
        result = await input.runStage(renderStudioPipelineStagePrompt({ ...stage, atoms: workAtoms }, index, pipeline.stages.length)
          + (stage.repeat ? `\nCurrent iteration: ${iteration + 1} / ${loop.max}.\n` : ''));
        input.check();
        const awaitingInput = result.ok && emittedRenderableQuestionForm(result.text);
        if (!result.ok || awaitingInput) return { value: result.value, progress: {
          snapshotId, stageIndex: index, stageCount: pipeline.stages.length, awaitingInput,
          ...(stage.repeat ? { iteration } : {}),
        } };
        tokensUsed = result.tokensUsed;
      }
      if (stage.atoms.includes('critique-theater')) {
        input.check();
        result = await input.runCritique!(directive, { stageIndex: index, iteration });
        input.check();
        const awaitingInput = result.ok && emittedRenderableQuestionForm(result.text);
        if (!result.ok || awaitingInput) return { value: result.value, progress: { snapshotId, stageIndex: index,
          stageCount: pipeline.stages.length, awaitingInput, ...(stage.repeat ? { iteration } : {}) } };
        if (result.tokensUsed !== undefined) tokensUsed = (tokensUsed ?? 0) + result.tokensUsed;
      }
      // Every path above ran at least one worker. Only Jury can supply score.
      const settled = result!;
      const score = stage.atoms.includes('critique-theater') ? settled.score : undefined;
      const converged = !stage.repeat || evaluateUntil(loop.expression!, {
        iterations: iteration + 1, ...(score === undefined ? {} : { 'critique.score': score }),
      }).satisfied;
      recordIteration(input.db, { runId: input.runId, stageId: stage.id, iteration: iteration + 1,
        artifactDiffSummary: null, critiqueSummary: score === undefined ? null : JSON.stringify({ score }), tokensUsed: tokensUsed ?? null });
      input.emit({ kind: 'pipeline_stage_completed', ...edge, iteration, completedAt: Date.now(), converged,
        ...(score === undefined ? {} : { critiqueScore: score }) });
      if (converged) {
        if (index === pipeline.stages.length - 1) return { value: settled.value, progress: {
          snapshotId, stageIndex: pipeline.stages.length, stageCount: pipeline.stages.length, awaitingInput: false,
        } };
        break;
      }
    }
  }
  throw new Error('studio_pipeline_cursor_invalid');
}
