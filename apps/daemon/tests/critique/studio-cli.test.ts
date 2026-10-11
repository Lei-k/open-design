import { spawn } from 'node:child_process';
import path from 'node:path';
import { expect, it } from 'vitest';
function cli(args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve('dist/cli.js'), 'critique', ...args], { env: { ...process.env, SHELL: '/bin/sh' }, timeout: 15000 });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (text) => { stdout += text; }); child.stderr.on('data', (text) => { stderr += text; });
    child.once('error', reject); child.once('close', (code) => resolve({ code, stdout, stderr })); child.stdin.end();
  });
}
it('documents Jury start/watch/interrupt/artifact and prompt-file', async () => {
  const result = await cli(['--help']);
  expect(result.code).toBe(0); expect(result.stdout).toContain('od critique start');
  for (const command of ['watch', 'interrupt', 'artifact', '--prompt-file', '--json']) expect(result.stdout).toContain(command);
});
it('refuses unknown flags and stray arguments before resolving a session or reading a prompt', async () => {
  for (const args of [['start', 'project', 'stray', '--prompt-file', 'missing'], ['start', 'project', '--api-key', 'PRIVATE-ARG-KEY']]) {
    const result = await cli([...args, '--json']);
    expect(result.code).not.toBe(0); expect(result.stdout + result.stderr).not.toContain('PRIVATE-ARG-KEY');
    expect(JSON.parse(result.stderr).error.code).toBe('CRITIQUE_CLI_INPUT');
  }
});
