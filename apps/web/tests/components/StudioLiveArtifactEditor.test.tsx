// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { LiveArtifact } from '@open-design/contracts';
import { StudioLiveArtifactEditor } from '../../src/components/StudioLiveArtifactEditor';
import { studioRequestAvailable } from '../../src/runtime/studio-transport';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const artifact: LiveArtifact = { schemaVersion: 1, id: 'live-fixture', projectId: 'project', title: 'Sales', slug: 'sales', pinned: false,
  preview: { type: 'html', entry: 'index.html' }, status: 'active', refreshStatus: 'never', createdAt: '2026-10-09', updatedAt: '2026-10-09', studioRevision: 1,
  document: { format: 'html_template_v1', templatePath: 'template.html', generatedPreviewPath: 'index.html', dataPath: 'data.json', dataJson: { total: 3 } } };
function mock(status = 200) {
  const calls: Array<{ url: string; method: string; body: any }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (!init?.method) return new Response('<h1>{{data.total}}</h1>');
    return Response.json(status === 200 ? { artifact } : { error: { message: 'live artifact changed; reopen the editor before saving' } }, { status });
  }));
  return calls;
}
it('creates an artifact from editable template/data and explicitly granted project JSON source', async () => {
  const calls = mock(); const saved = vi.fn();
  render(<StudioLiveArtifactEditor projectId="project" onClose={vi.fn()} onSaved={saved} />);
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Sales' } });
  fireEvent.change(screen.getByLabelText('Data'), { target: { value: '{"total":3}' } });
  fireEvent.change(screen.getByLabelText('Template HTML'), { target: { value: '<h1>{{data.total}}</h1>' } });
  fireEvent.change(screen.getByLabelText('Document source'), { target: { value: 'sales.json' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create' }));
  await waitFor(() => expect(saved).toHaveBeenCalledWith(artifact));
  expect(calls).toEqual([{ url: '/api/live-artifacts?projectId=project', method: 'POST', body: {
    input: { title: 'Sales', preview: artifact.preview, document: { ...artifact.document,
      sourceJson: { type: 'local_file', input: { path: 'sales.json' }, refreshPermission: 'manual_refresh_granted_for_read_only' } } },
    templateHtml: '<h1>{{data.total}}</h1>',
  } }]);
});
it('keeps invalid JSON local and retains daemon conflict errors in the editor', async () => {
  const calls = mock(409); const saved = vi.fn();
  render(<StudioLiveArtifactEditor projectId="project" onClose={vi.fn()} onSaved={saved} />);
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Sales' } });
  fireEvent.change(screen.getByLabelText('Data'), { target: { value: '[]' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create' }));
  expect(screen.getByRole('alert').textContent).toContain('JSON object'); expect(calls).toHaveLength(0);
  fireEvent.change(screen.getByLabelText('Data'), { target: { value: '{}' } }); fireEvent.click(screen.getByRole('button', { name: 'Create' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('reopen the editor')); expect(saved).not.toHaveBeenCalled();
});
it('loads the canonical template and keeps the original edit revision across live parent updates', async () => {
  const calls = mock(); const saved = vi.fn();
  const view = render(<StudioLiveArtifactEditor projectId="project" artifact={artifact} onClose={vi.fn()} onSaved={saved} />);
  await waitFor(() => expect((screen.getByLabelText('Template HTML') as HTMLTextAreaElement).value).toBe('<h1>{{data.total}}</h1>'));
  view.rerender(<StudioLiveArtifactEditor projectId="project" artifact={{ ...artifact, studioRevision: 2 }} onClose={vi.fn()} onSaved={saved} />);
  fireEvent.click(screen.getByRole('button', { name: 'Save' })); await waitFor(() => expect(saved).toHaveBeenCalled());
  expect(calls.at(-1)).toMatchObject({ method: 'PATCH', url: '/api/live-artifacts/live-fixture?projectId=project', body: { expectedRevision: 1 } });
});
it('opens only the reviewed data artifact routes, independently of paid media availability', () => {
  const usable = (lane: string) => ['files', 'preview'].includes(lane);
  expect(studioRequestAvailable('POST', '/api/live-artifacts', usable)).toBe(true);
  expect(studioRequestAvailable('GET', '/api/multiuser/live-artifacts/id/preview', usable)).toBe(true);
  expect(studioRequestAvailable('POST', '/api/tools/live-artifacts/create', usable)).toBe(false);
  expect(studioRequestAvailable('POST', '/api/live-artifacts/id/refresh', () => false)).toBe(false);
});

it('preserves an existing source mapping during editing and sends changed mappings through the shared endpoint', async () => {
  const calls = mock(); const saved = vi.fn();
  const outputMapping = { dataPaths: [{ from: 'report.total', to: 'total' }], transform: 'identity' as const };
  render(<StudioLiveArtifactEditor projectId="project" artifact={{ ...artifact, document: { ...artifact.document,
    sourceJson: { type: 'local_file', input: { path: 'sales.json' }, refreshPermission: 'manual_refresh_granted_for_read_only', outputMapping } } }} onClose={vi.fn()} onSaved={saved} />);
  await waitFor(() => expect((screen.getByLabelText('Template HTML') as HTMLTextAreaElement).value).toContain('data.total'));
  expect(JSON.parse((screen.getByLabelText('Output mapping (JSON)') as HTMLTextAreaElement).value)).toEqual(outputMapping);
  fireEvent.change(screen.getByLabelText('Output mapping (JSON)'), { target: { value: '{"transform":"metric_summary"}' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' })); await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect(calls.at(-1)?.body.input.document.sourceJson.outputMapping).toEqual({ transform: 'metric_summary' });
});

it('confirms deletion before issuing the shared DELETE request', async () => {
  const calls = mock(); const deleted = vi.fn();
  render(<StudioLiveArtifactEditor projectId="project" artifact={artifact} onClose={vi.fn()} onSaved={vi.fn()} onDeleted={deleted} />);
  await waitFor(() => expect((screen.getByLabelText('Template HTML') as HTMLTextAreaElement).value).toBe('<h1>{{data.total}}</h1>'));
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  expect(screen.getByRole('status').textContent).toContain('Sales'); expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Delete' })); await waitFor(() => expect(deleted).toHaveBeenCalledOnce());
  expect(calls.at(-1)).toMatchObject({ method: 'DELETE', url: '/api/live-artifacts/live-fixture?projectId=project' });
});

// S62: connector/MCP sources come only from the actor's own usable connections and servers.
const catalog = { connectors: [
  { connectorId: 'github', name: 'GitHub', available: true, tools: [{ name: 'github.github_search_repositories', title: 'Search repositories', readOnly: true },
    { name: 'github.github_create_issue', title: 'Create issue', readOnly: false }] },
  { connectorId: 'notion', name: 'Notion', available: false, reason: 'not_connected', tools: [] }],
  mcpServers: [{ serverId: 'mine', label: 'Docs', available: true }, { serverId: 'off', label: null, available: false, reason: 'disabled' }] };
function mockSources() {
  const calls: Array<{ url: string; method: string; body: any }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.startsWith('/api/multiuser/live-artifact-sources?')) return Response.json(catalog);
    if (url.includes('/live-artifact-sources/mcp/mine/tools')) return Response.json({ tools: [{ name: 'lookup', readOnly: true }, { name: 'write_row', readOnly: false }] });
    return Response.json({ artifact }, { status: init?.method === 'POST' ? 201 : 200 });
  }));
  return calls;
}
const fill = () => {
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Pipeline' } });
  fireEvent.change(screen.getByLabelText('Data'), { target: { value: '{"total":0}' } });
  fireEvent.change(screen.getByLabelText('Template HTML'), { target: { value: '<h1>{{data.total}}</h1>' } });
};
it('S62 offers the actor\'s own connected apps, marks unavailable apps and write tools, and saves an ids-only connector source', async () => {
  const calls = mockSources(); const saved = vi.fn();
  render(<StudioLiveArtifactEditor projectId="project" onClose={vi.fn()} onSaved={saved} toolSources={{ connectors: true, mcp: true }} />);
  fill();
  fireEvent.change(screen.getByRole('combobox', { name: 'Data source' }), { target: { value: 'connector' } });
  const app = await screen.findByRole('combobox', { name: 'My connected app' });
  await waitFor(() => expect(within(app).getByRole('option', { name: 'Notion — not connected' })).toHaveProperty('disabled', true));
  fireEvent.change(app, { target: { value: 'github' } });
  const tool = screen.getByRole('combobox', { name: 'Read-only tool' });
  expect(within(tool).getByRole('option', { name: 'Create issue — not read-only' })).toHaveProperty('disabled', true);
  fireEvent.change(tool, { target: { value: 'github.github_search_repositories' } });
  fireEvent.change(screen.getByLabelText('Tool arguments (JSON)'), { target: { value: '{"query":"open design"}' } });
  fireEvent.change(screen.getByLabelText('Output mapping (JSON)'), { target: { value: '{"dataPaths":[{"from":"total","to":"total"}]}' } });
  expect(screen.getByText(/person who refreshes/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Create' }));
  await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect(calls.at(-1)!.body.input.document.sourceJson).toEqual({ type: 'connector_tool', connector: { connectorId: 'github', toolName: 'github.github_search_repositories' },
    input: { query: 'open design' }, refreshPermission: 'manual_refresh_granted_for_read_only', outputMapping: { dataPaths: [{ from: 'total', to: 'total' }] } });
});
it('S62 MCP sources load tools from the actor\'s own server and require the read-only confirmation', async () => {
  const calls = mockSources(); const saved = vi.fn();
  render(<StudioLiveArtifactEditor projectId="project" onClose={vi.fn()} onSaved={saved} toolSources={{ connectors: false, mcp: true }} />);
  fill();
  const kind = screen.getByRole('combobox', { name: 'Data source' });
  expect(within(kind).queryByRole('option', { name: 'My connected app' })).toBeNull();
  fireEvent.change(kind, { target: { value: 'mcp' } });
  const server = await screen.findByRole('combobox', { name: 'My MCP server' });
  await waitFor(() => expect(within(server).getByRole('option', { name: 'off — disabled' })).toHaveProperty('disabled', true));
  fireEvent.change(server, { target: { value: 'mine' } });
  fireEvent.click(screen.getByRole('button', { name: 'Load tools' }));
  const tool = screen.getByRole('combobox', { name: 'Read-only tool' });
  await waitFor(() => expect(within(tool).getByRole('option', { name: 'write_row — not read-only' })).toHaveProperty('disabled', true));
  expect(calls.find((call) => call.url.includes('/tools'))).toMatchObject({ method: 'POST', url: '/api/multiuser/live-artifact-sources/mcp/mine/tools?projectId=project' });
  fireEvent.change(tool, { target: { value: 'lookup' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create' }));
  expect(screen.getByRole('alert').textContent).toContain('confirm'); expect(calls.some((call) => call.url.startsWith('/api/live-artifacts'))).toBe(false);
  fireEvent.click(screen.getByLabelText('I confirm this MCP tool only reads data'));
  fireEvent.click(screen.getByRole('button', { name: 'Create' }));
  await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect(calls.at(-1)!.body.input.document.sourceJson).toEqual({ type: 'mcp_tool', mcp: { serverId: 'mine', toolName: 'lookup', readOnlyConfirmed: true },
    input: {}, refreshPermission: 'manual_refresh_granted_for_read_only' });
});
it('S62 keeps a stored MCP source editable and offers no tool sources when the transport closes them', async () => {
  mockSources();
  const stored: LiveArtifact = { ...artifact, document: { ...artifact.document, sourceJson: { type: 'mcp_tool', mcp: { serverId: 'mine', toolName: 'lookup', readOnlyConfirmed: true },
    input: { q: 'x' }, refreshPermission: 'manual_refresh_granted_for_read_only' } } };
  render(<StudioLiveArtifactEditor projectId="project" artifact={stored} onClose={vi.fn()} onSaved={vi.fn()} toolSources={{ connectors: false, mcp: false }} />);
  expect((screen.getByRole('combobox', { name: 'Data source' }) as HTMLSelectElement).value).toBe('mcp');
  expect((screen.getByRole('combobox', { name: 'Read-only tool' }) as HTMLSelectElement).value).toBe('lookup');
  // S62 Repair 1: the confirmation is the saver's own, bound to their server instance — never pre-ticked.
  expect((screen.getByLabelText('I confirm this MCP tool only reads data') as HTMLInputElement).checked).toBe(false);
  cleanup();
  render(<StudioLiveArtifactEditor projectId="project" onClose={vi.fn()} onSaved={vi.fn()} toolSources={{ connectors: false, mcp: false }} />);
  expect(screen.queryByRole('combobox', { name: 'Data source' })).toBeNull();
});
it('S62 R1 an owner/editor reconfirms a stored MCP source by ticking the confirmation and saving', async () => {
  const calls = mockSources(); const saved = vi.fn();
  const stored: LiveArtifact = { ...artifact, document: { ...artifact.document, sourceJson: { type: 'mcp_tool', mcp: { serverId: 'mine', toolName: 'lookup', readOnlyConfirmed: true },
    input: { q: 'x' }, refreshPermission: 'manual_refresh_granted_for_read_only' } } };
  render(<StudioLiveArtifactEditor projectId="project" artifact={stored} onClose={vi.fn()} onSaved={saved} toolSources={{ connectors: false, mcp: true }} />);
  const save = await screen.findByRole('button', { name: 'Save' });
  await waitFor(() => expect(save).toHaveProperty('disabled', false));
  fireEvent.click(save);
  expect(screen.getByRole('alert').textContent).toContain('confirm');
  expect(calls.some((call) => call.method === 'PATCH')).toBe(false);
  fireEvent.click(screen.getByLabelText('I confirm this MCP tool only reads data'));
  fireEvent.click(save);
  await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  const patch = calls.find((call) => call.method === 'PATCH')!;
  expect(patch.url).toBe('/api/live-artifacts/live-fixture?projectId=project');
  expect(patch.body.expectedRevision).toBe(1);
  expect(patch.body.input.document.sourceJson).toEqual({ type: 'mcp_tool', mcp: { serverId: 'mine', toolName: 'lookup', readOnlyConfirmed: true },
    input: { q: 'x' }, refreshPermission: 'manual_refresh_granted_for_read_only' });
});
it('S62 opens the source routes only with files+preview and the matching capability', () => {
  const usable = (lane: string) => ['files', 'preview'].includes(lane);
  expect(studioRequestAvailable('GET', '/api/multiuser/live-artifact-sources', usable, false, false, true, false)).toBe(true);
  expect(studioRequestAvailable('GET', '/api/multiuser/live-artifact-sources', usable, false, false, false, false)).toBe(false);
  expect(studioRequestAvailable('POST', '/api/multiuser/live-artifact-sources/connector/github/tools', usable, false, false, true, false)).toBe(true);
  expect(studioRequestAvailable('POST', '/api/multiuser/live-artifact-sources/mcp/mine/tools', usable, false, false, true, false)).toBe(false);
  expect(studioRequestAvailable('POST', '/api/multiuser/live-artifact-sources/mcp/mine/tools', usable, false, false, false, true)).toBe(true);
  expect(studioRequestAvailable('POST', '/api/multiuser/live-artifact-sources/mcp/mine/tools', () => false, false, false, true, true)).toBe(false);
  expect(studioRequestAvailable('GET', '/api/multiuser/live-artifact-sources/mcp/mine/tools', usable, false, false, true, true)).toBe(false);
  expect(studioRequestAvailable('POST', '/api/multiuser/live-artifact-sources/other/mine/tools', usable, false, false, true, true)).toBe(false);
});
