// Issue #18, gate 2 (user decision 2026-10-06: per-run bubblewrap sandbox).
// Daemon and personal children share one OS uid, so only the sandbox keeps a
// task in A's run from reading B's CODEX_HOME or the daemon database. The mock's
// `[mock-read=…]` probe stands for such a task shell. Skipped where bwrap cannot
// build the sandbox (e.g. hosts that restrict unprivileged user namespaces).
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { PersonalLoginAttempt } from '@open-design/contracts';
import {
  PersonalCodexAccounts, actorRuntimeDir, personalCodexHome, runPersonalCodexTurn,
} from '../../src/services/personal-codex-accounts.js';
import { personalSandboxArgs, probePersonalSandbox, type PersonalSandbox } from '../../src/services/personal-sandbox.js';
import { PERSONAL_CODEX_MOCK, until } from './personal-codex-helpers.js';

const BWRAP = '/usr/bin/bwrap';
const usable = probePersonalSandbox(BWRAP, tmpdir());
const sandbox: PersonalSandbox = {
  bwrap: BWRAP,
  readOnlyPaths: [path.dirname(path.dirname(fs.realpathSync(process.execPath))), path.dirname(fs.realpathSync(PERSONAL_CODEX_MOCK))],
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

function make(withSandbox: boolean) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'od-personal-sandbox-'));
  const dbFile = path.join(root, 'app.sqlite');
  const db = new Database(dbFile);
  const service = new PersonalCodexAccounts({ db, dataRoot: root, appServerScript: PERSONAL_CODEX_MOCK,
    ...(withSandbox ? { sandbox } : {}) });
  cleanups.push(async () => { await service.shutdown(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, dbFile, db, service };
}

async function link(r: ReturnType<typeof make>, owner: string, email: string): Promise<void> {
  const attempt: PersonalLoginAttempt = await r.service.startLogin(owner);
  expect(attempt.status).toBe('pending');
  const login = fs.readdirSync(actorRuntimeDir(r.root, owner)).find((name) => name.startsWith('codex-login-'))!;
  const device = path.join(actorRuntimeDir(r.root, owner), login, '.mock-device');
  fs.mkdirSync(device, { recursive: true });
  fs.writeFileSync(path.join(device, attempt.userCode!), JSON.stringify({ outcome: 'approve', email }));
  const settled = await until(() => r.service.attempt(owner, attempt.id), (value) => value?.status !== 'pending', 'login');
  expect(settled?.status).toBe('connected');
}

/** One personal turn for `owner` that tries to read each of `paths`. */
async function probeReads(r: ReturnType<typeof make>, owner: string, paths: string[]): Promise<Record<string, string>> {
  const account = r.service.usableAccount(owner)!;
  const work = path.join(actorRuntimeDir(r.root, owner), 'probe-run');
  const project = path.join(r.root, 'projects', owner);
  for (const dir of [work, path.join(work, 'tmp'), project]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const turn = runPersonalCodexTurn({ ...r.service.appServerLaunch()!, codexHome: account.codexHome, home: work,
    temp: path.join(work, 'tmp'), cwd: project, dataRoot: r.root, sandboxMode: 'workspace-write', resumeThreadId: null,
    prompt: paths.map((file) => `[mock-read=${file}]`).join(' ') });
  const result = await turn.done;
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return (JSON.parse(result.text) as { reads: Record<string, string> }).reads;
}

describe.skipIf(!usable)('personal app-server children run in a per-run sandbox', () => {
  it('keeps another user\'s credential and the daemon database out of reach, but not the owner\'s own', async () => {
    const r = make(true);
    await link(r, 'alice', 'alice@example.com');
    await link(r, 'bob', 'bob@example.com');
    const own = path.join(personalCodexHome(r.root, 'alice'), 'auth.json');
    const other = path.join(personalCodexHome(r.root, 'bob'), 'auth.json');
    const reads = await probeReads(r, 'alice', [own, other, r.dbFile, '/etc/shadow']);
    expect(reads[own]).toBe('readable');
    expect(reads[other]).toBe('ENOENT');
    expect(reads[r.dbFile]).toBe('ENOENT');
    expect(reads['/etc/shadow']).toBe('ENOENT');
    // Login, identity read-back and verification ran sandboxed too.
    expect(r.service.summary('bob').account).toMatchObject({ status: 'connected', maskedIdentity: 'b***@example.com' });
    expect((await r.service.verify('alice', r.service.summary('alice').account!.id, true))?.verifiedAt).toEqual(expect.any(Number));
  });

  it('control: without the sandbox the same task can read the other user\'s credential', async () => {
    const r = make(false);
    await link(r, 'alice', 'alice@example.com');
    await link(r, 'bob', 'bob@example.com');
    const other = path.join(personalCodexHome(r.root, 'bob'), 'auth.json');
    expect((await probeReads(r, 'alice', [other]))[other]).toBe('readable');
  });
});

describe('sandbox arguments', () => {
  it('binds only the child\'s own writable paths, parents first, and no data root', () => {
    const args = personalSandboxArgs({ bwrap: BWRAP, readOnlyPaths: ['/opt/codex'] },
      { codexHome: '/data/rt/a/codex-home', home: '/data/rt/a/run', temp: '/data/rt/a/run/tmp', cwd: '/data/projects/p' });
    const binds = args.flatMap((arg, i) => (arg === '--bind' ? [args[i + 1]] : []));
    expect(binds).toEqual(['/data/rt/a/run', '/data/projects/p', '/data/rt/a/run/tmp', '/data/rt/a/codex-home']);
    expect(args).toEqual(expect.arrayContaining(['--unshare-all', '--share-net', '--die-with-parent']));
    expect(args.join(' ')).toContain('--ro-bind /opt/codex /opt/codex');
    expect(args).not.toContain('/data');
    expect(args.slice(-2)).toEqual(['--chdir', '/data/projects/p']);
  });
});
