export const PLUGIN_PREVIEW_USAGE = 'od plugin preview <id> [--example <name>] [--variant source|descriptor] [--json] [--daemon-url <url>]';

/** Read-only capability: no prompt input is needed. Source is also the single-user API shape. */
export function pluginPreviewCliRequest(args: string[]): { path: string; json: boolean; descriptor: boolean; daemonUrl?: string } {
  const positionals: string[] = []; const flags: Record<string, string> = {}; let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') { json = true; continue; }
    if (['--example', '--variant', '--daemon-url'].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith('--') || flags[arg] !== undefined) throw new Error(PLUGIN_PREVIEW_USAGE);
      flags[arg] = value; continue;
    }
    if (arg.startsWith('-')) throw new Error(PLUGIN_PREVIEW_USAGE);
    positionals.push(arg);
  }
  const variant = flags['--variant'] ?? 'source';
  if (positionals.length !== 1 || !['source', 'descriptor'].includes(variant)) throw new Error(PLUGIN_PREVIEW_USAGE);
  const suffix = flags['--example'] ? `example/${encodeURIComponent(flags['--example'])}` : 'preview';
  return { path: `/api/plugins/${encodeURIComponent(positionals[0]!)}/${suffix}?variant=${variant}`, json, descriptor: variant === 'descriptor',
    ...(flags['--daemon-url'] ? { daemonUrl: flags['--daemon-url'] } : {}) };
}
