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
// This module has no Express and no I/O beyond path resolution and the injectable
// sandbox probe, so the rule table is unit-tested.

import { accessSync, constants as fsConstants, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { apiTokenFromEnv, isApiAuthDisabled } from '../api-token-auth.js';
import { isLoopbackHostname } from '../http/local-daemon-request.js';
import type { ScryptParams } from './auth-passwords.js';
import { probePersonalSandbox, type PersonalSandbox } from './personal-sandbox.js';

/** The exact acknowledgement the programmatic option must carry. */
export const MULTIUSER_NOT_LAUNCH_READY_ACK =
  'I acknowledge OpenDesign multi-user mode is not launch-ready: #3/#4 authorization gate only; run isolation (#5) and the deployment gate (#7/#8) are not done' as const;

/**
 * What an operator writes into the `multiuser-serve` config file (user decision
 * 2026-10-06, #7/#18): a single-host staging deployment behind an HTTPS proxy.
 * It is not launch approval; the deployment gate (#8) is not done.
 */
export const MULTIUSER_STAGING_DEPLOYMENT_ACK =
  'I am deploying OpenDesign multi-user mode for staging behind an HTTPS proxy; the daemon stays on loopback and the #8 launch gate is not done' as const;

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
  /** Dedicated, cookie-free origin that serves only sandboxed project previews. */
  previewOrigin?: string;
  /** One-time first-admin bootstrap secret; null/empty disables bootstrap. */
  bootstrapSecret?: string | null;
  auth?: MultiUserAuthServiceOverrides;
  /** Direct startServer test harness only; must resolve to the repository mock. */
  testMockAgentScript?: string;
  /** Programmatic provider-fixture injection only; deployment config cannot supply it. */
  testCompanyOpenAIFetch?: typeof fetch;
  /** Test harness clock for pool accounting. */
  poolClock?: () => number;
  /**
   * Personal-subscription enablement switch (#18), default off. Direct
   * startServer test harness only; must resolve to the repository mock
   * app-server. There is no environment, admin or UI path to a real provider.
   */
  testPersonalCodexAppServer?: string;
  /**
   * Real-provider test switch (#18, user decision 2026-10-06): a real `codex`
   * binary for the personal lane. Direct startServer harness only (staging and
   * local acceptance); `startDaemonRuntime` still refuses every multi-user
   * option. Requires `personalSandbox` and the exact acknowledgement.
   */
  testPersonalCodexRealBinary?: { path: string; acknowledge: typeof PERSONAL_CODEX_REAL_PROVIDER_ACK };
  /**
   * Bubblewrap sandbox for every personal app-server child. Mandatory with a
   * real binary; optional with the mock (isolation tests). Startup refuses when
   * bwrap cannot build the sandbox on this host.
   */
  personalSandbox?: { bwrapPath: string };
}

/** The only app-server the personal-subscription lane may spawn without the real-provider switch. */
export const PERSONAL_CODEX_MOCK_RELATIVE_PATH = 'mocks/personal-codex-app-server.ts';

/** The exact acknowledgement the real-provider test switch must carry. */
export const PERSONAL_CODEX_REAL_PROVIDER_ACK =
  'I acknowledge a real Codex provider in the personal lane is a test switch: every child runs sandboxed, but secret custody and two-account end-to-end acceptance (#7/#8) are not done' as const;

/**
 * Credentials stay in each isolated CODEX_HOME. Without this pin the CLI may
 * choose an OS keyring, which every home of the same OS user shares.
 */
export const PERSONAL_CODEX_FILE_CREDENTIALS = ['-c', 'cli_auth_credentials_store="file"'] as const;

export interface ResolvedPersonalCodex {
  command: readonly [string, ...string[]];
  sandbox: PersonalSandbox | null;
  /** True only for the real-provider test switch. */
  realProvider: boolean;
}

