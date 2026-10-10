// S60 (#62): stored MCP secrets — header values, OAuth access/refresh tokens and
// the dynamic client secret — never appear in any response, log line,
// stdout/stderr write, failure journal, audit row or data file, under
// NODE_ENV=development and production alike, across success and failure paths.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readRecentApiFailures } from '../../src/http/api-failure-journal.js';
import {
  cleanupIsolatedDataRoot, loadIsolatedServerModule, multiUserOptions, provisionAccounts, startMultiUserDaemon,
  MU_TEST_ORIGIN, type Principal, type StartedMultiUserDaemon,
} from './multiuser-harness.js';
import { MCP_CLIENT_SECRET_SENTINEL, MCP_HEADER_SENTINEL, MCP_REFRESH_SENTINEL, MCP_TOKEN_SENTINEL, startMcpFixture, type McpFixture } from './studio-mcp-fixture.js';

const MARK = 'SNTLMCP';
function filesUnder(root: string): string[] {
  return readdirSync(root).flatMap((entry) => {
    const full = path.join(root, entry); const stat = statSync(full, { throwIfNoEntry: false });
    return !stat ? [] : stat.isDirectory() ? filesUnder(full) : stat.isFile() && stat.size < 64 * 1024 * 1024 ? [full] : [];
  });
}

export function studioMcpRedactionSuite(nodeEnv: 'development' | 'production'): void {
  let daemon: StartedMultiUserDaemon; let dataRoot: string; let user: Principal; let fixture: McpFixture;
  const captured: string[] = [];
  const previousEnv = process.env.NODE_ENV;
  beforeAll(async () => {
    delete process.env.OD_API_TOKEN; delete process.env.OD_DISABLE_API_AUTH;
    process.env.NODE_ENV = nodeEnv;
    ({ dataRoot } = await loadIsolatedServerModule());
    for (const level of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        captured.push(args.map((arg) => arg instanceof Error ? `${arg.message}\n${arg.stack}` : typeof arg === 'string' ? arg : JSON.stringify(arg) ?? String(arg)).join(' '));
      });
    }
    for (const stream of [process.stdout, process.stderr]) {
      const original = stream.write.bind(stream);
      vi.spyOn(stream, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
        captured.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
        return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof stream.write);
    }
    fixture = await startMcpFixture();
    daemon = await startMultiUserDaemon(multiUserOptions({ testMcpOutbound: { resolve: fixture.resolve, allowAddress: fixture.allowAddress, timeoutMs: 1_500 } }));
    user = (await provisionAccounts(daemon, ['mcp-redaction'])).users[0]!;
  }, 120_000);
  afterAll(async () => {
    await daemon?.close(); await fixture?.close(); vi.restoreAllMocks(); cleanupIsolatedDataRoot();
    if (previousEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousEnv;
  });

  describe(`account MCP secrets under NODE_ENV=${nodeEnv}`, () => {
    it('never leave the sealed store through any response, log, journal, audit row or data file', async () => {
      const responses: string[] = [];
      const call = async (method: string, route: string, body?: unknown, cookie: string | undefined = user.cookie) => {
        const res = await daemon.request({ method, path: route, ...(cookie ? { cookie } : {}), headers: { origin: MU_TEST_ORIGIN }, ...(body === undefined ? {} : { body }) });
        responses.push(`${res.status} ${JSON.stringify(res.headers)} ${res.text}`);
        return res;
      };
      expect((await call('POST', '/api/multiuser/mcp/servers', { id: 'keyed', url: fixture.url(), headers: { 'X-Api-Key': MCP_HEADER_SENTINEL } })).status).toBe(201);
      expect((await call('POST', '/api/multiuser/mcp/servers/keyed/test', {})).json.result.ok).toBe(true);
      await call('PATCH', '/api/multiuser/mcp/servers/keyed', { revision: 1, headers: { 'X-Api-Key': `${MCP_HEADER_SENTINEL}\r\nX: y` } });
      await call('POST', '/api/multiuser/mcp/servers', { id: 'keyed', url: fixture.url(), headers: { 'X-Api-Key': MCP_HEADER_SENTINEL } });
      await call('PUT', '/api/mcp/servers', { servers: [{ id: 'stdio', transport: 'stdio', command: 'npx', env: { TOKEN: MCP_HEADER_SENTINEL } }] });
      // A remote that rejects the header: a typed outcome, the remote body ("denied …") is not echoed.
      await call('POST', '/api/multiuser/mcp/servers', { id: 'wrong', url: fixture.url(), headers: { 'X-Api-Key': `${MCP_HEADER_SENTINEL}-wrong` } });
      expect((await call('POST', '/api/multiuser/mcp/servers/wrong/test', {})).json.result).toMatchObject({ ok: false, code: 'unauthorized', needsAuth: true });
      expect((await call('POST', '/api/multiuser/mcp/servers', { id: 'oauth', url: fixture.url(), authMode: 'oauth' })).status).toBe(201);
      const started = await call('POST', '/api/mcp/oauth/start', { serverId: 'oauth' });
      const state = new URL(started.json.authorizeUrl).searchParams.get('state')!;
      expect((await call('GET', `/api/mcp/oauth/callback?${new URLSearchParams({ state, code: 'good-code' })}`, undefined, undefined)).status).toBe(200);
      expect((await call('POST', '/api/multiuser/mcp/servers/oauth/test', {})).json.result.ok).toBe(true);
      expect((await call('POST', '/api/multiuser/mcp/oauth/refresh', { serverId: 'oauth' })).status).toBe(200);
      await call('GET', '/api/mcp/oauth/status?serverId=oauth');
      await call('GET', '/api/mcp/servers');
      // A token endpoint that echoes the request (code, verifier, client secret) in its error body.
      fixture.state.tokenFails = true;
      const again = await call('POST', '/api/mcp/oauth/start', { serverId: 'oauth' });
      const failedState = new URL(again.json.authorizeUrl).searchParams.get('state')!;
      expect((await call('GET', `/api/mcp/oauth/callback?${new URLSearchParams({ state: failedState, code: 'good-code' })}`, undefined, undefined)).json.error.details.reason).toBe('provider');
      fixture.state.tokenFails = false;
      await new Promise((resolve) => setTimeout(resolve, 50));
      const problems: string[] = [];
      for (const secret of [MCP_HEADER_SENTINEL, MCP_TOKEN_SENTINEL, MCP_REFRESH_SENTINEL, MCP_CLIENT_SECRET_SENTINEL]) {
        if (responses.some((text) => text.includes(secret))) problems.push(`response carries ${secret.slice(0, 20)}`);
      }
      if (captured.some((line) => line.includes(MARK))) problems.push(`logs carry a secret: ${captured.filter((line) => line.includes(MARK)).map((line) => line.slice(0, 120)).join(' | ')}`);
      if (JSON.stringify(readRecentApiFailures()).includes(MARK)) problems.push('failure journal carries a secret');
      const db = new Database(path.join(dataRoot, 'app.sqlite'), { readonly: true });
      try { if (JSON.stringify(db.prepare('SELECT * FROM studio_mcp_audit').all()).includes(MARK)) problems.push('audit carries a secret'); } finally { db.close(); }
      for (const file of filesUnder(dataRoot)) if (readFileSync(file).toString('latin1').includes(MARK)) problems.push(`data file carries a secret: ${path.relative(dataRoot, file)}`);
      expect(problems).toEqual([]);
    });
  });
}
