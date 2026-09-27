// Shared harness for the issue #2 auth-foundation tests.
//
// Everything here is local-only: a temp data root created per test, a manual
// clock, and a raw node:http client (so tests control Cookie/Origin/forged
// headers exactly instead of relying on a fetch implementation's header
// policy or cookie jar).

import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { MIN_SCRYPT_LOG_N, type ScryptParams } from '../../src/services/auth-passwords.js';
import { AuthService, type AuthServiceOptions } from '../../src/services/auth-service.js';
import { AuthStore } from '../../src/storage/auth-store.js';
import { registerAuthRoutes, type RegisterAuthRoutesDeps } from '../../src/routes/auth.js';

/**
 * Structural-floor scrypt cost, used ONLY to keep the suites fast. The
 * production default is pinned in auth-passwords.test.ts.
 */
export const FAST_TEST_SCRYPT_PARAMS: ScryptParams = { logN: MIN_SCRYPT_LOG_N, r: 8, p: 1 };

export const T0 = 1_800_000_000_000;

export class ManualClock {
  current = T0;
  now = (): number => this.current;
  advance(ms: number): void {
    this.current += ms;
  }
}

export function makeTempDataRoot(): { dataRoot: string; cleanup: () => void } {
  const dataRoot = mkdtempSync(path.join(tmpdir(), 'od-auth-test-'));
  return { dataRoot, cleanup: () => rmSync(dataRoot, { recursive: true, force: true }) };
}

export function openTestAuth(
  dataRoot: string,
  clock: ManualClock,
  options: Partial<Omit<AuthServiceOptions, 'store' | 'now'>> = {},
): { store: AuthStore; service: AuthService } {
  const store = AuthStore.open({ dataRoot });
  const service = new AuthService({
    store,
    now: clock.now,
    passwordParams: FAST_TEST_SCRYPT_PARAMS,
    ...options,
  });
  return { store, service };
}

export interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  json: any;
  setCookies: string[];
}

export interface RawRequest {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
  cookie?: string | null;
  rawBody?: string | Buffer;
  /** Send without Content-Length (Transfer-Encoding: chunked), in two writes. */
  chunked?: boolean;
}

export interface AuthHarness {
  baseUrl: string;
  request: (req: RawRequest) => Promise<RawResponse>;
  close: () => Promise<void>;
}

export const TEST_ORIGIN = 'https://od.test.invalid';

export interface AuthHarnessOptions {
  /** Install middleware BEFORE the auth registrar (e.g. the production global body parser). */
  setup?: (app: express.Express) => void;
}

export async function startAuthHarness(
  deps: Omit<RegisterAuthRoutesDeps, 'allowedOrigins'> & { allowedOrigins?: readonly string[] },
  options: AuthHarnessOptions = {},
): Promise<AuthHarness> {
  const app = express();
  options.setup?.(app);
  registerAuthRoutes(app, { allowedOrigins: [TEST_ORIGIN], ...deps });
  // Anything not owned by the auth registrar falls through to 404, which lets
  // tests prove there is no signup/registration surface.
  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'not found' } });
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  const request = (req: RawRequest): Promise<RawResponse> => new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...(req.headers ?? {}) };
    let payload: string | Buffer | undefined;
    if (req.rawBody !== undefined) {
      payload = req.rawBody;
    } else if (req.body !== undefined) {
      payload = JSON.stringify(req.body);
      headers['content-type'] ??= 'application/json';
    }
    if (payload !== undefined && !req.chunked) headers['content-length'] = String(Buffer.byteLength(payload));
    if (req.cookie) headers.cookie = req.cookie;
    const outgoing = http.request(
      { host: '127.0.0.1', port, path: req.path, method: req.method ?? 'GET', headers },
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
    if (payload !== undefined && req.chunked) {
      payload = Buffer.from(payload);
      const mid = Math.floor(payload.length / 2);
      outgoing.write(payload.subarray(0, mid));
      outgoing.write(payload.subarray(mid));
    } else if (payload !== undefined) {
      outgoing.write(payload);
    }
    outgoing.end();
  });

  return {
    baseUrl,
    request,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Turn a Set-Cookie header into the `name=value` pair a browser would send back. */
export function cookiePairFrom(setCookies: string[]): string | null {
  const first = setCookies[0];
  if (!first) return null;
  const pair = first.split(';', 1)[0]!.trim();
  const eq = pair.indexOf('=');
  if (eq <= 0 || pair.slice(eq + 1).length === 0) return null;
  return pair;
}
