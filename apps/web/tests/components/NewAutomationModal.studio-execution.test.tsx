// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { STUDIO_PARITY_LANES, type AuthAccount, type Routine, type StudioRuntimeCapabilities } from '@open-design/contracts';
import { CookieSession } from '../../src/multiuser/session';
import { StudioCapabilitiesProvider } from '../../src/runtime/studio-capabilities';
import { NewAutomationModal, type AutomationTemplate } from '../../src/components/NewAutomationModal';

const account: AuthAccount = { id: 'A', username: 'A', role: 'user', active: true, passwordState: 'set', createdAt: 1, updatedAt: 1 };
const choices: NonNullable<StudioRuntimeCapabilities['executionSources']> = [
  { source: 'personal_subscription', agentId: 'codex' }, { source: 'company_pool', agentId: 'openai' },
  { source: 'personal_api_key', agentId: 'openai-byok' },
];
const routine: Routine = { id: 'routine', name: 'Saved', prompt: 'Saved prompt', agentId: 'openai-byok', skillId: null,
  schedule: { kind: 'daily', time: '09:00', timezone: 'UTC' }, target: { mode: 'create_each_run' },
  enabled: true, nextRunAt: null, lastRun: null, createdAt: 1, updatedAt: 1 };
let session: CookieSession;
afterEach(() => { cleanup(); session?.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function mount(initial?: Routine, sources = choices, options: { template?: AutomationTemplate; refuse?: boolean } = {}) {
  const capabilities: StudioRuntimeCapabilities = { schemaVersion: 1, shell: 'studio', executionSources: sources,
    features: Object.fromEntries(STUDIO_PARITY_LANES.map(({ id }) => [id,
      ['automations', 'execution'].includes(id) ? { status: 'pilot', reason: 'Pilot' } : { status: 'unavailable', reason: 'Pending' },
    ])) as StudioRuntimeCapabilities['features'] };
  const writes: Array<{ method: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/auth/me') return Response.json({ account, studio: capabilities, studioRevision: 1 });
    if (url.startsWith('/api/routines') && init?.method) {
      const body = JSON.parse(String(init.body)); writes.push({ method: init.method, body });
      if (options.refuse) return Response.json({ error: { code: 'CONNECTOR_NOT_GRANTED', message: 'routine connectors unavailable' } }, { status: 403 });
      return Response.json({ routine: { ...routine, ...body } });
    }
    return Response.json({ error: { code: 'NOT_FOUND', message: 'Unavailable' } }, { status: 404 });
  }));
  session = new CookieSession(); await session.verify();
  const modal = (seed: ComponentProps<typeof NewAutomationModal>['initial'], open = true) => <StudioCapabilitiesProvider session={session} generation={session.snapshot().generation} actor={account} capabilities={capabilities}>
    <NewAutomationModal open={open} initial={seed} templates={options.template ? [options.template] : []} projects={[]} skills={[]}
      onClose={() => {}} onSaved={() => {}} />
  </StudioCapabilitiesProvider>;
  const view = render(modal(initial ? { routine: initial } : options.template ? { template: options.template } : undefined));
  return { writes, rerender: (seed: ComponentProps<typeof NewAutomationModal>['initial'], open = true) => view.rerender(modal(seed, open)) };
}
const save = () => fireEvent.submit(screen.getByTestId('automation-modal').querySelector('form')!);
it('lets an account create a routine on its own OpenAI key through the existing source picker', async () => {
  const { writes } = await mount();
  fireEvent.change(screen.getByTestId('automation-modal-title'), { target: { value: 'Own key task' } });
  fireEvent.change(screen.getByTestId('automation-modal-prompt'), { target: { value: 'Make a board' } });
  const picker = screen.getByTestId('studio-execution-source').querySelector('select')!;
  fireEvent.change(picker, { target: { value: 'openai-byok' } });
  save();
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]).toMatchObject({ method: 'POST', body: { name: 'Own key task', agentId: 'openai-byok' } });
});
it('preserves a saved own-key source on edits and changes it only through an explicit selection', async () => {
  const { writes } = await mount(routine);
  expect((screen.getByTestId('studio-execution-source').querySelector('select') as HTMLSelectElement).value).toBe('openai-byok');
  fireEvent.change(screen.getByTestId('automation-modal-title'), { target: { value: 'Renamed' } }); save();
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]).toMatchObject({ method: 'PATCH', body: { agentId: 'openai-byok' } });
  fireEvent.change(screen.getByTestId('studio-execution-source').querySelector('select')!, { target: { value: 'openai' } }); save();
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(writes[1]).toMatchObject({ method: 'PATCH', body: { agentId: 'openai' } });
});
it('defaults a new routine to the single advertised own-key source', async () => {
  const { writes } = await mount(undefined, [choices[2]!]);
  fireEvent.change(screen.getByTestId('automation-modal-title'), { target: { value: 'Only source' } });
  fireEvent.change(screen.getByTestId('automation-modal-prompt'), { target: { value: 'Use my key' } }); save();
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]!.body.agentId).toBe('openai-byok');
});

