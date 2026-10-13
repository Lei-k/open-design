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

// S62: connector/MCP sources from the CLI store ids only and keep an existing mapping.
const promptWithMapping = JSON.stringify({ input: { title: 'Pipeline', preview: { type: 'html', entry: 'index.html' }, document: {
  format: 'html_template_v1', templatePath: 'template.html', generatedPreviewPath: 'index.html', dataPath: 'data.json', dataJson: { total: 0 },
  sourceJson: { type: 'local_file', input: { path: 'old.json' }, refreshPermission: 'manual_refresh_granted_for_read_only', outputMapping: { dataPaths: [{ from: 'a', to: 'b' }] } } } },
  templateHtml: '<h1>{{data.total}}</h1>' });
it('S62 --source-mcp with --confirm-read-only and --source-input-file plans an mcp_tool descriptor', async () => {
  const read = vi.fn(async (file: string) => file === 'args.json' ? '{"q":"pipeline"}' : promptWithMapping);
  const request = await studioLiveArtifactCliRequest(['create', 'p', '--prompt-file', '-', '--source-mcp', 'mine:lookup', '--confirm-read-only', '--source-input-file', 'args.json', '--json'], read);
  expect((request.body as any).input.document.sourceJson).toEqual({ type: 'mcp_tool', mcp: { serverId: 'mine', toolName: 'lookup', readOnlyConfirmed: true },
    input: { q: 'pipeline' }, refreshPermission: 'manual_refresh_granted_for_read_only', outputMapping: { dataPaths: [{ from: 'a', to: 'b' }] } });
});
it('S62 --source-connector accepts a bare or qualified tool name and defaults arguments to {}', async () => {
  for (const tool of ['github_search_repositories', 'github.github_search_repositories']) {
    const request = await studioLiveArtifactCliRequest(['update', 'p', 'a', '--prompt-file', 'body.json', '--source-connector', `github:${tool}`], async () => promptWithMapping);
    expect((request.body as any).input.document.sourceJson).toMatchObject({ type: 'connector_tool', connector: { connectorId: 'github', toolName: 'github.github_search_repositories' }, input: {} });
    expect(request.method).toBe('PATCH');
  }
});
it.each([
  ['create', 'p', '--prompt-file', 'f', '--source-mcp', 'mine:lookup'],
  ['create', 'p', '--prompt-file', 'f', '--source-connector', 'github:x', '--confirm-read-only'],
  ['create', 'p', '--prompt-file', 'f', '--source-connector', 'github:x', '--source-mcp', 'mine:lookup', '--confirm-read-only'],
  ['refresh', 'p', 'a', '--source-connector', 'github:x'],
  ['create', 'p', '--prompt-file', 'f', '--source-input-file', 'g'],
  ['create', 'p', '--prompt-file', '-', '--source-connector', 'github:x', '--source-input-file', '-'],
  ['create', 'p', '--prompt-file', 'f', '--source-mcp', 'Bad Id:x', '--confirm-read-only'],
])('S62 rejects malformed source options: %j', async (...args) => {
  await expect(studioLiveArtifactCliRequest(args as string[], async () => promptWithMapping)).rejects.toThrow('Usage:');
});
it('S62 a source option needs a document in the prompt JSON', async () => {
  await expect(studioLiveArtifactCliRequest(['update', 'p', 'a', '--prompt-file', 'f', '--source-connector', 'github:x'], async () => '{"input":{"title":"t"}}'))
    .rejects.toThrow('input.document');
});
