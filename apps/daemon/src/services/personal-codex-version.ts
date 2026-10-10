import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { codexVersionAtStudioFloor, STUDIO_CODEX_MINIMUM_VERSION } from '../agent-protocol/codex-app-server/capabilities.js';
import { PersonalAccountError } from './personal-codex-accounts.js';
const versions = new Map<string, { mtime: number; promise: Promise<boolean> }>();
const PROBE_TIMEOUT_MS = 5_000;
/** Grace after the child-level timeout before the probe settles regardless of the child or its descendants. */
const PROBE_DEADLINE_GRACE_MS = 1_000;

/**
 * Runs `<binary> --version` and always settles. The child is killed with
 * SIGKILL at `timeoutMs` (a binary that traps SIGTERM cannot keep it alive),
 * and a hard deadline shortly after rejects even when a descendant keeps the
 * output pipe open, so the shared in-flight promise can never stay pending.
 */
function probeVersion(binary: string, options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const child = execFile(binary, ['--version'], { timeout: options.timeoutMs, killSignal: 'SIGKILL', maxBuffer: 4096,
      encoding: 'utf8', cwd: options.cwd, env: options.env }, (error, stdout) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) reject(error); else resolve(stdout);
    });
    const deadline = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch { /* already exited */ }
      child.stdout?.destroy(); child.stderr?.destroy();
      reject(new Error('version probe deadline exceeded'));
    }, options.timeoutMs + PROBE_DEADLINE_GRACE_MS);
    deadline.unref();
  });
}

async function discoverVersion(binary: string, dataRoot: string, timeoutMs: number): Promise<boolean> {
  const home = await fs.mkdtemp(path.join(dataRoot, 'codex-version-probe-'));
  try {
    const stdout = await probeVersion(binary, { timeoutMs, cwd: home, env: { PATH: process.env.PATH, OD_DATA_DIR: dataRoot, HOME: home, CODEX_HOME: home } });
    const match = /^codex(?:-cli)?\s+(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)\s*$/u.exec(stdout.trim());
    if (!match) throw new Error('unparseable version');
    return codexVersionAtStudioFloor(match[1]!);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

/** Bounded async local discovery; only definite versions remain cached by path + mtime. */
export async function assertPersonalCodexVersion(binary: string, dataRoot: string, options: { timeoutMs?: number } = {}): Promise<void> {
  let supported = false;
  try {
    const resolved = await fs.realpath(binary);
    const mtime = (await fs.stat(resolved)).mtimeMs;
    let cached = versions.get(resolved);
    if (!cached || cached.mtime !== mtime) {
      const promise = discoverVersion(resolved, dataRoot, options.timeoutMs ?? PROBE_TIMEOUT_MS).catch((error) => {
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
