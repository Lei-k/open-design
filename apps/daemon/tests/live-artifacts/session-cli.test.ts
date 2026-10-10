import { expect, it, vi } from 'vitest';
import { studioLiveArtifactCliRequest } from '../../src/live-artifacts/session-cli.js';

it.each([
  ['list', 'GET', '', ''], ['create', 'POST', '', ''], ['info', 'GET', '/artifact', ''],
  ['update', 'PATCH', '/artifact', ''], ['delete', 'DELETE', '/artifact', ''],
  ['refresh', 'POST', '/artifact/refresh', ''], ['history', 'GET', '/artifact/refreshes', ''],
  ['code', 'GET', '/artifact/preview', '&variant=rendered-source'],
])('plans %s against the same API as the viewer', async (command, method, suffix, query) => {
  const read = vi.fn(async () => '{"input":{"title":"Long prompt"},"templateHtml":"<h1>Hi</h1>"}');
  const args = [command, 'project / encoded', ...(suffix ? ['artifact'] : []), '--json',
    ...(['create', 'update'].includes(command) ? ['--prompt-file', '-'] : [])];
  const request = await studioLiveArtifactCliRequest(args, read);
  expect(request).toMatchObject({ method, path: `/api/live-artifacts${suffix}?projectId=project%20%2F%20encoded${query}`, json: true, text: command === 'code' });
  if (['create', 'update'].includes(command)) { expect(read).toHaveBeenCalledWith('-'); expect(request.body).toHaveProperty('templateHtml', '<h1>Hi</h1>'); }
  else expect(read).not.toHaveBeenCalled();
});

it.each([
  [], ['list'], ['list', 'project', 'extra'], ['create', 'project'], ['update', 'project', 'artifact'],
  ['delete', 'project', 'artifact', '--prompt-file', '-'], ['code', 'project', 'artifact', '--variant', 'rendered'],
  ['list', 'project', '--unknown'], ['list', 'project', '--daemon-url'], ['refresh', 'project', 'artifact', '--variant', 'template'],
])('rejects malformed CLI input: %j', async (...args) => {
  await expect(studioLiveArtifactCliRequest(args as string[], async () => '{}')).rejects.toThrow('Usage:');
});
