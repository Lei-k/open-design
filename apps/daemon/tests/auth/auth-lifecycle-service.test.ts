// Issue #10 — admin-user lifecycle on the real auth SQLite store.
//
// Recipient-set first password (setup credential), admin-issued reset
// credential, single-use/supersession/expiry, the usable-admin guard and the
// append-only audit. The password KDF is wrapped (never replaced) so a test
// can hold one derivation open and interleave a conflicting operation, and
// the clock is a manual clock. Two store connections stand in for two
// concurrent request handlers.

import path from 'node:path';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthError, type AuthActor, type AuthService } from '../../src/services/auth-service.js';
import type { AuthStore } from '../../src/storage/auth-store.js';
import { ManualClock, makeTempDataRoot, openTestAuth } from './helpers.js';

const kdf = vi.hoisted(() => ({
  gate: null as Promise<void> | null,
  entered: null as (() => void) | null,
}));

vi.mock('../../src/services/auth-passwords.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/auth-passwords.js')>();
  return {
    ...actual,
    hashPassword: async (...args: Parameters<typeof actual.hashPassword>) => {
      const gate = kdf.gate;
      if (gate) {
        kdf.gate = null;
        kdf.entered?.();
        await gate;
      }
      return actual.hashPassword(...args);
    },
  };
});

/** Hold the NEXT password derivation until `release()`; `entered` resolves once it is held. */
function holdNextKdf(): { entered: Promise<void>; release: () => void } {
  let release!: () => void;
  let entered!: () => void;
  kdf.gate = new Promise<void>((resolve) => { release = resolve; });
  const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
  kdf.entered = entered;
  return { entered: enteredPromise, release };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const ADMIN_PW = 'admin-password-000';
const ALICE_PW = 'alice-password-111';

let dataRoot = '';
let cleanup: () => void = () => {};
let clock: ManualClock;
let store: AuthStore;
let service: AuthService;
const extraStores: AuthStore[] = [];

beforeEach(() => {
  ({ dataRoot, cleanup } = makeTempDataRoot());
  clock = new ManualClock();
  ({ store, service } = openTestAuth(dataRoot, clock));
  kdf.gate = null;
  kdf.entered = null;
});

afterEach(() => {
  kdf.gate = null;
  for (const extra of extraStores.splice(0)) { try { extra.close(); } catch { /* closed */ } }
  try { store.close(); } catch { /* already closed by the test */ }
  cleanup();
});

/** A second, independent connection to the same auth database. */
function secondConnection(): { store: AuthStore; service: AuthService } {
  const second = openTestAuth(dataRoot, clock);
  extraStores.push(second.store);
  return second;
}

function rawDb(): Database.Database {
  return new Database(path.join(dataRoot, 'auth', 'auth.sqlite'));
}

async function expectAuthError(promise: Promise<unknown> | (() => unknown), code: AuthError['code']): Promise<AuthError> {
  try {
    await (typeof promise === 'function' ? promise() : promise);
  } catch (error) {
    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).code).toBe(code);
    return error as AuthError;
  }
  throw new Error(`expected AuthError ${code}`);
}

async function loginActor(svc: AuthService, username: string, password: string): Promise<{ actor: AuthActor; token: string }> {
  const { session } = await svc.login({ username, password });
  const actor = svc.resolveSession(session.token);
  if (!actor) throw new Error('expected a live session');
  return { actor, token: session.token };
}

async function seedAdmin(): Promise<AuthActor> {
  await service.bootstrapFirstAdmin({ username: 'root', password: ADMIN_PW });
  return (await loginActor(service, 'root', ADMIN_PW)).actor;
}

function credentialRows(): Array<Record<string, unknown>> {
  const db = rawDb();
  try { return db.prepare('SELECT * FROM auth_setup_credentials').all() as Array<Record<string, unknown>>; } finally { db.close(); }
}

function auditActions(): string[] {
  const db = rawDb();
  try {
    return (db.prepare('SELECT action FROM auth_audit ORDER BY id ASC').all() as Array<{ action: string }>).map((r) => r.action);
  } finally { db.close(); }
}

