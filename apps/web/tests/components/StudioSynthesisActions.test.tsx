// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { StudioSynthesisState } from '@open-design/contracts';
import { StudioSynthesisActions } from '../../src/components/StudioSynthesisActions';
const mock = vi.hoisted(() => ({ fetch: vi.fn(), actor: 'A', generation: 1, host: false, available: true, tick: () => {} }));
vi.mock('../../src/runtime/studio-capabilities', () => ({ useStudioCapabilities: () => ({ hostServices: mock.host,
  actor: { id: mock.actor }, generation: mock.generation, available: () => mock.available, reason: () => 'Delivery disabled' }) }));
vi.mock('../../src/runtime/studio-transport', () => ({ studioFetch: mock.fetch,
  studioSetInterval: (callback: () => void) => { mock.tick = callback; return 0; } }));
const digest = 'a'.repeat(64);
const state = (): StudioSynthesisState => ({ digest, defaultSource: 'personal_api_key', sources: [
  { executionSource: 'personal_subscription', available: false, reason: 'personal-codex' },
  { executionSource: 'company_pool', available: true, reason: null },
  { executionSource: 'personal_api_key', available: true, reason: null },
], results: {} });
let snapshot: StudioSynthesisState;
beforeEach(() => {
  snapshot = state(); mock.actor = 'A'; mock.host = false; mock.generation = 1; mock.available = true; mock.fetch.mockReset();
  mock.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const action = url.endsWith('/handoff') ? 'handoff' : 'finalize';
      const result = { id: action, projectId: 'p', action, conversationId: action === 'handoff' ? 'c' : null,
        executionSource: JSON.parse(String(init.body)).executionSource, fileName: action === 'handoff' ? 'HANDOFF.md' : 'DESIGN.md',
        digest, current: true, createdAt: 1, model: 'fixture', inputTokens: 1, outputTokens: 1, transcriptMessageCount: 1 } as const;
      snapshot.results[action] = result; return Response.json(result);
    }
    return Response.json(snapshot);
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it.each(['company_pool', 'personal_api_key'] as const)('sends credential-free finalize and handoff requests on %s', async (source) => {
  snapshot.defaultSource = source;
  render(<StudioSynthesisActions projectId="p" conversationId="c" />);
  await waitFor(() => expect((screen.getByRole('button', { name: 'Finalize with AI' }) as HTMLButtonElement).disabled).toBe(false));
  for (const name of ['Finalize with AI', 'Create handoff prompt']) {
    fireEvent.click(screen.getByRole('button', { name }));
    await waitFor(() => expect(mock.fetch.mock.calls.some((call) => call[1]?.method === 'POST' && call[0].endsWith(name.startsWith('Finalize') ? '/finalize/openai' : '/handoff'))).toBe(true));
    await waitFor(() => expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(false));
  }
  const bodies = mock.fetch.mock.calls.filter((call) => call[1]?.method === 'POST').map((call) => JSON.parse(call[1].body));
  expect(bodies).toEqual([{ executionSource: source, digest }, { executionSource: source, digest, conversationId: 'c' }]);
});
it('shows the typed Codex refusal and lets the actor choose an OpenAI source', async () => {
  snapshot.defaultSource = 'personal_subscription';
  render(<StudioSynthesisActions projectId="p" />);
  await waitFor(() => expect(screen.getByRole('status').getAttribute('data-refusal')).toBe('personal-codex'));
  expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'company_pool' } });
  expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(false);
});
it('fails closed with a typed source reason when the selected source is absent', async () => {
  snapshot.sources = [];
  snapshot.defaultSource = 'company_pool';
  render(<StudioSynthesisActions projectId="p" />);
  await waitFor(() => expect(screen.getByRole('status').getAttribute('data-refusal')).toBe('provider-disabled'));
  expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
});
it('refuses a read-only viewer with no callable synthesis controls', async () => {
  render(<StudioSynthesisActions projectId="p" conversationId="c" canWrite={false} />);
  await waitFor(() => expect(screen.getByRole('status').getAttribute('data-refusal')).toBe('project-read-only'));
  for (const button of screen.getAllByRole('button')) expect((button as HTMLButtonElement).disabled).toBe(true);
});
it('hides a saved handoff prompt when the digest becomes stale', async () => {
  const result = { id: 'job', projectId: 'p', action: 'handoff' as const, conversationId: 'c', executionSource: 'personal_api_key' as const,
    fileName: 'HANDOFF.md' as const, digest, current: true, createdAt: 1, model: 'fixture', inputTokens: 1, outputTokens: 2, transcriptMessageCount: 1 };
  mock.fetch.mockImplementation(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') { snapshot.results.handoff = result; return Response.json({ ...result, prompt: 'Private handoff' }); }
    return Response.json(snapshot);
  });
  render(<StudioSynthesisActions projectId="p" conversationId="c" />);
  await waitFor(() => expect((screen.getByRole('button', { name: 'Create handoff prompt' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Create handoff prompt' }));
  expect(await screen.findByDisplayValue('Private handoff')).toBeTruthy();
  snapshot.results.handoff = { ...result, current: false }; mock.tick();
  await waitFor(() => expect(screen.queryByDisplayValue('Private handoff')).toBeNull());
});
it('discards a late response after a project or actor-generation change', async () => {
  let release!: (value: Response) => void;
  mock.fetch.mockImplementation(async (_url: string, init?: RequestInit) => init?.method === 'POST'
    ? new Promise<Response>((resolve) => { release = resolve; }) : Response.json(snapshot));
  const view = render(<StudioSynthesisActions projectId="p" conversationId="c" />);
  await waitFor(() => expect((screen.getByRole('button', { name: 'Create handoff prompt' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Create handoff prompt' }));
  mock.generation++; view.rerender(<StudioSynthesisActions projectId="other" conversationId="other-c" />);
  release(Response.json({ prompt: 'Old private prompt', action: 'handoff', id: 'old' }));
  await waitFor(() => expect(mock.fetch.mock.calls.some((call) => call[0] === '/api/projects/other/synthesis')).toBe(true));
  expect(screen.queryByDisplayValue('Old private prompt')).toBeNull();
});
it('keeps local delivery unchanged and exposes a disabled-lane reason', () => {
  mock.host = true;
  const view = render(<StudioSynthesisActions projectId="p" />);
  expect(screen.queryByTestId('studio-synthesis-actions')).toBeNull(); expect(mock.fetch).not.toHaveBeenCalled();
  mock.host = false; mock.available = false; view.rerender(<StudioSynthesisActions projectId="p" />);
  expect(screen.getByRole('status').textContent).toBe('Delivery disabled'); expect(mock.fetch).not.toHaveBeenCalled();
});
it('shows a stale saved document after reload without presenting it as current', async () => {
  snapshot.results.finalize = { id:'earlier',projectId:'p',action:'finalize',conversationId:null,executionSource:'personal_api_key',
    fileName:'DESIGN.md',digest:'b'.repeat(64),current:false,createdAt:1,model:'fixture',inputTokens:1,outputTokens:1,transcriptMessageCount:1 };
  render(<StudioSynthesisActions projectId="p" />);
  await waitFor(() => expect(screen.getByText(/DESIGN.md:/).textContent).toContain('The project changed. Run synthesis again.'));
  expect(screen.queryByText('Saved for the current project version.')).toBeNull();
});
it('C: never borrows a caller conversation pin when the actor server default is null', async () => {
  snapshot.defaultSource = null;
  // An obsolete caller prop must not become a source of spend authority.
  const foreignPin = { executionSource: 'personal_api_key' as const };
  render(<StudioSynthesisActions {...foreignPin} projectId="p" conversationId="owner-conversation" />);
  await waitFor(() => expect(screen.getByRole('status').getAttribute('data-refusal')).toBe('source-required'));
  for (const button of screen.getAllByRole('button')) { expect((button as HTMLButtonElement).disabled).toBe(true); fireEvent.click(button); }
  expect(mock.fetch.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(0);
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'company_pool' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create handoff prompt' }));
  await waitFor(() => expect(mock.fetch.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(1));
  expect(JSON.parse(mock.fetch.mock.calls.find((call) => call[1]?.method === 'POST')![1].body)).toEqual({ executionSource:'company_pool',digest,conversationId:'owner-conversation' });
});
it('C: a pre-action poll cannot overwrite the newer receipt or hide its prompt', async () => {
  let release!: (value: Response) => void;
  render(<StudioSynthesisActions projectId="p" conversationId="c" />);
  await waitFor(() => expect((screen.getByRole('button',{name:'Create handoff prompt'}) as HTMLButtonElement).disabled).toBe(false));
  const old = structuredClone(snapshot);
  mock.fetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; }));
  act(() => mock.tick());
  const result = {id:'new-job',projectId:'p',action:'handoff' as const,conversationId:'c',executionSource:'personal_api_key' as const,
    fileName:'HANDOFF.md' as const,digest,current:true,createdAt:1,model:'fixture',inputTokens:1,outputTokens:2,transcriptMessageCount:1};
  mock.fetch.mockImplementation(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') { snapshot.results.handoff = result; return Response.json({...result,prompt:'New private prompt'}); }
    return Response.json(snapshot);
  });
  fireEvent.click(screen.getByRole('button',{name:'Create handoff prompt'}));
  expect(await screen.findByDisplayValue('New private prompt')).toBeTruthy();
  await act(async () => release(Response.json(old)));
  expect(screen.getByDisplayValue('New private prompt')).toBeTruthy();
  expect(screen.getByText(/HANDOFF.md:/).getAttribute('data-current')).toBe('true');
});
it.each(['actor','source','project'])('C: %s transition discards a private handoff prompt', async (change) => {
  const result={id:'private-job',projectId:'p',action:'handoff' as const,conversationId:'c',executionSource:'personal_api_key' as const,
    fileName:'HANDOFF.md' as const,digest,current:true,createdAt:1,model:'fixture',inputTokens:1,outputTokens:2,transcriptMessageCount:1};
  mock.fetch.mockImplementation(async (_url: string,init?: RequestInit)=>{
    if(init?.method==='POST'){snapshot.results.handoff=result;return Response.json({...result,prompt:'Private actor prompt'});}
    return Response.json(snapshot);
  });
  const view=render(<StudioSynthesisActions projectId="p" conversationId="c" />);
  await waitFor(()=>expect((screen.getByRole('button',{name:'Create handoff prompt'}) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button',{name:'Create handoff prompt'}));
  expect(await screen.findByDisplayValue('Private actor prompt')).toBeTruthy();
  if(change==='source'){snapshot.defaultSource='company_pool';act(()=>mock.tick());}
  else {
    if(change==='actor')mock.actor='B';
    view.rerender(<StudioSynthesisActions projectId={change==='project'?'other':'p'} conversationId="c" />);
  }
  await waitFor(()=>expect(screen.queryByDisplayValue('Private actor prompt')).toBeNull());
});
