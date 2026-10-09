// S41 (#61): Web plugin availability is computed from one capability
// registry evaluated against what a plugin declares (effective pipeline,
// atoms, strategy, capabilities, context). Nothing is keyed by plugin id, so
// a capability landing on Web makes more plugins applicable with no
// per-plugin edit, and an unknown or malformed declaration fails closed.
//
// Review repair (F1): Studio turns do not run pipeline stages (no stage
// runner, no active-stage rendering), so any pipeline apply would run,
// declared or scenario fallback, repeating or not, is unavailable with the
// typed `pipeline` reason even when every atom in it runs on Web.
import { describe, expect, it } from 'vitest';
import type { InstalledPluginRecord, StudioWebPluginCapabilities } from '@open-design/contracts';
import { STUDIO_WEB_PLUGIN_CAPABILITIES } from '@open-design/contracts';
import { evaluateStudioPluginAvailability, studioPluginReasonSummary } from '../src/plugins/studio-availability.js';

function record(od: Record<string, unknown>, extra: Partial<InstalledPluginRecord> = {}): InstalledPluginRecord {
  return {
    id: 'fixture', title: 'Fixture', version: '1.0.0', sourceKind: 'bundled', source: '/host/plugins/fixture', trust: 'bundled',
    capabilitiesGranted: [], fsPath: '/host/plugins/fixture', installedAt: 0, updatedAt: 0,
    manifest: { name: 'fixture', version: '1.0.0', od } as InstalledPluginRecord['manifest'], ...extra,
  };
}
const scenarios = [{ id: 'od-new-generation', taskKind: 'new-generation' as const, pipeline: { stages: [
  { id: 'discovery', atoms: ['discovery-question-form'] }, { id: 'plan', atoms: ['todo-write'] },
  { id: 'generate', atoms: ['file-write', 'live-artifact'] },
  { id: 'critique', atoms: ['critique-theater'], repeat: true, until: 'critique.score>=4' }] } }];