describe('U01/U02 — admin provisions; the recipient sets the first password', () => {
  it('creates a pending account that cannot authenticate until the recipient completes setup', async () => {
    const admin = await seedAdmin();
    const { account, setup } = service.provisionAccount(admin, { username: ' Carol ', role: 'user' });
    expect(account).toMatchObject({ username: 'carol', role: 'user', active: true, passwordState: 'setup_required' });
    expect(setup.purpose).toBe('setup');
    expect(setup.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(setup.token, 'base64url')).toHaveLength(32);
    expect(setup.expiresAt).toBe(clock.now() + DAY_MS);

    // No password exists yet: nothing logs in, not even the empty string or the token itself.
    for (const password of ['', setup.token, 'carol-password-123']) {
      await expectAuthError(service.login({ username: 'carol', password }), 'INVALID_CREDENTIALS');
    }

    const done = await service.completePasswordSetup({ token: setup.token, password: 'carol-password-123' });
    expect(done).toEqual({ username: 'carol' });
    // Completing setup does not grant a session.
    const db = rawDb();
    try {
      expect(db.prepare('SELECT COUNT(*) AS n FROM auth_sessions WHERE account_id = ?').get(account.id)).toEqual({ n: 0 });
    } finally { db.close(); }
    const { actor } = await loginActor(service, 'carol', 'carol-password-123');
    expect(actor).toMatchObject({ username: 'carol', role: 'user' });
    expect(service.getOwnAccount(actor).passwordState).toBe('set');
  });

  it('persists only a digest of the setup credential and never the raw value', async () => {
    const admin = await seedAdmin();
    const { account, setup } = service.provisionAccount(admin, { username: 'carol', role: 'user' });
    const rows = credentialRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ account_id: account.id, purpose: 'setup', expires_at: setup.expiresAt });
    expect(JSON.stringify(rows)).not.toContain(setup.token);
    store.close();
    const bytes = readFileSync(path.join(dataRoot, 'auth', 'auth.sqlite')).toString('latin1');
    expect(bytes).not.toContain(setup.token);
  });

  it('refuses non-admin, forged and anonymous provisioning', async () => {
    const admin = await seedAdmin();
    await service.createAccount(admin, { username: 'alice', password: ALICE_PW, role: 'user' });
    const { actor: alice } = await loginActor(service, 'alice', ALICE_PW);
    await expectAuthError(() => service.provisionAccount(alice, { username: 'mallory', role: 'admin' }), 'FORBIDDEN');
    await expectAuthError(() => service.provisionAccount({ ...alice, role: 'admin' }, { username: 'mallory', role: 'admin' }), 'FORBIDDEN');
    await expectAuthError(() => service.provisionAccount(null as unknown as AuthActor, { username: 'mallory', role: 'user' }), 'FORBIDDEN');
    expect(store.getAccountByUsername('mallory')).toBeNull();
  });

  it('keeps the normalized username unique against pending and set accounts', async () => {
    const admin = await seedAdmin();
    service.provisionAccount(admin, { username: 'carol', role: 'user' });
    await expectAuthError(() => service.provisionAccount(admin, { username: 'CAROL', role: 'user' }), 'USERNAME_TAKEN');
    await expectAuthError(() => service.provisionAccount(admin, { username: 'ROOT', role: 'user' }), 'USERNAME_TAKEN');
    await expectAuthError(() => service.provisionAccount(admin, { username: 'x', role: 'user' }), 'VALIDATION');
  });

  it('applies the existing password policy at redemption without consuming the credential', async () => {
    const admin = await seedAdmin();
    const { setup } = service.provisionAccount(admin, { username: 'carol-username', role: 'user' });
    for (const password of ['short', 'carol-username', 'x'.repeat(1025)]) {
      await expectAuthError(service.completePasswordSetup({ token: setup.token, password }), 'VALIDATION');
    }
    expect(credentialRows()).toHaveLength(1);
    await expect(service.completePasswordSetup({ token: setup.token, password: 'valid-password-12' })).resolves.toEqual({ username: 'carol-username' });
  });
});

