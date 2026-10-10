// S58 (#62): `od admin connectors composio …` (company key from stdin/file,
// never argv, never echoed) and `od connectors …` over a pinned session.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { cleanupIsolatedDataRoot, loadIsolatedServerModule, multiUserOptions, provisionAccounts, startMultiUserDaemon,
  type Principal, type StartedMultiUserDaemon } from './multiuser-harness.js';

const KEY = 'ak_cli_company_composio_key_9876';
const links: Array<{ userId: string; callbackUrl: string; id: string }> = [];
const composio: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {};
  const json = (value: unknown) => Response.json(value);
  if (url.pathname === '/api/v3/auth_configs') return json({ items: [{ id: 'ac_cli', toolkit: { slug: url.searchParams.get('toolkit_slug') }, status: 'ENABLED' }] });
  if (url.pathname === '/api/v3.1/connected_accounts/link') {
    const id = `ca_cli_${links.length + 1}`;
    links.push({ userId: String(body.user_id), callbackUrl: String(body.callback_url), id });
    return json({ id, redirect_url: 'https://backend.composio.dev/oauth/start/opaque' });
  }
  const account = links.find((link) => url.pathname === `/api/v3/connected_accounts/${link.id}`);
  if (account) return init?.method === 'DELETE' ? json({}) : json({ id: account.id, user_id: account.userId, auth_config: { id: 'ac_cli' },
    toolkit: { slug: 'github' }, status: 'ACTIVE', email: 'cli@apps.example' });
  return new Response('{}', { status: 404 });
};

let daemon: StartedMultiUserDaemon;
let admin: Principal;
let alice: Principal;
let bob: Principal;
let root: string;

