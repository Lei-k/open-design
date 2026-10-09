import { mkdtemp, mkdir, readFile, rm, symlink, link, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { CompanyOpenAIWorker, runCompanyOpenAITurn } from '../../src/runtimes/company-openai.js';
import { buildStudioSkillPackage, captureStudioSkill } from '../../src/services/studio-skill-packages.js';
import { captureStudioPluginResources, studioRunResourcePackages } from '../../src/plugins/studio-resources.js';
import { captureStudioPluginSkillContext } from '../../src/plugins/studio-skill-context.js';
import { PersonalRunEvents } from '../../src/runtimes/personal-run-events.js';
import { runSseEventToPersistedAgentEvent } from '../../src/runtimes/chat-run-messages.js';
import { eventsEndedWithUnfinishedWork, isTodoWriteToolName, type InstalledPluginRecord, type PersistedAgentEvent, type ChatSseEvent } from '@open-design/contracts';

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'company-tools-')); await mkdir(path.join(root, 'owner')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const call = (name: string, args: unknown, id: string) => ({ type: 'function_call', name, call_id: id, arguments: JSON.stringify(args) });
function completed(output: unknown[], text = '') {
  const frames = [...(text ? [{ type: 'response.output_text.delta', delta: text }] : []), { type: 'response.completed', response: { output } }];
  const bytes = Buffer.from(frames.map((frame) => `data: ${JSON.stringify(frame)}\r\n\r\n`).join(''));
  // One byte per chunk exercises split CRLF and multibyte UTF-8 decoding.
  return new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } }),
    { headers: { 'content-type': 'text/event-stream' } });
}
function turn(fetcher: typeof fetch, extra = {}) {
  return runCompanyOpenAITurn({ apiKey: 'fixture-private', model: 'fixture-model', systemPrompt: 'core', prompt: 'design', history: [],
    projectsRoot: root, projectId: 'owner', worker: new CompanyOpenAIWorker(), authorized: () => true, onAgentEvent: () => {}, fetch: fetcher, ...extra });
}
it('refuses traversal, external symlinks and unknown tools while preserving valid project files', async () => {
  await writeFile(path.join(root, 'foreign.txt'), 'FOREIGN_PRIVATE_BYTES');
  await mkdir(path.join(root, 'foreign-directory'));
  await writeFile(path.join(root, 'foreign-directory/FORBIDDEN_NAME.txt'), 'FOREIGN_PRIVATE_BYTES');
  await symlink(path.join(root, 'foreign-directory'), path.join(root, 'owner/foreign-directory'));
  await symlink(path.join(root, 'foreign.txt'), path.join(root, 'owner/escape.txt'));
  await link(path.join(root, 'foreign.txt'), path.join(root, 'owner/hardlink.txt'));
  let request = 0; let observed = '';
  const fetcher: typeof fetch = async (_url, init) => {
    if (request++ === 0) return completed([
      call('read_project_file', { path: '../foreign.txt' }, 'traversal'),
      call('read_project_file', { path: 'escape.txt' }, 'read-link'),
      call('write_project_file', { path: 'escape.txt', content: 'changed' }, 'write-link'),
      call('read_project_file', { path: 'hardlink.txt' }, 'hard-read'),
      call('write_project_file', { path: 'hardlink.txt', content: 'changed' }, 'hard-write'),
      call('read_project_file', { path: 'foreign-directory/FORBIDDEN_NAME.txt' }, 'parent-read'),
      call('write_project_file', { path: 'foreign-directory/FORBIDDEN_NAME.txt', content: 'changed' }, 'parent-write'),
      call('list_project_files', {}, 'list'),
      call('execute_shell', { command: 'cat ../foreign.txt' }, 'shell'),
      call('write_project_file', { path: 'design.html', content: '<h1>Owner</h1>' }, 'valid-write'),
      call('read_project_file', { path: 'design.html' }, 'valid-read'),
    ]);
    observed = String(init?.body);
    return completed([], '完成設計 ✓');
  };
  const events: Record<string, unknown>[] = [];
  const result = await turn(fetcher, { onAgentEvent: (event: Record<string, unknown>) => events.push(event) });
  expect(observed).not.toContain('FOREIGN_PRIVATE_BYTES');
  const listing = JSON.parse(observed).input.find((item: { call_id?: string; type?: string }) => item.call_id === 'list' && item.type === 'function_call_output');
  expect(listing.output).not.toContain('FORBIDDEN_NAME');
  expect(observed.match(/PROJECT_TOOL_REFUSED/g)).toHaveLength(8);
  expect(await readFile(path.join(root, 'foreign.txt'), 'utf8')).toBe('FOREIGN_PRIVATE_BYTES');
  expect(await readFile(path.join(root, 'owner/design.html'), 'utf8')).toBe('<h1>Owner</h1>');
  expect(result.files).toEqual(['design.html']);
  expect(events.find((event) => event.type === 'text_delta')?.delta).toBe('完成設計 ✓');
});
it('reads only selected immutable skill resources without opening a host skill path', async () => {
  const resources = path.join(root, 'bundled'); const folder = path.join(resources, 'selected');
  await mkdir(path.join(folder, 'references'), { recursive: true });
  await writeFile(path.join(folder, 'SKILL.md'), '---\nname: selected\n---\nFollow references/rules.md');
  await writeFile(path.join(folder, 'references/rules.md'), 'CAPTURED_SKILL_REFERENCE');
  const captured = captureStudioSkill(resources, folder, 'selected').package;
  await writeFile(path.join(folder, 'references/rules.md'), 'LIVE_REPLACEMENT');
  let request = 0; let observed = '';
  const fetcher: typeof fetch = async (_url, init) => {
    if (request++ === 0) return completed([
      call('list_skill_files', {}, 'list-skills'),
      call('read_skill_file', { skillId: 'selected', path: 'references/rules.md' }, 'selected-reference'),
      call('read_skill_file', { skillId: 'foreign', path: 'references/rules.md' }, 'foreign-reference'),
      call('read_skill_file', { skillId: 'selected', path: '../foreign.txt' }, 'traversal'),
    ]);
    observed = String(init?.body); return completed([], 'Used the captured reference.');
  };
  await turn(fetcher, { skillPackages: [captured] });
  expect(observed).toContain('CAPTURED_SKILL_REFERENCE');
  expect(observed).not.toContain('LIVE_REPLACEMENT');
  expect(observed).not.toContain(folder);
  expect(observed.match(/PROJECT_TOOL_REFUSED/g)).toHaveLength(2);
});

