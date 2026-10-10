import type { PipelineStage } from '@open-design/contracts';

/** Per-stage suffix after the pinned Studio prompt, on every provider source. */
export function renderStudioPipelineStagePrompt(stage: PipelineStage, index: number, total: number): string {
  return `\n\n# Current plugin stage (${index + 1}/${total})\n\n`
    + `Stage: ${stage.id}\nAtoms: ${stage.atoms.join(', ')}\n`
    + 'Perform only this stage of the captured plugin for the user request. Earlier stages are in the conversation; later stages are scheduled by the daemon. '
    + 'Use the captured plugin instructions to carry out these atoms. Do not execute later stages. '
    + 'If user input is needed, emit a question form and stop; the daemon will resume this stage after the answer. '
    + 'Otherwise finish with a concise account of this stage’s result.\n';
}
