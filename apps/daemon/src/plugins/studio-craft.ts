import fs from 'node:fs';
import path from 'node:path';
import { isStudioPluginCraftReferences } from '@open-design/contracts';

const SECTION_LIMIT = 128 * 1024;
const TOTAL_LIMIT = 512 * 1024;

/**
 * Capture requested bundled rulebooks at apply, without silently omitting a
 * declared dependency. Only flat, single-link regular UTF-8 files are read;
 * a missing, linked, empty or oversized rulebook refuses the whole apply.
 * The trusted resource root is supplied by daemon startup, never the actor.
 */
export function captureStudioCraft(craftRoot: string | undefined, requested: unknown): { body: string; sections: string[] } {
  if (!isStudioPluginCraftReferences(requested)) throw new Error('invalid plugin craft references');
  if (requested.length === 0) return { body: '', sections: [] };
  if (!craftRoot) throw new Error('plugin craft resources unavailable');
  const root = fs.realpathSync(craftRoot);
  const parts: string[] = [];
  let total = 0;
  for (const slug of requested) {
    const fd = fs.openSync(path.join(root, `${slug}.md`), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > SECTION_LIMIT) throw new Error('plugin craft file refused');
      // Read to the bound, rather than trusting a stat size that can change.
      const bytes = Buffer.alloc(SECTION_LIMIT + 1);
      let offset = 0;
      for (;;) {
        const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (!count) break;
        offset += count;
        if (offset > SECTION_LIMIT) throw new Error('plugin craft section too large');
      }
      const after = fs.fstatSync(fd);
      if (after.nlink !== 1 || stat.size !== offset || after.size !== offset
        || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) throw new Error('plugin craft content changed');
      total += offset;
      if (total > TOTAL_LIMIT) throw new Error('plugin craft context too large');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset)).trim();
      if (!text) throw new Error('plugin craft section empty');
      parts.push(`### ${slug}\n\n${text}`);
    } finally { fs.closeSync(fd); }
  }
  return { body: parts.join('\n\n---\n\n'), sections: [...requested] };
}
