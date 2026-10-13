// Issues #10/#53 — auth store schema v1 → v3 upgrade (repository-required).
//
// The fixture is a real v1 database: the exact v1 DDL shipped by #2, a real
// scrypt hash, a live session digest and the one-shot bootstrap marker. The
// upgrade must keep every account, password and session usable, default the
// new password state to "set", keep bootstrap closed, run once, roll back
// completely on failure, and refuse a future schema.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword } from '../../src/services/auth-passwords.js';
import { AuthError } from '../../src/services/auth-service.js';
import { AuthStore } from '../../src/storage/auth-store.js';
import { FAST_TEST_SCRYPT_PARAMS, ManualClock, T0, makeTempDataRoot, openTestAuth } from './helpers.js';

/** Verbatim v1 schema (base 05a7ba9, apps/daemon/src/storage/auth-store.ts). */
const V1_SCHEMA = `
  CREATE TABLE IF NOT EXISTS auth_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS auth_accounts (
    id            TEXT PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('admin', 'user')),
    active        INTEGER NOT NULL CHECK (active IN (0, 1)),
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS auth_sessions (
    id           TEXT PRIMARY KEY,
    token_hash   TEXT NOT NULL UNIQUE,
    account_id   TEXT NOT NULL REFERENCES auth_accounts(id) ON DELETE CASCADE,
    created_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS auth_sessions_account_idx ON auth_sessions(account_id);
`;

const ADMIN_PW = 'v1-admin-password-0';
const USER_PW = 'v1-user-password-11';

let dataRoot = '';
let cleanup: () => void = () => {};
let clock: ManualClock;
let file = '';

interface V1Fixture { adminId: string; userId: string; inactiveId: string; sessionToken: string }

