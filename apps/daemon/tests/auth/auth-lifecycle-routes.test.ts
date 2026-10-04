// Issue #10 — admin-user lifecycle over the auth registrar's real HTTP seam.
//
// Recipient onboarding (`POST /api/auth/users` without a password), the
// anonymous setup redemption (`POST /api/auth/setup`), admin-issued reset
// (`POST /api/auth/users/:id/password` without a password), bounded search
// on `GET /api/auth/users` and the admin audit read `GET /api/auth/audit`.
// Real SQLite store, manual clock, raw node:http requests.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearRecentApiFailures, readRecentApiFailures } from '../../src/http/api-failure-journal.js';
import type { AuthService } from '../../src/services/auth-service.js';
import type { AuthStore } from '../../src/storage/auth-store.js';
import {
  ManualClock,
  cookiePairFrom,
  makeTempDataRoot,
  openTestAuth,
  startAuthHarness,
  type AuthHarness,
  type RawRequest,
} from './helpers.js';

const BOOTSTRAP_SECRET = 'bootstrap-secret-for-tests-only-000000';
const ADMIN_PW = 'admin-password-000';
const ALICE_PW = 'alice-password-111';
const DAY_MS = 24 * 60 * 60 * 1000;

let dataRoot = '';
let cleanup: () => void = () => {};
let clock: ManualClock;
let store: AuthStore;
let service: AuthService;
let harness: AuthHarness;
let revokedCallbacks: string[] = [];
let consoleCalls: unknown[][] = [];

const call = (req: RawRequest) => harness.request(req);

async function login(username: string, password: string): Promise<string> {
  const res = await call({ method: 'POST', path: '/api/auth/login', body: { username, password } });
  expect(res.status, res.text).toBe(200);
  return cookiePairFrom(res.setCookies)!;
}

async function seed(): Promise<{ admin: string; adminId: string; alice: string; aliceId: string }> {
  const boot = await call({ method: 'POST', path: '/api/auth/bootstrap',
    body: { bootstrapToken: BOOTSTRAP_SECRET, username: 'root', password: ADMIN_PW } });
  expect(boot.status).toBe(201);
  const admin = await login('root', ADMIN_PW);
  // Legacy, test-only direct-password provisioning stays available for fixtures.
  const created = await call({ method: 'POST', path: '/api/auth/users', cookie: admin,
    body: { username: 'alice', password: ALICE_PW, role: 'user' } });
  expect(created.status).toBe(201);
  expect(created.json.setup).toBeUndefined();
  return { admin, adminId: boot.json.account.id, alice: await login('alice', ALICE_PW), aliceId: created.json.account.id };
}

beforeEach(async () => {
  ({ dataRoot, cleanup } = makeTempDataRoot());
  clock = new ManualClock();
  ({ store, service } = openTestAuth(dataRoot, clock));
  revokedCallbacks = [];
  consoleCalls = [];
  clearRecentApiFailures();
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { consoleCalls.push(args); });
  }
  harness = await startAuthHarness({ auth: service, bootstrapSecret: BOOTSTRAP_SECRET,
    onAccountSessionsRevoked: (id) => { revokedCallbacks.push(id); } });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await harness?.close();
  store.close();
  cleanup();
});

