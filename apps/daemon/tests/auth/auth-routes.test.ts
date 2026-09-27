// Issue #2 — route-level negative tests for the isolated auth registrar.
//
// The registrar is exercised through a local Express harness only; it is
// deliberately NOT registered in the production server (see
// auth-not-wired.test.ts). Actors: anonymous, admin ("root"), and two
// ordinary users ("alice", "bob").

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearRecentApiFailures, readRecentApiFailures } from '../../src/http/api-failure-journal.js';
import { AUTH_SESSION_COOKIE } from '../../src/routes/auth.js';
import type { AuthStore } from '../../src/storage/auth-store.js';
import type { AuthService } from '../../src/services/auth-service.js';
import {
  ManualClock,
  TEST_ORIGIN,
  cookiePairFrom,
  makeTempDataRoot,
  openTestAuth,
  startAuthHarness,
  type AuthHarness,
  type RawRequest,
  type RawResponse,
} from './helpers.js';

const BOOTSTRAP_SECRET = 'bootstrap-secret-for-tests-only-000000';
const ADMIN_PW = 'admin-password-000';
const ALICE_PW = 'alice-password-111';
const BOB_PW = 'bob-password-222';
const ALL_SECRETS = [BOOTSTRAP_SECRET, ADMIN_PW, ALICE_PW, BOB_PW];

let dataRoot = '';
let cleanup: () => void = () => {};
let clock: ManualClock;
let store: AuthStore;
let service: AuthService;
let harness: AuthHarness;
let issuedTokens: string[] = [];
let consoleCalls: unknown[][] = [];

function tokenOf(res: RawResponse): string {
  const pair = cookiePairFrom(res.setCookies);
  if (!pair) throw new Error(`expected a session cookie, got status ${res.status}: ${res.text}`);
  const token = pair.slice(pair.indexOf('=') + 1);
  issuedTokens.push(token);
  return pair;
}

async function start(bootstrapSecret: string | null = BOOTSTRAP_SECRET) {
  harness = await startAuthHarness({ auth: service, bootstrapSecret });
}

function call(req: RawRequest) {
  return harness.request(req);
}

async function login(username: string, password: string): Promise<string> {
  const res = await call({ method: 'POST', path: '/api/auth/login', body: { username, password } });
  expect(res.status).toBe(200);
  return tokenOf(res);
}

async function seed(): Promise<{ admin: string; alice: string; bob: string; aliceId: string; bobId: string; adminId: string }> {
  const boot = await call({
    method: 'POST',
    path: '/api/auth/bootstrap',
    body: { bootstrapToken: BOOTSTRAP_SECRET, username: 'root', password: ADMIN_PW },
  });
  expect(boot.status).toBe(201);
  const admin = await login('root', ADMIN_PW);
  const created: string[] = [];
  for (const [username, password] of [['alice', ALICE_PW], ['bob', BOB_PW]] as const) {
    const res = await call({
      method: 'POST',
      path: '/api/auth/users',
      cookie: admin,
      body: { username, password, role: 'user' },
    });
    expect(res.status).toBe(201);
    created.push(res.json.account.id);
  }
  return {
    admin,
    alice: await login('alice', ALICE_PW),
    bob: await login('bob', BOB_PW),
    adminId: boot.json.account.id,
    aliceId: created[0]!,
    bobId: created[1]!,
  };
}

beforeEach(() => {
  ({ dataRoot, cleanup } = makeTempDataRoot());
  clock = new ManualClock();
  ({ store, service } = openTestAuth(dataRoot, clock));
  issuedTokens = [];
  consoleCalls = [];
  clearRecentApiFailures();
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { consoleCalls.push(args); });
  }
});

afterEach(async () => {
  vi.restoreAllMocks();
  await harness?.close();
  store.close();
  cleanup();
});

