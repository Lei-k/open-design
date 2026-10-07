import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import type { ChatSseEvent, DaemonAgentPayload, PersistedAgentEvent } from '@open-design/contracts';
import { attachCodexAppServerSession } from '../../apps/daemon/src/agent-protocol/codex-app-server/session.js';
import { runPersonalCodexTurn } from '../../apps/daemon/src/services/personal-codex-accounts.js';
import { PersonalRunEvents } from '../../apps/daemon/src/runtimes/personal-run-events.js';
import { runSseEventToPersistedAgentEvent } from '../../apps/daemon/src/runtimes/chat-run-messages.js';
// Load the web modules through their own bundler resolution, as the other
// cross-app oracles do; e2e's NodeNext compiler does not own web source.
const blocksModule = fileURLToPath(new URL('../../apps/web/src/runtime/chat/build-turn-blocks.ts', import.meta.url));
const providerModule = fileURLToPath(new URL('../../apps/web/src/providers/daemon.ts', import.meta.url));
const toolEventsModule = fileURLToPath(new URL('../../apps/web/src/runtime/tool-events.ts', import.meta.url));
const { dedupeToolUsesById, dropSupersededInFlightToolUses } = await import(toolEventsModule) as {
  dedupeToolUsesById(events: PersistedAgentEvent[]): PersistedAgentEvent[];
  dropSupersededInFlightToolUses(events: PersistedAgentEvent[]): PersistedAgentEvent[];
};
const { buildTurnBlocks } = await import(blocksModule) as { buildTurnBlocks(input: { events: PersistedAgentEvent[]; runStatus: string; startedAtMs: number; endedAtMs: number }): unknown[] };
const { translateAgentEvent } = await import(providerModule) as { translateAgentEvent(data: DaemonAgentPayload): PersistedAgentEvent | null };

it('one mock app-server fixture has single-user/personal normalization and live/reloaded ChatPanel parity', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 's3-parity-'));
  const command = [process.execPath, fileURLToPath(new URL('../../mocks/personal-codex-app-server.ts', import.meta.url))] as const;
  for (const dir of ['codex', 'work', 'home', 'tmp']) mkdirSync(path.join(root, dir));
  writeFileSync(path.join(root, 'codex/auth.json'), '{"mock":true}');
  const rawSingle: Record<string, unknown>[] = [];
  const rawPersonal: Record<string, unknown>[] = [];
  const single = spawn(command[0]!, command.slice(1), { cwd: path.join(root, 'work'),
    env: { CODEX_HOME: path.join(root, 'codex'), HOME: path.join(root, 'home') }, stdio: 'pipe' });
  const singleClosed = once(single, 'close');
  const session = attachCodexAppServerSession({ child: single, prompt: '[mock-parity]', cwd: path.join(root, 'work'),
    sandboxMode: 'workspace-write', onAgentEvent: (event) => rawSingle.push(event) });
  const personal = runPersonalCodexTurn({ command, codexHome: path.join(root, 'codex'), home: path.join(root, 'home'),
    temp: path.join(root, 'tmp'), cwd: path.join(root, 'work'), dataRoot: root, prompt: '[mock-parity]',
    sandboxMode: 'workspace-write', resumeThreadId: null, onAgentEvent: (event) => rawPersonal.push(event) });
  const timeout = setTimeout(() => { single.kill('SIGKILL'); personal.child.kill('SIGKILL'); }, 10_000);
  try {
    await singleClosed;
    expect(session.completedSuccessfully()).toBe(true);
    expect((await personal.done).ok).toBe(true);
    // Native thread identity is per launch; all semantic event content is identical.
    const normalizeIdentity = (events: Record<string, unknown>[]) => events.map((event) => ({ ...event,
      ...(event.sessionId ? { sessionId: 'thread' } : {}),
      ...(event.startedAt ? { startedAt: 100 } : {}), ...(event.completedAt ? { completedAt: 200 } : {}),
    }));
    const singleEvents = normalizeIdentity(rawSingle);
    const personalEvents = normalizeIdentity(rawPersonal);
    expect(JSON.stringify(personalEvents) === JSON.stringify(singleEvents)).toBe(true);
    expect(JSON.stringify(singleEvents).includes('FAKE_S3_SECRET')).toBe(true);
    const project = (events: Record<string, unknown>[]) => {
      const frames: ChatSseEvent[] = [];
      const boundary = new PersonalRunEvents(path.join(root, 'work'), [root], (event) => frames.push(event), { now: () => 100 });
      for (const event of events) boundary.accept(event);
      boundary.flush(); return frames;
    };
    const expected = project(singleEvents); const actual = project(personalEvents);
    expect(actual).toEqual(expected);
    expect(JSON.stringify(actual).includes('FAKE_S3_SECRET')).toBe(false);
    const agent = actual.flatMap((event) => event.event === 'agent' ? [event.data] : []);
    for (const type of ['status', 'thinking_delta', 'text_delta', 'tool_use', 'tool_result', 'usage']) expect(agent.some((event) => event.type === type)).toBe(true);
    const tools = agent.flatMap((event) => event.type === 'tool_use' ? [event.name] : []);
    expect(tools).toEqual(expect.arrayContaining(['TodoWrite', 'Bash', 'Write', 'mcp__fixture__lookup', 'web_search']));
    const live = agent.map(translateAgentEvent).filter((event) => event !== null);
    const reloaded = actual.map((event) => runSseEventToPersistedAgentEvent(event.event, event.data)).filter((event) => event !== null);
    const blocks = (events: typeof reloaded) => buildTurnBlocks({ events: dedupeToolUsesById(dropSupersededInFlightToolUses(events)), runStatus: 'succeeded', startedAtMs: 0, endedAtMs: 1000 });
    expect(blocks(live)).toEqual(blocks(reloaded));
    for (let end = 1; end <= actual.length; end++) {
      const prefix = actual.slice(0, end);
      const livePrefix = prefix.flatMap((event) => event.event === 'agent' ? [translateAgentEvent(event.data)] : []).filter((event) => event !== null);
      const storedPrefix = prefix.map((event) => runSseEventToPersistedAgentEvent(event.event, event.data)).filter((event) => event !== null);
      expect(blocks(livePrefix)).toEqual(blocks(storedPrefix));
    }
    expect(blocks(reloaded)).toEqual(blocks(expected.map((event) => runSseEventToPersistedAgentEvent(event.event, event.data)).filter((event) => event !== null)));
  } finally {
    clearTimeout(timeout);
    if (single.exitCode === null && single.signalCode === null) single.kill('SIGKILL');
    if (personal.child.exitCode === null && personal.child.signalCode === null) personal.child.kill('SIGKILL');
    await Promise.allSettled([singleClosed, personal.done]);
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
