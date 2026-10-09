// Test-only applicable plugin for Studio apply tests (#61, S41 review repair F1).
//
// S42's finite runner makes od-share-to-community applicable. Keep pin and
// admission-race tests independent of that runner: this registers one
// `bundled` row in the test daemon's own installed-plugins table (never in the
// shipped bundled tree), evaluated by the same capability registry. It
// declares no pipeline (a scenario never falls back to another), only Web
// capabilities and its own SKILL.md, whose body carries `FIXTURE_SKILL_MARKER`.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export const FIXTURE_PLUGIN_ID = 'studio-test-applicable-plugin';
export const FIXTURE_SKILL_MARKER = 'FIXTURE_PLUGIN_SKILL_MARKER';
export const FIXTURE_RESOURCE_MARKER = 'FIXTURE_PLUGIN_RESOURCE_MARKER';
/** The bundled plugin the fixture is modelled on; its finite pipeline runs on Web since S42. */
export const PIPELINE_ONLY_PLUGIN_ID = 'od-share-to-community';

export function installStudioFixturePlugin(dataRoot: string): void {
  const folder = path.join(dataRoot, 'test-fixture-plugins', FIXTURE_PLUGIN_ID);
  mkdirSync(folder, { recursive: true });
  mkdirSync(path.join(folder, 'references'), { recursive: true });
  writeFileSync(path.join(folder, 'references/rules.md'), `${FIXTURE_RESOURCE_MARKER}: immutable relative reference.\n`);
  writeFileSync(path.join(folder, 'SKILL.md'),
    `---\nname: ${FIXTURE_PLUGIN_ID}\ndescription: Test-only Studio plugin\n---\n\n# Fixture plugin\n\n${FIXTURE_SKILL_MARKER}: keep the work in the project.\n`);
  const db = new Database(path.join(dataRoot, 'app.sqlite'));
  try {
    const base = db.prepare('SELECT * FROM installed_plugins WHERE id = ?').get(PIPELINE_ONLY_PLUGIN_ID) as Record<string, unknown> | undefined;
    if (!base) throw new Error(`bundled ${PIPELINE_ONLY_PLUGIN_ID} is not registered`);
    const manifest = JSON.parse(String(base.manifest_json)) as Record<string, any>;
    delete manifest.title_i18n;
    delete manifest.od.pipeline;
    const row: Record<string, unknown> = { ...base, id: FIXTURE_PLUGIN_ID, title: 'Studio fixture plugin', version: '1.0.0',
      source: folder, fs_path: folder, manifest_json: JSON.stringify({ ...manifest, name: FIXTURE_PLUGIN_ID, title: 'Studio fixture plugin',
        version: '1.0.0', od: { ...manifest.od, capabilities: ['prompt:inject', 'fs:read'],
          context: { ...manifest.od?.context, assets: ['./references/rules.md'] } } }) };
    const columns = Object.keys(row);
    db.prepare(`INSERT OR REPLACE INTO installed_plugins (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
      .run(...columns.map((key) => row[key]));
  } finally { db.close(); }
}