describe('auth routes — bootstrap', () => {
  it('is unavailable when no bootstrap secret is configured', async () => {
    await start(null);
    const res = await call({
      method: 'POST',
      path: '/api/auth/bootstrap',
      body: { bootstrapToken: '', username: 'root', password: ADMIN_PW },
    });
    expect(res.status).toBe(404);
    expect(service.isBootstrapRequired()).toBe(true);
  });

  it('requires the bootstrap secret, then closes permanently', async () => {
    await start();
    const wrong = await call({
      method: 'POST',
      path: '/api/auth/bootstrap',
      body: { bootstrapToken: 'nope', username: 'root', password: ADMIN_PW },
    });
    expect(wrong.status).toBe(403);
    const missing = await call({
      method: 'POST',
      path: '/api/auth/bootstrap',
      body: { username: 'root', password: ADMIN_PW },
    });
    expect(missing.status).toBe(403);

    const ok = await call({
      method: 'POST',
      path: '/api/auth/bootstrap',
      body: { bootstrapToken: BOOTSTRAP_SECRET, username: 'root', password: ADMIN_PW },
    });
    expect(ok.status).toBe(201);
    expect(ok.json.account).toMatchObject({ username: 'root', role: 'admin' });
    expect(ok.setCookies).toEqual([]);

    const again = await call({
      method: 'POST',
      path: '/api/auth/bootstrap',
      body: { bootstrapToken: BOOTSTRAP_SECRET, username: 'root2', password: ADMIN_PW },
    });
    expect(again.status).toBe(409);
  });
});

describe('auth routes — anonymous access', () => {
  it('denies every protected endpoint and offers no self-registration', async () => {
    await start();
    const { aliceId } = await seed();
    const attempts: RawRequest[] = [
      { path: '/api/auth/me' },
      { path: '/api/auth/users' },
      { method: 'POST', path: '/api/auth/users', body: { username: 'eve', password: 'eve-password-123', role: 'user' } },
      { method: 'PATCH', path: `/api/auth/users/${aliceId}`, body: { role: 'admin' } },
      { method: 'POST', path: `/api/auth/users/${aliceId}/sessions/revoke`, body: {} },
      { method: 'POST', path: `/api/auth/users/${aliceId}/password`, body: { password: 'eve-password-123' } },
      { method: 'POST', path: '/api/auth/session/rotate', body: {} },
      { method: 'POST', path: '/api/auth/password', body: { currentPassword: 'x', newPassword: 'eve-password-123' } },
    ];
    for (const attempt of attempts) {
      const res = await call(attempt);
      expect(res.status, `${attempt.method ?? 'GET'} ${attempt.path}`).toBe(401);
      expect(res.json.error.code).toBe('UNAUTHORIZED');
    }
    for (const path of ['/api/auth/register', '/api/auth/signup']) {
      const res = await call({ method: 'POST', path, body: { username: 'eve', password: 'eve-password-123' } });
      expect(res.status).toBe(404);
    }
    const eve = await call({ method: 'POST', path: '/api/auth/login', body: { username: 'eve', password: 'eve-password-123' } });
    expect(eve.status).toBe(401);
  });

  it('logout without a session is an idempotent no-op that clears the cookie', async () => {
    await start();
    const res = await call({ method: 'POST', path: '/api/auth/logout', body: {} });
    expect(res.status).toBe(204);
    expect(res.setCookies.join(';')).toMatch(new RegExp(`^${AUTH_SESSION_COOKIE}=;.*Max-Age=0`));
  });
});

describe('auth routes — login', () => {
  it('sets a hardened opaque session cookie and never returns secrets in the body', async () => {
    await start();
    await seed();
    const res = await call({ method: 'POST', path: '/api/auth/login', body: { username: 'Alice', password: ALICE_PW } });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.setCookies).toHaveLength(1);
    const cookie = res.setCookies[0]!;
    expect(AUTH_SESSION_COOKIE).toBe('__Host-od_session');
    expect(cookie.startsWith(`${AUTH_SESSION_COOKIE}=`)).toBe(true);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/');
    expect(cookie).not.toMatch(/Domain=/i);
    expect(cookie).toContain(`Max-Age=${12 * 60 * 60}`);
    const token = tokenOf(res).split('=')[1]!;
    expect(res.text).not.toContain(token);
    expect(res.text).not.toContain(ALICE_PW);
    expect(res.text).not.toMatch(/scrypt|passwordHash|password_hash/);
    expect(res.json.account).toMatchObject({ username: 'alice', role: 'user' });
  });

  it('returns an identical generic 401 for unknown users and wrong passwords', async () => {
    await start();
    await seed();
    const unknown = await call({ method: 'POST', path: '/api/auth/login', body: { username: 'nobody', password: ALICE_PW } });
    const wrong = await call({ method: 'POST', path: '/api/auth/login', body: { username: 'alice', password: BOB_PW } });
    const empty = await call({ method: 'POST', path: '/api/auth/login', body: {} });
    for (const res of [unknown, wrong, empty]) {
      expect(res.status).toBe(401);
      expect(res.setCookies).toEqual([]);
    }
    expect(unknown.text).toBe(wrong.text);
    expect(empty.text).toBe(wrong.text);
  });

  it('ignores client-supplied role fields on login', async () => {
    await start();
    await seed();
    const res = await call({
      method: 'POST',
      path: '/api/auth/login',
      headers: { 'x-od-role': 'admin' },
      body: { username: 'alice', password: ALICE_PW, role: 'admin' },
    });
    expect(res.json.account.role).toBe('user');
  });
});

