// Issue #18 — service-level edge cases of the personal Codex account lifecycle:
// bind rollback (SQL and filesystem failures), deadline before any re-authorization
// side effect, fence release on rejection, and unlink racing a re-authorization.
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { AppServerAccountClient } from '../../src/integrations/codex-app-server-account.js';
import type { PersonalLoginAttempt } from '@open-design/contracts';
import { PersonalCodexAccounts, actorRuntimeDir, personalCodexHome } from '../../src/services/personal-codex-accounts.js';
import { PERSONAL_CODEX_MOCK } from './personal-codex-helpers.js';

type Fixture = ReturnType<typeof make>;
const resources: Array<{ service: PersonalCodexAccounts; db: Database.Database; root: string }> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const r of resources.splice(0)) {
    await r.service.shutdown();
    r.db.close();
    fs.rmSync(r.root, { recursive: true, force: true });
  }
});

function make() {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'od-personal-service-'));
  const db = new Database(':memory:');
  let now = Date.now();
  const service = new PersonalCodexAccounts({ db, dataRoot: root, appServerScript: PERSONAL_CODEX_MOCK, clock: () => now });
  resources.push({ root, db, service });
  return { root, db, service, advance: (value: number) => { now = value; }, owner: 'owner', home: personalCodexHome(root, 'owner') };
}

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

function approve(r: Fixture, attempt: PersonalLoginAttempt): void {
  const device = path.join(actorRuntimeDir(r.root, r.owner), loginDirs(r)[0]!, '.mock-device');
  fs.mkdirSync(device, { recursive: true });
  fs.writeFileSync(path.join(device, attempt.userCode!), JSON.stringify({ outcome: 'approve', email: 'owner@example.com' }));
}

function settle(r: Fixture, id: string) {
  return until(() => r.db.prepare('SELECT status FROM multiuser_agent_login_attempts WHERE id = ?').get(id) as { status: string },
    (row) => row.status !== 'pending');
}

async function linked(r: Fixture): Promise<void> {
  const attempt = await r.service.startLogin(r.owner);
  approve(r, attempt);
  expect((await settle(r, attempt.id)).status).toBe('connected');
}

it('restores the previous credential and releases the fence when the SQL bind fails', async () => {
  const r = make();
  await linked(r);
  const old = fs.readFileSync(path.join(r.home, 'auth.json'), 'utf8');
  r.db.exec("CREATE TRIGGER fail_reauth BEFORE UPDATE ON multiuser_agent_accounts BEGIN SELECT RAISE(ABORT, 'injected SQL bind failure'); END");
  const attempt = await r.service.startLogin(r.owner);
  approve(r, attempt);
  expect((await settle(r, attempt.id)).status).toBe('failed');
  await until(() => loginDirs(r), (names) => names.length === 0);
  expect(fs.readFileSync(path.join(r.home, 'auth.json'), 'utf8')).toBe(old);
  expect(fs.statSync(path.join(r.home, 'auth.json')).mode & 0o777).toBe(0o600);
  expect(r.service.usableAccount(r.owner)).not.toBeNull();
});

it('restores the previous credential when permission hardening fails after the credential swap', async () => {
  const r = make();
  await linked(r);
  const auth = path.join(r.home, 'auth.json');
  const old = fs.readFileSync(auth, 'utf8');
  const attempt = await r.service.startLogin(r.owner);
  const original = fs.chmodSync;
  let injected = false;
  const spy = vi.spyOn(fs, 'chmodSync').mockImplementation((file, mode) => {
    if (String(file) === auth && !injected) {
      injected = true;
      throw Object.assign(new Error('injected chmod failure'), { code: 'EIO' });
    }
    return original(file, mode);
  });
  approve(r, attempt);
  expect((await settle(r, attempt.id)).status).toBe('failed');
  spy.mockRestore();
  expect(injected).toBe(true);
  await until(() => loginDirs(r), (names) => names.length === 0);
  expect({ restored: fs.readFileSync(auth, 'utf8') === old, mode: fs.statSync(auth).mode & 0o777, usable: r.service.usableAccount(r.owner) !== null })
    .toEqual({ restored: true, mode: 0o600, usable: true });
});

it('marks the account requires_reauth and keeps the backup when the credential cannot be restored', async () => {
  const r = make();
  await linked(r);
  const auth = path.join(r.home, 'auth.json');
  const attempt = await r.service.startLogin(r.owner);
  const originalChmod = fs.chmodSync;
  const originalRename = fs.renameSync;
  let failRestore = false;
  vi.spyOn(fs, 'chmodSync').mockImplementation((file, mode) => {
    if (String(file) === auth && !failRestore) {
      failRestore = true;
      throw Object.assign(new Error('injected chmod failure'), { code: 'EIO' });
    }
    return originalChmod(file, mode);
  });
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (failRestore && String(to) === auth) throw Object.assign(new Error('injected restore failure'), { code: 'EIO' });
    return originalRename(from, to);
  });
  approve(r, attempt);
  expect((await settle(r, attempt.id)).status).toBe('failed');
  vi.restoreAllMocks();
  expect(r.service.usableAccount(r.owner)).toBeNull();
  expect(r.service.summary(r.owner).account).toMatchObject({ status: 'requires_reauth', lastProblem: 'reauth_required' });
  expect(fs.existsSync(auth)).toBe(false);
  // The previous credential is kept (privately) rather than deleted with the staging directory.
  const backups = fs.readdirSync(r.home).filter((name) => name.startsWith('auth.json.'));
  expect(backups).toHaveLength(1);
  expect(fs.statSync(path.join(r.home, backups[0]!)).mode & 0o777).toBe(0o600);
});

