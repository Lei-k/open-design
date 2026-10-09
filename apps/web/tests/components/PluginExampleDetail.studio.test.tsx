// @vitest-environment jsdom
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import type { InstalledPluginRecord } from '@open-design/contracts';
import { PluginExampleDetail } from '../../src/components/plugin-details/PluginExampleDetail';

const mocks = vi.hoisted(() => ({ preview: vi.fn(), source: vi.fn(), example: vi.fn(), studio: { hostServices: false, actor: { id: 'A' }, generation: 1 } }));
vi.mock('../../src/providers/registry', () => ({ fetchStudioPluginPreview: mocks.preview, fetchPluginPreviewHtml: mocks.source, fetchPluginExampleHtml: mocks.example }));
vi.mock('../../src/runtime/studio-capabilities', () => ({ useStudioCapabilities: () => mocks.studio }));
const record = (id = 'demo'): InstalledPluginRecord => ({ id, title: id, version: '1.0.0', sourceKind: 'bundled', source: 'bundled', trust: 'bundled', capabilitiesGranted: [],
  fsPath: '', installedAt: 1, updatedAt: 1, manifest: { name: id, version: '1.0.0', od: { kind: 'scenario', preview: { type: 'html', entry: 'index.html' } } } });
const props = { record: record(), onClose() {}, onUse() {} };
beforeEach(() => { mocks.studio = { hostServices: false, actor: { id: 'A' }, generation: 1 }; mocks.preview.mockReset(); mocks.source.mockReset(); mocks.example.mockReset(); });
afterEach(cleanup);
it('opens the isolated descriptor URL in the existing modal with a script-only sandbox', async () => {
  mocks.preview.mockResolvedValue({ url: 'https://preview.test/api/multiuser/plugin-preview/scope/index.html' });
  const { container } = render(<PluginExampleDetail {...props} exampleStem="sample" />);
  await waitFor(() => expect(container.querySelector('iframe')?.getAttribute('src')).toContain('https://preview.test/'));
  const frame = container.querySelector('iframe')!;
  expect(frame.getAttribute('sandbox')).toBe('allow-scripts'); expect(frame.hasAttribute('srcdoc')).toBe(false);
  expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer'); expect(mocks.preview).toHaveBeenCalledWith('demo', 'sample');
  expect(mocks.source).not.toHaveBeenCalled(); expect(mocks.example).not.toHaveBeenCalled();
});
it('keeps source rendering for the local runtime', async () => {
  mocks.studio.hostServices = true; mocks.source.mockResolvedValue({ html: '<h1>Local</h1>' });
  const { container } = render(<PluginExampleDetail {...props} />);
  await waitFor(() => expect(container.querySelector('iframe')?.getAttribute('srcdoc')).toContain('Local'));
  expect(mocks.preview).not.toHaveBeenCalled();
});
it('shows shipped-preview absence and retries transient descriptor failures', async () => {
  mocks.preview.mockResolvedValueOnce(null);
  const { rerender, container } = render(<PluginExampleDetail {...props} />);
  await screen.findByTestId('preview-unavailable');
  mocks.preview.mockRejectedValueOnce(new Error('HTTP 503'));
  rerender(<PluginExampleDetail {...props} record={record('second')} />);
  const retry = await screen.findByRole('button', { name: /retry/i });
  mocks.preview.mockResolvedValue({ url: 'https://preview.test/recovered' }); fireEvent.click(retry);
  await waitFor(() => expect(container.querySelector('iframe')?.getAttribute('src')).toBe('https://preview.test/recovered'));
});
it('discards a previous actor generation response before showing the next account preview', async () => {
  let resolveOld!: (value: unknown) => void;
  mocks.preview.mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; }));
  const { container, rerender } = render(<PluginExampleDetail {...props} />);
  mocks.studio = { hostServices: false, actor: { id: 'B' }, generation: 2 }; mocks.preview.mockResolvedValue({ url: 'https://preview.test/new' });
  rerender(<PluginExampleDetail {...props} />);
  await waitFor(() => expect(container.querySelector('iframe')?.getAttribute('src')).toBe('https://preview.test/new'));
  await act(async () => { resolveOld({ url: 'https://preview.test/old' }); });
  expect(container.querySelector('iframe')?.getAttribute('src')).toBe('https://preview.test/new');
});
it('loads after StrictMode effect cleanup instead of accepting a discarded request', async () => {
  mocks.preview.mockResolvedValue({ url: 'https://preview.test/strict' });
  const { container } = render(<StrictMode><PluginExampleDetail {...props} /></StrictMode>);
  await waitFor(() => expect(container.querySelector('iframe')?.getAttribute('src')).toBe('https://preview.test/strict'));
});
