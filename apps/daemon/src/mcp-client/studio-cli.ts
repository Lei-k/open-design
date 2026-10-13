import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type {
  StudioMcpOAuthStartResponse, StudioMcpOAuthStatusResponse, StudioMcpServer, StudioMcpServerResponse, StudioMcpServersResponse, StudioMcpTestResponse,
} from '@open-design/contracts';

/**
 * `od mcp servers …` / `od mcp oauth …` — the CLI twin of Settings → MCP
 * servers (#62, S60). It calls the standard `/api/mcp/servers` and
 * `/api/mcp/oauth/*` endpoints (and the multi-user server routes): with
 * `--session-file` the pinned Studio server answers for the signed-in account
 * only. Header values are read only from a private file or stdin — never argv —
 * and output carries the redacted server fields only.
 */
const HELP = `Usage:
  od mcp servers list [--json]
  od mcp servers add <id> --url <url> [--transport http|sse] [--label <text>] [--auth none|oauth] [--disabled] [--headers-file <path|->] [--json]
  od mcp servers update <id> --revision <n> [--url <url>] [--transport http|sse] [--label <text>] [--auth none|oauth]
                         [--enable|--disable] [--headers-file <path|->] [--remove-header <name>]... [--json]
  od mcp servers remove <id> [--json]
  od mcp servers test <id> [--json]
  od mcp servers import --file <path|-> [--json]
  od mcp oauth start|status|refresh|cancel|disconnect <id> [--json]

Common: [--daemon-url <url>] [--session-file <path>]
Header values are a JSON object {"Header-Name": "value"} in a private file (0600, owned by you) or on stdin;
they are never accepted in argv and never printed. On multi-user Web only remote (HTTP/SSE) servers are
allowed: stdio servers and installing into a coding agent are refused. Account MCP servers are not yet
usable in runs.`;

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const VALUE_FLAGS = ['--url', '--transport', '--label', '--auth', '--revision', '--headers-file', '--remove-header', '--file', '--daemon-url', '--command'];
const BOOLEAN_FLAGS = ['--json', '--disabled', '--enable', '--disable'];
const SECRET_ARGV = ['--header', '--headers', '--api-key', '--token', '--env'];

class CliUsage extends Error {}

