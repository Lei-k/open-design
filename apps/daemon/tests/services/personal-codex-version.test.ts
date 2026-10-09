import { mkdtempSync, writeFileSync, readFileSync, rmSync, utimesSync } from 'node:fs';
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
  it.each(['codex-cli 0.154.0', 'unknown', 'codex-cli 0.162.1-alpha.1'])('refuses unsupported or unparseable %s with a stable code', (version) => {
    const { bin } = binary(version);
    expect(() => assertPersonalCodexVersion(bin, path.dirname(bin))).toThrowError(expect.objectContaining({ code: 'MULTIUSER_CODEX_UNSUPPORTED_VERSION' }));
  });
  it('accepts the deployment floor once per path and mtime and invalidates on replacement', () => {
    const { bin, calls } = binary('codex-cli 0.162.1');
    assertPersonalCodexVersion(bin, path.dirname(bin)); assertPersonalCodexVersion(bin, path.dirname(bin));
    expect(readFileSync(calls, 'utf8')).toBe('1');
    const changed = new Date(Date.now() + 2000); utimesSync(bin, changed, changed);
    assertPersonalCodexVersion(bin, path.dirname(bin)); expect(readFileSync(calls, 'utf8')).toBe('11');
  });
  it('refuses login and verification/run children before an unsupported binary can start', async () => {
    const { bin, calls } = binary('codex-cli 0.154.0');
    const db = new Database(':memory:');
    try {
      const accounts = new PersonalCodexAccounts({ db, dataRoot: path.dirname(bin), appServerCommand: [bin, 'app-server'] });
      await expect(accounts.startLogin('actor')).rejects.toMatchObject({ code: 'MULTIUSER_CODEX_UNSUPPORTED_VERSION' });
      expect(db.prepare('SELECT COUNT(*) AS n FROM multiuser_agent_login_attempts').get()).toEqual({ n: 0 });
      expect(() => runPersonalCodexTurn({ command: [bin, 'app-server'], codexHome: path.dirname(bin), home: path.dirname(bin),
        temp: path.dirname(bin), cwd: path.dirname(bin), dataRoot: path.dirname(bin), prompt: 'text', resumeThreadId: null, sandboxMode: 'workspace-write' }))
        .toThrowError(expect.objectContaining({ code: 'MULTIUSER_CODEX_UNSUPPORTED_VERSION' }));
      expect(readFileSync(calls, 'utf8')).toBe('1');
      await accounts.shutdown();
    } finally { db.close(); }
  });
  it('fails closed on a missing binary', () => {
    expect(() => assertPersonalCodexVersion('/does-not-exist/codex', tmpdir())).toThrowError(expect.objectContaining({ code: 'MULTIUSER_CODEX_UNSUPPORTED_VERSION' }));
  });
});
