// Issue #18 — durable state of personal Codex accounts across upgrades and failures:
// D1 migration of the prior schema that kept one identity per provider, D2 retained
// prior homes/credentials surviving retries and restarts, D3 unlink removing every
// retained copy of this owner's state (and nobody else's).
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PersonalLoginAttempt } from '@open-design/contracts';
import { PersonalCodexAccounts, actorRuntimeDir, personalCodexHome } from '../../src/services/personal-codex-accounts.js';
import { PERSONAL_CODEX_MOCK } from './personal-codex-helpers.js';

/** The account-service DDL exactly as shipped at 2fd5f112 (one identity per provider). */
const SCHEMA_2FD5F112 = `
  CREATE TABLE IF NOT EXISTS multiuser_agent_accounts (
    id TEXT PRIMARY KEY,
    owner_account_id TEXT NOT NULL CHECK (length(owner_account_id) > 0),
    provider TEXT NOT NULL CHECK (provider IN ('codex')),
    status TEXT NOT NULL CHECK (status IN ('connected','requires_reauth','disabled')),
    identity_hash TEXT NOT NULL, masked_identity TEXT NOT NULL, plan_type TEXT,
    credential_version INTEGER NOT NULL, last_problem TEXT, rate_limits_json TEXT,
    linked_at INTEGER NOT NULL, verified_at INTEGER, updated_at INTEGER NOT NULL,
    UNIQUE (owner_account_id, provider), UNIQUE (provider, identity_hash)
  );
  CREATE TRIGGER IF NOT EXISTS multiuser_agent_accounts_binding_immutable
    BEFORE UPDATE OF owner_account_id, provider, identity_hash ON multiuser_agent_accounts
    BEGIN SELECT RAISE(ABORT, 'agent account binding is immutable'); END;
  CREATE TABLE IF NOT EXISTS multiuser_agent_login_attempts (
    id TEXT PRIMARY KEY,
    owner_account_id TEXT NOT NULL CHECK (length(owner_account_id) > 0),
    provider TEXT NOT NULL CHECK (provider IN ('codex')),
    status TEXT NOT NULL CHECK (status IN ('pending','connected','denied','expired','canceled','failed')),
    failure_code TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_multiuser_agent_login_one_pending
    ON multiuser_agent_login_attempts(owner_account_id, provider) WHERE status = 'pending';
  CREATE TRIGGER IF NOT EXISTS multiuser_agent_login_owner_immutable
    BEFORE UPDATE OF owner_account_id, provider ON multiuser_agent_login_attempts
    BEGIN SELECT RAISE(ABORT, 'login attempt binding is immutable'); END;
  CREATE TABLE IF NOT EXISTS multiuser_agent_account_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS multiuser_agent_account_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT, actor_account_id TEXT NOT NULL, target_account_id TEXT NOT NULL,
    provider TEXT NOT NULL, action TEXT NOT NULL, detail TEXT, ref_id TEXT, created_at INTEGER NOT NULL
  );
  CREATE TRIGGER IF NOT EXISTS multiuser_agent_account_audit_immutable BEFORE UPDATE ON multiuser_agent_account_audit
    BEGIN SELECT RAISE(ABORT, 'agent account audit is append only'); END;
  CREATE TRIGGER IF NOT EXISTS multiuser_agent_account_audit_no_delete BEFORE DELETE ON multiuser_agent_account_audit
    BEGIN SELECT RAISE(ABORT, 'agent account audit is append only'); END;
`;

interface Fixture { root: string; dbPath: string; db: Database.Database; service: PersonalCodexAccounts; owner: string; home: string }
const fixtures: Fixture[] = [];
/** Added to the services' clock, to move an attempt past its deadline without waiting. */
let clockOffset = 0;

afterEach(async () => {
  vi.restoreAllMocks();
  clockOffset = 0;
  for (const r of fixtures.splice(0)) {
    await r.service.shutdown();
    r.db.close();
    fs.rmSync(r.root, { recursive: true, force: true });
  }
});

function open(root: string, dbPath: string) {
  const db = new Database(dbPath);
  return { db, service: new PersonalCodexAccounts({ db, dataRoot: root, appServerScript: PERSONAL_CODEX_MOCK,
    clock: () => Date.now() + clockOffset }) };
}

function make(seed?: (db: Database.Database) => void): Fixture {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'od-personal-retained-'));
  const dbPath = path.join(root, 'app.sqlite');
  if (seed) { const db = new Database(dbPath); try { seed(db); } finally { db.close(); } }
  const r = { root, dbPath, ...open(root, dbPath), owner: 'owner', home: personalCodexHome(root, 'owner') };
  fixtures.push(r);
  return r;
}

/** Shut the service down, close the database and open both again (a daemon restart). */
async function restart(r: Fixture): Promise<void> {
  await r.service.shutdown();
  r.db.close();
  Object.assign(r, open(r.root, r.dbPath));
}

const as = (r: Fixture, owner: string): Fixture => new Proxy(r, {
  get: (target, key) => (key === 'owner' ? owner : key === 'home' ? personalCodexHome(target.root, owner) : Reflect.get(target, key)),
});

