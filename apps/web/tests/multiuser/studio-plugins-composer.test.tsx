// @vitest-environment jsdom
// S67 repair 1 (review P2): the composer offers an applicable plugin that one
// execution source cannot run (media on personal Codex). It must disclose that
// restriction exactly as the Plugins page and CLI do: in the picker row (part
// of the focusable item's accessible name), in its preview, and on the
// applied-plugin chip. Ported from the reviewer's composer reproducer.
import { createRef, type ComponentProps } from 'react';
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

type Fixture = { plugins: unknown[]; pinned?: Record<string, unknown>; applyResponse?: typeof applied; onSend?: ComponentProps<typeof ChatComposer>['onSend'] };
async function mountComposer(fixture: Fixture = { plugins: [media, everywhere] }) {
  const handle = await mountComposerHandle(fixture);
  act(() => handle.current?.openPluginsPanel());
  await waitFor(() => expect(screen.getAllByText(/Review media plugin|Everywhere plugin/).length).toBeGreaterThan(0));
  return screen.getByTestId('composer-plugins-popup');
}

async function mountComposerHandle({ plugins, pinned = {}, applyResponse = applied, onSend = vi.fn() }: Fixture) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/auth/me') return Response.json({ account: actor, studio: capabilities, studioRevision: 1 });
    if (url === '/api/plugins') return Response.json({ plugins });
    const snapshot = /^\/api\/applied-plugins\/([^/?]+)$/.exec(url)?.[1];
    if (snapshot) return pinned[snapshot] ? Response.json(pinned[snapshot]) : Response.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
    if (/^\/api\/plugins\/[^/]+\/apply$/.test(url) && init?.method === 'POST') return Response.json(applyResponse);
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
      onSend={onSend} onStop={vi.fn()} onOpenMcpSettings={vi.fn()} skills={[]} />
  </StudioCapabilitiesProvider>);
  return ref;
}

const pluginChip = () => waitFor(() => {
  const found = screen.queryByTestId('staged-contexts')?.querySelector('[data-staged-kind="plugin"]');
  expect(found).toBeTruthy();
  return found as HTMLElement;
});

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

// S67 repair 2 (review P2): the applied chip discloses the application's
// pinned restrictions, which run admission enforces, not the current catalog's.
const v1Snapshot = { ...applied.appliedPlugin, snapshotId: 'snap-media-v1' };
const restoreApplied = (ref: Awaited<ReturnType<typeof mountComposerHandle>>, snapshot: typeof v1Snapshot) =>
  act(() => ref.current?.restoreDraft({ text: 'Make the hero image', meta: { appliedPluginSnapshot: snapshot as never,
    appliedPluginSnapshotId: snapshot.snapshotId } }));

it('keeps the pinned Codex restriction on a restored application after the catalog drops the media requirement', async () => {
  // v2 of the plugin runs everywhere; the restored v1 application still needs media-image.
  const v2 = { ...media, version: '2.0.0', availability: { applicable: true, reasons: [] } };
  const ref = await mountComposerHandle({ plugins: [v2, everywhere],
    pinned: { 'snap-media-v1': { ...v1Snapshot, sourceRestrictions: [{ source: 'personal-codex',
      reasons: [{ code: 'atom', subject: 'media-image' }, { code: 'capability', subject: 'media:image' }] }] } } });
  act(() => ref.current?.openPluginsPanel());
  const picker = await waitFor(() => screen.getByTestId('composer-plugins-popup'));
  // The picker describes the catalog's v2, which every source runs.
  await waitFor(() => expect(within(picker).getByRole('menuitem', { name: /Review media plugin/ }).textContent).not.toContain('Not on'));
  restoreApplied(ref, v1Snapshot);
  const chip = await pluginChip();
  await waitFor(() => expect(chip.textContent).toContain('Not on Codex · personal subscription · Needs: media-image, media:image'));
  expect(within(chip).getAllByRole('button')[0]!.getAttribute('aria-label'))
    .toContain('Not on Codex · personal subscription · Needs: media-image, media:image');
});

