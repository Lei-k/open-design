// Issue #18 — local real-provider acceptance for personal Codex subscriptions.
//
// Skipped unless OD_REAL_CODEX_ACCEPTANCE_BIN names a `codex` binary. It drives the
// account service (not the daemon: `startServer` still accepts only the repository
// mock) against the real `codex app-server`, in a throwaway data root:
//
//   cancel a login → device-code login approved by a human → identity read-back →
//   consented minimal verification turn → a turn plus a follow-up on the same native
//   thread → unlink.
//
// The device link and code are written only to OD_REAL_CODEX_ACCEPTANCE_PROMPT_FILE
// (0600) for the account owner to open, and that file is removed when the login
// settles. Nothing is copied from the operator's own CODEX_HOME. Verification and the
// two turns consume a small amount of the linked plan.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import {
  PersonalCodexAccounts, actorRuntimeDir, personalCodexHome, runPersonalCodexTurn,
} from '../../src/services/personal-codex-accounts.js';

const BIN = process.env.OD_REAL_CODEX_ACCEPTANCE_BIN;
const PROMPT_FILE = process.env.OD_REAL_CODEX_ACCEPTANCE_PROMPT_FILE;
/** Optional private file for app-server stderr (the service itself discards it). */
const STDERR_LOG = process.env.OD_REAL_CODEX_ACCEPTANCE_STDERR_LOG;
/**
 * Credentials must stay in each isolated CODEX_HOME. Without this pin the CLI may
 * pick an OS keyring, which is shared by every home of the same OS user.
 */
const COMMAND: [string, ...string[]] = STDERR_LOG
  ? ['/bin/sh', '-c', 'exec "$0" app-server -c cli_auth_credentials_store=\'"file"\' 2>>"$1"', BIN ?? '', STDERR_LOG]
  : [BIN ?? '', 'app-server', '-c', 'cli_auth_credentials_store="file"'];
const LOGIN_WAIT_MS = 15 * 60_000;

const sha = (file: string) => (fs.existsSync(file) ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null);
const modeOf = (file: string) => fs.statSync(file).mode & 0o777;

