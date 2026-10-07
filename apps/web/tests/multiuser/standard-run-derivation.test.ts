import { expect, it } from 'vitest';
import type { DaemonAgentPayload, PersistedAgentEvent } from '@open-design/contracts';
import { translateAgentEvent } from '../../src/providers/daemon';
import { buildTurnBlocks } from '../../src/runtime/chat/build-turn-blocks';

it('derives the same ChatPanel blocks from live standard redacted events and a reloaded transcript', () => {
  const redacted = { policy: 'personal-subscription' as const, fields: ['input'] };
  const wire: DaemonAgentPayload[] = [
    { type: 'thinking_delta', delta: 'Plan the work.' },
    { type: 'tool_use', id: 'cmd', name: 'Bash', input: {}, redacted, startedAt: 100 },
    { type: 'tool_result', toolUseId: 'cmd', content: '[omitted]', isError: false, completedAt: 200 },
    { type: 'text_delta', delta: 'Finished.' },
  ];
  const stored: PersistedAgentEvent[] = [
    { kind: 'thinking', text: 'Plan the work.' },
    { kind: 'tool_use', id: 'cmd', name: 'Bash', input: {}, redacted, startedAt: 100 },
    { kind: 'tool_result', toolUseId: 'cmd', content: '[omitted]', isError: false, completedAt: 200 },
    { kind: 'text', text: 'Finished.' },
  ];
  const live = wire.map(translateAgentEvent).filter((event) => event !== null);
  expect(live).toEqual(stored);
  for (const runStatus of ['running', 'succeeded', 'canceled'] as const) {
    const derive = (events: PersistedAgentEvent[]) => buildTurnBlocks({ events, runStatus, startedAtMs: 50, endedAtMs: 300, nowMs: 250 });
    expect(derive(live)).toEqual(derive(stored));
  }
});
