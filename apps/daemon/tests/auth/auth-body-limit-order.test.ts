// Issue #2 P1 — the auth body bound must hold regardless of middleware order.
//
// The production composition root (src/server.ts) installs a global
// `express.json({ limit: '4mb' })` BEFORE any route registrar. body-parser is
// a no-op once a body has been read, so an auth-scoped 16kb parser installed
// by the registrar cannot bound a body the global parser already accepted.
// These tests run every case in two orders:
//
//   isolated   — registerAuthRoutes on a bare app (the registrar's own parser)
//   production — the server's actual global JSON parser first, then the
//                registrar (the order a future mount would produce)
//
// and require that oversized / unmeasurable bodies are refused before any
// KDF-bearing service method (login, bootstrap, account create, password
// change/reset) is invoked, while legal bodies up to the bound still work.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTH_BODY_LIMIT_BYTES } from '../../src/routes/auth.js';
import type { AuthService } from '../../src/services/auth-service.js';
import type { AuthStore } from '../../src/storage/auth-store.js';
import {
  ManualClock,
  makeTempDataRoot,
  openTestAuth,
  startAuthHarness,
  type AuthHarness,
  type RawRequest,
} from './helpers.js';

const BOOTSTRAP_SECRET = 'bootstrap-secret-for-tests-only-000000';
const ADMIN_PW = 'admin-password-000';
const ALICE_PW = 'alice-password-111';
/** Body size from the reviewer's probe that reached auth.login with HTTP 200. */
const REVIEWER_PROBE_BYTES = 20_514;

const daemonSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');

/** Read the production global JSON parser limit from server.ts itself. */
function productionGlobalJsonLimit(): string {
  const server = readFileSync(path.join(daemonSrc, 'server.ts'), 'utf8');
  const match = /^\s*app\.use\(acknowledgePathlessUse\(express\.json\(\{ limit: '(\d+(?:kb|mb))' \}\), 'json-parser'\)\);/m.exec(server);
  if (!match) throw new Error('server.ts global express.json parser not found; update this test deliberately');
  return match[1]!;
}

const ORDERS = {
  isolated: undefined,
  production: (app: express.Express) => {
    app.use(express.json({ limit: productionGlobalJsonLimit() }));
  },
} as const;

/** A JSON object padded with an ignored field to exactly `bytes` UTF-8 bytes. */
function paddedJson(fields: Record<string, unknown>, bytes: number): string {
  const base = JSON.stringify({ ...fields, pad: '' });
  const padLength = bytes - Buffer.byteLength(base);
  if (padLength < 0) throw new Error('target size smaller than base body');
  const body = JSON.stringify({ ...fields, pad: 'x'.repeat(padLength) });
  expect(Buffer.byteLength(body)).toBe(bytes);
  return body;
}

let cleanup: () => void = () => {};
let store: AuthStore;
let service: AuthService;
let harness: AuthHarness | undefined;
let adminCookie = '';
let kdfCalls: Record<string, ReturnType<typeof vi.spyOn>> = {};

async function seed(): Promise<void> {
  await service.bootstrapFirstAdmin({ username: 'root', password: ADMIN_PW });
  const { session } = await service.login({ username: 'root', password: ADMIN_PW });
  const admin = service.resolveSession(session.token)!;
  await service.createAccount(admin, { username: 'alice', password: ALICE_PW, role: 'user' });
  adminCookie = `__Host-od_session=${session.token}`;
}

function spyOnKdfMethods(): void {
  kdfCalls = {
    login: vi.spyOn(service, 'login'),
    bootstrapFirstAdmin: vi.spyOn(service, 'bootstrapFirstAdmin'),
    createAccount: vi.spyOn(service, 'createAccount'),
    changeOwnPassword: vi.spyOn(service, 'changeOwnPassword'),
    resetPassword: vi.spyOn(service, 'resetPassword'),
  };
}

function totalKdfCalls(): number {
  return Object.values(kdfCalls).reduce((sum, spy) => sum + spy.mock.calls.length, 0);
}

beforeEach(async () => {
  let dataRoot: string;
  ({ dataRoot, cleanup } = makeTempDataRoot());
  ({ store, service } = openTestAuth(dataRoot, new ManualClock()));
  await seed();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await harness?.close();
  harness = undefined;
  store.close();
  cleanup();
});

