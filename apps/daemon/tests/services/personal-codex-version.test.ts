import { mkdtempSync, writeFileSync, readFileSync, rmSync, utimesSync, existsSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { PersonalCodexAccounts, runPersonalCodexTurn } from '../../src/services/personal-codex-accounts.js';
import { assertPersonalCodexVersion } from '../../src/services/personal-codex-version.js';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function binary(version: string) {
  const root = mkdtempSync(path.join(tmpdir(), 's57-version-')); roots.push(root);
  const bin = path.join(root, 'codex'); const calls = path.join(root, 'calls');
  writeFileSync(bin, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(calls)}, '1'); process.stdout.write(${JSON.stringify(version)});`, { mode: 0o700 });
  return { bin, calls };
}
describe('personal Codex version floor', () => {
  it('does not cache a timeout and re-probes the next request', async () => {
    const { bin, calls } = binary('');
    writeFileSync(bin, `#!${process.execPath}\nconst fs = require('node:fs'); fs.appendFileSync(${JSON.stringify(calls)}, '1');
if (fs.readFileSync(${JSON.stringify(calls)}, 'utf8').length === 1) setInterval(() => {}, 1000);
else process.stdout.write('codex-cli 0.162.1');`, { mode: 0o700 });
    // The real child/OS timeout boundary cannot be advanced by Vitest's clock.
    await expect(Promise.resolve().then(() => assertPersonalCodexVersion(bin, path.dirname(bin))))
      .rejects.toMatchObject({ code: 'MULTIUSER_CODEX_UNSUPPORTED_VERSION' });
    await expect(Promise.resolve().then(() => assertPersonalCodexVersion(bin, path.dirname(bin)))).resolves.toBeUndefined();
    expect(readFileSync(calls, 'utf8')).toBe('11');
  });
  it('uses and removes a dedicated empty probe home without polluting the data root', async () => {
    const { bin } = binary(''); const root = path.dirname(bin); const trace = path.join(root, 'probe-env');
    writeFileSync(bin, `#!${process.execPath}\nconst fs = require('node:fs'); const path = require('node:path');
fs.writeFileSync(${JSON.stringify(trace)}, JSON.stringify({ cwd: process.cwd(), home: process.env.HOME, codexHome: process.env.CODEX_HOME, entries: fs.readdirSync(process.cwd()) }));
fs.mkdirSync(path.join(process.env.CODEX_HOME, 'tmp', 'arg0'), { recursive: true }); process.stdout.write('codex-cli 0.162.1');`, { mode: 0o700 });
    await assertPersonalCodexVersion(bin, root);
    const env = JSON.parse(readFileSync(trace, 'utf8'));
    expect(env.cwd).not.toBe(root); expect(path.dirname(env.cwd)).toBe(root);
    expect(env.home).toBe(env.cwd); expect(env.codexHome).toBe(env.cwd); expect(env.entries).toEqual([]);
    expect(existsSync(env.cwd)).toBe(false); expect(readdirSync(root).sort()).toEqual(['codex', 'probe-env']);
  });
  it('shares an asynchronous probe across concurrent admissions', async () => {
    const { bin, calls } = binary('codex-cli 0.162.1');
    const probes = [assertPersonalCodexVersion(bin, path.dirname(bin)), assertPersonalCodexVersion(bin, path.dirname(bin))];
    try { expect(probes.every((probe) => probe instanceof Promise)).toBe(true); }
    finally { await Promise.allSettled(probes); }
    expect(readFileSync(calls, 'utf8')).toBe('1');
  });
  it('does not cache a signalled probe', async () => {
    const { bin, calls } = binary('');
    writeFileSync(bin, `#!${process.execPath}\nconst fs = require('node:fs'); fs.appendFileSync(${JSON.stringify(calls)}, '1');
if (fs.readFileSync(${JSON.stringify(calls)}, 'utf8').length === 1) process.kill(process.pid, 'SIGTERM');
else process.stdout.write('codex-cli 0.162.1');`, { mode: 0o700 });
    await expect(assertPersonalCodexVersion(bin, path.dirname(bin))).rejects.toMatchObject({ code: 'MULTIUSER_CODEX_UNSUPPORTED_VERSION' });
    await assertPersonalCodexVersion(bin, path.dirname(bin));
    expect(readFileSync(calls, 'utf8')).toBe('11');
  });
  it('does not cache a spawn error when the binary mtime has not changed', async () => {
    const { bin, calls } = binary(''); const interpreter = path.join(path.dirname(bin), 'interpreter');
    writeFileSync(bin, `#!${interpreter}\nrequire('node:fs').appendFileSync(${JSON.stringify(calls)}, '1'); process.stdout.write('codex-cli 0.162.1');`, { mode: 0o700 });
    await expect(assertPersonalCodexVersion(bin, path.dirname(bin))).rejects.toMatchObject({ code: 'MULTIUSER_CODEX_UNSUPPORTED_VERSION' });
    symlinkSync(process.execPath, interpreter);
    await assertPersonalCodexVersion(bin, path.dirname(bin));
    expect(readFileSync(calls, 'utf8')).toBe('1');
  });
  it('does not retain an unparseable probe result', async () => {
    const { bin, calls } = binary('unknown');
    for (let n = 0; n < 2; n++) await expect(assertPersonalCodexVersion(bin, path.dirname(bin)))
      .rejects.toMatchObject({ code: 'MULTIUSER_CODEX_UNSUPPORTED_VERSION' });
    expect(readFileSync(calls, 'utf8')).toBe('11');
  });
  it('returns null when persisted identity version discovery fails', async () => {
    const { bin } = binary('codex-cli 0.154.0'); const db = new Database(':memory:');
    const accounts = new PersonalCodexAccounts({ db, dataRoot: path.dirname(bin), appServerCommand: [bin, 'app-server'] });
    try {
      const reader = accounts as unknown as { readPersistedIdentity(home: string): Promise<unknown> };
      await expect(reader.readPersistedIdentity(path.dirname(bin))).resolves.toBeNull();
    } finally { await accounts.shutdown(); db.close(); }
  });
  it.each(['codex-cli 0.154.0', 'unknown', 'codex-cli 0.162.1-alpha.1'])('refuses unsupported or unparseable %s with a stable code', async (version) => {
    const { bin } = binary(version);
    await expect(assertPersonalCodexVersion(bin, path.dirname(bin))).rejects.toMatchObject(expect.objectContaining({ code: 'MULTIUSER_CODEX_UNSUPPORTED_VERSION' }));
  });
  it('accepts the deployment floor once per path and mtime and invalidates on replacement', async () => {
    const { bin, calls } = binary('codex-cli 0.162.1');
    await assertPersonalCodexVersion(bin, path.dirname(bin)); await assertPersonalCodexVersion(bin, path.dirname(bin));
    expect(readFileSync(calls, 'utf8')).toBe('1');
    const changed = new Date(Date.now() + 2000); utimesSync(bin, changed, changed);
    await assertPersonalCodexVersion(bin, path.dirname(bin)); expect(readFileSync(calls, 'utf8')).toBe('11');
  });
  it('refuses login and verification/run children before an unsupported binary can start', async () => {
    const { bin, calls } = binary('codex-cli 0.154.0');
    const db = new Database(':memory:');
    try {
      const accounts = new PersonalCodexAccounts({ db, dataRoot: path.dirname(bin), appServerCommand: [bin, 'app-server'] });
      await expect(accounts.startLogin('actor')).rejects.toMatchObject({ code: 'MULTIUSER_CODEX_UNSUPPORTED_VERSION' });
      expect(db.prepare('SELECT COUNT(*) AS n FROM multiuser_agent_login_attempts').get()).toEqual({ n: 0 });
      await expect(runPersonalCodexTurn({ command: [bin, 'app-server'], codexHome: path.dirname(bin), home: path.dirname(bin),
        temp: path.dirname(bin), cwd: path.dirname(bin), dataRoot: path.dirname(bin), prompt: 'text', resumeThreadId: null, sandboxMode: 'workspace-write' }))
        .rejects.toMatchObject(expect.objectContaining({ code: 'MULTIUSER_CODEX_UNSUPPORTED_VERSION' }));
      expect(readFileSync(calls, 'utf8')).toBe('1');
      await accounts.shutdown();
    } finally { db.close(); }
  });
  it('fails closed on a missing binary', async () => {
    await expect(assertPersonalCodexVersion('/does-not-exist/codex', tmpdir())).rejects.toMatchObject(expect.objectContaining({ code: 'MULTIUSER_CODEX_UNSUPPORTED_VERSION' }));
  });
});
