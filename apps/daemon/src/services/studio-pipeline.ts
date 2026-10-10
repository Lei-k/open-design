import type Database from 'better-sqlite3';
import { emittedRenderableQuestionForm, isStudioOrderedPipeline,
  type PluginPipeline, type PluginPipelineStageEvent, type StudioPipelineProgress } from '@open-design/contracts';
import { recordIteration } from '../plugins/pipeline.js';
import { renderStudioPipelineStagePrompt } from '../prompts/studio-pipeline.js';

type Snapshot = { snapshotId: string; pipeline?: PluginPipeline };

/**
 * Studio's finite stage worker boundary. The desktop devloop/GenUI wrapper
 * is deliberately separate: it reads host-global surfaces Studio cannot use.
 * Provider work is injected, but stage order, authority, pause-on-question and
 * the durable timeline are owned here, identically on all three sources.
 */
export async function runStudioPipeline<T>(input: {
  db: Database.Database; runId: string; snapshot: Snapshot | null;
  resumeStage?: unknown;
  check(): void;
  emit(event: PluginPipelineStageEvent): void;
  runStage(directive: string): Promise<{ value: T; ok: boolean; text: string; tokensUsed?: number }>;
}): Promise<{ value: T; progress?: StudioPipelineProgress }> {
  input.check();
  const pipeline = input.snapshot?.pipeline;
  if (pipeline === undefined || (isStudioOrderedPipeline(pipeline) && pipeline.stages.length === 0)) {
    const result = await input.runStage('');
    input.check();
    return { value: result.value };
  }
  if (!isStudioOrderedPipeline(pipeline)) throw new Error('studio_pipeline_invalid');
  const start = input.resumeStage ?? 0;
  if (!Number.isInteger(start) || (start as number) < 0 || (start as number) >= pipeline.stages.length) {
    throw new Error('studio_pipeline_cursor_invalid');
  }
  const snapshotId = input.snapshot!.snapshotId;
  for (let index = start as number; index < pipeline.stages.length; index++) {
    input.check();
    const stage = pipeline.stages[index]!;
    input.emit({ kind: 'pipeline_stage_started', runId: input.runId, snapshotId, stageId: stage.id, iteration: 0, startedAt: Date.now() });
    input.check();
    const result = await input.runStage(renderStudioPipelineStagePrompt(stage, index, pipeline.stages.length));
    input.check();
    const awaitingInput = result.ok && emittedRenderableQuestionForm(result.text);
    if (!result.ok || awaitingInput) {
      return { value: result.value, progress: { snapshotId, stageIndex: index, stageCount: pipeline.stages.length, awaitingInput } };
    }
    // Reuse the sole audit writer; this table contains no host credentials or
    // content. Studio reads continue through owner-scoped run/event APIs.
    recordIteration(input.db, { runId: input.runId, stageId: stage.id, iteration: 1,
      artifactDiffSummary: null, critiqueSummary: null, tokensUsed: result.tokensUsed ?? null });
    input.emit({ kind: 'pipeline_stage_completed', runId: input.runId, snapshotId, stageId: stage.id,
      iteration: 0, completedAt: Date.now(), converged: true });
    if (index === pipeline.stages.length - 1) {
      return { value: result.value, progress: { snapshotId, stageIndex: pipeline.stages.length,
        stageCount: pipeline.stages.length, awaitingInput: false } };
    }
  }
  throw new Error('studio_pipeline_cursor_invalid');
}
