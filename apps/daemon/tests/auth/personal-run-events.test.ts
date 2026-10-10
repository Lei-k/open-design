import { expect, it } from 'vitest';
import { emittedRenderableQuestionForm, workspaceToolsUnavailable, type ChatSseEvent } from '@open-design/contracts';
import { PersonalRunEvents } from '../../src/runtimes/personal-run-events.js';

const mcpStartup = { type: 'workspace_tool_startup_failure', server: 'fixture', scope: 'turn-1' };
const mcpAttempt = { type: 'workspace_tool_failed_attempt', server: 'fixture', scope: 'turn-1' };
it.each([
  ['text-only with unused failed MCP', [mcpStartup], 0, 0, false],
  ['question with unused failed MCP', [mcpStartup, { type: 'text_delta', delta: '<question-form id="q">' }], 0, 0, false],
  ['attempted failed MCP', [mcpStartup, mcpAttempt], 0, 0, true],
  ['startup reported after attempt', [mcpAttempt, mcpStartup], 0, 0, true],
  ['a different MCP was attempted', [mcpStartup, { ...mcpAttempt, server: 'fixture__other' }], 0, 0, false],
  ['an unused warning in another app-server turn', [mcpStartup, { ...mcpAttempt, scope: 'turn-2' }], 0, 0, false],
  ['ordinary MCP error', [mcpAttempt, { type: 'tool_result', toolUseId: 'lookup', isError: true, content: 'timeout' }], 0, 0, false],
  ['successful MCP use after startup warning', [mcpStartup, { type: 'tool_result', toolUseId: 'lookup', isError: false, content: 'answer' }], 0, 0, false],
  ['failed workspace spawn', [{ type: 'tool_result', toolUseId: 'exec', startupFailed: true }], 0, 0, true],
  ['later changed file', [mcpStartup, mcpAttempt], 1, 0, false],
  ['later artifact', [mcpStartup, mcpAttempt], 0, 1, false],
] as const)('Studio delivery rule: %s', (_label, events, files, artifacts, unavailable) => {
  const frames: ChatSseEvent[] = [];
  const boundary = new PersonalRunEvents('/workspace', [], (event) => frames.push(event));
  for (const event of events) boundary.accept(event);
  expect(workspaceToolsUnavailable(boundary.toolStartupFailed, files, artifacts)).toBe(unavailable);
  expect(frames.some((event) => event.event === 'agent' && event.data.type === 'tool_result' && event.data.toolUseId === 'mcp-startup')).toBe(false);
});

it('drops hostile tool arguments/output with a typed privacy marker and keeps safe identity and file metadata', () => {
  const frames: ChatSseEvent[] = [];
  const boundary = new PersonalRunEvents('/workspace', ['/host/private'], (event) => frames.push(event));
  const hostile = 'FAKE_S3_SECRET HOME=/host/private API_TOKEN=FAKE_S3_SECRET';
  boundary.accept({ type: 'tool_use', id: 'cmd', name: 'Bash', input: { command: hostile, env: { TOKEN: hostile } }, startedAt: 10 });
  boundary.accept({ type: 'tool_result', toolUseId: 'cmd', content: hostile, completedAt: 20 });
  boundary.accept({ type: 'tool_use', id: 'file', name: 'Write', input: { file_path: '/workspace/index.html', content: hostile } });
  expect(JSON.stringify(frames).includes('FAKE_S3_SECRET')).toBe(false);
  expect(JSON.stringify(frames).includes('/host/private')).toBe(false);
  expect(frames[0]).toMatchObject({ event: 'agent', data: { id: 'cmd', name: 'Bash', input: {}, startedAt: 10, redacted: { policy: 'personal-subscription' } } });
  expect(frames[1]).toMatchObject({ data: { toolUseId: 'cmd', completedAt: 20, redacted: { fields: ['content'] } } });
  expect(frames[2]).toMatchObject({ data: { input: { file_path: 'index.html' } } });
});

it('redacts private paths split across text chunks including a chunk containing an earlier newline', () => {
  const frames: ChatSseEvent[] = [];
  const boundary = new PersonalRunEvents('/workspace', ['/host/private'], (event) => frames.push(event));
  for (const delta of ['Hello\n/ho', 'st/pri', 'vate/auth.json\nDone']) boundary.accept({ type: 'text_delta', delta });
  boundary.flush();
  expect(boundary.text.includes('/host/private')).toBe(false);
  expect(boundary.text).toContain('Hello\n');
  expect(boundary.text).toContain('Done');
});

it('bounds event and aggregate bytes, preserves UTF-8, and records explicit omission markers', () => {
  const frames: ChatSseEvent[] = [];
  const boundary = new PersonalRunEvents('/workspace', [], (event) => frames.push(event));
  boundary.accept({ type: 'text_delta', delta: '界'.repeat(200_000) });
  boundary.flush();
  for (let n = 0; n < 2100; n++) boundary.accept({ type: 'status', label: `running-${n}` });
  expect(boundary.truncated).toBe(true);
  expect(boundary.text.at(-1)).toBe('界');
  expect(Buffer.byteLength(boundary.text)).toBeLessThanOrEqual(512 * 1024);
  expect(frames.length).toBeLessThanOrEqual(2050);
  expect(frames.filter((e) => e.event === 'diagnostic' && e.data.type === 'personal_event_budget')).toHaveLength(1);
  expect(frames.every((e) => Buffer.byteLength(JSON.stringify(e)) <= 16 * 1024)).toBe(true);
});