describe('U01/U02 — provisioning and recipient setup over HTTP', () => {
  it('admin provisions; the recipient sets a password; login only after setup; replay refused', async () => {
    const { admin } = await seed();
    const created = await call({ method: 'POST', path: '/api/auth/users', cookie: admin, body: { username: ' Carol ', role: 'user' } });
    expect(created.status, created.text).toBe(201);
    expect(created.headers['cache-control']).toBe('no-store');
    expect(created.setCookies).toEqual([]);
    expect(created.json.account).toMatchObject({ username: 'carol', role: 'user', active: true, passwordState: 'setup_required' });
    const { token, purpose, expiresAt } = created.json.setup;
    expect(purpose).toBe('setup');
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(expiresAt).toBe(clock.now() + DAY_MS);

    const before = await call({ method: 'POST', path: '/api/auth/login', body: { username: 'carol', password: 'carol-password-123' } });
    const unknown = await call({ method: 'POST', path: '/api/auth/login', body: { username: 'nobody', password: 'carol-password-123' } });
    expect(before.status).toBe(401);
    expect(before.text).toBe(unknown.text);

    // Redemption is anonymous, sets no cookie and grants no session.
    const done = await call({ method: 'POST', path: '/api/auth/setup', body: { token, password: 'carol-password-123' } });
    expect(done.status, done.text).toBe(200);
    expect(done.json).toEqual({ account: { username: 'carol' } });
    expect(done.setCookies).toEqual([]);
    expect(done.headers['cache-control']).toBe('no-store');

    const replay = await call({ method: 'POST', path: '/api/auth/setup', body: { token, password: 'carol-password-456' } });
    const bogus = await call({ method: 'POST', path: '/api/auth/setup', body: { token: 'B'.repeat(43), password: 'carol-password-456' } });
    const empty = await call({ method: 'POST', path: '/api/auth/setup', body: {} });
    for (const res of [replay, bogus, empty]) {
      expect(res.status).toBe(401);
      expect(res.json.error.code).toBe('UNAUTHORIZED');
      expect(res.text).toBe(replay.text);
    }

    const carol = await login('carol', 'carol-password-123');
    const me = await call({ path: '/api/auth/me', cookie: carol });
    expect(me.json.account).toMatchObject({ username: 'carol', passwordState: 'set' });
  });

  it('refuses anonymous and ordinary users; the account is never created', async () => {
    const { alice } = await seed();
    const anon = await call({ method: 'POST', path: '/api/auth/users', body: { username: 'eve', role: 'admin' } });
    expect(anon.status).toBe(401);
    const user = await call({ method: 'POST', path: '/api/auth/users', cookie: alice, headers: { 'x-od-role': 'admin' },
      body: { username: 'eve', role: 'admin' } });
    expect(user.status).toBe(403);
    expect(store.getAccountByUsername('eve')).toBeNull();
    for (const path of ['/api/auth/register', '/api/auth/signup', '/api/auth/invite']) {
      expect((await call({ method: 'POST', path, body: { username: 'eve' } })).status).toBe(404);
    }
  });

  it('validates the setup body and the existing password policy without consuming the credential', async () => {
    const { admin } = await seed();
    const created = await call({ method: 'POST', path: '/api/auth/users', cookie: admin, body: { username: 'carol', role: 'user' } });
    const { token } = created.json.setup;
    const weak = await call({ method: 'POST', path: '/api/auth/setup', body: { token, password: 'short' } });
    expect(weak.status).toBe(400);
    const form = await call({ method: 'POST', path: '/api/auth/setup', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      rawBody: `token=${token}&password=carol-password-123` });
    expect(form.status).toBe(415);
    const cross = await call({ method: 'POST', path: '/api/auth/setup', headers: { origin: 'https://evil.example' },
      body: { token, password: 'carol-password-123' } });
    expect(cross.status).toBe(403);
    const ok = await call({ method: 'POST', path: '/api/auth/setup', body: { token, password: 'carol-password-123' } });
    expect(ok.status).toBe(200);
  });

  it('an expired credential gets the same fixed answer', async () => {
    const { admin } = await seed();
    const created = await call({ method: 'POST', path: '/api/auth/users', cookie: admin, body: { username: 'carol', role: 'user' } });
    clock.advance(DAY_MS);
    const expired = await call({ method: 'POST', path: '/api/auth/setup', body: { token: created.json.setup.token, password: 'carol-password-123' } });
    const bogus = await call({ method: 'POST', path: '/api/auth/setup', body: { token: 'C'.repeat(43), password: 'carol-password-123' } });
    expect(expired.status).toBe(401);
    expect(expired.text).toBe(bogus.text);
  });
});