describe('auth routes — ordinary users (alice, bob)', () => {
  it('each user sees only their own identity', async () => {
    await start();
    const { alice, bob } = await seed();
    const me1 = await call({ path: '/api/auth/me', cookie: alice });
    const me2 = await call({ path: '/api/auth/me', cookie: bob });
    expect(me1.json.account).toMatchObject({ username: 'alice', role: 'user' });
    expect(me2.json.account).toMatchObject({ username: 'bob', role: 'user' });
    expect(me1.headers['cache-control']).toBe('no-store');
  });

  it('cannot perform admin actions, even with forged role/identity headers', async () => {
    await start();
    const { alice, aliceId, bobId } = await seed();
    const forged = {
      'x-od-role': 'admin',
      'x-user-role': 'admin',
      'x-od-user': 'root',
      'x-forwarded-user': 'root',
      'x-remote-user': 'root',
      authorization: `Bearer ${BOOTSTRAP_SECRET}`,
    };
    const attempts: RawRequest[] = [
      { path: '/api/auth/users' },
      { method: 'POST', path: '/api/auth/users', body: { username: 'mallory', password: 'mallory-password-1', role: 'admin' } },
      { method: 'PATCH', path: `/api/auth/users/${aliceId}`, body: { role: 'admin' } },
      { method: 'PATCH', path: `/api/auth/users/${bobId}`, body: { active: false } },
      { method: 'POST', path: `/api/auth/users/${bobId}/sessions/revoke`, body: {} },
      { method: 'POST', path: `/api/auth/users/${bobId}/password`, body: { password: 'mallory-password-1' } },
    ];
    for (const headers of [{}, forged]) {
      for (const attempt of attempts) {
        const res = await call({ ...attempt, cookie: alice, headers });
        expect(res.status, `${attempt.method ?? 'GET'} ${attempt.path}`).toBe(403);
        expect(res.json.error.code).toBe('FORBIDDEN');
      }
    }
    const me = await call({ path: '/api/auth/me', cookie: alice, headers: forged });
    expect(me.json.account).toMatchObject({ username: 'alice', role: 'user' });
    const bobLogin = await call({ method: 'POST', path: '/api/auth/login', body: { username: 'bob', password: BOB_PW } });
    expect(bobLogin.status).toBe(200);
  });

  it('a forged cookie or a cookie for another scheme is not a session', async () => {
    await start();
    const { alice } = await seed();
    const aliceToken = alice.split('=')[1]!;
    for (const cookie of [
      `${AUTH_SESSION_COOKIE}=${'A'.repeat(43)}`,
      `od_session=${aliceToken}`,
      `${AUTH_SESSION_COOKIE}=${aliceToken}; ${AUTH_SESSION_COOKIE}=${aliceToken}`,
      `${AUTH_SESSION_COOKIE}=`,
    ]) {
      const res = await call({ path: '/api/auth/me', cookie });
      expect(res.status, cookie).toBe(401);
    }
    const bearer = await call({ path: '/api/auth/me', headers: { authorization: `Bearer ${aliceToken}` } });
    expect(bearer.status).toBe(401);
  });
});

