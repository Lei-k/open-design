import type { PipelineStage, StudioPluginUnavailableReason } from '@open-design/contracts';
import { parseUntil, type UntilExpression } from './until.js';

/** Studio spend ceiling. Change this one constant to configure the policy. */
export const STUDIO_DEVLOOP_MAX_ITERATIONS = 8;

/** Reuse the closed until grammar; only an unconditional disjunct proves a bound. */
export function studioDevloop(stage: PipelineStage): {
  expression?: UntilExpression; max: number; reasons: StudioPluginUnavailableReason[];
} {
  if (!stage.repeat && stage.until === undefined) return { max: 1, reasons: [] };
  const reason = (code: StudioPluginUnavailableReason['code'], subject = stage.id) => ({ code, subject });
  if (stage.repeat !== true || !stage.until) return { max: 0, reasons: [reason('pipeline-devloop-unbounded')] };
  let expression: UntilExpression;
  try { expression = parseUntil(stage.until); }
  catch { return { max: 0, reasons: [reason('manifest', 'pipeline.until')] }; }
  const signals = new Set(expression.any.flat().map((term) => term.signal));
  const reasons = [...signals].filter((signal) => signal !== 'iterations' && signal !== 'critique.score')
    .map((signal) => reason('pipeline-devloop-signal', signal));
  // A conjunction with a score/confirmation does not prove termination.
  // Count completed iterations: >7 stops at 8; >=2.5 stops at 3.
  const bounds = expression.any.flatMap((terms) => {
    if (terms.length !== 1) return [];
    const term = terms[0]!;
    if (term.signal !== 'iterations' || typeof term.value !== 'number' || !['>=', '>'].includes(term.op)) return [];
    const bound = Math.max(1, term.op === '>' ? Math.floor(term.value) + 1 : Math.ceil(term.value));
    return term.value <= STUDIO_DEVLOOP_MAX_ITERATIONS && bound <= STUDIO_DEVLOOP_MAX_ITERATIONS ? [bound] : [];
  });
  if (!bounds.length) reasons.push(reason('pipeline-devloop-unbounded'));
  return { expression, max: bounds.length ? Math.min(...bounds) : 0, reasons };
}
