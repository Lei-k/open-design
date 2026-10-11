// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { STUDIO_PARITY_LANES, buildSocialSharePayload, type AuthAccount, type StudioRuntimeCapabilities } from '@open-design/contracts';
import { CookieSession } from '../../src/multiuser/session';
import { StudioCapabilitiesProvider } from '../../src/runtime/studio-capabilities';
import { StudioCapabilityMessage, useStudioCapabilityState } from '../../src/runtime/StudioCapabilityState';
import { StudioExternalLink } from '../../src/runtime/StudioExternalLink';
import { NotificationsSection } from '../../src/components/NotificationsSection';
import { NewProjectPanel } from '../../src/components/NewProjectPanel';
import { StudioAccountSettings } from '../../src/runtime/StudioAccountSettings';
import { StudioAccountMenu } from '../../src/runtime/StudioAccountMenu';
import { StudioDeployMenu } from '../../src/runtime/StudioDeploy';
import { SocialShareGrid } from '../../src/components/SocialShareGrid';
import { FileViewer } from '../../src/components/FileViewer';
import { DEFAULT_CONFIG } from '../../src/state/config';
const account: AuthAccount = { id: 'a', username: 'pilot-a', role: 'user', active: true, passwordState: 'set', createdAt: 1, updatedAt: 1 };
const capabilities: StudioRuntimeCapabilities = { schemaVersion: 1, shell: 'studio', features: Object.fromEntries(
  STUDIO_PARITY_LANES.map(({ id }) => [id, { status: 'pilot', reason: 'Pilot' }]),
) as StudioRuntimeCapabilities['features'] };
let session: CookieSession;
let mediaListeners: (() => void)[];
let narrow = true;
beforeEach(() => {
  narrow = true; mediaListeners = [];
  vi.stubGlobal('innerWidth', 390); vi.stubGlobal('innerHeight', 844);
  vi.stubGlobal('matchMedia', () => ({ matches: narrow, addEventListener: (_: string, listener: () => void) => mediaListeners.push(listener), removeEventListener() {} }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('EventSource', class { addEventListener() {} removeEventListener() {} close() {} });
  vi.stubGlobal('fetch', vi.fn(async (input) => {
    const url = String(input);
    if (url === '/api/auth/me') return Response.json({ account, studio: capabilities, studioRevision: 1 });
    if (url === '/api/app-config') return Response.json({ revision: 0, config: { codexModel: { model: 'gpt-5', reasoning: 'default' }, customInstructions: '', notifications: DEFAULT_CONFIG.notifications } });
    if (url === '/api/codex-pets') return Response.json({ pets: [] });
    if (url.startsWith('/api/deploy/config')) return Response.json({ providerId: url.includes('cloudflare') ? 'cloudflare-pages' : 'vercel', configured: false, revision: 0 });
    if (url.endsWith('/deployments')) return Response.json({ deployments: [] });
    if (url === '/api/version') return Response.json({ version: { version: 'test', channel: 'test' } });
    return Response.json({});
  }));
});
afterEach(async () => { cleanup(); await session?.logout(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function mount(child: React.ReactNode, advertised = capabilities) {
  session = new CookieSession(); await session.verify();
  return render(<StudioCapabilitiesProvider session={session} actor={account} generation={session.snapshot().generation} capabilities={advertised}>{child}</StudioCapabilitiesProvider>);
}
it.each(['unsupported', 'denied', 'default'] as const)('notifications %s retain accessible reason and usable in-app alternative at 390px', async (permission) => {
  const request = vi.fn(async () => 'granted');
  vi.stubGlobal('Notification', permission === 'unsupported' ? undefined : { permission, requestPermission: request });
  await mount(<NotificationsSection cfg={{ ...DEFAULT_CONFIG, notifications: { ...DEFAULT_CONFIG.notifications!, desktopEnabled: false } }} setCfg={vi.fn()} />);
  const group = screen.getByRole('group', { name: 'Desktop notification' });
  const enable = within(group).getByRole('button', { name: 'active' });
  const described = document.getElementById(enable.getAttribute('aria-describedby')!);
  expect(described?.getAttribute('role')).toBe('status');
  expect(described?.textContent).toMatch(/results and activity/);
  expect((enable as HTMLButtonElement).disabled).toBe(permission !== 'default');
  if (permission === 'default') { fireEvent.click(enable); await waitFor(() => expect(request).toHaveBeenCalledOnce()); }
  else { fireEvent.click(enable); expect(request).not.toHaveBeenCalled(); }
});
it('unsupported folder entry offers actual plain-file upload and keeps ZIP import at 390px', async () => {
  const imported = vi.fn(async () => ({ ok: true }));
  await mount(<NewProjectPanel skills={[]} designSystems={[]} defaultDesignSystemId={null} templates={[]} promptTemplates={[]} onCreate={vi.fn()}
    onImportBrowserDirectory={imported} onImportClaudeDesign={vi.fn()} />);
  const folder = screen.getByTestId('import-browser-directory') as HTMLButtonElement;
  expect(folder.disabled).toBe(true);
  expect(document.getElementById(folder.getAttribute('aria-describedby')!)?.textContent).toMatch(/Upload files/);
  const files = screen.getByTestId('import-browser-files') as HTMLButtonElement;
  expect(files.disabled).toBe(false); expect(files.style.minHeight).toBe('40px');
  fireEvent.change(screen.getByTestId('browser-files-input'), { target: { files: [new File(['hello'], 'index.html')] } });
  await waitFor(() => expect(imported).toHaveBeenCalledOnce());
  expect(screen.getByText('Import Claude Design ZIP')).toBeTruthy();
});
it('narrow capability updates when media changes and native host ignores browser restrictions', async () => {
  function Probe() { return <StudioCapabilityMessage state={useStudioCapabilityState('pet')} />; }
  const view = await mount(<Probe />);
  expect(screen.getByRole('status').getAttribute('data-capability-state')).toBe('narrow-viewport-alternative');
  await act(async () => { narrow = false; mediaListeners.forEach((listener) => listener()); });
  expect(screen.queryByRole('status')).toBeNull();
  view.unmount(); render(<Probe />); expect(screen.queryByRole('status')).toBeNull();
});
it('About/version, pet and deploy settings remain reachable through the narrow Settings navigation', async () => {
  await mount(<StudioAccountSettings presentation="page" initialSection="about" initial={DEFAULT_CONFIG} onClose={vi.fn()} onPersist={vi.fn()} />);
  expect(screen.getByTestId('studio-about-clear-data')).toBeTruthy();
  fireEvent.click(screen.getByTestId('studio-about-check')); await screen.findByText('You are already on the latest version.');
  fireEvent.click(screen.getByTestId('studio-settings-nav-general'));
  await screen.findByTestId('studio-settings-pet');
  expect(screen.getByTestId('studio-instructions-save')).toBeTruthy();
  fireEvent.click(screen.getByTestId('studio-settings-nav-deploy'));
  await screen.findByText('Vercel');
});
it('account shell actions stay reachable at 390px and deploy disabled reasons are associated', async () => {
  await mount(<><StudioAccountMenu placement="page" /><StudioDeployMenu projectId="p" fileName="index.html" owner /></>);
  fireEvent.click(screen.getByTestId('studio-account-trigger'));
  expect(screen.getByRole('menuitem', { name: 'Settings' })).toBeTruthy();
  const deploy = (await screen.findByText('Vercel')).closest('button')!;
  expect(deploy.disabled).toBe(true);
  expect(document.getElementById(deploy.getAttribute('aria-describedby')!)?.textContent).toMatch(/Configure your own provider token/);
});
it('About exposes blocked browser storage while sign-out remains usable', async () => {
  vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => { throw new DOMException('Blocked', 'SecurityError'); });
  await mount(<StudioAccountSettings presentation="page" initialSection="about" initial={DEFAULT_CONFIG} onClose={vi.fn()} onPersist={vi.fn()} />);
  expect(screen.getAllByRole('status').some((status) => status.getAttribute('data-capability-state') === 'permission-denied')).toBe(true);
  expect((screen.getByTestId('studio-about-clear-data') as HTMLButtonElement).disabled).toBe(false);
});
it('external links retain secure new-tab and same-tab choices; custom protocols are refused', async () => {
  await mount(<><StudioExternalLink href="https://site.example/x">Site</StudioExternalLink><StudioExternalLink href="javascript:alert(1)">Bad</StudioExternalLink></>);
  expect(screen.getByRole('link', { name: 'Site' }).getAttribute('rel')).toBe('noopener noreferrer');
  expect(screen.getByRole('link', { name: 'Open in this tab' }).getAttribute('target')).toBeNull();
  expect(screen.queryByText('Bad')).toBeNull();
});
it('clipboard absence gives selectable manual copy', async () => {
  vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
  await mount(<SocialShareGrid share={buildSocialSharePayload({ kind: 'project-html', url: 'https://site.example/x' })} />);
  expect(screen.getByLabelText('Select the text and copy it manually.')).toBeTruthy();
  expect(screen.getAllByRole('status').some((status) => status.textContent?.includes('no Clipboard API'))).toBe(true);
});
it('minimal deployment keeps rendered export entries with reason and HTML/ZIP choices in FileViewer', async () => {
  await mount(<FileViewer projectId="p" projectKind="prototype" file={{ name: 'index.html', path: 'index.html', type: 'file', size: 10, mtime: 1, kind: 'html', mime: 'text/html' }} liveHtml="<html><body>Hi</body></html>" />);
  const exportButton = screen.getByRole('button', { name: 'Export' });
  fireEvent.click(exportButton);
  const pdf = await screen.findByRole('menuitem', { name: 'Export as PDF' });
  expect((pdf as HTMLButtonElement).disabled).toBe(true);
  expect(document.getElementById(pdf.getAttribute('aria-describedby')!)?.textContent).toMatch(/HTML and owned ZIP/);
  expect(screen.queryByRole('menuitem', { name: 'Export as PPTX' })).toBeNull();
  expect(screen.getByRole('menuitem', { name: 'Export as standalone HTML' })).toBeTruthy();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Download as .zip' }));
  await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/projects/p/archive', expect.objectContaining({ credentials: 'same-origin' })));
});

it('clipboard rejection exposes manual text without claiming copied', async () => {
  const clipboard = { writeText: vi.fn(async () => { throw new DOMException('Denied', 'NotAllowedError'); }) };
  vi.stubGlobal('navigator', { ...navigator, clipboard });
  Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn(() => false) });
  await mount(<SocialShareGrid share={buildSocialSharePayload({ kind: 'project-html', url: 'https://site.example/x' })} />);
  fireEvent.click(screen.getByRole('button', { name: 'Instagram' }));
  await screen.findByLabelText('Select the text and copy it manually.');
  expect(screen.getAllByRole('status').some((status) => status.textContent?.includes('Clipboard access was refused.'))).toBe(true);
  expect(screen.queryByText('Copied')).toBeNull();
});
// Port of independent reviewer PW-1–4. Copy remains retryable even when the
// capability message offers manual selection; the shared fallback is real.
it('PW-1 absent Clipboard API keeps legacy copy operable and reports its real result', async () => {
  vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
  const exec = vi.fn(() => true);
  Object.defineProperty(document, 'execCommand', { configurable: true, value: exec });
  await mount(<SocialShareGrid share={buildSocialSharePayload({ kind: 'project-html', url: 'https://site.example/x' })} />);
  const button = screen.getByRole('button', { name: 'Instagram' }) as HTMLButtonElement;
  expect(button.disabled).toBe(false);
  fireEvent.click(button);
  await screen.findByText('Copied');
  expect(exec).toHaveBeenCalledWith('copy');
});
it('PW-2 a failed copy permits retry and clears the failure after success', async () => {
  const writeText = vi.fn(async () => { throw new DOMException('Not focused', 'NotAllowedError'); });
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
  Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn(() => false) });
  await mount(<SocialShareGrid share={buildSocialSharePayload({ kind: 'project-html', url: 'https://site.example/x' })} />);
  fireEvent.click(screen.getByRole('button', { name: 'Instagram' }));
  await screen.findByLabelText('Select the text and copy it manually.');
  writeText.mockResolvedValue(undefined as never);
  const button = screen.getByRole('button', { name: 'Instagram' }) as HTMLButtonElement;
  expect(button.disabled).toBe(false);
  fireEvent.click(button);
  await screen.findByText('Copied');
  expect(screen.queryByLabelText('Select the text and copy it manually.')).toBeNull();
  expect(screen.queryByText(/Clipboard access was refused/)).toBeNull();
});
it('PW-3 Studio intent links preserve both share callbacks', async () => {
  const onShare = vi.fn(); const onAfterShare = vi.fn();
  await mount(<SocialShareGrid share={buildSocialSharePayload({ kind: 'project-html', url: 'https://site.example/x' })} onShare={onShare} onAfterShare={onAfterShare} />);
  fireEvent.click(screen.getByRole('link', { name: 'X' }));
  expect(onShare).toHaveBeenCalledWith('x');
  expect(onAfterShare).toHaveBeenCalledOnce();
});
it('PW-4 Studio Copied feedback expires after the existing 1.6 second timeout', async () => {
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn(async () => {}) } });
  await mount(<SocialShareGrid share={buildSocialSharePayload({ kind: 'project-html', url: 'https://site.example/x' })} />);
  fireEvent.click(screen.getByRole('button', { name: 'Instagram' }));
  await screen.findByText('Copied');
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1800)); });
  expect(screen.queryByText('Copied')).toBeNull();
  expect(screen.getByRole('button', { name: 'Instagram' })).toBeTruthy();
});
it('share link group has one popup advisory while every link retains a same-tab alternative', async () => {
  await mount(<SocialShareGrid share={buildSocialSharePayload({ kind: 'project-html', url: 'https://site.example/x' })} />);
  const notices = screen.getAllByRole('status').filter((status) => status.textContent?.includes('If a new tab does not open'));
  expect(notices).toHaveLength(1);
  const links = screen.getAllByRole('link', { name: 'Open in this tab' });
  expect(links.length).toBeGreaterThan(1);
  expect(links.every((link) => !link.getAttribute('target'))).toBe(true);
});
it.each(['http', 'network', 'browser'].flatMap((failure) => ['button', 'menu'].map((entry) => ({ failure, entry }))))('owned ZIP $failure failure from $entry has the correct retryable state', async ({ failure, entry }) => {
  const original = fetch;
  vi.stubGlobal('fetch', vi.fn(async (input, init) => String(input).endsWith('/archive')
    ? failure === 'network' ? Promise.reject(new TypeError('Network failed')) : failure === 'http' ? Response.json({}, { status: 503 }) : new Response('zip') : original(input, init)));
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => { throw new DOMException('Blocked', 'NotAllowedError'); });
  await mount(<FileViewer projectId="p" projectKind="prototype" file={{ name: 'index.html', path: 'index.html', type: 'file', size: 10, mtime: 1, kind: 'html', mime: 'text/html' }} liveHtml="<html><body>Hi</body></html>" />);
  if (entry === 'button') fireEvent.click(screen.getByTestId('download-project-archive'));
  else {
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Download as .zip' }));
  }
  await waitFor(() => {
    if (entry === 'menu') {
      expect(screen.getAllByRole('status').some((reason) => reason.getAttribute('data-capability-state') === (failure === 'browser' ? 'permission-denied' : 'retryable-error'))).toBe(true);
      return;
    }
    const reason = document.getElementById(screen.getByTestId('download-project-archive').getAttribute('aria-describedby')!);
    expect(reason?.getAttribute('data-capability-state')).toBe(failure === 'browser' ? 'permission-denied' : 'retryable-error');
  });
  expect((screen.getByTestId('download-project-archive') as HTMLButtonElement).disabled).toBe(false);
});
it('FileViewer keeps manual copy after brief button feedback expires', async () => {
  const ordinaryFetch = fetch;
  vi.stubGlobal('fetch', vi.fn(async (input, init) => String(input).includes('publish-public')
    ? Response.json({ publication: { url: 'https://site.example/x', slug: 'slot', fileName: 'index.html' } })
    : ordinaryFetch(input, init)));
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn(async () => { throw new DOMException('Denied', 'NotAllowedError'); }) } });
  Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn(() => false) });
  const file = { name: 'index.html', path: 'index.html', type: 'file' as const, size: 10, mtime: 1, kind: 'html' as const, mime: 'text/html' };
  await mount(<FileViewer projectId="p" projectKind="prototype" file={file} liveHtml="<html><body>Hi</body></html>" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Share' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Copy share link' }));
  await screen.findByLabelText('Select the text and copy it manually.');
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2000)); });
  expect(screen.getByLabelText('Select the text and copy it manually.')).toBeTruthy();
  expect(screen.getAllByRole('status').some((status) => status.textContent?.includes('Clipboard access was refused.'))).toBe(true);
});
it('narrow alternatives still render when media-query subscription APIs are absent', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  function Probe() { return <StudioCapabilityMessage state={useStudioCapabilityState('pet')} />; }
  await mount(<Probe />);
  expect(screen.getByRole('status').getAttribute('data-capability-state')).toBe('narrow-viewport-alternative');
});