async function privateInput(file: string, limit: number): Promise<string> {
  if (file === '-') {
    if (process.stdin.isTTY) throw new CliUsage('pipe the JSON on stdin; interactive input must not echo');
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of process.stdin) {
      const buffer = Buffer.from(chunk); bytes += buffer.length;
      if (bytes > limit) throw new CliUsage('input is too large');
      chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  const fd = openSync(path.resolve(file), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
      throw new CliUsage('the file must be private (0600) and owned by this user');
    }
    return readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
}
async function headersInput(file: string): Promise<Record<string, string>> {
  let parsed: unknown;
  try { parsed = JSON.parse(await privateInput(file, 96 * 1024)); } catch (error) { if (error instanceof CliUsage) throw error; throw new CliUsage('headers must be a JSON object'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.values(parsed).some((value) => typeof value !== 'string')) {
    throw new CliUsage('headers must be a JSON object of strings');
  }
  return parsed as Record<string, string>;
}
/** Redacted fields only. A local desktop daemon lists its own config shape; its header values are dropped to names. */
const publicServer = (server: StudioMcpServer) => {
  const headers = Array.isArray(server.headers) ? server.headers.map((header) => ({ name: header.name, configured: header.configured, tail: header.tail }))
    : Object.keys((server.headers ?? {}) as Record<string, string>).map((name) => ({ name, configured: true, tail: '' }));
  return { id: server.id, label: server.label ?? null, transport: server.transport, url: server.url ?? null, enabled: server.enabled,
    authMode: server.authMode ?? null, headers, oauth: server.oauth ?? null, lastTest: server.lastTest ?? null, revision: server.revision ?? null };
};

export async function runStudioMcpCli(args: string[], resolveDaemonUrl: (flags: Record<string, string>) => Promise<string>): Promise<number> {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  const removeHeaders: string[] = [];
  const booleans = new Set<string>();
  try {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (arg === '--help' || arg === '-h') { process.stdout.write(`${HELP}\n`); return 0; }
      const [name, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
      if (SECRET_ARGV.includes(name!)) throw new CliUsage('header values and tokens are never accepted in argv; use --headers-file <path|->');
      if (BOOLEAN_FLAGS.includes(name!)) { booleans.add(name!); continue; }
      if (VALUE_FLAGS.includes(name!)) {
        const value = inline ?? args[++i];
        if (value === undefined) throw new CliUsage(`${name} requires a value`);
        if (name === '--remove-header') removeHeaders.push(value); else flags[name!.slice(2)] = value;
        continue;
      }
      if (arg.startsWith('-')) throw new CliUsage(`unknown option: ${name}`);
      positional.push(arg);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof CliUsage ? error.message : 'invalid arguments'}\n${HELP}\n`);
    return 2;
  }
  const [group, command, id, extra] = positional;
  const commands: Record<string, string[]> = { servers: ['list', 'add', 'update', 'remove', 'test', 'import'], oauth: ['start', 'status', 'refresh', 'cancel', 'disconnect'] };
  const needsId = group === 'oauth' || ['add', 'update', 'remove', 'test'].includes(command ?? '');
  if (!group || !commands[group]?.includes(command ?? '') || extra !== undefined || (needsId ? !id || !ID.test(id) : id !== undefined)) {
    process.stderr.write(`${HELP}\n`);
    return 2;
  }
  const base = (await resolveDaemonUrl(flags)).replace(/\/$/, '');
  const call = async <T>(route: string, init?: { method: string; body?: unknown }): Promise<T> => {
    const response = await fetch(`${base}${route}`, { redirect: 'error', ...(init ? { method: init.method } : {}),
      ...(init?.body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.body) } : {}) });
    if (!response.ok) {
      let error: { code?: string; details?: unknown } = {};
      try { error = ((await response.json()) as { error?: typeof error }).error ?? {}; } catch { /* generic code */ }
      const details = error.details && typeof error.details === 'object' ? error.details as Record<string, unknown> : null;
      // Only fixed fields: code, status and the typed reason/capability; never a request value.
      process.stderr.write(`${JSON.stringify({ ok: false, error: { code: error.code ?? 'REQUEST_FAILED', status: response.status,
        ...(details && typeof details.reason === 'string' ? { reason: details.reason } : {}),
        ...(details && typeof details.capability === 'string' ? { capability: details.capability } : {}) } })}\n`);
      throw Object.assign(new Error(`mcp request refused (${response.status})`), { reported: true });
    }
    return await response.json() as T;
  };
  const out = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
  try {
    if (group === 'servers' && command === 'list') {
      const listed = await call<StudioMcpServersResponse>('/api/mcp/servers');
      out({ servers: listed.servers.map(publicServer), ...(listed.stdio ? { stdio: listed.stdio } : {}), ...(listed.runs ? { runs: listed.runs } : {}) });
    } else if (group === 'servers' && command === 'add') {
      if (!flags.url && !flags.command) throw new CliUsage('--url is required');
      const body = flags.command !== undefined || flags.transport === 'stdio'
        // Sent as is so the server answers with its typed stdio refusal.
        ? { id, transport: 'stdio', ...(flags.command !== undefined ? { command: flags.command } : {}) }
        : { id, url: flags.url, ...(flags.transport ? { transport: flags.transport } : {}), ...(flags.label ? { label: flags.label } : {}),
          ...(flags.auth ? { authMode: flags.auth } : {}), ...(booleans.has('--disabled') ? { enabled: false } : {}),
          ...(flags['headers-file'] ? { headers: await headersInput(flags['headers-file']) } : {}) };
      out({ server: publicServer((await call<StudioMcpServerResponse>('/api/multiuser/mcp/servers', { method: 'POST', body })).server) });
    } else if (group === 'servers' && command === 'update') {
      if (!/^\d+$/.test(flags.revision ?? '')) throw new CliUsage('--revision <n> is required');
      if (booleans.has('--enable') && booleans.has('--disable')) throw new CliUsage('choose --enable or --disable');
      const headers: Record<string, string | null> = { ...(flags['headers-file'] ? await headersInput(flags['headers-file']) : {}),
        ...Object.fromEntries(removeHeaders.map((name) => [name, null])) };
      const body = { revision: Number(flags.revision), ...(flags.url ? { url: flags.url } : {}), ...(flags.transport ? { transport: flags.transport } : {}),
        ...(flags.label !== undefined ? { label: flags.label } : {}), ...(flags.auth ? { authMode: flags.auth } : {}),
        ...(booleans.has('--enable') ? { enabled: true } : booleans.has('--disable') ? { enabled: false } : {}),
        ...(flags.command !== undefined ? { command: flags.command } : {}), ...(Object.keys(headers).length ? { headers } : {}) };
      out({ server: publicServer((await call<StudioMcpServerResponse>(`/api/multiuser/mcp/servers/${id}`, { method: 'PATCH', body })).server) });
    } else if (group === 'servers' && command === 'remove') {
      await call(`/api/multiuser/mcp/servers/${id}`, { method: 'DELETE' });
      out({ ok: true, id });
    } else if (group === 'servers' && command === 'test') {
      const tested = await call<StudioMcpTestResponse>(`/api/multiuser/mcp/servers/${id}/test`, { method: 'POST', body: {} });
      out({ server: publicServer(tested.server), result: tested.result });
    } else if (group === 'servers' && command === 'import') {
      if (!flags.file) throw new CliUsage('--file <path|-> is required');
      let parsed: unknown;
      try { parsed = JSON.parse(await privateInput(flags.file, 256 * 1024)); } catch (error) { if (error instanceof CliUsage) throw error; throw new CliUsage('import must be JSON'); }
      const body = Array.isArray(parsed) ? { servers: parsed } : parsed;
      const imported = await call<StudioMcpServersResponse & { imported?: string[] }>('/api/mcp/servers', { method: 'PUT', body });
      out({ imported: imported.imported ?? [], servers: imported.servers.map(publicServer) });
    } else if (command === 'status') {
      out({ oauth: await call<StudioMcpOAuthStatusResponse>(`/api/mcp/oauth/status?${new URLSearchParams({ serverId: id! })}`) });
    } else if (command === 'start') {
      const started = await call<StudioMcpOAuthStartResponse>('/api/mcp/oauth/start', { method: 'POST', body: { serverId: id } });
      out({ authorizeUrl: started.authorizeUrl, expiresAt: started.expiresAt });
    } else {
      const route = command === 'disconnect' ? '/api/mcp/oauth/disconnect' : `/api/multiuser/mcp/oauth/${command}`;
      out({ [command!]: await call<unknown>(route, { method: 'POST', body: { serverId: id } }) });
    }
    return 0;
  } catch (error) {
    if ((error as { reported?: boolean }).reported) return 1;
    if (error instanceof CliUsage) { process.stderr.write(`${error.message}\n`); return 2; }
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ELOOP' || code === 'EACCES') { process.stderr.write('cannot read the input file\n'); return 2; }
    throw error;
  }
}