async function until<T>(read: () => T, done: (value: T) => boolean): Promise<T> {
  const end = Date.now() + 5_000;
  for (;;) {
    const value = read();
    if (done(value)) return value;
    if (Date.now() > end) throw new Error(`wait timed out: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const loginDirs = (r: Fixture) => fs.readdirSync(actorRuntimeDir(r.root, r.owner)).filter((name) => name.startsWith('codex-login-'));
const aside = (r: Fixture) => path.join(actorRuntimeDir(r.root, r.owner), 'codex-home.previous');
const modeOf = (file: string) => fs.statSync(file).mode & 0o777;

function approve(r: Fixture, attempt: PersonalLoginAttempt, email = 'owner@example.com'): void {
  const device = path.join(actorRuntimeDir(r.root, r.owner), loginDirs(r)[0]!, '.mock-device');
  fs.mkdirSync(device, { recursive: true });
  fs.writeFileSync(path.join(device, attempt.userCode!), JSON.stringify({ outcome: 'approve', email }));
}

function settle(r: Fixture, id: string) {
  return until(() => r.db.prepare('SELECT status, failure_code FROM multiuser_agent_login_attempts WHERE id = ?').get(id) as
    { status: string; failure_code: string | null }, (row) => row.status !== 'pending');
}

async function login(r: Fixture, email = 'owner@example.com') {
  const attempt = await r.service.startLogin(r.owner);
  approve(r, attempt, email);
  const settled = await settle(r, attempt.id);
  await until(() => loginDirs(r), (names) => names.length === 0);
  return settled;
}

async function linked(r: Fixture, email = 'owner@example.com'): Promise<void> {
  expect((await login(r, email)).status).toBe('connected');
}

/** Link, add native state, then switch with both hardening and its restore failing. */
async function brokenSwitch(r: Fixture): Promise<{ auth: string }> {
  await linked(r);
  fs.mkdirSync(path.join(r.home, 'sessions'));
  fs.writeFileSync(path.join(r.home, 'sessions', 'old-thread'), 'old native state');
  r.service.secureHome(r.owner);
  const auth = fs.readFileSync(path.join(r.home, 'auth.json'), 'utf8');
  injectSwitchRestoreFailure(r);
  expect((await login(r, 'switched@example.org')).status).toBe('failed');
  vi.restoreAllMocks();
  expect(r.service.summary(r.owner).account).toMatchObject({ status: 'requires_reauth' });
  expect(r.service.usableAccount(r.owner)).toBeNull();
  expect(fs.existsSync(r.home)).toBe(false);
  expectOldState(aside(r), auth);
  return { auth };
}

function injectSwitchRestoreFailure(r: Fixture): void {
  const chmod = fs.chmodSync;
  const rename = fs.renameSync;
  let injected = false;
  vi.spyOn(fs, 'chmodSync').mockImplementation((file, mode) => {
    if (String(file) === r.home && !injected) { injected = true; throw new Error('switch chmod EIO'); }
    return chmod(file, mode);
  });
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (injected && String(from) === aside(r)) throw new Error('restore EIO');
    return rename(from, to);
  });
}

/** The old credential and its native session live, private, in `dir`. */
function expectOldState(dir: string, auth: string): void {
  expect(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8')).toBe(auth);
  expect(fs.readFileSync(path.join(dir, 'sessions', 'old-thread'), 'utf8')).toBe('old native state');
  expect(modeOf(dir)).toBe(0o700);
  expect(modeOf(path.join(dir, 'auth.json'))).toBe(0o600);
}

function noRetainedCopies(r: Fixture): void {
  expect(fs.existsSync(aside(r))).toBe(false);
  expect(fs.existsSync(path.join(r.home, 'auth.json.previous'))).toBe(false);
}

describe('D1: migrating the prior schema', () => {
  const seedLegacy = (db: Database.Database) => {
    db.exec(SCHEMA_2FD5F112);
    db.exec(`CREATE TABLE conversations (id TEXT PRIMARY KEY);
      CREATE TABLE multiuser_personal_sessions (conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
        owner_account_id TEXT NOT NULL, personal_account_id TEXT NOT NULL, thread_id TEXT, updated_at INTEGER NOT NULL);
      INSERT INTO conversations (id) VALUES ('conv-1');
      INSERT INTO multiuser_agent_accounts (id, owner_account_id, provider, status, identity_hash, masked_identity, plan_type,
        credential_version, last_problem, rate_limits_json, linked_at, verified_at, updated_at)
        VALUES ('acct-legacy', 'legacy-owner', 'codex', 'requires_reauth', 'hash-legacy', 'l***@example.com', 'plus', 3,
          'reauth_required', NULL, 100, 120, 130);
      INSERT INTO multiuser_agent_login_attempts (id, owner_account_id, provider, status, failure_code, created_at, expires_at, updated_at)
        VALUES ('attempt-legacy', 'legacy-owner', 'codex', 'connected', NULL, 90, 990, 100);
      INSERT INTO multiuser_agent_account_audit (actor_account_id, target_account_id, provider, action, detail, ref_id, created_at)
        VALUES ('legacy-owner', 'legacy-owner', 'codex', 'link_complete', 'connected', 'attempt-legacy', 100);
      INSERT INTO multiuser_personal_sessions (conversation_id, owner_account_id, personal_account_id, thread_id, updated_at)
        VALUES ('conv-1', 'legacy-owner', 'acct-legacy', 'thr-legacy', 140);`);
  };
  const snapshot = (db: Database.Database) => ({
    accounts: db.prepare('SELECT * FROM multiuser_agent_accounts ORDER BY id').all(),
    attempts: db.prepare('SELECT * FROM multiuser_agent_login_attempts ORDER BY id').all(),
    audit: db.prepare('SELECT * FROM multiuser_agent_account_audit ORDER BY id').all(),
    sessions: db.prepare('SELECT * FROM multiuser_personal_sessions ORDER BY conversation_id').all(),
  });
  const uniqueIndexes = (db: Database.Database) => (db.prepare('PRAGMA index_list(multiuser_agent_accounts)').all() as
    Array<{ name: string; unique: number; origin: string }>).filter((index) => index.unique === 1 && index.origin === 'u')
    .map((index) => (db.prepare(`PRAGMA index_info(${JSON.stringify(index.name)})`).all() as Array<{ name: string }>).map((c) => c.name).join(','));
  const tableSql = (db: Database.Database) => (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'multiuser_agent_accounts'")
    .get() as { sql: string }).sql;

  it('drops identity uniqueness, keeps rows, bindings and constraints, and is idempotent on restart', async () => {
    let before: ReturnType<typeof snapshot> | null = null;
    const r = make((db) => { seedLegacy(db); before = snapshot(db); });
    expect(uniqueIndexes(r.db).sort()).toEqual(['owner_account_id,provider']);
    expect(snapshot(r.db)).toEqual(before);
    expect(r.db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    expect(r.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(r.db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'multiuser_agent_accounts_%' AND type = 'table'").all()).toEqual([]);
    // Ownership stays immutable and unique; the identity changes only through a switch.
    expect(() => r.db.prepare("UPDATE multiuser_agent_accounts SET owner_account_id = 'x' WHERE id = 'acct-legacy'").run()).toThrow(/immutable/);
    expect(() => r.db.prepare("UPDATE multiuser_agent_accounts SET identity_hash = 'other' WHERE id = 'acct-legacy'").run()).toThrow(/switch/);
    expect(() => r.db.prepare(`INSERT INTO multiuser_agent_accounts (id, owner_account_id, provider, status, identity_hash, masked_identity,
      credential_version, linked_at, updated_at) VALUES ('dup', 'legacy-owner', 'codex', 'connected', 'h', 'm', 1, 1, 1)`).run()).toThrow(/UNIQUE/);
    const migrated = tableSql(r.db);
    await restart(r);
    expect(tableSql(r.db)).toBe(migrated);
    expect(snapshot(r.db)).toEqual(before);

    // Two platform owners may now link the same provider identity.
    await linked(r);
    await linked(as(r, 'other'));
    expect(r.service.usableAccount('other')).not.toBeNull();
    expect(r.service.usableAccount('owner')).not.toBeNull();
  });

  it('leaves the prior schema and rows untouched when the migration fails', () => {
    const root = fs.mkdtempSync(path.join(tmpdir(), 'od-personal-retained-'));
    const dbPath = path.join(root, 'app.sqlite');
    const db = new Database(dbPath);
    try {
      seedLegacy(db);
      const before = snapshot(db);
      const legacySql = tableSql(db);
      const exec = db.exec.bind(db);
      vi.spyOn(db, 'exec').mockImplementation((sql: string) => {
        if (/RENAME TO multiuser_agent_accounts\b/u.test(sql)) throw new Error('injected migration failure');
        return exec(sql);
      });
      expect(() => new PersonalCodexAccounts({ db, dataRoot: root, appServerScript: PERSONAL_CODEX_MOCK })).toThrow('injected migration failure');
      vi.restoreAllMocks();
      expect(tableSql(db)).toBe(legacySql);
      expect(snapshot(db)).toEqual(before);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'multiuser_agent_accounts_%' AND type = 'table'").all()).toEqual([]);
      // A later start migrates cleanly.
      new PersonalCodexAccounts({ db, dataRoot: root, appServerScript: PERSONAL_CODEX_MOCK });
      expect(uniqueIndexes(db)).toEqual(['owner_account_id,provider']);
      expect(snapshot(db)).toEqual(before);
    } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });
});

describe('D2: retained prior state survives retries and restarts', () => {
  it('restores the whole old home when switch hardening fails and restore succeeds', async () => {
    const r = make();
    await linked(r);
    fs.mkdirSync(path.join(r.home, 'sessions'));
    fs.writeFileSync(path.join(r.home, 'sessions', 'old-thread'), 'old native state');
    r.service.secureHome(r.owner);
    const auth = fs.readFileSync(path.join(r.home, 'auth.json'), 'utf8');
    const chmod = fs.chmodSync;
    let injected = false;
    vi.spyOn(fs, 'chmodSync').mockImplementation((file, mode) => {
      if (String(file) === r.home && !injected) { injected = true; throw new Error('chmod EIO'); }
      return chmod(file, mode);
    });
    expect((await login(r, 'switched@example.org')).status).toBe('failed');
    vi.restoreAllMocks();
    expectOldState(r.home, auth);
    noRetainedCopies(r);
    expect(r.service.usableAccount(r.owner)).not.toBeNull();
  });

  it('restores the retained home on restart and keeps the account unavailable', async () => {
    const r = make();
    const { auth } = await brokenSwitch(r);
    await restart(r);
    expectOldState(r.home, auth);
    noRetainedCopies(r);
    expect(r.service.summary(r.owner).account).toMatchObject({ status: 'requires_reauth' });
    expect(r.service.usableAccount(r.owner)).toBeNull();
  });

  it('never loses the only prior home when a switch retry fails after restart', async () => {
    const r = make();
    const { auth } = await brokenSwitch(r);
    await restart(r);
    expect(r.service.usableAccount(r.owner)).toBeNull();
    const rename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to) === r.home && String(from).includes('codex-login-')) throw new Error('second install EIO');
      return rename(from, to);
    });
    expect((await login(r, 'switched@example.org')).status).toBe('failed');
    vi.restoreAllMocks();
    // Restart reconciliation had already put the old home back; the failed retry undoes into it.
    expectOldState(r.home, auth);
    noRetainedCopies(r);
    expect(r.service.usableAccount(r.owner)).toBeNull();
  });

  it('keeps the only prior home through repeated failed switches without a restart', async () => {
    const r = make();
    const { auth } = await brokenSwitch(r);
    injectSwitchRestoreFailure(r);
    expect((await login(r, 'switched@example.org')).status).toBe('failed');
    vi.restoreAllMocks();
    expect(fs.existsSync(r.home)).toBe(false);
    expectOldState(aside(r), auth);
    expect(r.service.usableAccount(r.owner)).toBeNull();
  });

  it('recovers the original native sessions through a same-identity re-authorization and cleans up', async () => {
    const r = make();
    const { auth } = await brokenSwitch(r);
    await linked(r);
    expect(r.service.usableAccount(r.owner)).not.toBeNull();
    expect(fs.readFileSync(path.join(r.home, 'sessions', 'old-thread'), 'utf8')).toBe('old native state');
    expect(fs.readFileSync(path.join(r.home, 'auth.json'), 'utf8')).not.toBe(auth);
    expect(modeOf(r.home)).toBe(0o700);
    expect(modeOf(path.join(r.home, 'auth.json'))).toBe(0o600);
    noRetainedCopies(r);
  });

  it('commits a later switch after a failed one and removes the retained home only then', async () => {
    const r = make();
    await brokenSwitch(r);
    await linked(r, 'switched@example.org');
    expect(r.service.summary(r.owner).account).toMatchObject({ status: 'connected', maskedIdentity: 's***@example.org' });
    expect(fs.existsSync(path.join(r.home, 'sessions'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(r.home, 'auth.json'), 'utf8')).email).toBe('switched@example.org');
    noRetainedCopies(r);
  });
});

describe('D3: unlink removes every retained copy of this owner only', () => {
  it('removes a retained switch home and leaves another owner of the same identity intact', async () => {
    const r = make();
    const other = as(r, 'other');
    await linked(other);
    const otherAuth = fs.readFileSync(path.join(other.home, 'auth.json'), 'utf8');
    await brokenSwitch(r);
    const account = r.service.summary(r.owner).account!;
    expect(await r.service.unlink(r.owner, account.id)).toBe(true);
    expect(r.service.summary(r.owner).account).toBeNull();
    expect(fs.existsSync(r.home)).toBe(false);
    noRetainedCopies(r);
    expect(fs.readFileSync(path.join(other.home, 'auth.json'), 'utf8')).toBe(otherAuth);
    expect(r.service.usableAccount('other')).not.toBeNull();
    // A fresh link afterwards starts clean.
    await linked(r);
    noRetainedCopies(r);
  });

  it('keeps the account unavailable and its row when retained-state cleanup fails, then succeeds on retry', async () => {
    const r = make();
    await brokenSwitch(r);
    const account = r.service.summary(r.owner).account!;
    const rm = fs.rmSync;
    vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
      if (String(target) === aside(r)) throw new Error('cleanup EIO');
      return rm(target, options);
    });
    await expect(r.service.unlink(r.owner, account.id)).rejects.toThrow('cleanup EIO');
    vi.restoreAllMocks();
    expect(r.service.summary(r.owner).account).toMatchObject({ id: account.id, status: 'requires_reauth' });
    expect(r.service.usableAccount(r.owner)).toBeNull();
    expect(await r.service.unlink(r.owner, account.id)).toBe(true);
    expect(r.service.summary(r.owner).account).toBeNull();
    expect(fs.existsSync(r.home)).toBe(false);
    noRetainedCopies(r);
  });
});

// ---- Repair 7: convergence table rows (byo-run/repair7-state-table.md) -------------------
//
// A database written before the retained-state record existed (7329dfd2 and earlier) has the
// current account schema without `multiuser_agent_retained_state`. The legacy states below are
// the exact files 7329dfd2's fault paths leave behind: no record, a sole `codex-home.previous`
// or `auth.json.previous`, or such a backup next to an active copy.

interface Legacy { auth: string; newAuth: string }

/** Link, add native state, stop, turn the database into a pre-record one and shape the files. */
async function legacyUpgrade(r: Fixture, shape: (paths: { home: string; aside: string; auth: string; backup: string }) => void,
  db?: (db: Database.Database) => void): Promise<Legacy> {
  await linked(r);
  fs.mkdirSync(path.join(r.home, 'sessions'));
  fs.writeFileSync(path.join(r.home, 'sessions', 'old-thread'), 'old native state');
  r.service.secureHome(r.owner);
  const auth = fs.readFileSync(path.join(r.home, 'auth.json'), 'utf8');
  await r.service.shutdown();
  r.db.exec('DROP TABLE multiuser_agent_retained_state');
  r.db.prepare("UPDATE multiuser_agent_accounts SET status = 'requires_reauth', last_problem = 'reauth_required' WHERE owner_account_id = ?").run(r.owner);
  db?.(r.db);
  shape({ home: r.home, aside: aside(r), auth: path.join(r.home, 'auth.json'), backup: path.join(r.home, 'auth.json.previous') });
  r.db.close();
  Object.assign(r, open(r.root, r.dbPath));
  return { auth, newAuth: 'mock-uncommitted-or-committed-replacement' };
}

/** A second, different credential/home written the way the legacy install leaves it (0700/0600). */
function writeReplacementHome(dir: string, content: string): void {
  fs.mkdirSync(dir, { mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'auth.json'), content, { mode: 0o600 });
}

function expectFenced(r: Fixture): void {
  expect(r.service.usableAccount(r.owner)).toBeNull();
  expect(r.service.summary(r.owner).account).toMatchObject({ status: 'requires_reauth' });
}

describe('repair 7: legacy and record-aware retained state', () => {
  it('row 4: adopts a sole legacy credential backup on upgrade, then same-identity reauth keeps sessions (row 9)', async () => {
    const r = make();
    const { auth } = await legacyUpgrade(r, (p) => fs.renameSync(p.auth, p.backup));
    expectOldState(r.home, auth);
    noRetainedCopies(r);
    expectFenced(r);
    await linked(r);
    expect(r.service.usableAccount(r.owner)).not.toBeNull();
    expect(fs.readFileSync(path.join(r.home, 'sessions', 'old-thread'), 'utf8')).toBe('old native state');
    expect(fs.readFileSync(path.join(r.home, 'auth.json'), 'utf8')).not.toBe(auth);
    noRetainedCopies(r);
  });

  it('row 5: adopts a sole legacy whole-home backup on upgrade, then a switch commits (row 10)', async () => {
    const r = make();
    const { auth } = await legacyUpgrade(r, (p) => fs.renameSync(p.home, p.aside));
    expectOldState(r.home, auth);
    noRetainedCopies(r);
    expectFenced(r);
    await restart(r);
    expectOldState(r.home, auth);
    await linked(r, 'switched@example.org');
    expect(r.service.summary(r.owner).account).toMatchObject({ status: 'connected', maskedIdentity: 's***@example.org' });
    expect(fs.existsSync(path.join(r.home, 'sessions'))).toBe(false);
    noRetainedCopies(r);
  });

  it.each([
    ['6a: legacy home backup beside an active home', (p: { home: string; aside: string }, next: string) => {
      fs.renameSync(p.home, p.aside);
      writeReplacementHome(p.home, next);
    }],
    ['6b: legacy credential backup beside an active credential', (p: { auth: string; backup: string }, next: string) => {
      fs.renameSync(p.auth, p.backup);
      fs.writeFileSync(p.auth, next, { mode: 0o600 });
    }],
  ] as const)('row %s: keeps every copy private and fenced across restart; unlink still removes every copy', async (_name, shape) => {
    const r = make();
    const other = as(r, 'other');
    await linked(other);
    const otherAuth = fs.readFileSync(path.join(other.home, 'auth.json'), 'utf8');
    const next = 'mock-ambiguous-active-credential';
    const { auth } = await legacyUpgrade(r, (p) => shape(p, next));
    const original = fs.existsSync(aside(r)) ? aside(r) : null;
    const check = () => {
      if (original) {
        expectOldState(original, auth);
        expect(fs.readFileSync(path.join(r.home, 'auth.json'), 'utf8')).toBe(next);
      } else {
        expect(fs.readFileSync(path.join(r.home, 'auth.json.previous'), 'utf8')).toBe(auth);
        expect(modeOf(path.join(r.home, 'auth.json.previous'))).toBe(0o600);
        expect(fs.readFileSync(path.join(r.home, 'auth.json'), 'utf8')).toBe(next);
        expect(fs.readFileSync(path.join(r.home, 'sessions', 'old-thread'), 'utf8')).toBe('old native state');
      }
      expect(modeOf(r.home)).toBe(0o700);
      expect(modeOf(path.join(r.home, 'auth.json'))).toBe(0o600);
      expectFenced(r);
    };
    check();
    await restart(r);
    check();
    const account = r.service.summary(r.owner).account!;
    expect(await r.service.unlink(r.owner, account.id)).toBe(true);
    expect(fs.existsSync(r.home)).toBe(false);
    noRetainedCopies(r);
    expect(fs.readFileSync(path.join(other.home, 'auth.json'), 'utf8')).toBe(otherAuth);
    expect(r.service.usableAccount('other')).not.toBeNull();
    await linked(r);
    expect(r.service.usableAccount(r.owner)).not.toBeNull();
  });

  it('row 6c: mixed legacy backups (home set aside, credential backup in the active home) are both kept', async () => {
    const r = make();
    const { auth } = await legacyUpgrade(r, (p) => {
      fs.renameSync(p.home, p.aside);
      writeReplacementHome(p.home, 'mock-ambiguous-active-credential');
      fs.writeFileSync(path.join(p.home, 'auth.json.previous'), 'mock-older-credential', { mode: 0o600 });
    });
    expectOldState(aside(r), auth);
    expect(fs.readFileSync(path.join(r.home, 'auth.json.previous'), 'utf8')).toBe('mock-older-credential');
    expect(fs.readFileSync(path.join(r.home, 'auth.json'), 'utf8')).toBe('mock-ambiguous-active-credential');
    expectFenced(r);
  });

  it('row 8: a legacy restore that fails on upgrade keeps the copy fenced, and the next start restores it', async () => {
    const r = make();
    const rename = fs.renameSync;
    const { auth } = await legacyUpgrade(r, (p) => {
      fs.renameSync(p.home, p.aside);
      vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
        if (String(from) === aside(r)) throw new Error('upgrade restore EIO');
        return rename(from, to);
      });
    });
    vi.restoreAllMocks();
    expect(fs.existsSync(r.home)).toBe(false);
    expectOldState(aside(r), auth);
    expectFenced(r);
    await restart(r);
    expectOldState(r.home, auth);
    noRetainedCopies(r);
    expectFenced(r);
  });

  it.each(['home', 'credential'] as const)('row 7: a post-commit %s cleanup failure never reverts the committed account on restart', async (kind) => {
    const r = make();
    await linked(r);
    const attempt = await r.service.startLogin(r.owner);
    const target = kind === 'home' ? aside(r) : path.join(r.home, 'auth.json.previous');
    const rm = fs.rmSync;
    let blocked = false;
    vi.spyOn(fs, 'rmSync').mockImplementation((file, options) => {
      const row = r.db.prepare('SELECT status FROM multiuser_agent_login_attempts WHERE id = ?').get(attempt.id) as { status: string };
      if (String(file) === target && row.status === 'connected') { blocked = true; throw new Error('post-commit cleanup EIO'); }
      return rm(file, options);
    });
    approve(r, attempt, kind === 'home' ? 'switched@example.org' : 'owner@example.com');
    expect((await settle(r, attempt.id)).status).toBe('connected');
    vi.restoreAllMocks();
    await until(() => loginDirs(r), (names) => names.length === 0);
    expect(blocked).toBe(true);
    const committed = { account: r.service.summary(r.owner).account, auth: fs.readFileSync(path.join(r.home, 'auth.json'), 'utf8') };
    await restart(r);
    expect(r.service.summary(r.owner).account).toEqual(committed.account);
    expect(fs.readFileSync(path.join(r.home, 'auth.json'), 'utf8')).toBe(committed.auth);
    noRetainedCopies(r);
    expect(r.service.usableAccount(r.owner)).not.toBeNull();
  });

  it.each(['switch', 'reauthorize'] as const)('rows 2/3: an installed but uncommitted %s is undone on restart', async (mode) => {
    const r = make();
    await linked(r);
    fs.mkdirSync(path.join(r.home, 'sessions'));
    fs.writeFileSync(path.join(r.home, 'sessions', 'old-thread'), 'old native state');
    r.service.secureHome(r.owner);
    const auth = fs.readFileSync(path.join(r.home, 'auth.json'), 'utf8');
    const row = r.db.prepare('SELECT * FROM multiuser_agent_accounts').get();
    const staging = path.join(actorRuntimeDir(r.root, r.owner), 'codex-login-crash-fixture');
    writeReplacementHome(staging, 'mock-uncommitted');
    // A crash between installing the files and the bind transaction.
    (r.service as unknown as { installCredentials: (...args: unknown[]) => void }).installCredentials(r.owner, staging, mode, () => {});
    expect(r.service.usableAccount(r.owner)).toBeNull();
    await restart(r);
    expectOldState(r.home, auth);
    noRetainedCopies(r);
    expect(r.db.prepare('SELECT * FROM multiuser_agent_accounts').get()).toEqual(row);
    expect(r.service.usableAccount(r.owner)).not.toBeNull();
  });

  it('row 12: a legacy home backup left by a pre-record unlink is removed when the owner links again', async () => {
    const r = make();
    await legacyUpgrade(r, (p) => fs.renameSync(p.home, p.aside),
      (db) => db.prepare('DELETE FROM multiuser_agent_accounts WHERE owner_account_id = ?').run(r.owner));
    expect(r.service.summary(r.owner).account).toBeNull();
    await linked(r);
    expect(r.service.usableAccount(r.owner)).not.toBeNull();
    expect(fs.existsSync(path.join(r.home, 'sessions'))).toBe(false);
    noRetainedCopies(r);
  });
});

// ---- Row 6, confirmed decision (issue18-decision4: "reauth commit = proof") ---------------
//
// Ambiguous legacy copies stay private and fenced until a NEW authorization commits. That
// commit (same account row, credential version +1, verification and problem cleared, native
// thread pins reset even for the same identity) is the proof that retires both old copies.
// Anything short of a commit keeps every byte and mode of both copies and the fence.

type AmbiguousForm = 'whole-home' | 'auth-only' | 'mixed';

async function ambiguousState(r: Fixture, form: AmbiguousForm): Promise<void> {
  await legacyUpgrade(r, (p) => {
    if (form === 'auth-only') {
      fs.renameSync(p.auth, p.backup);
      fs.writeFileSync(p.auth, 'mock-ambiguous-active-credential', { mode: 0o600 });
      return;
    }
    fs.renameSync(p.home, p.aside);
    writeReplacementHome(p.home, 'mock-ambiguous-active-credential');
    if (form === 'mixed') fs.writeFileSync(p.backup, 'mock-older-credential', { mode: 0o600 });
  }, (db) => db.prepare('UPDATE multiuser_agent_accounts SET verified_at = 123 WHERE owner_account_id = ?').run(r.owner));
  expect(retainedKind(r)).toBe('ambiguous');
}

const retainedKind = (r: Fixture) => (r.db.prepare('SELECT kind FROM multiuser_agent_retained_state WHERE owner_account_id = ?')
  .get(r.owner) as { kind: string } | undefined)?.kind ?? null;
const accountRow = (r: Fixture) => r.db.prepare('SELECT * FROM multiuser_agent_accounts WHERE owner_account_id = ?').get(r.owner) as
  { id: string; credential_version: number; verified_at: number | null; last_problem: string | null; status: string };

/** Every path, mode and byte of this owner's state outside login staging. */
function snapshot(r: Fixture): Record<string, string> {
  const out: Record<string, string> = {};
  const root = actorRuntimeDir(r.root, r.owner);
  const walk = (dir: string) => {
    for (const name of fs.readdirSync(dir).sort()) {
      if (dir === root && name.startsWith('codex-login-')) continue;
      const full = path.join(dir, name);
      const info = fs.lstatSync(full);
      const rel = path.relative(root, full);
      if (info.isDirectory()) { out[`${rel}/`] = (info.mode & 0o777).toString(8); walk(full); }
      else out[rel] = `${(info.mode & 0o777).toString(8)}:${fs.readFileSync(full, 'utf8')}`;
    }
  };
  walk(root);
  return out;
}

function expectPreserved(r: Fixture, before: Record<string, string>): void {
  expect(snapshot(r)).toEqual(before);
  expect(retainedKind(r)).toBe('ambiguous');
  expectFenced(r);
}

describe('row 6: re-authorization out of ambiguous legacy state (commit = proof)', () => {
  it.each([
    ['whole-home', 'owner@example.com'], ['auth-only', 'owner@example.com'], ['mixed', 'owner@example.com'],
    ['whole-home', 'switched@example.org'], ['auth-only', 'switched@example.org'],
  ] as const)('%s with %s: commits a fresh subscription home, resets pins, then removes both old copies', async (form, email) => {
    const r = make();
    const other = as(r, 'other');
    await linked(other);
    const otherAuth = fs.readFileSync(path.join(other.home, 'auth.json'), 'utf8');
    await ambiguousState(r, form);
    const before = accountRow(r);
    const forgotten: string[] = [];
    r.service.setRunHooks({ cancelPersonalRuns: async () => {}, forgetNativeSessions: (owner) => { forgotten.push(owner); } });
    expect((await login(r, email)).status).toBe('connected');
    const after = accountRow(r);
    expect(after).toMatchObject({ id: before.id, status: 'connected', credential_version: before.credential_version + 1,
      verified_at: null, last_problem: null });
    expect(r.service.usableAccount(r.owner)).toMatchObject({ id: before.id, credentialVersion: before.credential_version + 1 });
    expect(forgotten).toEqual([r.owner]);
    // Only the new login remains: no old credential, no old native sessions, no retained copy.
    expect(JSON.parse(fs.readFileSync(path.join(r.home, 'auth.json'), 'utf8')).email).toBe(email);
    expect(fs.existsSync(path.join(r.home, 'sessions'))).toBe(false);
    noRetainedCopies(r);
    expect(retainedKind(r)).toBeNull();
    expect(Object.keys(snapshot(r)).filter((name) => !name.startsWith('codex-home'))).toEqual([]);
    expect(modeOf(r.home)).toBe(0o700);
    expect(modeOf(path.join(r.home, 'auth.json'))).toBe(0o600);
    expect(fs.readFileSync(path.join(other.home, 'auth.json'), 'utf8')).toBe(otherAuth);
    expect(r.service.usableAccount('other')).not.toBeNull();
  });

  it.each(['whole-home', 'auth-only', 'mixed'] as const)('%s: a failed install keeps both copies and the fence across restart, then a retry commits', async (form) => {
    const r = make();
    await ambiguousState(r, form);
    const before = snapshot(r);
    const chmod = fs.chmodSync;
    let injected = false;
    vi.spyOn(fs, 'chmodSync').mockImplementation((file, mode) => {
      if (String(file) === r.home && !injected) { injected = true; throw new Error('install chmod EIO'); }
      return chmod(file, mode);
    });
    expect((await login(r)).status).toBe('failed');
    vi.restoreAllMocks();
    expect(injected).toBe(true);
    expectPreserved(r, before);
    await restart(r);
    expectPreserved(r, before);
    expect((await login(r)).status).toBe('connected');
    noRetainedCopies(r);
    expect(r.service.usableAccount(r.owner)).not.toBeNull();
  });

  it('a failed bind transaction is no deletion authority', async () => {
    const r = make();
    await ambiguousState(r, 'mixed');
    const before = snapshot(r);
    r.db.exec("CREATE TRIGGER test_fail_bind BEFORE UPDATE ON multiuser_agent_accounts BEGIN SELECT RAISE(ABORT, 'injected bind failure'); END");
    try { expect((await login(r, 'switched@example.org')).status).toBe('failed'); } finally { r.db.exec('DROP TRIGGER test_fail_bind'); }
    expectPreserved(r, before);
  });

  it('expiry, denial and cancel before binding keep both copies and the fence', async () => {
    const r = make();
    await ambiguousState(r, 'whole-home');
    const before = snapshot(r);
    const expiring = await r.service.startLogin(r.owner);
    clockOffset = expiring.expiresAt - Date.now() + 1;
    approve(r, expiring);
    expect((await settle(r, expiring.id)).status).toBe('expired');
    clockOffset = 0;
    await until(() => loginDirs(r), (names) => names.length === 0);
    expectPreserved(r, before);
    const denied = await r.service.startLogin(r.owner);
    const device = path.join(actorRuntimeDir(r.root, r.owner), loginDirs(r)[0]!, '.mock-device');
    fs.mkdirSync(device, { recursive: true });
    fs.writeFileSync(path.join(device, denied.userCode!), JSON.stringify({ outcome: 'deny' }));
    expect((await settle(r, denied.id)).status).toBe('denied');
    await until(() => loginDirs(r), (names) => names.length === 0);
    expectPreserved(r, before);
    const canceled = await r.service.startLogin(r.owner);
    await r.service.cancelLogin(r.owner, canceled.id);
    expectPreserved(r, before);
  });

  it('a crash between installing and committing is undone on restart, keeping the fence', async () => {
    const r = make();
    await ambiguousState(r, 'mixed');
    const before = snapshot(r);
    const staging = path.join(actorRuntimeDir(r.root, r.owner), 'codex-login-crash-fixture');
    writeReplacementHome(staging, 'mock-uncommitted');
    (r.service as unknown as { installCredentials: (...args: unknown[]) => void })
      .installCredentials(r.owner, staging, 'replaceAmbiguous', () => {});
    expect(r.service.usableAccount(r.owner)).toBeNull();
    await restart(r);
    expectPreserved(r, before);
    expect((await login(r)).status).toBe('connected');
    noRetainedCopies(r);
  });

  it('a failed undo keeps the evidence; the next start puts it back', async () => {
    const r = make();
    await ambiguousState(r, 'whole-home');
    const before = snapshot(r);
    const chmod = fs.chmodSync;
    const rename = fs.renameSync;
    let injected = false;
    vi.spyOn(fs, 'chmodSync').mockImplementation((file, mode) => {
      if (String(file) === r.home && !injected) { injected = true; throw new Error('install chmod EIO'); }
      return chmod(file, mode);
    });
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (injected && String(to) === r.home) throw new Error('undo EIO');
      return rename(from, to);
    });
    expect((await login(r)).status).toBe('failed');
    vi.restoreAllMocks();
    expect(retainedKind(r)).toBe('ambiguous');
    expectFenced(r);
    await restart(r);
    expectPreserved(r, before);
  });
});

// ---- #20: legacy copies written with the provider's umask are hardened on start -----------
//
// 7329dfd2's fault paths could leave the active credential (and copies beside it) at 0644,
// because the provider child writes with its own umask and the failed install never got to
// re-apply modes. Adoption keeps every copy; the start that adopts them must also make them
// private, without moving or deleting anything and without lifting the fence.

/** Loosen every mode under the owner's state the way an un-hardened provider write leaves it. */
function loosen(r: Fixture): void {
  const walk = (dir: string) => {
    fs.chmodSync(dir, 0o755);
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.lstatSync(full).isDirectory()) walk(full);
      else fs.chmodSync(full, 0o644);
    }
  };
  for (const dir of [r.home, aside(r)]) if (fs.existsSync(dir)) walk(dir);
}

/** Same paths and bytes as `before`, with every directory 0700 and every file 0600. */
function hardened(before: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(before).map(([rel, value]) => [rel,
    rel.endsWith('/') ? '700' : `600:${value.slice(value.indexOf(':') + 1)}`]));
}

describe('#20: hardening adopted legacy credential modes', () => {
  it.each([
    ['whole-home', 'owner@example.com'], ['auth-only', 'owner@example.com'], ['mixed', 'owner@example.com'],
    ['whole-home', 'switched@example.org'], ['auth-only', 'switched@example.org'],
  ] as const)('%s, then reauth as %s: every copy becomes private on start and stays fenced until commit', async (form, email) => {
    const r = make();
    const other = as(r, 'other');
    await linked(other);
    const otherAuth = fs.readFileSync(path.join(other.home, 'auth.json'), 'utf8');
    await ambiguousState(r, form);
    loosen(r);
    const before = snapshot(r);
    expect(Object.values(before).some((value) => value.startsWith('644:'))).toBe(true);
    await restart(r);
    expectPreserved(r, hardened(before));
    await restart(r);
    expectPreserved(r, hardened(before));
    // Re-authorization out of the hardened ambiguous state still commits and retires both copies.
    expect((await login(r, email)).status).toBe('connected');
    noRetainedCopies(r);
    expect(modeOf(r.home)).toBe(0o700);
    expect(modeOf(path.join(r.home, 'auth.json'))).toBe(0o600);
    expect(fs.readFileSync(path.join(other.home, 'auth.json'), 'utf8')).toBe(otherAuth);
    expect(r.service.usableAccount('other')).not.toBeNull();
  });

  it('a hardening failure keeps every copy, the record and the fence; the next start hardens', async () => {
    const r = make();
    await ambiguousState(r, 'mixed');
    loosen(r);
    const before = snapshot(r);
    await r.service.shutdown();
    r.db.close();
    const chmod = fs.chmodSync;
    vi.spyOn(fs, 'chmodSync').mockImplementation((file, mode) => {
      if (String(file) === path.join(r.home, 'auth.json')) throw new Error('harden chmod EIO');
      return chmod(file, mode);
    });
    Object.assign(r, open(r.root, r.dbPath));
    vi.restoreAllMocks();
    const after = snapshot(r);
    expect(Object.keys(after)).toEqual(Object.keys(before));
    // Bytes are untouched; modes may be partly hardened before the injected failure.
    for (const [rel, value] of Object.entries(before)) {
      if (rel.endsWith('/')) continue;
      expect(after[rel]!.slice(after[rel]!.indexOf(':') + 1)).toBe(value.slice(value.indexOf(':') + 1));
    }
    expect(retainedKind(r)).toBe('ambiguous');
    expectFenced(r);
    await restart(r);
    expectPreserved(r, hardened(before));
  });

  it('hardens a connected home left at 0644 and keeps it usable', async () => {
    const r = make();
    await linked(r);
    loosen(r);
    await restart(r);
    expect(modeOf(r.home)).toBe(0o700);
    expect(modeOf(path.join(r.home, 'auth.json'))).toBe(0o600);
    expect(r.service.usableAccount(r.owner)).not.toBeNull();
  });
});

// ---- Restore from a backup that excluded provider homes (user decision 2026-10-06) --------

describe('a data root restored without provider homes', () => {
  it.each([
    ['the whole home', (r: Fixture) => fs.rmSync(r.home, { recursive: true, force: true })],
    ['only the credential', (r: Fixture) => fs.rmSync(path.join(r.home, 'auth.json'))],
  ] as const)('missing %s: the account requires re-authorization on start, and re-authorization restores it', async (_name, drop) => {
    const r = make();
    await linked(r);
    expect(r.service.usableAccount(r.owner)).not.toBeNull();
    await r.service.shutdown();
    drop(r);
    await restart(r);
    expect(r.service.summary(r.owner).account).toMatchObject({ status: 'requires_reauth', lastProblem: 'reauth_required' });
    expect(r.service.usableAccount(r.owner)).toBeNull();
    await linked(r);
    expect(r.service.usableAccount(r.owner)).not.toBeNull();
  });
});