describe('auth routes — admin management', () => {
  it('creates users with normalized unique usernames and no secret fields', async () => {
    await start();
    const { admin } = await seed();
    const dup = await call({
      method: 'POST',
      path: '/api/auth/users',
      cookie: admin,
      body: { username: ' ALICE ', password: 'another-password-1', role: 'user' },
    });
    expect(dup.status).toBe(409);
    const bad = await call({
      method: 'POST',
      path: '/api/auth/users',
      cookie: admin,
      body: { username: 'carol', password: 'short', role: 'user' },
    });
    expect(bad.status).toBe(400);
    const list = await call({ path: '/api/auth/users', cookie: admin });
    expect(list.status).toBe(200);
    expect(list.json.accounts.map((a: { username: string }) => a.username).sort()).toEqual(['alice', 'bob', 'root']);
    expect(list.text).not.toMatch(/scrypt|passwordHash|password_hash|token/i);
  });

  it('role change and deactivation revoke the target sessions (stale cookie → 401)', async () => {
    await start();
    const { admin, alice, bob, aliceId, bobId } = await seed();
    const promote = await call({ method: 'PATCH', path: `/api/auth/users/${aliceId}`, cookie: admin, body: { role: 'admin' } });
    expect(promote.status).toBe(200);
    expect(promote.json.account).toMatchObject({ role: 'admin' });
    const stale = await call({ path: '/api/auth/me', cookie: alice });
    expect(stale.status).toBe(401);
    expect(stale.setCookies.join(';')).toContain('Max-Age=0');
    expect((await call({ path: '/api/auth/me', cookie: bob })).status).toBe(200);

    const deactivate = await call({ method: 'PATCH', path: `/api/auth/users/${bobId}`, cookie: admin, body: { active: false } });
    expect(deactivate.status).toBe(200);
    expect((await call({ path: '/api/auth/me', cookie: bob })).status).toBe(401);
    const relogin = await call({ method: 'POST', path: '/api/auth/login', body: { username: 'bob', password: BOB_PW } });
    expect(relogin.status).toBe(401);
  });

  it('revokes one user without affecting the other', async () => {
    await start();
    const { admin, alice, bob, bobId } = await seed();
    const res = await call({ method: 'POST', path: `/api/auth/users/${bobId}/sessions/revoke`, cookie: admin, body: {} });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ revoked: 1 });
    expect((await call({ path: '/api/auth/me', cookie: bob })).status).toBe(401);
    expect((await call({ path: '/api/auth/me', cookie: alice })).status).toBe(200);
  });

  it('refuses to remove the last admin', async () => {
    await start();
    const { admin, adminId } = await seed();
    for (const body of [{ role: 'user' }, { active: false }]) {
      const res = await call({ method: 'PATCH', path: `/api/auth/users/${adminId}`, cookie: admin, body });
      expect(res.status).toBe(409);
    }
    expect((await call({ path: '/api/auth/me', cookie: admin })).json.account.role).toBe('admin');
  });

  it('validates patch bodies and unknown ids', async () => {
    await start();
    const { admin, aliceId } = await seed();
    const unknown = await call({ method: 'PATCH', path: '/api/auth/users/nope', cookie: admin, body: { active: false } });
    expect(unknown.status).toBe(404);
    for (const body of [{}, { role: 'owner' }, { active: 'no' }, { username: 'renamed' }]) {
      const res = await call({ method: 'PATCH', path: `/api/auth/users/${aliceId}`, cookie: admin, body });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('a demoted admin loses admin access immediately', async () => {
    await start();
    const { admin, aliceId } = await seed();
    await call({ method: 'PATCH', path: `/api/auth/users/${aliceId}`, cookie: admin, body: { role: 'admin' } });
    const aliceAdmin = await login('alice', ALICE_PW);
    expect((await call({ path: '/api/auth/users', cookie: aliceAdmin })).status).toBe(200);
    await call({ method: 'PATCH', path: `/api/auth/users/${aliceId}`, cookie: admin, body: { role: 'user' } });
    expect((await call({ path: '/api/auth/users', cookie: aliceAdmin })).status).toBe(401);
    const aliceUser = await login('alice', ALICE_PW);
    expect((await call({ path: '/api/auth/users', cookie: aliceUser })).status).toBe(403);
  });
});

describe('auth routes — stale sessions', () => {
  it('rejects expired, logged-out and rotated-away cookies', async () => {
    await start();
    const { alice, bob } = await seed();

    const rotated = await call({ method: 'POST', path: '/api/auth/session/rotate', cookie: alice, body: {} });
    expect(rotated.status).toBe(200);
    const aliceNew = tokenOf(rotated);
    expect(aliceNew).not.toBe(alice);
    expect((await call({ path: '/api/auth/me', cookie: alice })).status).toBe(401);
    expect((await call({ path: '/api/auth/me', cookie: aliceNew })).status).toBe(200);

    const out = await call({ method: 'POST', path: '/api/auth/logout', cookie: aliceNew, body: {} });
    expect(out.status).toBe(204);
    expect((await call({ path: '/api/auth/me', cookie: aliceNew })).status).toBe(401);

    clock.advance(12 * 60 * 60 * 1000);
    expect((await call({ path: '/api/auth/me', cookie: bob })).status).toBe(401);
  });

  it('survives a store restart for live sessions', async () => {
    await start();
    const { alice } = await seed();
    await harness.close();
    store.close();
    ({ store, service } = openTestAuth(dataRoot, clock));
    await start();
    expect((await call({ path: '/api/auth/me', cookie: alice })).json.account.username).toBe('alice');
  });

  it('self password change rotates the caller and kills other sessions', async () => {
    await start();
    await seed();
    const a1 = await login('alice', ALICE_PW);
    const a2 = await login('alice', ALICE_PW);
    const wrong = await call({
      method: 'POST',
      path: '/api/auth/password',
      cookie: a1,
      body: { currentPassword: BOB_PW, newPassword: 'new-alice-password-9' },
    });
    expect(wrong.status).toBe(401);
    const ok = await call({
      method: 'POST',
      path: '/api/auth/password',
      cookie: a1,
      body: { currentPassword: ALICE_PW, newPassword: 'new-alice-password-9' },
    });
    expect(ok.status).toBe(200);
    const fresh = tokenOf(ok);
    expect((await call({ path: '/api/auth/me', cookie: a1 })).status).toBe(401);
    expect((await call({ path: '/api/auth/me', cookie: a2 })).status).toBe(401);
    expect((await call({ path: '/api/auth/me', cookie: fresh })).status).toBe(200);
  });
});

describe('auth routes — request hardening', () => {
  it('rejects cross-origin and non-JSON state-changing requests', async () => {
    await start();
    const { admin } = await seed();
    const evil = await call({
      method: 'POST',
      path: '/api/auth/users',
      cookie: admin,
      headers: { origin: 'https://evil.example' },
      body: { username: 'carol', password: 'carol-password-12', role: 'user' },
    });
    expect(evil.status).toBe(403);
    const sameOrigin = await call({
      method: 'POST',
      path: '/api/auth/users',
      cookie: admin,
      headers: { origin: TEST_ORIGIN },
      body: { username: 'carol', password: 'carol-password-12', role: 'user' },
    });
    expect(sameOrigin.status).toBe(201);
    const form = await call({
      method: 'POST',
      path: '/api/auth/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      rawBody: `username=alice&password=${ALICE_PW}`,
    });
    expect(form.status).toBe(415);
    const textPlain = await call({
      method: 'POST',
      path: '/api/auth/users',
      cookie: admin,
      headers: { 'content-type': 'text/plain' },
      rawBody: JSON.stringify({ username: 'dave', password: 'dave-password-123', role: 'user' }),
    });
    expect(textPlain.status).toBe(415);
    expect(store.getAccountByUsername('dave')).toBeNull();
  });
});

describe('auth routes — no secrets in logs or diagnostics', () => {
  it('never writes passwords, bootstrap secret or session tokens to console or the failure journal', async () => {
    await start();
    const { alice, aliceId } = await seed();
    await call({ method: 'POST', path: '/api/auth/login', body: { username: 'alice', password: 'wrong-password-99' } });
    await call({ method: 'PATCH', path: `/api/auth/users/${aliceId}`, cookie: alice, body: { role: 'admin' } });
    await call({ method: 'POST', path: '/api/auth/bootstrap', body: { bootstrapToken: 'guess', username: 'x', password: 'y' } });
    const tokens = issuedTokens.filter(Boolean);
    expect(tokens.length).toBeGreaterThan(0);
    const logged = JSON.stringify(consoleCalls, (_k, v) => (v instanceof Error ? `${v.message}\n${v.stack}` : v));
    const journal = JSON.stringify(readRecentApiFailures());
    expect(readRecentApiFailures().length).toBeGreaterThan(0);
    for (const secret of [...ALL_SECRETS, 'wrong-password-99', ...tokens]) {
      expect(logged).not.toContain(secret);
      expect(journal).not.toContain(secret);
    }
  });
});
