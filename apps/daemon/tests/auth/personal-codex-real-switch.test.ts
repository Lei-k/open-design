// Issue #18 — the real-provider test switch and the personal sandbox option
// (user decisions 2026-10-06: per-run sandbox, test switch only). Resolution is
// pure apart from path checks and the injected sandbox probe.
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  MULTIUSER_NOT_LAUNCH_READY_ACK, MultiUserModeRefusal, PERSONAL_CODEX_REAL_PROVIDER_ACK, resolveMultiUserMode,
  type MultiUserModeOptions,
} from '../../src/services/multiuser-mode.js';
import { PERSONAL_CODEX_MOCK } from './personal-codex-helpers.js';

const scratch = fs.mkdtempSync(path.join(tmpdir(), 'od-real-switch-'));
const binary = path.join(scratch, 'release', 'bin', 'codex');
fs.mkdirSync(path.dirname(binary), { recursive: true });
fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
const notExecutable = path.join(scratch, 'codex-noexec');
fs.writeFileSync(notExecutable, '', { mode: 0o644 });
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

const repositoryRoot = path.resolve('../..');
const real = { path: binary, acknowledge: PERSONAL_CODEX_REAL_PROVIDER_ACK };
const sandbox = { bwrapPath: '/usr/bin/bwrap' };

function resolve(extra: Partial<MultiUserModeOptions>, probe: (bwrap: string) => boolean = () => true) {
  return resolveMultiUserMode({
    options: { acknowledgeNotLaunchReady: MULTIUSER_NOT_LAUNCH_READY_ACK, allowedOrigins: ['https://od.test'], ...extra },
    env: {}, host: '127.0.0.1', repositoryRoot, probeSandbox: probe,
  });
}

describe('real-provider test switch', () => {
  it('starts the real binary sandboxed, pinning file-based credentials', () => {
    const probed: string[] = [];
    const personal = resolve({ testPersonalCodexRealBinary: real, personalSandbox: sandbox }, (bwrap) => { probed.push(bwrap); return true; })
      ?.personalCodex;
    expect(probed).toEqual(['/usr/bin/bwrap']);
    expect(personal).toEqual({
      command: [fs.realpathSync(binary), 'app-server', '-c', 'cli_auth_credentials_store="file"'],
      sandbox: { bwrap: '/usr/bin/bwrap', readOnlyPaths: [fs.realpathSync(path.join(scratch, 'release'))] },
      realProvider: true,
    });
  });

  it.each([
    ['without the acknowledgement', { testPersonalCodexRealBinary: { path: binary, acknowledge: 'yes' as never }, personalSandbox: sandbox }],
    ['without a sandbox', { testPersonalCodexRealBinary: real }],
    ['with a relative binary path', { testPersonalCodexRealBinary: { ...real, path: 'codex' }, personalSandbox: sandbox }],
    ['with a missing binary', { testPersonalCodexRealBinary: { ...real, path: path.join(scratch, 'nope') }, personalSandbox: sandbox }],
    ['with a non-executable binary', { testPersonalCodexRealBinary: { ...real, path: notExecutable }, personalSandbox: sandbox }],
    ['next to the mock', { testPersonalCodexRealBinary: real, personalSandbox: sandbox, testPersonalCodexAppServer: PERSONAL_CODEX_MOCK }],
  ] as const)('refuses %s', (_name, extra) => {
    expect(() => resolve(extra as Partial<MultiUserModeOptions>)).toThrow(MultiUserModeRefusal);
  });

  it('refuses when bwrap cannot build the sandbox on this host', () => {
    expect(() => resolve({ testPersonalCodexRealBinary: real, personalSandbox: sandbox }, () => false))
      .toThrow(/cannot build the personal sandbox/);
    expect(() => resolve({ testPersonalCodexRealBinary: real, personalSandbox: { bwrapPath: 'bwrap' } }))
      .toThrow(/cannot build the personal sandbox/);
  });
});

describe('personal sandbox with the mock', () => {
  it('stays unsandboxed by default and sandboxes the mock when asked', () => {
    expect(resolve({ testPersonalCodexAppServer: PERSONAL_CODEX_MOCK })?.personalCodex)
      .toMatchObject({ command: [process.execPath, fs.realpathSync(PERSONAL_CODEX_MOCK)], sandbox: null, realProvider: false });
    const sandboxed = resolve({ testPersonalCodexAppServer: PERSONAL_CODEX_MOCK, personalSandbox: sandbox })?.personalCodex;
    expect(sandboxed?.sandbox?.bwrap).toBe('/usr/bin/bwrap');
    expect(sandboxed?.sandbox?.readOnlyPaths).toContain(path.dirname(fs.realpathSync(PERSONAL_CODEX_MOCK)));
  });

  it('refuses a sandbox with no personal app-server', () => {
    expect(() => resolve({ personalSandbox: sandbox })).toThrow(/needs a personal app-server/);
  });
});
