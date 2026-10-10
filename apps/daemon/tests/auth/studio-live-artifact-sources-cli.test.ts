// S62 (#63/#68): the session CLI creates and refreshes connector/MCP Live
// Artifact sources through the same endpoints as the Web editor. Fixture
// providers only (programmatic injection); no real MCP server or Composio.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { cleanupIsolatedDataRoot, loadIsolatedServerModule, multiUserOptions, provisionAccounts, startMultiUserDaemon, MU_TEST_ORIGIN, type Principal, type StartedMultiUserDaemon } from './multiuser-harness.js';
import { MCP_HEADER_SENTINEL, encodedForms, startMcpFixture, type McpFixture } from './studio-mcp-fixture.js';

let daemon: StartedMultiUserDaemon; let fixture: McpFixture; let root: string; let alice: Principal; let bob: Principal;
beforeAll(async () => {
  ({ dataRoot: root } = await loadIsolatedServerModule()); fixture = await startMcpFixture();
  daemon = await startMultiUserDaemon(multiUserOptions({ testMcpOutbound: { resolve: fixture.resolve, allowAddress: fixture.allowAddress, timeoutMs: 10_000 } }));
  [alice, bob] = (await provisionAccounts(daemon, ['s62-cli-alice', 's62-cli-bob'])).users as [Principal, Principal];
}, 120_000);
afterAll(async () => { await daemon?.close(); await fixture?.close(); cleanupIsolatedDataRoot(); });

function cli(args: string[], input = ''): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env }; delete env.NODE_OPTIONS; delete env.OD_DAEMON_URL;
    const child = spawn(process.execPath, [path.resolve('../..', 'node_modules/tsx/dist/cli.mjs'), path.resolve('src/cli.ts'), ...args], { env, stdio: ['pipe', 'pipe', 'pipe'], timeout: 20_000 });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject); child.once('close', (code) => resolve({ code, stdout, stderr })); child.stdin.end(input);
  });
}
const success = (result: { code: number | null; stdout: string; stderr: string }) => { expect(result.code, result.stderr).toBe(0); return JSON.parse(result.stdout); };

it('S62 od live-artifact create --source-mcp … and refresh --json read the caller\'s own server', async () => {
  const session = path.join(root, 's62-cli-session'); const bobSession = path.join(root, 's62-cli-bob-session');
  success(await cli(['session', 'login', '--daemon-url', daemon.baseUrl, '--username', alice.username, '--password-file', '-', '--session-file', session, '--json'], alice.password));
  success(await cli(['session', 'login', '--daemon-url', daemon.baseUrl, '--username', bob.username, '--password-file', '-', '--session-file', bobSession, '--json'], bob.password));
  expect((await daemon.request({ method: 'POST', path: '/api/multiuser/mcp/servers', cookie: alice.cookie, headers: { origin: MU_TEST_ORIGIN },
    body: { id: 'mine', url: fixture.url('/runtime'), headers: { 'X-Api-Key': MCP_HEADER_SENTINEL } } })).status).toBe(201);
  Object.assign(fixture.state, { tools: [{ name: 'lookup', annotations: { readOnlyHint: true }, inputSchema: { type: 'object' } }],
    callJson: { structuredContent: { total: 12 } }, echoSecrets: true });
  const projectId = success(await cli(['project', 'create', '--name', 'S62 CLI', '--session-file', session, '--json'])).project.id;
  const body = { input: { title: 'CLI pipeline', preview: { type: 'html', entry: 'index.html' }, document: { format: 'html_template_v1', templatePath: 'template.html',
    generatedPreviewPath: 'index.html', dataPath: 'data.json', dataJson: { total: 0 },
    sourceJson: { type: 'local_file', input: { path: 'x.json' }, refreshPermission: 'manual_refresh_granted_for_read_only', outputMapping: { dataPaths: [{ from: 'structuredContent.total', to: 'total' }] } } } },
  templateHtml: '<h1>{{data.total}}</h1>' };
  const args = path.join(root, 's62-args.json'); writeFileSync(args, '{"q":"pipeline"}');
  const unconfirmed = await cli(['live-artifact', 'create', projectId, '--prompt-file', '-', '--source-mcp', 'mine:lookup', '--session-file', session, '--json'], JSON.stringify(body));
  expect(unconfirmed.code).toBe(2); expect(unconfirmed.stderr).toContain('--confirm-read-only');
  const artifact = success(await cli(['live-artifact', 'create', projectId, '--prompt-file', '-', '--source-mcp', 'mine:lookup', '--confirm-read-only',
    '--source-input-file', args, '--session-file', session, '--json'], JSON.stringify(body))).artifact;
  expect(artifact.document.sourceJson).toMatchObject({ type: 'mcp_tool', mcp: { serverId: 'mine', toolName: 'lookup', readOnlyConfirmed: true }, input: { q: 'pipeline' } });
  const refreshed = success(await cli(['live-artifact', 'refresh', projectId, artifact.id, '--session-file', session, '--json']));
  expect(refreshed.artifact.document.dataJson).toEqual({ total: 12 });
  expect(refreshed.artifact.studioProvenance.toolSource).toMatchObject({ kind: 'mcp', id: 'mine', tool: 'lookup', actorAccountId: alice.id });
  const history = success(await cli(['live-artifact', 'history', projectId, artifact.id, '--session-file', session, '--json'])).refreshes;
  expect(history.at(-1).studioSource).toEqual({ kind: 'mcp', id: 'mine', tool: 'lookup' });
  for (const form of encodedForms(MCP_HEADER_SENTINEL)) expect(JSON.stringify(refreshed) + JSON.stringify(history)).not.toContain(form);
  // Another account (no project access) gets the same not-found refusal, as JSON on stderr.
  const foreign = await cli(['live-artifact', 'refresh', projectId, artifact.id, '--session-file', bobSession, '--json']);
  expect(foreign.code).not.toBe(0); expect(foreign.stderr).toContain('NOT_FOUND');
}, 90_000);
