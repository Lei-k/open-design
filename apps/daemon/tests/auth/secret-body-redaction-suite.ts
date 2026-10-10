// S58 repair 1: secret-bearing multi-user endpoints never echo a request body
// in any response, log line, stderr write, failure journal, audit row or data
// file — whatever the parser, size or validation outcome — in development and
// production alike. Each test file runs this suite under one NODE_ENV (Express
// picks its error behaviour from NODE_ENV when the app is created).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readRecentApiFailures } from '../../src/http/api-failure-journal.js';
import {
  cleanupIsolatedDataRoot, loadIsolatedServerModule, multiUserOptions, provisionAccounts, startMultiUserDaemon,
  MU_TEST_ORIGIN, type Principal, type StartedMultiUserDaemon,
} from './multiuser-harness.js';

// V8 quotes at most ~10 characters of a body in a JSON SyntaxError, so leaks are
// detected by a short marker at the very start of the secret.
const MARK = 'SNTL';
const SENTINEL = `${MARK}_secret_key_material_0123456789`;

interface Endpoint { name: string; path: string; as: 'admin' | 'user'; valid: Record<string, unknown> }
const ENDPOINTS: Endpoint[] = [
  { name: 'company Composio key (standard alias)', path: '/api/connectors/composio/config', as: 'admin', valid: { revision: 0, apiKey: SENTINEL } },
  { name: 'company Composio key', path: '/api/multiuser/connectors/company-key', as: 'admin', valid: { revision: 0, apiKey: SENTINEL } },
  { name: 'company OpenAI key', path: '/api/admin/pool/openai', as: 'admin', valid: { revision: 0, enabled: true, model: 'gpt-5', capacity: 1, apiKey: SENTINEL } },
  { name: 'account OpenAI key', path: '/api/multiuser/settings/provider-keys/openai', as: 'user', valid: { revision: 0, apiKey: SENTINEL } },
  { name: 'account Tavily key', path: '/api/multiuser/settings/provider-keys/tavily', as: 'user', valid: { revision: 0, apiKey: SENTINEL } },
];

/** Bodies that must each fail without any body-derived text escaping. */
function hostileBodies(endpoint: Endpoint): Array<{ label: string; rawBody: string; contentType: string }> {
  const json = JSON.stringify(endpoint.valid);
  return [
    { label: 'truncated JSON', rawBody: json.slice(0, -1), contentType: 'application/json' },
    { label: 'bare token', rawBody: SENTINEL, contentType: 'application/json' },
    { label: 'non-object JSON', rawBody: JSON.stringify(SENTINEL), contentType: 'application/json' },
    { label: 'trailing garbage', rawBody: `${json} ${SENTINEL}`, contentType: 'application/json' },
    { label: 'unsupported charset', rawBody: json, contentType: 'application/json; charset=iso-8859-1' },
    { label: 'oversized', rawBody: JSON.stringify({ ...endpoint.valid, apiKey: `${SENTINEL}${'x'.repeat(16 * 1024)}` }), contentType: 'application/json' },
    { label: 'unknown field', rawBody: JSON.stringify({ ...endpoint.valid, [SENTINEL]: SENTINEL }), contentType: 'application/json' },
    { label: 'wrong field type', rawBody: JSON.stringify({ ...endpoint.valid, revision: SENTINEL }), contentType: 'application/json' },
    // Under the route's byte bound but over every key-length bound: refused by validation, not by size.
    { label: 'invalid key value', rawBody: JSON.stringify({ ...endpoint.valid, apiKey: `${SENTINEL}${'y'.repeat(5000)}` }), contentType: 'application/json' },
  ];
}

function filesUnder(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const full = path.join(root, entry);
    const stat = statSync(full, { throwIfNoEntry: false });
    if (!stat) continue;
    if (stat.isDirectory()) out.push(...filesUnder(full));
    else if (stat.isFile() && stat.size < 64 * 1024 * 1024) out.push(full);
  }
  return out;
}

export function secretBodyRedactionSuite(nodeEnv: 'development' | 'production'): void {
  let daemon: StartedMultiUserDaemon;
  let dataRoot: string;
  let admin: Principal;
  let user: Principal;
  const captured: string[] = [];
  const previousEnv = process.env.NODE_ENV;

  beforeAll(async () => {
    delete process.env.OD_API_TOKEN;
    delete process.env.OD_DISABLE_API_AUTH;
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
    daemon = await startMultiUserDaemon(multiUserOptions());
    const provisioned = await provisionAccounts(daemon, ['redaction-user']);
    admin = provisioned.admin;
    user = provisioned.users[0]!;
  }, 120_000);
  afterAll(async () => {
    await daemon?.close();
    vi.restoreAllMocks();
    cleanupIsolatedDataRoot();
    if (previousEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousEnv;
  });

  describe(`secret-bearing endpoints under NODE_ENV=${nodeEnv}`, () => {
    it.each(ENDPOINTS)('$name answers every hostile body with a fixed typed error and leaks it nowhere', async (endpoint) => {
      const principal = endpoint.as === 'admin' ? admin : user;
      const problems: string[] = [];
      for (const body of hostileBodies(endpoint)) {
        const res = await daemon.request({ method: 'PUT', path: endpoint.path, cookie: principal.cookie, rawBody: body.rawBody,
          headers: { origin: MU_TEST_ORIGIN, 'content-type': body.contentType } });
        if (res.text.includes(MARK)) problems.push(`${body.label}: response echoes the body: ${res.text.slice(0, 200)}`);
        if (res.status < 400 || res.status >= 500) problems.push(`${body.label}: status ${res.status}`);
        if (!String(res.headers['content-type']).includes('application/json') || typeof res.json?.error?.code !== 'string') {
          problems.push(`${body.label}: not a typed JSON error (${res.headers['content-type']})`);
        }
      }
      // Let any deferred logging flush before inspecting every sink.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const leakedLines = captured.filter((line) => line.includes(MARK));
      if (leakedLines.length) problems.push(`logs/stdout/stderr carry the body: ${leakedLines.map((line) => line.split('\n')[0]).join(' | ').slice(0, 400)}`);
      if (JSON.stringify(readRecentApiFailures()).includes(MARK)) problems.push('failure journal carries the body');
      for (const file of filesUnder(dataRoot)) {
        if (readFileSync(file).toString('latin1').includes(MARK)) problems.push(`data file carries the body: ${path.relative(dataRoot, file)}`);
      }
      captured.length = 0;
      expect(problems).toEqual([]);
    });
  });
}