for (const [order, setup] of Object.entries(ORDERS)) {
  describe(`auth body bound — ${order} middleware order`, () => {
    beforeEach(async () => {
      harness = await startAuthHarness(
        { auth: service, bootstrapSecret: BOOTSTRAP_SECRET },
        setup ? { setup } : {},
      );
      spyOnKdfMethods();
    });

    function call(req: RawRequest) {
      return harness!.request(req);
    }

    it('accepts a legal login body of exactly the bound', async () => {
      const res = await call({
        method: 'POST',
        path: '/api/auth/login',
        headers: { 'content-type': 'application/json' },
        rawBody: paddedJson({ username: 'alice', password: ALICE_PW }, AUTH_BODY_LIMIT_BYTES),
      });
      expect(res.status).toBe(200);
      expect(res.json.account).toMatchObject({ username: 'alice' });
      expect(kdfCalls.login!.mock.calls).toHaveLength(1);
    });

    it('refuses oversized bodies with 413 before any KDF-bearing call', async () => {
      const targets: Array<{ path: string; fields: Record<string, unknown>; cookie?: string }> = [
        { path: '/api/auth/login', fields: { username: 'alice', password: ALICE_PW } },
        {
          path: '/api/auth/bootstrap',
          fields: { bootstrapToken: BOOTSTRAP_SECRET, username: 'root2', password: ADMIN_PW },
        },
        {
          path: '/api/auth/users',
          fields: { username: 'carol', password: 'carol-password-12', role: 'user' },
          cookie: adminCookie,
        },
        {
          path: '/api/auth/password',
          fields: { currentPassword: ADMIN_PW, newPassword: 'new-admin-password-1' },
          cookie: adminCookie,
        },
      ];
      for (const bytes of [AUTH_BODY_LIMIT_BYTES + 1, REVIEWER_PROBE_BYTES]) {
        for (const target of targets) {
          const res = await call({
            method: 'POST',
            path: target.path,
            headers: { 'content-type': 'application/json' },
            cookie: target.cookie ?? null,
            rawBody: paddedJson(target.fields, bytes),
          });
          expect(res.status, `${target.path} @ ${bytes}B`).toBe(413);
          expect(res.json.error.code).toBe('PAYLOAD_TOO_LARGE');
          expect(res.setCookies).toEqual([]);
        }
      }
      expect(totalKdfCalls()).toBe(0);
    });

    it('refuses an oversized chunked body (no Content-Length) before login', async () => {
      const res = await call({
        method: 'POST',
        path: '/api/auth/login',
        headers: { 'content-type': 'application/json' },
        chunked: true,
        rawBody: paddedJson({ username: 'alice', password: ALICE_PW }, REVIEWER_PROBE_BYTES),
      });
      expect(res.status).toBe(413);
      expect(totalKdfCalls()).toBe(0);
    });

    it('refuses compressed bodies (the bound is on raw bytes) before login', async () => {
      const res = await call({
        method: 'POST',
        path: '/api/auth/login',
        headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
        rawBody: gzipSync(Buffer.from(paddedJson({ username: 'alice', password: ALICE_PW }, 200_000))),
      });
      expect(res.status).toBe(415);
      expect(totalKdfCalls()).toBe(0);
    });
  });
}

describe('auth body bound — unmeasurable bodies fail closed', () => {
  it('a small chunked body already consumed by an upstream parser is refused, not trusted', async () => {
    harness = await startAuthHarness(
      { auth: service, bootstrapSecret: BOOTSTRAP_SECRET },
      { setup: ORDERS.production },
    );
    spyOnKdfMethods();
    const res = await harness.request({
      method: 'POST',
      path: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      chunked: true,
      rawBody: JSON.stringify({ username: 'alice', password: ALICE_PW }),
    });
    expect(res.status).toBe(413);
    expect(totalKdfCalls()).toBe(0);
  });

  it('the same small chunked body is accepted when the registrar parses it itself', async () => {
    harness = await startAuthHarness({ auth: service, bootstrapSecret: BOOTSTRAP_SECRET });
    spyOnKdfMethods();
    const res = await harness.request({
      method: 'POST',
      path: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      chunked: true,
      rawBody: JSON.stringify({ username: 'alice', password: ALICE_PW }),
    });
    expect(res.status).toBe(200);
    expect(kdfCalls.login!.mock.calls).toHaveLength(1);
  });
});
