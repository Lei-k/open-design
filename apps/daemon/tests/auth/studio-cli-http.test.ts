import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupIsolatedDataRoot, loadIsolatedServerModule, login, multiUserOptions, provisionAccounts, startMultiUserDaemon, type Principal, type StartedMultiUserDaemon } from './multiuser-harness.js';
import { PERSONAL_CODEX_MOCK, codexHome, linkCodex, setTurnMode, until } from './personal-codex-helpers.js';
import { FIXTURE_PLUGIN_ID, PIPELINE_ONLY_PLUGIN_ID, installStudioFixturePlugin } from './studio-plugin-fixture.js';

let daemon: StartedMultiUserDaemon;
let alice: Principal;
let bob: Principal;
let admin: Principal;
let root: string;
let aFile: string;
let bFile: string;
beforeAll(async () => {
  ({ dataRoot: root } = await loadIsolatedServerModule());
  daemon = await startMultiUserDaemon(multiUserOptions({ testMockAgentScript: path.resolve('../..', 'mocks/run-isolation-agent.ts'), testPersonalCodexAppServer: PERSONAL_CODEX_MOCK, studioRenderer: { assetHosts: [] },
    testCompanyOpenAIFetch: async () => new Response('data: ' + JSON.stringify({ type: 'response.output_text.delta', delta: 'CLI company completed.\n' })
      + '\n\ndata: ' + JSON.stringify({ type: 'response.completed', response: { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'CLI company completed.' }] }] } }) + '\n\n',
      { headers: { 'content-type': 'text/event-stream' } }),
    testTavilyFetch: async () => Response.json({ answer: 'CLI research summary', results: [{ title: 'CLI source', url: 'https://example.test/cli', content: 'CLI snippet' }] }) }));
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
  it('creates, reads, maps, refreshes, edits and deletes live artifacts through the pinned session CLI', async () => {
    const session = path.join(root, 'cli-live-artifact-session');
    success(await cli(['session', 'login', '--daemon-url', daemon.baseUrl, '--username', alice.username,
      '--password-file', '-', '--session-file', session, '--json'], alice.password));
    const projectId = success(await cli(['project', 'create', '--name', 'CLI live artifact', '--session-file', session, '--json'])).project.id;
    expect((await daemon.request({ method: 'POST', path: `/api/projects/${projectId}/files`, cookie: alice.cookie,
      body: { name: 'sales.json', content: '{"report":{"total":8}}' } })).status).toBe(200);
    const request = { input: { title: 'CLI sales', preview: { type: 'html', entry: 'index.html' }, document: {
      format: 'html_template_v1', templatePath: 'template.html', generatedPreviewPath: 'index.html', dataPath: 'data.json', dataJson: { total: 3 },
      sourceJson: { type: 'local_file', input: { path: 'sales.json' }, refreshPermission: 'manual_refresh_granted_for_read_only',
        outputMapping: { dataPaths: [{ from: 'report.total', to: 'total' }] } },
    } }, templateHtml: '<h1>{{data.total}}</h1>' };
    const artifact = success(await cli(['live-artifact', 'create', projectId, '--prompt-file', '-', '--session-file', session, '--json'], JSON.stringify(request))).artifact;
    expect(artifact.studioProvenance.origin).toBe('user');
    expect(success(await cli(['live-artifact', 'list', projectId, '--session-file', session, '--json'])).artifacts.map((item: { id: string }) => item.id)).toEqual([artifact.id]);
    expect(success(await cli(['live-artifact', 'code', projectId, artifact.id, '--session-file', session, '--json']))).toBe('<h1>3</h1>');
    const refreshed = success(await cli(['live-artifact', 'refresh', projectId, artifact.id, '--session-file', session, '--json'])).artifact;
    expect(refreshed.document.dataJson).toEqual({ total: 8 }); expect(refreshed.studioProvenance.source.path).toBe('sales.json');
    expect(success(await cli(['live-artifact', 'history', projectId, artifact.id, '--session-file', session, '--json'])).refreshes).toHaveLength(1);
    expect((await daemon.request({ path: `/api/live-artifacts/${artifact.id}?projectId=${projectId}`, cookie: bob.cookie })).status).toBe(404);
    const update = { input: { document: { ...refreshed.document, dataJson: { total: 11 } } }, expectedRevision: refreshed.studioRevision };
    expect(success(await cli(['live-artifact', 'update', projectId, artifact.id, '--prompt-file', '-', '--session-file', session, '--json'], JSON.stringify(update))).artifact.studioProvenance.origin).toBe('user');
    expect(success(await cli(['live-artifact', 'info', projectId, artifact.id, '--session-file', session, '--json'])).artifact.document.dataJson).toEqual({ total: 11 });
    expect(success(await cli(['live-artifact', 'delete', projectId, artifact.id, '--session-file', session, '--json']))).toEqual({ ok: true });
    expect(success(await cli(['live-artifact', 'list', projectId, '--session-file', session, '--json'])).artifacts).toEqual([]);
  }, 120_000);

  it('exports server-rendered PPTX and PDF through od export over a session', async () => {
    const session = path.join(root, 'cli-render-session');
    success(await cli(['session', 'login', '--daemon-url', daemon.baseUrl, '--username', alice.username,
      '--password-file', '-', '--session-file', session, '--json'], alice.password));
    const made = success(await cli(['project', 'create', '--name', 'CLI render', '--session-file', session, '--json']));
    const projectId = made.project.id;
    expect((await daemon.request({ method: 'POST', path: `/api/projects/${projectId}/files`, cookie: alice.cookie,
      body: { name: 'deck.html', content: '<section class="slide"><h1>CLI slide</h1></section>' } })).status).toBe(200);
    for (const [format, magic] of [['pptx', 'PK'], ['pdf', '%PDF']] as const) {
      const out = path.join(root, `cli-render.${format}`);
      const result = success(await cli(['export', '--project', projectId, '--file', 'deck.html', '--format', format, '--deck',
        '--out', out, '--session-file', session, '--json']));
      expect(result).toMatchObject({ ok: true, path: out });
      expect(readFileSync(out).subarray(0, magic.length).toString()).toBe(magic);
    }
  }, 120_000);

  it('lists, adds, updates and deletes owner preview comments through the comment endpoints', async () => {
    const session = path.join(root, 'cli-comment-session');
    success(await cli(['session', 'login', '--daemon-url', daemon.baseUrl, '--username', alice.username,
      '--password-file', '-', '--session-file', session, '--json'], alice.password));
    const made = success(await cli(['project', 'create', '--name', 'CLI comments', '--session-file', session, '--json']));
    const projectId = made.project.id; const conversation = made.conversationId;
    const added = success(await cli(['comment', 'add', projectId, '--conversation', conversation, '--file', 'index.html',
      '--selector', '#hero', '--prompt-file', '-', '--session-file', session, '--json'], 'Tighten the hero spacing'));
    expect(added.comment).toMatchObject({ filePath: 'index.html', selector: '#hero', note: 'Tighten the hero spacing', status: 'open' });
    const status = success(await cli(['comment', 'status', projectId, added.comment.id, '--conversation', conversation,
      '--status', 'resolved', '--session-file', session, '--json']));
    expect(status.comment.status).toBe('resolved');
    const listed = success(await cli(['comment', 'list', projectId, '--conversation', conversation, '--session-file', session, '--json']));
    expect(listed.comments.map((comment: { id: string }) => comment.id)).toEqual([added.comment.id]);
    // The same endpoint refuses another account exactly like a missing project.
    expect((await daemon.request({ path: `/api/projects/${projectId}/conversations/${conversation}/comments`, cookie: bob.cookie })).status).toBe(404);
    expect(success(await cli(['comment', 'delete', projectId, added.comment.id, '--conversation', conversation, '--session-file', session, '--json']))).toEqual({ ok: true });
    expect(success(await cli(['comment', 'list', projectId, '--conversation', conversation, '--session-file', session, '--json'])).comments).toEqual([]);
  });

  it('shares a project with another account, lists members and presence, and revokes it through od project', async () => {
    const owner = path.join(root, 'cli-share-owner'); const grantee = path.join(root, 'cli-share-grantee');
    for (const [user, file] of [[alice, owner], [bob, grantee]] as const) {
      success(await cli(['session', 'login', '--daemon-url', daemon.baseUrl, '--username', user.username,
        '--password-file', '-', '--session-file', file, '--json'], user.password));
    }
    const made = success(await cli(['project', 'create', '--name', 'CLI shared', '--session-file', owner, '--json']));
    const projectId = made.project.id;
    expect(success(await cli(['project', 'share', projectId, bob.username, '--role', 'comment', '--session-file', owner, '--json'])).member)
      .toMatchObject({ accountId: bob.id, username: bob.username, role: 'comment' });
    expect((await cli(['project', 'share', projectId, bob.username, '--role', 'admin', '--session-file', owner, '--json'])).code).toBe(2);
    const members = success(await cli(['project', 'members', projectId, '--session-file', grantee, '--json']));
    expect(members).toMatchObject({ role: 'comment', owner: { username: alice.username } });
    expect((await cli(['project', 'share', projectId, alice.username, '--role', 'view', '--session-file', grantee, '--json'])).code).not.toBe(0);
    expect((await daemon.request({ method: 'POST', path: `/api/projects/${projectId}/presence/heartbeat`, cookie: bob.cookie, body: { clientId: 'cli-tab' } })).status).toBe(200);
    expect(success(await cli(['project', 'presence', projectId, '--session-file', owner, '--json'])).present)
      .toEqual([expect.objectContaining({ memberId: bob.id, name: bob.username })]);
    const added = success(await cli(['comment', 'add', projectId, '--conversation', made.conversationId, '--file', 'index.html',
      '--selector', '#hero', '--note', 'From Bob', '--session-file', grantee, '--json']));
    expect(added.comment.authorMemberId).toBe(bob.id);
    expect(success(await cli(['project', 'unshare', projectId, bob.username, '--session-file', owner, '--json']))).toEqual({ ok: true });
    expect((await cli(['project', 'members', projectId, '--session-file', grantee, '--json'])).code).not.toBe(0);
    // Leaving: re-share, then the grantee gives the access up.
    success(await cli(['project', 'share', projectId, bob.username, '--role', 'view', '--session-file', owner, '--json']));
    expect(success(await cli(['project', 'leave', projectId, '--session-file', grantee, '--json']))).toEqual({ ok: true });
    expect(success(await cli(['project', 'members', projectId, '--session-file', owner, '--json'])).members.map((m: { username: string }) => m.username)).toEqual([alice.username]);
  }, 120_000);

  it('duplicates and saves/shows/uses/deletes captured private templates through the same APIs', async () => {
    const session = path.join(root, 'cli-template-session');
    success(await cli(['session', 'login', '--daemon-url', daemon.baseUrl, '--username', alice.username,
      '--password-file', '-', '--session-file', session, '--json'], alice.password));
    const source = success(await cli(['project', 'create', '--name', 'CLI template source', '--session-file', session, '--json']));
    const projectId = source.project.id;
    expect((await daemon.request({ method: 'POST', path: `/api/projects/${projectId}/files`, cookie: alice.cookie,
      body: { name: 'index.html', content: '<h1>CLI captured version</h1>' } })).status).toBe(200);
    const copy = success(await cli(['project', 'duplicate', projectId, '--session-file', session, '--json']));
    expect(copy.copiedFiles).toEqual(['index.html']);
    const saved = success(await cli(['templates', 'save', projectId, '--name', 'CLI snapshot', '--session-file', session, '--json']));
    const id = saved.template.id;
    const shown = success(await cli(['templates', 'show', id, '--session-file', session, '--json']));
    expect(shown.template).toEqual(saved.template);
    const metadata = path.join(root, 'cli-template-metadata.json');
    await import('node:fs/promises').then(({ writeFile }) => writeFile(metadata, JSON.stringify({ kind: 'template', templateId: id })));
    const used = success(await cli(['project', 'create', '--name', 'CLI from template', '--metadata-json', metadata,
      '--prompt-file', '-', '--session-file', session, '--json'], 'Continue editing the captured design.'));
    expect(used.project.metadata.templateId).toBe(id);
    expect((await daemon.request({ path: `/api/projects/${used.project.id}/files/index.html`, cookie: alice.cookie })).text).toBe('<h1>CLI captured version</h1>');
    expect(success(await cli(['templates', 'delete', id, '--session-file', session, '--json']))).toMatchObject({ ok: true });
    const fs = await import('node:fs/promises');
    const directory = path.join(root, 'cli-folder'); await fs.mkdir(path.join(directory, 'src'), { recursive: true });
    await fs.writeFile(path.join(directory, 'src', 'App.tsx'), 'export const App = () => null');
    const imported = success(await cli(['project', 'import-folder', directory, '--session-file', session, '--json']));
    expect(imported.project.name).toBe('cli-folder');
    expect((await daemon.request({ path: `/api/projects/${imported.project.id}/files/src/App.tsx`, cookie: alice.cookie })).text).toBe('export const App = () => null');
    expect(imported.project.metadata.baseDir).toBeUndefined();
    const archiveOutput = path.join(root, 'cli-owned-download.zip');
    const receipt = success(await cli(['project', 'archive', imported.project.id, '--out', archiveOutput,
      '--session-file', session, '--json']));
    const { createHash } = await import('node:crypto');
    expect(receipt).toMatchObject({ projectId: imported.project.id, path: archiveOutput,
      sha256: createHash('sha256').update(readFileSync(archiveOutput)).digest('hex'), bytes: statSync(archiveOutput).size });
    const overwrite = await cli(['project', 'archive', imported.project.id, '--out', archiveOutput, '--session-file', session, '--json']);
    expect(overwrite.code).not.toBe(0);
    const htmlOutput = path.join(root, 'cli-owned-export.html');
    const html = success(await cli(['project', 'export-html', projectId, '--path', 'index.html', '--out', htmlOutput,
      '--title', 'CLI export', '--session-file', session, '--json']));
    expect(html).toMatchObject({ projectId, entry: 'index.html', path: htmlOutput, externalDependencies: 0 });
    expect(readFileSync(htmlOutput, 'utf8')).toContain('CLI captured version');
    expect((await cli(['project', 'export-html', projectId, '--path', 'index.html', '--out', htmlOutput, '--session-file', session, '--json'])).code).not.toBe(0);
    const versions = await daemon.request({ path: `/api/projects/${projectId}/files/index.html/versions`, cookie: alice.cookie });
    const firstVersion = (versions.json.versions as Array<{ id: string }>)[0]!.id;
    const versionOutput = path.join(root, 'cli-owned-export-version.html');
    expect(success(await cli(['project', 'export-html', projectId, '--path', 'index.html', '--out', versionOutput,
      '--version-id', firstVersion, '--session-file', session, '--json']))).toMatchObject({ versionId: firstVersion, path: versionOutput });

    const { default: JSZip } = await import('jszip'); const zip = new JSZip(); zip.file('index.html', 'CLI archive original');
    const downloaded = await JSZip.loadAsync(readFileSync(archiveOutput));
    expect(await downloaded.file('src/App.tsx')!.async('string')).toBe('export const App = () => null');
    const batchOutput = path.join(root, 'cli-owned-selection.zip');
    success(await cli(['project', 'archive', imported.project.id, '--out', batchOutput, '--files-json', '-', '--session-file', session, '--json'], JSON.stringify(['src/App.tsx'])));
    expect((await JSZip.loadAsync(readFileSync(batchOutput))).file('src/App.tsx')).not.toBeNull();
    const archive = path.join(root, 'cli-archive.zip'); await fs.writeFile(archive, await zip.generateAsync({ type: 'nodebuffer' }));
    const zipped = success(await cli(['project', 'import-zip', archive, '--session-file', session, '--json']));
    expect((await daemon.request({ path: `/api/projects/${zipped.project.id}/files/index.html`, cookie: alice.cookie })).text).toBe('CLI archive original');
  });
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
    // Studio is the default shell; the toggle writes an administrator's opt-out.
    expect(success(await cli(get))).toEqual({ studioPilot: true, revision: 0 });
    const off = ['admin', 'studio-pilot', 'set', alice.id, '--enabled', 'false', '--revision', '0', '--session-file', file, '--json'];
    expect(success(await cli(off))).toEqual({ studioPilot: false, revision: 1 });
    expect((await cli(off)).code).not.toBe(0);
    const set = ['admin', 'studio-pilot', 'set', alice.id, '--enabled', 'true', '--revision', '1', '--session-file', file, '--json'];
    expect(success(await cli(set))).toEqual({ studioPilot: true, revision: 2 });
    expect((await cli(set)).code).not.toBe(0);
    expect(success(await cli(['session', 'me', '--session-file', aFile, '--json'])).studio.shell).toBe('studio');
    // B keeps the default until an administrator says otherwise, and reads legacy once one does.
    expect(success(await cli(['session', 'me', '--session-file', bFile, '--json'])).studio.shell).toBe('studio');
    success(await cli(['admin', 'studio-pilot', 'set', bob.id, '--enabled', 'false', '--revision', '0', '--session-file', file, '--json']));
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
    const target = success(await cli(['project', 'create', '--name', 'CLI skill turn', '--skill', id,
      '--prompt-file', '-', '--session-file', aFile, '--json'], 'CLI initial project brief'));
    expect(target.project).toMatchObject({ skillId: id, pendingPrompt: 'CLI initial project brief' });
    const started = success(await cli(['run', 'start', '--project', target.project.id, '--conversation', target.conversationId,
      '--execution-source', 'personal_subscription', '--skill', id, '--model', 'gpt-6-sol', '--reasoning', 'low',
      '--prompt-file', '-', '--session-file', aFile, '--json'], 'use my skill'));
    expect((await cli(['run', 'watch', started.runId, '--session-file', aFile, '--json'])).code).toBe(0);
    expect(JSON.parse(readFileSync(path.join(codexHome(root, alice.id), 'mock-turn-evidence.json'), 'utf8'))).toMatchObject({ model: 'gpt-6-sol', effort: 'low' });
    const messages = success(await cli(['conversation', 'messages', target.conversationId, '--project', target.project.id, '--session-file', aFile, '--json']));
    expect(messages.messages.find((message: { role: string }) => message.role === 'assistant').content).toContain('CLI_SKILL_UPDATED');
    expect((await cli(['skill', 'uninstall', id, '--session-file', bFile, '--json'])).code).not.toBe(0);
    success(await cli(['skill', 'uninstall', id, '--session-file', aFile, '--json']));
    expect((await cli(['skill', 'show', id, '--session-file', aFile, '--json'])).code).not.toBe(0);
  }, 40_000);

  it('imports a skill folder with side files into the actor catalog only', async () => {
    const folder = path.join(root, 'cli-folder-skill');
    mkdirSync(path.join(folder, 'assets'), { recursive: true });
    writeFileSync(path.join(folder, 'SKILL.md'), '---\nname: CLI folder skill\n---\nCLI_FOLDER_SKILL_BODY');
    writeFileSync(path.join(folder, 'assets', 'mark.bin'), Buffer.from([0, 255, 7]));
    writeFileSync(path.join(folder, '.env'), 'NOT_UPLOADED=1');
    const made = success(await cli(['skill', 'import-folder', folder, '--session-file', aFile, '--json']));
    const id = made.skill.id;
    expect(made.skill.name).toBe('CLI folder skill');
    const files = await daemon.request({ path: `/api/skills/${encodeURIComponent(id)}/files`, cookie: alice.cookie });
    expect(files.json.files.map((file: { path: string }) => file.path).sort()).toEqual(['SKILL.md', 'assets/mark.bin']);
    expect((await cli(['skill', 'show', id, '--session-file', bFile, '--json'])).code).not.toBe(0);
    success(await cli(['skill', 'uninstall', id, '--session-file', aFile, '--json']));
  }, 40_000);

  it('creates, runs and lists account automations through the same routine APIs', async () => {
    const made = success(await cli(['automation', 'create', '--name', 'CLI routine', '--prompt-file', '-', '--schedule', 'daily:09:00',
      '--session-file', aFile, '--json'], 'CLI_ROUTINE_PROMPT'));
    const id = made.routine.id;
    expect(made.routine).toMatchObject({ name: 'CLI routine', agentId: 'codex', enabled: true });
    expect(success(await cli(['automation', 'list', '--session-file', aFile, '--json'])).routines.map((item: { id: string }) => item.id)).toContain(id);
    expect(success(await cli(['automation', 'list', '--session-file', bFile, '--json'])).routines).toEqual([]);
    expect((await cli(['automation', 'run', id, '--session-file', bFile, '--json'])).code).not.toBe(0);
    const started = success(await cli(['automation', 'run', id, '--session-file', aFile, '--json']));
    expect(started.projectId).toEqual(expect.any(String));
    let history: { runs: Array<{ status: string }> } = { runs: [] };
    for (let attempt = 0; attempt < 200 && history.runs[0]?.status !== 'succeeded'; attempt++) {
      history = success(await cli(['automation', 'runs', id, '--session-file', aFile, '--json']));
      if (history.runs[0]?.status !== 'succeeded') await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(history.runs[0]).toMatchObject({ status: 'succeeded', trigger: 'manual' });
    // #64: crystallize, templates, ingestion and proposal review on the same account APIs.
    const runId = (history.runs[0] as unknown as { id: string }).id;
    expect((await cli(['automation', 'crystallize-run', id, runId, '--session-file', bFile, '--json'])).code).not.toBe(0);
    const crystal = success(await cli(['automation', 'crystallize-run', id, runId, '--session-file', aFile, '--json']));
    const skillProposal = crystal.proposals.find((item: { targetKind: string }) => item.targetKind === 'skill');
    expect(success(await cli(['automation', 'proposal', 'list', '--status', 'pending-review', '--session-file', bFile, '--json'])).proposals).toEqual([]);
    expect((await cli(['automation', 'proposal', 'apply', skillProposal.id, '--session-file', bFile, '--json'])).code).not.toBe(0);
    const applied = success(await cli(['automation', 'proposal', 'apply', skillProposal.id, '--session-file', aFile, '--json']));
    expect(applied.result.skillId).toMatch(/^studio-skill:/);
    const templates = success(await cli(['automation', 'template', 'list', '--session-file', aFile, '--json'])).templates;
    expect(templates.find((item: { id: string }) => item.id === 'connector-digest-design-context').unavailable.code).toBe('MULTIUSER_CAPABILITY_UNAVAILABLE');
    const templateDraft = { title: 'CLI private template', description: 'Private description', purpose: 'Private purpose', triggerKinds: ['manual'], sourceKinds: ['chat'],
      stages: [{ id: 'propose', kind: 'propose', title: 'Review brief' }], outputSinks: ['memory'], reviewPolicy: 'always', tokenCompression: 'balanced' };
    const templateProposal = success(await cli(['automation', 'template', 'propose', '--action', 'create', '--prompt-file', '-', '--session-file', aFile, '--json'], JSON.stringify(templateDraft)));
    expect(templateProposal.proposal.targetKind).toBe('automation-template');
    const templateApplied = success(await cli(['automation', 'proposal', 'apply', templateProposal.proposal.id, '--session-file', aFile, '--json']));
    const privateTemplateId = templateApplied.result.automationTemplateId;
    expect(success(await cli(['automation', 'template', 'get', privateTemplateId, '--session-file', aFile, '--json'])).template.studioOwned).toBe(true);
    expect((await cli(['automation', 'template', 'get', privateTemplateId, '--session-file', bFile, '--json'])).code).not.toBe(0);
    const privateRoutine = success(await cli(['automation', 'create', '--template', privateTemplateId, '--schedule', 'daily:07:00', '--session-file', aFile, '--json']));
    expect(privateRoutine.routine.name).toBe(templateDraft.title);
    const templateDeletion = success(await cli(['automation', 'template', 'propose', '--action', 'delete', '--target', privateTemplateId, '--session-file', aFile, '--json']));
    success(await cli(['automation', 'proposal', 'apply', templateDeletion.proposal.id, '--session-file', aFile, '--json']));
    expect((await cli(['automation', 'template', 'get', privateTemplateId, '--session-file', aFile, '--json'])).code).not.toBe(0);
    success(await cli(['automation', 'delete', privateRoutine.routine.id, '--session-file', aFile, '--json']));
    const fromTemplate = success(await cli(['automation', 'create', '--template', 'compress-project-context', '--schedule', 'daily:07:00',
      '--session-file', aFile, '--json']));
    expect(fromTemplate.routine).toMatchObject({ templateId: 'compress-project-context', name: 'Compress project context' });
    expect((await cli(['automation', 'create', '--template', 'connector-digest-design-context', '--schedule', 'daily:07:00',
      '--session-file', aFile, '--json'])).code).not.toBe(0);
    const ingested = success(await cli(['automation', 'source', 'ingest', '--source-kind', 'upload', '--title', 'CLI notes', '--body-file', '-',
      '--candidate-sinks', 'memory', '--session-file', aFile, '--json'], 'CLI_INGEST_MARKER prefer calm palettes'));
    expect(success(await cli(['automation', 'source', 'list', '--session-file', bFile, '--json'])).packets).toEqual([]);
    expect((await cli(['automation', 'source', 'get', ingested.packet.id, '--session-file', bFile, '--json'])).code).not.toBe(0);
    const rejected = success(await cli(['automation', 'proposal', 'reject', ingested.proposals[0].id, '--reason', 'later', '--session-file', aFile, '--json']));
    expect(rejected.proposal.status).toBe('rejected');
    expect((await cli(['automation', 'source', 'ingest', '--source-kind', 'connector', '--body', 'x', '--session-file', aFile, '--json'])).code).not.toBe(0);
    success(await cli(['automation', 'delete', fromTemplate.routine.id, '--session-file', aFile, '--json']));
    success(await cli(['automation', 'delete', id, '--session-file', aFile, '--json']));
  }, 60_000);

  it('switches automatic memory, reads its history and distils rules per account through od memory (#62)', async () => {
    const on = success(await cli(['memory', 'config', '--extraction', 'true', '--session-file', aFile, '--json']));
    expect(on).toMatchObject({ chatExtractionEnabled: true });
    expect(success(await cli(['memory', 'config', '--session-file', bFile, '--json'])).chatExtractionEnabled).toBe(false);
    const extracted = await daemon.request({ method: 'POST', path: '/api/memory/extract', cookie: alice.cookie, body: { userMessage: 'remember: CLI_MEMORY_MARKER ships on Fridays' } });
    expect(extracted.json.changed).toHaveLength(1);
    const history = success(await cli(['memory', 'extractions', 'list', '--session-file', aFile, '--json'])).extractions;
    expect(history[0]).toMatchObject({ kind: 'heuristic', phase: 'success', writtenCount: 1 });
    expect(success(await cli(['memory', 'extractions', '--session-file', bFile, '--json'])).extractions).toEqual([]);
    expect(success(await cli(['memory', 'extractions', 'delete', history[0].id, '--session-file', bFile, '--json']))).toEqual({ removed: 0 });
    const rules = success(await cli(['memory', 'rule', 'suggest', '--note', 'Keep the logo top-left', '--target', 'Header', '--session-file', aFile, '--json']));
    expect(rules).toMatchObject({ attemptedLLM: false, source: 'heuristic' });
    expect(success(await cli(['memory', 'verify', 'list', '--session-file', aFile, '--json'])).verifications).toEqual([]);
    expect(success(await cli(['memory', 'extractions', 'clear', '--session-file', aFile, '--json'])).removed).toBeGreaterThan(0);
    success(await cli(['memory', 'config', '--extraction', 'false', '--session-file', aFile, '--json']));
  }, 40_000);

  it('reads and replaces the account memory index through od memory index (#81)', async () => {
    const bBefore = success(await cli(['memory', 'index', '--session-file', bFile, '--json'])).index;
    const index = '# Memory\n\n- CLI_INDEX_MARKER\n';
    expect(success(await cli(['memory', 'index', 'set', '--prompt-file', '-', '--session-file', aFile, '--json'], index))).toEqual({ index });
    expect(success(await cli(['memory', 'index', 'show', '--session-file', aFile, '--json'])).index).toBe(index);
    expect(success(await cli(['memory', 'index', '--session-file', bFile, '--json'])).index).toBe(bBefore);
    expect((await cli(['memory', 'index', 'set', '--session-file', aFile, '--json'])).code).not.toBe(0);
  }, 40_000);

  it('shares a private skill and design document for use and revokes them through od skill / od design-system (#61/#65)', async () => {
    const skill = success(await cli(['skill', 'import', '--name', 'cli-shared-skill', '--prompt-file', '-', '--session-file', aFile, '--json'], 'CLI_SHARED_SKILL'));
    const skillId = skill.skill.id as string;
    const document = success(await cli(['design-system', 'create', '--title', 'CLI shared', '--prompt-file', '-', '--session-file', aFile, '--json'], '# CLI\nCLI_SHARED_DESIGN'));
    const designId = (document.designSystem ?? document).id as string;
    expect((await cli(['skill', 'members', skillId, '--session-file', bFile, '--json'])).code).not.toBe(0);
    expect(success(await cli(['skill', 'share', skillId, bob.username, '--session-file', aFile, '--json'])).member).toMatchObject({ username: bob.username, role: 'use' });
    expect(success(await cli(['design-system', 'share', designId, bob.username, '--session-file', aFile, '--json'])).member.role).toBe('use');
    expect((await cli(['skill', 'share', skillId, alice.username, '--session-file', bFile, '--json'])).code).not.toBe(0);
    const members = success(await cli(['skill', 'members', skillId, '--session-file', bFile, '--json']));
    expect(members).toMatchObject({ role: 'use', owner: { username: alice.username } });
    // (The full bundled list is asserted over HTTP; a large `--json` list can outrun the CLI's exit.)
    expect(success(await cli(['skill', 'show', skillId, '--session-file', bFile, '--json']))).toMatchObject({ body: 'CLI_SHARED_SKILL',
      studioShare: { role: 'use', ownerUsername: alice.username } });
    success(await cli(['design-system', 'leave', designId, '--session-file', bFile, '--json']));
    expect((await cli(['design-system', 'show', designId, '--session-file', bFile, '--json'])).code).not.toBe(0);
    success(await cli(['skill', 'unshare', skillId, bob.username, '--session-file', aFile, '--json']));
    expect((await cli(['skill', 'show', skillId, '--session-file', bFile, '--json'])).code).not.toBe(0);
    expect((await cli(['skill', 'unshare', skillId, bob.username, '--session-file', aFile, '--json'])).code).not.toBe(0);
  }, 60_000);

  it('lists, shows and applies bundled plugins with Web availability through od plugin; B and unavailable plugins are refused (#61)', async () => {
    const listed = success(await cli(['plugin', 'list', '--bundled', '--session-file', aFile, '--json']));
    expect(listed.total).toBeGreaterThan(100);
    // The finite stage runner opens this bundled pipeline of Web atoms.
    expect(listed.plugins.filter((plugin: { availability: { applicable: boolean } }) => plugin.availability.applicable).map((plugin: { id: string }) => plugin.id)).toEqual([PIPELINE_ONLY_PLUGIN_ID]);
    const share = listed.plugins.find((plugin: { id: string }) => plugin.id === PIPELINE_ONLY_PLUGIN_ID);
    expect(share).toMatchObject({ fsPath: '', availability: { applicable: true, reasons: [] } });
    const unavailable = success(await cli(['plugin', 'show', 'image-template-vr-headset-exploded-view-poster', '--session-file', aFile, '--json']));
    expect(unavailable.availability).toMatchObject({ applicable: false, reasons: expect.arrayContaining([{ code: 'unknown-atom', subject: 'image-generate' }]) });
    // Previewing a shipped example does not imply its generation atoms are available.
    const previewArgs = ['plugin', 'preview', 'example-article-magazine', '--session-file', aFile, '--json'];
    const preview = success(await cli(previewArgs)); expect(preview.html).toContain('<html');
    const bPreview = success(await cli(['plugin', 'preview', 'example-article-magazine', '--session-file', bFile, '--json']));
    expect(bPreview.html).toBe(preview.html);
    const descriptor = success(await cli([...previewArgs, '--variant', 'descriptor']));
    expect(descriptor).toMatchObject({ pluginId: 'example-article-magazine', entry: 'example.html' });
    expect(new URL(descriptor.url).pathname).toMatch(/^\/api\/multiuser\/plugin-preview\//);
    expect((await daemon.request({ path: '/api/plugins/example-article-magazine/asset/SKILL.md', cookie: alice.cookie })).status).toBe(403);
    const made = success(await cli(['project', 'create', '--name', 'CLI plugins', '--session-file', aFile, '--json']));
    const pid = made.project.id as string;
    const pipeline = await cli(['plugin', 'apply', PIPELINE_ONLY_PLUGIN_ID, '--project', pid, '--session-file', aFile, '--json']);
    expect(success(pipeline)).toMatchObject({ ok: true, projectId: pid, appliedPlugin: { pluginId: PIPELINE_ONLY_PLUGIN_ID, pipeline: { stages: [
      { id: 'inspect-project', atoms: ['file-read'] }, { id: 'package-plugin', atoms: ['file-write'] }] } } });
    const refused = await cli(['plugin', 'apply', 'image-template-vr-headset-exploded-view-poster', '--project', pid, '--session-file', aFile, '--json']);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain('MULTIUSER_CAPABILITY_UNAVAILABLE');
    expect(refused.stderr).toContain('image-generate');
    // Apply itself, through a test-only applicable row the same registry evaluates.
    installStudioFixturePlugin(root);
    expect(success(await cli(['plugin', 'show', FIXTURE_PLUGIN_ID, '--session-file', aFile, '--json'])).availability).toEqual({ applicable: true, reasons: [] });
    const applied = success(await cli(['plugin', 'apply', FIXTURE_PLUGIN_ID, '--project', pid, '--session-file', aFile, '--json']));
    expect(applied).toMatchObject({ ok: true, projectId: pid, appliedPlugin: { pluginId: FIXTURE_PLUGIN_ID, snapshotId: applied.snapshotId } });
    const foreign = await cli(['plugin', 'apply', FIXTURE_PLUGIN_ID, '--project', pid, '--session-file', bFile, '--json']);
    expect(foreign.code).not.toBe(0);
    expect(foreign.stderr).toContain('PROJECT_NOT_FOUND');
    // Catalog skill references use the same apply endpoint and owner/use policy.
    const shared = success(await cli(['skill', 'import', '--name', 'cli-plugin-reference', '--prompt-file', '-', '--session-file', bFile, '--json'], 'CLI_PLUGIN_REFERENCE'));
    const sharedId = shared.skill.id as string;
    const db = new Database(path.join(root, 'app.sqlite'));
    const original = db.prepare('SELECT manifest_json FROM installed_plugins WHERE id = ?').get(FIXTURE_PLUGIN_ID) as { manifest_json: string };
    try {
      db.prepare("UPDATE installed_plugins SET manifest_json = json_set(manifest_json, '$.od.context.skills', json(?)) WHERE id = ?")
        .run(JSON.stringify([{ path: './SKILL.md' }, { ref: sharedId }]), FIXTURE_PLUGIN_ID);
      expect((await cli(['plugin', 'apply', FIXTURE_PLUGIN_ID, '--project', pid, '--session-file', aFile, '--json'])).code).not.toBe(0);
      success(await cli(['skill', 'share', sharedId, alice.username, '--session-file', bFile, '--json']));
      const captured = success(await cli(['plugin', 'apply', FIXTURE_PLUGIN_ID, '--project', pid, '--session-file', aFile, '--json']));
      expect(captured.appliedPlugin.resolvedContext.items).toContainEqual({ kind: 'skill', id: sharedId, label: 'cli-plugin-reference' });
      success(await cli(['skill', 'unshare', sharedId, alice.username, '--session-file', bFile, '--json']));
      expect((await cli(['plugin', 'apply', FIXTURE_PLUGIN_ID, '--project', pid, '--session-file', aFile, '--json'])).code).not.toBe(0);
      expect(success(await cli(['project', 'info', pid, '--session-file', aFile, '--json'])).project.appliedPluginSnapshotId).toBe(captured.snapshotId);
    } finally {
      db.prepare('UPDATE installed_plugins SET manifest_json = ? WHERE id = ?').run(original.manifest_json, FIXTURE_PLUGIN_ID); db.close();
    }
    const install = await cli(['plugin', 'install', '--source', 'github:example/plugin', '--session-file', aFile, '--json']);
    expect(install.code).not.toBe(0);
    expect(`${install.stdout}${install.stderr}`).toContain('MULTIUSER_CAPABILITY_UNAVAILABLE');
  }, 90_000);

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

it('stores the account\'s own OpenAI key through stdin, runs on it with --execution-source personal_api_key and never prints it', async () => {
  const sessionA = path.join(root, 'cli-key-a-session'); const sessionB = path.join(root, 'cli-key-b-session');
  for (const [user, sessionFile] of [[alice, sessionA], [bob, sessionB]] as const) {
    success(await cli(['session', 'login', '--daemon-url', daemon.baseUrl, '--username', user.username,
      '--password-file', '-', '--session-file', sessionFile, '--json'], user.password + '\n'));
  }
  const key = 'sk-cli-account-own-key-1234567890abcdefWXYZ';
  const initial = success(await cli(['account', 'key', 'get', '--session-file', sessionA, '--json'])).key;
  expect(initial).toMatchObject({ provider: 'openai', configured: false, last4: null });
  expect((await cli(['account', 'key', 'set', '--api-key', key, '--revision', '0', '--session-file', sessionA, '--json'])).code).not.toBe(0);
  const written = await cli(['account', 'key', 'set', '--revision', String(initial.revision), '--api-key-file', '-', '--model', 'gpt-cli',
    '--session-file', sessionA, '--json'], key + '\n');
  expect(success(written).key).toMatchObject({ configured: true, last4: 'WXYZ', model: 'gpt-cli' });
  expect(written.stdout + written.stderr).not.toContain(key);
  expect(success(await cli(['account', 'key', 'get', '--session-file', sessionB, '--json'])).key.configured).toBe(false);
  const made = success(await cli(['project', 'create', '--name', 'CLI own key', '--session-file', sessionA, '--json']));
  const admitted = success(await cli(['run', 'start', '--project', made.project.id, '--conversation', made.conversationId,
    '--execution-source', 'personal_api_key', '--prompt-file', '-', '--session-file', sessionA, '--json'], 'Own key CLI prompt'));
  const watched = await cli(['run', 'watch', admitted.runId, '--session-file', sessionA, '--json']);
  expect(watched.code, watched.stderr).toBe(0);
  expect(watched.stdout).toContain('CLI company completed.');
  expect(watched.stdout).not.toContain(key);
  const info = success(await cli(['run', 'info', admitted.runId, '--session-file', sessionA, '--json']));
  expect(JSON.stringify(info)).toContain('personal_api_key');
  const automation = success(await cli(['automation', 'create', '--name', 'CLI own-key routine', '--agent', 'openai-byok',
    '--prompt-file', '-', '--schedule', 'daily:09:00', '--session-file', sessionA, '--json'], 'Own-key automation prompt'));
  const routineId = automation.routine.id as string;
  expect(automation.routine.agentId).toBe('openai-byok');
  expect(success(await cli(['automation', 'update', routineId, '--name', 'Renamed own-key routine', '--session-file', sessionA, '--json'])).routine.agentId).toBe('openai-byok');
  expect(success(await cli(['automation', 'update', routineId, '--agent', 'openai', '--session-file', sessionA, '--json'])).routine.agentId).toBe('openai');
  expect(success(await cli(['automation', 'update', routineId, '--agent', 'openai-byok', '--session-file', sessionA, '--json'])).routine.agentId).toBe('openai-byok');
  expect((await cli(['automation', 'run', routineId, '--session-file', sessionB, '--json'])).code).not.toBe(0);
  const routineRun = success(await cli(['automation', 'run', routineId, '--session-file', sessionA, '--json']));
  expect(routineRun).toMatchObject({ projectId: expect.any(String), conversationId: expect.any(String) });
  const routineCookie = await login(daemon, alice.username, alice.password);
  const routineHistory = await until(() => daemon.request({ path: `/api/routines/${routineId}/runs`, cookie: routineCookie }),
    (result) => result.json.runs[0]?.status === 'succeeded', 'CLI own-key routine');
  expect((await daemon.request({ path: `/api/runs/${routineHistory.json.runs[0].agentRunId}`, cookie: routineCookie })).json.executionSource).toBe('personal_api_key');
  success(await cli(['automation', 'delete', routineId, '--session-file', sessionA, '--json']));
  // An Image project on the CLI: personal Codex is refused, the own-key source is admitted (#63).
  const image = success(await cli(['project', 'create', '--name', 'CLI image', '--kind', 'image', '--session-file', sessionA, '--json']));
  expect(image.project.metadata.kind).toBe('image');
  expect((await cli(['run', 'start', '--project', image.project.id, '--conversation', image.conversationId, '--execution-source', 'personal_subscription',
    '--prompt-file', '-', '--session-file', sessionA, '--json'], 'Image via Codex')).code).not.toBe(0);
  success(await cli(['run', 'start', '--project', image.project.id, '--conversation', image.conversationId, '--execution-source', 'personal_api_key',
    '--prompt-file', '-', '--session-file', sessionA, '--json'], 'Image via own key'));
  const current = success(await cli(['account', 'key', 'get', '--session-file', sessionA, '--json'])).key;
  expect(success(await cli(['account', 'key', 'remove', '--revision', String(current.revision), '--session-file', sessionA, '--json'])).key)
    .toMatchObject({ configured: false, last4: null });
}, 40_000);

it('stores the account Tavily key through stdin and runs od research search on it only (#63)', async () => {
  const sessionA = path.join(root, 'cli-key-a-session'); const sessionB = path.join(root, 'cli-key-b-session');
  const key = 'tvly-cli-account-research-key-0123ABCD';
  const missing = await cli(['research', 'search', '--query', 'cli query', '--session-file', sessionB, '--json']);
  expect(missing.code).not.toBe(0);
  expect(missing.stderr).toContain('MULTIUSER_PROVIDER_KEY_MISSING');
  const initial = success(await cli(['account', 'key', 'get', '--provider', 'tavily', '--session-file', sessionA, '--json'])).key;
  expect(initial).toMatchObject({ provider: 'tavily', configured: false, model: '' });
  expect((await cli(['account', 'key', 'set', '--provider', 'tavily', '--model', 'x', '--revision', '0', '--api-key-file', '-',
    '--session-file', sessionA, '--json'], key + '\n')).code).not.toBe(0);
  const written = await cli(['account', 'key', 'set', '--provider', 'tavily', '--revision', String(initial.revision), '--api-key-file', '-',
    '--session-file', sessionA, '--json'], key + '\n');
  expect(success(written).key).toMatchObject({ provider: 'tavily', configured: true, last4: 'ABCD' });
  expect(written.stdout + written.stderr).not.toContain(key);
  const found = await cli(['research', 'search', '--query', 'cli query', '--max-sources', '3', '--session-file', sessionA, '--json']);
  expect(found.code, found.stderr).toBe(0);
  expect(JSON.parse(found.stdout)).toMatchObject({ query: 'cli query', provider: 'tavily', summary: 'CLI research summary',
    sources: [{ url: 'https://example.test/cli' }] });
  expect(found.stdout).not.toContain(key);
  expect(success(await cli(['account', 'key', 'get', '--provider', 'tavily', '--session-file', sessionB, '--json'])).key.configured).toBe(false);
}, 40_000);

it('publishes, lists and revokes a deployment-local public link through od project', async () => {
  const session = path.join(root, 'cli-public-session');
  success(await cli(['session', 'login', '--daemon-url', daemon.baseUrl, '--username', alice.username,
    '--password-file', '-', '--session-file', session, '--json'], alice.password + '\n'));
  const made = success(await cli(['project', 'create', '--name', 'CLI public', '--session-file', session, '--json']));
  const id = made.project.id;
  // Earlier cases revoke alice's harness cookie; write through a fresh session.
  const cookie = await login(daemon, alice.username, alice.password);
  expect((await daemon.request({ method: 'POST', path: `/api/projects/${id}/files`, cookie, body: { name: 'page.html', content: '<h1>Public CLI</h1>' } })).status).toBe(200);
  const published = success(await cli(['project', 'publish-public-link', id, '--path', 'page.html', '--session-file', session, '--json']));
  expect(published).toMatchObject({ fileName: 'page.html' });
  expect(published.url).toMatch(/\/api\/multiuser\/public\/[A-Za-z0-9_-]{32}\/page\.html$/);
  expect(success(await cli(['project', 'public-links', id, '--session-file', session, '--json'])).links).toHaveLength(1);
  expect(success(await cli(['project', 'revoke-public-link', id, '--path', 'page.html', '--url', published.url, '--session-file', session, '--json'])))
    .toMatchObject({ ok: true, slug: published.slug });
  expect(success(await cli(['project', 'public-links', id, '--session-file', session, '--json'])).links).toEqual([]);
});

it('edits account instructions and manual profile through stdin and isolates B', async () => {
  const first = path.join(root, 'cli-settings-a'); const second = path.join(root, 'cli-settings-b');
  for (const [user, file] of [[alice, first], [bob, second]] as const) {
    success(await cli(['session', 'login', '--daemon-url', daemon.baseUrl, '--username', user.username,
      '--password-file', '-', '--session-file', file, '--json'], user.password + '\n'));
  }
  expect(success(await cli(['config', 'set', 'customInstructions', '--prompt-file', '-', '--session-file', first, '--json'], 'CLI_INSTRUCTIONS\nsecond line')))
    .toMatchObject({ customInstructions: 'CLI_INSTRUCTIONS\nsecond line' });
  expect(success(await cli(['config', 'get', 'customInstructions', '--session-file', second, '--json']))).toBe('');
  expect((await cli(['config', 'set', 'agentCliEnv', '--value-json', '{}', '--session-file', first, '--json'])).code).not.toBe(0);
  const notifications = { soundEnabled: true, desktopEnabled: false, successSoundId: 'chime', failureSoundId: 'thud' };
  expect(success(await cli(['config', 'set', 'notifications', '--value-json', JSON.stringify(notifications), '--session-file', first, '--json'])).notifications).toEqual(notifications);
  expect(success(await cli(['config', 'get', 'notifications', '--session-file', second, '--json'])).soundEnabled).toBe(false);
  expect(success(await cli(['config', 'set', 'accentColor', '#1A74FF', '--session-file', first, '--json'])).accentColor).toBe('#1a74ff');
  expect(success(await cli(['config', 'unset', 'notifications', '--session-file', first, '--json'])).notifications.soundEnabled).toBe(false);
  expect(success(await cli(['config', 'unset', 'accentColor', '--session-file', first, '--json'])).accentColor).toBe('#353535');
  expect((await cli(['config', 'set', 'locale', 'zh-TW', '--session-file', first, '--json'])).code).not.toBe(0);
  const profile = success(await cli(['memory', 'profile', 'set', '--prompt-file', '-', '--session-file', first, '--json'], '- Role: CLI_PROFILE_ORIGINAL'));
  expect(profile.body).toContain('CLI_PROFILE_ORIGINAL');
  expect(success(await cli(['memory', 'tree', 'list', '--session-file', first, '--json'])).tree.some((node: { id: string }) => node.id === 'user_profile')).toBe(true);
  const edited = success(await cli(['memory', 'tree', 'edit', 'user_profile', '--prompt-file', '-', '--session-file', first, '--json'], '- Role: CLI_PROFILE_EDITED'));
  expect(edited.entry.body).toContain('CLI_PROFILE_EDITED');
  expect((await cli(['memory', 'tree', 'view', 'user_profile', '--session-file', second, '--json'])).code).not.toBe(0);
  expect(success(await cli(['config', 'unset', 'customInstructions', '--session-file', first, '--json']))).toMatchObject({ customInstructions: '' });
}, 40_000);


it('creates, edits, reads and deletes private DESIGN.md through stdin on the standard APIs', async () => {
  const first = path.join(root, 'cli-design-a'); const second = path.join(root, 'cli-design-b');
  for (const [user, file] of [[alice, first], [bob, second]] as const) {
    success(await cli(['session', 'login', '--daemon-url', daemon.baseUrl, '--username', user.username,
      '--password-file', '-', '--session-file', file, '--json'], user.password + '\n'));
  }
  const created = success(await cli(['design-systems', 'create', '--title', 'CLI document', '--prompt-file', '-', '--session-file', first, '--json'], '# CLI DESIGN ORIGINAL'));
  const id = created.designSystem.id;
  expect(created.designSystem.body).toBe('# CLI DESIGN ORIGINAL');
  expect((await cli(['design-systems', 'show', id, '--session-file', second, '--json'])).code).not.toBe(0);
  expect(success(await cli(['design-systems', 'update', id, '--prompt-file', '-', '--session-file', first, '--json'], '# CLI DESIGN EDITED')).designSystem.body).toBe('# CLI DESIGN EDITED');
  expect(success(await cli(['design-systems', 'show', id, '--session-file', first, '--json'])).designSystem.body).toBe('# CLI DESIGN EDITED');
  expect(success(await cli(['design-systems', 'delete', id, '--session-file', first, '--json']))).toEqual({ ok: true });
  expect((await cli(['design-systems', 'show', id, '--session-file', first, '--json'])).code).not.toBe(0);
}, 40_000);
