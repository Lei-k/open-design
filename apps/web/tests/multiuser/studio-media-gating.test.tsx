// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { STUDIO_PARITY_LANES, type AuthAccount, type StudioRuntimeCapabilities } from '@open-design/contracts';
import { CookieSession } from '../../src/multiuser/session';
import { StudioCapabilitiesProvider } from '../../src/runtime/studio-capabilities';
import { HomeView } from '../../src/components/HomeView';
import { SettingsDialog } from '../../src/components/SettingsDialog';
import { StudioDesignJury } from '../../src/components/Theater/StudioDesignJury';
import { DEFAULT_CONFIG } from '../../src/state/config';
import { homeTemplateTrigger } from '../helpers/home-template-picker';
const actor: AuthAccount = { id: 'A', username: 'A', role: 'user', active: true, passwordState: 'set', createdAt: 1, updatedAt: 1 };
const capabilities: StudioRuntimeCapabilities = { schemaVersion: 1, shell: 'studio', executionSources: [{ source: 'personal_subscription', agentId: 'codex' }],
  features: Object.fromEntries(STUDIO_PARITY_LANES.map(({ id }) => [id, ['baseline', 'execution', 'home'].includes(id)
    ? { status: 'pilot', reason: 'Pilot' } : { status: 'admin-disabled', reason: 'Media requires an OpenAI execution source.' }])) as StudioRuntimeCapabilities['features'] };
let session: CookieSession;
afterEach(() => { cleanup(); session?.dispose(); vi.unstubAllGlobals(); });
async function mount(children: React.ReactNode) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input) === '/api/auth/me'
    ? Response.json({ account: actor, studio: capabilities, studioRevision: 1, studioMessageIdPrefix: 'mua_0123456789abcdef01234567_' })
    : Response.json(String(input).endsWith('/critique') ? { runs: [] } : {}, { status: String(input).endsWith('/critique') ? 200 : 404 })));
  session = new CookieSession(); await session.verify();
  const state = session.snapshot();
  return render(<StudioCapabilitiesProvider session={session} generation={state.generation} actor={actor} capabilities={state.studio!}>{children}</StudioCapabilitiesProvider>);
}
it('personal-only Home keeps media disabled while standalone Jury can start', async () => {
  await mount(<><HomeView projects={[]} onSubmit={vi.fn()} onOpenProject={vi.fn()} /><StudioDesignJury projectId="p" conversationId="c" agentId="codex" canWrite /></>);
  await screen.findByTestId('home-hero-template-trigger'); fireEvent.click(homeTemplateTrigger());
  const menu = await screen.findByTestId('home-hero-template-menu');
  for (const kind of ['image', 'video', 'audio']) expect((menu.querySelector(`[data-chip="${kind}"]`) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole('button', { name: 'Start Design Jury' })).toBeTruthy();
});
it('personal-only Settings keeps the media section gated', async () => {
  await mount(<SettingsDialog initial={DEFAULT_CONFIG} agents={[]} daemonLive appVersionInfo={null} initialSection="media"
    onPersist={vi.fn()} onPersistComposioKey={vi.fn()} onClose={vi.fn()} onRefreshAgents={vi.fn()} />);
  expect(screen.queryByTestId('studio-media')).toBeNull();
  expect(screen.getByRole('status').textContent).toBe('Media requires an OpenAI execution source.');
});