function cli(args: string[], input = ''): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    delete env.OD_DAEMON_URL;
    const child = spawn(process.execPath, [path.resolve('../..', 'node_modules/tsx/dist/cli.mjs'), path.resolve('src/cli.ts'), ...args], {
      env, stdio: ['pipe', 'pipe', 'pipe'], timeout: 20_000,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}
const success = (result: { code: number | null; stdout: string; stderr: string }) => {
  expect(result.code, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
};
async function session(user: Principal, name: string) {
  const file = path.join(root, `${name}-session`);
  success(await cli(['session', 'login', '--daemon-url', daemon.baseUrl, '--username', user.username, '--password-file', '-', '--session-file', file, '--json'], user.password));
  return file;
}

beforeAll(async () => {
  ({ dataRoot: root } = await loadIsolatedServerModule());
  daemon = await startMultiUserDaemon(multiUserOptions({ testComposioFetch: composio }));
  const accounts = await provisionAccounts(daemon, ['cli-conn-alice', 'cli-conn-bob']);
  admin = accounts.admin;
  [alice, bob] = accounts.users as [Principal, Principal];
}, 120_000);
afterAll(async () => { await daemon?.close(); cleanupIsolatedDataRoot(); });

it('administers the company key from stdin or a private file and never prints it', async () => {
  const adminFile = await session(admin, 'cli-conn-admin');
  const aliceFile = await session(alice, 'cli-conn-alice');
  expect(success(await cli(['admin', 'connectors', 'composio', 'get', '--session-file', adminFile, '--json'])))
    .toEqual({ composio: { configured: false, apiKeyTail: '', revision: 0, credentialRevision: 0, canManage: true } });
  // argv keys are refused before anything is sent.
  const argv = await cli(['admin', 'connectors', 'composio', 'set', '--revision', '0', '--api-key', KEY, '--session-file', adminFile, '--json']);
  expect(argv.code).not.toBe(0);
  expect(argv.stdout + argv.stderr).not.toContain(KEY);
  const set = await cli(['admin', 'connectors', 'composio', 'set', '--revision', '0', '--api-key-file', '-', '--session-file', adminFile, '--json'], `${KEY}\n`);
  expect(success(set)).toEqual({ composio: { configured: true, apiKeyTail: '9876', revision: 1, credentialRevision: 1, canManage: true } });
  expect(set.stdout + set.stderr).not.toContain(KEY);
  // Invalid or oversized key material is refused without being echoed by the CLI or the server.
  for (const input of [`${KEY} embedded-space\n`, `${KEY}${'x'.repeat(5000)}\n`]) {
    const refused = await cli(['admin', 'connectors', 'composio', 'set', '--revision', '1', '--api-key-file', '-', '--session-file', adminFile, '--json'], input);
    expect(refused.code).not.toBe(0);
    expect(refused.stdout + refused.stderr).not.toContain(KEY.slice(0, 10));
  }
  // A member can neither set nor clear it, and reads no tail.
  const member = await cli(['admin', 'connectors', 'composio', 'clear', '--revision', '1', '--session-file', aliceFile, '--json']);
  expect(member.code).not.toBe(0);
  expect(success(await cli(['admin', 'connectors', 'composio', 'get', '--session-file', aliceFile, '--json'])).composio)
    .toMatchObject({ configured: true, apiKeyTail: '', canManage: false });
  // A private key file works as well (rotation to the same value is unchanged).
  const keyFile = path.join(root, 'composio-key');
  writeFileSync(keyFile, KEY, { mode: 0o600 });
  expect(success(await cli(['admin', 'connectors', 'composio', 'set', '--revision', '1', '--api-key-file', keyFile, '--session-file', adminFile, '--json'])).composio)
    .toMatchObject({ configured: true, revision: 2, credentialRevision: 1 });
}, 120_000);

it('connects, lists and disconnects the signed-in account\'s own app as JSON', async () => {
  const aliceFile = await session(alice, 'cli-conn-alice-2');
  const bobFile = await session(bob, 'cli-conn-bob');
  const listed = success(await cli(['connectors', 'list', '--session-file', aliceFile, '--json']));
  expect(listed.connectors.find((item: { id: string }) => item.id === 'github')).toMatchObject({ status: 'available', configured: true });
  const started = success(await cli(['connectors', 'connect', 'github', '--session-file', aliceFile, '--json']));
  expect(started.auth).toMatchObject({ kind: 'redirect_required', redirectUrl: 'https://backend.composio.dev/oauth/start/opaque' });
  expect(JSON.stringify(started)).not.toMatch(/ca_cli|od-acct-/);
  const link = links.at(-1)!;
  const callback = new URL(link.callbackUrl);
  expect((await daemon.request({ path: `${callback.pathname}${callback.search}&status=success` })).status).toBe(200);
  expect(success(await cli(['connectors', 'status', '--session-file', aliceFile, '--json'])).statuses.github)
    .toEqual({ status: 'connected', accountLabel: 'cli@apps.example' });
  expect(success(await cli(['connectors', 'show', 'github', '--session-file', bobFile, '--json'])).connector).toMatchObject({ status: 'available' });
  expect((await cli(['connectors', 'list', '--session-file', bobFile, '--json'])).stdout).not.toContain('cli@apps.example');
  const bobDisconnect = await cli(['connectors', 'disconnect', 'github', '--session-file', bobFile, '--json']);
  expect(bobDisconnect.code).toBe(1);
  expect(JSON.parse(bobDisconnect.stderr.trim().split('\n').at(-1)!)).toEqual({ ok: false, error: { code: 'NOT_FOUND', status: 404 } });
  expect(success(await cli(['connectors', 'disconnect', 'github', '--session-file', aliceFile, '--json'])).connector).toMatchObject({ id: 'github', status: 'available' });
  expect(success(await cli(['connectors', 'cancel', 'github', '--session-file', aliceFile, '--json'])).connector.status).toBe('available');
  expect((await cli(['connectors', 'connect', '../x', '--session-file', aliceFile, '--json'])).code).toBe(2);
}, 120_000);
