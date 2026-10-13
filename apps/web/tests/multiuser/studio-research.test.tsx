// @vitest-environment jsdom
// #63: the account's Tavily key in shared Settings and the composer's research
// readiness. `/search` is offered only when the server advertises account
// research and this account saved a key; saving one flips readiness at once.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { STUDIO_PARITY_LANES, type AuthAccount, type StudioProviderKeySummary, type StudioRuntimeCapabilities } from '@open-design/contracts';
import { CookieSession } from '../../src/multiuser/session';
import { StudioCapabilitiesProvider } from '../../src/runtime/studio-capabilities';
import { StudioProviderKeys } from '../../src/runtime/StudioProviderKeys';
import { useStudioResearchReady } from '../../src/runtime/studio-research';
import { studioRequestAvailable } from '../../src/runtime/studio-transport';

const account: AuthAccount = { id: 'A', username: 'A', role: 'user', active: true, passwordState: 'set', createdAt: 1, updatedAt: 1 };
const capabilities = (researchSearch: boolean): StudioRuntimeCapabilities => ({ schemaVersion: 1, shell: 'studio', researchSearch,
  features: Object.fromEntries(STUDIO_PARITY_LANES.map(({ id }) => [id, ['execution', 'generation'].includes(id)
    ? { status: 'pilot', reason: 'Pilot' } : { status: 'unavailable', reason: 'Pending' }])) as StudioRuntimeCapabilities['features'] });
const summary = (provider: 'openai' | 'tavily', configured: boolean, revision: number): StudioProviderKeySummary => ({ provider, configured,
  last4: configured ? 'ABCD' : null, model: provider === 'openai' ? 'gpt-5.1' : '', revision, credentialRevision: revision, updatedAt: null });

function Ready() { return <span data-testid="ready">{String(useStudioResearchReady())}</span>; }
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('saves the Tavily key write-only and turns research on for the composer', async () => {
  let tavily = summary('tavily', false, 0);
  const puts: Array<{ url: string; body: unknown }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/auth/me') return Response.json({ account, studio: capabilities(true), studioRevision: 1, studioMessageIdPrefix: 'mua_0123456789abcdef01234567_' });
    if (url === '/api/multiuser/settings/provider-keys/tavily' && init?.method === 'PUT') {
      puts.push({ url, body: JSON.parse(String(init.body)) });
      tavily = summary('tavily', true, 1);
      return Response.json({ key: tavily });
    }
    if (url === '/api/multiuser/settings/provider-keys') return Response.json({ keys: [summary('openai', false, 0), tavily] });
    return Response.json({}, { status: 404 });
  }));
  const session = new CookieSession();
  await session.verify();
  const state = session.snapshot();
  render(<StudioCapabilitiesProvider session={session} generation={state.generation} actor={account} capabilities={state.studio!}>
    <StudioProviderKeys provider="tavily" /><Ready />
  </StudioCapabilitiesProvider>);
  await waitFor(() => expect(screen.getByTestId('studio-provider-key-state-tavily').textContent).toContain('No key saved'));
  expect(screen.getByTestId('ready').textContent).toBe('false');
  // No model choice for a research key.
  expect(screen.queryByTestId('studio-provider-key-model')).toBeNull();
  fireEvent.change(screen.getByTestId('studio-provider-key-input-tavily'), { target: { value: 'tvly-secret-research-key-ABCD' } });
  await act(async () => { fireEvent.click(screen.getByTestId('studio-provider-key-save-tavily')); });
  await waitFor(() => expect(screen.getByTestId('ready').textContent).toBe('true'));
  expect(puts).toEqual([{ url: '/api/multiuser/settings/provider-keys/tavily', body: { revision: 0, apiKey: 'tvly-secret-research-key-ABCD' } }]);
  expect((screen.getByTestId('studio-provider-key-input-tavily') as HTMLInputElement).value).toBe('');
  expect(document.body.textContent).not.toContain('tvly-secret-research-key');
  session.dispose();
});

it('keeps research closed in the transport unless the server advertises account research', () => {
  const lanes = (lane: string) => lane === 'generation' || lane === 'execution';
  expect(studioRequestAvailable('POST', '/api/research/search', lanes as never, false, true)).toBe(true);
  expect(studioRequestAvailable('POST', '/api/research/search', lanes as never, false, false)).toBe(false);
  expect(studioRequestAvailable('PUT', '/api/multiuser/settings/provider-keys/tavily', lanes as never, false, false)).toBe(false);
  expect(studioRequestAvailable('PUT', '/api/multiuser/settings/provider-keys/tavily', lanes as never, false, true)).toBe(true);
  expect(studioRequestAvailable('GET', '/api/research/search', () => true, true, true)).toBe(false);
});
