// @vitest-environment jsdom
// #61 (S41): Web accounts read the bundled plugin catalog with server-computed
// availability. Unavailable plugins are listed with their reasons and never
// offered for apply; applicable plugins are applied from a project composer.
// Install, upgrade, marketplace changes, doctor and trust stay closed.
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { InstalledPluginRecordSchema, STUDIO_PARITY_LANES, type AuthAccount, type InstalledPluginRecord, type StudioRuntimeCapabilities } from '@open-design/contracts';
import { CookieSession } from '../../src/multiuser/session';
import { StudioCapabilitiesProvider } from '../../src/runtime/studio-capabilities';
import { studioRequestAvailable } from '../../src/runtime/studio-transport';
import { studioPluginAvailability, studioPluginOffered, studioPluginReasonTokens } from '../../src/runtime/studio-plugins';
import { PluginWebAvailability } from '../../src/components/PluginWebAvailability';
import { PluginDetailView } from '../../src/components/PluginDetailView';

vi.mock('../../src/analytics/provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/analytics/provider')>();
  return { ...actual, useAnalytics: () => ({ track: vi.fn() }) };
});

const account: AuthAccount = { id: 'A', username: 'alice', role: 'user', active: true, passwordState: 'set', createdAt: 1, updatedAt: 1 };
const capabilities = (lanes: readonly string[]): StudioRuntimeCapabilities => ({ schemaVersion: 1, shell: 'studio',
  features: Object.fromEntries(STUDIO_PARITY_LANES.map(({ id }) => [id, lanes.includes(id)
    ? { status: 'pilot', reason: 'Pilot' } : { status: 'unavailable', reason: 'Pending' }])) as StudioRuntimeCapabilities['features'] });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const record = (id: string, availability?: unknown): InstalledPluginRecord => ({
  ...InstalledPluginRecordSchema.parse({ id, title: id, version: '1.0.0', sourceKind: 'bundled', source: `bundled:${id}`, fsPath: '',
    installedAt: 0, updatedAt: 0, trust: 'bundled', capabilitiesGranted: [], manifest: { name: id, version: '1.0.0', title: id, od: { kind: 'scenario' } } }),
  ...(availability === undefined ? {} : { availability }),
} as InstalledPluginRecord);
const unavailable = { applicable: false, reasons: [{ code: 'atom', subject: 'live-artifact' }, { code: 'atom', subject: 'critique-theater' },
  { code: 'pipeline-devloop', subject: 'critique' }, { code: 'capability', subject: 'subprocess' }, { code: 'strategy' }] };

it('opens the catalog, apply, applied snapshots and read-only marketplaces only with the catalogs lane', () => {
  const catalogs = ((lane: string) => lane === 'catalogs') as never;
  for (const prefix of ['/api', '/api/multiuser/catalog']) {
    expect(studioRequestAvailable('GET', `${prefix}/plugins`, catalogs)).toBe(true);
    expect(studioRequestAvailable('GET', `${prefix}/plugins/od-share-to-community`, catalogs)).toBe(true);
    expect(studioRequestAvailable('POST', `${prefix}/plugins/od-share-to-community/apply`, catalogs)).toBe(true);
    expect(studioRequestAvailable('GET', `${prefix}/applied-plugins/snap-1`, catalogs)).toBe(true);
    expect(studioRequestAvailable('GET', `${prefix}/marketplaces`, catalogs)).toBe(true);
    expect(studioRequestAvailable('GET', `${prefix}/marketplaces/official/plugins`, catalogs)).toBe(true);
    expect(studioRequestAvailable('GET', `${prefix}/plugins`, (() => false) as never)).toBe(false);
    expect(studioRequestAvailable('POST', `${prefix}/plugins`, catalogs)).toBe(false);
    expect(studioRequestAvailable('GET', `${prefix}/plugins/x/apply`, catalogs)).toBe(false);
  }
  for (const [method, path] of [['POST', '/api/plugins/install'], ['POST', '/api/plugins/upload-zip'], ['POST', '/api/plugins/x/upgrade'],
    ['POST', '/api/plugins/x/uninstall'], ['POST', '/api/plugins/x/doctor'], ['POST', '/api/plugins/x/trust'], ['POST', '/api/plugins/x/apply-local'],
    ['POST', '/api/plugins/x/duplicate-project'], ['POST', '/api/marketplaces'], ['POST', '/api/marketplaces/official/refresh'],
    ['DELETE', '/api/marketplaces/official'], ['GET', '/api/plugins/stats'], ['GET', '/api/plugins/events'], ['GET', '/api/applied-plugins'],
    ['GET', '/api/plugins/x/preview']] as const) {
    expect(studioRequestAvailable(method, path, (() => true) as never), `${method} ${path}`).toBe(false);
  }
});

it('reads availability only from a well-formed Studio record and keeps desktop records offered', () => {
  expect(studioPluginAvailability(record('desktop'))).toBeNull();
  expect(studioPluginOffered(record('desktop'))).toBe(true);
  expect(studioPluginOffered(record('ok', { applicable: true, reasons: [] }))).toBe(true);
  expect(studioPluginOffered(record('no', unavailable))).toBe(false);
  expect(studioPluginAvailability(record('bad', { applicable: 'yes', reasons: [] }))).toBeNull();
  expect(studioPluginReasonTokens(unavailable.reasons as never)).toEqual(['live-artifact', 'critique-theater', 'critique ↻', 'subprocess', '+1']);
});

it('shows why a plugin is not available on Web, and where an applicable one is applied', () => {
  render(<>
    <PluginWebAvailability record={record('no', unavailable)} />
    <PluginWebAvailability record={record('ok', { applicable: true, reasons: [] })} />
    <PluginWebAvailability record={record('desktop')} />
  </>);
  const no = screen.getByTestId('plugin-web-availability-no');
  expect(no.getAttribute('data-applicable')).toBe('false');
  expect(no.textContent).toContain('Not available on Web');
  expect(no.textContent).toContain('live-artifact');
  expect(no.getAttribute('title')).toContain('OD Next strategy');
  expect(screen.getByTestId('plugin-web-availability-ok').textContent).toContain('project composer');
  expect(screen.queryByTestId('plugin-web-availability-desktop')).toBeNull();
});

it('replaces the Home hand-off Use button with Web availability on the plugin page for a Studio account', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/auth/me') return Response.json({ account, studio: capabilities(['shell', 'catalogs']), studioRevision: 1, studioMessageIdPrefix: 'mua_0123456789abcdef01234567_' });
    if (url === '/api/plugins/no') return Response.json(record('no', unavailable));
    return Response.json({}, { status: 404 });
  }));
  const session = new CookieSession();
  await session.verify();
  const state = session.snapshot();
  render(<StudioCapabilitiesProvider session={session} generation={state.generation} actor={account} capabilities={state.studio!}>
    <PluginDetailView pluginId="no" />
  </StudioCapabilitiesProvider>);
  await waitFor(() => expect(screen.getByTestId('plugin-web-availability-no')).toBeTruthy());
  expect(screen.queryByTestId('plugin-detail-use')).toBeNull();
});