it.each(['template', 'routine'] as const)('keeps a %s draft and refusal through parent refreshes, but resets for another selection and reopening', async (kind) => {
  const template: AutomationTemplate = { id: 'connector-template', category: 'Automation', kind: 'routine', icon: 'history',
    title: 'Connector template', description: 'Connected context', prompt: 'Template prompt', catalogTemplateId: 'connector-template' };
  const { writes, rerender } = await mount(kind === 'routine' ? routine : undefined, choices,
    { refuse: true, ...(kind === 'template' ? { template } : {}) });
  const title = () => screen.getByTestId('automation-modal-title') as HTMLInputElement;
  const prompt = () => screen.getByTestId('automation-modal-prompt') as HTMLTextAreaElement;
  const source = () => screen.getByTestId('studio-execution-source').querySelector('select') as HTMLSelectElement;
  fireEvent.change(title(), { target: { value: 'My edited title' } });
  fireEvent.change(prompt(), { target: { value: 'My edited prompt' } });
  fireEvent.change(source(), { target: { value: 'openai' } });
  save();
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBeTruthy());
  expect(writes).toHaveLength(1);
  expect(writes[0]!.body).toMatchObject({ name: 'My edited title', prompt: 'My edited prompt', agentId: 'openai' });
  const refusal = screen.getByRole('alert').textContent;

  // TasksView recreates this wrapper on a parent render. Even updated metadata
  // for the same selection must not replace the user's in-progress draft.
  rerender(kind === 'routine'
    ? { routine: { ...routine, name: 'Refetched name', prompt: 'Refetched prompt', agentId: 'codex' } }
    : { template: { ...template, title: 'Refetched title', prompt: 'Refetched prompt' } });
  expect(screen.getByRole('alert').textContent).toBe(refusal);
  expect(title().value).toBe('My edited title');
  expect(prompt().value).toBe('My edited prompt');
  expect(source().value).toBe('openai');

  const next = kind === 'routine'
    ? { routine: { ...routine, id: 'different-routine', name: 'Next title', prompt: 'Next prompt' } }
    : { template: { ...template, id: 'different-template', title: 'Next title', prompt: 'Next prompt' } };
  rerender(next);
  expect(title().value).toBe('Next title');
  expect(prompt().value).toBe('Next prompt');
  expect(source().value).toBe(kind === 'routine' ? 'openai-byok' : 'codex');
  expect(screen.queryByRole('alert')).toBeNull();

  fireEvent.change(title(), { target: { value: 'Draft before close' } });
  rerender(next, false);
  rerender({ ...next });
  expect(title().value).toBe('Next title');
  expect(prompt().value).toBe('Next prompt');
});