describe('U02/U03 — single use, supersession and expiry', () => {
  it('denies replay with the same fixed error as unknown and malformed credentials', async () => {
    const admin = await seedAdmin();
    const { setup } = service.provisionAccount(admin, { username: 'carol', role: 'user' });
    await service.completePasswordSetup({ token: setup.token, password: 'carol-password-123' });
    const replay = await expectAuthError(service.completePasswordSetup({ token: setup.token, password: 'other-password-456' }), 'SETUP_INVALID');
    const unknown = await expectAuthError(service.completePasswordSetup({ token: 'A'.repeat(43), password: 'other-password-456' }), 'SETUP_INVALID');
    const malformed = await expectAuthError(service.completePasswordSetup({ token: '../x', password: 'other-password-456' }), 'SETUP_INVALID');
    expect(new Set([replay.message, unknown.message, malformed.message]).size).toBe(1);
    await expectAuthError(service.login({ username: 'carol', password: 'other-password-456' }), 'INVALID_CREDENTIALS');
    expect(credentialRows()).toEqual([]);
  });

  it('reissue invalidates the earlier outstanding credential', async () => {
    const admin = await seedAdmin();
    const { account, setup: first } = service.provisionAccount(admin, { username: 'carol', role: 'user' });
    const second = service.issueSetupCredential(admin, account.id);
    expect(second.purpose).toBe('setup');
    expect(second.token).not.toBe(first.token);
    expect(credentialRows()).toHaveLength(1);
    await expectAuthError(service.completePasswordSetup({ token: first.token, password: 'carol-password-123' }), 'SETUP_INVALID');
    await expect(service.completePasswordSetup({ token: second.token, password: 'carol-password-123' })).resolves.toEqual({ username: 'carol' });
  });

  it('expires at the configured lifetime (24 h default), at the boundary', async () => {
    const admin = await seedAdmin();
    const { setup } = service.provisionAccount(admin, { username: 'carol', role: 'user' });
    clock.advance(DAY_MS);
    const expired = await expectAuthError(service.completePasswordSetup({ token: setup.token, password: 'carol-password-123' }), 'SETUP_INVALID');
    expect(expired.message).toBe(new AuthError('SETUP_INVALID').message);

    // The admin's own 12 h session has expired by now; sign in again.
    const freshAdmin = (await loginActor(service, 'root', ADMIN_PW)).actor;
    const { account: dave, setup: daveSetup } = service.provisionAccount(freshAdmin, { username: 'dave', role: 'user' });
    clock.advance(DAY_MS - 1);
    await expect(service.completePasswordSetup({ token: daveSetup.token, password: 'dave-password-123' })).resolves.toEqual({ username: 'dave' });
    expect(store.getAccountById(dave.id)?.passwordState).toBe('set');
  });

  it('honours a configured shorter lifetime', async () => {
    store.close();
    ({ store, service } = openTestAuth(dataRoot, clock, { setupCredentialTtlMs: 60_000 }));
    const admin = await seedAdmin();
    const { setup } = service.provisionAccount(admin, { username: 'carol', role: 'user' });
    expect(setup.expiresAt).toBe(clock.now() + 60_000);
    clock.advance(60_000);
    await expectAuthError(service.completePasswordSetup({ token: setup.token, password: 'carol-password-123' }), 'SETUP_INVALID');
  });

  it('re-checks expiry after the password derivation, in the committing transaction', async () => {
    const admin = await seedAdmin();
    const { account, setup } = service.provisionAccount(admin, { username: 'carol', role: 'user' });
    clock.advance(DAY_MS - 1);
    const held = holdNextKdf();
    const redeem = service.completePasswordSetup({ token: setup.token, password: 'carol-password-123' });
    await held.entered;
    clock.advance(1);
    held.release();
    await expectAuthError(redeem, 'SETUP_INVALID');
    expect(store.getAccountById(account.id)?.passwordState).toBe('setup_required');
    await expectAuthError(service.login({ username: 'carol', password: 'carol-password-123' }), 'INVALID_CREDENTIALS');
    expect(auditActions()).not.toContain('password_setup');
  });

  it('a reissue during the held derivation wins; the superseded redemption commits nothing', async () => {
    const admin = await seedAdmin();
    const { account, setup } = service.provisionAccount(admin, { username: 'carol', role: 'user' });
    const held = holdNextKdf();
    const redeem = service.completePasswordSetup({ token: setup.token, password: 'carol-password-123' });
    await held.entered;
    const fresh = service.issueSetupCredential(admin, account.id);
    held.release();
    await expectAuthError(redeem, 'SETUP_INVALID');
    expect(store.getAccountById(account.id)?.passwordState).toBe('setup_required');
    await expect(service.completePasswordSetup({ token: fresh.token, password: 'carol-password-999' })).resolves.toEqual({ username: 'carol' });
    await expect(service.login({ username: 'carol', password: 'carol-password-999' })).resolves.toBeTruthy();
  });

  it('concurrent redemption of one credential on two connections has exactly one winner', async () => {
    const admin = await seedAdmin();
    const { account, setup } = service.provisionAccount(admin, { username: 'carol', role: 'user' });
    const other = secondConnection();
    const held = holdNextKdf();
    const first = service.completePasswordSetup({ token: setup.token, password: 'first-password-111' });
    await held.entered;
    // The second redemption runs to completion on the other connection while the first is held.
    await expect(other.service.completePasswordSetup({ token: setup.token, password: 'second-password-222' }))
      .resolves.toEqual({ username: 'carol' });
    held.release();
    await expectAuthError(first, 'SETUP_INVALID');
    await expectAuthError(service.login({ username: 'carol', password: 'first-password-111' }), 'INVALID_CREDENTIALS');
    await expect(service.login({ username: 'carol', password: 'second-password-222' })).resolves.toBeTruthy();
    expect(store.getAccountById(account.id)?.passwordState).toBe('set');
    expect(auditActions().filter((a) => a === 'password_setup')).toHaveLength(1);
  });

  it('survives a restart: an outstanding credential stays valid and stays single-use', async () => {
    const admin = await seedAdmin();
    const { setup } = service.provisionAccount(admin, { username: 'carol', role: 'user' });
    store.close();
    ({ store, service } = openTestAuth(dataRoot, clock));
    await expect(service.completePasswordSetup({ token: setup.token, password: 'carol-password-123' })).resolves.toEqual({ username: 'carol' });
    store.close();
    ({ store, service } = openTestAuth(dataRoot, clock));
    await expectAuthError(service.completePasswordSetup({ token: setup.token, password: 'carol-password-456' }), 'SETUP_INVALID');
    await expect(service.login({ username: 'carol', password: 'carol-password-123' })).resolves.toBeTruthy();
  });

  it('deactivation withdraws the outstanding credential; issuing to a deactivated account is refused', async () => {
    const admin = await seedAdmin();
    const { account, setup } = service.provisionAccount(admin, { username: 'carol', role: 'user' });
    service.updateAccount(admin, account.id, { active: false });
    expect(credentialRows()).toEqual([]);
    await expectAuthError(service.completePasswordSetup({ token: setup.token, password: 'carol-password-123' }), 'SETUP_INVALID');
    await expectAuthError(() => service.issueSetupCredential(admin, account.id), 'VALIDATION');
    await expectAuthError(() => service.issueSetupCredential(admin, 'missing'), 'NOT_FOUND');
  });
});

