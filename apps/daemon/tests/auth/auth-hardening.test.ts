// Issue #2 — extra negative tests for hardening that the primary auth suites
// do not pin: body-parser failures never echo/log credentials, browser
// fetch-metadata without an Origin, opaque `null` origins, fail-closed
// registrar configuration, route-level session-fixation defense, and a
// symlinked store directory.

import { mkdirSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearRecentApiFailures, readRecentApiFailures } from '../../src/http/api-failure-journal.js';
import { registerAuthRoutes } from '../../src/routes/auth.js';
import type { AuthService } from '../../src/services/auth-service.js';
import { AuthStore } from '../../src/storage/auth-store.js';
import {
  ManualClock,
  TEST_ORIGIN,
  cookiePairFrom,
  makeTempDataRoot,
  openTestAuth,
  startAuthHarness,
  type AuthHarness,
} from './helpers.js';

const BOOTSTRAP_SECRET = 'bootstrap-secret-for-tests-only-000000';
const ADMIN_PW = 'admin-password-000';
const ALICE_PW = 'alice-password-111';

let dataRoot = '';
let cleanup: () => void = () => {};
let store: AuthStore;
let service: AuthService;
let harness: AuthHarness;
let consoleCalls: unknown[][] = [];

beforeEach(async () => {
  ({ dataRoot, cleanup } = makeTempDataRoot());
  ({ store, service } = openTestAuth(dataRoot, new ManualClock()));
  consoleCalls = [];
  clearRecentApiFailures();
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { consoleCalls.push(args); });
  }
  harness = await startAuthHarness({ auth: service, bootstrapSecret: BOOTSTRAP_SECRET });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await harness.close();
  store.close();
  cleanup();
});

async function seedAlice(): Promise<string> {
  const boot = await harness.request({
    method: 'POST',
    path: '/api/auth/bootstrap',
    body: { bootstrapToken: BOOTSTRAP_SECRET, username: 'root', password: ADMIN_PW },
  });
  expect(boot.status).toBe(201);
  const adminLogin = await harness.request({ method: 'POST', path: '/api/auth/login', body: { username: 'root', password: ADMIN_PW } });
  const admin = cookiePairFrom(adminLogin.setCookies)!;
  const created = await harness.request({
    method: 'POST',
    path: '/api/auth/users',
    cookie: admin,
    body: { username: 'alice', password: ALICE_PW, role: 'user' },
  });
  expect(created.status).toBe(201);
  return admin;
}

describe('auth hardening — body parsing', () => {
  it('answers malformed JSON with a generic 400 that neither echoes nor logs the body', async () => {
    const res = await harness.request({
      method: 'POST',
      path: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      rawBody: `{"username":"alice","password":"${ALICE_PW}"`,
    });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe('BAD_REQUEST');
    expect(res.text).not.toContain(ALICE_PW);
    expect(JSON.stringify(consoleCalls)).not.toContain(ALICE_PW);
    expect(JSON.stringify(readRecentApiFailures())).not.toContain(ALICE_PW);
  });

  it('refuses oversized bodies before the KDF runs', async () => {
    const res = await harness.request({
      method: 'POST',
      path: '/api/auth/login',
      body: { username: 'alice', password: 'x'.repeat(64 * 1024) },
    });
    expect(res.status).toBe(413);
  });
});

describe('auth hardening — origin and fetch metadata', () => {
  it('refuses state-changing requests marked cross-site/same-site without an allowed Origin', async () => {
    await seedAlice();
    for (const site of ['cross-site', 'same-site']) {
      const res = await harness.request({
        method: 'POST',
        path: '/api/auth/login',
        headers: { 'sec-fetch-site': site },
        body: { username: 'alice', password: ALICE_PW },
      });
      expect(res.status, site).toBe(403);
      expect(res.setCookies).toEqual([]);
    }
    const sameOrigin = await harness.request({
      method: 'POST',
      path: '/api/auth/login',
      headers: { 'sec-fetch-site': 'same-origin', origin: TEST_ORIGIN },
      body: { username: 'alice', password: ALICE_PW },
    });
    expect(sameOrigin.status).toBe(200);
  });

  it('treats an opaque "null" Origin as cross-origin', async () => {
    await seedAlice();
    const res = await harness.request({
      method: 'POST',
      path: '/api/auth/login',
      headers: { origin: 'null' },
      body: { username: 'alice', password: ALICE_PW },
    });
    expect(res.status).toBe(403);
  });
});

describe('auth hardening — session fixation at the route', () => {
  it('login retires whatever session cookie the client presented', async () => {
    await seedAlice();
    const first = await harness.request({ method: 'POST', path: '/api/auth/login', body: { username: 'alice', password: ALICE_PW } });
    const planted = cookiePairFrom(first.setCookies)!;
    const second = await harness.request({
      method: 'POST',
      path: '/api/auth/login',
      cookie: planted,
      body: { username: 'alice', password: ALICE_PW },
    });
    expect(second.status).toBe(200);
    expect((await harness.request({ path: '/api/auth/me', cookie: planted })).status).toBe(401);
    expect((await harness.request({ path: '/api/auth/me', cookie: cookiePairFrom(second.setCookies)! })).status).toBe(200);
  });
});

describe('auth hardening — fail-closed configuration', () => {
  it('refuses weak bootstrap secrets and non-exact origins at registration', () => {
    const app = express();
    expect(() => registerAuthRoutes(app, { auth: service, bootstrapSecret: 'short', allowedOrigins: [TEST_ORIGIN] })).toThrow();
    for (const allowedOrigins of [[], ['*'], [`${TEST_ORIGIN}/`], ['od.test.invalid'], ['file:///x']]) {
      expect(
        () => registerAuthRoutes(express(), { auth: service, bootstrapSecret: null, allowedOrigins }),
        JSON.stringify(allowedOrigins),
      ).toThrow();
    }
  });

  it('refuses a symlinked auth directory under the data root', () => {
    if (process.platform === 'win32') return;
    const { dataRoot: other, cleanup: cleanupOther } = makeTempDataRoot();
    try {
      const elsewhere = path.join(other, 'elsewhere');
      mkdirSync(elsewhere);
      const root = path.join(other, 'root');
      mkdirSync(root);
      symlinkSync(elsewhere, path.join(root, 'auth'));
      expect(() => AuthStore.open({ dataRoot: root })).toThrow();
    } finally {
      cleanupOther();
    }
  });
});
