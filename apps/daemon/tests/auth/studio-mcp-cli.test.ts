// S60 (#62): `od mcp servers|oauth …` over a pinned Studio session. Header values
// come only from a private file or stdin, never argv; output is redacted; stdio
// and foreign servers answer the server's typed refusals.
import { spawn } from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { cleanupIsolatedDataRoot, loadIsolatedServerModule, multiUserOptions, provisionAccounts, startMultiUserDaemon,
  type Principal, type StartedMultiUserDaemon } from './multiuser-harness.js';
import { MCP_HEADER_SENTINEL, startMcpFixture, type McpFixture } from './studio-mcp-fixture.js';

let daemon: StartedMultiUserDaemon; let fixture: McpFixture; let root: string;
let alice: Principal; let bob: Principal;

function cli(args: string[], input = ''): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.NODE_OPTIONS; delete env.OD_DAEMON_URL;
    const child = spawn(process.execPath, [path.resolve('../..', 'node_modules/tsx/dist/cli.mjs'), path.resolve('src/cli.ts'), ...args], {
      env, stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000,
    });
    let stdout = ''; let stderr = '';
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
const refusal = (result: { code: number | null; stdout: string; stderr: string }) => {
  expect(result.code, result.stdout).toBe(1);
  return JSON.parse(result.stderr.trim().split('\n').at(-1)!);
};
async function session(user: Principal, name: string) {
  const file = path.join(root, `${name}-session`);
  success(await cli(['session', 'login', '--daemon-url', daemon.baseUrl, '--username', user.username, '--password-file', '-', '--session-file', file, '--json'], user.password));
  return file;
}

beforeAll(async () => {
  ({ dataRoot: root } = await loadIsolatedServerModule());
  fixture = await startMcpFixture();
  daemon = await startMultiUserDaemon(multiUserOptions({ testMcpOutbound: { resolve: fixture.resolve, allowAddress: fixture.allowAddress, timeoutMs: 1_500 } }));
  const accounts = await provisionAccounts(daemon, ['cli-mcp-alice', 'cli-mcp-bob']);
  [alice, bob] = accounts.users as [Principal, Principal];
}, 120_000);
afterAll(async () => { await daemon?.close(); await fixture?.close(); cleanupIsolatedDataRoot(); });

it('manages the account\'s own remote servers with secrets from a private file or stdin, never argv, never printed', async () => {
  const aliceFile = await session(alice, 'cli-mcp-alice');
  const bobFile = await session(bob, 'cli-mcp-bob');
  const argv = await cli(['mcp', 'servers', 'add', 'fx', '--url', fixture.url(), '--header', `X-Api-Key=${MCP_HEADER_SENTINEL}`, '--session-file', aliceFile, '--json']);
  expect(argv.code).toBe(2);
  expect(argv.stdout + argv.stderr).not.toContain(MCP_HEADER_SENTINEL);
  const shared = path.join(root, 'headers-shared.json');
  writeFileSync(shared, JSON.stringify({ 'X-Api-Key': MCP_HEADER_SENTINEL })); chmodSync(shared, 0o644);
  const loose = await cli(['mcp', 'servers', 'add', 'fx', '--url', fixture.url(), '--headers-file', shared, '--session-file', aliceFile, '--json']);
  expect(loose.code).toBe(2);
  expect(loose.stdout + loose.stderr).not.toContain(MCP_HEADER_SENTINEL);
  const added = success(await cli(['mcp', 'servers', 'add', 'fx', '--url', fixture.url(), '--label', 'Fixture', '--headers-file', '-', '--session-file', aliceFile, '--json'],
    JSON.stringify({ 'X-Api-Key': MCP_HEADER_SENTINEL })));
  expect(added.server).toMatchObject({ id: 'fx', transport: 'http', label: 'Fixture', headers: [{ name: 'X-Api-Key', configured: true, tail: MCP_HEADER_SENTINEL.slice(-4) }] });
  const listed = await cli(['mcp', 'servers', 'list', '--session-file', aliceFile, '--json']);
  expect(success(listed).servers.map((server: { id: string }) => server.id)).toEqual(['fx']);
  expect(success(listed).stdio.available).toBe(false);
  const tested = await cli(['mcp', 'servers', 'test', 'fx', '--session-file', aliceFile, '--json']);
  expect(success(tested).result).toMatchObject({ ok: true, serverName: 'fixture-mcp' });
  expect(success(await cli(['mcp', 'oauth', 'status', 'fx', '--session-file', aliceFile, '--json'])).oauth).toMatchObject({ connected: false, status: 'not-required' });
  const updated = success(await cli(['mcp', 'servers', 'update', 'fx', '--revision', String(added.server.revision), '--disable', '--session-file', aliceFile, '--json']));
  expect(updated.server.enabled).toBe(false);
  for (const output of [added, listed.stdout, tested.stdout, updated]) expect(JSON.stringify(output)).not.toContain(MCP_HEADER_SENTINEL);
  // stdio is refused by the server with its typed reason, from add and from import.
  expect(refusal(await cli(['mcp', 'servers', 'add', 'local', '--transport', 'stdio', '--command', 'npx', '--session-file', aliceFile, '--json'])).error)
    .toMatchObject({ code: 'MULTIUSER_CAPABILITY_UNAVAILABLE', status: 403, capability: 'mcp-stdio' });
  expect(refusal(await cli(['mcp', 'servers', 'import', '--file', '-', '--session-file', aliceFile, '--json'],
    JSON.stringify({ servers: [{ id: 'local', transport: 'stdio', command: 'npx', env: { TOKEN: MCP_HEADER_SENTINEL } }] }))).error)
    .toMatchObject({ code: 'MULTIUSER_CAPABILITY_UNAVAILABLE', capability: 'mcp-stdio' });
  // Another account cannot address alice's server; the host install stays a local-only command.
  expect(refusal(await cli(['mcp', 'servers', 'remove', 'fx', '--session-file', bobFile, '--json'])).error).toMatchObject({ code: 'NOT_FOUND', status: 404 });
  expect(success(await cli(['mcp', 'servers', 'list', '--session-file', bobFile, '--json'])).servers).toEqual([]);
  const install = await cli(['mcp', 'install', 'codex', '--session-file', aliceFile, '--json']);
  expect(install.code).toBe(2);
  expect(install.stderr).toContain('CLI_SESSION_CAPABILITY_PENDING');
  expect(success(await cli(['mcp', 'servers', 'remove', 'fx', '--session-file', aliceFile, '--json']))).toEqual({ ok: true, id: 'fx' });
});