it('shows no restriction on a restored application its pin runs everywhere, whatever the catalog now says', async () => {
  const ref = await mountComposerHandle({ plugins: [media, everywhere], pinned: { 'snap-media-v1': { ...v1Snapshot } } });
  act(() => ref.current?.openPluginsPanel());
  // The catalog's current plugin is restricted, and the picker says so.
  await waitFor(() => expect(screen.getByTestId('composer-plugins-popup').textContent).toContain('Not on Codex · personal subscription'));
  restoreApplied(ref, v1Snapshot);
  const chip = await pluginChip();
  expect(chip.textContent).toContain('Review media plugin');
  expect(chip.textContent).not.toContain('Not on');
  // The chip asked the daemon for the pin; after it answers the catalog's restriction still never appears.
  await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url) === '/api/applied-plugins/snap-media-v1')).toBe(true));
  await act(async () => { await Promise.resolve(); });
  expect(chip.textContent).not.toContain('Not on');
});

it.each(['http', 'network'] as const)('restored pin %s failure is unknown and a bounded retry restores restrictions', async (failure) => {
  const ref = await mountComposerHandle({ plugins: [media] });
  const original = fetch;
  let attempts = 0;
  let recover = false;
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    if (String(url) !== '/api/applied-plugins/snap-media-v1') return original(url, init);
    attempts++;
    if (recover) return Response.json({ ...v1Snapshot, sourceRestrictions: restriction });
    if (failure === 'network') throw new TypeError('Network failed');
    return Response.json({}, { status: 503 });
  }));
  restoreApplied(ref, v1Snapshot);
  const chip = await pluginChip();
  await waitFor(() => expect(chip.textContent).toContain('Restrictions unknown'));
  expect(within(chip).getAllByRole('button')[0]!.getAttribute('aria-label')).toContain('Restrictions unknown');
  recover = true;
  await waitFor(() => expect(chip.textContent).toContain('Not on Codex · personal subscription · Needs: media-image'), { timeout: 4000 });
  expect(chip.textContent).not.toContain('Restrictions unknown');
  expect(attempts).toBe(2);
});
it('restored pin retries stop after three attempts and retain unknown restrictions', async () => {
  const ref = await mountComposerHandle({ plugins: [media] });
  restoreApplied(ref, v1Snapshot);
  const chip = await pluginChip();
  await waitFor(() => expect(chip.textContent).toContain('Restrictions unknown'));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 3300)); });
  expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === '/api/applied-plugins/snap-media-v1')).toHaveLength(3);
  expect(chip.textContent).toContain('Restrictions unknown');
});

// S70: entry-point component witness paired with the daemon catalog/HTTP
// specimens of these three newly applicable bundled plugins.
it.each(['example-article-magazine', 'example-dashboard', 'example-ve-terminal-mono'])('applies newly available %s and sends its pinned pipeline from Web', async (id) => {
  const plugin = { ...everywhere, id, title: id, source: `bundled:${id}`, manifest: { ...everywhere.manifest, name: id, title: id } };
  const pipeline = { stages: [{ id: 'generate', atoms: ['file-write', 'live-artifact'] },
    { id: 'critique', atoms: ['critique-theater'], repeat: true, until: 'critique.score>=4 || iterations>=3' }] };
  const response = { ...applied, query: 'Create the design', snapshotId: `snap-${id}`, sourceRestrictions: [],
    appliedPlugin: { ...applied.appliedPlugin, pluginId: id, pluginTitle: id, snapshotId: `snap-${id}`, pipeline } };
  const onSend = vi.fn();
  const ref = await mountComposerHandle({ plugins: [plugin], applyResponse: response, onSend });
  act(() => ref.current?.openPluginsPanel());
  const picker = await waitFor(() => screen.getByTestId('composer-plugins-popup'));
  const item = await waitFor(() => within(picker).getByRole('menuitem', { name: new RegExp(id) }));
  fireEvent.click(item);
  const chip = await pluginChip();
  expect(chip.textContent).toContain(id); expect(chip.textContent).not.toContain('Not available');
  await waitFor(() => expect((screen.getByTestId('chat-send') as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByTestId('chat-send'));
  await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
  const meta = onSend.mock.calls[0]![3];
  expect(meta.appliedPluginSnapshotId).toBe(`snap-${id}`);
  expect(meta.appliedPluginSnapshot.pipeline).toEqual(pipeline);
});