it('omits run-environment, host-identity and secret-named assignments', () => {
  const frames: ChatSseEvent[] = [];
  const boundary = new PersonalRunEvents('/workspace', [], (event) => frames.push(event));
  boundary.accept({ type: 'text_delta', delta: 'HOME=PRIVATE_ENV TOKEN="PRIVATE_ENV with spaces" USER=PRIVATE_ENV CODEX_HOME: PRIVATE_ENV\nDone' });
  boundary.flush();
  expect(JSON.stringify(frames).includes('PRIVATE_ENV')).toBe(false);
  expect(boundary.text).toContain('Done');
});

it('keeps ordinary code and question-form text while credentials never reach a frame, even split across deltas (#77)', () => {
  const frames: ChatSseEvent[] = [];
  const boundary = new PersonalRunEvents('/workspace', ['/srv/od-data'], (event) => frames.push(event));
  const ordinary = [
    'Set WIDTH=1440 and HEIGHT = 900 for the hero.',
    'const API_URL = "https://api.example.com/v1"; const MAX_ITEMS=50;',
    'LANG=en_US.UTF-8 NODE_ENV=production DEBUG=false max_tokens=1024 token_count = 3 key="id"',
    'The bearer token is described in the guide; use sk-learn for the model.',
    '<question-form id="brief" title="Brief">{"questions":[{"id":"size","label":"Canvas WIDTH=1440?","type":"text"},{"id":"password","label":"API token: optional","type":"text"}]}</question-form>',
  ].join('\n') + '\n';
  const secrets = [
    'OPENAI_API_KEY=FAKE77_sk_value', 'export GITHUB_TOKEN="FAKE77 quoted token"', 'db_password = \'FAKE77pw\'',
    'Authorization: Bearer FAKE77abcdefghijklmnop', 'key sk-FAKE77abcdefghijklmnopqrstu', 'HOME=/srv/od-data/FAKE77',
    'AWS_SECRET_ACCESS_KEY: FAKE77aws', 'ghp_FAKE77abcdefghijklmnopqrstuvwxyz0123',
  ].join('\n') + '\n';
  const all = ordinary + secrets;
  // Every split position must still scrub: deltas are buffered through a complete line.
  for (let n = 0; n < all.length; n += 7) boundary.accept({ type: 'text_delta', delta: all.slice(n, n + 7) });
  boundary.flush();
  expect(boundary.text.startsWith(ordinary)).toBe(true);
  expect(emittedRenderableQuestionForm(boundary.text)).toBe(true);
  expect(JSON.stringify(frames).includes('FAKE77')).toBe(false);
  expect(frames.filter((e) => e.event === 'agent' && 'redacted' in e.data && e.data.redacted)).not.toHaveLength(0);
});

it('coalesces information-free repeats so running-command updates never spend the event budget (#76)', () => {
  const frames: ChatSseEvent[] = [];
  const boundary = new PersonalRunEvents('/workspace', [], (event) => frames.push(event));
  // 250ms running-command updates differ only in fields the privacy policy drops.
  for (let n = 0; n < 3000; n++) {
    for (const id of ['cmd-a', 'cmd-b']) boundary.accept({ type: 'tool_in_flight', id, name: 'Bash', input: { command: 'build' }, output: `line ${n}`, startedAt: 10 });
  }
  boundary.accept({ type: 'status', label: 'running' });
  boundary.accept({ type: 'status', label: 'running' });
  boundary.accept({ type: 'text_delta', delta: 'Final reply\n' });
  boundary.flush();
  expect(boundary.truncated).toBe(false);
  expect(frames.filter((e) => e.event === 'agent' && e.data.type === 'tool_in_flight').map((e) => (e.data as { id: string }).id)).toEqual(['cmd-a', 'cmd-b']);
  expect(frames.filter((e) => e.event === 'agent' && e.data.type === 'status')).toHaveLength(1);
  expect(boundary.text).toBe('Final reply\n');
});

it('splits escape-heavy text below the per-event limit without losing any of it (#76)', () => {
  const frames: ChatSseEvent[] = [];
  const boundary = new PersonalRunEvents('/workspace', [], (event) => frames.push(event));
  const text = `${'"\\'.repeat(20_000)}${'\u0001'.repeat(9_000)}界\n`;
  boundary.accept({ type: 'text_delta', delta: text });
  boundary.flush();
  expect(boundary.truncated).toBe(false);
  expect(boundary.text).toBe(text);
  expect(frames.every((e) => Buffer.byteLength(JSON.stringify(e)) <= 16 * 1024)).toBe(true);
});

it('buffers long newline-free text in near-linear time (#76)', () => {
  const frames: ChatSseEvent[] = [];
  const boundary = new PersonalRunEvents('/workspace', [], (event) => frames.push(event));
  const started = performance.now();
  for (let n = 0; n < 120_000; n++) boundary.accept({ type: 'text_delta', delta: 'abcd' });
  boundary.flush();
  expect(performance.now() - started).toBeLessThan(1_500);
  expect(boundary.text).toBe('abcd'.repeat(120_000));
});
