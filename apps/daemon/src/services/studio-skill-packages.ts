import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { captureStudioResource } from '../projects/studio-snapshot.js';
import { parseFrontmatter } from '../design-systems/frontmatter.js';

export interface StudioSkillPackage {
  id: string;
  key: string;
  files: Array<{ path: string; data: string; executable: boolean; sha256: string }>;
  hash: string;
}
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const studioSkillKey = (id: string) => digest(id).slice(0, 32);
const packageHash = (value: Omit<StudioSkillPackage, 'hash'>) => digest(JSON.stringify(value));

/** Capture all shipped side files, without the single-user scanner's absolute
 * fallback preamble. Admission owns these bytes; upgrades cannot change them. */
export function captureStudioSkill(root: string, directory: string, id: string): { body: string; package: StudioSkillPackage } {
  const files = captureStudioResource(root, directory);
  const source = files.find((file) => file.name === 'SKILL.md');
  if (!source) throw new Error('skill document missing');
  const raw = new TextDecoder('utf-8', { fatal: true }).decode(source.bytes);
  const { body } = parseFrontmatter(raw);
  return { body, package: buildStudioSkillPackage(id, files.map((file) => ({ path: file.name, bytes: file.bytes, executable: Boolean(file.executable) }))) };
}

/** Content-addressed package for an id. Callers validate with
 * `readStudioSkillPackages` before persisting or staging it. */
export function buildStudioSkillPackage(id: string, files: ReadonlyArray<{ path: string; bytes: Buffer; executable: boolean }>): StudioSkillPackage {
  const captured = { id, key: studioSkillKey(id), files: files.map((file) => ({ path: file.path,
    data: file.bytes.toString('base64'), executable: file.executable, sha256: digest(file.bytes) })) };
  return { ...captured, hash: packageHash(captured) };
}

/** Validate persisted packages before any path or allocation is used. There
 * is no live-catalog fallback when a captured revision is damaged. */
export function readStudioSkillPackages(value: unknown, maxPackages: 12 | 13 = 12): StudioSkillPackage[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxPackages) throw new Error('invalid skill snapshots');
  const packages: StudioSkillPackage[] = [];
  let total = 0;
  const ids = new Set<string>();
  for (const snapshot of value) {
    if (!snapshot || typeof snapshot !== 'object') throw new Error('invalid skill snapshot');
    const resource = (snapshot as { package?: StudioSkillPackage }).package;
    if (resource === undefined) continue; // Existing text-only revisions remain reproducible.
    if (!resource || typeof resource.id !== 'string' || resource.id !== snapshot.id
      || resource.key !== studioSkillKey(resource.id) || !Array.isArray(resource.files) || resource.files.length > 250
      || ids.has(resource.id)) throw new Error('invalid skill package');
    ids.add(resource.id);
    const names = new Set<string>(); let bytes = 0;
    for (const file of resource.files) {
      if (!file || typeof file.path !== 'string' || file.path.length > 1024 || file.path.includes('\\') || file.path.includes('\0')
        || file.path.split('/').length > 17
        || file.path.split('/').some((segment) => !segment || segment.startsWith('.') || segment === 'node_modules')
        || names.has(file.path) || typeof file.data !== 'string' || file.data.length > Math.ceil(4 * 1024 * 1024 / 3) * 4
        || typeof file.executable !== 'boolean' || typeof file.sha256 !== 'string') throw new Error('invalid skill file');
      names.add(file.path);
      const content = Buffer.from(file.data, 'base64');
      if (content.toString('base64') !== file.data || content.length > 4 * 1024 * 1024 || digest(content) !== file.sha256) throw new Error('invalid skill bytes');
      bytes += content.length;
    }
    total += bytes;
    if (!names.has('SKILL.md') || bytes > 8 * 1024 * 1024 || total > 16 * 1024 * 1024
      || packageHash({ id: resource.id, key: resource.key, files: resource.files }) !== resource.hash) throw new Error('invalid skill package hash or size');
    packages.push(resource);
  }
  return packages;
}

/** Fresh per-run root, never a project-controlled alias or symlink. The real
 * worker receives this subtree as an additional read-only sandbox mount. */
export function stageStudioSkillPackages(runHome: string, packages: readonly StudioSkillPackage[]): string | undefined {
  if (!packages.length) return undefined;
  const root = path.join(runHome, 'skill-packages');
  fs.mkdirSync(root, { mode: 0o700 });
  for (const resource of packages) for (const file of resource.files) {
    const destination = path.join(root, resource.key, file.path);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.writeFileSync(destination, Buffer.from(file.data, 'base64'), { flag: 'wx', mode: file.executable ? 0o500 : 0o400 });
  }
  return root;
}
