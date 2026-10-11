// @vitest-environment jsdom
// S67 repair 1 (review P2): the composer offers an applicable plugin that one
// execution source cannot run (media on personal Codex). It must disclose that
// restriction exactly as the Plugins page and CLI do: in the picker row (part
// of the focusable item's accessible name), in its preview, and on the
// applied-plugin chip. Ported from the reviewer's composer reproducer.
import { createRef } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { STUDIO_PARITY_LANES, type StudioRuntimeCapabilities } from '@open-design/contracts';
import { CookieSession } from '../../src/multiuser/session';
import { StudioCapabilitiesProvider } from '../../src/runtime/studio-capabilities';
import { ChatComposer, type ChatComposerHandle } from '../../src/components/ChatComposer';

vi.mock('../../src/analytics/provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/analytics/provider')>();
  return { ...actual, useAnalytics: () => ({ track: vi.fn() }) };
});

const actor = { id: 'A', username: 'A', role: 'user', active: true, passwordState: 'set', createdAt: 1, updatedAt: 1 } as const;
const capabilities = { schemaVersion: 1, shell: 'studio',
  executionSources: [{ source: 'personal_subscription', agentId: 'codex' }, { source: 'company_pool', agentId: 'openai' }],
  features: Object.fromEntries(STUDIO_PARITY_LANES.map(({ id }) => [id, { status: 'pilot', reason: 'Fixture' }])) } as unknown as StudioRuntimeCapabilities;
const restriction = [{ source: 'personal-codex', reasons: [{ code: 'atom', subject: 'media-image' }] }];
const media = { id: 'review-media', title: 'Review media plugin', version: '1.0.0', sourceKind: 'bundled', source: 'bundled:review-media',
  trust: 'bundled', capabilitiesGranted: [], fsPath: '', installedAt: 0, updatedAt: 0,
  manifest: { name: 'review-media', title: 'Review media plugin', version: '1.0.0', description: 'Image fixture', od: { kind: 'scenario', mode: 'image' } },
  availability: { applicable: true, reasons: [], sourceRestrictions: restriction } };
const everywhere = { ...media, id: 'review-everywhere', title: 'Everywhere plugin', source: 'bundled:review-everywhere',
  manifest: { ...media.manifest, name: 'review-everywhere', title: 'Everywhere plugin' }, availability: { applicable: true, reasons: [] } };
const applied = { ok: true, query: '', contextItems: [], inputs: [], assets: [], mcpServers: [], trust: 'bundled', capabilitiesGranted: [],
  capabilitiesRequired: [], projectMetadata: {}, projectId: 'review-project', snapshotId: 'snap-media', warnings: [], manifestSourceDigest: 'a'.repeat(64),
  sourceRestrictions: restriction,
  appliedPlugin: { snapshotId: 'snap-media', pluginId: 'review-media', pluginTitle: 'Review media plugin', pluginVersion: '1.0.0',
    manifestSourceDigest: 'a'.repeat(64), inputs: {}, resolvedContext: { items: [] }, capabilitiesGranted: [], capabilitiesRequired: [],
    assetsStaged: [], taskKind: 'new-generation', appliedAt: 0, connectorsRequired: [], connectorsResolved: [], mcpServers: [], status: 'fresh' } };

let session: CookieSession | null = null;
afterEach(() => { cleanup(); session?.dispose(); session = null; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function mountComposer() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/auth/me') return Response.json({ account: actor, studio: capabilities, studioRevision: 1 });
    if (url === '/api/plugins') return Response.json({ plugins: [media, everywhere] });
    if (url === '/api/plugins/review-media/apply' && init?.method === 'POST') return Response.json(applied);
    if (url === '/api/mcp/servers') return Response.json({ servers: [], templates: [] });
    if (url === '/api/connectors') return Response.json({ connectors: [] });
    if (url === '/api/projects') return Response.json({ projects: [] });
    return Response.json({});
  }));
  session = new CookieSession();
  await session.verify();
  const ref = createRef<ChatComposerHandle>();
  render(<StudioCapabilitiesProvider session={session} generation={session.snapshot().generation} actor={actor as never} capabilities={capabilities}>
    <ChatComposer ref={ref} projectId="review-project" projectFiles={[]} streaming={false} onEnsureProject={async () => 'review-project'}
      onSend={vi.fn()} onStop={vi.fn()} onOpenMcpSettings={vi.fn()} skills={[]} />
  </StudioCapabilitiesProvider>);
  act(() => ref.current?.openPluginsPanel());
  await waitFor(() => expect(screen.getAllByText('Review media plugin').length).toBeGreaterThan(0));
  return screen.getByTestId('composer-plugins-popup');
}

it('shows the same personal Codex restriction in the composer picker as on the Plugins page', async () => {
  const picker = await mountComposer();
  expect(picker.textContent).toContain('Not on Codex · personal subscription');
  expect(picker.textContent).toContain('media-image');
  // Keyboard and screen readers reach it on the focusable item itself.
  const row = within(picker).getByRole('menuitem', { name: /Review media plugin.*Not on Codex · personal subscription · Needs: media-image/ });
  expect(row.tagName).toBe('BUTTON');
  // A plugin every source runs carries no restriction.
  const plain = within(picker).getByRole('menuitem', { name: /Everywhere plugin/ });
  expect(plain.textContent).not.toContain('Not on');
  // The hovered preview repeats it.
  fireEvent.focus(row);
  expect(picker.querySelector('[data-plugin-id="review-media"]')?.textContent).toContain('Not on Codex · personal subscription');
});

it('keeps the restriction on the applied-plugin context chip', async () => {
  const picker = await mountComposer();
  fireEvent.click(within(picker).getByRole('menuitem', { name: /Review media plugin/ }));
  const chip = await waitFor(() => {
    const found = screen.queryByTestId('staged-contexts')?.querySelector('[data-staged-kind="plugin"]');
    expect(found).toBeTruthy();
    return found!;
  });
  expect(chip.textContent).toContain('Not on Codex · personal subscription · Needs: media-image');
  const open = within(chip as HTMLElement).getAllByRole('button')[0]!;
  expect(open.getAttribute('aria-label')).toContain('Not on Codex · personal subscription · Needs: media-image');
});
