// #7/#18 (user decision 2026-10-06): `multiuser-serve` is the one production entry
// that starts multi-user mode. It reads a config file (never an environment switch),
// binds loopback only, accepts exactly one https public origin, and leaves the
// company pool unavailable because it has no real provider yet (#14).
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MultiUserServeConfigError, parseMultiUserServeArgs, resolveMultiUserServeConfig,
} from '../../src/multiuser-serve.js';
import {
  MULTIUSER_NOT_LAUNCH_READY_ACK, MULTIUSER_STAGING_DEPLOYMENT_ACK, PERSONAL_CODEX_REAL_PROVIDER_ACK,
} from '../../src/services/multiuser-mode.js';

const SECRET = 'staging-bootstrap-secret-0123456789abcdef';
const base = { acknowledge: MULTIUSER_STAGING_DEPLOYMENT_ACK, publicOrigin: 'https://od.example.test',
  previewOrigin: 'https://preview.od.example.test' };

describe('config resolution', () => {
  it('turns a minimal config into loopback multi-user options with the company pool off', () => {
    expect(resolveMultiUserServeConfig({ ...base, bootstrapSecretFile: '/run/secrets/bootstrap' }, () => `${SECRET}\n`)).toEqual({
      port: 7456,
      publicOrigin: 'https://od.example.test',
      previewOrigin: 'https://preview.od.example.test',
      multiUser: { acknowledgeNotLaunchReady: MULTIUSER_NOT_LAUNCH_READY_ACK, allowedOrigins: ['https://od.example.test'],
        previewOrigin: 'https://preview.od.example.test',
        bootstrapSecret: SECRET },
    });
  });

  it('enables sandboxed personal Codex only when a binary and bwrap are given', () => {
    const resolved = resolveMultiUserServeConfig({ ...base, port: 8000,
      personalCodex: { binary: '/opt/codex/bin/codex', bwrap: '/usr/bin/bwrap' } });
    expect(resolved.port).toBe(8000);
    expect(resolved.multiUser).toMatchObject({
      bootstrapSecret: null,
      testPersonalCodexRealBinary: { path: '/opt/codex/bin/codex', acknowledge: PERSONAL_CODEX_REAL_PROVIDER_ACK },
      personalSandbox: { bwrapPath: '/usr/bin/bwrap' },
    });
  });

  it.each([
    ['a missing acknowledgement', { publicOrigin: base.publicOrigin }],
    ['the test-harness acknowledgement', { ...base, acknowledge: MULTIUSER_NOT_LAUNCH_READY_ACK }],
    ['a plain http origin', { ...base, publicOrigin: 'http://od.example.test' }],
    ['an origin with a path', { ...base, publicOrigin: 'https://od.example.test/app' }],
    ['a missing preview origin', { acknowledge: base.acknowledge, publicOrigin: base.publicOrigin }],
    ['a preview origin matching public', { ...base, previewOrigin: base.publicOrigin }],
    ['a preview origin sharing the cookie hostname', { ...base, previewOrigin: 'https://od.example.test:8443' }],
    ['a plain http preview origin', { ...base, previewOrigin: 'http://preview.od.example.test' }],
    ['a port out of range', { ...base, port: 70000 }],
    ['a relative secret path', { ...base, bootstrapSecretFile: 'secret.txt' }],
    ['a short bootstrap secret', { ...base, bootstrapSecretFile: '/run/secrets/bootstrap', short: true }],
    ['an unknown key', { ...base, bindHost: '0.0.0.0' }],
    ['a personalCodex without bwrap', { ...base, personalCodex: { binary: '/opt/codex/bin/codex' } }],
    ['a non-object config', ['nope']],
  ] as const)('refuses %s', (_name, raw) => {
    const short = (raw as { short?: boolean }).short === true;
    const config = Array.isArray(raw) ? raw : Object.fromEntries(Object.entries(raw).filter(([key]) => key !== 'short'));
    expect(() => resolveMultiUserServeConfig(config, () => (short ? 'too-short' : SECRET))).toThrow(MultiUserServeConfigError);
  });

  it('accepts only --config <file>', () => {
    expect(parseMultiUserServeArgs(['--config', '/etc/od.json'])).toBe('/etc/od.json');
    for (const argv of [[], ['--config'], ['--port', '1'], ['--config', 'a', 'b']]) {
      expect(() => parseMultiUserServeArgs(argv)).toThrow(MultiUserServeConfigError);
    }
  });
});

// ---- the launcher as a process ------------------------------------------------------

const children: ChildProcessWithoutNullStreams[] = [];
const scratch: string[] = [];
afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGKILL');
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

