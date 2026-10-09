// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { AssistantMessage } from '../../src/components/AssistantMessage';
import { translateAgentEvent } from '../../src/providers/daemon';
import type { ChatMessage, AgentEvent } from '../../src/types';

afterEach(cleanup);
const started = { kind: 'pipeline_stage_started', runId: 'run', snapshotId: 'snapshot', stageId: 'inspect-project', iteration: 0, startedAt: 1000 } as const;
const completed = { kind: 'pipeline_stage_completed', runId: 'run', snapshotId: 'snapshot', stageId: 'inspect-project', iteration: 0, completedAt: 2000 } as const;
const message = (events: AgentEvent[], runStatus: NonNullable<ChatMessage['runStatus']>): ChatMessage => ({ id: 'a', role: 'assistant', content: '', events, runStatus });

it('renders the active daemon stage from live SSE and the same stage from persisted history', () => {
  const event = translateAgentEvent({ type: 'pipeline_stage', stage: started });
  expect(event).toEqual(started);
  const view = render(<AssistantMessage message={message([event!], 'running')} streaming />);
  expect(screen.getByTestId('status-detail').textContent).toBe('inspect-project');
  expect(screen.getByTestId('status-pill').textContent).toContain('Working');
  view.rerender(<AssistantMessage message={message([started, completed], 'succeeded')} streaming={false} />);
  expect(screen.getAllByTestId('status-detail')).toHaveLength(1);
  expect(screen.getByTestId('status-pill').textContent).toContain('Done');
});
it.each(['queued', 'running'] as const)('keeps a persisted %s stage active while the transport reattaches', (status) => {
  render(<AssistantMessage message={message([started], status)} streaming={false} />);
  expect(screen.getByTestId('status-pill').textContent).toContain('Working');
  expect(screen.getByTestId('status-pill').textContent).not.toContain('Awaiting your reply');
});
it.each([['canceled', 'Canceled'], ['failed', 'Run failed'], ['succeeded', 'Awaiting your reply']] as const)(
  'never leaves the unfinished stage running on a %s turn', (status, label) => {
    render(<AssistantMessage message={message([started], status)} streaming={false} />);
    expect(screen.getByTestId('status-pill').textContent).toContain(label);
    expect(screen.getByTestId('status-pill').textContent).not.toContain('Working');
  });
it('ignores malformed stage frames and renders no stage row when no pipeline ran', () => {
  expect(translateAgentEvent({ type: 'pipeline_stage', stage: { ...started, iteration: -1 } })).toBeNull();
  render(<AssistantMessage message={message([{ kind: 'text', text: 'Ordinary reply' }], 'succeeded')} streaming={false} />);
  expect(screen.queryByTestId('status-pill')).toBeNull();
});
