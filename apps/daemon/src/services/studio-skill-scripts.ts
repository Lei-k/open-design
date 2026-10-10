import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { sandboxedCommand, type PersonalSandbox } from './personal-sandbox.js';
import type { StudioSkillPackage } from './studio-skill-packages.js';

const OUTPUT_LIMIT = 64 * 1024;
const TIMEOUT_MS = 60_000;
const MAX_ARGS = 32;
const ARG_LIMIT = 4096;

export interface StudioSkillScriptResult { exitCode: number | null; timedOut: boolean; stdout: string; stderr: string }
export type StudioSkillScriptRunner = (request: { skillId: string; path: string; args: readonly string[]; signal: AbortSignal }) => Promise<StudioSkillScriptResult>;

/** Interpreters for captured scripts that ship without an executable bit. */
function interpreterFor(file: string): readonly string[] | null {
  if (/\.py$/u.test(file)) return ['/usr/bin/python3'];
  if (/\.(?:sh|bash)$/u.test(file)) return ['/bin/sh'];
  if (/\.(?:js|mjs|cjs)$/u.test(file)) return [process.execPath];
  return null;
}

/** Embedded catalog skills keep their own SKILL.md root. Their scripts use
 * OD_SKILL_DIR relative to that document, rather than the plugin carrier's
 * generated index. All candidates must already exist in the captured package.
 */
export function studioSkillScriptDirectory(resource: StudioSkillPackage, file: string): string {
  const names = new Set(resource.files.map((entry) => entry.path));
  const parts = file.split('/').slice(0, -1);
  while (parts.length) {
    const relative = parts.join('/');
    if (names.has(`${relative}/SKILL.md`)) return relative;
    parts.pop();
  }
  return '';
}

/** Company pool scripts run the captured bytes of a selected package inside the
 * personal bubblewrap boundary with no network: only the project cwd and a
 * fresh run home are writable, the staged package is read-only, and the
 * daemon data root, other projects and the company API key do not exist
 * inside. Output paths are rewritten before anything reaches the provider. */
export function createStudioSkillScriptRunner(input: {
  sandbox: PersonalSandbox; packages: readonly StudioSkillPackage[]; skillRoot: string; runHome: string; cwd: string;
}): StudioSkillScriptRunner {
  const home = path.join(input.runHome, 'script-home');
  const temp = path.join(home, 'tmp');
  const runtime = path.dirname(process.execPath);
  return async ({ skillId, path: file, args, signal }) => {
    const resource = input.packages.find((item) => item.id === skillId);
    const entry = resource?.files.find((item) => item.path === file);
    if (!resource || !entry || file === 'SKILL.md' || file.endsWith('/SKILL.md')) throw new Error('skill script refused');
    if (args.length > MAX_ARGS || args.some((arg) => typeof arg !== 'string' || arg.length > ARG_LIMIT || arg.includes('\0'))) throw new Error('skill script arguments refused');
    const interpreter = entry.executable ? [] : interpreterFor(file);
    if (!interpreter) throw new Error('skill script is not executable');
    const packageDirectory = path.join(input.skillRoot, resource.key);
    const directory = path.join(packageDirectory, studioSkillScriptDirectory(resource, file));
    const script = path.join(packageDirectory, file);
    fs.mkdirSync(temp, { recursive: true, mode: 0o700 });
    const [bin, ...argv] = sandboxedCommand({ ...input.sandbox, readOnlyPaths: [...input.sandbox.readOnlyPaths, runtime] },
      { codexHome: home, home, temp, cwd: input.cwd, skillPackages: input.skillRoot, network: false },
      [...interpreter, script, ...args] as [string, ...string[]]);
    signal.throwIfAborted();
    return await new Promise<StudioSkillScriptResult>((resolve, reject) => {
      const child = spawn(bin, argv, { stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home, TMPDIR: temp, LANG: 'C.UTF-8', OD_SKILL_DIR: directory } });
      const output = { stdout: '', stderr: '' };
      const collect = (key: keyof typeof output) => (chunk: Buffer) => {
        if (output[key].length < OUTPUT_LIMIT) output[key] = (output[key] + chunk.toString('utf8')).slice(0, OUTPUT_LIMIT);
      };
      child.stdout.on('data', collect('stdout'));
      child.stderr.on('data', collect('stderr'));
      let timedOut = false;
      const stop = () => child.kill('SIGKILL');
      const timer = setTimeout(() => { timedOut = true; stop(); }, TIMEOUT_MS);
      signal.addEventListener('abort', stop, { once: true });
      child.once('error', (error) => { clearTimeout(timer); signal.removeEventListener('abort', stop); reject(error); });
      child.once('close', (code) => {
        clearTimeout(timer); signal.removeEventListener('abort', stop);
        if (signal.aborted) return reject(signal.reason);
        const clean = (text: string) => text.replaceAll(directory, '$OD_SKILL_DIR').replaceAll(input.cwd, '.').replaceAll(input.runHome, '<run>');
        resolve({ exitCode: code, timedOut, stdout: clean(output.stdout), stderr: clean(output.stderr) });
      });
    });
  };
}
