import { spawn } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupIsolatedDataRoot, loadIsolatedServerModule, multiUserOptions, provisionAccounts, startMultiUserDaemon, type Principal, type StartedMultiUserDaemon } from './multiuser-harness.js';
import { PERSONAL_CODEX_MOCK, linkCodex, setTurnMode } from './personal-codex-helpers.js';

let daemon: StartedMultiUserDaemon;
let alice: Principal;
let bob: Principal;
let admin: Principal;
let root: string;
let aFile: string;
let bFile: string;
beforeAll(async () => {
  ({ dataRoot: root } = await loadIsolatedServerModule());
  daemon = await startMultiUserDaemon(multiUserOptions({ testMockAgentScript: path.resolve('../..', 'mocks/run-isolation-agent.ts'), testPersonalCodexAppServer: PERSONAL_CODEX_MOCK,
    testCompanyOpenAIFetch: async () => new Response('data: ' + JSON.stringify({ type: 'response.output_text.delta', delta: 'CLI company completed.\n' })
      + '\n\ndata: ' + JSON.stringify({ type: 'response.completed', response: { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'CLI company completed.' }] }] } }) + '\n\n',
      { headers: { 'content-type': 'text/event-stream' } }) }));
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

  it('reads and toggles the pilot through the pinned admin session and exposes the effective shell', async () => {
    const file = path.join(root, 'cli-admin-session');
    success(await cli(['session', 'login', '--daemon-url', daemon.baseUrl, '--username', admin.username,
      '--password-file', '-', '--session-file', file, '--json'], admin.password + '\n'));
    const get = ['admin', 'studio-pilot', 'get', alice.id, '--session-file', file, '--json'];
    expect(success(await cli(get))).toEqual({ studioPilot: false, revision: 0 });
    const set = ['admin', 'studio-pilot', 'set', alice.id, '--enabled', 'true', '--revision', '0', '--session-file', file, '--json'];
    expect(success(await cli(set))).toEqual({ studioPilot: true, revision: 1 });
    expect((await cli(set)).code).not.toBe(0);
    expect(success(await cli(['session', 'me', '--session-file', aFile, '--json'])).studio.shell).toBe('studio');
    expect(success(await cli(['session', 'me', '--session-file', bFile, '--json'])).studio.shell).toBe('legacy-multiuser');
    expect((await cli(['admin', 'studio-pilot', 'get', alice.id, '--session-file', bFile, '--json'])).code).not.toBe(0);
  }, 40_000);

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

  it('answers a personal question using prompt-file stdin and the standard run contract', async () => {
    await linkCodex(daemon, root, alice, 'cli-a@example.test');
    setTurnMode(root, alice, { reply: '<question-form id="brief">{"questions":[{"id":"color","label":"Color","type":"text"}]}</question-form>' });
    const made = success(await cli(['project', 'create', '--name', 'CLI question', '--session-file', aFile, '--json']));
    const base = ['run', 'start', '--project', made.project.id, '--conversation', made.conversationId,
      '--execution-source', 'personal_subscription', '--prompt-file', '-', '--session-file', aFile, '--json'];
    const question = success(await cli(base, 'ask'));
    const watch = await cli(['run', 'watch', question.runId, '--session-file', aFile, '--json']);
    expect(watch.code).toBe(0);
    expect(watch.stdout.includes('"type":"text_delta"')).toBe(true);
    setTurnMode(root, alice, {});
    const answer = success(await cli([...base, '--question-answer', question.runId], '[form answers — brief]\nColor: blue'));
    expect((await cli(['run', 'watch', answer.runId, '--session-file', aFile, '--json'])).code).toBe(0);
    expect((await cli([...base, '--question-answer', question.runId], 'duplicate')).code).not.toBe(0);
    const first = await daemon.request({ path: `/api/runs/${question.runId}`, cookie: alice.cookie });
    const next = await daemon.request({ path: `/api/runs/${answer.runId}`, cookie: alice.cookie });
    expect(next.json.output.threadId).toBe(first.json.output.threadId);
  }, 40_000);

  it('inspects and downloads historical run artifacts through A\'s session and refuses B', async () => {
    const made = success(await cli(['project', 'create', '--name', 'CLI artifacts', '--session-file', aFile, '--json']));
    const started = success(await cli(['run', 'start', '--project', made.project.id, '--conversation', made.conversationId,
      '--execution-source', 'personal_subscription', '--prompt-file', '-', '--session-file', aFile, '--json'], '[mock-write=hero.png]'));
    expect((await cli(['run', 'watch', started.runId, '--session-file', aFile, '--json'])).code).toBe(0);
    const prefix = ['project', 'artifact-snapshot'];
    const listed = success(await cli([...prefix, 'list', '--project', made.project.id, '--conversation', made.conversationId,
      '--message', started.run.assistantMessageId, '--session-file', aFile, '--json']));
    const ref = listed.artifacts[0];
    expect(ref).toMatchObject({ label: 'hero.png', snapshotState: 'ready' });
    const inspect = [...prefix, 'inspect', ref.snapshotId, '--project', made.project.id, '--json'];
    expect(success(await cli([...inspect, '--session-file', aFile])).snapshot).toMatchObject({ projectId: made.project.id, runId: started.runId });
    const out = path.join(root, 'owned-artifact.png');
    const exported = success(await cli([...prefix, 'export', ref.snapshotId, '--project', made.project.id,
      '--out', out, '--session-file', aFile, '--json']));
    expect(exported.byteSize).toBe(readFileSync(out).byteLength);
    expect(readFileSync(out, 'utf8')).toMatch(/^generated by /u);
    expect((await cli([...inspect, '--session-file', bFile])).code).not.toBe(0);
  }, 40_000);

  it('imports, updates, selects and deletes private skills through the same APIs using stdin', async () => {
    const made = success(await cli(['skill', 'import', '--name', 'CLI owned skill', '--prompt-file', '-', '--session-file', aFile, '--json'], 'CLI_SKILL_ORIGINAL'));
    const id = made.skill.id;
    expect(success(await cli(['skill', 'show', id, '--session-file', aFile, '--json'])).body).toBe('CLI_SKILL_ORIGINAL');
    expect((await cli(['skill', 'show', id, '--session-file', bFile, '--json'])).code).not.toBe(0);
    success(await cli(['skill', 'update', id, '--prompt-file', '-', '--session-file', aFile, '--json'], 'CLI_SKILL_UPDATED'));
    const target = success(await cli(['project', 'create', '--name', 'CLI skill turn', '--session-file', aFile, '--json']));
    const started = success(await cli(['run', 'start', '--project', target.project.id, '--conversation', target.conversationId,
      '--execution-source', 'personal_subscription', '--skill', id, '--prompt-file', '-', '--session-file', aFile, '--json'], 'use my skill'));
    expect((await cli(['run', 'watch', started.runId, '--session-file', aFile, '--json'])).code).toBe(0);
    const messages = success(await cli(['conversation', 'messages', target.conversationId, '--project', target.project.id, '--session-file', aFile, '--json']));
    expect(messages.messages.find((message: { role: string }) => message.role === 'assistant').content).toContain('CLI_SKILL_UPDATED');
    expect((await cli(['skill', 'uninstall', id, '--session-file', bFile, '--json'])).code).not.toBe(0);
    success(await cli(['skill', 'uninstall', id, '--session-file', aFile, '--json']));
    expect((await cli(['skill', 'show', id, '--session-file', aFile, '--json'])).code).not.toBe(0);
  }, 40_000);

  it('honors server revocation and logs B out without printing or retaining credentials', async () => {
    const revoked = await daemon.request({ method: 'POST', path: `/api/auth/users/${alice.id}/sessions/revoke`, cookie: admin.cookie, body: {} });
    expect(revoked.status).toBe(200);
    expect((await cli(['project', 'list', '--session-file', aFile, '--json'])).code).not.toBe(0);
    expect(success(await cli(['session', 'logout', '--session-file', bFile, '--json']))).toEqual({ ok: true, sessionRemoved: true });
    expect(() => statSync(bFile)).toThrow();
    expect((await cli(['session', 'me', '--session-file', bFile, '--json'])).code).not.toBe(0);
  });
});


