import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AuthAccount } from '@open-design/contracts';

export interface CliSessionCredential {
  schemaVersion: 1;
  origin: string;
  cookie: string;
  expiresAt: number;
}
const COOKIE = /^__Host-od_session=[A-Za-z0-9_-]{43}$/;

/** No insecure remote origins, userinfo, subpaths, redirects or TLS bypass. */
export function pinCliServerOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Invalid server origin'); }
  const loopback = url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !loopback) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Use an HTTPS server origin; HTTP is allowed only on numeric loopback');
  }
  return url.origin;
}

function sessionPath(file: string): string {
  if (!file || file === '-') throw new Error('An explicit credential file is required');
  const target = path.resolve(file);
  if (realpathSync(path.dirname(target)) !== path.dirname(target)) throw new Error('Credential file parents must not be symlinks');
  return target;
}

/** O_NOFOLLOW + fstat checks the opened inode, not a racy pre-open stat. */
export function readCliSession(file: string, allowExpired = false): CliSessionCredential {
  const fd = openSync(sessionPath(file), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4096 || (stat.mode & 0o077) !== 0
      || (process.getuid && stat.uid !== process.getuid())) throw new Error('Credential file must be private, owned by this user and mode 0600');
    const value: unknown = JSON.parse(readFileSync(fd, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid credential file');
    const c = value as Partial<CliSessionCredential>;
    if (c.schemaVersion !== 1 || typeof c.origin !== 'string' || pinCliServerOrigin(c.origin) !== c.origin
      || typeof c.cookie !== 'string' || !COOKIE.test(c.cookie) || typeof c.expiresAt !== 'number' || !Number.isFinite(c.expiresAt)
      || Object.keys(value).some((key) => !['schemaVersion', 'origin', 'cookie', 'expiresAt'].includes(key))) throw new Error('Invalid credential file');
    if (!allowExpired && c.expiresAt <= Date.now()) throw new Error('Session expired; sign in again using a new session file');
    return c as CliSessionCredential;
  } finally { closeSync(fd); }
}

export function createCliSessionFile(file: string, credential: CliSessionCredential): void {
  const target = sessionPath(file);
  const fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, JSON.stringify(credential), 'utf8'); }
  catch (error) { closeSync(fd); unlinkSync(target); throw error; }
  closeSync(fd);
}

export function extractCliSessionFile(args: readonly string[]): { args: string[]; sessionFile: string | null } {
  const output: string[] = [];
  let file: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--session-file' || arg.startsWith('--session-file=')) {
      const value = arg === '--session-file' ? args[++i] : arg.slice('--session-file='.length);
      if (file || !value || value.startsWith('--')) throw new Error('Provide --session-file once with a credential file path');
      file = value;
    } else output.push(arg);
  }
  return { args: output, sessionFile: file };
}

/** A process-local transport also protects imported command helpers. Requests
 * cannot leak cookies to another host or follow a redirect, including same-host
 * redirects. Client-asserted workspace identities never become remote authority.
 */
export function cliSessionFetch(credential: CliSessionCredential, transport: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== credential.origin || !url.pathname.startsWith('/api/') || url.username || url.password) {
      throw new Error('Session server origin mismatch or non-API destination');
    }
    if (credential.expiresAt <= Date.now()) throw new Error('Session expired');
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    for (const key of [...headers.keys()]) {
      if (key.startsWith('x-od-') || ['authorization', 'proxy-authorization', 'cookie', 'origin', 'sec-fetch-site'].includes(key)) headers.delete(key);
    }
    headers.set('cookie', credential.cookie);
    // Numeric-loopback HTTP is a local test/dev transport, never a remote
    // deployment. Production origins are HTTPS and pinned into Origin too.
    if (credential.origin.startsWith('https:')) headers.set('origin', credential.origin);
    headers.set('cache-control', 'no-store');
    return transport(input, { ...init, headers, redirect: 'error' });
  };
}

function publicAccount(body: unknown): AuthAccount {
  const account = body && typeof body === 'object' && 'account' in body ? body.account : null;
  if (!account || typeof account !== 'object') throw new Error('Invalid account response');
  const value = account as Partial<AuthAccount>;
  if (typeof value.id !== 'string' || typeof value.username !== 'string' || !['user', 'admin'].includes(value.role ?? '')
    || typeof value.active !== 'boolean' || !['set', 'setup_required', 'reset_required'].includes(value.passwordState ?? '')
    || typeof value.createdAt !== 'number' || typeof value.updatedAt !== 'number') throw new Error('Invalid account response');
  return { id: value.id, username: value.username, role: value.role!, active: value.active,
    passwordState: value.passwordState!, createdAt: value.createdAt, updatedAt: value.updatedAt };
}