describe('evaluateStudioPluginAvailability', () => {
  it('admits a plugin whose every declaration runs in Studio turns: no pipeline, its own SKILL.md, Web capabilities', () => {
    expect(evaluateStudioPluginAvailability(record({ kind: 'scenario', mode: 'scenario', capabilities: ['prompt:inject', 'fs:read', 'fs:write'],
      context: { skills: [{ path: './SKILL.md' }], atoms: ['file-read'] } }), scenarios))
      .toEqual({ applicable: true, reasons: [] });
  });

  it('refuses any pipeline Studio turns would have to run, even when every atom in it runs on Web', () => {
    // Non-repeating stages of allowed atoms: the stages themselves are not executed by Studio turns.
    expect(evaluateStudioPluginAvailability(record({ kind: 'scenario', mode: 'scenario', capabilities: ['prompt:inject', 'fs:read', 'fs:write'],
      context: { skills: [{ path: './SKILL.md' }] },
      pipeline: { stages: [{ id: 'inspect', atoms: ['file-read'] }, { id: 'package', atoms: ['file-write'] }] } }), scenarios))
      .toEqual({ applicable: false, reasons: [{ code: 'pipeline' }] });
    // A pipeline inherited from the scenario fallback counts the same way.
    const fallback = evaluateStudioPluginAvailability(record({ kind: 'atom', capabilities: ['prompt:inject'] }), scenarios);
    expect(fallback.reasons).toEqual(expect.arrayContaining([{ code: 'pipeline' }]));
    // An empty declared pipeline declares no stage.
    expect(evaluateStudioPluginAvailability(record({ kind: 'scenario', pipeline: { stages: [] } }), scenarios))
      .toEqual({ applicable: true, reasons: [] });
  });

  it('evaluates the pipeline apply would run, including the scenario fallback and the core quality stages', () => {
    // A generate-only template gains plan + critique at apply; both are evaluated.
    const template = evaluateStudioPluginAvailability(record({ kind: 'scenario', mode: 'prototype', capabilities: ['prompt:inject', 'fs:write'],
      pipeline: { stages: [{ id: 'generate', atoms: ['file-write', 'live-artifact'] }] } }), scenarios);
    expect(template.applicable).toBe(false);
    expect(template.reasons).toEqual([
      { code: 'atom', subject: 'critique-theater' }, { code: 'atom', subject: 'live-artifact' },
      { code: 'atom', subject: 'todo-write' }, { code: 'pipeline' }, { code: 'pipeline-devloop', subject: 'critique' }]);
    // An atom without a pipeline inherits the bundled scenario's.
    const atom = evaluateStudioPluginAvailability(record({ kind: 'atom', capabilities: ['prompt:inject'] }), scenarios);
    expect(atom.reasons).toEqual(expect.arrayContaining([{ code: 'atom', subject: 'live-artifact' }, { code: 'pipeline-devloop', subject: 'critique' }]));
  });

  it('fails closed on unknown atoms, host capabilities, strategies, GenUI, connectors, MCP, context it cannot capture and malformed declarations', () => {
    const reasonsOf = (od: Record<string, unknown>) => evaluateStudioPluginAvailability(record({ kind: 'scenario', mode: 'image', ...od }), scenarios).reasons;
    expect(reasonsOf({ pipeline: { stages: [{ id: 'generate', atoms: ['image-generate'] }] } })).toEqual([{ code: 'pipeline' }, { code: 'unknown-atom', subject: 'image-generate' }]);
    expect(reasonsOf({ capabilities: ['prompt:inject', 'subprocess', 'network'] })).toEqual([
      { code: 'capability', subject: 'network' }, { code: 'capability', subject: 'subprocess' }]);
    expect(reasonsOf({ strategy: { schema: 'open-design.bundled-strategy/v2' } })).toEqual([{ code: 'strategy' }]);
    expect(reasonsOf({ genui: { surfaces: [{ id: 'confirm', kind: 'confirmation', persist: 'run' }] } })).toEqual([{ code: 'genui', subject: 'confirm' }]);
    expect(reasonsOf({ connectors: { required: [{ id: 'notion', tools: [] }] } })).toEqual([{ code: 'connector', subject: 'notion' }]);
    expect(reasonsOf({ context: { mcp: [{ name: 'figma', command: 'npx' }] } })).toEqual([{ code: 'mcp', subject: 'figma' }]);
    expect(reasonsOf({ context: { assets: ['./a.png'], craft: ['typography'], skills: [{ ref: 'some-skill' }], designSystem: { ref: 'linear' } } })).toEqual([
      { code: 'context', subject: 'assets' }, { code: 'context', subject: 'craft' },
      { code: 'context', subject: 'design-system' }, { code: 'context', subject: 'skill-ref' }]);
    expect(reasonsOf({ pipeline: { stages: [{ id: 'generate' }] } })).toEqual([{ code: 'manifest', subject: 'pipeline' }]);
    expect(reasonsOf({ capabilities: 'fs:read' })).toEqual([{ code: 'manifest', subject: 'capabilities' }]);
    expect(evaluateStudioPluginAvailability(record({}, { sourceKind: 'marketplace' }), scenarios).reasons).toEqual([{ code: 'source', subject: 'marketplace' }]);
  });

  it('opens more plugins automatically when a capability lands on Web', () => {
    const template = record({ kind: 'scenario', mode: 'prototype', capabilities: ['prompt:inject', 'fs:write'],
      pipeline: { stages: [{ id: 'generate', atoms: ['file-write', 'live-artifact'] }] } });
    const landed: StudioWebPluginCapabilities = { ...STUDIO_WEB_PLUGIN_CAPABILITIES,
      atoms: [...STUDIO_WEB_PLUGIN_CAPABILITIES.atoms, 'todo-write', 'live-artifact', 'critique-theater'], pipelines: true, pipelineDevloop: true };
    expect(evaluateStudioPluginAvailability(template, scenarios).applicable).toBe(false);
    expect(evaluateStudioPluginAvailability(template, scenarios, landed)).toEqual({ applicable: true, reasons: [] });
    // A stage runner alone opens a plain pipeline of Web atoms; the devloop stays its own capability.
    const plain = record({ kind: 'scenario', capabilities: ['fs:read', 'fs:write'],
      pipeline: { stages: [{ id: 'inspect', atoms: ['file-read'] }, { id: 'package', atoms: ['file-write'] }] } });
    const runner: StudioWebPluginCapabilities = { ...STUDIO_WEB_PLUGIN_CAPABILITIES, pipelines: true };
    expect(evaluateStudioPluginAvailability(plain, scenarios, runner)).toEqual({ applicable: true, reasons: [] });
    expect(evaluateStudioPluginAvailability(template, scenarios, { ...runner, atoms: landed.atoms }).reasons)
      .toEqual([{ code: 'pipeline-devloop', subject: 'critique' }]);
  });

  it('summarizes reasons for reporting', () => {
    const summary = studioPluginReasonSummary([
      { applicable: true, reasons: [] },
      { applicable: false, reasons: [{ code: 'atom', subject: 'live-artifact' }, { code: 'atom', subject: 'critique-theater' }] },
      { applicable: false, reasons: [{ code: 'atom', subject: 'live-artifact' }] },
    ]);
    expect(summary).toEqual({ total: 3, applicable: 1, unavailable: 2, byReason: { 'atom:critique-theater': 1, 'atom:live-artifact': 2 } });
  });
});
