import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseStudioRuntimeCapabilities, type AuthAccount, type AuthSessionResponse, type StudioPilotState, type CompanyOpenAIConfigResponse,
  type StudioProviderKeyResponse, type StudioProviderKeySummary, type StudioProviderKeysResponse, type StudioComposioConfigResponse } from '@open-design/contracts';

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

async function secretInput(file: string, label = 'Password'): Promise<string> {
  let raw: string;
  if (file === '-') {
    if (process.stdin.isTTY) throw new Error(`Pipe ${label.toLowerCase()} on stdin; interactive input must not echo`);
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > 4096) throw new Error(`${label} input is too large`);
      chunks.push(buffer);
    }
    raw = Buffer.concat(chunks).toString('utf8');
  } else {
    const fd = openSync(path.resolve(file), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 4096 || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
        throw new Error(`${label} file must be private and owned by this user`);
      }
      raw = readFileSync(fd, 'utf8');
    } finally { closeSync(fd); }
  }
  const password = raw.replace(/\r?\n$/, '');
  if (!password || password.length > (label === 'Password' ? 1024 : 4096)) throw new Error(`Invalid ${label.toLowerCase()} input`);
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
    const password = await secretInput(flags['--password-file']);
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
    const body = await response.json() as AuthSessionResponse;
    const studio = body.studio === undefined ? undefined : parseStudioRuntimeCapabilities(body.studio);
    if ((body.studio !== undefined || body.studioRevision !== undefined) && (!studio || !Number.isSafeInteger(body.studioRevision) || body.studioRevision < 0)) throw new Error('Invalid capability response');
    process.stdout.write(`${JSON.stringify({ account: publicAccount(body), origin: credential.origin, studio, studioRevision: body.studioRevision })}\n`);
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

/** Explicit optimistic write; never silently read/retry a conflicting mutation. */
export async function runStudioPilotCli(args: string[], sessionFile: string | null): Promise<void> {
  if (args[0] === 'pool') return runCompanyOpenAICli(args.slice(1), sessionFile);
  if (args[0] === 'connectors') return runCompanyComposioCli(args.slice(1), sessionFile);
  if (args.includes('--help')) {
    process.stdout.write('Usage: od admin pool openai get|set --help\n       od admin connectors composio get|set|clear --help\n       od admin studio-pilot get <account-id> --session-file <path> [--json]\n       od admin studio-pilot set <account-id> --enabled true|false --revision <integer> --session-file <path> [--json]\n');
    return;
  }
  const [domain, command, accountId, ...rest] = args;
  if (domain !== 'studio-pilot' || !['get', 'set'].includes(command ?? '') || !accountId || !/^[A-Za-z0-9_-]+$/.test(accountId) || !sessionFile) {
    throw new Error('Invalid pilot command; use admin --help');
  }
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i]!;
    if (key === '--json') continue;
    if (command !== 'set' || !['--enabled', '--revision'].includes(key) || flags[key] !== undefined || rest[i + 1] === undefined) throw new Error('Invalid pilot options');
    flags[key] = rest[++i]!;
  }
  let body: StudioPilotState | undefined;
  if (command === 'set') {
    if (!['true', 'false'].includes(flags['--enabled'] ?? '') || !/^(0|[1-9][0-9]*)$/.test(flags['--revision'] ?? '') || !Number.isSafeInteger(Number(flags['--revision']))) throw new Error('Invalid pilot state');
    body = { studioPilot: flags['--enabled'] === 'true', revision: Number(flags['--revision']) };
  }
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('TLS verification must not be disabled');
  const credential = readCliSession(sessionFile);
  const response = await cliSessionFetch(credential)(`${credential.origin}/api/admin/users/${encodeURIComponent(accountId)}/studio-pilot`, body ? {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  } : undefined);
  if (!response.ok) throw new Error(`Pilot request refused (${response.status})`);
  const result = await response.json() as StudioPilotState;
  if (typeof result.studioPilot !== 'boolean' || !Number.isSafeInteger(result.revision) || result.revision < 0) throw new Error('Invalid pilot response');
  process.stdout.write(`${JSON.stringify({ studioPilot: result.studioPilot, revision: result.revision })}\n`);
}


