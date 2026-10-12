import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { workspaceToolsUnavailable, type ChatSseEvent } from '@open-design/contracts';
import { attachCodexAppServerSession } from '../src/agent-protocol/codex-app-server/session.js';
import { PersonalRunEvents } from '../src/runtimes/personal-run-events.js';
type Frame = { method: string; params: Record<string, any> };
const load = (name: string): Frame[] => fs.readFileSync(new URL(`../../../mocks/fixtures/codex-code-mode-host/${name}.jsonl`, import.meta.url), 'utf8')
  .trim().split('\n').map((line) => JSON.parse(line));
const raw = load('rawrun').filter((frame) => frame.method === 'rawResponseItem/completed' && frame.params.item.type.startsWith('custom_tool_call'));
const warning = load('nb').find((frame) => frame.method === 'warning')!;
function replay(reportToolStartupFailures = true, resume = false, tools = true) {
  const stdout = new EventEmitter(); const sent: any[] = []; const events: Record<string, unknown>[] = []; const sse: ChatSseEvent[] = [];
  const projection = new PersonalRunEvents('/workspace', [], (event) => sse.push(event));
  const end = vi.fn(); const terminal = vi.fn();
  const session = attachCodexAppServerSession({ child: { stdout, stdin: {
    write(chunk: string, callback?: (err?: Error | null) => void) { sent.push(JSON.parse(chunk)); callback?.(null); }, end,
  } }, prompt: 'write a file', cwd: '/workspace', sandboxMode: 'danger-full-access', reportToolStartupFailures,
    resumeSessionId: resume ? 'fixture-thread' : null,
    ...(tools ? { dynamicTools: [], onDynamicToolCall: () => ({}) } : {}), onTurnComplete: terminal,
    onAgentEvent: (event) => { events.push(event); projection.accept(event); },
  });
  const say = (frame: unknown) => stdout.emit('data', JSON.stringify(frame) + '\n');
  say({ id: sent[0].id, result: { userAgent: 'codex/0.162.1' } });
  const open = sent.find((frame) => frame.method === (resume ? 'thread/resume' : 'thread/start'));
  say({ id: open.id, result: { thread: { id: 'fixture-thread', cwd: '/workspace' } } });
  const started = load('rawrun')[0]!;
  const complete = load('rawrun').at(-1)!;
  const outcome = (files = 0, artifacts = 0) => session.completedSuccessfully()
    && !workspaceToolsUnavailable(projection.toolStartupFailed, files, artifacts) ? 'succeeded' : 'failed';
  return { say, open, sent, started, complete, projection, events, sse, end, terminal, outcome };
}
describe('native Codex 0.162.1 code-mode-host evidence', () => {
  it('negotiates experimentalApi for personal startup evidence independently of dynamic tools', () => {
    expect(replay(true, false, false).sent[0].params.capabilities.experimentalApi).toBe(true);
    expect(replay(false, false, false).sent[0].params.capabilities.experimentalApi).toBe(false);
  });
  it.each([false, true])('opts into raw Responses items on personal start/resume (resume=%s)', (resume) => {
    const h = replay(true, resume);
    expect(h.sent[0].params.capabilities.experimentalApi).toBe(true);
    expect(h.open.params.experimentalRawEvents).toBe(true);
    expect(replay(false, resume).open.params).not.toHaveProperty('experimentalRawEvents');
  });
  it.each(['nb', 'nbw', 'rawrun', 'ok', 'sb'])('replays captured %s through session, normalizer and privacy boundary', (name) => {
    const h = replay(); const frames = load(name);
    for (const frame of frames) h.say(frame);
    h.say(frames.at(-1)); // A duplicate terminal must not finalize twice.
    h.projection.flush();
    expect(h.outcome()).toBe(['ok', 'sb'].includes(name) ? 'succeeded' : 'failed');
    expect(h.terminal).toHaveBeenCalledTimes(1); expect(h.end).toHaveBeenCalledTimes(1);
    expect(h.projection.text).toBe('Done.'); // Raw assistant items must not duplicate text.
    expect(JSON.stringify(h.events)).not.toContain('codex-code-mode-host');
    expect(JSON.stringify(h.sse)).not.toContain('codex-code-mode-host');
    expect(JSON.stringify(h.sse)).not.toContain('/private-release');
    expect(h.events.some((event) => String(event.type).startsWith('raw'))).toBe(false);
  });
  it('documents the native non-ELF blind spot without raw events', () => {
    const h = replay(); for (const frame of load('badrun')) h.say(frame);
    expect(h.outcome()).toBe('succeeded'); expect(h.projection.toolStartupFailed).toBe(false);
  });
  it('deduplicates warning plus raw evidence without a tool row', () => {
    const h = replay(); h.say(warning); h.say(h.started);
    for (const frame of raw) { h.say(frame); h.say(frame); }
    h.say(h.complete);
    expect(h.events.filter((event) => event.type === 'workspace_code_mode_host_failure')).toHaveLength(1);
    expect(h.events.some((event) => event.type === 'tool_result')).toBe(false);
  });
  it.each(['nb', 'rawrun'])('desktop default ignores startup evidence from %s', (name) => {
    const h = replay(false); for (const frame of load(name)) h.say(frame);
    expect(h.outcome()).toBe('succeeded'); expect(h.projection.toolStartupFailed).toBe(false);
  });
  it.each(['custom', 'function', 'wait'])('correlates the raw %s call/output variant', (kind) => {
    const h = replay(); h.say(h.started);
    const call = structuredClone(raw[0]!); const output = structuredClone(raw[1]!);
    if (kind === 'function') { call.params.item.type = 'function_call'; output.params.item.type = 'function_call_output'; }
    if (kind === 'wait') call.params.item.name = 'wait';
    h.say(call); h.say(output); h.say(h.complete);
    expect(h.outcome()).toBe('failed');
    expect(h.events.filter((event) => event.type === 'workspace_code_mode_host_failure')).toHaveLength(1);
    expect(h.outcome(1)).toBe('succeeded'); expect(h.outcome(0, 1)).toBe('succeeded');
  });
  it.each(['foreign thread', 'foreign turn', 'unmatched output', 'wrong call id', 'other namespace', 'other tool',
    'ordinary output', 'array output', 'raw message', 'started frame', 'duplicate output', 'after terminal'])('filters %s raw evidence', (kind) => {
    const h = replay(); h.say(h.started);
    const call = structuredClone(raw[0]!); const output = structuredClone(raw[1]!);
    if (kind === 'foreign thread') output.params.threadId = 'foreign';
    if (kind === 'foreign turn') output.params.turnId = 'foreign';
    if (kind === 'wrong call id') output.params.item.call_id = 'unmatched';
    if (kind === 'other namespace') call.params.item.namespace = 'other';
    if (kind === 'other tool') call.params.item.name = 'read';
    if (kind === 'ordinary output') output.params.item.output = 'command exited with code 1';
    if (kind === 'array output') output.params.item.output = [{ type: 'input_text', text: output.params.item.output }];
    if (kind === 'raw message') output.params.item = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: output.params.item.output }] };
    if (kind === 'started frame') output.method = 'rawResponseItem/started';
    if (kind !== 'unmatched output') h.say(call);
    if (kind === 'after terminal') h.say(h.complete);
    if (kind === 'duplicate output') {
      h.say({ ...output, params: { ...output.params, item: { ...output.params.item, output: 'successful output' } } });
    }
    h.say(output); h.say(h.complete);
    expect(h.outcome()).toBe('succeeded'); expect(h.projection.toolStartupFailed).toBe(false);
  });
  it.each(['foreign thread', 'after terminal', 'ordinary warning'])('filters %s warning', (kind) => {
    const h = replay(); const frame = structuredClone(warning);
    if (kind === 'foreign thread') frame.params.threadId = 'foreign';
    if (kind === 'ordinary warning') frame.params.message = 'A different tool is unavailable';
    if (kind === 'after terminal') { h.say(h.started); h.say(h.complete); }
    h.say(frame); h.say(h.started); h.say(h.complete);
    expect(h.projection.toolStartupFailed).toBe(false);
  });
  it('drops all raw provider payloads, including secret and instruction content', () => {
    const h = replay(); h.say(h.started);
    for (const method of ['rawResponseItem/completed', 'rawResponse/completed', 'rawResponseItem/started']) {
      h.say({ method, params: { threadId: 'fixture-thread', turnId: 'fixture-turn', item: { type: 'message',
        role: 'developer', content: [{ type: 'input_text', text: 'PRIVATE_RAW_TOKEN /private-release/secret' }] }, secret: 'PRIVATE_RAW_TOKEN' } });
    }
    h.say(h.complete); h.projection.flush();
    expect(JSON.stringify(h.events) + JSON.stringify(h.sse)).not.toContain('PRIVATE_RAW_TOKEN');
    expect(h.projection.text).toBe('');
  });
});
