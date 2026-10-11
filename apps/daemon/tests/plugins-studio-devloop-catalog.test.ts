import path from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { STUDIO_PLUGIN_EXECUTION_SOURCES, STUDIO_WEB_PLUGIN_CAPABILITIES, studioPluginSourceReasons } from '@open-design/contracts';
import { migratePlugins } from '../src/plugins/persistence.js';
import { registerBundledPlugins } from '../src/plugins/bundled.js';
import { bundledScenarioRegistry } from '../src/plugins/bundled-scenarios.js';
import { readStudioPluginDocuments } from '../src/plugins/studio-desktop-steps.js';
import { evaluateStudioPluginRequirements, evaluateStudioPluginAvailability, studioPluginReasonSummary } from '../src/plugins/studio-availability.js';
import { applyPlugin } from '../src/plugins/apply.js';
import { S70_DEVLOOP_SAMPLE } from './auth/studio-devloop-sample.js';

it('recounts the bundled catalog through the catalog evaluator and opens only the critique/devloop gaps', async () => {
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE projects (id TEXT PRIMARY KEY); CREATE TABLE conversations (id TEXT PRIMARY KEY);');
    migratePlugins(db);
    const { registered } = await registerBundledPlugins({ db, bundledRoot: path.resolve('../../plugins/_official'),
      roots: { userPluginsRoot: process.env.TMPDIR! } });
    const scenarios = bundledScenarioRegistry(registered);
    const baseCapabilities = { ...STUDIO_WEB_PLUGIN_CAPABILITIES, pipelineDevloop: false,
      atoms: STUDIO_WEB_PLUGIN_CAPABILITIES.atoms.filter((atom) => atom !== 'critique-theater') };
    const rows = registered.map((plugin) => {
      const documents = readStudioPluginDocuments(plugin.fsPath);
      return { id: plugin.id, before: evaluateStudioPluginAvailability(plugin, scenarios, baseCapabilities, documents, path.resolve('../../craft')),
        after: evaluateStudioPluginAvailability(plugin, scenarios, undefined, documents, path.resolve('../../craft')) };
    });
    const before = studioPluginReasonSummary(rows.map((row) => row.before));
    const after = studioPluginReasonSummary(rows.map((row) => row.after));
    const opened = rows.filter((row) => !row.before.applicable && row.after.applicable);
    expect(before).toMatchObject({ total: 460, applicable: 10, unavailable: 450 });
    expect(after).toMatchObject({ total: 460, applicable: 309, unavailable: 151 });
    expect(after.byReason).toMatchObject({ 'context:craft': 6, 'capability:desktop:local-script': 7 });
    expect(opened).toHaveLength(299);
    for (const id of ['example-kami-deck', 'example-kami-landing', 'example-open-design-homepage', 'example-live-dashboard']) {
      expect(rows.find((row) => row.id === id)!.after, id).toMatchObject({ applicable: false, reasons: expect.arrayContaining([{ code: 'context', subject: 'craft' }]) });
    }
    for (const id of ['example-pptx-html-fidelity-audit', 'example-last30days']) {
      expect(rows.find((row) => row.id === id)!.after, id).toMatchObject({ applicable: false, reasons: expect.arrayContaining([{ code: 'capability', subject: 'desktop:local-script' }]) });
    }
    expect(opened.every((row) => row.before.reasons.every((reason) => reason.code === 'pipeline-devloop'
      || reason.code === 'atom' && reason.subject === 'critique-theater'))).toBe(true);
    expect(S70_DEVLOOP_SAMPLE).toHaveLength(10);
    for (const sample of S70_DEVLOOP_SAMPLE) {
      expect(opened.some((row) => row.id === sample.id), sample.id).toBe(true);
      const plugin = registered.find((plugin) => plugin.id === sample.id)!;
      const reference = plugin.manifest.od?.context?.designSystem;
      expect(Boolean(reference && !reference.ref), sample.id).toBe(sample.projectDesign);
      const requirements = evaluateStudioPluginRequirements(plugin, scenarios, undefined, readStudioPluginDocuments(plugin.fsPath), path.resolve('../../craft'));
      expect(STUDIO_PLUGIN_EXECUTION_SOURCES.filter((source) => !studioPluginSourceReasons(requirements, source).length), sample.id).toEqual(sample.sources);
      const computed = applyPlugin({ plugin, inputs: sample.inputs ?? {}, activeProjectDesignSystem: { id: 'user:s70-brand' },
        registry: { skills: [], designSystems: [{ id: reference?.ref ?? 'user:s70-brand' }], craft: [], atoms: [], scenarios } });
      expect(computed.result.appliedPlugin.pipeline?.stages.find((stage) => stage.id === 'critique'), sample.id)
        .toMatchObject({ repeat: true, until: 'critique.score>=4 || iterations>=3' });
    }
    console.log('S70 catalog audit', JSON.stringify({ before, after, opened: opened.length }));
  } finally { db.close(); }
});