async function passwordInput(file: string): Promise<string> {
  let raw: string;
  if (file === '-') {
    if (process.stdin.isTTY) throw new Error('Pipe the password on stdin; interactive input must not echo');
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > 4096) throw new Error('Password input is too large');
      chunks.push(buffer);
    }
    raw = Buffer.concat(chunks).toString('utf8');
  } else {
    const fd = openSync(path.resolve(file), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 4096 || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
        throw new Error('Password file must be private and owned by this user');
      }
      raw = readFileSync(fd, 'utf8');
    } finally { closeSync(fd); }
  }
  const password = raw.replace(/\r?\n$/, '');
  if (!password || password.length > 1024) throw new Error('Invalid password input');
  return password;
}

export async function runSessionCli(args: string[], sessionFile: string | null): Promise<void> {
  if (args.includes('--help') || args[0] === 'help' || !args.length) {
    process.stdout.write('Usage:\n  od session login --daemon-url <https-origin> --username <name> --password-file <path|-> --session-file <path> [--json]\n  od session me|logout --session-file <path> [--json]\n  od <command> ... --session-file <path> [--json]\nPasswords and cookies are never accepted in argv. Existing credential files are never overwritten.\n');
    return;
  }
  const command = args[0];
  const flags: Record<string, string> = {};
  for (let i = 1; i < args.length; i++) {
    const key = args[i]!;
    if (key === '--json') continue;
    if (!['--daemon-url', '--username', '--password-file'].includes(key) || flags[key] || !args[i + 1] || args[i + 1]!.startsWith('--')) {
      throw new Error('Invalid session command options; secrets must use --password-file');
    }
    flags[key] = args[++i]!;
  }
  if (!sessionFile) throw new Error('--session-file is required');
  if (command === 'login') {
    if (!flags['--daemon-url'] || !flags['--username'] || !flags['--password-file']) throw new Error('Login requires an explicit origin, username and password file');
    const origin = pinCliServerOrigin(flags['--daemon-url']);
    if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('TLS verification must not be disabled');
    const target = sessionPath(sessionFile);
    try { lstatSync(target); throw new Error('Credential file already exists; choose a new file or log out first'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const password = await passwordInput(flags['--password-file']);
    const response = await fetch(`${origin}/api/auth/login`, { method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json', ...(origin.startsWith('https:') ? { origin } : {}) },
      body: JSON.stringify({ username: flags['--username'], password }) });
    if (!response.ok) throw new Error(`Login refused (${response.status})`);
    const body = await response.json() as { account: AuthAccount; session: { expiresAt: number } };
    const account = publicAccount(body);
    const cookies = response.headers.getSetCookie().filter((cookie) => cookie.startsWith('__Host-od_session='));
    const cookie = cookies.length === 1 ? cookies[0]!.split(';')[0]! : '';
    const attrs = cookies[0] ?? '';
    if (!COOKIE.test(cookie) || !/;\s*Secure(?:;|$)/i.test(attrs) || !/;\s*HttpOnly(?:;|$)/i.test(attrs)
      || !/;\s*Path=\/(?:;|$)/i.test(attrs) || !/;\s*SameSite=Strict(?:;|$)/i.test(attrs) || /;\s*Domain=/i.test(attrs)
      || !Number.isFinite(body.session?.expiresAt) || body.session.expiresAt <= Date.now()) throw new Error('Invalid login response');
    const credential: CliSessionCredential = { schemaVersion: 1, origin, cookie, expiresAt: body.session.expiresAt };
    try { createCliSessionFile(sessionFile, credential); }
    catch (error) {
      await cliSessionFetch(credential)(`${origin}/api/auth/logout`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => {});
      throw error;
    }
    // Only the documented public account fields, never Set-Cookie/session.
    process.stdout.write(`${JSON.stringify({ account, origin })}\n`);
    return;
  }
  if (!['me', 'logout'].includes(command ?? '') || flags['--username'] || flags['--password-file']) throw new Error('Unknown session command');
  const credential = readCliSession(sessionFile, command === 'logout');
  if (flags['--daemon-url'] && pinCliServerOrigin(flags['--daemon-url']) !== credential.origin) throw new Error('Session server origin mismatch');
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('TLS verification must not be disabled');
  if (command === 'me') {
    const response = await cliSessionFetch(credential)(`${credential.origin}/api/auth/me`);
    if (!response.ok) throw new Error(`Session refused (${response.status})`);
    process.stdout.write(`${JSON.stringify({ account: publicAccount(await response.json()), origin: credential.origin })}\n`);
    return;
  }
  // Expired sessions can still be logged out; server revocation is authoritative.
  const response = await cliSessionFetch({ ...credential, expiresAt: Number.MAX_SAFE_INTEGER })(`${credential.origin}/api/auth/logout`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  if (!response.ok) throw new Error(`Logout refused (${response.status}); credential file retained`);
  // Recheck the exact file before deletion, so an overlapping login is not erased.
  if (readCliSession(sessionFile, true).cookie !== credential.cookie) throw new Error('Credential file changed during logout');
  unlinkSync(sessionPath(sessionFile));
  process.stdout.write(`${JSON.stringify({ ok: true, sessionRemoved: true })}\n`);
}
