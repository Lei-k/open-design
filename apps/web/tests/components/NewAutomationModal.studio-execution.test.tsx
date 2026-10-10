// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { STUDIO_PARITY_LANES, type AuthAccount, type Routine, type StudioRuntimeCapabilities } from '@open-design/contracts';
import { CookieSession } from '../../src/multiuser/session';
import { StudioCapabilitiesProvider } from '../../src/runtime/studio-capabilities';
import { NewAutomationModal } from '../../src/components/NewAutomationModal';

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
async function mount(initial?: Routine, sources = choices) {
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
      return Response.json({ routine: { ...routine, ...body } });
    }
    return Response.json({ error: { code: 'NOT_FOUND', message: 'Unavailable' } }, { status: 404 });
  }));
  session = new CookieSession(); await session.verify();
  render(<StudioCapabilitiesProvider session={session} generation={session.snapshot().generation} actor={account} capabilities={capabilities}>
    <NewAutomationModal open initial={initial ? { routine: initial } : undefined} templates={[]} projects={[]} skills={[]}
      onClose={() => {}} onSaved={() => {}} />
  </StudioCapabilitiesProvider>);
  return writes;
}
const save = () => fireEvent.submit(screen.getByTestId('automation-modal').querySelector('form')!);
it('lets an account create a routine on its own OpenAI key through the existing source picker', async () => {
  const writes = await mount();
  fireEvent.change(screen.getByTestId('automation-modal-title'), { target: { value: 'Own key task' } });
  fireEvent.change(screen.getByTestId('automation-modal-prompt'), { target: { value: 'Make a board' } });
  const picker = screen.getByTestId('studio-execution-source').querySelector('select')!;
  fireEvent.change(picker, { target: { value: 'openai-byok' } });
  save();
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]).toMatchObject({ method: 'POST', body: { name: 'Own key task', agentId: 'openai-byok' } });
});
it('preserves a saved own-key source on edits and changes it only through an explicit selection', async () => {
  const writes = await mount(routine);
  expect((screen.getByTestId('studio-execution-source').querySelector('select') as HTMLSelectElement).value).toBe('openai-byok');
  fireEvent.change(screen.getByTestId('automation-modal-title'), { target: { value: 'Renamed' } }); save();
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]).toMatchObject({ method: 'PATCH', body: { agentId: 'openai-byok' } });
  fireEvent.change(screen.getByTestId('studio-execution-source').querySelector('select')!, { target: { value: 'openai' } }); save();
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(writes[1]).toMatchObject({ method: 'PATCH', body: { agentId: 'openai' } });
});
it('defaults a new routine to the single advertised own-key source', async () => {
  const writes = await mount(undefined, [choices[2]!]);
  fireEvent.change(screen.getByTestId('automation-modal-title'), { target: { value: 'Only source' } });
  fireEvent.change(screen.getByTestId('automation-modal-prompt'), { target: { value: 'Use my key' } }); save();
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]!.body.agentId).toBe('openai-byok');
});
