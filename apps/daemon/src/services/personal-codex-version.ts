import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { codexVersionAtStudioFloor, STUDIO_CODEX_MINIMUM_VERSION } from '../agent-protocol/codex-app-server/capabilities.js';
import { PersonalAccountError } from './personal-codex-accounts.js';
const versions = new Map<string, { mtime: number; supported: boolean }>();
/** No account or provider operation: bounded local version discovery, cached per binary path + mtime. */
export function assertPersonalCodexVersion(binary: string, dataRoot: string): void {
  let supported = false;
  try {
    const resolved = fs.realpathSync(binary);
    const mtime = fs.statSync(resolved).mtimeMs;
    let cached = versions.get(resolved);
    if (!cached || cached.mtime !== mtime) {
      const probe = spawnSync(resolved, ['--version'], { timeout: 5_000, maxBuffer: 4096, encoding: 'utf8', cwd: dataRoot, env: { PATH: process.env.PATH, OD_DATA_DIR: dataRoot, HOME: dataRoot, CODEX_HOME: dataRoot } });
      const match = /^codex(?:-cli)?\s+(\S+)\s*$/u.exec(probe.stdout?.trim() ?? '');
      cached = { mtime, supported: probe.status === 0 && !!match && codexVersionAtStudioFloor(match[1]!) };
      versions.set(resolved, cached);
      if (!cached.supported) console.error(`[Studio] MULTIUSER_CODEX_UNSUPPORTED_VERSION: Codex ${STUDIO_CODEX_MINIMUM_VERSION} or newer required`);
    }
    supported = cached.supported;
  } catch { console.error('[Studio] MULTIUSER_CODEX_UNSUPPORTED_VERSION: version discovery failed'); }
  if (!supported) throw new PersonalAccountError(409, 'MULTIUSER_CODEX_UNSUPPORTED_VERSION', `Codex ${STUDIO_CODEX_MINIMUM_VERSION} or newer is required`);
}