describe('U04 — admin-issued password recovery', () => {
  async function seedAlice() {
    const admin = await seedAdmin();
    const created = await service.createAccount(admin, { username: 'alice', password: ALICE_PW, role: 'user' });
    return { admin, aliceId: created.id };
  }

  it('issuing a reset retires the password and every session; the user chooses the replacement', async () => {
    const { admin, aliceId } = await seedAlice();
    const s1 = await loginActor(service, 'alice', ALICE_PW);
    const s2 = await loginActor(service, 'alice', ALICE_PW);
    const reset = service.issueSetupCredential(admin, aliceId);
    expect(reset.purpose).toBe('reset');
    expect(service.resolveSession(s1.token)).toBeNull();
    expect(service.resolveSession(s2.token)).toBeNull();
    expect(store.getAccountById(aliceId)?.passwordState).toBe('reset_required');
    await expectAuthError(service.login({ username: 'alice', password: ALICE_PW }), 'INVALID_CREDENTIALS');
    await expectAuthError(() => service.getOwnAccount(s1.actor), 'FORBIDDEN');

    await service.completePasswordSetup({ token: reset.token, password: 'alice-new-password-9' });
    await expectAuthError(service.login({ username: 'alice', password: ALICE_PW }), 'INVALID_CREDENTIALS');
    await expect(service.login({ username: 'alice', password: 'alice-new-password-9' })).resolves.toBeTruthy();
  });

  it('a failed commit consumes nothing and leaves no partial durable state', async () => {
    const { admin, aliceId } = await seedAlice();
    const reset = service.issueSetupCredential(admin, aliceId);
    const before = store.getAccountById(aliceId);
    const auditBefore = auditActions();
    const db = rawDb();
    db.exec(`CREATE TRIGGER test_fail_setup BEFORE UPDATE OF password_hash ON auth_accounts
      BEGIN SELECT RAISE(ABORT, 'injected setup failure'); END`);
    try {
      await expect(service.completePasswordSetup({ token: reset.token, password: 'alice-new-password-9' })).rejects.toThrow();
    } finally {
      db.exec('DROP TRIGGER test_fail_setup');
      db.close();
    }
    expect(store.getAccountById(aliceId)).toEqual(before);
    expect(credentialRows()).toHaveLength(1);
    expect(auditActions()).toEqual(auditBefore);
    await expect(service.completePasswordSetup({ token: reset.token, password: 'alice-new-password-9' })).resolves.toEqual({ username: 'alice' });
  });

  it('the legacy direct-password reset (test-only) withdraws any outstanding credential', async () => {
    const { admin, aliceId } = await seedAlice();
    const reset = service.issueSetupCredential(admin, aliceId);
    await service.resetPassword(admin, aliceId, 'direct-password-77');
    expect(credentialRows()).toEqual([]);
    expect(store.getAccountById(aliceId)?.passwordState).toBe('set');
    await expectAuthError(service.completePasswordSetup({ token: reset.token, password: 'alice-new-password-9' }), 'SETUP_INVALID');
    await expect(service.login({ username: 'alice', password: 'direct-password-77' })).resolves.toBeTruthy();
  });
});

