import { constants, closeSync, fstatSync, openSync, opendirSync, readSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { projectDir, validateProjectPath } from '../projects.js';

export const STUDIO_SNAPSHOT_LIMITS = { files: 500, bytes: 64 * 1024 * 1024, fileBytes: 25 * 1024 * 1024, depth: 32 } as const;
export interface StudioSnapshotFile { name: string; bytes: Buffer; executable?: boolean }

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
  const fdPath = (fd: number) => `/proc/self/fd/${fd}`;
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
    const current = realpathSync(fdPath(fd));
    if (current !== expected && !current.startsWith(expected + path.sep)) throw new Error('Project directory changed');
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
            if (!before.isFile() || before.nlink !== 1) throw new Error('Project file refused');
            if (before.size > limits.fileBytes || files.length >= limits.files
              || total + before.size > limits.bytes) throw new Error('Project snapshot limit exceeded');
            // Read in bounded chunks: growth after fstat must not allocate unbounded memory.
            const chunks: Buffer[] = [];
            let size = 0;
            for (;;) {
              const chunk = Buffer.alloc(Math.min(64 * 1024, limits.fileBytes + 1 - size));
              const count = readSync(child, chunk, 0, chunk.length, size);
              if (!count) break;
              size += count;
              if (size > limits.fileBytes || total + size > limits.bytes) throw new Error('Project snapshot limit exceeded');
              chunks.push(chunk.subarray(0, count));
            }
            const after = fstatSync(child);
            assertDirectory(fd);
            if (after.nlink !== 1 || before.size !== size || after.size !== size || before.mtimeMs !== after.mtimeMs
              || before.ctimeMs !== after.ctimeMs) throw new Error('Project file changed during capture');
            const actual = realpathSync(fdPath(child));
            if (actual !== path.join(expected, name)) throw new Error('Project file changed during capture');
            total += size;
            files.push({ name, bytes: Buffer.concat(chunks, size), executable: Boolean(before.mode & 0o111) });
          }
        } finally { closeSync(child); }
      }
    } finally { directory.closeSync(); }
  };
  try { walk(root, '', 0); return files.sort((a, b) => a.name.localeCompare(b.name)); }
  finally { closeSync(root); }
}
