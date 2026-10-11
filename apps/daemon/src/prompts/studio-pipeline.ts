import type { PipelineStage } from '@open-design/contracts';

/**
 * The Studio tools that carry out each first-party atom (S67). Captured plugin
 * skills may describe a desktop shell workflow (`od media generate`,
 * `od tools live-artifacts …`); a Studio stage names its own tools instead, so
 * the atom runs through the canonical Studio Live Artifact tools bound to the
 * admitted run and the S34 media functions billed to the turn's own source.
 * Media atoms reach only OpenAI sources; admission refuses them elsewhere.
 */
const STUDIO_ATOM_TOOLS: Readonly<Record<string, string>> = {
  'live-artifact': 'live_artifacts_create, live_artifacts_list, live_artifacts_read, live_artifacts_update and live_artifacts_refresh',
  'media-image': 'generate_image',
  'media-video': 'generate_video',
  'media-audio': 'generate_speech (speech narration only)',
};

/** Per-stage suffix after the pinned Studio prompt, on every provider source. */
export function renderStudioPipelineStagePrompt(stage: PipelineStage, index: number, total: number): string {
  const tools = stage.atoms.filter((atom) => STUDIO_ATOM_TOOLS[atom]).map((atom) => `- ${atom}: ${STUDIO_ATOM_TOOLS[atom]}`);
  return `\n\n# Current plugin stage (${index + 1}/${total})\n\n`
    + `Stage: ${stage.id}\nAtoms: ${stage.atoms.join(', ')}\n`
    + (tools.length ? `Studio tools for these atoms (use them instead of any desktop shell or \`od\` command in the captured skill):\n${tools.join('\n')}\n` : '')
    + 'Perform only this stage of the captured plugin for the user request. Earlier stages are in the conversation; later stages are scheduled by the daemon. '
    + 'Use the captured plugin instructions to carry out these atoms. Do not execute later stages. '
    + 'If user input is needed, emit a question form and stop; the daemon will resume this stage after the answer. '
    + 'Otherwise finish with a concise account of this stage’s result.\n';
}
