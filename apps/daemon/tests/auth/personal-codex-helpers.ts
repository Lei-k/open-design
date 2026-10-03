// Helpers for the personal Codex subscription tests (#18). Everything drives
// the real daemon over HTTP; the only out-of-band action is writing the mock
// app-server's device-approval control file, which stands for "the user typed
// the code on the official page".
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect } from 'vitest';
import type { Principal, StartedMultiUserDaemon } from './multiuser-harness.js';

export const PERSONAL_CODEX_MOCK = path.resolve('../..', 'mocks/personal-codex-app-server.ts');
export const RUN_MOCK = path.resolve('../..', 'mocks/run-isolation-agent.ts');

export function actorDir(dataRoot: string, accountId: string): string {
  return path.join(dataRoot, 'multiuser-runtime', createHash('sha256').update(accountId).digest('hex'));
}

export function codexHome(dataRoot: string, accountId: string): string {
  return path.join(actorDir(dataRoot, accountId), 'codex-home');
}

export function loginHomes(dataRoot: string, accountId: string): string[] {
  const dir = actorDir(dataRoot, accountId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.startsWith('codex-login-')).map((name) => path.join(dir, name));
}

export async function until<T>(read: () => Promise<T> | T, done: (value: T) => boolean, label = 'condition', timeoutMs = 8_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export async function startLogin(daemon: StartedMultiUserDaemon, user: Principal) {
  const res = await daemon.request({ method: 'POST', path: '/api/agent-accounts/codex/logins', cookie: user.cookie, body: {} });
  expect(res.status, res.text).toBe(202);
  return res.json.attempt as { id: string; status: string; userCode: string; verificationUrl: string; expiresAt: number };
}

export async function readAttempt(daemon: StartedMultiUserDaemon, user: Principal, id: string) {
  return daemon.request({ path: `/api/agent-accounts/codex/logins/${id}`, cookie: user.cookie });
}

/** Simulate the user completing (or refusing) the official device page for this code. */
export async function decide(dataRoot: string, user: Principal, userCode: string, outcome: Record<string, unknown>): Promise<string> {
  const homes = await until(() => loginHomes(dataRoot, user.id), (list) => list.length === 1, 'one login home');
  const dir = path.join(homes[0]!, '.mock-device');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, userCode);
  writeFileSync(file, JSON.stringify(outcome));
  return file;
}

export async function settle(daemon: StartedMultiUserDaemon, user: Principal, id: string) {
  const res = await until(() => readAttempt(daemon, user, id), (r) => r.json?.attempt?.status !== 'pending', 'attempt to settle');
  return res.json.attempt as { id: string; status: string; failureCode: string | null; userCode?: string; verificationUrl?: string };
}

export async function linkCodex(daemon: StartedMultiUserDaemon, dataRoot: string, user: Principal, email: string, planType = 'plus') {
  const attempt = await startLogin(daemon, user);
  await decide(dataRoot, user, attempt.userCode, { outcome: 'approve', email, planType });
  const settled = await settle(daemon, user, attempt.id);
  expect(settled.status).toBe('connected');
  return { attempt, account: await summary(daemon, user).then((s) => s.codex.account) };
}

export async function summary(daemon: StartedMultiUserDaemon, user: Principal) {
  const res = await daemon.request({ path: '/api/agent-accounts', cookie: user.cookie });
  expect(res.status, res.text).toBe(200);
  return res.json;
}

export function setTurnMode(dataRoot: string, user: Principal, control: Record<string, unknown>): void {
  writeFileSync(path.join(codexHome(dataRoot, user.id), 'mock-control.json'), JSON.stringify(control));
}

export function mode(file: string): number {
  return statSync(file).mode & 0o777;
}

/** Every regular file under `root`, read as bytes (for secret scans). */
export function readTree(root: string): Array<{ file: string; bytes: Buffer }> {
  const out: Array<{ file: string; bytes: Buffer }> = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      const info = statSync(full, { throwIfNoEntry: false });
      if (!info) continue;
      if (info.isDirectory()) walk(full);
      else if (info.isFile()) out.push({ file: full, bytes: readFileSync(full) });
    }
  };
  walk(root);
  return out;
}

/** Paths under `root` whose mode is not 0700 (directories) / 0600 (files). */
export function looseModes(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if ((statSync(dir).mode & 0o777) !== 0o700) out.push(dir);
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      const info = statSync(full);
      if (info.isDirectory()) walk(full);
      else if ((info.mode & 0o777) !== 0o600) out.push(full);
    }
  };
  walk(root);
  return out;
}
