// Issue #2 — auth-domain service + SQLite store.
//
// Covers one-time bootstrap, admin-only account management, username
// normalization, password policy, opaque server-side sessions (expiry,
// idle expiry, rotation, revocation), last-admin protection, role read
// from persistence (never from the caller), and persistence across a
// store restart. The store only ever receives an explicit data root.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthError, type AuthActor, type AuthService } from '../../src/services/auth-service.js';
import {
  AUTH_STORE_RELATIVE_PATH,
  AuthStore,
} from '../../src/storage/auth-store.js';
import { ManualClock, makeTempDataRoot, openTestAuth } from './helpers.js';

const ADMIN_PW = 'admin-password-000';
const ALICE_PW = 'alice-password-111';
const BOB_PW = 'bob-password-222';

let dataRoot = '';
let cleanup: () => void = () => {};
let clock: ManualClock;
let store: AuthStore;
let service: AuthService;

beforeEach(() => {
  ({ dataRoot, cleanup } = makeTempDataRoot());
  clock = new ManualClock();
  ({ store, service } = openTestAuth(dataRoot, clock));
});

afterEach(() => {
  try { store.close(); } catch { /* already closed by the test */ }
  cleanup();
});

async function expectAuthError(promise: Promise<unknown> | (() => unknown), code: AuthError['code']) {
  try {
    await (typeof promise === 'function' ? promise() : promise);
  } catch (error) {
    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).code).toBe(code);
    return error as AuthError;
  }
  throw new Error(`expected AuthError ${code}`);
}

async function seedAdminAndUsers() {
  await service.bootstrapFirstAdmin({ username: 'root', password: ADMIN_PW });
  const adminLogin = await service.login({ username: 'root', password: ADMIN_PW });
  const admin = service.resolveSession(adminLogin.session.token)!;
  const alice = await service.createAccount(admin, { username: 'alice', password: ALICE_PW, role: 'user' });
  const bob = await service.createAccount(admin, { username: 'bob', password: BOB_PW, role: 'user' });
  return { admin, adminToken: adminLogin.session.token, alice, bob };
}

async function loginActor(username: string, password: string): Promise<{ actor: AuthActor; token: string }> {
  const { session } = await service.login({ username, password });
  const actor = service.resolveSession(session.token);
  if (!actor) throw new Error('expected a live session');
  return { actor, token: session.token };
}

describe('auth store — data root contract', () => {
  it('requires an explicit absolute data root and has no fallback', () => {
    expect(() => AuthStore.open({ dataRoot: '' })).toThrow();
    expect(() => AuthStore.open({ dataRoot: 'relative/dir' })).toThrow();
    // @ts-expect-error — missing dataRoot must not silently pick a default
    expect(() => AuthStore.open({})).toThrow();
  });

  it('keeps the database under <dataRoot>/auth with owner-only permissions', () => {
    expect(AUTH_STORE_RELATIVE_PATH).toBe(path.join('auth', 'auth.sqlite'));
    expect(store.file).toBe(path.join(dataRoot, 'auth', 'auth.sqlite'));
    expect(readdirSync(dataRoot)).toEqual(['auth']);
    if (process.platform !== 'win32') {
      expect(statSync(path.join(dataRoot, 'auth')).mode & 0o777).toBe(0o700);
      expect(statSync(store.file).mode & 0o777).toBe(0o600);
    }
  });
});