describe('U04/U06 — admin-issued reset over HTTP', () => {
  it('kills the old sessions and password, fires the cancellation callback, supersedes on reissue', async () => {
    const { admin, alice, aliceId } = await seed();
    const issued = await call({ method: 'POST', path: `/api/auth/users/${aliceId}/password`, cookie: admin, body: {} });
    expect(issued.status, issued.text).toBe(201);
    expect(issued.json.setup).toMatchObject({ purpose: 'reset', expiresAt: clock.now() + DAY_MS });
    expect(revokedCallbacks).toEqual([aliceId]);
    expect((await call({ path: '/api/auth/me', cookie: alice })).status).toBe(401);
    expect((await call({ method: 'POST', path: '/api/auth/login', body: { username: 'alice', password: ALICE_PW } })).status).toBe(401);

    const reissued = await call({ method: 'POST', path: `/api/auth/users/${aliceId}/password`, cookie: admin, body: {} });
    expect(reissued.status).toBe(201);
    const stale = await call({ method: 'POST', path: '/api/auth/setup', body: { token: issued.json.setup.token, password: 'alice-new-password-1' } });
    expect(stale.status).toBe(401);
    const ok = await call({ method: 'POST', path: '/api/auth/setup', body: { token: reissued.json.setup.token, password: 'alice-new-password-1' } });
    expect(ok.status).toBe(200);
    await login('alice', 'alice-new-password-1');
  });

  it('keeps the legacy direct-password reset (test-only) and refuses non-admins either way', async () => {
    const { admin, alice, aliceId, adminId } = await seed();
    for (const body of [{}, { password: 'mallory-password-1' }]) {
      const res = await call({ method: 'POST', path: `/api/auth/users/${adminId}/password`, cookie: alice, body });
      expect(res.status).toBe(403);
    }
    const legacy = await call({ method: 'POST', path: `/api/auth/users/${aliceId}/password`, cookie: admin, body: { password: 'direct-password-77' } });
    expect(legacy.status).toBe(204);
    await login('alice', 'direct-password-77');
    const lastAdmin = await call({ method: 'POST', path: `/api/auth/users/${adminId}/password`, cookie: admin, body: {} });
    expect(lastAdmin.status).toBe(409);
    const missing = await call({ method: 'POST', path: '/api/auth/users/nope/password', cookie: admin, body: {} });
    expect(missing.status).toBe(404);
  });
});

describe('U07 — bounded admin search with strict query validation', () => {
  it('searches, pages and projects metadata only', async () => {
    const { admin } = await seed();
    for (const username of ['carol', 'caroline', 'dave']) {
      clock.advance(1);
      expect((await call({ method: 'POST', path: '/api/auth/users', cookie: admin, body: { username, role: 'user' } })).status).toBe(201);
    }
    const all = await call({ path: '/api/auth/users', cookie: admin });
    expect(all.status).toBe(200);
    expect(all.json.page).toEqual({ total: 5, limit: 50, offset: 0 });
    expect(all.json.accounts.map((a: { username: string }) => a.username)).toEqual(['root', 'alice', 'carol', 'caroline', 'dave']);
    expect(all.text).not.toMatch(/scrypt|passwordHash|password_hash|token|digest/i);

    const search = await call({ path: '/api/auth/users?q=CARO&limit=1&offset=1', cookie: admin });
    expect(search.status, search.text).toBe(200);
    expect(search.json.page).toEqual({ total: 2, limit: 1, offset: 1 });
    expect(search.json.accounts.map((a: { username: string }) => a.username)).toEqual(['caroline']);
    const none = await call({ path: '/api/auth/users?q=zzz', cookie: admin });
    expect(none.json).toEqual({ accounts: [], page: { total: 0, limit: 50, offset: 0 } });

    for (const query of ['q=', 'q=a%20b', 'limit=0', 'limit=101', 'limit=abc', 'limit=1e2', 'offset=-1', 'offset=10001',
      'q=a&q=b', 'role=admin', 'q[x]=1']) {
      const res = await call({ path: `/api/auth/users?${query}`, cookie: admin });
      expect(res.status, query).toBe(400);
      expect(res.json.error.code).toBe('BAD_REQUEST');
    }
  });

  it('denies anonymous, ordinary, forged-header and stale-role callers', async () => {
    const { admin, alice, aliceId } = await seed();
    expect((await call({ path: '/api/auth/users?q=a' })).status).toBe(401);
    expect((await call({ path: '/api/auth/users?q=a', cookie: alice, headers: { 'x-od-role': 'admin', authorization: `Bearer ${BOOTSTRAP_SECRET}` } })).status).toBe(403);
    await call({ method: 'PATCH', path: `/api/auth/users/${aliceId}`, cookie: admin, body: { role: 'admin' } });
    const aliceAdmin = await login('alice', ALICE_PW);
    expect((await call({ path: '/api/auth/users', cookie: aliceAdmin })).status).toBe(200);
    await call({ method: 'PATCH', path: `/api/auth/users/${aliceId}`, cookie: admin, body: { role: 'user' } });
    expect((await call({ path: '/api/auth/users', cookie: aliceAdmin })).status).toBe(401);
    expect((await call({ path: '/api/auth/audit', cookie: aliceAdmin })).status).toBe(401);
  });
});