it.each(['company_pool', 'personal_api_key'])('reads and copies the applied plugin capture on %s after bundled files disappear', async (source) => {
  const folder = path.join(root, 'bundled-plugin'); await mkdir(folder);
  const binary = Buffer.from([0, 255, 128, 1]);
  await writeFile(path.join(folder, 'SKILL.md'), 'Use example.html and font.woff2');
  await writeFile(path.join(folder, 'example.html'), '<h1>CAPTURED_PLUGIN_ASSET</h1>');
  await writeFile(path.join(folder, 'font.woff2'), binary);
  const captured = captureStudioPluginResources({ id: 'plugin-fixture', version: '1.0.0', fsPath: folder,
    manifest: { name: 'plugin-fixture', version: '1.0.0', od: { context: {
      skills: [{ path: './SKILL.md' }], assets: ['./example.html', './font.woff2'] } } } } as InstalledPluginRecord);
  await rm(folder, { recursive: true });
  const resourceId = captured.package!.id;
  const skillPackages = studioRunResourcePackages({ pluginSnapshot: { resourcePackage: captured.package } });
  let request = 0; let observed = '';
  const fetcher: typeof fetch = async (_url, init) => {
    if (request++ === 0) return completed([
      call('list_skill_files', {}, 'list-plugin'),
      call('read_skill_file', { skillId: resourceId, path: 'example.html' }, 'read-plugin'),
      call('copy_skill_file', { skillId: resourceId, path: 'font.woff2', destination: 'fonts/plugin.woff2' }, 'copy-plugin'),
      call('read_skill_file', { skillId: 'unapplied-plugin', path: 'example.html' }, 'foreign-plugin'),
    ]);
    observed = String(init?.body); return completed([], 'Used the captured plugin.');
  };
  const result = await turn(fetcher, { apiKey: `${source}-fixture-secret`, skillPackages });
  expect(observed).toContain('CAPTURED_PLUGIN_ASSET'); expect(observed).not.toContain(folder);
  expect(observed.match(/PROJECT_TOOL_REFUSED/g)).toHaveLength(1);
  expect(await readFile(path.join(root, 'owner/fonts/plugin.woff2'))).toEqual(binary);
  expect(result.files).toEqual(['fonts/plugin.woff2']);
});