it('administers the OpenAI company pool through write-only stdin credentials and refuses ordinary users', async () => {
  const file = path.join(root, 'cli-company-admin-session');
  const companyAFile = path.join(root, 'cli-company-a-session');
  const companyBFile = path.join(root, 'cli-company-b-session');
  for (const [user, sessionFile] of [[alice, companyAFile], [bob, companyBFile]] as const) {
    success(await cli(['session', 'login', '--daemon-url', daemon.baseUrl, '--username', user.username,
      '--password-file', '-', '--session-file', sessionFile, '--json'], user.password + '\n'));
  }
  success(await cli(['session', 'login', '--daemon-url', daemon.baseUrl, '--username', admin.username,
    '--password-file', '-', '--session-file', file, '--json'], admin.password + '\n'));
  const get = ['admin', 'pool', 'openai', 'get', '--session-file', file, '--json'];
  const current = success(await cli(get)).provider;
  const key = 'sk-cli-company-secret-123456789012345678901234567890';
  const set = ['admin', 'pool', 'openai', 'set', '--enabled', 'true', '--revision', String(current.revision),
    '--model', 'fixture-model', '--capacity', '1', '--api-key-file', '-', '--session-file', file, '--json'];
  const written = await cli(set, key + '\n');
  expect(success(written).provider).toMatchObject({ configured: true, enabled: true, model: 'fixture-model', revision: current.revision + 1 });
  expect(written.stdout + written.stderr).not.toContain(key);
  expect(success(await cli(get)).provider.configured).toBe(true);
  expect((await cli(set, key)).code).not.toBe(0);
  expect((await cli(['admin', 'pool', 'openai', 'get', '--session-file', companyBFile, '--json'])).code).not.toBe(0);
  expect((await cli(['admin', 'pool', 'openai', 'set', '--api-key', key, '--session-file', file, '--json'])).code).not.toBe(0);
  const made = success(await cli(['project', 'create', '--name', 'CLI OpenAI run', '--session-file', companyAFile, '--json']));
  const admitted = success(await cli(['run', 'start', '--project', made.project.id, '--conversation', made.conversationId,
    '--agent', 'openai', '--execution-source', 'company_pool', '--prompt-file', '-', '--session-file', companyAFile, '--json'], 'Company CLI prompt'));
  const watched = await cli(['run', 'watch', admitted.runId, '--session-file', companyAFile, '--json']);
  expect(watched.code, watched.stderr).toBe(0);
  expect(watched.stdout).toContain('CLI company completed.');
  expect(watched.stdout).not.toContain(key);
  expect((await cli(['run', 'info', admitted.runId, '--session-file', companyBFile, '--json'])).code).not.toBe(0);
  const revoked = success(await cli(['admin', 'pool', 'openai', 'set', '--enabled', 'false', '--revision', String(current.revision + 1),
    '--model', 'fixture-model', '--capacity', '0', '--revoke-key', '--session-file', file, '--json']));
  expect(revoked.provider.configured).toBe(false);
}, 40_000);
