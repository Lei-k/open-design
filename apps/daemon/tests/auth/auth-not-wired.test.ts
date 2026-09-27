// Issue #2 — fail-closed gate for the multi-user auth foundation.
//
// The session registrar authenticates *who* is calling but nothing else in
// the daemon is yet scoped to that actor: projects, conversations, runs,
// files, previews and static serving are still global. Wiring the registrar
// into the production server before resource/run/file authorization
// (#3/#4/#5) lands would let any signed-in account reach every other
// account's data behind a "logged in" veneer.
//
// This tripwire therefore asserts that the production composition root does
// not import or register the auth routes and that no multi-user toggle
// exists. The PR that lands #3/#4/#5 authorization is the one that should
// update this test, deliberately.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const daemonSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');

describe('auth foundation is not reachable from the production daemon', () => {
  it('server.ts neither imports nor registers the auth registrar', () => {
    const server = readFileSync(path.join(daemonSrc, 'server.ts'), 'utf8');
    expect(server).not.toMatch(/routes\/auth\.js/);
    expect(server).not.toMatch(/registerAuthRoutes|createRequireSession/);
    expect(server).not.toMatch(/services\/auth-service\.js|storage\/auth-store\.js/);
  });

  it('introduces no multi-user runtime toggle', () => {
    const server = readFileSync(path.join(daemonSrc, 'server.ts'), 'utf8');
    expect(server).not.toMatch(/OD_MULTIUSER|OD_MULTI_USER|OD_AUTH_MODE/);
  });
});
