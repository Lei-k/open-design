// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { importBrowserDirectory } from '../../src/state/projects';
afterEach(() => vi.unstubAllGlobals());
it('plain file fallback works when the browser File has no webkitRelativePath', async () => {
  const upload = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ project: { id: 'owned' } }));
  vi.stubGlobal('fetch', upload);
  const file = new File(['<p>hello</p>'], 'index.html');
  Object.defineProperty(file, 'webkitRelativePath', { value: undefined });
  await expect(importBrowserDirectory([file])).resolves.toMatchObject({ project: { id: 'owned' } });
  expect(upload.mock.calls[0]?.[0]).toBe('/api/import/files');
  const form = (upload.mock.calls[0]?.[1] as RequestInit).body as FormData;
  expect((form.get('files') as File).name).toBe('index.html');
});
