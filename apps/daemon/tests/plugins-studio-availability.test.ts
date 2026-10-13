// S41 (#61): Web plugin availability is computed from one capability
// registry evaluated against what a plugin declares (effective pipeline,
// atoms, strategy, capabilities, context). Nothing is keyed by plugin id, so
// a capability landing on Web makes more plugins applicable with no
// per-plugin edit, and an unknown or malformed declaration fails closed.
//
// Keep the disabled-runner controls from S41 (F1), and prove S42 opens finite
// ordered stages only. Devloops and unsupported policies remain refused.
import { describe, expect, it } from 'vitest';
import type { InstalledPluginRecord, StudioWebPluginCapabilities } from '@open-design/contracts';
import { STUDIO_WEB_PLUGIN_CAPABILITIES, studioPluginSourceReasons } from '@open-design/contracts';
import { evaluateStudioPluginAvailability, evaluateStudioPluginRequirements, studioPluginReasonSummary } from '../src/plugins/studio-availability.js';

function record(od: Record<string, unknown>, extra: Partial<InstalledPluginRecord> = {}): InstalledPluginRecord {
  return {
    id: 'fixture', title: 'Fixture', version: '1.0.0', sourceKind: 'bundled', source: '/host/plugins/fixture', trust: 'bundled',
    capabilitiesGranted: [], fsPath: '/host/plugins/fixture', installedAt: 0, updatedAt: 0,
    manifest: { name: 'fixture', version: '1.0.0', od } as InstalledPluginRecord['manifest'], ...extra,
  };
}
const noRunner = { ...STUDIO_WEB_PLUGIN_CAPABILITIES, pipelines: false, pipelineDevloop: false,
  atoms: STUDIO_WEB_PLUGIN_CAPABILITIES.atoms.filter((atom) => atom !== 'critique-theater') };
const scenarios = [{ id: 'od-new-generation', taskKind: 'new-generation' as const, pipeline: { stages: [
  { id: 'discovery', atoms: ['discovery-question-form'] }, { id: 'plan', atoms: ['todo-write'] },
  { id: 'generate', atoms: ['file-write', 'live-artifact'] },
  { id: 'critique', atoms: ['critique-theater'], repeat: true, until: 'critique.score>=4 || iterations>=3' }] } }];

