// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { STUDIO_PARITY_LANES, type AuthAccount, type StudioRuntimeCapabilities } from '@open-design/contracts';
import { CookieSession } from '../../src/multiuser/session';
import { StudioCapabilitiesProvider } from '../../src/runtime/studio-capabilities';
import { StudioAccountSettings } from '../../src/runtime/StudioAccountSettings';
import * as registry from '../../src/providers/registry';
import { takeHomeComposerAssetSeed } from '../../src/state/libraryHandoff';
import type { AppConfig } from '../../src/types';
import { StudioLibrarySettings } from '../../src/runtime/StudioLibrarySettings';
const account: AuthAccount = { id: 'A', username: 'A', role: 'user', active: true, passwordState: 'set', createdAt: 1, updatedAt: 1 };
const capabilities: StudioRuntimeCapabilities = { schemaVersion: 1, shell: 'studio', features: Object.fromEntries(STUDIO_PARITY_LANES.map(({ id }) => [id, { status: 'pilot', reason: 'Pilot' }])) as StudioRuntimeCapabilities['features'] };
async function mount(fail = false, settings = false, captured = false) {
  const calls: string[] = []; let revoked = false;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (url === '/api/auth/me') return Response.json({ account, studio: capabilities, studioRevision: 1 });
    if (url === '/api/library/assets') return Response.json({ assets: captured ? [{ id: 'asset-a', kind: 'image', storage: 'owned', capturedAt: 1, archivedDate: '2026-10-12', contentHash: 'a'.repeat(64), sourceTitle: 'PRIVATE_CAPTURE_A', tags: [], sources: [], createdAt: 1, updatedAt: 1 }] : [] });
    if (url === '/api/library/connection') return Response.json({ paired: !revoked, tokens: revoked ? [] : [{ id: 'token-id', label: 'My extension', extensionOrigin: 'chrome-extension://abc', createdAt: 1, lastUsedAt: 2 }] });
    if (url === '/api/library/pair') return fail ? Response.json({ error: { code: 'CONFLICT', message: 'SECRET_PROVIDER_TEXT' } }, { status: 409 }) : Response.json({ code: 'PAIRING_ONCE', expiresAt: Date.now() + 300000 });
    if (url === '/api/library/tokens/token-id') { revoked = true; return Response.json({ ok: true }); }
    return Response.json({}, { status: 404 });
  }));
  const session = new CookieSession(); await session.verify(); const state = session.snapshot();
  render(<StudioCapabilitiesProvider session={session} generation={state.generation} actor={account} capabilities={capabilities}><>{settings ? <StudioAccountSettings presentation="page" initialSection="about" initial={{} as AppConfig} onClose={() => {}} onPersist={() => {}} /> : <StudioLibrarySettings />}</></StudioCapabilitiesProvider>);
  if (!settings) await screen.findByText('My extension'); return { session, calls };
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('creates a short-lived code and lists/revokes redacted tokens through standard routes', async () => {
  const { calls } = await mount(); fireEvent.click(screen.getByTestId('studio-library-pair'));
  await screen.findByText('PAIRING_ONCE'); expect(document.body.textContent).toContain('Last used');
  fireEvent.click(screen.getByTestId('studio-library-revoke-token-id')); await screen.findByTestId('studio-library-empty');
  expect(calls).toContain('POST /api/library/pair'); expect(calls).toContain('DELETE /api/library/tokens/token-id');
});
it('withdraws a pairing code and token list synchronously on session loss', async () => {
  const { session } = await mount(); fireEvent.click(screen.getByTestId('studio-library-pair')); await screen.findByText('PAIRING_ONCE');
  session.withdraw(); await waitFor(() => expect(document.body.textContent).not.toMatch(/PAIRING_ONCE|My extension/));
});
it('shows a fixed localized refusal without provider prose or a stale pairing code', async () => {
  await mount(true); fireEvent.click(screen.getByTestId('studio-library-pair')); await screen.findByRole('alert');
  expect(document.body.textContent).not.toMatch(/SECRET_PROVIDER_TEXT|PAIRING_ONCE/);
});

it('discovers Library in the shared Settings frame with pairing, assets and no host sync control', async () => {
  const { calls } = await mount(false, true);
  fireEvent.click(screen.getByTestId('studio-settings-nav-library'));
  await screen.findByText('My extension'); expect(screen.getByTestId('studio-library-pair')).toBeTruthy();
  await waitFor(() => expect(calls).toContain('GET /api/library/assets'));
  expect(calls).not.toContain('POST /api/library/sync');
  expect(screen.queryByText('Sync')).toBeNull();
});

it('discards a late library file handoff after the session is withdrawn', async () => {
  let complete!: (file: File) => void;
  const deferred = new Promise<File>((resolve) => { complete = resolve; });
  vi.spyOn(registry, 'fetchLibraryAssetAsFile').mockReturnValue(deferred);
  const { session } = await mount(false, true, true);
  fireEvent.click(screen.getByTestId('studio-settings-nav-library'));
  await waitFor(() => expect(document.querySelector('[data-asset-id="asset-a"]')).toBeTruthy());
  fireEvent.keyDown(window, { key: 'a', ctrlKey: true });
  fireEvent.click(await screen.findByRole('button', { name: 'Chat to design' }));
  await waitFor(() => expect(registry.fetchLibraryAssetAsFile).toHaveBeenCalled());
  await act(async () => { session.withdraw(); complete(new File(['PRIVATE_CAPTURE_A'], 'reference.png', { type: 'image/png' })); await deferred; });
  expect(takeHomeComposerAssetSeed()).toBeNull();
});
