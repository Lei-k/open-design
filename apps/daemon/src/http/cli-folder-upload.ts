import { constants, closeSync, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { STUDIO_SNAPSHOT_LIMITS, type StudioSnapshotFile } from '../projects/studio-snapshot.js';
import { validateProjectPath } from '../projects.js';

/** Files explicitly selected by the CLI's own OS principal. Unlike privileged
 * managed-project capture, this works without Linux /proc on the client. */
export function captureCliFolder(folder: string): StudioSnapshotFile[] {
  const root = realpathSync(folder);
  if (lstatSync(folder).isSymbolicLink() || !lstatSync(root).isDirectory()) throw new Error('Select a directory, not a symbolic link');
  const files: StudioSnapshotFile[] = [];
  let total = 0;
  let visited = 0;
  const walk = (directory: string, prefix: string, depth: number) => {
    if (depth > STUDIO_SNAPSHOT_LIMITS.depth) throw new Error('Folder depth limit exceeded');
    if (realpathSync(directory) !== directory || !lstatSync(directory).isDirectory()) throw new Error('Folder changed during upload');
    for (const name of readdirSync(directory).sort()) {
      if (++visited > 2000) throw new Error('Folder entry limit exceeded');
      if (name.startsWith('.') || name === 'node_modules' || name.endsWith('.artifact.json')) continue;
      const relative = validateProjectPath(prefix + name) as string;
      const target = path.join(directory, name);
      const stat = lstatSync(target);
      if (stat.isSymbolicLink()) throw new Error('Folder symbolic links cannot be uploaded');
      if (stat.isDirectory()) { walk(target, relative + '/', depth + 1); continue; }
      if (!stat.isFile() || stat.nlink !== 1) throw new Error('Folder contains an unsupported file');
      if (realpathSync(target) !== target) throw new Error('Folder changed during upload');
      const fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      try {
        const before = fstatSync(fd);
        if (!before.isFile() || before.nlink !== 1 || before.ino !== stat.ino || before.dev !== stat.dev
          || before.size > STUDIO_SNAPSHOT_LIMITS.fileBytes || total + before.size > STUDIO_SNAPSHOT_LIMITS.bytes
          || files.length >= STUDIO_SNAPSHOT_LIMITS.files) throw new Error('Folder file or upload limit refused');
        const bytes = Buffer.alloc(before.size);
        let read = 0;
        while (read < bytes.length) {
          const count = readSync(fd, bytes, read, bytes.length - read, read);
          if (!count) throw new Error('File changed during upload');
          read += count;
        }
        const after = fstatSync(fd);
        const current = lstatSync(target);
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
          || after.nlink !== 1 || current.ino !== after.ino || current.dev !== after.dev || realpathSync(target) !== target)
          throw new Error('File changed during upload');
        total += bytes.length;
        files.push({ name: relative, bytes });
      } finally { closeSync(fd); }
    }
  };
  walk(root, '', 0);
  if (!files.length) throw new Error('Folder has no uploadable files');
  return files;
}