describe('evaluateStudioPluginAvailability', () => {
  it('admits a plugin whose every declaration runs in Studio turns: no pipeline, its own SKILL.md, Web capabilities', () => {
    expect(evaluateStudioPluginAvailability(record({ kind: 'scenario', mode: 'scenario', capabilities: ['prompt:inject', 'fs:read', 'fs:write'],
      context: { skills: [{ path: './SKILL.md' }], atoms: ['file-read'] } }), scenarios, noRunner))
      .toEqual({ applicable: true, reasons: [] });
  });

  it('refuses any pipeline Studio turns would have to run, even when every atom in it runs on Web', () => {
    // Disabling the runner refuses even non-repeating stages of allowed atoms.
    expect(evaluateStudioPluginAvailability(record({ kind: 'scenario', mode: 'scenario', capabilities: ['prompt:inject', 'fs:read', 'fs:write'],
      context: { skills: [{ path: './SKILL.md' }] },
      pipeline: { stages: [{ id: 'inspect', atoms: ['file-read'] }, { id: 'package', atoms: ['file-write'] }] } }), scenarios, noRunner))
      .toEqual({ applicable: false, reasons: [{ code: 'pipeline' }] });
    // A pipeline inherited from the scenario fallback counts the same way.
    const fallback = evaluateStudioPluginAvailability(record({ kind: 'atom', capabilities: ['prompt:inject'] }), scenarios, noRunner);
    expect(fallback.reasons).toEqual(expect.arrayContaining([{ code: 'pipeline' }]));
    // An empty declared pipeline declares no stage.
    expect(evaluateStudioPluginAvailability(record({ kind: 'scenario', pipeline: { stages: [] } }), scenarios, noRunner))
      .toEqual({ applicable: true, reasons: [] });
  });

  it('evaluates the pipeline apply would run, including the scenario fallback and the core quality stages', () => {
    // A generate-only template gains plan + critique at apply; both are evaluated.
    const template = evaluateStudioPluginAvailability(record({ kind: 'scenario', mode: 'prototype', capabilities: ['prompt:inject', 'fs:write'],
      pipeline: { stages: [{ id: 'generate', atoms: ['file-write', 'live-artifact'] }] } }), scenarios, noRunner);
    expect(template.applicable).toBe(false);
    expect(template.reasons).toEqual([
      { code: 'atom', subject: 'critique-theater' },
      { code: 'pipeline' }, { code: 'pipeline-devloop', subject: 'critique' }]);
    // An atom without a pipeline inherits the bundled scenario's.
    const atom = evaluateStudioPluginAvailability(record({ kind: 'atom', capabilities: ['prompt:inject'] }), scenarios, noRunner);
    expect(atom.reasons).toEqual(expect.arrayContaining([{ code: 'atom', subject: 'critique-theater' }, { code: 'pipeline-devloop', subject: 'critique' }]));
  });

  it('fails closed on unknown atoms, host capabilities, strategies, GenUI, connectors, MCP, context it cannot capture and malformed declarations', () => {
    const reasonsOf = (od: Record<string, unknown>) => evaluateStudioPluginAvailability(record({ kind: 'scenario', mode: 'image', ...od }), scenarios, noRunner).reasons;
    expect(reasonsOf({ pipeline: { stages: [{ id: 'generate', atoms: ['image-generate'] }] } })).toEqual([{ code: 'pipeline' }, { code: 'unknown-atom', subject: 'image-generate' }]);
    expect(reasonsOf({ capabilities: ['prompt:inject', 'subprocess', 'network'] })).toEqual([
      { code: 'capability', subject: 'network' }, { code: 'capability', subject: 'subprocess' }]);
    expect(reasonsOf({ strategy: { schema: 'open-design.bundled-strategy/v2' } })).toEqual([{ code: 'strategy' }]);
    expect(reasonsOf({ genui: { surfaces: [{ id: 'confirm', kind: 'confirmation', persist: 'run' }] } })).toEqual([{ code: 'genui', subject: 'confirm' }]);
    expect(reasonsOf({ connectors: { required: [{ id: 'notion', tools: [] }] } })).toEqual([{ code: 'connector', subject: 'notion' }]);
    expect(reasonsOf({ context: { mcp: [{ name: 'figma', command: 'npx' }] } })).toEqual([{ code: 'mcp', subject: 'figma' }]);
    expect(reasonsOf({ context: { claudePlugins: [{ ref: 'some-plugin' }] } })).toEqual([
      { code: 'context', subject: 'claude-plugin' }]);
    expect(reasonsOf({ pipeline: { stages: [{ id: 'generate' }] } })).toEqual([{ code: 'manifest', subject: 'pipeline' }]);
    expect(reasonsOf({ capabilities: 'fs:read' })).toEqual([{ code: 'manifest', subject: 'capabilities' }]);
    expect(evaluateStudioPluginAvailability(record({}, { sourceKind: 'marketplace' }), scenarios).reasons).toEqual([{ code: 'source', subject: 'marketplace' }]);
  });

  it('opens more plugins automatically when a capability lands on Web', () => {
    const template = record({ kind: 'scenario', mode: 'prototype', capabilities: ['prompt:inject', 'fs:write'],
      pipeline: { stages: [{ id: 'generate', atoms: ['file-write', 'live-artifact'] }] } });
    const landed: StudioWebPluginCapabilities = { ...STUDIO_WEB_PLUGIN_CAPABILITIES,
      atoms: [...STUDIO_WEB_PLUGIN_CAPABILITIES.atoms, 'todo-write', 'live-artifact', 'critique-theater'], pipelines: true, pipelineDevloop: true };
    expect(evaluateStudioPluginAvailability(template, scenarios, noRunner).applicable).toBe(false);
    expect(evaluateStudioPluginAvailability(template, scenarios, landed)).toEqual({ applicable: true, reasons: [] });
    // A stage runner alone opens a plain pipeline of Web atoms; the devloop stays its own capability.
    const plain = record({ kind: 'scenario', capabilities: ['fs:read', 'fs:write'],
      pipeline: { stages: [{ id: 'inspect', atoms: ['file-read'] }, { id: 'package', atoms: ['file-write'] }] } });
    const runner: StudioWebPluginCapabilities = { ...STUDIO_WEB_PLUGIN_CAPABILITIES, pipelines: true, pipelineDevloop: false };
    expect(evaluateStudioPluginAvailability(plain, scenarios, runner)).toEqual({ applicable: true, reasons: [] });
    expect(evaluateStudioPluginAvailability(plain, scenarios)).toEqual({ applicable: true, reasons: [] });
    expect(evaluateStudioPluginAvailability(template, scenarios, { ...runner, atoms: landed.atoms }).reasons)
      .toEqual([{ code: 'pipeline-devloop', subject: 'critique' }]);
  });
  it('admits finite planning stages now that every Studio source exposes a plan tool', () => {
    const planning = record({ kind: 'scenario', capabilities: ['prompt:inject'],
      pipeline: { stages: [{ id: 'plan', atoms: ['todo-write'] }, { id: 'read', atoms: ['file-read'] }] } });
    expect(evaluateStudioPluginAvailability(planning, scenarios)).toEqual({ applicable: true, reasons: [] });
    expect(evaluateStudioPluginAvailability(planning, scenarios, { ...STUDIO_WEB_PLUGIN_CAPABILITIES,
      atoms: STUDIO_WEB_PLUGIN_CAPABILITIES.atoms.filter((atom) => atom !== 'todo-write') }).reasons)
      .toEqual([{ code: 'atom', subject: 'todo-write' }]);
  });

  it('admits craft references only when bounded and supported by the capture registry', () => {
    const craft = (references: unknown) => record({ kind: 'scenario', context: { craft: references } });
    expect(evaluateStudioPluginAvailability(craft(['typography', 'color']), scenarios))
      .toEqual({ applicable: true, reasons: [] });
    expect(evaluateStudioPluginAvailability(craft(['typography']), scenarios, { ...STUDIO_WEB_PLUGIN_CAPABILITIES,
      context: { ...STUDIO_WEB_PLUGIN_CAPABILITIES.context, craft: false } }).reasons)
      .toEqual([{ code: 'context', subject: 'craft' }]);
    for (const references of [[42], ['../typography'], ['typography', 'typography'], ['a'.repeat(65)]]) {
      expect(evaluateStudioPluginAvailability(craft(references), scenarios).reasons)
        .toEqual([{ code: 'manifest', subject: 'context.craft' }]);
    }
  });

  it('admits local assets through the shared resource carrier and refuses unsafe resource declarations', () => {
    const fixture = (context: Record<string, unknown>) => record({ kind: 'scenario', context });
    expect(evaluateStudioPluginAvailability(fixture({ assets: ['./example.html', './source'] }), scenarios))
      .toEqual({ applicable: true, reasons: [] });
    expect(evaluateStudioPluginAvailability(fixture({ assets: ['./example.html'] }), scenarios, { ...STUDIO_WEB_PLUGIN_CAPABILITIES,
      context: { ...STUDIO_WEB_PLUGIN_CAPABILITIES.context, assets: false } }).reasons)
      .toEqual([{ code: 'context', subject: 'assets' }]);
    for (const assets of [['../other.html'], ['/etc/passwd'], ['file:secret'], ['.secret'], [42]]) {
      expect(evaluateStudioPluginAvailability(fixture({ assets }), scenarios).reasons)
        .toEqual([{ code: 'manifest', subject: 'context.assets' }]);
    }
    expect(evaluateStudioPluginAvailability(fixture({ skills: [{ path: '../outside/SKILL.md' }] }), scenarios).reasons)
      .toEqual([{ code: 'manifest', subject: 'context.skills' }]);
  });

  it('admits a catalog design reference or primary selection and refuses unimplemented reference shapes', () => {
    const fixture = (designSystem: unknown) => record({ kind: 'scenario', context: { designSystem } });
    for (const reference of [{}, { primary: true }, { ref: 'linear' }, { ref: 'user:studio_fixture', primary: true }]) {
      expect(evaluateStudioPluginAvailability(fixture(reference), scenarios)).toEqual({ applicable: true, reasons: [] });
    }
    expect(evaluateStudioPluginAvailability(fixture({ ref: 'linear' }), scenarios, { ...STUDIO_WEB_PLUGIN_CAPABILITIES,
      context: { ...STUDIO_WEB_PLUGIN_CAPABILITIES.context, designSystem: false } }).reasons)
      .toEqual([{ code: 'context', subject: 'design-system' }]);
    for (const reference of [{ primary: false }, { ref: '' }, { ref: '../secret' }, { path: './DESIGN.md' }, { ref: 'linear', unknown: true }]) {
      expect(evaluateStudioPluginAvailability(fixture(reference), scenarios).reasons)
        .toEqual([{ code: 'manifest', subject: 'context.designSystem' }]);
    }
  });

  it('admits catalog skills only through bounded unambiguous references', () => {
    const fixture = (skills: unknown) => record({ kind: 'scenario', context: { skills } });
    for (const skills of [[{ ref: 'web-clone' }], [{ path: 'web-clone' }], [{ ref: 'studio-skill:fixture' }, { path: './SKILL.md' }]]) {
      expect(evaluateStudioPluginAvailability(fixture(skills), scenarios)).toEqual({ applicable: true, reasons: [] });
    }
    expect(evaluateStudioPluginAvailability(fixture([{ ref: 'web-clone' }]), scenarios, { ...STUDIO_WEB_PLUGIN_CAPABILITIES,
      context: { ...STUDIO_WEB_PLUGIN_CAPABILITIES.context, skillRefs: false } }).reasons)
      .toEqual([{ code: 'context', subject: 'skill-ref' }]);
    for (const skills of [[{}], [{ ref: '' }], [{ ref: '/etc/passwd' }], [{ ref: 'https://host' }], [{ ref: 'web-clone', path: './SKILL.md' }],
      [{ path: './SKILL.md', hiddenCondition: true }], [{ path: './SKILL.md' }, { path: 'SKILL.md', ref: 'other' }],
      [{ ref: 'web-clone' }, { path: 'web-clone' }], [{ path: './source/SKILL.md' }, { path: 'source/SKILL.md' }],
      Array.from({ length: 13 }, (_, i) => ({ ref: `skill-${i}` }))]) {
      expect(evaluateStudioPluginAvailability(fixture(skills), scenarios).reasons).toEqual([{ code: 'manifest', subject: 'context.skills' }]);
    }
  });

  it.each([
    { stages: [{ id: 'inspect', atoms: ['file-read'], onFailure: 'skip' }] },
    { stages: [{ id: 'inspect', atoms: ['file-read'], onFailure: 'retry' }] },
    { stages: [{ id: 'inspect', atoms: ['file-read'], hiddenCondition: 'skip' }] },
    { stages: [{ id: 'inspect', atoms: ['file-read'] }, { id: 'inspect', atoms: ['file-write'] }] },
  ])('refuses a pipeline the finite runner cannot honor: %j', (pipeline) => {
    expect(evaluateStudioPluginAvailability(record({ kind: 'scenario', pipeline }), scenarios))
      .toEqual({ applicable: false, reasons: [{ code: 'manifest', subject: 'pipeline' }] });
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

// S67 (#61/#63/#68): `live-artifact` and the media atoms already exist as Studio
// capabilities. Live Artifacts run on every source through the canonical Studio
// tools; media runs only where the S34 functions exist (the OpenAI sources), so
// a plugin needing media stays applicable but names personal Codex as a source
// whose turns are refused. Nothing is keyed by plugin id.
describe('S67 Studio atoms with per-source availability', () => {
  const generate = (atoms: string[], od: Record<string, unknown> = {}) => record({ kind: 'scenario', capabilities: ['prompt:inject', 'fs:write'],
    pipeline: { stages: [{ id: 'render', atoms }] }, ...od });

  it('opens live-artifact stages on every execution source', () => {
    expect(evaluateStudioPluginAvailability(generate(['file-write', 'live-artifact']), scenarios)).toEqual({ applicable: true, reasons: [] });
    expect(evaluateStudioPluginRequirements(generate(['file-write', 'live-artifact']), scenarios))
      .toEqual({ atoms: ['file-write', 'live-artifact'], capabilities: ['fs:write', 'prompt:inject'] });
    // Control: a registry without the atom still refuses it.
    expect(evaluateStudioPluginAvailability(generate(['live-artifact']), scenarios, { ...STUDIO_WEB_PLUGIN_CAPABILITIES,
      atoms: STUDIO_WEB_PLUGIN_CAPABILITIES.atoms.filter((atom) => atom !== 'live-artifact') }).reasons)
      .toEqual([{ code: 'atom', subject: 'live-artifact' }]);
  });

  it('opens declared media atoms and capabilities only on the OpenAI sources', () => {
    const media = generate(['media-image', 'media-video', 'media-audio', 'live-artifact'],
      { capabilities: ['prompt:inject', 'media:image', 'media:video', 'media:audio', 'fs:write'] });
    expect(evaluateStudioPluginAvailability(media, scenarios)).toEqual({ applicable: true, reasons: [], sourceRestrictions: [
      { source: 'personal-codex', reasons: [{ code: 'atom', subject: 'media-audio' }, { code: 'atom', subject: 'media-image' },
        { code: 'atom', subject: 'media-video' }, { code: 'capability', subject: 'media:audio' }, { code: 'capability', subject: 'media:image' },
        { code: 'capability', subject: 'media:video' }] }] });
    const requirements = evaluateStudioPluginRequirements(media, scenarios);
    expect(studioPluginSourceReasons(requirements, 'company-openai')).toEqual([]);
    expect(studioPluginSourceReasons(requirements, 'account-openai')).toEqual([]);
    expect(studioPluginSourceReasons(requirements, 'personal-codex').map((reason) => reason.subject))
      .toEqual(['media-audio', 'media-image', 'media-video', 'media:audio', 'media:image', 'media:video']);
    // Context atoms count the same way as stage atoms.
    expect(evaluateStudioPluginAvailability(record({ kind: 'scenario', context: { atoms: ['media-image'] } }), scenarios).sourceRestrictions)
      .toEqual([{ source: 'personal-codex', reasons: [{ code: 'atom', subject: 'media-image' }] }]);
  });

  it('derives the media atom from a declared image, video or audio surface', () => {
    // Desktop routes these surfaces to `od media generate`, even when the pipeline names only file and Live Artifact atoms.
    for (const [od, atom] of [[{ mode: 'image' }, 'media-image'], [{ surface: 'audio', mode: 'scenario' }, 'media-audio'],
      [{ surface: 'hyperframes', mode: 'video' }, 'media-video']] as const) {
      const plugin = generate(['file-write', 'live-artifact'], od);
      expect(evaluateStudioPluginAvailability(plugin, scenarios)).toEqual({ applicable: true, reasons: [],
        sourceRestrictions: [{ source: 'personal-codex', reasons: [{ code: 'atom', subject: atom }] }] });
      expect(evaluateStudioPluginRequirements(plugin, scenarios).atoms).toContain(atom);
    }
    expect(evaluateStudioPluginAvailability(generate(['file-write'], { mode: 'prototype', surface: 'web' }), scenarios))
      .toEqual({ applicable: true, reasons: [] });
  });

  it('keeps desktop-only media pipelines, unknown media atoms and unrunnable plugins closed', () => {
    // The HyperFrames renderer and the image-template atoms are not Studio functions.
    expect(evaluateStudioPluginAvailability(generate(['media-video'], { capabilities: ['prompt:inject', 'media:video-generate'] }), scenarios).reasons)
      .toEqual([{ code: 'capability', subject: 'media:video-generate' }]);
    expect(evaluateStudioPluginAvailability(generate(['image-generate']), scenarios).reasons).toEqual([{ code: 'unknown-atom', subject: 'image-generate' }]);
    // A plugin no source can run is unavailable rather than restricted everywhere.
    const nowhere: StudioWebPluginCapabilities = { ...STUDIO_WEB_PLUGIN_CAPABILITIES, sourceGaps: {
      'personal-codex': { atoms: ['media-image'], capabilities: [] }, 'company-openai': { atoms: ['media-image'], capabilities: [] },
      'account-openai': { atoms: ['media-image'], capabilities: [] } } };
    expect(evaluateStudioPluginAvailability(generate(['media-image']), scenarios, nowhere))
      .toEqual({ applicable: false, reasons: [{ code: 'atom', subject: 'media-image' }] });
    // Unavailable plugins carry no restriction list.
    expect(evaluateStudioPluginAvailability(generate(['media-image', 'critique-theater']), scenarios))
      .toEqual({ applicable: true, reasons: [], sourceRestrictions: [{ source: 'personal-codex', reasons: [{ code: 'atom', subject: 'media-image' }] }] });
  });
});

// S67 repair 1: the desktop-step detector's reasons join the declaration
// reasons, are pinned in the requirements, and an unreadable package fails
// closed. Admission refuses a pinned requirement no Studio turn runs at all.
describe('S67 repair 1: captured-package desktop steps', () => {
  const plain = record({ kind: 'scenario', capabilities: ['prompt:inject', 'fs:write'], pipeline: { stages: [{ id: 'render', atoms: ['file-write'] }] } });
  it('closes a plugin whose package instructs a desktop-only core step and pins the step', () => {
    const documents = [{ path: 'SKILL.md', text: 'Finish with `od plugin install --source generated-plugin`.' }];
    expect(evaluateStudioPluginAvailability(plain, scenarios, undefined, documents))
      .toEqual({ applicable: false, reasons: [{ code: 'capability', subject: 'desktop:od-cli' }] });
    expect(evaluateStudioPluginRequirements(plain, scenarios, undefined, documents).capabilities).toContain('desktop:od-cli');
    // A clean package and a declarations-only evaluation stay applicable.
    expect(evaluateStudioPluginAvailability(plain, scenarios, undefined, [{ path: 'SKILL.md', text: 'Write the page.' }]))
      .toEqual({ applicable: true, reasons: [] });
    expect(evaluateStudioPluginAvailability(plain, scenarios)).toEqual({ applicable: true, reasons: [] });
  });
  it('fails closed when the package cannot be read', () => {
    expect(evaluateStudioPluginAvailability(plain, scenarios, undefined, null))
      .toEqual({ applicable: false, reasons: [{ code: 'context', subject: 'package' }] });
  });
  it('refuses a pinned requirement no Studio source runs on every source', () => {
    for (const source of ['personal-codex', 'company-openai', 'account-openai'] as const) {
      expect(studioPluginSourceReasons({ atoms: ['critique-theater', 'file-write'], capabilities: ['desktop:media-scaffold', 'fs:write'] }, source))
        .toEqual([{ code: 'capability', subject: 'desktop:media-scaffold' }]);
    }
  });
});

describe('S70 bounded Studio devloop admission', () => {
  const fixture = (until?: string) => record({ kind: 'scenario', pipeline: { stages: [{ id: 'review', atoms: ['critique-theater'], repeat: true, until }] } });
  it('opens a bounded critique loop without changing pinned media source restrictions', () => {
    expect(evaluateStudioPluginAvailability(fixture('critique.score>=4 || iterations>=3'), scenarios)).toEqual({ applicable: true, reasons: [] });
  });
  it.each([undefined, 'critique.score>=4', 'critique.score>=4 && iterations>=3', 'iterations>=9', 'iterations>8'])('refuses an unproved bound %s with a typed reason', (until) => {
    expect(evaluateStudioPluginAvailability(fixture(until), scenarios).reasons).toContainEqual({ code: 'pipeline-devloop-unbounded', subject: 'review' });
  });
  it.each(['build.passing', 'tests.passing', 'user.confirmed', 'preview.ok'])('refuses unsupported signal %s even with a bound', (signal) => {
    expect(evaluateStudioPluginAvailability(fixture(`${signal}==true || iterations>=3`), scenarios).reasons)
      .toContainEqual({ code: 'pipeline-devloop-signal', subject: signal });
  });
  it.each(['iterations>=8', 'iterations>7', 'iterations>=2.5'])('proves the integer termination count for %s', (until) => {
    expect(evaluateStudioPluginAvailability(fixture(until), scenarios)).toEqual({ applicable: true, reasons: [] });
  });
});

describe('S70 pinned admission reuses the bounded policy and S67 requirements', () => {
  it.each(['scripts/extract_pptx.py "deck.pptx" > dump.json', 'python3.12 "scripts/last30days.py" topic'])(
    'refuses old pinned script instructions on every source: %s', async (command) => {
      const { studioPinnedPluginSourceReasons } = await import('../src/plugins/studio-pinned-requirements.js');
      const { buildStudioSkillPackage } = await import('../src/services/studio-skill-packages.js');
      const pin = { requirements: { atoms: [], capabilities: [] }, resourcePackage: buildStudioSkillPackage('studio-plugin:old@1.0.0', [
        { path: 'SKILL.md', bytes: Buffer.from(`Run \`${command}\`.`), executable: false },
      ]) };
      for (const source of ['personal-codex', 'company-openai', 'account-openai'] as const) {
        expect(studioPinnedPluginSourceReasons(pin, source, { liveArtifacts: true }))
          .toEqual([{ code: 'capability', subject: 'desktop:local-script' }]);
      }
    });
  it.each(['personal-codex', 'company-openai', 'account-openai'] as const)('refuses an old unbounded pin on %s', async (source) => {
    const { studioPinnedPluginSourceReasons } = await import('../src/plugins/studio-pinned-requirements.js');
    const pin = { pipeline: { stages: [{ id: 'critique', atoms: ['critique-theater'], repeat: true, until: 'critique.score>=4' }] } };
    expect(studioPinnedPluginSourceReasons(pin, source, { liveArtifacts: true }))
      .toContainEqual({ code: 'pipeline-devloop-unbounded', subject: 'critique' });
  });
  it('retains the media and desktop refusals on a bounded pin', async () => {
    const { studioPinnedPluginSourceReasons } = await import('../src/plugins/studio-pinned-requirements.js');
    const pin = { requirements: { atoms: ['critique-theater', 'media-image'], capabilities: ['desktop:od-cli'] },
      pipeline: { stages: [{ id: 'critique', atoms: ['critique-theater'], repeat: true, until: 'critique.score>=4 || iterations>=3' }] } };
    expect(studioPinnedPluginSourceReasons(pin, 'personal-codex', { liveArtifacts: true })).toEqual([
      { code: 'atom', subject: 'media-image' }, { code: 'capability', subject: 'desktop:od-cli' }]);
    expect(studioPinnedPluginSourceReasons(pin, 'account-openai', { liveArtifacts: true })).toEqual([{ code: 'capability', subject: 'desktop:od-cli' }]);
  });
});
