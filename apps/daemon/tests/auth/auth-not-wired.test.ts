// Issues #2 → #3/#4 — deliberate tripwire for how multi-user auth is wired.
//
// History: #2 landed the session registrar unmounted, and this file asserted
// server.ts did not import it at all. #3/#4 (this change) deliberately relax
// that: server.ts may now install the multi-user authorization gate, which is
// the ONLY module allowed to mount the auth registrar. The gate and the auth
// routes must be active only when multi-user mode is on, and the mode must not
// be usable as a production switch while #5 (run isolation) and #7/#8
// (deployment gate) are still open:
//
// - there is no environment switch (setting one refuses startup);
// - the mode is enabled only through the programmatic `startServer({ multiUser })`
//   option carrying an exact not-launch-ready acknowledgement, and no
//   production entrypoint (cli, sidecar, daemon-startup) supplies it.
//
// Runtime proof that mode-off registers no auth route and creates no auth or
// ownership state lives in multiuser-mode.test.ts.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MULTIUSER_ENV_SWITCH_NAMES,
  MultiUserModeRefusal,
  resolveMultiUserMode,
} from '../../src/services/multiuser-mode.js';

const daemonSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listSourceFiles(full));
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

const rel = (file: string) => path.relative(daemonSrc, file).split(path.sep).join('/');
const sources = listSourceFiles(daemonSrc).map((file) => ({ file: rel(file), text: readFileSync(file, 'utf8') }));
const server = sources.find((s) => s.file === 'server.ts')!.text;

describe('multi-user auth is reachable only through the opt-in gate', () => {
  it('server.ts does not import the auth registrar, service or store directly', () => {
    expect(server).not.toMatch(/routes\/auth\.js/);
    expect(server).not.toMatch(/registerAuthRoutes|createRequireSession/);
    expect(server).not.toMatch(/services\/auth-service\.js|storage\/auth-store\.js/);
  });

  it('only the multi-user gate module mounts the auth registrar', () => {
    const mounters = sources
      .filter((s) => /registerAuthRoutes\s*\(/.test(s.text) && s.file !== 'routes/auth.ts')
      .map((s) => s.file);
    expect(mounters).toEqual(['http/multiuser-gate.ts']);
  });

  it('server.ts installs the gate only from the resolved (default-off) mode', () => {
    expect(server).toMatch(/multiUser = null/);
    expect(server).toMatch(/resolveMultiUserMode\(/);
    const installs = server.match(/installMultiUserFront\(/g) ?? [];
    expect(installs).toHaveLength(1);
    expect(server).toMatch(/multiUserMode\s*\?\s*installMultiUserFront\(/);
  });
});

describe('multi-user mode is not a production switch', () => {
  it('server.ts reads no multi-user environment variable', () => {
    expect(server).not.toMatch(/OD_MULTIUSER|OD_MULTI_USER|OD_AUTH_MODE/);
  });

  it('no production module supplies the multiUser option or the acknowledgement', () => {
    const allowed = new Set(['server.ts', 'services/multiuser-mode.ts', 'http/multiuser-gate.ts']);
    const offenders = sources
      .filter((s) => !allowed.has(s.file))
      .filter((s) => /\bmultiUser\b|MULTIUSER_NOT_LAUNCH_READY_ACK|not launch-ready/.test(s.text))
      .map((s) => s.file);
    expect(offenders).toEqual([]);
    const ackOwners = sources
      .filter((s) => /MULTIUSER_NOT_LAUNCH_READY_ACK\s*=/.test(s.text))
      .map((s) => s.file);
    expect(ackOwners).toEqual(['services/multiuser-mode.ts']);
  });

  it('an environment switch refuses startup instead of enabling or silently ignoring it', () => {
    for (const name of MULTIUSER_ENV_SWITCH_NAMES) {
      expect(() => resolveMultiUserMode({ options: undefined, env: { [name]: '1' }, host: '127.0.0.1' }))
        .toThrow(MultiUserModeRefusal);
    }
    expect(resolveMultiUserMode({ options: undefined, env: {}, host: '127.0.0.1' })).toBeNull();
  });
});