export interface ResolvedMultiUserMode {
  allowedOrigins: readonly string[];
  previewOrigin: string;
  bootstrapSecret: string | null;
  auth: MultiUserAuthServiceOverrides;
  testMockAgentScript?: string;
  /** Programmatic provider-fixture injection only; deployment config cannot supply it. */
  testCompanyOpenAIFetch?: typeof fetch;
  poolClock?: () => number;
  /** How personal app-server children start; absent means the feature is off. */
  personalCodex?: ResolvedPersonalCodex;
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
  /** Whether bwrap can build the personal sandbox here (injected in unit tests). */
  probeSandbox?: (bwrapPath: string) => boolean;
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
  const publicOrigin = new URL(allowedOrigins[0]!);
  const previewOrigin = options.previewOrigin ?? `${publicOrigin.protocol}//preview.${publicOrigin.host}`;
  let parsedPreview: URL;
  try { parsedPreview = new URL(previewOrigin); } catch {
    throw new MultiUserModeRefusal('previewOrigin must be an exact https origin');
  }
  const publicHostnames = new Set(allowedOrigins.map((origin) => new URL(origin).hostname));
  if (parsedPreview.protocol !== 'https:' || parsedPreview.origin !== previewOrigin || publicHostnames.has(parsedPreview.hostname)) {
    throw new MultiUserModeRefusal('previewOrigin must be an exact https origin on a different hostname from every public origin');
  }
  const bootstrapSecret =
    typeof options.bootstrapSecret === 'string' && options.bootstrapSecret.length > 0 ? options.bootstrapSecret : null;
  const personalCodex = resolvePersonalCodex(options, input.repositoryRoot,
    input.probeSandbox ?? ((bwrap) => probePersonalSandbox(bwrap, tmpdir())));
  return { allowedOrigins, previewOrigin, bootstrapSecret, auth: { ...(options.auth ?? {}) },
    ...(options.testMockAgentScript ? { testMockAgentScript: options.testMockAgentScript } : {}),
    ...(options.testCompanyOpenAIFetch ? { testCompanyOpenAIFetch: options.testCompanyOpenAIFetch } : {}),
    ...(options.poolClock ? { poolClock: options.poolClock } : {}),
    ...(personalCodex ? { personalCodex } : {}) };
}

function resolvePersonalCodex(options: MultiUserModeOptions, repositoryRoot: string | undefined,
  probeSandbox: (bwrapPath: string) => boolean): ResolvedPersonalCodex | undefined {
  const mock = options.testPersonalCodexAppServer;
  const real = options.testPersonalCodexRealBinary;
  if (mock !== undefined && real !== undefined) {
    throw new MultiUserModeRefusal('choose either the repository mock app-server or the real-provider test switch, not both');
  }
  if (mock === undefined && real === undefined) {
    if (options.personalSandbox !== undefined) throw new MultiUserModeRefusal('personalSandbox needs a personal app-server');
    return undefined;
  }
  let command: [string, ...string[]];
  let readOnlyPaths: string[];
  if (real !== undefined) {
    if (!real || real.acknowledge !== PERSONAL_CODEX_REAL_PROVIDER_ACK) {
      throw new MultiUserModeRefusal('the real-provider acknowledgement is missing or does not match');
    }
    if (options.personalSandbox === undefined) {
      throw new MultiUserModeRefusal('a real Codex provider requires personalSandbox: personal children must not share the daemon filesystem');
    }
    const binary = resolveExecutable(real.path);
    command = [binary, 'app-server', ...PERSONAL_CODEX_FILE_CREDENTIALS];
    // The standalone package keeps helpers (e.g. a bundled bwrap) beside bin/.
    readOnlyPaths = [path.dirname(path.dirname(binary))];
  } else {
    const script = resolvePersonalCodexMock(mock, repositoryRoot);
    command = [process.execPath, script];
    readOnlyPaths = [path.dirname(path.dirname(realpathSync(process.execPath))), path.dirname(script)];
  }
  let sandbox: PersonalSandbox | null = null;
  if (options.personalSandbox !== undefined) {
    const bwrap = options.personalSandbox?.bwrapPath;
    if (typeof bwrap !== 'string' || !path.isAbsolute(bwrap) || !probeSandbox(bwrap)) {
      throw new MultiUserModeRefusal('personalSandbox.bwrapPath cannot build the personal sandbox on this host');
    }
    sandbox = { bwrap, readOnlyPaths };
  }
  return { command, sandbox, realProvider: real !== undefined };
}

function resolveExecutable(candidate: unknown): string {
  let resolved: string;
  try {
    if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) throw new Error('not absolute');
    resolved = realpathSync(candidate);
    if (!statSync(resolved).isFile()) throw new Error('not a file');
    accessSync(resolved, fsConstants.X_OK);
  } catch {
    throw new MultiUserModeRefusal('testPersonalCodexRealBinary.path must be an absolute path to an executable codex binary');
  }
  return resolved;
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
