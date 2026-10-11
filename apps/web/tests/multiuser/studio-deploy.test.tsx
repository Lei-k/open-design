// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { STUDIO_PARITY_LANES, type AuthAccount, type StudioRuntimeCapabilities } from '@open-design/contracts';
import { CookieSession } from '../../src/multiuser/session';
import { StudioCapabilitiesProvider } from '../../src/runtime/studio-capabilities';
import { StudioDeploySettings, StudioDeployMenu } from '../../src/runtime/StudioDeploy';
const account: AuthAccount = {
  id: 'a',
  username: 'a',
  role: 'user',
  active: true,
  passwordState: 'set',
  createdAt: 1,
  updatedAt: 1,
};
const capabilities: StudioRuntimeCapabilities = {
  schemaVersion: 1,
  shell: 'studio',
  features: Object.fromEntries(
    STUDIO_PARITY_LANES.map(({ id }) => [id, { status: 'pilot', reason: 'Pilot' }]),
  ) as StudioRuntimeCapabilities['features'],
};
async function mount(child: React.ReactNode, configured = false) {
  const calls: { url: string; body: any }[] = [];
  let revision = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input, init) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(init.body) : undefined;
      calls.push({ url, body });
      if (url === '/api/auth/me')
        return Response.json({
          account,
          studio: capabilities,
          studioRevision: 1,
          studioMessageIdPrefix: 'mua_0123456789abcdef01234567_',
        });
      if (url.startsWith('/api/deploy/config')) {
        if (body) {
          configured = body.token !== null;
          revision++;
        }
        return Response.json({
          providerId: body?.providerId ?? (url.includes('cloudflare') ? 'cloudflare-pages' : 'vercel'),
          configured,
          last4: configured ? '9234' : null,
          revision,
        });
      }
      if (url.endsWith('/deployments')) return Response.json({ deployments: [] });
      return Response.json({});
    }),
  );
  const session = new CookieSession();
  await session.verify();
  const state = session.snapshot();
  render(
    <StudioCapabilitiesProvider
      session={session}
      actor={account}
      generation={state.generation}
      capabilities={state.studio!}
    >
      {child}
    </StudioCapabilitiesProvider>,
  );
  return { calls, session };
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('Settings tokens are password inputs cleared immediately on submit; configured state and clear work', async () => {
  await mount(<StudioDeploySettings />);
  await screen.findByText('Vercel');
  const input = screen.getAllByLabelText('Provider token')[0] as HTMLInputElement;
  expect(input.type).toBe('password');
  fireEvent.change(input, { target: { value: 'S63-web-token-9234' } });
  fireEvent.submit(input.closest('form')!);
  expect(input.value).toBe('');
  await screen.findAllByText(/Configured/);
  expect(document.body.textContent).not.toContain('S63-web-token-9234');
  fireEvent.click(screen.getAllByText('Clear token')[0]!);
  await screen.findAllByText('No token configured');
});
it('Share menu exposes missing-token reason with disabled deploy controls', async () => {
  await mount(<StudioDeployMenu projectId="p" fileName="index.html" owner />);
  await screen.findByText('Vercel');
  expect((screen.getByText('Vercel').closest('button') as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getAllByText(/Configure your own provider token/)).toHaveLength(2);
});
it('edit grantees get owner-only reason and issue no deploy/history requests', async () => {
  const { calls } = await mount(<StudioDeployMenu projectId="p" fileName="index.html" owner={false} />);
  expect(screen.getByText(/Only the project owner/)).toBeTruthy();
  expect(calls.filter((c) => c.url.includes('/deploy'))).toEqual([]);
});
it('configured owners can deploy and see bounded progress', async () => {
  const { calls } = await mount(<StudioDeployMenu projectId="p" fileName="index.html" owner />, true);
  await screen.findByText('Vercel');
  fireEvent.click(screen.getByText('Vercel'));
  await waitFor(() =>
    expect(calls.some((c) => c.url === '/api/projects/p/deploy' && c.body.providerId === 'vercel')).toBe(true),
  );
});

it('history-full deploy errors show the localized actionable cap message', async () => {
  await mount(<StudioDeployMenu projectId="p" fileName="index.html" owner />, true);
  await screen.findByText('Vercel');
  const original = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (input, init) => String(input).endsWith('/deploy')
    ? Response.json({ error: { code: 'MULTIUSER_DEPLOY_HISTORY_FULL', message: 'untrusted provider text' } }, { status: 409 })
    : original(input, init)));
  fireEvent.click(screen.getByText('Vercel'));
  expect((await screen.findByRole('alert')).textContent)
    .toBe('Deployment history is full (100 records). Delete a deployment record before deploying again.');
});
