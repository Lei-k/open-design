import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';

class DeployCliInputError extends Error {}

/** od deploy control plane; argv secrets are refused before making any request. */
export async function runStudioDeployCli(
  args: string[],
  resolveBase: (flags: Record<string, string>) => Promise<string>,
): Promise<number> {
  const flags: Record<string, string> = {};
  const positionals: string[] = [];
  try {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (arg === '--json') continue;
      if (arg === '--help' || arg === '-h') {
        console.log(
          'od deploy config set|show|clear --provider vercel|cloudflare-pages --revision N [--token-file path|-]\nod deploy run|list|status|check-link|redeploy|delete PROJECT [DEPLOYMENT] [--file index.html] [--json]',
        );
        return 0;
      }
      if (arg.startsWith('--')) {
        const [name, inline] = arg.split('=', 2);
        if (
          ![
            '--provider',
            '--revision',
            '--token-file',
            '--file',
            '--target',
            '--team-id',
            '--team-slug',
            '--account-id',
            '--project-name',
            '--daemon-url',
          ].includes(name!)
        )
          throw new DeployCliInputError('Invalid deploy option; tokens must use --token-file or stdin.');
        const value = inline ?? args[++i];
        if (!value || value.startsWith('--')) throw new DeployCliInputError('Deploy option requires a value.');
        flags[name!.slice(2)] = value;
      } else positionals.push(arg);
    }
    const [command, id, record] = positionals;
    const expected = ['status', 'check-link', 'redeploy', 'delete'].includes(command ?? '') ? 3 : 2;
    if (positionals.length !== expected) throw new DeployCliInputError('Unexpected deploy arguments.');
    let method = 'GET';
    let route = '';
    let body: Record<string, unknown> | undefined;
    if (command === 'config') {
      if (
        !['set', 'show', 'clear'].includes(id ?? '') ||
        !['vercel', 'vercel-self', 'cloudflare-pages'].includes(flags.provider ?? '')
      )
        throw new DeployCliInputError('Invalid deploy config command or provider.');
      route = `/api/deploy/config?providerId=${encodeURIComponent(flags.provider!)}`;
      if (id !== 'show') {
        if (!/^\d+$/.test(flags.revision ?? '')) throw new DeployCliInputError('--revision is required.');
        body = { providerId: flags.provider, revision: Number(flags.revision) };
        method = 'PUT';
        if (id === 'clear') body.token = null;
        else {
          const file = flags['token-file'];
          if (!file) throw new DeployCliInputError('--token-file path|- is required; argv tokens are refused.');
          let raw = '';
          if (file === '-') {
            if (process.stdin.isTTY) throw new DeployCliInputError('Pipe the token on stdin.');
            let size = 0;
            for await (const c of process.stdin) {
              size += Buffer.byteLength(c);
              if (size > 4097) throw new DeployCliInputError('Token input too large.');
              raw += String(c);
            }
          } else {
            const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
            try {
              const st = fstatSync(fd);
              if (
                !st.isFile() ||
                st.nlink !== 1 ||
                st.size > 4097 ||
                st.mode & 0o077 ||
                (process.getuid && st.uid !== process.getuid())
              )
                throw new DeployCliInputError('Token file must be private (0600) and owned by this user.');
              raw = readFileSync(fd, 'utf8');
            } finally {
              closeSync(fd);
            }
          }
          body.token = raw.replace(/\r?\n$/, '');
          for (const [flag, key] of [
            ['team-id', 'teamId'],
            ['team-slug', 'teamSlug'],
            ['account-id', 'accountId'],
            ['project-name', 'projectName'],
          ] as const)
            if (flags[flag] !== undefined) body[key] = flags[flag];
        }
      }
    } else {
      if (!id || !['run', 'list', 'status', 'check-link', 'redeploy', 'delete'].includes(command ?? ''))
        throw new DeployCliInputError('Invalid deploy command.');
      const base = `/api/projects/${encodeURIComponent(id)}`;
      if (command === 'run') {
        route = `${base}/deploy`;
        method = 'POST';
        body = {
          fileName: flags.file ?? 'index.html',
          providerId: flags.provider ?? 'vercel',
          ...(flags.target ? { target: flags.target } : {}),
        };
      } else if (command === 'list') route = `${base}/deployments`;
      else {
        if (!record) throw new DeployCliInputError('Deployment id required.');
        route = `${base}/deployments/${encodeURIComponent(record)}`;
        if (command === 'delete') method = 'DELETE';
        else {
          route += `/${command}`;
          method = 'POST';
          body = {};
        }
      }
    }
    const base = await resolveBase(flags);
    const response = await fetch(`${base}${route}`, {
      method,
      ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    const data = await response.json();
    process[response.ok ? 'stdout' : 'stderr'].write(`${JSON.stringify(data)}\n`);
    return response.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ error: { code: 'DEPLOY_CLI_INPUT', message: error instanceof DeployCliInputError ? error.message : 'Deploy command failed; check the session and private token input.' } })}\n`,
    );
    return 2;
  }
}
