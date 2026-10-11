// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StudioDesignJury } from '../../../src/components/Theater/StudioDesignJury';
const mock = vi.hoisted(() => ({ available: true, media: true, fetch: vi.fn(), connections: [] as string[],
  streams: [] as Array<{ events: Record<string, EventListener>; closed: boolean }> }));
vi.mock('../../../src/runtime/studio-capabilities', () => ({ useStudioCapabilities: () => ({
  available: (lane: string) => lane === 'generation' ? mock.media : mock.available, reason: () => 'Execution disabled', generation: 1,
}) }));
vi.mock('../../../src/runtime/studio-transport', () => ({ studioFetch: mock.fetch, studioEventSourceCtor: () => class {
  handle = { events: {} as Record<string, EventListener>, closed: false };
  constructor(url: string) { mock.connections.push(url); mock.streams.push(this.handle); }
  addEventListener(name: string, listener: EventListener) { this.handle.events[name] = listener; }
  close() { this.handle.closed = true; }
} }));
beforeEach(() => { mock.available = true; mock.connections.length = 0; mock.streams.length = 0; mock.fetch.mockReset();
  mock.fetch.mockImplementation(async (_url: string, init?: RequestInit) => Response.json(init?.method === 'POST'
    ? { runId: 'jury-run' } : { runs: [] })); });