/** API keys use private files or stdin, never argv or readable responses. */
async function runCompanyOpenAICli(args: string[], sessionFile: string | null): Promise<void> {
  if (args.includes('--help')) {
    process.stdout.write('Usage: od admin pool openai get --session-file <path> [--json]\n       od admin pool openai set --revision <integer> --enabled true|false --model <id> --capacity <0..16> [--api-key-file <path|-> | --revoke-key] --session-file <path> [--json]\n');
    return;
  }
  const [provider, command, ...rest] = args;
  if (provider !== 'openai' || !['get', 'set'].includes(command ?? '') || !sessionFile) throw new Error('Invalid company pool command');
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i]!;
    if (key === '--json') continue;
    if (command !== 'set' || flags[key] !== undefined) throw new Error('Invalid company pool options');
    if (key === '--revoke-key') { flags[key] = 'true'; continue; }
    if (!['--revision', '--enabled', '--model', '--capacity', '--api-key-file'].includes(key)
      || !rest[i + 1] || rest[i + 1]!.startsWith('--')) throw new Error('Invalid company pool options; keys require --api-key-file');
    flags[key] = rest[++i]!;
  }
  let body: Record<string, unknown> | undefined;
  if (command === 'set') {
    if (!/^(0|[1-9][0-9]*)$/.test(flags['--revision'] ?? '') || !Number.isSafeInteger(Number(flags['--revision']))
      || !['true', 'false'].includes(flags['--enabled'] ?? '') || !flags['--model']
      || !/^(0|[1-9]|1[0-6])$/.test(flags['--capacity'] ?? '') || flags['--api-key-file'] && flags['--revoke-key']) throw new Error('Invalid company pool configuration');
    body = { revision: Number(flags['--revision']), enabled: flags['--enabled'] === 'true', model: flags['--model'], capacity: Number(flags['--capacity']),
      ...(flags['--revoke-key'] ? { apiKey: null } : {}),
      ...(flags['--api-key-file'] ? { apiKey: await secretInput(flags['--api-key-file'], 'API key') } : {}) };
  }
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('TLS verification must not be disabled');
  const credential = readCliSession(sessionFile);
  const response = await cliSessionFetch(credential)(`${credential.origin}/api/admin/pool/openai`, body ? {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  } : undefined);
  if (!response.ok) throw new Error(`Company pool request refused (${response.status})`);
  const { provider: result } = await response.json() as CompanyOpenAIConfigResponse;
  if (result?.providerId !== 'openai' || typeof result.enabled !== 'boolean' || typeof result.configured !== 'boolean'
    || typeof result.model !== 'string' || !Number.isSafeInteger(result.capacity) || !Number.isSafeInteger(result.revision)
    || !Number.isSafeInteger(result.credentialRevision)) throw new Error('Invalid company pool response');
  // Project only the public contract even if a server response gains fields.
  process.stdout.write(`${JSON.stringify({ provider: { providerId: 'openai', enabled: result.enabled, configured: result.configured,
    model: result.model, capacity: result.capacity, revision: result.revision, credentialRevision: result.credentialRevision } })}\n`);
}

/**
 * The company Composio key (#62, S58): administrators only, the CLI twin of
 * Settings → Connectors. The key comes from a private file or stdin, never
 * argv, and no output carries it: only configured, the last four characters
 * and the revisions, exactly as the server projects them.
 */
async function runCompanyComposioCli(args: string[], sessionFile: string | null): Promise<void> {
  if (args.includes('--help')) {
    process.stdout.write('Usage: od admin connectors composio get --session-file <path> [--json]\n'
      + '       od admin connectors composio set --revision <integer> --api-key-file <path|-> --session-file <path> [--json]\n'
      + '       od admin connectors composio clear --revision <integer> --session-file <path> [--json]\n'
      + '  Rotating or clearing the key marks every account connection for re-check; accounts reconnect.\n');
    return;
  }
  const [provider, command, ...rest] = args;
  if (provider !== 'composio' || !['get', 'set', 'clear'].includes(command ?? '') || !sessionFile) throw new Error('Invalid connectors key command; use admin connectors composio --help');
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i]!;
    if (key === '--json') continue;
    const allowed = command === 'set' ? ['--revision', '--api-key-file'] : command === 'clear' ? ['--revision'] : [];
    if (!allowed.includes(key) || flags[key] !== undefined || !rest[i + 1] || rest[i + 1]!.startsWith('--')) throw new Error('Invalid connectors key options; keys require --api-key-file');
    flags[key] = rest[++i]!;
  }
  let body: Record<string, unknown> | undefined;
  if (command !== 'get') {
    if (!/^(0|[1-9][0-9]*)$/.test(flags['--revision'] ?? '') || !Number.isSafeInteger(Number(flags['--revision']))
      || command === 'set' && !flags['--api-key-file']) throw new Error('Invalid connectors key update');
    body = { revision: Number(flags['--revision']), apiKey: command === 'clear' ? null : await secretInput(flags['--api-key-file']!, 'API key') };
  }
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('TLS verification must not be disabled');
  const credential = readCliSession(sessionFile);
  const response = await cliSessionFetch(credential)(`${credential.origin}/api/connectors/composio/config`, body ? {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  } : undefined);
  if (!response.ok) throw new Error(`Connectors key request refused (${response.status})`);
  const result = await response.json() as Partial<StudioComposioConfigResponse>;
  if (typeof result.configured !== 'boolean' || typeof result.apiKeyTail !== 'string' || result.apiKeyTail.length > 4
    || !Number.isSafeInteger(result.revision) || !Number.isSafeInteger(result.credentialRevision) || typeof result.canManage !== 'boolean') throw new Error('Invalid connectors key response');
  // Project only the public contract even if a server response gains fields.
  process.stdout.write(`${JSON.stringify({ composio: { configured: result.configured, apiKeyTail: result.apiKeyTail, revision: result.revision,
    credentialRevision: result.credentialRevision, canManage: result.canManage } })}\n`);
}

