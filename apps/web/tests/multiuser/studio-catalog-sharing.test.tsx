// @vitest-environment jsdom
// #61/#65: team catalogs. The owner of a private skill or design document
// shares it for use from the same Share dialog projects use (one role, so no
// role picker); a grantee sees who has access and may remove it. The entry
// exists only where the session has the catalogs and collaboration lanes.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { STUDIO_PARITY_LANES, type AuthAccount, type StudioCatalogAccessResponse, type StudioRuntimeCapabilities } from '@open-design/contracts';
import { CookieSession } from '../../src/multiuser/session';
import { StudioCapabilitiesProvider } from '../../src/runtime/studio-capabilities';
import { StudioCatalogShareButton } from '../../src/runtime/StudioShareDialog';
import { studioRequestAvailable } from '../../src/runtime/studio-transport';
import { ProjectShareBadge } from '../../src/components/ProjectShareBadge';

const account: AuthAccount = { id: 'A', username: 'alice', role: 'user', active: true, passwordState: 'set', createdAt: 1, updatedAt: 1 };
const capabilities = (lanes: readonly string[]): StudioRuntimeCapabilities => ({ schemaVersion: 1, shell: 'studio',
  features: Object.fromEntries(STUDIO_PARITY_LANES.map(({ id }) => [id, lanes.includes(id)
    ? { status: 'pilot', reason: 'Pilot' } : { status: 'unavailable', reason: 'Pending' }])) as StudioRuntimeCapabilities['features'] });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const base = '/api/multiuser/catalog/skills/studio-skill%3As1';
const access = (role: 'owner' | 'use', members: StudioCatalogAccessResponse['members']): StudioCatalogAccessResponse => ({
  kind: 'skill', resourceId: 'studio-skill:s1', role, self: members.find((member) => member.role === role)!,
  owner: members[0]!, members, shared: members.length > 1 });

async function mount(lanes: readonly string[], routes: (url: string, init?: RequestInit) => Response | undefined, props: Partial<Parameters<typeof StudioCatalogShareButton>[0]> = {}) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/auth/me') return Response.json({ account, studio: capabilities(lanes), studioRevision: 1, studioMessageIdPrefix: 'mua_0123456789abcdef01234567_' });
    calls.push({ method: init?.method ?? 'GET', url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return routes(url, init) ?? Response.json({}, { status: 404 });
  }));
  const session = new CookieSession();
  await session.verify();
  const state = session.snapshot();
  const onChanged = vi.fn();
  render(<StudioCapabilitiesProvider session={session} generation={state.generation} actor={account} capabilities={state.studio!}>
    <StudioCatalogShareButton kind="skill" resourceId="studio-skill:s1" onChanged={onChanged} {...props} />
  </StudioCapabilitiesProvider>);
  return { calls, onChanged, session };
}

it('opens use grants only with the catalogs and collaboration lanes', () => {
  const both = (lane: string) => lane === 'catalogs' || lane === 'collaboration';
  for (const segment of ['skills', 'design-systems']) {
    const item = `/api/multiuser/catalog/${segment}/x`;
    expect(studioRequestAvailable('GET', `${item}/access`, both as never)).toBe(true);
    expect(studioRequestAvailable('DELETE', `${item}/access`, both as never)).toBe(true);
    expect(studioRequestAvailable('PUT', `${item}/shares`, both as never)).toBe(true);
    expect(studioRequestAvailable('DELETE', `${item}/shares/acct`, both as never)).toBe(true);
    expect(studioRequestAvailable('GET', `${item}/access`, ((lane: string) => lane === 'catalogs') as never)).toBe(false);
    expect(studioRequestAvailable('PUT', `${item}/shares`, ((lane: string) => lane === 'collaboration') as never)).toBe(false);
    expect(studioRequestAvailable('POST', `${item}/shares`, both as never)).toBe(false);
    expect(studioRequestAvailable('PUT', `${item}/access`, both as never)).toBe(false);
    expect(studioRequestAvailable('GET', `${item}/shares/acct`, both as never)).toBe(false);
  }
  // Vela team sharing stays closed for Studio accounts.
  expect(studioRequestAvailable('POST', '/api/workspace/skills/x/share', () => true)).toBe(false);
});