function launch(config: unknown, env: Record<string, string | undefined>) {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'od-mu-serve-'));
  scratch.push(dir);
  const configFile = path.join(dir, 'multiuser.json');
  fs.writeFileSync(configFile, JSON.stringify(config));
  const childEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: dir, ...env };
  for (const [key, value] of Object.entries(childEnv)) if (value === undefined) delete childEnv[key];
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/multiuser-serve.ts', '--config', configFile],
    { cwd: path.resolve('.'), env: childEnv });
  children.push(child);
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  return { dir, child, exited, output: () => output };
}

async function until(read: () => boolean, label: string, timeoutMs = 60_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!read()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('the launcher process', () => {
  it('serves multi-user mode on loopback, bootstraps one admin, and reports the company pool unavailable', async () => {
    const port = await freePort();
    const secretDir = fs.mkdtempSync(path.join(tmpdir(), 'od-mu-secret-'));
    scratch.push(secretDir);
    const secretFile = path.join(secretDir, 'bootstrap');
    fs.writeFileSync(secretFile, SECRET, { mode: 0o600 });
    const dataDir = fs.mkdtempSync(path.join(tmpdir(), 'od-mu-data-'));
    scratch.push(dataDir);
    const run = launch({ ...base, port, bootstrapSecretFile: secretFile }, { OD_DATA_DIR: dataDir });
    await until(() => run.output().includes('multi-user staging daemon listening'), 'listening');
    expect(run.output()).toContain(`http://127.0.0.1:${port}`);

    const url = `http://127.0.0.1:${port}`;
    const headers = { 'content-type': 'application/json', origin: base.publicOrigin };
    const version = await (await fetch(`${url}/api/version`)).json() as { version: { capabilities: Record<string, unknown> } };
    expect(version.version.capabilities.multiUser).toBe(true);
    expect((await fetch(`${url}/api/agent-accounts`)).status).toBe(401);

    const boot = await fetch(`${url}/api/auth/bootstrap`, { method: 'POST', headers,
      body: JSON.stringify({ bootstrapToken: SECRET, username: 'root-admin', password: 'admin-password-correct-horse' }) });
    expect(boot.status, await boot.clone().text()).toBe(201);
    const again = await fetch(`${url}/api/auth/bootstrap`, { method: 'POST', headers,
      body: JSON.stringify({ bootstrapToken: SECRET, username: 'second-admin', password: 'admin-password-correct-horse' }) });
    expect(again.status).not.toBe(201);

    const login = await fetch(`${url}/api/auth/login`, { method: 'POST', headers,
      body: JSON.stringify({ username: 'root-admin', password: 'admin-password-correct-horse' }) });
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^__Host-od_session=[^;]+;.*HttpOnly; Secure; SameSite=Strict/);
    const session = cookie.split(';')[0]!;

    const accounts = await (await fetch(`${url}/api/agent-accounts`, { headers: { cookie: session } })).json();
    expect(accounts).toMatchObject({ mode: 'multi-user', companyPoolAvailable: false, personalSubscriptionsEnabled: false });
    // A foreign origin cannot change state.
    const foreign = await fetch(`${url}/api/projects`, { method: 'POST', headers: { ...headers, origin: 'https://evil.test', cookie: session },
      body: JSON.stringify({ id: 'p1', name: 'p1' }) });
    expect(foreign.status).toBe(403);

    run.child.kill('SIGTERM');
    expect(await run.exited).toBe(0);
  }, 120_000);

  it.each([
    ['without OD_DATA_DIR', { ...base }, {}, /OD_DATA_DIR must be set/],
    ['with the wrong acknowledgement', { ...base, acknowledge: 'yes' }, { OD_DATA_DIR: '/nonexistent-od-data' }, /acknowledge/],
    ['next to OD_API_TOKEN', { ...base }, { OD_DATA_DIR: 'DATA', OD_API_TOKEN: 'shared' }, /OD_API_TOKEN/],
  ] as const)('refuses to start %s', async (_name, config, env, message) => {
    const dataDir = fs.mkdtempSync(path.join(tmpdir(), 'od-mu-data-'));
    scratch.push(dataDir);
    const resolvedEnv = Object.fromEntries(Object.entries(env).map(([key, value]) => [key, value === 'DATA' ? dataDir : value]));
    const run = launch({ ...config, port: await freePort() }, resolvedEnv);
    expect(await run.exited).toBe(1);
    expect(run.output()).toMatch(message);
    expect(run.output()).not.toContain('listening');
  }, 120_000);
});
