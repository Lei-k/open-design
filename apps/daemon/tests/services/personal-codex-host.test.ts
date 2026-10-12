// Deterministic admission tests: version discovery is a fixture, never a provider/process.
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
const probe = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (original) => ({
  ...await original<typeof import('node:child_process')>(),
  execFile: probe,
}));
import { assertPersonalCodexVersion } from '../../src/services/personal-codex-version.js';
import { PersonalCodexAccounts, runPersonalCodexTurn } from '../../src/services/personal-codex-accounts.js';
import { MULTIUSER_STAGING_DEPLOYMENT_ACK } from '../../src/services/multiuser-mode.js';
const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })); probe.mockReset(); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 's73-host-')); roots.push(root);
  const bin = path.join(root, 'codex'); const host = path.join(root, 'codex-code-mode-host');
  fs.writeFileSync(bin, 'fixture codex', { mode: 0o700 }); fs.writeFileSync(host, 'fixture host', { mode: 0o700 });
  probe.mockImplementation((_binary, _args, _options, callback) => {
    queueMicrotask(() => callback(null, 'codex-cli 0.162.1'));
    return Object.assign(new EventEmitter(), { kill: vi.fn(), stdout: null, stderr: null });
  });
  return { root, bin, host };
}
it('rechecks host on a cached version, refuses a damaged package and admits its repair', async () => {
  const { root, bin, host } = fixture();
  await assertPersonalCodexVersion(bin, root);
  fs.rmSync(host);
  await expect(assertPersonalCodexVersion(bin, root)).rejects.toMatchObject({ code: 'MULTIUSER_CODEX_HOST_UNAVAILABLE' });
  fs.writeFileSync(host, 'fixed host', { mode: 0o700 });
  await expect(assertPersonalCodexVersion(bin, root)).resolves.toBeUndefined();
  expect(probe).toHaveBeenCalledTimes(1);
});
it('refuses login and run before an app-server starts and does not insert a login attempt', async () => {
  const { root, bin, host } = fixture(); fs.rmSync(host);
  const db = new Database(':memory:');
  const accounts = new PersonalCodexAccounts({ db, dataRoot: root, appServerCommand: [bin, 'app-server'] });
  try {
    await expect(accounts.startLogin('actor')).rejects.toMatchObject({ code: 'MULTIUSER_CODEX_HOST_UNAVAILABLE' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM multiuser_agent_login_attempts').get()).toEqual({ n: 0 });
    await expect(runPersonalCodexTurn({ command: [bin, 'app-server'], codexHome: root, home: root, temp: root, cwd: root,
      dataRoot: root, prompt: 'text', resumeThreadId: null, sandboxMode: 'workspace-write' }))
      .rejects.toMatchObject({ code: 'MULTIUSER_CODEX_HOST_UNAVAILABLE' });
    expect(probe).toHaveBeenCalledTimes(1);
  } finally { await accounts.shutdown(); db.close(); }
});
it('logs the typed companion refusal at launcher startup before opening a listener', () => {
  const { root, bin, host } = fixture(); fs.rmSync(host);
  const config = path.join(root, 'config.json'); const log = path.join(root, 'startup.log');
  fs.writeFileSync(config, JSON.stringify({ acknowledge: MULTIUSER_STAGING_DEPLOYMENT_ACK,
    publicOrigin: 'https://studio.example.test', previewOrigin: 'https://preview.example.test',
    personalCodex: { binary: bin, bwrap: '/missing-bwrap' } }));
  const fd = fs.openSync(log, 'w');
  try {
    // File descriptors avoid IPC/loopback entirely, including in restricted writers.
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../dist/multiuser-serve.js', import.meta.url)), '--config', config], {
      stdio: ['ignore', fd, fd], timeout: 10_000, env: { PATH: process.env.PATH, OD_DATA_DIR: root, HOME: root, CODEX_HOME: root },
    });
    expect(result.error).toBeUndefined(); expect(result.status).toBe(1);
    expect(fs.readFileSync(log, 'utf8')).toContain('MULTIUSER_CODEX_HOST_UNAVAILABLE');
    expect(fs.readFileSync(log, 'utf8')).toContain('install the full Codex release package');
  } finally { fs.closeSync(fd); }
});