describe('U05 — privilege guard and the usable-admin invariant', () => {
  it('a pending admin is not a usable admin: no last-admin escape', async () => {
    const admin = await seedAdmin();
    const { account: pending, setup } = service.provisionAccount(admin, { username: 'p-admin', role: 'admin' });
    await expectAuthError(() => service.updateAccount(admin, admin.accountId, { role: 'user' }), 'LAST_ADMIN');
    await expectAuthError(() => service.updateAccount(admin, admin.accountId, { active: false }), 'LAST_ADMIN');
    await expectAuthError(() => service.issueSetupCredential(admin, admin.accountId), 'LAST_ADMIN');
    // Demoting or deactivating the pending admin is always allowed.
    expect(service.updateAccount(admin, pending.id, { role: 'user' }).role).toBe('user');
    service.updateAccount(admin, pending.id, { role: 'admin' });
    const reissued = service.issueSetupCredential(admin, pending.id);
    expect(setup.token).not.toBe(reissued.token);
    await service.completePasswordSetup({ token: reissued.token, password: 'p-admin-password-1' });
    // Now usable: the first admin may step down.
    expect(service.updateAccount(admin, admin.accountId, { role: 'user' }).role).toBe('user');
  });

  it('a reset on an admin is refused when it would leave no usable admin', async () => {
    const admin = await seedAdmin();
    const second = await service.createAccount(admin, { username: 'alice', password: ALICE_PW, role: 'admin' });
    const reset = service.issueSetupCredential(admin, second.id);
    expect(reset.purpose).toBe('reset');
    await expectAuthError(() => service.issueSetupCredential(admin, admin.accountId), 'LAST_ADMIN');
    expect(store.getAccountById(admin.accountId)?.passwordState).toBe('set');
  });

  it('re-counts usable admins inside the transaction across two connections', async () => {
    const admin = await seedAdmin();
    await service.createAccount(admin, { username: 'alice', password: ALICE_PW, role: 'admin' });
    const aliceOther = secondConnection();
    const aliceAdmin = (await loginActor(aliceOther.service, 'alice', ALICE_PW)).actor;
    // Connection B (alice) demotes root; connection A (root's stale handle) is refused.
    aliceOther.service.updateAccount(aliceAdmin, admin.accountId, { role: 'user' });
    await expectAuthError(() => service.updateAccount(admin, aliceAdmin.accountId, { role: 'user' }), 'FORBIDDEN');
    await expectAuthError(() => service.provisionAccount(admin, { username: 'mallory', role: 'admin' }), 'FORBIDDEN');
    // Alice is now the only usable admin, seen fresh from connection A as well.
    const aliceHere = service.resolveSession((await service.login({ username: 'alice', password: ALICE_PW })).session.token)!;
    await expectAuthError(() => service.updateAccount(aliceHere, aliceHere.accountId, { active: false }), 'LAST_ADMIN');
    await expectAuthError(() => aliceOther.service.updateAccount(aliceAdmin, aliceAdmin.accountId, { role: 'user' }), 'LAST_ADMIN');
  });

  it('a demoted issuer cannot commit an account created during a held derivation', async () => {
    const admin = await seedAdmin();
    await service.createAccount(admin, { username: 'alice', password: ALICE_PW, role: 'admin' });
    const other = secondConnection();
    const aliceAdmin = (await loginActor(service, 'alice', ALICE_PW)).actor;
    const auditBefore = auditActions();
    const held = holdNextKdf();
    const creating = service.createAccount(aliceAdmin, { username: 'mallory', password: 'mallory-password-1', role: 'admin' });
    await held.entered;
    other.service.updateAccount(admin, aliceAdmin.accountId, { role: 'user' });
    held.release();
    await expectAuthError(creating, 'FORBIDDEN');
    expect(store.getAccountByUsername('mallory')).toBeNull();
    expect(auditActions()).toEqual([...auditBefore, 'account_update']);
  });

  it('an issuer whose sessions are revoked during a held derivation cannot commit', async () => {
    const admin = await seedAdmin();
    await service.createAccount(admin, { username: 'alice', password: ALICE_PW, role: 'admin' });
    await service.createAccount(admin, { username: 'bob', password: 'bob-password-222', role: 'user' });
    const other = secondConnection();
    const aliceAdmin = (await loginActor(service, 'alice', ALICE_PW)).actor;
    const held = holdNextKdf();
    const resetting = service.resetPassword(aliceAdmin, store.getAccountByUsername('bob')!.id, 'taken-over-password-1');
    await held.entered;
    other.service.revokeAccountSessions(admin, aliceAdmin.accountId);
    held.release();
    await expectAuthError(resetting, 'FORBIDDEN');
    await expect(service.login({ username: 'bob', password: 'bob-password-222' })).resolves.toBeTruthy();
  });

  it('a recipient deactivated during the held derivation cannot complete setup', async () => {
    const admin = await seedAdmin();
    const { account, setup } = service.provisionAccount(admin, { username: 'carol', role: 'user' });
    const other = secondConnection();
    const held = holdNextKdf();
    const redeem = service.completePasswordSetup({ token: setup.token, password: 'carol-password-123' });
    await held.entered;
    other.service.updateAccount(admin, account.id, { active: false });
    held.release();
    await expectAuthError(redeem, 'SETUP_INVALID');
    expect(store.getAccountById(account.id)).toMatchObject({ active: false, passwordState: 'setup_required' });
  });
});

