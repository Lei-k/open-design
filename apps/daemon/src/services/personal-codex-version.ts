import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { codexVersionAtStudioFloor, STUDIO_CODEX_MINIMUM_VERSION } from '../agent-protocol/codex-app-server/capabilities.js';
import { PersonalAccountError } from './personal-codex-accounts.js';
const probeVersion = promisify(execFile);
const versions = new Map<string, { mtime: number; promise: Promise<boolean> }>();

async function discoverVersion(binary: string, dataRoot: string): Promise<boolean> {
  const home = await fs.mkdtemp(path.join(dataRoot, 'codex-version-probe-'));
  try {
    const { stdout } = await probeVersion(binary, ['--version'], { timeout: 5_000, maxBuffer: 4096, encoding: 'utf8',
      cwd: home, env: { PATH: process.env.PATH, OD_DATA_DIR: dataRoot, HOME: home, CODEX_HOME: home } });
    const match = /^codex(?:-cli)?\s+(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)\s*$/u.exec(stdout.trim());
    if (!match) throw new Error('unparseable version');
    return codexVersionAtStudioFloor(match[1]!);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

/** Bounded async local discovery; only definite versions remain cached by path + mtime. */
export async function assertPersonalCodexVersion(binary: string, dataRoot: string): Promise<void> {
  let supported = false;
  try {
    const resolved = await fs.realpath(binary);
    const mtime = (await fs.stat(resolved)).mtimeMs;
    let cached = versions.get(resolved);
    if (!cached || cached.mtime !== mtime) {
      const promise = discoverVersion(resolved, dataRoot).catch((error) => {
        if (versions.get(resolved)?.promise === promise) versions.delete(resolved);
        throw error;
      });
      cached = { mtime, promise };
      versions.set(resolved, cached);
    }
    supported = await cached.promise;
  } catch { /* Transient discovery failure refuses this request; the next request re-probes. */ }
  if (!supported) {
    console.error(`[Studio] MULTIUSER_CODEX_UNSUPPORTED_VERSION: Codex ${STUDIO_CODEX_MINIMUM_VERSION} or newer required; version discovery refused`);
    throw new PersonalAccountError(409, 'MULTIUSER_CODEX_UNSUPPORTED_VERSION', `Codex ${STUDIO_CODEX_MINIMUM_VERSION} or newer is required`);
  }
}