afterEach(cleanup);
it('starts with the conversation execution source and mounts the private Jury stream', async () => {
  render(<StudioDesignJury projectId="p" conversationId="c" agentId="openai-byok" canWrite />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Review spacing' } });
  fireEvent.click(screen.getByRole('button', { name: 'Start Design Jury' }));
  await waitFor(() => expect(mock.connections).toContain('/api/projects/p/critique/jury-run/events'));
  const request = mock.fetch.mock.calls.find((call) => call[1]?.method === 'POST');
  expect(JSON.parse(request![1].body)).toEqual({ conversationId: 'c', agentId: 'openai-byok', message: 'Review spacing' });
});
it('replays private rounds into Theater and exposes only the matching SHIP artifact', async () => {
  mock.fetch.mockImplementation(async (url: string) => Response.json(url.endsWith('/jury-run')
    ? { status: 'succeeded' } : { runs: [{ id: 'jury-run' }] }));
  render(<StudioDesignJury projectId="p" conversationId="c" agentId="codex" canWrite />);
  await waitFor(() => expect(mock.streams).toHaveLength(1));
  const stream = mock.streams[0]!;
  act(() => {
    stream.events['critique.run_started']!(new MessageEvent('critique.run_started', { data: JSON.stringify({
      runId: 'jury-run', protocolVersion: 1, cast: ['critic'], maxRounds: 3, threshold: 8, scale: 10,
    }) }));
  });
  expect(screen.getAllByRole('region').some((region) => region.getAttribute('data-phase') === 'running')).toBe(true);
  act(() => {
    stream.events['critique.ship']!(new MessageEvent('critique.ship', { data: JSON.stringify({
      runId: 'jury-run', round: 3, composite: 9, status: 'shipped', summary: 'Ready',
      artifactRef: { projectId: 'p', artifactId: 'jury-run' },
    }) }));
  });
  expect(screen.getByRole('link', { name: 'Open reviewed artifact' }).getAttribute('href')).toBe('/api/projects/p/critique/jury-run/artifact');
  expect(stream.closed).toBe(true);
});
it('shows the capability reason with no callable controls', () => {
  mock.available = false;
  render(<StudioDesignJury projectId="p" conversationId="c" agentId="codex" canWrite />);
  expect(screen.getByRole('status').textContent).toBe('Execution disabled');
  expect(screen.queryByRole('button')).toBeNull(); expect(mock.fetch).not.toHaveBeenCalled();
});
it('opens the authorized transcript replay with its saved panel notes after completion', async () => {
  const events = [
    { type: 'run_started', runId: 'jury-run', protocolVersion: 1, cast: ['critic'], maxRounds: 3, threshold: 8, scale: 10 },
    { type: 'panelist_open', runId: 'jury-run', round: 1, role: 'critic' },
    { type: 'panelist_dim', runId: 'jury-run', round: 1, role: 'critic', dimName: 'hierarchy', dimScore: 9, dimNote: 'Saved spacing note' },
    { type: 'panelist_close', runId: 'jury-run', round: 1, role: 'critic', score: 9 },
    { type: 'round_end', runId: 'jury-run', round: 1, composite: 9, mustFix: 0, decision: 'ship', reason: 'Ready' },
    { type: 'ship', runId: 'jury-run', round: 1, composite: 9, status: 'shipped', summary: 'Ready', artifactRef: { projectId: 'p', artifactId: 'jury-run' } },
  ];
  mock.fetch.mockImplementation(async (url: string) => Response.json(url.endsWith('/transcript') ? { events }
    : url.endsWith('/jury-run') ? { status: 'succeeded' } : { runs: [{ id: 'jury-run' }] }));
  render(<StudioDesignJury projectId="p" conversationId="c" agentId="codex" canWrite />);
  fireEvent.click(await screen.findByRole('button', { name: 'Replay' }));
  expect(await screen.findByText('Saved spacing note')).toBeTruthy();
  expect(mock.fetch).toHaveBeenCalledWith('/api/projects/p/critique/jury-run/transcript');
});
it('selects an earlier owned Jury and closes the prior private stream', async () => {
  mock.fetch.mockImplementation(async (url: string) => Response.json(/\/(new|old)$/.test(url)
    ? { status: 'succeeded' } : { runs: [{ id: 'new' }, { id: 'old' }] }));
  render(<StudioDesignJury projectId="p" conversationId="c" agentId="codex" canWrite />);
  await waitFor(() => expect(mock.connections).toContain('/api/projects/p/critique/new/events'));
  fireEvent.change(await screen.findByRole('combobox', { name: 'Replay' }), { target: { value: 'old' } });
  await waitFor(() => expect(mock.connections).toContain('/api/projects/p/critique/old/events'));
  expect(mock.streams[0]!.closed).toBe(true);
});
it('offers no start control for a read-only conversation', async () => {
  render(<StudioDesignJury projectId="p" conversationId="c" agentId="codex" canWrite={false} />);
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Start Design Jury' })).toBeNull();
});
it('lets the owner interrupt a queued Jury before the Theater has started', async () => {
  mock.fetch.mockImplementation(async (url: string, init?: RequestInit) => Response.json(init?.method === 'POST' ? { status: 'canceled' }
    : url.endsWith('/queued') ? { status: 'queued' } : { runs: [{ id: 'queued' }] }));
  render(<StudioDesignJury projectId="p" conversationId="c" agentId="codex" canWrite />);
  const button = await screen.findByRole('button', { name: 'Interrupt' });
  fireEvent.click(button);
  await waitFor(() => expect(mock.fetch).toHaveBeenCalledWith('/api/projects/p/critique/queued/interrupt', { method: 'POST' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Interrupt' })).toBeNull());
});
it('does not display another project’s late start result', async () => {
  let release!: (value: Response) => void;
  mock.fetch.mockImplementation(async (_url: string, init?: RequestInit) => init?.method === 'POST'
    ? new Promise<Response>((resolve) => { release = resolve; }) : Response.json({ runs: [] }));
  const view = render(<StudioDesignJury projectId="p" conversationId="c" agentId="codex" canWrite />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Review' } });
  fireEvent.click(screen.getByRole('button', { name: 'Start Design Jury' }));
  view.rerender(<StudioDesignJury projectId="other" conversationId="other-c" agentId="codex" canWrite />);
  release(Response.json({ runId: 'old-run' }));
  await waitFor(() => expect(mock.fetch.mock.calls.some((call) => call[0] === '/api/projects/other/critique')).toBe(true));
  expect(mock.connections.some((url) => url.includes('old-run'))).toBe(false);
});

it('allows a personal Codex Jury without reopening the disabled media generation lane', async () => {
  mock.media = false;
  try {
    render(<StudioDesignJury projectId="p" conversationId="c" agentId="codex" canWrite />);
    expect(screen.getByRole('button', { name: 'Start Design Jury' })).toBeTruthy();
  } finally { mock.media = true; }
});


it.each(['interrupted', 'timed_out'] as const)('hides the artifact link for a legacy %s fallback SHIP', async (status) => {
  mock.fetch.mockImplementation(async (url: string) => Response.json(url.endsWith('/jury-run')
    ? { status: 'failed', critique: { status, artifactAvailable: false } } : { runs: [{ id: 'jury-run' }] }));
  render(<StudioDesignJury projectId="p" conversationId="c" agentId="codex" canWrite />);
  await waitFor(() => expect(mock.streams).toHaveLength(1));
  const stream = mock.streams[0]!;
  act(() => {
    stream.events['critique.run_started']!(new MessageEvent('critique.run_started', { data: JSON.stringify({
      runId: 'jury-run', protocolVersion: 1, cast: ['critic'], maxRounds: 3, threshold: 8, scale: 10,
    }) }));
    stream.events['critique.ship']!(new MessageEvent('critique.ship', { data: JSON.stringify({
      runId: 'jury-run', round: 1, composite: 7, status, summary: 'Fallback', artifactRef: { projectId: 'p', artifactId: 'jury-run' },
    }) }));
  });
  expect(screen.queryByRole('link', { name: 'Open reviewed artifact' })).toBeNull();
});