describe('U07 — bounded account search', () => {
  it('pages and searches by username substring with a metadata-only projection', async () => {
    const admin = await seedAdmin();
    for (const name of ['carol', 'caroline', 'dave', 'a_b', 'axb']) {
      clock.advance(1);
      service.provisionAccount(admin, { username: name, role: 'user' });
    }
    const all = service.searchAccounts(admin, {});
    expect(all.total).toBe(6);
    expect(all.accounts.map((a) => a.username)).toEqual(['root', 'carol', 'caroline', 'dave', 'a_b', 'axb']);
    for (const view of all.accounts) {
      expect(Object.keys(view).sort()).toEqual(['active', 'createdAt', 'id', 'passwordState', 'role', 'updatedAt', 'username']);
    }
    const carol = service.searchAccounts(admin, { q: 'CARO' });
    expect(carol).toMatchObject({ total: 2, limit: 50, offset: 0 });
    expect(carol.accounts.map((a) => a.username)).toEqual(['carol', 'caroline']);
    // "_" is a literal character, not a wildcard.
    expect(service.searchAccounts(admin, { q: 'a_b' }).accounts.map((a) => a.username)).toEqual(['a_b']);
    const page = service.searchAccounts(admin, { limit: 2, offset: 2 });
    expect(page).toMatchObject({ total: 6, limit: 2, offset: 2 });
    expect(page.accounts.map((a) => a.username)).toEqual(['caroline', 'dave']);
    expect(service.searchAccounts(admin, { q: 'nobody' })).toMatchObject({ total: 0, accounts: [] });
    for (const bad of [{ limit: 0 }, { limit: 101 }, { offset: -1 }, { offset: 10_001 }, { q: '' }, { q: 'has space' }, { q: 'x'.repeat(33) }]) {
      await expectAuthError(() => service.searchAccounts(admin, bad), 'VALIDATION');
    }
  });

  it('refuses ordinary and forged actors', async () => {
    const admin = await seedAdmin();
    await service.createAccount(admin, { username: 'alice', password: ALICE_PW, role: 'user' });
    const { actor } = await loginActor(service, 'alice', ALICE_PW);
    await expectAuthError(() => service.searchAccounts(actor, {}), 'FORBIDDEN');
    await expectAuthError(() => service.searchAccounts({ ...actor, role: 'admin' }, {}), 'FORBIDDEN');
    await expectAuthError(() => service.listAuditEvents(actor, {}), 'FORBIDDEN');
  });
});