/**
 * The account's own provider keys (#62/#63: OpenAI for turns and media, Tavily for research), the CLI twin of Settings →
 * Agent accounts. The key comes from a private file or stdin, never argv, and
 * no response carries it: output is the same last-four summary the UI shows.
 */
export async function runAccountCli(args: string[], sessionFile: string | null): Promise<void> {
  if (args.includes('--help') || args.length === 0) {
    process.stdout.write('Usage: od account key get [--provider openai|tavily] --session-file <path> [--json]\n'
      + '       od account key set [--provider openai|tavily] --revision <integer> [--api-key-file <path|->] [--model <id>] --session-file <path> [--json]\n'
      + '       od account key remove [--provider openai|tavily] --revision <integer> --session-file <path> [--json]\n'
      + '  openai runs your own chat turns and media; tavily runs your research searches (no --model).\n');
    return;
  }
  const [domain, command, ...rest] = args;
  if (domain !== 'key' || !['get', 'set', 'remove'].includes(command ?? '') || !sessionFile) throw new Error('Invalid account command; use account --help');
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i]!;
    if (key === '--json') continue;
    const allowed = ['--provider', ...(command === 'set' ? ['--revision', '--api-key-file', '--model'] : command === 'remove' ? ['--revision'] : [])];
    if (!allowed.includes(key) || flags[key] !== undefined || !rest[i + 1] || rest[i + 1]!.startsWith('--')) throw new Error('Invalid account key options; keys require --api-key-file');
    flags[key] = rest[++i]!;
  }
  const provider = flags['--provider'] ?? 'openai';
  if (provider !== 'openai' && provider !== 'tavily' || provider === 'tavily' && flags['--model']) throw new Error('Invalid account key provider; tavily keys have no model');
  let body: Record<string, unknown> | undefined;
  if (command !== 'get') {
    if (!/^(0|[1-9][0-9]*)$/.test(flags['--revision'] ?? '') || !Number.isSafeInteger(Number(flags['--revision']))
      || command === 'set' && !flags['--api-key-file'] && !flags['--model']) throw new Error('Invalid account key update');
    body = { revision: Number(flags['--revision']), ...(command === 'remove' ? { apiKey: null } : {}),
      ...(flags['--model'] ? { model: flags['--model'] } : {}),
      ...(flags['--api-key-file'] ? { apiKey: await secretInput(flags['--api-key-file'], 'API key') } : {}) };
  }
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('TLS verification must not be disabled');
  const credential = readCliSession(sessionFile);
  const base = `${credential.origin}/api/multiuser/settings/provider-keys`;
  const response = await cliSessionFetch(credential)(body ? `${base}/${provider}` : base, body ? {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  } : undefined);
  if (!response.ok) throw new Error(`Account key request refused (${response.status})`);
  const json = await response.json() as Partial<StudioProviderKeyResponse & StudioProviderKeysResponse>;
  const summary = body ? json.key : json.keys?.find((key) => key.provider === provider);
  const valid = (key: StudioProviderKeySummary | undefined): key is StudioProviderKeySummary => !!key && key.provider === provider
    && typeof key.configured === 'boolean' && (key.last4 === null || typeof key.last4 === 'string' && key.last4.length <= 4)
    && typeof key.model === 'string' && Number.isSafeInteger(key.revision) && Number.isSafeInteger(key.credentialRevision);
  if (!valid(summary)) throw new Error('Invalid account key response');
  process.stdout.write(`${JSON.stringify({ key: { provider, configured: summary.configured, last4: summary.last4, model: summary.model,
    revision: summary.revision, credentialRevision: summary.credentialRevision, updatedAt: summary.updatedAt ?? null } })}\n`);
}