describe('U08 — admin audit read over HTTP', () => {
  it('is admin-only, bounded, paginated and free of secrets', async () => {
    const { admin, alice, aliceId } = await seed();
    const created = await call({ method: 'POST', path: '/api/auth/users', cookie: admin, body: { username: 'carol', role: 'user' } });
    const setupToken = created.json.setup.token as string;
    await call({ method: 'POST', path: '/api/auth/setup', body: { token: setupToken, password: 'carol-password-123' } });
    await call({ method: 'POST', path: `/api/auth/users/${aliceId}/sessions/revoke`, cookie: admin, body: {} });

    expect((await call({ path: '/api/auth/audit' })).status).toBe(401);
    const aliceAgain = await login('alice', ALICE_PW);
    expect((await call({ path: '/api/auth/audit', cookie: aliceAgain })).status).toBe(403);
    expect(alice).not.toBe(aliceAgain);

    const audit = await call({ path: '/api/auth/audit', cookie: admin });
    expect(audit.status).toBe(200);
    expect(audit.headers['cache-control']).toBe('no-store');
    expect(audit.json.events.map((e: { action: string }) => e.action)).toEqual([
      'sessions_revoke', 'password_setup', 'credential_issue', 'account_create', 'account_create', 'bootstrap',
    ]);
    expect(audit.json.nextBefore).toBeNull();
    const page = await call({ path: '/api/auth/audit?limit=2', cookie: admin });
    expect(page.json.events).toHaveLength(2);
    const next = await call({ path: `/api/auth/audit?limit=2&before=${page.json.nextBefore}`, cookie: admin });
    expect(next.json.events.map((e: { action: string }) => e.action)).toEqual(['credential_issue', 'account_create']);
    for (const query of ['limit=0', 'limit=101', 'before=0', 'before=x', 'action=bootstrap', 'limit=1&limit=2']) {
      const res = await call({ path: `/api/auth/audit?${query}`, cookie: admin });
      expect(res.status, query).toBe(400);
    }
    for (const secret of [setupToken, ADMIN_PW, ALICE_PW, 'carol-password-123', BOOTSTRAP_SECRET]) {
      expect(audit.text).not.toContain(secret);
    }
  });

  it('never writes setup credentials or passwords to console or the failure journal', async () => {
    const { admin, aliceId } = await seed();
    const created = await call({ method: 'POST', path: '/api/auth/users', cookie: admin, body: { username: 'carol', role: 'user' } });
    const reset = await call({ method: 'POST', path: `/api/auth/users/${aliceId}/password`, cookie: admin, body: {} });
    const tokens = [created.json.setup.token as string, reset.json.setup.token as string];
    await call({ method: 'POST', path: '/api/auth/setup', body: { token: tokens[0], password: 'short' } });
    await call({ method: 'POST', path: '/api/auth/setup', body: { token: tokens[0], password: 'carol-password-123' } });
    await call({ method: 'POST', path: '/api/auth/setup', body: { token: tokens[0], password: 'carol-password-456' } });
    await call({ path: '/api/auth/users?q=a%20b', cookie: admin });
    const list = await call({ path: '/api/auth/users', cookie: admin });
    const audit = await call({ path: '/api/auth/audit', cookie: admin });
    expect(readRecentApiFailures().length).toBeGreaterThan(0);
    const logged = JSON.stringify(consoleCalls, (_k, v) => (v instanceof Error ? `${v.message}\n${v.stack}` : v));
    const journal = JSON.stringify(readRecentApiFailures());
    for (const secret of [...tokens, 'carol-password-123', 'carol-password-456', ADMIN_PW, ALICE_PW]) {
      expect(logged).not.toContain(secret);
      expect(journal).not.toContain(secret);
      expect(list.text).not.toContain(secret);
      expect(audit.text).not.toContain(secret);
    }
  });
});