async function writeV1Fixture(extraSql = ''): Promise<V1Fixture> {
  const dir = path.join(dataRoot, 'auth');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const db = new Database(file);
  const adminHash = await hashPassword(ADMIN_PW, FAST_TEST_SCRYPT_PARAMS);
  const userHash = await hashPassword(USER_PW, FAST_TEST_SCRYPT_PARAMS);
  const fixture: V1Fixture = {
    adminId: randomUUID(), userId: randomUUID(), inactiveId: randomUUID(),
    sessionToken: randomBytes(32).toString('base64url'),
  };
  db.pragma('journal_mode = WAL');
  db.exec(V1_SCHEMA);
  const insert = db.prepare(`INSERT INTO auth_accounts (id, username, password_hash, role, active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  insert.run(fixture.adminId, 'v1-admin', adminHash, 'admin', 1, T0 - 3000, T0 - 3000);
  insert.run(fixture.userId, 'v1-user', userHash, 'user', 1, T0 - 2000, T0 - 2000);
  insert.run(fixture.inactiveId, 'v1-gone', userHash, 'user', 0, T0 - 1000, T0 - 1000);
  db.prepare('INSERT INTO auth_meta (key, value) VALUES (?, ?)').run('bootstrap_completed_at', String(T0 - 3000));
  db.prepare(`INSERT INTO auth_sessions (id, token_hash, account_id, created_at, last_seen_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(randomUUID(), createHash('sha256').update(fixture.sessionToken).digest('hex'),
    fixture.userId, T0 - 60_000, T0 - 60_000, T0 + 60 * 60 * 1000);
  if (extraSql) db.exec(extraSql);
  db.pragma('user_version = 1');
  db.close();
  chmodSync(file, 0o600);
  return fixture;
}

function inspect<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(file, { readonly: true });
  try { return fn(db); } finally { db.close(); }
}

const tableNames = () => inspect((db) => (db.prepare(
  "SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
).all() as Array<{ name: string }>).map((r) => r.name));
const accountColumns = () => inspect((db) => (db.prepare('PRAGMA table_info(auth_accounts)').all() as Array<{ name: string }>).map((c) => c.name));
const userVersion = () => inspect((db) => db.pragma('user_version', { simple: true }) as number);

beforeEach(() => {
  ({ dataRoot, cleanup } = makeTempDataRoot());
  clock = new ManualClock();
  file = path.join(dataRoot, 'auth', 'auth.sqlite');
});

afterEach(() => cleanup());

describe('U09 — auth store v1 → v3 migration', () => {
  it('upgrades a populated v1 store without disturbing accounts, passwords, sessions or bootstrap', async () => {
    const fixture = await writeV1Fixture();
    const v1Accounts = inspect((db) => db.prepare('SELECT * FROM auth_accounts ORDER BY id').all());
    const v1Sessions = inspect((db) => db.prepare('SELECT * FROM auth_sessions').all());

    const { store, service } = openTestAuth(dataRoot, clock);
    try {
      expect(userVersion()).toBe(3);
      expect(accountColumns()).toContain('password_state');
      expect(tableNames()).toEqual(['auth_accounts', 'auth_audit', 'auth_meta', 'auth_sessions', 'auth_setup_credentials', 'auth_studio_pilots']);
      // Existing rows are unchanged except for the defaulted password state.
      const after = inspect((db) => db.prepare('SELECT * FROM auth_accounts ORDER BY id').all() as Array<Record<string, unknown>>);
      expect(after.map(({ password_state: state, ...rest }) => { expect(state).toBe('set'); return rest; })).toEqual(v1Accounts);
      expect(inspect((db) => db.prepare('SELECT * FROM auth_sessions').all())).toEqual(v1Sessions);
      expect(inspect((db) => db.prepare('SELECT COUNT(*) AS n FROM auth_audit').get())).toEqual({ n: 0 });

      // The live v1 session still resolves; v1 passwords still log in.
      expect(service.resolveSession(fixture.sessionToken)).toMatchObject({ accountId: fixture.userId, username: 'v1-user', role: 'user' });
      await expect(service.login({ username: 'v1-user', password: USER_PW })).resolves.toBeTruthy();
      const admin = service.resolveSession((await service.login({ username: 'v1-admin', password: ADMIN_PW })).session.token)!;
      try {
        await service.login({ username: 'v1-gone', password: USER_PW });
        throw new Error('inactive v1 account logged in');
      } catch (error) {
        expect((error as AuthError).code).toBe('INVALID_CREDENTIALS');
      }
      // One-shot bootstrap stays closed.
      expect(service.isBootstrapRequired()).toBe(false);
      await expect(service.bootstrapFirstAdmin({ username: 'intruder', password: 'intruder-password-1' })).rejects.toMatchObject({ code: 'BOOTSTRAP_CLOSED' });
      // The upgraded store supports the new lifecycle.
      expect(service.searchAccounts(admin, {}).accounts.map((a) => [a.username, a.passwordState])).toEqual([
        ['v1-admin', 'set'], ['v1-user', 'set'], ['v1-gone', 'set'],
      ]);
      const { setup } = service.provisionAccount(admin, { username: 'v2-new', role: 'user' });
      await service.completePasswordSetup({ token: setup.token, password: 'v2-new-password-1' });
    } finally {
      store.close();
    }
  });

  it('is idempotent across repeated reopen', async () => {
    const fixture = await writeV1Fixture();
    for (let i = 0; i < 3; i += 1) {
      const { store, service } = openTestAuth(dataRoot, clock);
      try {
        expect(userVersion()).toBe(3);
        expect(service.resolveSession(fixture.sessionToken)).toMatchObject({ username: 'v1-user' });
        expect(service.isBootstrapRequired()).toBe(false);
      } finally { store.close(); }
    }
    expect(accountColumns().filter((c) => c === 'password_state')).toHaveLength(1);
  });

  it('rolls a failed upgrade back completely and retries cleanly on the next open', async () => {
    // A conflicting object makes the v2 step fail after its first statement.
    const fixture = await writeV1Fixture('CREATE VIEW auth_setup_credentials AS SELECT 1 AS x;');
    const before = readFileSync(file);
    expect(() => AuthStore.open({ dataRoot })).toThrow();
    expect(userVersion()).toBe(1);
    expect(accountColumns()).not.toContain('password_state');
    expect(tableNames()).toEqual(['auth_accounts', 'auth_meta', 'auth_sessions', 'auth_setup_credentials']);
    expect(inspect((db) => db.prepare('SELECT COUNT(*) AS n FROM auth_accounts').get())).toEqual({ n: 3 });
    expect(before.length).toBeGreaterThan(0);

    const db = new Database(file);
    db.exec('DROP VIEW auth_setup_credentials');
    db.close();
    const { store, service } = openTestAuth(dataRoot, clock);
    try {
      expect(userVersion()).toBe(3);
      expect(service.resolveSession(fixture.sessionToken)).toMatchObject({ username: 'v1-user' });
    } finally { store.close(); }
  });

  it('refuses a future schema without touching it', async () => {
    await writeV1Fixture();
    const db = new Database(file);
    db.pragma('user_version = 4');
    db.close();
    expect(() => AuthStore.open({ dataRoot })).toThrow(/newer than this daemon/);
    expect(userVersion()).toBe(4);
    expect(accountColumns()).not.toContain('password_state');
  });

  it('fails closed on an unknown persisted password state', async () => {
    await writeV1Fixture();
    const { store } = openTestAuth(dataRoot, clock);
    store.close();
    const db = new Database(file);
    // The CHECK constraint is the first line of defence; bypass it to model tampering.
    db.pragma('ignore_check_constraints = ON');
    db.prepare("UPDATE auth_accounts SET password_state = 'mystery' WHERE username = 'v1-user'").run();
    db.close();
    const reopened = openTestAuth(dataRoot, clock);
    try {
      expect(() => reopened.store.getAccountByUsername('v1-user')).toThrow(/unknown password state/);
    } finally { reopened.store.close(); }
  });

  it('creates a fresh store directly at v3', () => {
    const store = AuthStore.open({ dataRoot });
    store.close();
    expect(userVersion()).toBe(3);
    expect(tableNames()).toEqual(['auth_accounts', 'auth_audit', 'auth_meta', 'auth_sessions', 'auth_setup_credentials', 'auth_studio_pilots']);
  });
});