async function until<T>(read: () => Promise<T> | T, done: (value: T) => boolean, timeoutMs: number): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > end) throw new Error(`timed out: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

describe.skipIf(!BIN)('personal Codex subscription against the real provider', () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'od-real-codex-'));
  const db = new Database(path.join(root, 'app.sqlite'));
  const service = new PersonalCodexAccounts({ db, dataRoot: root, acceptanceAppServerCommand: COMMAND });
  const owner = 'acceptance-owner';
  const operatorAuth = path.join(process.env.CODEX_HOME ?? path.join(homedir(), '.codex'), 'auth.json');
  let accountId = '';

  /** Non-sensitive state for a failed step: statuses, audit actions, file names and modes. */
  function diagnostics(attemptId: string): unknown {
    const files: string[] = [];
    const walk = (dir: string) => {
      if (!fs.existsSync(dir)) return;
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        const info = fs.lstatSync(full);
        files.push(`${(info.mode & 0o777).toString(8)} ${path.relative(root, full)}${info.isDirectory() ? '/' : ''}`);
        if (info.isDirectory() && !info.isSymbolicLink()) walk(full);
      }
    };
    walk(actorRuntimeDir(root, owner));
    return {
      attempt: db.prepare('SELECT status, failure_code FROM multiuser_agent_login_attempts WHERE id = ?').get(attemptId),
      audit: db.prepare('SELECT action, detail FROM multiuser_agent_account_audit ORDER BY id').all(),
      account: service.summary(owner).account,
      files,
    };
  }

  afterAll(async () => {
    if (PROMPT_FILE) fs.rmSync(PROMPT_FILE, { force: true });
    await service.shutdown();
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('cancels a pending device-code login without binding anything', async () => {
    const attempt = await service.startLogin(owner);
    expect(attempt.status).toBe('pending');
    expect(attempt.verificationUrl).toMatch(/^https:\/\//u);
    expect(attempt.userCode).toBeTruthy();
    const canceled = await service.cancelLogin(owner, attempt.id);
    expect(canceled?.status).toBe('canceled');
    expect(canceled?.userCode ?? null).toBeNull();
    expect(service.summary(owner).account).toBeNull();
  }, 60_000);

  it('links through a device-code login the owner approves, into a private isolated home', async () => {
    const attempt = await service.startLogin(owner);
    if (PROMPT_FILE) {
      fs.writeFileSync(PROMPT_FILE, `${attempt.verificationUrl}\n${attempt.userCode}\n`, { mode: 0o600 });
    }
    const settled = await until(() => service.attempt(owner, attempt.id), (value) => value?.status !== 'pending', LOGIN_WAIT_MS);
    if (PROMPT_FILE) fs.rmSync(PROMPT_FILE, { force: true });
    if (settled?.status !== 'connected') console.error('[real-codex] login did not connect', diagnostics(attempt.id));
    expect(settled?.status, JSON.stringify(settled)).toBe('connected');
    expect(settled?.userCode ?? null).toBeNull();

    const account = service.summary(owner).account!;
    accountId = account.id;
    expect(account).toMatchObject({ status: 'connected', verifiedAt: null });
    expect(account.maskedIdentity).toMatch(/^.\*\*\*@/u);
    console.info('[real-codex] linked', { masked: account.maskedIdentity, plan: account.planType });

    const home = personalCodexHome(root, owner);
    expect(modeOf(actorRuntimeDir(root, owner))).toBe(0o700);
    expect(modeOf(home)).toBe(0o700);
    expect(modeOf(path.join(home, 'auth.json'))).toBe(0o600);
    // A fresh device login, not a copy of the operator's own credential.
    expect(sha(path.join(home, 'auth.json'))).not.toBe(sha(operatorAuth));
    expect(fs.readdirSync(actorRuntimeDir(root, owner)).filter((name) => name.startsWith('codex-login-'))).toEqual([]);
  }, LOGIN_WAIT_MS + 60_000);

  it('requires consent, then verifies with one minimal real turn', async () => {
    expect(accountId).not.toBe('');
    await expect(service.verify(owner, accountId, false)).rejects.toMatchObject({ code: 'MULTIUSER_PERSONAL_CONSENT_REQUIRED' });
    const verified = await service.verify(owner, accountId, true);
    expect(verified?.verifiedAt).toEqual(expect.any(Number));
    console.info('[real-codex] verified; rate limits', JSON.stringify(verified?.rateLimits ?? null));
  }, 180_000);

  it('runs a turn and resumes the same native thread for the follow-up', async () => {
    const usable = service.usableAccount(owner)!;
    expect(usable).toMatchObject({ id: accountId });
    const work = path.join(root, 'run-work');
    fs.mkdirSync(path.join(work, 'tmp'), { recursive: true, mode: 0o700 });
    const env = { command: service.appServerCommand()!, codexHome: usable.codexHome, home: work,
      temp: path.join(work, 'tmp'), cwd: work, dataRoot: root, sandboxMode: 'read-only' as const };
    const first = await runPersonalCodexTurn({ ...env, prompt: 'Remember the word "teal". Reply with OK only.', resumeThreadId: null }).done;
    expect(first, JSON.stringify(first)).toMatchObject({ ok: true, problem: null });
    expect(first.threadId).toBeTruthy();
    const second = await runPersonalCodexTurn({ ...env, prompt: 'Which word did I ask you to remember? Reply with that word only.',
      resumeThreadId: first.threadId }).done;
    expect(second, JSON.stringify(second)).toMatchObject({ ok: true, problem: null, threadId: first.threadId });
    expect(second.text.toLowerCase()).toContain('teal');
    service.secureHome(owner);
    expect(modeOf(path.join(usable.codexHome, 'auth.json'))).toBe(0o600);
  }, 300_000);

  it('unlinks: local logout, every copy removed, account gone', async () => {
    expect(await service.unlink(owner, accountId)).toBe(true);
    expect(service.summary(owner).account).toBeNull();
    expect(fs.existsSync(personalCodexHome(root, owner))).toBe(false);
    expect(service.usableAccount(owner)).toBeNull();
  }, 60_000);
});
