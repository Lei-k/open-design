// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
