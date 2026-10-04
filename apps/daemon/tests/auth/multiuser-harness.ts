// Harness for the multi-user authorization gate tests (#3/#4).
//
// Starts the REAL daemon (`startServer`, port 0) against a fresh temp data
// root. `server.ts` resolves `OD_DATA_DIR` into `RUNTIME_DATA_DIR` at module
// load, so the env var is set here and server.ts is imported dynamically
// afterwards; vitest isolates modules per test file, so each file that uses
// this harness gets exactly one isolated data root.
//
// Requests go through raw node:http so each test controls Cookie, Origin and
// forged identity headers exactly.

import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { MultiUserModeOptions } from '../../src/services/multiuser-mode.js';
import { MULTIUSER_NOT_LAUNCH_READY_ACK } from '../../src/services/multiuser-mode.js';
import { FAST_TEST_SCRYPT_PARAMS, cookiePairFrom, type RawRequest, type RawResponse } from './helpers.js';

export const MU_TEST_ORIGIN = 'https://od-mu.test.invalid';
export const MU_BOOTSTRAP_SECRET = 'multiuser-gate-test-bootstrap-secret-0123456789';

type ServerModule = typeof import('../../src/server.js');

let dataRoot: string | null = null;
let serverModule: ServerModule | null = null;

/** Point this test file at a fresh data root and import server.ts once. */
export async function loadIsolatedServerModule(): Promise<{ mod: ServerModule; dataRoot: string }> {
  if (!serverModule) {
    dataRoot = mkdtempSync(path.join(tmpdir(), 'od-mu-gate-'));
    process.env.OD_DATA_DIR = dataRoot;
    serverModule = await import('../../src/server.js');
  }
  return { mod: serverModule, dataRoot: dataRoot! };
}

export function cleanupIsolatedDataRoot(): void {
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true });
}

export function multiUserOptions(overrides: Partial<MultiUserModeOptions> = {}): MultiUserModeOptions {
  return {
    acknowledgeNotLaunchReady: MULTIUSER_NOT_LAUNCH_READY_ACK,
    allowedOrigins: [MU_TEST_ORIGIN],
    bootstrapSecret: MU_BOOTSTRAP_SECRET,
    auth: { passwordParams: FAST_TEST_SCRYPT_PARAMS },
    ...overrides,
  };
}

export function rawRequest(baseUrl: string, req: RawRequest): Promise<RawResponse> {
  const { port, hostname } = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...(req.headers ?? {}) };
    let payload: string | Buffer | undefined;
    if (req.rawBody !== undefined) payload = req.rawBody;
    else if (req.body !== undefined) {
      payload = JSON.stringify(req.body);
      headers['content-type'] ??= 'application/json';
    }
    if (payload !== undefined) headers['content-length'] = String(Buffer.byteLength(payload));
    if (req.cookie) headers.cookie = req.cookie;
    const outgoing = http.request(
      { host: hostname, port: Number(port), path: req.path, method: req.method ?? 'GET', headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: unknown = null;
          try { json = text ? JSON.parse(text) : null; } catch { json = null; }
          const rawSetCookie = res.headers['set-cookie'];
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text,
            json,
            setCookies: Array.isArray(rawSetCookie) ? rawSetCookie : [],
          });
        });
      },
    );
    outgoing.on('error', reject);
    if (payload !== undefined) outgoing.write(payload);
    outgoing.end();
  });
}

export interface StartedMultiUserDaemon {
  baseUrl: string;
  routeInventory: Array<{ method: string; path: string }>;
  patternRouteInventory: Array<{ method: string; path: string }>;
  pathlessRouteInventory: Array<{ method: string; path: string }>;
  request: (req: RawRequest) => Promise<RawResponse>;
  close: () => Promise<void>;
}

export async function startMultiUserDaemon(
  options: MultiUserModeOptions = multiUserOptions(),
  staticDir?: string,
): Promise<StartedMultiUserDaemon> {
  const { mod } = await loadIsolatedServerModule();
  const started = (await mod.startServer({
    port: 0,
    host: '127.0.0.1',
    returnServer: true,
    multiUser: options,
    ...(staticDir === undefined ? {} : { staticDir }),
  })) as import('../../src/server.js').StartServerResult;
  const baseUrl = started.url;
  return {
    baseUrl,
    routeInventory: started.routeInventory,
    patternRouteInventory: started.patternRouteInventory,
    pathlessRouteInventory: started.pathlessRouteInventory ?? [],
    request: (req) => rawRequest(baseUrl, req),
    close: async () => {
      await Promise.resolve(started.shutdown());
      await new Promise<void>((resolve) => started.server.close(() => resolve()));
    },
  };
}

export async function login(
  daemon: StartedMultiUserDaemon,
  username: string,
  password: string,
): Promise<string> {
  const res = await daemon.request({ method: 'POST', path: '/api/auth/login', body: { username, password } });
  if (res.status !== 200) throw new Error(`login ${username} failed: ${res.status} ${res.text}`);
  const cookie = cookiePairFrom(res.setCookies);
  if (!cookie) throw new Error('login did not set a session cookie');
  return cookie;
}

export interface Principal {
  id: string;
  username: string;
  password: string;
  cookie: string;
}

/** Bootstrap the first admin, then have the admin create `usernames` as ordinary users. */
export async function provisionAccounts(
  daemon: StartedMultiUserDaemon,
  usernames: string[],
): Promise<{ admin: Principal; users: Principal[] }> {
  const adminPassword = 'admin-password-correct-horse';
  const boot = await daemon.request({
    method: 'POST',
    path: '/api/auth/bootstrap',
    body: { bootstrapToken: MU_BOOTSTRAP_SECRET, username: 'root-admin', password: adminPassword },
  });
  if (boot.status !== 201) throw new Error(`bootstrap failed: ${boot.status} ${boot.text}`);
  const adminCookie = await login(daemon, 'root-admin', adminPassword);
  const admin: Principal = { id: boot.json.account.id, username: 'root-admin', password: adminPassword, cookie: adminCookie };
  const users: Principal[] = [];
  for (const username of usernames) {
    const password = `${username}-password-battery-staple`;
    const created = await daemon.request({
      method: 'POST',
      path: '/api/auth/users',
      cookie: admin.cookie,
      body: { username, password, role: 'user' },
    });
    if (created.status !== 201) throw new Error(`create ${username} failed: ${created.status} ${created.text}`);
    users.push({ id: created.json.account.id, username, password, cookie: await login(daemon, username, password) });
  }
  return { admin, users };
}
