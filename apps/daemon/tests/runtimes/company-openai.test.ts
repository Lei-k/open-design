import { mkdtemp, mkdir, readFile, rm, symlink, link, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { CompanyOpenAIWorker, runCompanyOpenAITurn } from '../../src/runtimes/company-openai.js';
import { captureStudioSkill } from '../../src/services/studio-skill-packages.js';

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

it('checks withdrawn authority after provider completion before executing a queued file tool', async () => {
  let allowed = true;
  const fetcher: typeof fetch = async () => { allowed = false; return completed([call('write_project_file', { path: 'late.html', content: 'late' }, 'late')]); };
  await expect(turn(fetcher, { authorized: () => allowed })).rejects.toThrow('company_authority_changed');
  await expect(readFile(path.join(root, 'owner/late.html'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('fails incomplete streams and does not forward upstream error bodies', async () => {
  await expect(turn(async () => new Response('private provider error', { status: 401 }))).rejects.toThrow('company_provider_failed');
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
  expect(bodies[1]).toContain('SCRIPT_OK');
  expect(bodies[1].match(/PROJECT_TOOL_REFUSED/g)).toHaveLength(2);
  expect(result.files).toEqual(['fonts/brand.woff2']);
  expect(JSON.parse(bodies[0]).tools.map((tool: { name: string }) => tool.name)).toContain('run_skill_script');

  // Without a host script sandbox the tool is neither advertised nor executed.
  scripts.length = 0; bodies.length = 0; request = 0;
  await turn(fetcher, { skillPackages: [captured] });
  expect(JSON.parse(bodies[0]).tools.map((tool: { name: string }) => tool.name)).not.toContain('run_skill_script');
  expect(scripts).toEqual([]);
  expect(bodies[1].match(/PROJECT_TOOL_REFUSED/g)).toHaveLength(3);
});
