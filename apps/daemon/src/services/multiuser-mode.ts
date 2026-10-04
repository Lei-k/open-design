// Multi-user mode switch (issues #3/#4, epic #9) — resolved once at startup.
//
// Semantics (see specs/current/web-multiuser-authz-gate.md):
// - Default OFF. Off means the daemon composes exactly as before: no auth
//   routes, no gate, no ownership table, single-user/desktop behaviour.
// - There is deliberately NO environment switch in this slice. Multi-user
//   mode is enabled only through the programmatic `startServer({ multiUser })`
//   option, which no production entrypoint supplies, and that option must
//   carry the exact `MULTIUSER_NOT_LAUNCH_READY_ACK` literal. Tests use it; an
//   operator cannot flip it on a deployed daemon.
// - Setting any multi-user-looking environment variable REFUSES startup (in
//   either mode) rather than being ignored: an operator who believes they
//   enabled per-user isolation must not silently get a single-tenant daemon.
// - In multi-user mode the single-tenant substitutes for per-user sessions
//   refuse startup:
//     * OD_API_TOKEN set — the token middleware (plus its loopback bypass)
//       authorizes whole-daemon access without any account;
//     * OD_DISABLE_API_AUTH truthy — delegates all auth to a proxy;
//     * a non-loopback bind host — would require one of the two above, and
//       this slice is not deployable (#7/#8 own the deployment gate).
//   The gate itself never consults the peer address, so loopback peers get no
//   bypass either.
//
// This module is pure (no Express, no I/O) so the rule table is unit-tested.

import { realpathSync } from 'node:fs';
import path from 'node:path';
import { apiTokenFromEnv, isApiAuthDisabled } from '../api-token-auth.js';
import { isLoopbackHostname } from '../http/local-daemon-request.js';
import type { ScryptParams } from './auth-passwords.js';

/** The exact acknowledgement the programmatic option must carry. */
export const MULTIUSER_NOT_LAUNCH_READY_ACK =
  'I acknowledge OpenDesign multi-user mode is not launch-ready: #3/#4 authorization gate only; run isolation (#5) and the deployment gate (#7/#8) are not done' as const;

/** Representative forbidden names; startup scans all environment keys. */
export const MULTIUSER_ENV_SWITCH_NAMES: readonly string[] = [
  'OD_MULTIUSER_MODE',
  'OD_MULTIUSER',
  'OD_MULTI_USER',
  'OD_MULTI_USER_MODE',
  'OD_AUTH_MODE',
];

function isMultiUserEnvironmentSwitch(name: string): boolean {
  if (!name.toUpperCase().startsWith('OD_')) return false;
  const normalized = name.toUpperCase().replace(/[_-]/g, '');
  return normalized.includes('MULTIUSER') || normalized === 'ODAUTHMODE';
}

export interface MultiUserAuthServiceOverrides {
  /** Test-only KDF cost override; production keeps the auth-service default. */
  passwordParams?: ScryptParams;
  now?: () => number;
  sessionTtlMs?: number;
  sessionIdleTtlMs?: number;
}

export interface MultiUserModeOptions {
  acknowledgeNotLaunchReady: typeof MULTIUSER_NOT_LAUNCH_READY_ACK;
  /** Exact browser origins allowed to make state-changing requests. */
  allowedOrigins: readonly string[];
  /** One-time first-admin bootstrap secret; null/empty disables bootstrap. */
  bootstrapSecret?: string | null;
  auth?: MultiUserAuthServiceOverrides;
  /** Direct startServer test harness only; must resolve to the repository mock. */
  testMockAgentScript?: string;
  /** Test harness clock for pool accounting. */
  poolClock?: () => number;
  /**
   * Personal-subscription enablement switch (#18), default off. Direct
   * startServer test harness only; must resolve to the repository mock
   * app-server. There is no environment, admin or UI path to a real provider.
   */
  testPersonalCodexAppServer?: string;
}

/** The only app-server the personal-subscription lane may spawn in this slice. */
export const PERSONAL_CODEX_MOCK_RELATIVE_PATH = 'mocks/personal-codex-app-server.ts';

