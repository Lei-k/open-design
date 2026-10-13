import { constants, closeSync, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync, type Stats } from 'node:fs';
import path from 'node:path';
import { projectDir, validateProjectPath } from '../projects.js';

export const STUDIO_SNAPSHOT_LIMITS = { files: 500, bytes: 64 * 1024 * 1024, fileBytes: 25 * 1024 * 1024, depth: 32 } as const;
export interface StudioSnapshotFile { name: string; bytes: Buffer; executable?: boolean }
const fdPath = (fd: number) => `/proc/self/fd/${fd}`;
const heldWithin = (expected: string, fd: number) => {
  const current = realpathSync(fdPath(fd));
  return current === expected || current.startsWith(expected + path.sep);
};

/** Capture through held directory/file descriptors. A sandbox worker may
 * replace paths during capture; symlinks, hard links, devices and changed
 * files must never turn a project copy into a daemon/foreign read. */
export function captureStudioProject(projectsRoot: string, projectId: string): StudioSnapshotFile[] {
  const expected = projectDir(projectsRoot, projectId);
  const parent = realpathSync(projectsRoot);
  if (path.dirname(expected) !== parent) throw new Error('Invalid managed project');
  return captureStudioTree(expected, STUDIO_SNAPSHOT_LIMITS, true);
}

/** Resources have a separately supplied trusted root; a catalog directory is
 * never permission to read a sibling tree or follow a source symlink. */
export function captureStudioResource(root: string, directory: string): StudioSnapshotFile[] {
  const parent = realpathSync(root);
  const expected = path.join(parent, path.basename(directory));
  if (path.resolve(directory) !== path.join(path.resolve(root), path.basename(directory))) throw new Error('Invalid resource directory');
  return captureStudioTree(expected, { files: 250, bytes: 8 * 1024 * 1024, fileBytes: 4 * 1024 * 1024, depth: 16 }, false);
}

