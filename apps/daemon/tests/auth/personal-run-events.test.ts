import { expect, it } from 'vitest';
import type { ChatSseEvent } from '@open-design/contracts';
import { PersonalRunEvents } from '../../src/runtimes/personal-run-events.js';

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
  for (let n = 0; n < 2100; n++) boundary.accept({ type: 'status', label: 'running' });
  expect(boundary.truncated).toBe(true);
  expect(boundary.text.at(-1)).toBe('界');
  expect(Buffer.byteLength(boundary.text)).toBeLessThanOrEqual(512 * 1024);
  expect(frames.length).toBeLessThanOrEqual(2050);
  expect(frames.filter((e) => e.event === 'diagnostic' && e.data.type === 'personal_event_budget')).toHaveLength(1);
  expect(frames.every((e) => Buffer.byteLength(JSON.stringify(e)) <= 16 * 1024)).toBe(true);
});

it('omits bare and quoted environment assignments even when their names have no secret suffix', () => {
  const frames: ChatSseEvent[] = [];
  const boundary = new PersonalRunEvents('/workspace', [], (event) => frames.push(event));
  boundary.accept({ type: 'text_delta', delta: 'HOME=PRIVATE_ENV TOKEN="PRIVATE_ENV with spaces" LANG=PRIVATE_ENV\nDone' });
  boundary.flush();
  expect(JSON.stringify(frames).includes('PRIVATE_ENV')).toBe(false);
  expect(boundary.text).toContain('Done');
});
