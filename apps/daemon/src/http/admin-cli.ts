import { cliSessionFetch, readCliSession, refuseAdminCliResponse } from './cli-session.js';

const HELP = `Usage: od admin users list [--q <username>] [--limit <1..100>] [--offset <0..10000>] [--json]
       od admin users create <username> --role user|admin [--json]
       od admin users update <id> --revision <account.updatedAt> [--role user|admin] [--active true|false] [--json]
       od admin users reset <id> --revision <account.updatedAt> [--json]
       od admin users revoke <id> [--json]
       od admin audit [--limit <1..100>] [--before <id>] [--json]
       od admin pool get [--json]
       od admin pool openai get --session-file <path> [--json]
       od admin pool openai set --help
       od admin pool provider <id> --capacity <0..16> [--json]
       od admin pool quota <account-id> --minutes <0..10080> [--json]
       od admin personal get|set [--capacity <0..16>] [--json]
       od admin health [--json]
All commands require --session-file <path>. Setup/reset credentials are returned once.
`;

/** The existing admin metadata endpoints, over the same pinned cookie transport
 * as the Studio Settings controls. Access writes require an explicit revision;
 * conflicts are returned without re-reading or retrying. */
export async function runAdminMetadataCli(args: string[], sessionFile: string | null): Promise<void> {
  if (args.includes('--help')) { process.stdout.write(HELP); return; }
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') continue;
    if (arg.startsWith('--')) {
      if (flags[arg] !== undefined || !args[i + 1] || args[i + 1]!.startsWith('--')) throw new Error('Invalid admin options');
      flags[arg] = args[++i]!;
    } else positional.push(arg);
  }
  const [domain, command, id] = positional;
  let path = ''; let method = 'GET'; let body: object | undefined; let allowed: string[] = []; let expected = 0;
  const integer = (name: string, min: number, max: number) => {
    const value = flags[name];
    if (!value || !/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) throw new Error(`Invalid ${name}`);
    return Number(value);
  };
  const identifier = (value: string | undefined) => { if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid account/provider id'); return encodeURIComponent(value); };
  const query = (names: string[]) => {
    const params = new URLSearchParams();
    for (const name of names) if (flags['--' + name] !== undefined) {
      if (name === 'q') { if (!/^[A-Za-z0-9_.-]{1,32}$/.test(flags['--q']!)) throw new Error('Invalid username search'); params.set(name, flags['--q']!); }
      else params.set(name, String(integer('--' + name, name === 'offset' ? 0 : 1, name === 'limit' ? 100 : name === 'offset' ? 10000 : Number.MAX_SAFE_INTEGER)));
    }
    return params.size ? '?' + params.toString() : '';
  };
  if (domain === 'users') {
    expected = command === 'list' ? 2 : 3;
    if (command === 'list') { allowed = ['--q', '--limit', '--offset']; path = '/api/auth/users' + query(['q', 'limit', 'offset']); }
    else if (command === 'create') {
      if (!id || !/^[A-Za-z0-9_.-]{3,32}$/.test(id) || !['admin', 'user'].includes(flags['--role'] ?? '')) throw new Error('Invalid account');
      allowed = ['--role']; path = '/api/auth/users'; method = 'POST'; body = { username: id, role: flags['--role'] };
    } else if (command === 'update') {
      allowed = ['--role', '--active', '--revision']; path = '/api/auth/users/' + identifier(id); method = 'PATCH';
      const revision = integer('--revision', 0, Number.MAX_SAFE_INTEGER);
      if (!flags['--role'] && !flags['--active'] || flags['--role'] && !['admin', 'user'].includes(flags['--role']) || flags['--active'] && !['true', 'false'].includes(flags['--active'])) throw new Error('Invalid access change');
      body = { revision, ...(flags['--role'] ? { role: flags['--role'] } : {}), ...(flags['--active'] ? { active: flags['--active'] === 'true' } : {}) };
    } else if (command === 'reset' || command === 'revoke') {
      path = '/api/auth/users/' + identifier(id) + (command === 'reset' ? '/password' : '/sessions/revoke'); method = 'POST'; body = {};
      if (command === 'reset') { allowed = ['--revision']; body = { revision: integer('--revision', 0, Number.MAX_SAFE_INTEGER) }; }
    }
  } else if (domain === 'audit') { expected = 1; allowed = ['--limit', '--before']; path = '/api/auth/audit' + query(['limit', 'before']); }
  else if (domain === 'pool') {
    expected = command === 'get' ? 2 : 3;
    if (command === 'get') path = '/api/admin/pool';
    else if (command === 'provider') { allowed = ['--capacity']; path = '/api/admin/pool/providers/' + identifier(id); method = 'PUT'; body = { capacity: integer('--capacity', 0, 16) }; }
    else if (command === 'quota') { allowed = ['--minutes']; path = '/api/admin/pool/users/' + identifier(id) + '/quota'; method = 'PUT'; body = { budgetMinutes: integer('--minutes', 0, 10080) }; }
  } else if (domain === 'personal') {
    expected = 2;
    if (command === 'get') path = '/api/admin/agent-accounts';
    else if (command === 'set') { allowed = ['--capacity']; path = '/api/admin/agent-accounts/personal-capacity'; method = 'PUT'; body = { capacity: integer('--capacity', 0, 16) }; }
  } else if (domain === 'health') { expected = 1; path = '/api/health'; }
  if (!path || positional.length !== expected || Object.keys(flags).some((flag) => !allowed.includes(flag)) || !sessionFile) throw new Error('Invalid admin command; use admin --help');
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('TLS verification must not be disabled');
  const credential = readCliSession(sessionFile);
  const response = await cliSessionFetch(credential)(credential.origin + path, { method, ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  if (!response.ok) await refuseAdminCliResponse(response);
  process.stdout.write(JSON.stringify(await response.json()) + '\n');
}
