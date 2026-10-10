export const STUDIO_LIVE_ARTIFACT_USAGE = `Usage:
  od live-artifact list <projectId> [--json]
  od live-artifact create <projectId> --prompt-file <path|-> [source options] [--json]
  od live-artifact info|code|history|refresh|delete <projectId> <artifactId> [--json]
  od live-artifact update <projectId> <artifactId> --prompt-file <path|-> [source options] [--json]

Create/update accept JSON { "input": { ... }, "templateHtml": "..." }.
Document/template updates also require "expectedRevision" from info.
Code accepts --variant template|rendered-source (default: rendered-source).

Source options (create/update; the JSON must carry input.document):
  --source-connector <connectorId>:<toolName>   read-only tool of your own connected app
  --source-mcp <serverId>:<toolName>            read-only tool of your own remote MCP server
  --confirm-read-only                           required with --source-mcp: you confirm the tool only reads
  --source-input-file <path|->                  JSON object of tool arguments (default {})
A connector/MCP source stores ids only. Refresh always runs with the refreshing
account's own connection or server; an existing outputMapping in the JSON is kept.

Common options: --session-file <path>, --daemon-url <url>, --json.`;

const VALUE_FLAGS = ['--prompt-file', '--daemon-url', '--variant', '--source-connector', '--source-mcp', '--source-input-file'];

/** Thin request planner shared by the real session CLI and its in-process contract tests. */
export async function studioLiveArtifactCliRequest(args: string[], read: (file: string) => Promise<string>): Promise<{
  method: string; path: string; body?: unknown; json: boolean; daemonUrl?: string; text: boolean;
}> {
  const [command, ...rest] = args; const positionals: string[] = []; const flags: Record<string, string> = {};
  let json = false; let confirmReadOnly = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--json') { json = true; continue; }
    if (arg === '--confirm-read-only') { if (confirmReadOnly) throw new Error(STUDIO_LIVE_ARTIFACT_USAGE); confirmReadOnly = true; continue; }
    if (VALUE_FLAGS.includes(arg)) {
      const value = rest[++i]; if (!value || value.startsWith('--') || flags[arg] !== undefined) throw new Error(STUDIO_LIVE_ARTIFACT_USAGE);
      flags[arg] = value; continue;
    }
    if (arg.startsWith('-')) throw new Error(STUDIO_LIVE_ARTIFACT_USAGE);
    positionals.push(arg);
  }
  const sourceFlag = flags['--source-connector'] ?? flags['--source-mcp'];
  const editing = command === 'create' || command === 'update';
  if (!command || !['list', 'create', 'info', 'code', 'history', 'refresh', 'delete', 'update'].includes(command)
    || positionals.length !== (['list', 'create'].includes(command) ? 1 : 2)
    || editing !== Boolean(flags['--prompt-file'])
    || flags['--variant'] !== undefined && (command !== 'code' || !['template', 'rendered-source'].includes(flags['--variant']))
    // One source at a time, only while editing; the read-only confirmation belongs to MCP sources.
    || flags['--source-connector'] !== undefined && flags['--source-mcp'] !== undefined
    || (sourceFlag !== undefined || flags['--source-input-file'] !== undefined || confirmReadOnly) && !editing
    || flags['--source-input-file'] !== undefined && sourceFlag === undefined
    || confirmReadOnly !== (flags['--source-mcp'] !== undefined)
    || flags['--prompt-file'] === '-' && flags['--source-input-file'] === '-') {
    throw new Error(STUDIO_LIVE_ARTIFACT_USAGE);
  }
  const [project, id] = positionals;
  const suffix = command === 'code' ? '/preview' : command === 'history' ? '/refreshes' : command === 'refresh' ? '/refresh' : '';
  const query = `?projectId=${encodeURIComponent(project!)}${command === 'code' ? `&variant=${flags['--variant'] ?? 'rendered-source'}` : ''}`;
  const path = `/api/live-artifacts${id ? `/${encodeURIComponent(id)}${suffix}` : ''}${query}`;
  let body = flags['--prompt-file'] ? JSON.parse(await read(flags['--prompt-file'])) as unknown : undefined;
  if (sourceFlag !== undefined) body = await withToolSource(body, flags, read);
  return { method: command === 'create' || command === 'refresh' ? 'POST' : command === 'update' ? 'PATCH' : command === 'delete' ? 'DELETE' : 'GET',
    path, ...(body === undefined ? {} : { body }), json, text: command === 'code', ...(flags['--daemon-url'] ? { daemonUrl: flags['--daemon-url'] } : {}) };
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Replace input.document.sourceJson with the connector/MCP descriptor the flags name (ids only). */
async function withToolSource(body: unknown, flags: Record<string, string>, read: (file: string) => Promise<string>): Promise<unknown> {
  const document = object(body) && object(body.input) && object(body.input.document) ? body.input.document : null;
  if (!document) throw new Error(`${STUDIO_LIVE_ARTIFACT_USAGE}\n\nA source option needs input.document in the --prompt-file JSON.`);
  const connector = flags['--source-connector'] !== undefined;
  const match = /^([a-z0-9][a-z0-9_-]{0,63}):([A-Za-z0-9_.-]{1,265})$/.exec(connector ? flags['--source-connector']! : flags['--source-mcp']!);
  if (!match) throw new Error(STUDIO_LIVE_ARTIFACT_USAGE);
  const input = flags['--source-input-file'] ? JSON.parse(await read(flags['--source-input-file'])) as unknown : {};
  if (!object(input)) throw new Error(`${STUDIO_LIVE_ARTIFACT_USAGE}\n\n--source-input-file must contain a JSON object.`);
  const previous = object(document.sourceJson) ? document.sourceJson : {};
  const [, sourceId, tool] = match;
  const sourceJson = {
    ...(connector ? { type: 'connector_tool', connector: { connectorId: sourceId, toolName: tool!.includes('.') ? tool : `${sourceId}.${tool}` } }
      : { type: 'mcp_tool', mcp: { serverId: sourceId, toolName: tool, readOnlyConfirmed: true } }),
    input, refreshPermission: 'manual_refresh_granted_for_read_only',
    ...(previous.outputMapping !== undefined ? { outputMapping: previous.outputMapping } : {}),
  };
  return { ...(body as Record<string, unknown>), input: { ...(body as { input: Record<string, unknown> }).input, document: { ...document, sourceJson } } };
}