it('has no side effects when the attempt expires during the account read', async () => {
  const r = make();
  await linked(r);
  let canceled = 0;
  r.service.setRunHooks({ cancelPersonalRuns: async () => { canceled += 1; } });
  const before = r.service.usableAccount(r.owner);
  const auth = fs.readFileSync(path.join(r.home, 'auth.json'), 'utf8');
  const attempt = await r.service.startLogin(r.owner);
  const original = AppServerAccountClient.prototype.request;
  vi.spyOn(AppServerAccountClient.prototype, 'request').mockImplementation(async function (this: AppServerAccountClient, method, params, timeout) {
    const result = await original.call(this, method, params, timeout);
    if (method === 'account/read') r.advance(attempt.expiresAt + 1);
    return result;
  });
  approve(r, attempt);
  expect((await settle(r, attempt.id)).status).toBe('expired');
  vi.restoreAllMocks();
  expect(canceled).toBe(0);
  expect(r.service.usableAccount(r.owner)).toEqual(before);
  expect(fs.readFileSync(path.join(r.home, 'auth.json'), 'utf8')).toBe(auth);
});

it('releases the re-authorization and unlink fences if cancellation rejects', async () => {
  const r = make();
  await linked(r);
  const account = r.service.summary(r.owner).account!;
  const old = fs.readFileSync(path.join(r.home, 'auth.json'), 'utf8');
  r.service.setRunHooks({ cancelPersonalRuns: async () => { throw new Error('injected cancellation rejection'); } });
  const attempt = await r.service.startLogin(r.owner);
  approve(r, attempt);
  expect((await settle(r, attempt.id)).status).toBe('failed');
  await until(() => loginDirs(r), (names) => names.length === 0);
  expect(r.service.usableAccount(r.owner)).not.toBeNull();
  expect(fs.readFileSync(path.join(r.home, 'auth.json'), 'utf8')).toBe(old);
  await expect(r.service.unlink(r.owner, account.id)).rejects.toThrow('injected cancellation rejection');
  expect(r.service.usableAccount(r.owner)).not.toBeNull();
  const next = await r.service.startLogin(r.owner);
  await r.service.cancelLogin(r.owner, next.id);
});

it('does not resurrect credentials when unlink races an in-flight re-authorization', async () => {
  const r = make();
  await linked(r);
  const account = r.service.summary(r.owner).account!;
  let release!: () => void;
  let entered!: () => void;
  let calls = 0;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const called = new Promise<void>((resolve) => { entered = resolve; });
  r.service.setRunHooks({ cancelPersonalRuns: async () => { if (++calls === 1) { entered(); await blocked; } } });
  const attempt = await r.service.startLogin(r.owner);
  approve(r, attempt);
  await called;
  expect(r.service.usableAccount(r.owner)).toBeNull();
  try { expect(await r.service.unlink(r.owner, account.id)).toBe(true); } finally { release(); }
  expect((await settle(r, attempt.id)).status).toBe('canceled');
  await new Promise((resolve) => setImmediate(resolve));
  expect(r.service.summary(r.owner).account).toBeNull();
  expect(fs.existsSync(r.home)).toBe(false);
  expect(loginDirs(r)).toEqual([]);
  r.service.setRunHooks({ cancelPersonalRuns: async () => {} });
  await linked(r);
  expect(r.service.usableAccount(r.owner)).not.toBeNull();
});

// Real codex 0.154.0 (2026-10-06 acceptance) announced a successful device login while
// the same process's `account/read` still lacked the account; the identity is then read
// from a fresh child on the persisted login home.
function decide(r: Fixture, attempt: PersonalLoginAttempt, body: Record<string, unknown>): void {
  const device = path.join(actorRuntimeDir(r.root, r.owner), loginDirs(r)[0]!, '.mock-device');
  fs.mkdirSync(device, { recursive: true });
  fs.writeFileSync(path.join(device, attempt.userCode!), JSON.stringify(body));
}

it('reads the identity from the persisted login home when the live read-back is stale', async () => {
  const r = make();
  const attempt = await r.service.startLogin(r.owner);
  decide(r, attempt, { outcome: 'approve-stale-read', email: 'Owner@Example.com', planType: 'pro' });
  expect((await settle(r, attempt.id)).status).toBe('connected');
  expect(r.service.summary(r.owner).account).toMatchObject({ status: 'connected', maskedIdentity: 'o***@example.com', planType: 'pro' });
  expect(fs.statSync(path.join(r.home, 'auth.json')).mode & 0o777).toBe(0o600);
  await until(() => loginDirs(r), (names) => names.length === 0);
});

it('still fails with identity_unavailable when the persisted home has no e-mail either', async () => {
  const r = make();
  const attempt = await r.service.startLogin(r.owner);
  decide(r, attempt, { outcome: 'approve-stale-read' });
  expect((await settle(r, attempt.id)).status).toBe('failed');
  expect(r.db.prepare('SELECT failure_code FROM multiuser_agent_login_attempts WHERE id = ?').get(attempt.id))
    .toEqual({ failure_code: 'identity_unavailable' });
  expect(r.service.summary(r.owner).account).toBeNull();
  expect(fs.existsSync(r.home)).toBe(false);
  await until(() => loginDirs(r), (names) => names.length === 0);
});
