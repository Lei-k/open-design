import path from 'node:path';
import type { InstalledPluginRecord } from '@open-design/contracts';
import { isStudioPluginAssetReferences, parseStudioPluginSkillReferences } from '@open-design/contracts';
import { captureStudioResource, type StudioSnapshotFile } from '../projects/studio-snapshot.js';
import { parseFrontmatter } from '../design-systems/frontmatter.js';
import { buildStudioSkillPackage, readStudioSkillPackages, type StudioSkillPackage } from '../services/studio-skill-packages.js';

export interface StudioPluginResources { skills: Array<{ path: string; body: string }>; package?: StudioSkillPackage }

/**
 * Capture a trusted bundled plugin's resource tree through held descriptors.
 * All local skill documents and every declared asset must resolve. Side files
 * travel with the immutable application, never with a live catalog lookup.
 */
export function captureStudioPluginResources(record: InstalledPluginRecord, contextFiles: readonly StudioSnapshotFile[] = []): StudioPluginResources {
  const assets = record.manifest.od?.context?.assets ?? [];
  if (!isStudioPluginAssetReferences(assets)) throw new Error('invalid plugin assets');
  const references = parseStudioPluginSkillReferences(record.manifest.od?.context?.skills ?? []);
  if (!references) throw new Error('invalid plugin skills');
  const localSkills = references.filter((ref) => ref.kind === 'local').map((ref) => ref.id);
  if (!assets.length && !localSkills.length && !contextFiles.length) return { skills: [] };
  let files: StudioSnapshotFile[] = [];
  if (assets.length || localSkills.length) {
    const directory = path.resolve(record.fsPath);
    files = captureStudioResource(path.dirname(directory), directory);
  }
  const relative = (ref: string) => ref.startsWith('./') ? ref.slice(2) : ref;
  for (const ref of assets) {
    const name = relative(ref);
    if (!files.some((file) => file.name === name || file.name.startsWith(`${name}/`))) throw new Error('plugin asset missing');
  }
  const skills = localSkills.map((ref) => {
    const name = relative(ref);
    const file = files.find((entry) => entry.name === name);
    if (!file || file.bytes.length > 256 * 1024) throw new Error('plugin skill missing or too large');
    const { body } = parseFrontmatter(new TextDecoder('utf-8', { fatal: true }).decode(file.bytes));
    if (!body.trim()) throw new Error('plugin skill empty');
    return { path: name, body: body.trim() };
  });
  // The existing resource transport is shared with selected skills. An
  // asset-only plugin gets a small generated index document for that carrier.
  const captured = [...files, ...contextFiles].map((file) => ({ path: file.name, bytes: file.bytes, executable: Boolean(file.executable) }));
  if (!captured.some((file) => file.path === 'SKILL.md')) captured.push({ path: 'SKILL.md',
    bytes: Buffer.from(`# Plugin resources\n\n${record.id}@${record.version}\n`), executable: false });
  const id = `studio-plugin:${record.id}@${record.version}`;
  const resource = buildStudioSkillPackage(id, captured);
  readStudioSkillPackages([{ id, package: resource }]);
  return { skills, package: resource };
}

/** Merge already captured plugin files with the run's selected skill files.
 * Validate the combined budget and every content hash before any worker runs.
 * A malformed capture never falls back to a live bundled resource directory.
 */
export function studioRunResourcePackages(request: Record<string, unknown> | null): StudioSkillPackage[] {
  const skills: unknown = request?.skillSnapshots ?? [];
  if (!Array.isArray(skills)) throw new Error('invalid run skill snapshots');
  const plugin = request?.pluginSnapshot;
  const resource = plugin && typeof plugin === 'object' ? (plugin as { resourcePackage?: unknown }).resourcePackage : undefined;
  if (resource === undefined) return readStudioSkillPackages(skills);
  if (!resource || typeof resource !== 'object' || typeof (resource as StudioSkillPackage).id !== 'string') throw new Error('invalid plugin resource snapshot');
  const captured = resource as StudioSkillPackage;
  // Up to 12 selected skills plus one applied plugin; keep the existing
  // 16 MiB aggregate ceiling by validating the combined payload in one pass.
  return readStudioSkillPackages([...skills, { id: captured.id, package: captured }], 13);
}