it.each(['company_pool', 'personal_api_key'])('uses captured referenced skill files through plugin tools on %s', async (source) => {
  const id = 'studio-skill:shared-fixture'; const binary = Buffer.from([0, 255, 127, 128]);
  const referenced = captureStudioPluginSkillContext({ id, name: 'Shared fixture', source: 'user', body: 'REFERENCED_SKILL_BODY',
    package: buildStudioSkillPackage(id, [{ path: 'SKILL.md', bytes: Buffer.from('REFERENCED_SKILL_BODY'), executable: false },
      { path: 'references/rules.md', bytes: Buffer.from('REFERENCED_CAPTURED_RULES'), executable: false },
      { path: 'assets/font.woff2', bytes: binary, executable: false },
      { path: 'scripts/build.py', bytes: Buffer.from('print("captured")'), executable: false }]) });
  const captured = captureStudioPluginResources({ id: 'ref-plugin', version: '1.0.0',
    manifest: { name: 'ref-plugin', version: '1.0.0', od: { context: { skills: [{ ref: id }] } } } } as InstalledPluginRecord, referenced.files);
  const resource = captured.package!; const prefix = referenced.files[0]!.name.slice(0, -'SKILL.md'.length);
  let request = 0; let observed = ''; const scripts: unknown[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    if (request++ === 0) return completed([
      call('read_skill_file', { skillId: resource.id, path: `${prefix}references/rules.md` }, 'ref-read'),
      call('copy_skill_file', { skillId: resource.id, path: `${prefix}assets/font.woff2`, destination: 'fonts/referenced.woff2' }, 'ref-copy'),
      call('run_skill_script', { skillId: resource.id, path: `${prefix}scripts/build.py`, args: ['out.html'] }, 'ref-script'),
      call('read_skill_file', { skillId: id, path: 'references/rules.md' }, 'live-refused'),
    ]);
    observed = String(init?.body); return completed([], 'Used the captured referenced skill.');
  };
  await turn(fetcher, { apiKey: `${source}-fixture-secret`, skillPackages: studioRunResourcePackages({ pluginSnapshot: { resourcePackage: resource } }),
    runSkillScript: async ({ signal: _signal, ...script }: { skillId: string; path: string; args: string[]; signal: AbortSignal }) => {
      scripts.push(script); return { exitCode: 0, timedOut: false, stdout: 'CAPTURED_SCRIPT_RESULT', stderr: '' };
    } });
  expect(observed).toContain('REFERENCED_CAPTURED_RULES'); expect(observed).toContain('CAPTURED_SCRIPT_RESULT');
  expect(observed.match(/PROJECT_TOOL_REFUSED/g)).toHaveLength(1);
  expect(scripts).toEqual([{ skillId: resource.id, path: `${prefix}scripts/build.py`, args: ['out.html'] }]);
  expect(await readFile(path.join(root, 'owner/fonts/referenced.woff2'))).toEqual(binary);
});

