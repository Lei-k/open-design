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
  // The oracle below reads the app-server protocol itself, not either pipeline's output.
  let wire = '';
  single.stdout.on('data', (chunk: Buffer) => { wire += chunk.toString('utf8'); });
  const singleClosed = once(single, 'close');
  const session = attachCodexAppServerSession({ child: single, prompt: '[mock-parity]', cwd: path.join(root, 'work'),
    sandboxMode: 'workspace-write', onAgentEvent: (event) => rawSingle.push(event) });
  const personal = await runPersonalCodexTurn({ command, codexHome: path.join(root, 'codex'), home: path.join(root, 'home'),
    reportToolStartupFailures: true,
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

    // #80 independent oracle, derived from the app-server protocol frames.
    type Note = { method?: string; params?: Record<string, any> };
    const protocol = wire.split('\n').flatMap((line) => { try { return [JSON.parse(line) as Note]; } catch { return []; } });
    const notes = (method: string) => protocol.filter((frame) => frame.method === method).map((frame) => frame.params!);
    const outputDeltas = notes('item/commandExecution/outputDelta');
    const patchUpdates = notes('item/fileChange/patchUpdated');
    const completed = notes('item/completed').map((params) => params.item as Record<string, any>);
    // The fixture exercises Codex's real streaming shapes.
    expect(outputDeltas.length).toBeGreaterThan(1);
    expect(patchUpdates.length).toBeGreaterThan(1);
    const singleRaw = singleEvents as Array<Record<string, unknown>>;
    const singleInFlight = singleRaw.filter((event) => event.type === 'tool_in_flight');
    expect(singleInFlight.filter((event) => event.id === outputDeltas[0]!.itemId).length).toBeGreaterThan(1);
    expect(new Set(singleInFlight.map((event) => event.id)).size).toBeGreaterThanOrEqual(3);
    // Patch stats: each completed change's own diff lines, per file.
    const changes = completed.filter((item) => item.type === 'fileChange').flatMap((item) => item.changes as Array<{ path: string; kind: string; diff: string }>);
    const settled = agent.flatMap((event) => event.type === 'tool_use' ? [event] : []);
    for (const change of changes) {
      const lines = change.diff.split('\n');
      const stat = change.kind === 'add' ? { added: lines.length, removed: 0 }
        : { added: lines.filter((line) => line.startsWith('+')).length, removed: lines.filter((line) => line.startsWith('-')).length };
      expect(settled.filter((event) => (event.input as { file_path?: string }).file_path === change.path)
        .map((event) => [event.name, (event.input as { od_diff_stat?: unknown }).od_diff_stat])).toEqual([[change.kind === 'add' ? 'Write' : 'Edit', stat]]);
    }
    // One settled row per protocol tool item — none missing, none duplicated.
    const toolItems = completed.filter((item) => ['commandExecution', 'mcpToolCall', 'webSearch'].includes(item.type)).length
      + changes.length + notes('turn/plan/updated').length;
    expect(new Set(settled.map((event) => event.id)).size).toBe(toolItems);
    expect(settled.filter((event) => event.name !== 'TodoWrite')).toHaveLength(toolItems - notes('turn/plan/updated').length);
    // Tool retirement: every early row has a settled row; derived rows keep none.
    const inFlight = agent.flatMap((event) => event.type === 'tool_in_flight' ? [event] : []);
    expect(inFlight.length).toBeGreaterThanOrEqual(3);
    for (const event of inFlight) expect(settled.some((row) => row.id === event.id)).toBe(true);
    // A redacted update that says nothing new is coalesced: one early row per id.
    expect(inFlight.map((event) => event.id)).toEqual([...new Set(inFlight.map((event) => event.id))]);
    const derived = dedupeToolUsesById(dropSupersededInFlightToolUses(reloaded)).flatMap((event) => event.kind === 'tool_use' ? [event.id] : []);
    expect(derived.sort()).toEqual([...new Set(settled.map((event) => event.id))].sort());
    // No duplicate frame anywhere in the stream.
    for (let n = 1; n < actual.length; n++) expect(JSON.stringify(actual[n])).not.toBe(JSON.stringify(actual[n - 1]));
    // Equal to the single-user stream except identity and redaction: the same
    // event kinds and tool names in order once repeated early rows coalesce.
    const shape = (events: Array<{ type?: unknown; name?: unknown; id?: unknown }>) => {
      const seen = new Set<unknown>();
      return events.flatMap((event) => {
        if (event.type === 'text_delta' || event.type === 'thinking_delta' || event.type === 'turn_end') return [];
        if (event.type === 'tool_in_flight') { if (seen.has(event.id)) return []; seen.add(event.id); }
        return [[event.type, event.name ?? null]];
      });
    };
    expect(shape(agent)).toEqual(shape(singleRaw));
    const deltas = (events: Array<{ type?: unknown; delta?: unknown }>, type: string) => events.filter((event) => event.type === type).map((event) => event.delta).join('');
    expect(deltas(agent, 'text_delta')).toBe(deltas(singleRaw, 'text_delta'));
    expect(deltas(agent, 'thinking_delta')).toBe(deltas(singleRaw, 'thinking_delta'));
    // Hostile command output and tool payloads in the protocol never reach a frame.
    const hostile = [...outputDeltas.map((params) => String(params.delta).trim()),
      ...completed.flatMap((item) => typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput.split('\n').filter(Boolean) : []),
      'FAKE_S3_SECRET', '/host/private', root];
    expect(hostile.length).toBeGreaterThan(4);
    for (const token of hostile) expect(JSON.stringify(actual)).not.toContain(token);
  } finally {
    clearTimeout(timeout);
    if (single.exitCode === null && single.signalCode === null) single.kill('SIGKILL');
    if (personal.child.exitCode === null && personal.child.signalCode === null) personal.child.kill('SIGKILL');
    await Promise.allSettled([singleClosed, personal.done]);
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
