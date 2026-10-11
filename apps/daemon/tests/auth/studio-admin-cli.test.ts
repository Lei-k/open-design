import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createCliSessionFile, runStudioPilotCli } from '../../src/http/cli-session.js';
let root: string;
let file: string;
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'admin-cli-')); file = path.join(root, 'session'); createCliSessionFile(file, { schemaVersion: 1, origin: 'https://fixture.invalid', cookie: '__Host-od_session=' + 'a'.repeat(43), expiresAt: Date.now() + 60000 }); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it.each([
  [['users', 'list', '--q', 'alice', '--json'], 'GET', '/api/auth/users?q=alice', undefined],
  [['users', 'create', 'alice', '--role', 'user', '--json'], 'POST', '/api/auth/users', { username: 'alice', role: 'user' }],
  [['users', 'update', 'alice', '--role', 'admin', '--revision', '3', '--json'], 'PATCH', '/api/auth/users/alice', { role: 'admin', revision: 3 }],
  [['users', 'reset', 'alice', '--revision', '3', '--json'], 'POST', '/api/auth/users/alice/password', { revision: 3 }],
  [['users', 'revoke', 'alice', '--json'], 'POST', '/api/auth/users/alice/sessions/revoke', {}],
  [['audit', '--limit', '20', '--json'], 'GET', '/api/auth/audit?limit=20', undefined],
  [['pool', 'get', '--json'], 'GET', '/api/admin/pool', undefined],
  [['pool', 'provider', 'test-mock', '--capacity', '2', '--json'], 'PUT', '/api/admin/pool/providers/test-mock', { capacity: 2 }],
  [['pool', 'quota', 'alice', '--minutes', '0', '--json'], 'PUT', '/api/admin/pool/users/alice/quota', { budgetMinutes: 0 }],
  [['personal', 'get', '--json'], 'GET', '/api/admin/agent-accounts', undefined],
  [['personal', 'set', '--capacity', '2', '--json'], 'PUT', '/api/admin/agent-accounts/personal-capacity', { capacity: 2 }],
  [['health', '--json'], 'GET', '/api/health', undefined],
] as const)('maps admin command %j to its exact pinned-cookie HTTP action', async (args, method, route, body) => {
  const fetcher = vi.fn(async () => Response.json({ ok: true })); vi.stubGlobal('fetch', fetcher);
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  await runStudioPilotCli([...args], file);
  const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe('https://fixture.invalid' + route); expect(init.method ?? 'GET').toBe(method);
  expect(init.body ? JSON.parse(String(init.body)) : undefined).toEqual(body);
  expect(new Headers(init.headers).get('cookie')).toBe('__Host-od_session=' + 'a'.repeat(43));
  expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toEqual({ ok: true });
});
it('refuses omitted revisions, unknown flags and endpoint injection before transport', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  for (const args of [['users', 'update', 'alice', '--role', 'admin'], ['users', 'list', '--token', 'secret'], ['users', 'reset', '../other']]) {
    await expect(runStudioPilotCli(args, file)).rejects.toThrow();
  }
  expect(fetcher).not.toHaveBeenCalled();
});
it('does not print a denied response or retry a concurrency conflict', async () => {
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const fetcher = vi.fn(async () => Response.json({ private: 'marker' }, { status: 409 })); vi.stubGlobal('fetch', fetcher);
  await expect(runStudioPilotCli(['users', 'update', 'alice', '--role', 'admin', '--revision', '3'], file)).rejects.toThrow(/409/);
  expect(fetcher).toHaveBeenCalledOnce(); expect(output).not.toHaveBeenCalled();
});

it('requires an observed reset revision, including for a pending account', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  for (const revision of [undefined, 'nonsense', '-1']) {
    await expect(runStudioPilotCli(['users', 'reset', 'alice', ...(revision ? ['--revision', revision] : [])], file)).rejects.toThrow();
  }
  expect(fetcher).not.toHaveBeenCalled();
});
it.each(['CONFLICT', 'LAST_ADMIN', 'USERNAME_TAKEN', 'FORBIDDEN'])('reports only the typed %s refusal without response content or retries', async (code) => {
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const fetcher = vi.fn(async () => Response.json({ error: { code, message: 'PRIVATE_BODY_MARKER', credential: 'SECRET_MARKER' } }, { status: code === 'FORBIDDEN' ? 403 : 409 })); vi.stubGlobal('fetch', fetcher);
  await expect(runStudioPilotCli(['users', 'update', 'alice', '--role', 'user', '--revision', '3'], file)).rejects.toThrow(new RegExp(`^Admin request refused \\(${code === 'FORBIDDEN' ? 403 : 409}\\) ${code}$`));
  expect(fetcher).toHaveBeenCalledOnce(); expect(output).not.toHaveBeenCalled();
});
it('lists existing OpenAI credential commands alongside pool metadata in pool help', async () => {
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  await runStudioPilotCli(['pool', '--help'], null);
  const help = output.mock.calls.map(([value]) => String(value)).join('');
  expect(help).toContain('pool openai get'); expect(help).toContain('pool openai set'); expect(help).toContain('pool quota');
});

it.each([['pool', 'openai', 'get'], ['studio-pilot', 'get', 'alice'], ['connectors', 'composio', 'get']])('retains typed refusals for existing admin command %j', async (...args) => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { code: 'CONFLICT', message: 'PRIVATE_BODY_MARKER' } }, { status: 409 })));
  await expect(runStudioPilotCli(args, file)).rejects.toThrow('CONFLICT');
});