it('lets the owner grant use by username and revoke, without a role picker', async () => {
  let members: StudioCatalogAccessResponse['members'] = [{ accountId: 'A', username: 'alice', role: 'owner' }];
  const { calls, onChanged, session } = await mount(['catalogs', 'collaboration'], (url, init) => {
    if (url === `${base}/access`) return Response.json(access('owner', members));
    if (url === `${base}/shares` && init?.method === 'PUT') {
      members = [...members, { accountId: 'B', username: 'bob', role: 'use', grantedAt: 2 }];
      return Response.json({ member: members[1] });
    }
    if (url === `${base}/shares/B` && init?.method === 'DELETE') { members = members.slice(0, 1); return Response.json({ ok: true }); }
    return undefined;
  });
  expect(calls).toEqual([]);
  fireEvent.click(screen.getByTestId('studio-catalog-share-button'));
  await waitFor(() => expect(screen.getAllByTestId('studio-share-member')).toHaveLength(1));
  expect(screen.getByText('Share skill')).toBeTruthy();
  expect(screen.queryByTestId('studio-share-role')).toBeNull();
  fireEvent.change(screen.getByTestId('studio-share-username'), { target: { value: ' bob ' } });
  await act(async () => { fireEvent.click(screen.getByTestId('studio-share-submit')); });
  await waitFor(() => expect(screen.getAllByTestId('studio-share-member')).toHaveLength(2));
  expect(calls.find((call) => call.method === 'PUT')).toEqual({ method: 'PUT', url: `${base}/shares`, body: { username: 'bob', role: 'use' } });
  expect(screen.getByText('Can use')).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByTestId('studio-share-revoke')); });
  await waitFor(() => expect(screen.getAllByTestId('studio-share-member')).toHaveLength(1));
  fireEvent.click(screen.getByText('Close'));
  expect(onChanged).toHaveBeenCalled();
  session.dispose();
});

it('shows a grantee who has access and lets it remove the item from its catalog', async () => {
  const { calls, onChanged, session } = await mount(['catalogs', 'collaboration'], (url, init) => {
    if (url === `${base}/access` && (init?.method ?? 'GET') === 'GET') return Response.json(access('use', [{ accountId: 'O', username: 'olga', role: 'owner' }, { accountId: 'A', username: 'alice', role: 'use', grantedAt: 2 }]));
    if (url === `${base}/access` && init?.method === 'DELETE') return Response.json({ ok: true });
    return undefined;
  }, { share: { role: 'use', ownerUsername: 'olga', memberCount: 2 } });
  expect(screen.getByTestId('studio-catalog-share-button').textContent).toBe('Can use');
  fireEvent.click(screen.getByTestId('studio-catalog-share-button'));
  await waitFor(() => expect(screen.getAllByTestId('studio-share-member')).toHaveLength(2));
  expect(screen.queryByTestId('studio-share-username')).toBeNull();
  expect(screen.queryByTestId('studio-share-revoke')).toBeNull();
  await act(async () => { fireEvent.click(screen.getByTestId('studio-share-leave')); });
  await waitFor(() => expect(onChanged).toHaveBeenCalled());
  expect(calls.some((call) => call.method === 'DELETE' && call.url === `${base}/access`)).toBe(true);
  session.dispose();
});

it('renders no share entry without the collaboration lane', async () => {
  const { calls, session } = await mount(['catalogs'], () => undefined);
  expect(screen.queryByTestId('studio-catalog-share-button')).toBeNull();
  expect(calls).toEqual([]);
  session.dispose();
});

it('marks shared catalog entries for owners and grantees', () => {
  render(<>
    <ProjectShareBadge project={{ studioShare: { role: 'use', ownerUsername: 'olga', memberCount: 3 } }} testId="catalog-share-badge" />
    <ProjectShareBadge project={{ studioShare: { role: 'owner', ownerUsername: 'alice', memberCount: 3 } }} testId="own-share-badge" />
    <ProjectShareBadge project={{}} testId="no-share-badge" />
  </>);
  expect(screen.getByTestId('catalog-share-badge').textContent).toBe('Shared by olga');
  expect(screen.getByTestId('own-share-badge').textContent).toBe('Share · 3');
  expect(screen.queryByTestId('no-share-badge')).toBeNull();
});
