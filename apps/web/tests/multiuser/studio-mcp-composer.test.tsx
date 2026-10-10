// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { STUDIO_PARITY_LANES, type AuthAccount, type StudioRuntimeCapabilities } from '@open-design/contracts';
import { CookieSession } from '../../src/multiuser/session';
import { StudioCapabilitiesProvider } from '../../src/runtime/studio-capabilities';
import { ChatComposer } from '../../src/components/ChatComposer';
import { NewAutomationModal } from '../../src/components/NewAutomationModal';
import { typeAndSettle } from '../helpers/lexical-composer';
const actor: AuthAccount = { id: 'A', username: 'A', role: 'user', active: true, passwordState: 'set', createdAt: 1, updatedAt: 1 };
const capabilities: StudioRuntimeCapabilities = { schemaVersion: 1, shell: 'studio', mcpServers: true, connectors: true,
  executionSources: [{ source: 'company_pool', agentId: 'openai' }], features: Object.fromEntries(STUDIO_PARITY_LANES.map(({ id }) => [id, { status: 'pilot', reason: 'Pilot' }])) as StudioRuntimeCapabilities['features'] };
let session: CookieSession; let enabled = true;
afterEach(() => { cleanup(); session?.dispose(); vi.unstubAllGlobals(); });
async function mount(child: React.ReactNode) {
  const writes: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/auth/me') return Response.json({ account: actor, studio: capabilities, studioRevision: 1 });
    if (url === '/api/mcp/servers') return Response.json({ runs: { available: true }, servers: [
      { id: 'mine', label: 'My MCP', transport: 'http', url: 'https://mine.example.com', enabled, authMode: 'none', oauth: { status: 'not-required' } },
      { id: 'disabled', label: 'Disabled MCP', transport: 'http', enabled: false, authMode: 'none', oauth: { status: 'not-required' } },
      { id: 'needs', label: 'Unsigned MCP', transport: 'sse', enabled: true, authMode: 'oauth', oauth: { status: 'needs-auth' } },
    ], templates: [] });
    if (url === '/api/routines' && init?.method === 'POST') { const body = JSON.parse(String(init.body)); writes.push(body); return Response.json({ routine: { id: 'new', ...body } }); }
    if (url === '/api/connectors/discovery') return Response.json({ connectors: [] });
    if (url === '/api/connectors/composio/config') return Response.json({ configured: false });
    return Response.json([]);
  }));
  session = new CookieSession(); await session.verify();
  render(<StudioCapabilitiesProvider session={session} generation={session.snapshot().generation} actor={actor} capabilities={capabilities}>{child}</StudioCapabilitiesProvider>);
  return writes;
}
it('S61 composer stages only its usable MCP server and removes it after Settings disables it', async () => {
  enabled = true;
  await mount(<ChatComposer projectId="p" projectFiles={[]} streaming={false} skills={[]} onEnsureProject={async () => 'p'} onSend={vi.fn()} onStop={vi.fn()} />);
  fireEvent.focus(screen.getByTestId('chat-composer-input'));
  await typeAndSettle('@');
  await waitFor(() => expect(screen.getByText('My MCP')).toBeTruthy());
  expect(screen.queryByText('Disabled MCP')).toBeNull(); expect(screen.queryByText('Unsigned MCP')).toBeNull();
  expect(screen.getByTestId('studio-mcp-selection-unavailable').textContent).toContain('Settings');
  fireEvent.click(screen.getByText('My MCP'));
  await waitFor(() => expect(screen.getByTestId('staged-contexts').textContent).toContain('My MCP'));
  enabled = false; await act(async () => { window.dispatchEvent(new Event('studio-mcp-changed')); });
  await waitFor(() => expect(screen.queryByTestId('staged-contexts')?.textContent ?? '').not.toContain('My MCP'));
});
it('S61 routine editor offers only usable owner servers beside connectors and saves canonical selection', async () => {
  enabled = true;
  const writes = await mount(<NewAutomationModal open templates={[]} projects={[]} skills={[]} connectors={[]} onClose={() => {}} onSaved={() => {}} />);
  fireEvent.change(screen.getByTestId('automation-modal-title'), { target: { value: 'MCP task' } });
  const prompt = screen.getByTestId('automation-modal-prompt');
  fireEvent.change(prompt, { target: { value: 'Use @', selectionStart: 5 } });
  await waitFor(() => expect(screen.getByRole('option', { name: /My MCP/ })).toBeTruthy());
  expect(screen.queryByRole('option', { name: /Disabled MCP|Unsigned MCP/ })).toBeNull();
  expect(screen.getByRole('tab', { name: 'Connectors' })).toBeTruthy();
  expect(screen.getByTestId('studio-routine-mcp-unavailable').textContent).toContain('Settings');
  fireEvent.mouseDown(screen.getByRole('option', { name: /My MCP/ }));
  fireEvent.submit(screen.getByTestId('automation-modal').querySelector('form')!);
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]!.context).toMatchObject({ mcpServerIds: ['mine'] });
});
