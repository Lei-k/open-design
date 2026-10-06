import { spawn } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupIsolatedDataRoot, loadIsolatedServerModule, multiUserOptions, provisionAccounts, startMultiUserDaemon, type Principal, type StartedMultiUserDaemon } from './multiuser-harness.js';

let daemon: StartedMultiUserDaemon;
let alice: Principal;
let bob: Principal;
let admin: Principal;
let root: string;
let aFile: string;
let bFile: string;
beforeAll(async () => {
  ({ dataRoot: root } = await loadIsolatedServerModule());
  daemon = await startMultiUserDaemon(multiUserOptions({ testMockAgentScript: path.resolve('../..', 'mocks/run-isolation-agent.ts') }));
  const accounts = await provisionAccounts(daemon, ['cli-alice', 'cli-bob']);
  admin = accounts.admin;
  [alice, bob] = accounts.users as [Principal, Principal];
  aFile = path.join(root, 'cli-a-session');
  bFile = path.join(root, 'cli-b-session');
}, 120_000);
afterAll(async () => { await daemon?.close(); cleanupIsolatedDataRoot(); });

function cli(args: string[], input = ''): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    delete env.OD_DAEMON_URL;
    const child = spawn(process.execPath, [path.resolve('../..', 'node_modules/tsx/dist/cli.mjs'), path.resolve('src/cli.ts'), ...args], {
      env, stdio: ['pipe', 'pipe', 'pipe'], timeout: 15_000,
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
function success(result: { code: number | null; stdout: string; stderr: string }) {
  expect(result.code, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

describe('same Studio APIs through remote od sessions', () => {
  it('logs A/B in using stdin and displays only public metadata', async () => {
    for (const [user, file] of [[alice, aFile], [bob, bFile]] as const) {
      const result = await cli(['session', 'login', '--daemon-url', daemon.baseUrl, '--username', user.username,
        '--password-file', '-', '--session-file', file, '--json'], user.password + '\n');
      expect(success(result)).toMatchObject({ account: { id: user.id, username: user.username }, origin: daemon.baseUrl });
      expect(statSync(file).mode & 0o777).toBe(0o600);
      const token = JSON.parse(readFileSync(file, 'utf8')).cookie;
      expect(result.stdout + result.stderr).not.toContain(token);
      expect(result.stdout + result.stderr).not.toContain(user.password);
      expect(success(await cli(['session', 'me', '--session-file', file, '--json'])).account.id).toBe(user.id);
    }
  });

  it('creates projects, manages standard conversations and tabs, and hides A from B', async () => {
    const made = success(await cli(['project', 'create', '--name', 'CLI Studio', '--session-file', aFile, '--json']));
    const pid = made.project.id;
    const cid = made.conversationId;
    expect(success(await cli(['project', 'active', pid, '--active-file', 'owned.html', '--session-file', aFile, '--json'])))
      .toMatchObject({ active: true, projectId: pid, fileName: 'owned.html' });
    expect(success(await cli(['project', 'active', '--session-file', bFile, '--json']))).toEqual({ active: false });
    expect((await cli(['project', 'active', pid, '--session-file', bFile, '--json'])).code).not.toBe(0);
    expect(success(await cli(['project', 'active', '--clear', '--session-file', aFile, '--json']))).toEqual({ active: false });
    const listed = success(await cli(['project', 'list', '--session-file', bFile, '--json']));
    expect(listed.projects).not.toContainEqual(expect.objectContaining({ id: pid }));
    expect((await cli(['project', 'info', pid, '--session-file', bFile, '--json'])).code).not.toBe(0);
    const changed = success(await cli(['conversation', 'update', cid, '--project', pid, '--title', 'Design revision',
      '--mode', 'plan', '--session-file', aFile, '--json']));
    expect(changed.conversation).toMatchObject({ title: 'Design revision', sessionMode: 'plan' });
    expect(success(await cli(['project', 'tabs', pid, '--tabs-json', '["index.html"]', '--active-file', 'index.html',
      '--session-file', aFile, '--json']))).toMatchObject({ tabs: ['index.html'], active: 'index.html' });
    const fork = success(await cli(['conversation', 'new', pid, '--session-file', aFile, '--json']));
    expect(success(await cli(['conversation', 'delete', fork.conversation.id, '--project', pid, '--session-file', aFile, '--json']))).toEqual({ ok: true });
  }, 40_000);

  it('uses prompt-file stdin and emits resumable run ND-JSON through the same contract', async () => {
    const made = success(await cli(['project', 'create', '--name', 'CLI run', '--session-file', aFile, '--json']));
    const started = success(await cli(['run', 'start', '--project', made.project.id, '--conversation', made.conversationId,
      '--agent', 'test-mock', '--execution-source', 'company_pool', '--prompt-file', '-', '--session-file', aFile, '--json'], 'Owned CLI prompt'));
    const watched = await cli(['run', 'watch', started.runId, '--session-file', aFile, '--json']);
    expect(watched.code, watched.stderr).toBe(0);
    const events = watched.stdout.trim().split('\n').map((line) => JSON.parse(line));
    expect(events.at(-1)).toMatchObject({ event: 'end', data: { status: 'succeeded' } });
    expect(events[0].id).toBe('1');
    const replay = await cli(['run', 'watch', started.runId, '--last-event-id', '1', '--session-file', aFile, '--json']);
    expect(replay.stdout).not.toContain('"id":"1"');
    expect(replay.code, replay.stderr).toBe(0);
    const completed = await cli(['run', 'watch', started.runId, '--last-event-id', events.at(-1).id, '--session-file', aFile, '--json']);
    expect(completed.code, completed.stderr).toBe(0);
    expect(completed.stdout).toBe('');
    const messages = success(await cli(['conversation', 'messages', made.conversationId, '--project', made.project.id, '--session-file', aFile, '--json']));
    expect(messages.messages[0]).toMatchObject({ role: 'user', content: 'Owned CLI prompt' });
    expect((await cli(['run', 'watch', started.runId, '--session-file', bFile, '--json'])).code).not.toBe(0);
  }, 40_000);

  it('rejects origin mismatch and local lifecycle commands before any side effects', async () => {
    const mismatch = await cli(['project', 'list', '--daemon-url', 'https://other.test.invalid', '--session-file', aFile, '--json']);
    expect(mismatch.code).toBe(2);
    expect(mismatch.stderr).toContain('CLI_SESSION_INVALID');
    const lifecycle = await cli(['daemon', 'stop', '--session-file', aFile, '--json']);
    expect(lifecycle.code).toBe(2);
    expect(lifecycle.stderr).toContain('CLI_SESSION_CAPABILITY_PENDING');
    expect((await daemon.request({ path: '/api/health' })).status).toBe(200);
  });

  it('honors server revocation and logs B out without printing or retaining credentials', async () => {
    const revoked = await daemon.request({ method: 'POST', path: `/api/auth/users/${alice.id}/sessions/revoke`, cookie: admin.cookie, body: {} });
    expect(revoked.status).toBe(200);
    expect((await cli(['project', 'list', '--session-file', aFile, '--json'])).code).not.toBe(0);
    expect(success(await cli(['session', 'logout', '--session-file', bFile, '--json']))).toEqual({ ok: true, sessionRemoved: true });
    expect(() => statSync(bFile)).toThrow();
    expect((await cli(['session', 'me', '--session-file', bFile, '--json'])).code).not.toBe(0);
  });
});