function captureStudioTree(expected: string, limits: { files: number; bytes: number; fileBytes: number; depth: number }, allowMissing: boolean): StudioSnapshotFile[] {
  let root: number;
  try { root = openSync(expected, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
  catch (error) {
    // Projects created before managed-copy creation may not have files yet.
    if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const files: StudioSnapshotFile[] = [];
  let total = 0;
  let visited = 0;
  const assertDirectory = (fd: number) => {
    if (!heldWithin(expected, fd)) throw new Error('Project directory changed');
  };
  const walk = (fd: number, prefix: string, depth: number) => {
    assertDirectory(fd);
    if (depth > limits.depth) throw new Error('Project directory depth exceeded');
    const directory = opendirSync(fdPath(fd));
    try {
      for (;;) {
        const entry = directory.readSync();
        if (!entry) break;
        if (++visited > 2000) throw new Error('Project directory entry limit exceeded');
        // Internal manifests, versions and dependency caches are never copied.
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name.endsWith('.artifact.json')) continue;
        const name = validateProjectPath(prefix + entry.name) as string;
        if (entry.isSymbolicLink()) throw new Error('Project symlink refused');
        const child = openSync(path.join(fdPath(fd), entry.name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
          | (entry.isDirectory() ? constants.O_DIRECTORY : 0));
        try {
          const before = fstatSync(child);
          if (before.isDirectory()) walk(child, name + '/', depth + 1);
          else {
            if (files.length >= limits.files) throw new Error('Project snapshot limit exceeded');
            const bytes = readHeldProjectFile(child, before, { expected, name, limits, total, assertParent: () => assertDirectory(fd) });
            total += bytes.length;
            files.push({ name, bytes, executable: Boolean(before.mode & 0o111) });
          }
        } finally { closeSync(child); }
      }
    } finally { directory.closeSync(); }
  };
  try { walk(root, '', 0); return files.sort((a, b) => a.name.localeCompare(b.name)); }
  finally { closeSync(root); }
}

/** Why one project file may not be captured. Paths are project-relative. */
export type StudioCaptureRefusalReason = 'symlink' | 'hard_link' | 'not_regular' | 'too_large' | 'bundle_too_large' | 'changed' | 'invalid_path';
/** A capture refusal that names the project-relative path at fault, never a host path or contents. */
export class StudioCaptureRefusal extends Error {
  constructor(readonly path: string, readonly reason: StudioCaptureRefusalReason, message: string) {
    super(message);
    this.name = 'StudioCaptureRefusal';
  }
}

/** The one read discipline for a project file already opened no-follow and
 * fstat'ed: regular, single-link, bounded (per file and running total), read
 * in bounded chunks, unchanged while read, and still at its expected path. */
function readHeldProjectFile(child: number, before: Stats, input: {
  expected: string; name: string; limits: { fileBytes: number; bytes: number }; total: number; assertParent: () => void;
}): Buffer {
  const { name, limits, total } = input;
  if (!before.isFile()) throw new StudioCaptureRefusal(name, 'not_regular', 'Project file refused');
  if (before.nlink !== 1) throw new StudioCaptureRefusal(name, 'hard_link', 'Project file refused');
  const tooLarge = (size: number) => size > limits.fileBytes
    ? new StudioCaptureRefusal(name, 'too_large', 'Project snapshot limit exceeded')
    : total + size > limits.bytes ? new StudioCaptureRefusal(name, 'bundle_too_large', 'Project snapshot limit exceeded') : null;
  const early = tooLarge(before.size); if (early) throw early;
  // Read in bounded chunks: growth after fstat must not allocate unbounded memory.
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const chunk = Buffer.alloc(Math.min(64 * 1024, limits.fileBytes + 1 - size));
    const count = readSync(child, chunk, 0, chunk.length, size);
    if (!count) break;
    size += count;
    const late = tooLarge(size); if (late) throw late;
    chunks.push(chunk.subarray(0, count));
  }
  const after = fstatSync(child);
  input.assertParent();
  if (after.nlink !== 1 || before.size !== size || after.size !== size || before.mtimeMs !== after.mtimeMs
    || before.ctimeMs !== after.ctimeMs) throw new StudioCaptureRefusal(name, 'changed', 'Project file changed during capture');
  const actual = realpathSync(fdPath(child));
  if (actual !== path.join(input.expected, name)) throw new StudioCaptureRefusal(name, 'changed', 'Project file changed during capture');
  return Buffer.concat(chunks, size);
}

export interface StudioProjectSelection {
  /** Bytes of one project-relative file, or null when it does not exist or is
   * a directory or a path the project capture never copies (dot segments,
   * `node_modules`, `*.artifact.json`). Throws `StudioCaptureRefusal` for a
   * file that exists but may not be captured. */
  read(name: string): Buffer | null;
  close(): void;
}

/**
 * Capture only selected files of a managed project, with the same no-follow,
 * descriptor-held discipline as `captureStudioProject` (#119). Every path
 * component is walked from the held project directory: symlinks anywhere,
 * hard links, non-regular files, oversize files, a running total above
 * `limits.bytes`, escaping the project and files changed while read are
 * refused for that path. Files that are not selected are never opened, so
 * they cannot block the capture.
 */
export function openStudioProjectSelection(projectsRoot: string, projectId: string,
  limits: { fileBytes: number; bytes: number; depth: number }): StudioProjectSelection {
  const expected = projectDir(projectsRoot, projectId);
  const parent = realpathSync(projectsRoot);
  if (path.dirname(expected) !== parent) throw new Error('Invalid managed project');
  let root: number | null;
  try { root = openSync(expected, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
  catch (error) {
    // Projects created before managed-copy creation may not have files yet.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    root = null;
  }
  if (root !== null && realpathSync(fdPath(root)) !== expected) { closeSync(root); throw new Error('Project directory changed'); }
  let total = 0;
  const absent = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes(String((error as NodeJS.ErrnoException).code));
  const openChild = (dir: number, segment: string, rel: string, flags: number): number | null => {
    try { return openSync(path.join(fdPath(dir), segment), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | flags); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Replaced by a symlink after lstat: O_NOFOLLOW refuses it.
      if (code === 'ELOOP') throw new StudioCaptureRefusal(rel, 'symlink', 'Project symlink refused');
      if (code === 'ENOENT') return null;
      if (code === 'ENOTDIR') throw new StudioCaptureRefusal(rel, 'changed', 'Project file changed during capture');
      throw error;
    }
  };
  return {
    read(name) {
      let safe: string;
      try { safe = validateProjectPath(name) as string; }
      catch { throw new StudioCaptureRefusal(String(name), 'invalid_path', 'Invalid project path'); }
      const segments = safe.split('/');
      // Internal manifests, versions and dependency caches are never copied.
      if (segments.some((segment) => segment.startsWith('.') || segment === 'node_modules' || segment.endsWith('.artifact.json'))) return null;
      if (segments.length - 1 > limits.depth) throw new StudioCaptureRefusal(safe, 'invalid_path', 'Project directory depth exceeded');
      if (root === null) return null;
      const held: number[] = [];
      try {
        let dir = root;
        for (let index = 0; index < segments.length; index++) {
          const segment = segments[index]!;
          const rel = segments.slice(0, index + 1).join('/');
          const last = index === segments.length - 1;
          let entry: Stats;
          try { entry = lstatSync(path.join(fdPath(dir), segment)); }
          catch (error) { if (absent(error)) return null; throw error; }
          if (entry.isSymbolicLink()) throw new StudioCaptureRefusal(rel, 'symlink', 'Project symlink refused');
          if (entry.isDirectory()) {
            // A directory is not a publishable file.
            if (last) return null;
            const child = openChild(dir, segment, rel, constants.O_DIRECTORY);
            if (child === null) return null;
            held.push(child);
            const opened = fstatSync(child);
            if (!opened.isDirectory() || opened.ino !== entry.ino || opened.dev !== entry.dev || !heldWithin(expected, child)) {
              throw new StudioCaptureRefusal(rel, 'changed', 'Project directory changed');
            }
            dir = child;
            continue;
          }
          // A file where a directory is expected: nothing exists below it.
          if (!last) return null;
          // Never open a device or FIFO; refuse it from its link metadata.
          if (!entry.isFile()) throw new StudioCaptureRefusal(rel, 'not_regular', 'Project file refused');
          const child = openChild(dir, segment, rel, 0);
          if (child === null) return null;
          held.push(child);
          const before = fstatSync(child);
          if (before.ino !== entry.ino || before.dev !== entry.dev) throw new StudioCaptureRefusal(rel, 'changed', 'Project file changed during capture');
          const parentDir = dir;
          const bytes = readHeldProjectFile(child, before, { expected, name: safe, limits, total, assertParent: () => {
            if (!heldWithin(expected, parentDir)) throw new StudioCaptureRefusal(safe, 'changed', 'Project directory changed');
          } });
          total += bytes.length;
          return bytes;
        }
        return null;
      } finally { for (const fd of held) closeSync(fd); }
    },
    close() { if (root !== null) closeSync(root); root = null; },
  };
}
