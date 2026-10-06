// Multi-user staging launcher (#7/#18, user decision 2026-10-06).
//
//   node apps/daemon/dist/multiuser-serve.js --config <file>
//
// The one production entry that starts multi-user mode. It is a separate
// program rather than an environment switch, so the startup rule that refuses
// every multi-user-looking environment variable still holds, and the CLI and
// sidecar (`startDaemonRuntime`) still refuse multi-user mode.
//
// Topology (deploy/multiuser/): the daemon binds loopback only. An HTTPS proxy
// shares its network namespace and is the only published listener, so the
// browser reaches the daemon through TLS and nothing else reaches it at all.
// Session cookies are `__Host-` and always Secure, so plain HTTP cannot sign in.
//
// The config file carries the operator acknowledgement, the one public origin,
// an optional one-time bootstrap secret file for the first administrator, and
// an optional real Codex binary for personal subscriptions, which always runs
// in the per-run bubblewrap sandbox. The company pool has no real provider yet
// (#14) and is unavailable. The daemon data root is `OD_DATA_DIR`, which must
// be set explicitly (root AGENTS.md data-directory contract).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { closeHttpServer } from './daemon-startup.js';
import {
  MULTIUSER_NOT_LAUNCH_READY_ACK, MULTIUSER_STAGING_DEPLOYMENT_ACK, PERSONAL_CODEX_REAL_PROVIDER_ACK,
  type MultiUserModeOptions,
} from './services/multiuser-mode.js';

export interface MultiUserServeConfigFile {
  acknowledge: string;
  /** The exact public `https://host[:port]` origin users open. */
  publicOrigin: string;
  /** Loopback port the proxy forwards to; default 7456. */
  port?: number;
  /** File holding the one-time first-administrator bootstrap secret (>= 32 characters). */
  bootstrapSecretFile?: string;
  /** Real Codex for personal subscriptions; omitted means personal subscriptions are off. */
  personalCodex?: { binary: string; bwrap: string };
}

export interface ResolvedMultiUserServe {
  port: number;
  publicOrigin: string;
  multiUser: MultiUserModeOptions;
}

export class MultiUserServeConfigError extends Error {
  constructor(message: string) {
    super(`multiuser-serve: ${message}`);
    this.name = 'MultiUserServeConfigError';
  }
}

const KEYS = new Set(['acknowledge', 'publicOrigin', 'port', 'bootstrapSecretFile', 'personalCodex']);
const MIN_BOOTSTRAP_SECRET = 32;

/** Validate a parsed config file and turn it into `startServer` options. Throws on anything off. */
export function resolveMultiUserServeConfig(raw: unknown,
  readSecret: (file: string) => string = (file) => fs.readFileSync(file, 'utf8')): ResolvedMultiUserServe {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new MultiUserServeConfigError('the config must be a JSON object');
  const config = raw as Record<string, unknown>;
  const unknown = Object.keys(config).filter((key) => !KEYS.has(key));
  if (unknown.length > 0) throw new MultiUserServeConfigError(`unknown config keys: ${unknown.join(', ')}`);
  if (config.acknowledge !== MULTIUSER_STAGING_DEPLOYMENT_ACK) {
    throw new MultiUserServeConfigError('"acknowledge" must be the exact staging deployment acknowledgement');
  }
  let origin: URL;
  try { origin = new URL(String(config.publicOrigin)); } catch { throw new MultiUserServeConfigError('"publicOrigin" must be an https origin'); }
  if (origin.protocol !== 'https:' || origin.origin !== config.publicOrigin) {
    throw new MultiUserServeConfigError('"publicOrigin" must be an exact https://host[:port] origin (sign-in cookies are Secure-only)');
  }
  const port = config.port ?? 7456;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new MultiUserServeConfigError('"port" must be an integer between 1 and 65535');
  }
  let bootstrapSecret: string | null = null;
  if (config.bootstrapSecretFile !== undefined) {
    const file = config.bootstrapSecretFile;
    if (typeof file !== 'string' || !path.isAbsolute(file)) throw new MultiUserServeConfigError('"bootstrapSecretFile" must be an absolute path');
    let secret: string;
    try { secret = readSecret(file).trim(); } catch { throw new MultiUserServeConfigError('"bootstrapSecretFile" cannot be read'); }
    if (secret.length < MIN_BOOTSTRAP_SECRET) {
      throw new MultiUserServeConfigError(`the bootstrap secret must be at least ${MIN_BOOTSTRAP_SECRET} characters`);
    }
    bootstrapSecret = secret;
  }
  const personal = config.personalCodex;
  if (personal !== undefined) {
    const value = personal as Record<string, unknown> | null;
    if (!value || typeof value !== 'object' || typeof value.binary !== 'string' || typeof value.bwrap !== 'string'
        || Object.keys(value).some((key) => key !== 'binary' && key !== 'bwrap')) {
      throw new MultiUserServeConfigError('"personalCodex" must be { "binary": <absolute path>, "bwrap": <absolute path> }');
    }
  }
  const codex = personal as { binary: string; bwrap: string } | undefined;
  return {
    port,
    publicOrigin: origin.origin,
    multiUser: {
      acknowledgeNotLaunchReady: MULTIUSER_NOT_LAUNCH_READY_ACK,
      allowedOrigins: [origin.origin],
      bootstrapSecret,
      ...(codex ? {
        testPersonalCodexRealBinary: { path: codex.binary, acknowledge: PERSONAL_CODEX_REAL_PROVIDER_ACK },
        personalSandbox: { bwrapPath: codex.bwrap },
      } : {}),
    },
  };
}

/** `--config <file>` is the only argument. */
export function parseMultiUserServeArgs(argv: readonly string[]): string {
  if (argv.length !== 2 || argv[0] !== '--config' || !argv[1]) {
    throw new MultiUserServeConfigError('usage: multiuser-serve --config <file>');
  }
  return path.resolve(argv[1]);
}

async function main(): Promise<void> {
  const configPath = parseMultiUserServeArgs(process.argv.slice(2));
  const dataDir = process.env.OD_DATA_DIR;
  if (!dataDir || !path.isAbsolute(dataDir)) {
    throw new MultiUserServeConfigError('OD_DATA_DIR must be set to an absolute daemon data root');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {
    throw new MultiUserServeConfigError(`cannot read a JSON config from ${configPath}`);
  }
  const resolved = resolveMultiUserServeConfig(parsed);
  // Links the daemon builds for the browser point at the public origin, not at loopback.
  process.env.OD_PUBLIC_BASE_URL ??= resolved.publicOrigin;
  // server.ts resolves the data root when it is imported, so it is imported only now.
  const { startServer } = await import('./server.js');
  const started = await startServer({ port: resolved.port, host: '127.0.0.1', returnServer: true,
    multiUser: resolved.multiUser }) as import('./server.js').StartServerResult;
  console.log(`[od] multi-user staging daemon listening on ${started.url} for ${resolved.publicOrigin}`
    + `${resolved.multiUser.testPersonalCodexRealBinary ? ' (personal Codex subscriptions on, sandboxed)' : ''}`);
  let stopping = false;
  const stop = () => {
    if (stopping) process.exit(0);
    stopping = true;
    void Promise.allSettled([Promise.resolve(started.shutdown?.()), closeHttpServer(started.server)])
      .finally(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