it('checks withdrawn authority after provider completion before executing a queued file tool', async () => {
  let allowed = true;
  const fetcher: typeof fetch = async () => { allowed = false; return completed([call('write_project_file', { path: 'late.html', content: 'late' }, 'late')]); };
  await expect(turn(fetcher, { authorized: () => allowed })).rejects.toThrow('company_authority_changed');
  await expect(readFile(path.join(root, 'owner/late.html'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('fails incomplete streams and does not forward upstream error bodies', async () => {
  // Coarse, secret-free classes only (#62/#63): auth and rate limits are told apart, the body never travels.
  await expect(turn(async () => new Response('private provider error', { status: 401 }))).rejects.toThrow(/^provider_auth_rejected$/);
  await expect(turn(async () => new Response('private provider error', { status: 429 }))).rejects.toThrow(/^provider_rate_limited$/);
  await expect(turn(async () => new Response('private provider error', { status: 500 }))).rejects.toThrow(/^company_provider_failed$/);
  await expect(turn(async () => new Response('data: {"type":"response.output_text.delta","delta":"partial"}\n\n',
    { headers: { 'content-type': 'text/event-stream' } }))).rejects.toThrow('company_response_incomplete');
});
it('copies captured binary resources and runs scripts only through the provided runner', async () => {
  const resources = path.join(root, 'bundled'); const folder = path.join(resources, 'selected');
  await mkdir(path.join(folder, 'assets'), { recursive: true });
  await mkdir(path.join(folder, 'scripts'), { recursive: true });
  await writeFile(path.join(folder, 'SKILL.md'), '---\nname: selected\n---\nRun scripts/build.py');
  const font = Buffer.from([0, 1, 2, 0xff, 0xfe, 0x80]);
  await writeFile(path.join(folder, 'assets/font.woff2'), font);
  await writeFile(path.join(folder, 'scripts/build.py'), 'print("x")');
  const captured = captureStudioSkill(resources, folder, 'selected').package;
  await writeFile(path.join(folder, 'assets/font.woff2'), 'LIVE_REPLACEMENT');
  const scripts: Array<{ skillId: string; path: string; args: readonly string[] }> = [];
  const runner = async (request: { skillId: string; path: string; args: readonly string[] }) => {
    scripts.push({ skillId: request.skillId, path: request.path, args: request.args });
    return { exitCode: 0, timedOut: false, stdout: 'SCRIPT_OK', stderr: '' };
  };
  const bodies: string[] = []; let request = 0;
  const fetcher: typeof fetch = async (_url, init) => {
    bodies.push(String(init?.body));
    if (request++ === 0) return completed([
      call('copy_skill_file', { skillId: 'selected', path: 'assets/font.woff2', destination: 'fonts/brand.woff2' }, 'copy'),
      call('copy_skill_file', { skillId: 'selected', path: 'assets/font.woff2', destination: '../escape.woff2' }, 'copy-escape'),
      call('copy_skill_file', { skillId: 'foreign', path: 'assets/font.woff2', destination: 'foreign.woff2' }, 'copy-foreign'),
      call('run_skill_script', { skillId: 'selected', path: 'scripts/build.py', args: ['--out', 'deck.html'] }, 'run'),
    ]);
    return completed([], 'done');
  };
  const result = await turn(fetcher, { skillPackages: [captured], runSkillScript: runner });
  expect(await readFile(path.join(root, 'owner/fonts/brand.woff2'))).toEqual(font);
  await expect(readFile(path.join(root, 'escape.woff2'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(scripts).toEqual([{ skillId: 'selected', path: 'scripts/build.py', args: ['--out', 'deck.html'] }]);
  expect(bodies[1]!).toContain('SCRIPT_OK');
  expect(bodies[1]!.match(/PROJECT_TOOL_REFUSED/g)).toHaveLength(2);
  expect(result.files).toEqual(['fonts/brand.woff2']);
  expect(JSON.parse(bodies[0]!).tools.map((tool: { name: string }) => tool.name)).toContain('run_skill_script');

  // Without a host script sandbox the tool is neither advertised nor executed.
  scripts.length = 0; bodies.length = 0; request = 0;
  await turn(fetcher, { skillPackages: [captured] });
  expect(JSON.parse(bodies[0]!).tools.map((tool: { name: string }) => tool.name)).not.toContain('run_skill_script');
  expect(scripts).toEqual([]);
  expect(bodies[1]!.match(/PROJECT_TOOL_REFUSED/g)).toHaveLength(3);
});
it.each(['company-pool', 'account-key'])('publishes accepted plans through the same redacted durable todo contract on %s', async (source) => {
  let step = 0;
  const requests: Record<string, any>[] = [];
  const events: ChatSseEvent[] = [];
  const projection = new PersonalRunEvents(path.join(root, 'owner'), [root], (event) => events.push(event), undefined, 'company-pool');
  const fetcher: typeof fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${source}-fixture-secret`);
    if (step++ === 0) return completed([call('update_plan', { todos: [{ content: `Read ${root}/private-input`, status: 'in_progress' },
      { content: 'Write the design', status: 'pending' }] }, 'plan-start')]);
    if (step === 2) return completed([call('update_plan', { todos: [{ content: 'Read the input', status: 'completed' },
      { content: 'Write the design', status: 'completed' }] }, 'plan-finish')]);
    return completed([], 'Done');
  };
  const result = await turn(fetcher, { apiKey: `${source}-fixture-secret`, onAgentEvent: (event: Record<string, unknown>) => projection.accept(event) });
  projection.flush();
  expect(result.files).toEqual([]);
  const tool = requests[0]!.tools.find((entry: { name: string }) => entry.name === 'update_plan');
  expect(tool).toMatchObject({ strict: true, parameters: { required: ['todos'], additionalProperties: false } });
  const durable = events.map((event) => runSseEventToPersistedAgentEvent(event.event, event.data)).filter((event): event is PersistedAgentEvent => event !== null);
  const plans = durable.filter((event) => event.kind === 'tool_use' && isTodoWriteToolName(event.name));
  expect(plans).toHaveLength(2);
  expect(plans[0]).toMatchObject({ input: { todos: [{ content: 'Read [private path]/private-input', status: 'in_progress' },
    { content: 'Write the design', status: 'pending' }] } });
  expect(plans[1]).toMatchObject({ input: { todos: [{ content: 'Read the input', status: 'completed' }, { content: 'Write the design', status: 'completed' }] } });
  expect(eventsEndedWithUnfinishedWork([plans[0]])).toBe(true);
  expect(eventsEndedWithUnfinishedWork(plans)).toBe(false);
  expect(JSON.stringify(durable)).not.toContain(root);
  expect(JSON.stringify(events)).not.toContain(`${source}-fixture-secret`);
  expect(requests[1]!.input).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'function_call_output', call_id: 'plan-start', output: '{"updated":2}' })]));
});
it.each([
  { todos: [{ content: 'Do work', status: 'unknown' }] }, { todos: [{ content: '', status: 'pending' }] },
  { todos: [{ content: 'x'.repeat(201), status: 'pending' }] }, { todos: [{ content: 'Work', status: 'pending', owner: 'other' }] },
  { todos: Array.from({ length: 33 }, () => ({ content: 'Work', status: 'pending' })) }, { todos: [], owner: 'other' },
  { todos: 'not a list' }, { todos: [null] },
  { todos: [{ content: 'Hidden\u0000work', status: 'pending' }] },
  { todos: Array.from({ length: 32 }, () => ({ content: '界'.repeat(200), status: 'pending' })) },
])('refuses invalid plan updates without replacing a previous valid plan: %j', async (invalid) => {
  let step = 0; const events: Record<string, unknown>[] = [];
  const fetcher: typeof fetch = async () => step++ === 0 ? completed([
    call('update_plan', { todos: [{ content: 'Unfinished work', status: 'pending' }] }, 'good'), call('update_plan', invalid, 'bad'),
  ]) : completed([], 'Blocked');
  const result = await turn(fetcher, { onAgentEvent: (event: Record<string, unknown>) => events.push(event) });
  expect(result.input).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'function_call_output', call_id: 'bad', output: '{"error":"PROJECT_TOOL_REFUSED"}' })]));
  expect(events.filter((event) => event.type === 'tool_use' && isTodoWriteToolName(event.name))).toHaveLength(1);
  expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'tool_use', id: 'bad', name: 'plan_update_refused' }),
    expect.objectContaining({ type: 'tool_result', toolUseId: 'bad', isError: true })]));
});