describe('U08 — append-only administrator audit', () => {
  it('records successful management, bootstrap, setup, reset and revoke events with non-sensitive metadata', async () => {
    const admin = await seedAdmin();
    const { account: carol, setup } = service.provisionAccount(admin, { username: 'carol', role: 'user' });
    await service.completePasswordSetup({ token: setup.token, password: 'carol-password-123' });
    const legacy = await service.createAccount(admin, { username: 'alice', password: ALICE_PW, role: 'user' });
    service.updateAccount(admin, legacy.id, { role: 'admin' });
    service.updateAccount(admin, legacy.id, { role: 'admin' }); // no-op: not audited
    await loginActor(service, 'carol', 'carol-password-123');
    expect(service.revokeAccountSessions(admin, carol.id)).toBe(1);
    const reset = service.issueSetupCredential(admin, carol.id);
    await service.completePasswordSetup({ token: reset.token, password: 'carol-password-456' });
    await service.resetPassword(admin, legacy.id, 'direct-password-77');
    // Failures are not audit events.
    await expectAuthError(() => service.updateAccount(admin, 'missing', { active: false }), 'NOT_FOUND');
    await expectAuthError(service.completePasswordSetup({ token: reset.token, password: 'carol-password-789' }), 'SETUP_INVALID');

    const { events, nextBefore } = service.listAuditEvents(admin, {});
    expect(nextBefore).toBeNull();
    expect(events.map((e) => e.action)).toEqual([
      'password_reset_legacy',
      'password_setup',
      'credential_issue',
      'sessions_revoke',
      'account_update',
      'account_create',
      'password_setup',
      'credential_issue',
      'account_create',
      'bootstrap',
    ]);
    for (const event of events) {
      expect(Object.keys(event).sort()).toEqual(['action', 'actorAccountId', 'at', 'id', 'metadata', 'outcome', 'targetAccountId']);
      expect(event.outcome).toBe('success');
      expect(event.at).toBe(clock.now());
    }
    const byAction = (action: string) => events.filter((e) => e.action === action);
    expect(byAction('bootstrap')[0]).toMatchObject({ actorAccountId: admin.accountId, targetAccountId: admin.accountId });
    expect(byAction('account_create').map((e) => e.metadata)).toEqual([
      { role: 'user', onboarding: 'legacy_password' },
      { role: 'user', onboarding: 'setup_credential' },
    ]);
    expect(byAction('credential_issue').map((e) => e.metadata)).toEqual([
      { purpose: 'reset', expiresAt: reset.expiresAt },
      { purpose: 'setup', expiresAt: setup.expiresAt },
    ]);
    expect(byAction('password_setup').map((e) => [e.actorAccountId, e.targetAccountId, e.metadata])).toEqual([
      [carol.id, carol.id, { purpose: 'reset' }],
      [carol.id, carol.id, { purpose: 'setup' }],
    ]);
    expect(byAction('account_update')[0]!.metadata).toEqual({ fromRole: 'user', toRole: 'admin', fromActive: true, toActive: true });
    expect(byAction('sessions_revoke')[0]!.metadata).toEqual({ revoked: 1 });

    const dump = JSON.stringify(events);
    for (const secret of [setup.token, reset.token, ADMIN_PW, ALICE_PW, 'carol-password-123', 'carol-password-456', 'direct-password-77']) {
      expect(dump).not.toContain(secret);
    }
    expect(dump).not.toMatch(/scrypt/);

    const page = service.listAuditEvents(admin, { limit: 3 });
    expect(page.events.map((e) => e.id)).toEqual(events.slice(0, 3).map((e) => e.id));
    expect(page.nextBefore).toBe(events[2]!.id);
    expect(service.listAuditEvents(admin, { limit: 3, before: page.nextBefore! }).events.map((e) => e.id))
      .toEqual(events.slice(3, 6).map((e) => e.id));
    for (const bad of [{ limit: 0 }, { limit: 101 }, { before: 0 }, { before: 1.5 }]) {
      await expectAuthError(() => service.listAuditEvents(admin, bad), 'VALIDATION');
    }
  });

  it('is append-only and survives a restart', async () => {
    const admin = await seedAdmin();
    service.provisionAccount(admin, { username: 'carol', role: 'user' });
    const db = rawDb();
    try {
      expect(() => db.prepare("UPDATE auth_audit SET action = 'x'").run()).toThrow(/append-only/);
      expect(() => db.prepare('DELETE FROM auth_audit').run()).toThrow(/append-only/);
    } finally { db.close(); }
    store.close();
    ({ store, service } = openTestAuth(dataRoot, clock));
    const root = (await loginActor(service, 'root', ADMIN_PW)).actor;
    expect(service.listAuditEvents(root, {}).events.map((e) => e.action)).toEqual(['credential_issue', 'account_create', 'bootstrap']);
  });

  it('a failed audit append rolls the mutation back', async () => {
    const admin = await seedAdmin();
    const legacy = await service.createAccount(admin, { username: 'alice', password: ALICE_PW, role: 'user' });
    const session = await loginActor(service, 'alice', ALICE_PW);
    const db = rawDb();
    db.exec(`CREATE TRIGGER test_fail_audit BEFORE INSERT ON auth_audit
      BEGIN SELECT RAISE(ABORT, 'injected audit failure'); END`);
    try {
      expect(() => service.issueSetupCredential(admin, legacy.id)).toThrow();
      expect(() => service.provisionAccount(admin, { username: 'carol', role: 'user' })).toThrow();
      expect(() => service.updateAccount(admin, legacy.id, { active: false })).toThrow();
    } finally {
      db.exec('DROP TRIGGER test_fail_audit');
      db.close();
    }
    expect(store.getAccountById(legacy.id)).toMatchObject({ active: true, passwordState: 'set' });
    expect(service.resolveSession(session.token)).not.toBeNull();
    expect(store.getAccountByUsername('carol')).toBeNull();
    expect(credentialRows()).toEqual([]);
    await expect(service.login({ username: 'alice', password: ALICE_PW })).resolves.toBeTruthy();
  });
});