describe('auth service — one-time first-admin bootstrap', () => {
  it('bootstraps exactly one admin on an empty store', async () => {
    expect(service.isBootstrapRequired()).toBe(true);
    const admin = await service.bootstrapFirstAdmin({ username: '  Root ', password: ADMIN_PW });
    expect(admin).toMatchObject({ username: 'root', role: 'admin', active: true });
    expect(service.isBootstrapRequired()).toBe(false);
    await expectAuthError(
      service.bootstrapFirstAdmin({ username: 'root2', password: ADMIN_PW }),
      'BOOTSTRAP_CLOSED',
    );
  });

  it('allows only one winner under concurrent bootstrap attempts', async () => {
    const results = await Promise.allSettled([
      service.bootstrapFirstAdmin({ username: 'first', password: ADMIN_PW }),
      service.bootstrapFirstAdmin({ username: 'second', password: ADMIN_PW }),
      service.bootstrapFirstAdmin({ username: 'third', password: ADMIN_PW }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results) {
      if (r.status === 'rejected') expect((r.reason as AuthError).code).toBe('BOOTSTRAP_CLOSED');
    }
    expect(store.countAccounts()).toBe(1);
  });

  it('stays closed after restart', async () => {
    await service.bootstrapFirstAdmin({ username: 'root', password: ADMIN_PW });
    store.close();
    ({ store, service } = openTestAuth(dataRoot, clock));
    expect(service.isBootstrapRequired()).toBe(false);
    await expectAuthError(
      service.bootstrapFirstAdmin({ username: 'other', password: ADMIN_PW }),
      'BOOTSTRAP_CLOSED',
    );
  });
});

describe('auth service — accounts and password policy', () => {
  it('normalizes usernames and enforces uniqueness on the normalized form', async () => {
    const { admin } = await seedAdminAndUsers();
    await expectAuthError(
      service.createAccount(admin, { username: 'ALICE', password: 'another-password-9', role: 'user' }),
      'USERNAME_TAKEN',
    );
    // Fullwidth "ａｌｉｃｅ" NFKC-normalizes to "alice".
    await expectAuthError(
      service.createAccount(admin, { username: 'ａｌｉｃｅ', password: 'another-password-9', role: 'user' }),
      'USERNAME_TAKEN',
    );
  });

  it('rejects invalid usernames', async () => {
    const { admin } = await seedAdminAndUsers();
    for (const username of ['', 'ab', ' ', 'has space', '../etc', 'a/b', 'x'.repeat(33), '_lead', 'émile']) {
      await expectAuthError(
        service.createAccount(admin, { username, password: 'valid-password-12', role: 'user' }),
        'VALIDATION',
      );
    }
  });

  it('enforces password length bounds and rejects password == username', async () => {
    const { admin } = await seedAdminAndUsers();
    for (const password of ['short', 'elevenchars', 'x'.repeat(1025), 'carol-username']) {
      await expectAuthError(
        service.createAccount(admin, { username: 'carol-username', password, role: 'user' }),
        'VALIDATION',
      );
    }
    await expectAuthError(
      // @ts-expect-error — role outside admin/user
      service.createAccount(admin, { username: 'carol', password: 'valid-password-12', role: 'owner' }),
      'VALIDATION',
    );
  });

  it('never stores or returns plaintext passwords or hashes', async () => {
    const { admin } = await seedAdminAndUsers();
    const views = service.listAccounts(admin);
    expect(views.map((v) => v.username).sort()).toEqual(['alice', 'bob', 'root']);
    for (const view of views) {
      expect(Object.keys(view).sort()).toEqual(['active', 'createdAt', 'id', 'role', 'updatedAt', 'username']);
    }
    store.close();
    const raw = new Database(path.join(dataRoot, 'auth', 'auth.sqlite'), { readonly: true });
    const dump = JSON.stringify(raw.prepare('SELECT * FROM auth_accounts').all());
    raw.close();
    for (const pw of [ADMIN_PW, ALICE_PW, BOB_PW]) expect(dump).not.toContain(pw);
    expect(dump).toContain('$scrypt$');
  });
});

describe('auth service — login and sessions', () => {
  it('issues an opaque token that is stored only as a hash', async () => {
    await seedAdminAndUsers();
    const { session, account } = await service.login({ username: 'Alice', password: ALICE_PW });
    expect(account.username).toBe('alice');
    expect(session.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(session.expiresAt).toBe(clock.now() + 12 * 60 * 60 * 1000);
    store.close();
    const bytes = readFileSync(path.join(dataRoot, 'auth', 'auth.sqlite')).toString('latin1');
    const raw = new Database(path.join(dataRoot, 'auth', 'auth.sqlite'), { readonly: true });
    const dump = JSON.stringify(raw.prepare('SELECT * FROM auth_sessions').all());
    raw.close();
    expect(dump).not.toContain(session.token);
    expect(bytes).not.toContain(session.token);
  });

  it('gives the same generic failure for unknown user, wrong password and inactive user', async () => {
    const { admin, alice } = await seedAdminAndUsers();
    service.updateAccount(admin, alice.id, { active: false });
    const errors = [
      await expectAuthError(service.login({ username: 'nobody', password: ALICE_PW }), 'INVALID_CREDENTIALS'),
      await expectAuthError(service.login({ username: 'bob', password: ALICE_PW }), 'INVALID_CREDENTIALS'),
      await expectAuthError(service.login({ username: 'alice', password: ALICE_PW }), 'INVALID_CREDENTIALS'),
      await expectAuthError(service.login({ username: '', password: '' }), 'INVALID_CREDENTIALS'),
    ];
    expect(new Set(errors.map((e) => e.message)).size).toBe(1);
  });

  it('resolves the actor role from persistence, and rejects garbage tokens', async () => {
    await seedAdminAndUsers();
    const { actor } = await loginActor('alice', ALICE_PW);
    expect(actor).toMatchObject({ username: 'alice', role: 'user' });
    for (const token of ['', 'x', 'a'.repeat(43), 'a'.repeat(10_000), '../../etc/passwd']) {
      expect(service.resolveSession(token)).toBeNull();
    }
  });

  it('expires sessions at the absolute TTL even when active', async () => {
    await seedAdminAndUsers();
    const { token } = await loginActor('alice', ALICE_PW);
    for (let i = 0; i < 11; i += 1) {
      clock.advance(60 * 60 * 1000);
      expect(service.resolveSession(token)).not.toBeNull();
    }
    clock.advance(60 * 60 * 1000);
    expect(service.resolveSession(token)).toBeNull();
  });

  it('expires sessions after the idle TTL', async () => {
    await seedAdminAndUsers();
    const { token } = await loginActor('alice', ALICE_PW);
    clock.advance(2 * 60 * 60 * 1000 - 1);
    expect(service.resolveSession(token)).not.toBeNull();
    clock.advance(2 * 60 * 60 * 1000 + 1);
    expect(service.resolveSession(token)).toBeNull();
  });

  it('revokes on logout and on login with a previous token (fixation defense)', async () => {
    await seedAdminAndUsers();
    const first = await loginActor('alice', ALICE_PW);
    service.logout(first.token);
    expect(service.resolveSession(first.token)).toBeNull();

    const second = await loginActor('alice', ALICE_PW);
    const third = await service.login({ username: 'alice', password: ALICE_PW }, { previousToken: second.token });
    expect(service.resolveSession(second.token)).toBeNull();
    expect(service.resolveSession(third.session.token)).not.toBeNull();
  });

  it('rotates tokens without extending the absolute expiry', async () => {
    await seedAdminAndUsers();
    const { token } = await loginActor('alice', ALICE_PW);
    const before = service.resolveSession(token)!;
    clock.advance(10 * 60 * 1000);
    const rotated = service.rotateSession(token);
    expect(rotated).not.toBeNull();
    expect(rotated!.token).not.toBe(token);
    expect(rotated!.expiresAt).toBe(before.sessionExpiresAt);
    expect(service.resolveSession(token)).toBeNull();
    expect(service.resolveSession(rotated!.token)).toMatchObject({ username: 'alice' });
    expect(service.rotateSession(token)).toBeNull();
  });

  it('persists accounts and live sessions across a store restart', async () => {
    await seedAdminAndUsers();
    const { token } = await loginActor('alice', ALICE_PW);
    store.close();
    ({ store, service } = openTestAuth(dataRoot, clock));
    expect(service.resolveSession(token)).toMatchObject({ username: 'alice', role: 'user' });
    await expect(service.login({ username: 'bob', password: BOB_PW })).resolves.toBeTruthy();
  });
});

describe('auth service — admin-only management', () => {
  it('rejects non-admin actors for every management action', async () => {
    const { bob } = await seedAdminAndUsers();
    const { actor: alice } = await loginActor('alice', ALICE_PW);
    await expectAuthError(
      service.createAccount(alice, { username: 'mallory', password: 'valid-password-12', role: 'admin' }),
      'FORBIDDEN',
    );
    await expectAuthError(() => service.listAccounts(alice), 'FORBIDDEN');
    await expectAuthError(() => service.updateAccount(alice, alice.accountId, { role: 'admin' }), 'FORBIDDEN');
    await expectAuthError(() => service.updateAccount(alice, bob.id, { active: false }), 'FORBIDDEN');
    await expectAuthError(() => service.revokeAccountSessions(alice, bob.id), 'FORBIDDEN');
    await expectAuthError(service.resetPassword(alice, bob.id, 'valid-password-12'), 'FORBIDDEN');
  });

  it('ignores a forged actor role: authority comes from the stored account', async () => {
    await seedAdminAndUsers();
    const { actor: alice } = await loginActor('alice', ALICE_PW);
    const forged: AuthActor = { ...alice, role: 'admin' };
    await expectAuthError(() => service.listAccounts(forged), 'FORBIDDEN');
    const ghost: AuthActor = { ...alice, accountId: 'does-not-exist', role: 'admin' };
    await expectAuthError(() => service.listAccounts(ghost), 'FORBIDDEN');
  });

  it('revokes sessions of an account whose role changes or that is deactivated', async () => {
    const { admin, alice, bob } = await seedAdminAndUsers();
    const a = await loginActor('alice', ALICE_PW);
    const b = await loginActor('bob', BOB_PW);
    service.updateAccount(admin, alice.id, { role: 'admin' });
    expect(service.resolveSession(a.token)).toBeNull();
    expect(service.resolveSession(b.token)).not.toBeNull();
    const a2 = await loginActor('alice', ALICE_PW);
    expect(a2.actor.role).toBe('admin');

    service.updateAccount(admin, bob.id, { active: false });
    expect(service.resolveSession(b.token)).toBeNull();
    await expectAuthError(service.login({ username: 'bob', password: BOB_PW }), 'INVALID_CREDENTIALS');
  });

  it('never removes the last active admin', async () => {
    const { admin, alice } = await seedAdminAndUsers();
    await expectAuthError(() => service.updateAccount(admin, admin.accountId, { role: 'user' }), 'LAST_ADMIN');
    await expectAuthError(() => service.updateAccount(admin, admin.accountId, { active: false }), 'LAST_ADMIN');
    service.updateAccount(admin, alice.id, { role: 'admin' });
    // With a second admin the first may step down.
    service.updateAccount(admin, admin.accountId, { role: 'user' });
    const aliceAdmin = (await loginActor('alice', ALICE_PW)).actor;
    await expectAuthError(() => service.updateAccount(aliceAdmin, alice.id, { active: false }), 'LAST_ADMIN');
    await expectAuthError(() => service.updateAccount(aliceAdmin, alice.id, { role: 'user' }), 'LAST_ADMIN');
  });

  it('revokes all sessions of a single account on admin request', async () => {
    const { admin, bob } = await seedAdminAndUsers();
    const a = await loginActor('alice', ALICE_PW);
    const b1 = await loginActor('bob', BOB_PW);
    const b2 = await loginActor('bob', BOB_PW);
    expect(service.revokeAccountSessions(admin, bob.id)).toBe(2);
    expect(service.resolveSession(b1.token)).toBeNull();
    expect(service.resolveSession(b2.token)).toBeNull();
    expect(service.resolveSession(a.token)).not.toBeNull();
  });

  it('reports NOT_FOUND for unknown account ids', async () => {
    const { admin } = await seedAdminAndUsers();
    await expectAuthError(() => service.updateAccount(admin, 'missing', { active: false }), 'NOT_FOUND');
    await expectAuthError(() => service.revokeAccountSessions(admin, 'missing'), 'NOT_FOUND');
  });

  it('admin password reset revokes the target sessions and replaces the password', async () => {
    const { admin, alice } = await seedAdminAndUsers();
    const a = await loginActor('alice', ALICE_PW);
    await service.resetPassword(admin, alice.id, 'fresh-password-333');
    expect(service.resolveSession(a.token)).toBeNull();
    await expectAuthError(service.login({ username: 'alice', password: ALICE_PW }), 'INVALID_CREDENTIALS');
    await expect(service.login({ username: 'alice', password: 'fresh-password-333' })).resolves.toBeTruthy();
  });
});

describe('auth service — self password change', () => {
  it('requires the current password and revokes every other session', async () => {
    await seedAdminAndUsers();
    const a1 = await loginActor('alice', ALICE_PW);
    const a2 = await loginActor('alice', ALICE_PW);
    await expectAuthError(
      service.changeOwnPassword(a1.actor, { currentPassword: 'wrong-password-00', newPassword: 'new-password-4444' }),
      'INVALID_CREDENTIALS',
    );
    const issued = await service.changeOwnPassword(a1.actor, {
      currentPassword: ALICE_PW,
      newPassword: 'new-password-4444',
    });
    expect(service.resolveSession(a1.token)).toBeNull();
    expect(service.resolveSession(a2.token)).toBeNull();
    expect(service.resolveSession(issued.token)).toMatchObject({ username: 'alice' });
    await expectAuthError(service.login({ username: 'alice', password: ALICE_PW }), 'INVALID_CREDENTIALS');
  });
});
