export const STUDIO_LIVE_ARTIFACT_USAGE = `Usage:
  od live-artifact list <projectId> [--json]
  od live-artifact create <projectId> --prompt-file <path|-> [--json]
  od live-artifact info|code|history|refresh|delete <projectId> <artifactId> [--json]
  od live-artifact update <projectId> <artifactId> --prompt-file <path|-> [--json]

Create/update accept JSON { "input": { ... }, "templateHtml": "..." }.
Document/template updates also require "expectedRevision" from info.
Code accepts --variant template|rendered-source (default: rendered-source).
Common options: --session-file <path>, --daemon-url <url>, --json.`;

/** Thin request planner shared by the real session CLI and its in-process contract tests. */
export async function studioLiveArtifactCliRequest(args: string[], read: (file: string) => Promise<string>): Promise<{
  method: string; path: string; body?: unknown; json: boolean; daemonUrl?: string; text: boolean;
}> {
  const [command, ...rest] = args; const positionals: string[] = []; const flags: Record<string, string> = {};
  let json = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--json') { json = true; continue; }
    if (['--prompt-file', '--daemon-url', '--variant'].includes(arg)) {
      const value = rest[++i]; if (!value || value.startsWith('--') || flags[arg] !== undefined) throw new Error(STUDIO_LIVE_ARTIFACT_USAGE);
      flags[arg] = value; continue;
    }
    if (arg.startsWith('-')) throw new Error(STUDIO_LIVE_ARTIFACT_USAGE);
    positionals.push(arg);
  }
  if (!command || !['list', 'create', 'info', 'code', 'history', 'refresh', 'delete', 'update'].includes(command)
    || positionals.length !== (['list', 'create'].includes(command) ? 1 : 2)
    || ['create', 'update'].includes(command) !== Boolean(flags['--prompt-file'])
    || flags['--variant'] !== undefined && (command !== 'code' || !['template', 'rendered-source'].includes(flags['--variant']))) {
    throw new Error(STUDIO_LIVE_ARTIFACT_USAGE);
  }
  const [project, id] = positionals;
  const suffix = command === 'code' ? '/preview' : command === 'history' ? '/refreshes' : command === 'refresh' ? '/refresh' : '';
  const query = `?projectId=${encodeURIComponent(project!)}${command === 'code' ? `&variant=${flags['--variant'] ?? 'rendered-source'}` : ''}`;
  const path = `/api/live-artifacts${id ? `/${encodeURIComponent(id)}${suffix}` : ''}${query}`;
  const body = flags['--prompt-file'] ? JSON.parse(await read(flags['--prompt-file'])) : undefined;
  return { method: command === 'create' || command === 'refresh' ? 'POST' : command === 'update' ? 'PATCH' : command === 'delete' ? 'DELETE' : 'GET',
    path, ...(body === undefined ? {} : { body }), json, text: command === 'code', ...(flags['--daemon-url'] ? { daemonUrl: flags['--daemon-url'] } : {}) };
}
