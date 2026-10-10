import type { ConnectorConnectResponse, ConnectorDetail, ConnectorDetailResponse, ConnectorListResponse, ConnectorStatusResponse } from '@open-design/contracts';

/**
 * `od connectors …` — the CLI twin of Settings → Connectors. It calls the
 * standard `/api/connectors/*` endpoints: the local daemon for desktop use, or,
 * with `--session-file`, the pinned Studio server, where every route answers for
 * the signed-in account only (#62, S58). Output is JSON and carries only the
 * public connector fields; no provider ids, entities or keys.
 */
const HELP = `Usage:
  od connectors list [--json] [--daemon-url <url>] [--session-file <path>]
  od connectors status [--json]
  od connectors show <connector-id> [--json]
  od connectors connect <connector-id> [--json]
  od connectors cancel <connector-id> [--json]
  od connectors disconnect <connector-id> [--json]

connect prints the provider authorization URL; open it in a browser to finish.
With --session-file the connections are the signed-in account's own, through
the company Composio key an administrator configured (od admin connectors
composio …). Connected apps are not yet usable in runs on Web accounts.`;

const ID = /^[a-z0-9_]{1,64}$/;

function publicConnector(connector: ConnectorDetail) {
  return { id: connector.id, name: connector.name, category: connector.category, status: connector.status,
    ...(connector.accountLabel ? { accountLabel: connector.accountLabel } : {}),
    ...(connector.lastError ? { lastError: connector.lastError } : {}),
    configured: connector.auth?.configured === true };
}

export async function runConnectorsCli(args: string[], resolveDaemonUrl: (flags: Record<string, string>) => Promise<string>): Promise<number> {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') continue;
    if (arg === '--help' || arg === '-h') { process.stdout.write(`${HELP}\n`); return 0; }
    if (arg === '--daemon-url') {
      if (!args[i + 1]) throw new Error('--daemon-url requires a value');
      flags['daemon-url'] = args[++i]!; continue;
    }
    if (arg.startsWith('--daemon-url=')) { flags['daemon-url'] = arg.slice('--daemon-url='.length); continue; }
    if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
    positional.push(arg);
  }
  const [command, id, extra] = positional;
  const needsId = ['show', 'connect', 'cancel', 'disconnect'].includes(command ?? '');
  if (!command || !['list', 'status', 'show', 'connect', 'cancel', 'disconnect'].includes(command) || extra !== undefined
    || (needsId ? !id || !ID.test(id) : id !== undefined)) {
    process.stderr.write(`${HELP}\n`);
    return 2;
  }
  const base = (await resolveDaemonUrl(flags)).replace(/\/$/, '');
  const call = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetch(`${base}${path}`, { redirect: 'error', ...init,
      ...(init?.method && init.method !== 'GET' ? { headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } } : {}) });
    if (!response.ok) {
      let code = 'REQUEST_FAILED';
      try { code = String(((await response.json()) as { error?: { code?: string } }).error?.code ?? code); } catch { /* keep the generic code */ }
      process.stderr.write(`${JSON.stringify({ ok: false, error: { code, status: response.status } })}\n`);
      throw Object.assign(new Error(`connectors request refused (${response.status})`), { reported: true });
    }
    return await response.json() as T;
  };
  const path = (suffix = '') => `/api/connectors${suffix}`;
  try {
    if (command === 'list') {
      const { connectors } = await call<ConnectorListResponse>(path());
      process.stdout.write(`${JSON.stringify({ connectors: connectors.map(publicConnector) })}\n`);
    } else if (command === 'status') {
      const { statuses } = await call<ConnectorStatusResponse>(path('/status'));
      process.stdout.write(`${JSON.stringify({ statuses: Object.fromEntries(Object.entries(statuses).map(([key, value]) => [key, {
        status: value.status, ...(value.accountLabel ? { accountLabel: value.accountLabel } : {}), ...(value.lastError ? { lastError: value.lastError } : {}) }])) })}\n`);
    } else if (command === 'show') {
      const { connector } = await call<ConnectorDetailResponse>(path(`/${id}`));
      process.stdout.write(`${JSON.stringify({ connector: publicConnector(connector) })}\n`);
    } else if (command === 'connect') {
      const result = await call<ConnectorConnectResponse>(path(`/${id}/connect`), { method: 'POST', body: '{}' });
      process.stdout.write(`${JSON.stringify({ connector: publicConnector(result.connector), ...(result.auth ? { auth: {
        kind: result.auth.kind, ...(result.auth.redirectUrl ? { redirectUrl: result.auth.redirectUrl } : {}),
        ...(result.auth.expiresAt ? { expiresAt: result.auth.expiresAt } : {}) } } : {}) })}\n`);
    } else {
      const result = await call<ConnectorDetailResponse>(command === 'cancel' ? path(`/${id}/authorization/cancel`) : path(`/${id}/connection`),
        command === 'cancel' ? { method: 'POST', body: '{}' } : { method: 'DELETE' });
      process.stdout.write(`${JSON.stringify({ connector: publicConnector(result.connector) })}\n`);
    }
    return 0;
  } catch (error) {
    if ((error as { reported?: boolean }).reported) return 1;
    throw error;
  }
}
