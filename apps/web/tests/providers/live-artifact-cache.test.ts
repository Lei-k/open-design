import { afterEach, expect, it, vi } from 'vitest';
import { deleteLiveArtifact, fetchLiveArtifacts, refreshLiveArtifact, updateLiveArtifact } from '../../src/providers/registry';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it.each(['refresh', 'update', 'delete'] as const)('reads the new list after a successful %s without expiring the share window', async (operation) => {
  vi.useFakeTimers();
  const initial = [{ id: 'live-1', title: 'Before' }];
  const updated = operation === 'delete' ? [] : [{ id: 'live-1', title: 'After' }];
  let list = initial;
  const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (!init?.method) return Response.json({ artifacts: list });
    list = updated;
    return Response.json({ artifact: updated[0], refresh: { status: 'succeeded' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  expect(await fetchLiveArtifacts('project')).toEqual(initial);
  expect(await fetchLiveArtifacts('other-project')).toEqual(initial);
  if (operation === 'refresh') await refreshLiveArtifact('project', 'live-1');
  else if (operation === 'delete') expect(await deleteLiveArtifact('project', 'live-1')).toBe(true);
  else await updateLiveArtifact('project', 'live-1', { title: 'After', status: 'active', pinned: false, preview: { type: 'html', entry: 'index.html' } });
  expect(await fetchLiveArtifacts('project')).toEqual(updated);
  expect(await fetchLiveArtifacts('other-project')).toEqual(initial);
  expect(fetchMock).toHaveBeenCalledTimes(4);
});
