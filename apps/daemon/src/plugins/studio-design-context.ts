import { createHash } from 'node:crypto';
import path from 'node:path';
import type { DesignSystemDetail } from '@open-design/contracts';
import { captureStudioResource, type StudioSnapshotFile } from '../projects/studio-snapshot.js';

export interface StudioPluginDesignContext {
  id: string;
  title: string;
  prompt: string;
  files: StudioSnapshotFile[];
}

/** Capture the entire bundled brand package or an authorized private document.
 * Runs receive package bytes, never a live host path or host-global tools.
 */
export function captureStudioPluginDesignContext(system: DesignSystemDetail, designSystemsRoot?: string): StudioPluginDesignContext {
  if (typeof system.body !== 'string' || !system.body.trim() || Buffer.byteLength(system.body) > 256 * 1024) throw new Error('design document unavailable');
  let files: StudioSnapshotFile[];
  if (system.source === 'built-in') {
    if (!designSystemsRoot || !/^[\w-]{1,128}$/.test(system.id)) throw new Error('design package unavailable');
    files = captureStudioResource(designSystemsRoot, path.join(designSystemsRoot, system.id));
    const design = files.find((file) => file.name === 'DESIGN.md');
    if (!design || new TextDecoder('utf-8', { fatal: true }).decode(design.bytes).trim() !== system.body.trim()) throw new Error('design package changed during capture');
  } else if (system.source === 'user' && system.id.startsWith('user:')) {
    // Account documents are text-only; never inspect host user folders.
    files = [{ name: 'DESIGN.md', bytes: Buffer.from(system.body) }];
  } else throw new Error('design source unavailable');
  const prefix = `opendesign-context/design-${createHash('sha256').update(system.id).digest('hex').slice(0, 32)}`;
  const prompt = `## Applied plugin design system — ${system.title}\n\n`
    + `Treat this captured DESIGN.md as authoritative for color, typography, spacing and component rules. Preserve the brand's token values. `
    + `The complete captured brand package is under ${prefix}/ in the plugin resource package. Read its manifest, tokens and component references there; use captured resource tools instead of host design-system commands.\n\n`
    + system.body.trim();
  return { id: system.id, title: system.title, prompt, files: files.map((file) => ({ ...file, name: `${prefix}/${file.name}` })) };
}