export interface ResolvedMultiUserMode {
  allowedOrigins: readonly string[];
  bootstrapSecret: string | null;
  auth: MultiUserAuthServiceOverrides;
  testMockAgentScript?: string;
  poolClock?: () => number;
  /** Real path of the repository mock app-server; absent means the feature is off. */
  personalCodexAppServer?: string;
}

export class MultiUserModeRefusal extends Error {
  constructor(message: string) {
    super(`multi-user mode refused: ${message}`);
    this.name = 'MultiUserModeRefusal';
  }
}

function assertExactOrigins(origins: unknown): readonly string[] {
  if (!Array.isArray(origins) || origins.length === 0) {
    throw new MultiUserModeRefusal('allowedOrigins must list at least one exact origin');
  }
  for (const origin of origins) {
    let parsed: URL;
    try {
      parsed = new URL(String(origin));
    } catch {
      throw new MultiUserModeRefusal('allowedOrigins must be absolute scheme://host[:port] origins');
    }
    if (parsed.origin !== origin || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
      throw new MultiUserModeRefusal('allowedOrigins must be exact scheme://host[:port] origins');
    }
  }
  return [...origins] as string[];
}

/**
 * Resolve the multi-user mode once, at the top of `startServer`. Returns
 * null for the default single-user mode; throws `MultiUserModeRefusal` for
 * every configuration that must not start.
 */
export function resolveMultiUserMode(input: {
  options: MultiUserModeOptions | null | undefined;
  env: NodeJS.ProcessEnv;
  host: string;
  /** Repository root used to pin the personal app-server to the repository mock. */
  repositoryRoot?: string;
}): ResolvedMultiUserMode | null {
  const { options, env, host } = input;
  for (const [name, value] of Object.entries(env)) {
    if (isMultiUserEnvironmentSwitch(name) && String(value ?? '').trim().length > 0) {
      throw new MultiUserModeRefusal(
        `${name} is set, but this build has no environment switch for multi-user mode ` +
        '(it is test-only and not launch-ready); unset it to run the single-user daemon',
      );
    }
  }
  if (options === undefined || options === null) return null;

  if (options.acknowledgeNotLaunchReady !== MULTIUSER_NOT_LAUNCH_READY_ACK) {
    throw new MultiUserModeRefusal('the not-launch-ready acknowledgement is missing or does not match');
  }
  if (apiTokenFromEnv(env).length > 0) {
    throw new MultiUserModeRefusal(
      'OD_API_TOKEN is set; the single-tenant API token (and its loopback bypass) cannot substitute for per-user sessions',
    );
  }
  if (isApiAuthDisabled(env)) {
    throw new MultiUserModeRefusal('OD_DISABLE_API_AUTH is set; proxy-delegated auth cannot substitute for per-user sessions');
  }
  if (!isLoopbackHostname(host)) {
    throw new MultiUserModeRefusal(
      `bind host ${host} is not loopback; this slice is not deployable and must bind to a loopback host`,
    );
  }
  const allowedOrigins = assertExactOrigins(options.allowedOrigins);
  const bootstrapSecret =
    typeof options.bootstrapSecret === 'string' && options.bootstrapSecret.length > 0 ? options.bootstrapSecret : null;
  const personalCodexAppServer = options.testPersonalCodexAppServer === undefined
    ? undefined : resolvePersonalCodexMock(options.testPersonalCodexAppServer, input.repositoryRoot);
  return { allowedOrigins, bootstrapSecret, auth: { ...(options.auth ?? {}) },
    ...(options.testMockAgentScript ? { testMockAgentScript: options.testMockAgentScript } : {}),
    ...(options.poolClock ? { poolClock: options.poolClock } : {}),
    ...(personalCodexAppServer ? { personalCodexAppServer } : {}) };
}

function resolvePersonalCodexMock(candidate: unknown, repositoryRoot: string | undefined): string {
  const real = (file: string) => { try { return realpathSync(file); } catch { return null; } };
  const expected = repositoryRoot ? real(path.join(repositoryRoot, PERSONAL_CODEX_MOCK_RELATIVE_PATH)) : null;
  const actual = typeof candidate === 'string' && candidate.length > 0 ? real(candidate) : null;
  if (!expected || !actual || actual !== expected) {
    throw new MultiUserModeRefusal('only the repository mock app-server may back personal subscriptions in this slice');
  }
  return actual;
}
