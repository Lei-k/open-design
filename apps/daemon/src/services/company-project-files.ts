import { closeSync, constants, fstatSync, mkdirSync, openSync, readSync, opendirSync, realpathSync, ftruncateSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { kindFor, projectDir, validateProjectPath } from '../projects.js';
import { normalizeArtifactRuntimeImports } from '../artifacts/runtime-compat.js';

const FILE_LIMIT = 1024 * 1024;
/** Captured skill resources may be binary and up to their package's per-file bound. */
const RESOURCE_LIMIT = 4 * 1024 * 1024;
const fdPath = (fd: number) => `/proc/self/fd/${fd}`;

/** EC2/Linux project functions hold directory inodes instead of reopening a
 * checked pathname. A personal worker may concurrently rename a directory or
 * plant symlinks; neither can redirect these functions into daemon/foreign data.
 * No fallback to an ordinary following path when descriptor paths are absent. */
function withFile<T>(projectsRoot: string, projectId: string, name: string, write: boolean, operate: (fd: number) => T, limit = FILE_LIMIT): T {
  const safe = validateProjectPath(name) as string;
  if (safe.split('/').some((segment) => ['.file-versions', '.live-artifacts'].includes(segment))) throw new Error('project tool path refused');
  const expectedRoot = realpathSync(projectDir(projectsRoot, projectId));
  if (path.dirname(expectedRoot) !== realpathSync(projectsRoot)) throw new Error('project tool root refused');
  const dirs: number[] = [];
  let file: number | undefined;
  try {
    const root = openSync(projectDir(projectsRoot, projectId), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    dirs.push(root);
    if (realpathSync(fdPath(root)) !== expectedRoot) throw new Error('project tool root changed');
    const segments = safe.split('/');
    for (const segment of segments.slice(0, -1)) {
      const current = path.join(fdPath(dirs.at(-1)!), segment);
      if (write) {
        try { mkdirSync(current, { mode: 0o700 }); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
      }
      dirs.push(openSync(current, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW));
    }
    // O_TRUNC is intentionally absent: verify the inode before altering it.
    file = openSync(path.join(fdPath(dirs.at(-1)!), segments.at(-1)!), constants.O_NOFOLLOW | constants.O_NONBLOCK
      | (write ? constants.O_WRONLY | constants.O_CREAT : constants.O_RDONLY), 0o600);
    const stat = fstatSync(file);
    const actual = realpathSync(fdPath(file));
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit || !actual.startsWith(expectedRoot + path.sep)) throw new Error('project tool file refused');
    return operate(file);
  } finally {
    if (file !== undefined) closeSync(file);
    for (const dir of dirs.reverse()) closeSync(dir);
  }
}
export function readCompanyProjectFile(projectsRoot: string, projectId: string, name: string): string {
  return withFile(projectsRoot, projectId, name, false, (fd) => {
    const content = Buffer.alloc(FILE_LIMIT + 1);
    let offset = 0;
    for (;;) {
      const count = readSync(fd, content, offset, content.length - offset, offset);
      if (!count) break;
      offset += count;
      if (offset > FILE_LIMIT) throw new Error('project tool file limit');
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(content.subarray(0, offset));
  });
}
export function writeCompanyProjectFile(projectsRoot: string, projectId: string, name: string, text: string): void {
  const normalized = normalizeArtifactRuntimeImports(name, text);
  if (typeof normalized !== 'string') throw new Error('project tool content refused');
  if (Buffer.byteLength(normalized) > FILE_LIMIT) throw new Error('project tool file limit');
  withFile(projectsRoot, projectId, name, true, (fd) => { ftruncateSync(fd, 0); writeFileSync(fd, normalized); });
}

/** Bytes from an immutable captured package; text-like HTML still passes the
 * same runtime-import normalization as a model-authored write. */
export function writeCompanyProjectBytes(projectsRoot: string, projectId: string, name: string, bytes: Buffer): void {
  if (bytes.length > RESOURCE_LIMIT) throw new Error('project tool file limit');
  let text: string | null = null;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { /* binary */ }
  if (text !== null && bytes.length <= FILE_LIMIT) return writeCompanyProjectFile(projectsRoot, projectId, name, text);
  withFile(projectsRoot, projectId, name, true, (fd) => { ftruncateSync(fd, 0); writeFileSync(fd, bytes); }, RESOURCE_LIMIT);
}

/** Generated media (#63) is bounded by its own ceiling, not the text/resource one. */
export const MEDIA_FILE_LIMIT = 64 * 1024 * 1024;
export function writeCompanyProjectMedia(projectsRoot: string, projectId: string, name: string, bytes: Buffer): void {
  if (bytes.length > MEDIA_FILE_LIMIT) throw new Error('project tool file limit');
  withFile(projectsRoot, projectId, name, true, (fd) => { ftruncateSync(fd, 0); writeFileSync(fd, bytes); }, MEDIA_FILE_LIMIT);
}

/** Bounded descriptor traversal: no foreign names leak through a renamed or
 * symlinked intermediate directory, and no FIFO/device is ever opened to read. */
export function listCompanyProjectFiles(projectsRoot: string, projectId: string): Array<{ name: string; size: number; kind: string }> {
  const expectedRoot = realpathSync(projectDir(projectsRoot, projectId));
  if (path.dirname(expectedRoot) !== realpathSync(projectsRoot)) throw new Error('project tool root refused');
  const root = openSync(projectDir(projectsRoot, projectId), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const files: Array<{ name: string; size: number; kind: string }> = [];
  let visited = 0;
  const walk = (fd: number, prefix: string, depth: number) => {
    if (depth > 32 || visited >= 2000 || files.length >= 500) return;
    const actual = realpathSync(fdPath(fd));
    if (actual !== expectedRoot && !actual.startsWith(expectedRoot + path.sep)) throw new Error('project tool directory refused');
    const directory = opendirSync(fdPath(fd));
    try {
      for (;;) {
        const entry = directory.readSync();
        if (!entry || visited++ >= 2000 || files.length >= 500) break;
        if (entry.name.startsWith('.') || entry.name.endsWith('.artifact.json') || entry.name === 'node_modules' || entry.isSymbolicLink()) continue;
        const name = prefix + entry.name;
        let child: number | undefined;
        try {
          child = openSync(path.join(fdPath(fd), entry.name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
            | (entry.isDirectory() ? constants.O_DIRECTORY : 0));
          const stat = fstatSync(child);
          if (stat.isDirectory()) walk(child, name + '/', depth + 1);
          else if (stat.isFile() && stat.nlink === 1) files.push({ name, size: stat.size, kind: kindFor(name) as string });
        } catch { /* A replaced or unreadable entry is not eligible. */ }
        finally { if (child !== undefined) closeSync(child); }
      }
    } finally { directory.closeSync(); }
  };
  try { if (realpathSync(fdPath(root)) !== expectedRoot) throw new Error('project tool root changed'); walk(root, '', 0); return files; }
  finally { closeSync(root); }
}
