import { createHash } from 'node:crypto';
import type { SkillDetail } from '@open-design/contracts';
import type { StudioSnapshotFile } from '../projects/studio-snapshot.js';
import { parseFrontmatter } from '../design-systems/frontmatter.js';
import { readStudioSkillPackages, type StudioSkillPackage } from '../services/studio-skill-packages.js';

export interface StudioPluginSkillContext {
  id: string;
  title: string;
  prompt: string;
  files: StudioSnapshotFile[];
}

/** Catalog access is decided by the caller. This function consumes only the
 * returned revision, with no installed-directory or user-folder fallback.
 * Namespacing preserves each skill's relative reference/script paths while
 * transporting all plugin context through the existing immutable carrier.
 */
export function captureStudioPluginSkillContext(skill: Pick<SkillDetail, 'id' | 'name' | 'source' | 'body'> & { package?: StudioSkillPackage }): StudioPluginSkillContext {
  if (!skill.id || typeof skill.body !== 'string' || !skill.body.trim() || Buffer.byteLength(skill.body) > 256 * 1024) {
    throw new Error('skill document unavailable');
  }
  let files: StudioSnapshotFile[];
  if (skill.package) {
    const resource = readStudioSkillPackages([{ id: skill.id, package: skill.package }])[0]!;
    const document = resource.files.find((file) => file.path === 'SKILL.md')!;
    const { body } = parseFrontmatter(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(document.data, 'base64')));
    if (body.trim() !== skill.body.trim()) throw new Error('skill document differs from its package');
    files = resource.files.map((file) => ({ name: file.path, bytes: Buffer.from(file.data, 'base64'), executable: file.executable }));
  } else if (skill.source === 'user' && skill.id.startsWith('studio-skill:')) {
    // Legacy account-authored text skills have no folder package.
    files = [{ name: 'SKILL.md', bytes: Buffer.from(skill.body) }];
  } else throw new Error('skill package unavailable');
  const prefix = `opendesign-context/skill-${createHash('sha256').update(skill.id).digest('hex').slice(0, 32)}`;
  const title = skill.name || skill.id;
  const prompt = `## Applied plugin catalog skill — ${title}\n\n`
    + `Skill id: ${skill.id}\nThe captured SKILL.md and its side files are under ${prefix}/ in the plugin resource package. `
    + `Resolve this skill's relative paths within that directory. Use captured resource tools to read, copy or run its files; never look up a live catalog or host folder.\n\n`
    + skill.body.trim();
  return { id: skill.id, title, prompt, files: files.map((file) => ({ ...file, name: `${prefix}/${file.name}` })) };
}
