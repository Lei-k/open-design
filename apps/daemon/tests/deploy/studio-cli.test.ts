import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { runStudioDeployCli } from '../../src/deploy/studio-cli.js';
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('refuses argv tokens (inline too), and nonprivate files before any HTTP request', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const errors: string[] = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((value) => {
    errors.push(String(value));
    return true;
  });
  for (const args of [
    ['config', 'set', '--token', 'SECRET'],
    ['config', 'set', '--token=SECRET'],
    ['run', 'p', '--api-key', 'SECRET'],
  ])
    expect(await runStudioDeployCli(args, async () => 'http://fixture')).toBe(2);
  const root = mkdtempSync(path.join(tmpdir(), 's63-cli-'));
  try {
    const misplacedToken = 'S63-misplaced-argv-token-SECRET-9385';
    expect(
      await runStudioDeployCli(
        ['config', 'set', '--provider', 'vercel', '--revision', '0', '--token-file', path.join(root, misplacedToken)],
        async () => 'http://fixture',
      ),
    ).toBe(2);
    expect(errors.join('')).not.toContain(misplacedToken);
    const file = path.join(root, 'token');
    writeFileSync(file, 'SECRET_PRIVATE_TOKEN', { mode: 0o644 });
    expect(
      await runStudioDeployCli(
        ['config', 'set', '--provider', 'vercel', '--revision', '0', '--token-file', file],
        async () => 'http://fixture',
      ),
    ).toBe(2);
  } finally {
    rmSync(root, { recursive: true });
  }
  expect(fetch).not.toHaveBeenCalled();
});
it('private file config, clear/show and all record commands use standard endpoints with JSON', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, init) => {
      calls.push({ url: String(url), init });
      return Response.json({ configured: true, last4: '9234' });
    }),
  );
  const root = mkdtempSync(path.join(tmpdir(), 's63-cli-'));
  try {
    const file = path.join(root, 'token');
    writeFileSync(file, 'S63_CLI_PRIVATE_TOKEN_9234\n', { mode: 0o600 });
    expect(
      await runStudioDeployCli(
        ['config', 'set', '--provider', 'vercel', '--revision', '0', '--token-file', file, '--json'],
        async () => 'http://fixture',
      ),
    ).toBe(0);
    expect(JSON.parse(calls[0]!.init.body as string).token).toBe('S63_CLI_PRIVATE_TOKEN_9234');
    for (const op of ['show', 'clear'])
      expect(
        await runStudioDeployCli(
          ['config', op, '--provider', 'vercel', '--revision', '1', '--json'],
          async () => 'http://fixture',
        ),
      ).toBe(0);
    for (const op of ['run', 'list', 'status', 'check-link', 'redeploy', 'delete'])
      expect(await runStudioDeployCli([op, 'p', 'd', '--json'], async () => 'http://fixture')).toBe(0);
    expect(calls.map((c) => c.url)).toContain('http://fixture/api/projects/p/deployments/d/redeploy');
  } finally {
    rmSync(root, { recursive: true });
  }
});
