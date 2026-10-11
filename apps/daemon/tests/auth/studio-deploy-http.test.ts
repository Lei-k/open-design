import { currentAccountRevision } from './helpers.js';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { knownSecrets } from '../../src/mcp-client/studio-untrusted.js';
import {
  cleanupIsolatedDataRoot,
  loadIsolatedServerModule,
  login,
  multiUserOptions,
  provisionAccounts,
  startMultiUserDaemon,
  type Principal,
  type StartedMultiUserDaemon,
} from './multiuser-harness.js';
let daemon: StartedMultiUserDaemon;
let fixture: http.Server;
let root: string;
let a: Principal;
let b: Principal;
let admin: Principal;
const token = 'S63-account-A-private-token-9234';
const cfToken = 'S63-cloudflare-account-token-7832';
const bToken = 'S63-account-B-private-token-6172';
const jwt = 'S63-cloudflare-upload-credential-8392';
const hostToken = 'S63-HOST-sentinel-NEVER-send-5938';
const requests: { authorization: string; url: string; body: string }[] = [];
const logs: string[] = [];
const responses: string[] = [];
let holdPath: string | null = null;
let held: () => void = () => {};
let release: () => void = () => {};
let heldReleases: (() => void)[] = [];
let failure = false;
let echo = false;
let redirect = false;
let holdDns = false;
let dnsHeld: () => void = () => {};
let releaseDns: () => void = () => {};
let configRevision = 0;
const call = async (user: Principal, method: string, route: string, body?: unknown) => {
  const response = await daemon.request({
    cookie: user.cookie,
    method,
    path: route,
    ...(body === undefined ? {} : { body }),
  });
  responses.push(response.text);
  return response;
};
async function setToken(user = a, provider = 'vercel', value: string | null = token) {
  const current = await call(user, 'GET', `/api/deploy/config?providerId=${provider}`);
  const result = await call(user, 'PUT', '/api/deploy/config', {
    providerId: provider,
    revision: current.json.revision,
    token: value,
    ...(provider === 'cloudflare-pages' ? { accountId: 'a'.repeat(32), projectName: 'site' } : {}),
  });
  expect(result.status, result.text).toBe(200);
  configRevision = result.json.revision;
  return result;
}
async function project(user = a) {
  const id = randomUUID();
  expect((await call(user, 'POST', '/api/projects', { id, name: 'Deploy' })).status).toBe(200);
  expect(
    (await call(user, 'POST', `/api/projects/${id}/files`, { name: 'index.html', content: '<p>S63</p>' })).status,
  ).toBe(200);
  return id;
}
const deploy = (id: string, user = a, providerId = 'vercel') =>
  call(user, 'POST', `/api/projects/${id}/deploy`, { fileName: 'index.html', providerId });
beforeAll(async () => {
  ({ dataRoot: root } = await loadIsolatedServerModule());
  for (const level of ['log', 'warn', 'error', 'info', 'debug'] as const)
    vi.spyOn(console, level).mockImplementation((...args) =>
      logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')),
    );
  mkdirSync(path.join(root, 'host-state'));
  process.env.OD_USER_STATE_DIR = path.join(root, 'host-state');
  writeFileSync(path.join(root, 'host-state', 'vercel.json'), JSON.stringify({ token: hostToken }), { mode: 0o600 });
  fixture = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += String(chunk);
    const url = req.url!;
    requests.push({ authorization: String(req.headers.authorization), url, body });
    if (holdPath && url.includes(holdPath)) {
      held();
      await new Promise<void>((resolve) => {
        release = resolve;
        heldReleases.push(resolve);
      });
    }
    if (redirect) {
      res.writeHead(302, { Location: 'http://localhost:1/steal' });
      res.end();
      return;
    }
    const secretEcho = echo ? Buffer.from(token).toString('base64') : '';
    res.setHeader('Content-Type', 'application/json');
    if (failure) {
      res.statusCode = 403;
      res.end(JSON.stringify({ error: { message: `Bearer ${token} ${secretEcho}` }, errors: [{ message: cfToken }] }));
      return;
    }
    let output: unknown = {
      id: 'deployment-1',
      url: echo ? `https://${secretEcho}.vercel.app` : 'https://site.vercel.app',
      readyState: 'READY',
      extra: token,
    };
    if (url.includes('/client/v4')) {
      if (url.endsWith('upload-token')) output = { success: true, result: { jwt } };
      else if (url.endsWith('check-missing')) output = { success: true, result: JSON.parse(body).hashes };
      else if (url.endsWith('/deployments') || url.includes('/deployments/deployment-1'))
        output = {
          success: true,
          result: {
            id: 'deployment-1',
            url: 'https://site.pages.dev',
            latest_stage: { status: 'success' },
            echo: cfToken,
          },
        };
      else output = { success: true, result: {} };
    }
    res.end(JSON.stringify(output));
  });
  await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  const origin = `http://deploy.fixture.test.invalid:${(fixture.address() as import('node:net').AddressInfo).port}`;
  daemon = await startMultiUserDaemon(
    multiUserOptions({
      testDeployOutbound: {
        apiOrigin: origin,
        resolve: async () => {
          if (holdDns) {
            dnsHeld();
            await new Promise<void>((resolve) => {
              releaseDns = resolve;
            });
          }
          return ['127.0.0.1'];
        },
        allowAddress: (address) => address === '127.0.0.1',
        timeoutMs: 3000,
      },
    }),
  );
  const users = await provisionAccounts(daemon, ['deploy-a', 'deploy-b']);
  [a, b] = users.users as [Principal, Principal];
  admin = users.admin;
}, 120_000);
beforeEach(() => {
  holdDns = false;
  holdPath = null;
  heldReleases = [];
  failure = false;
  echo = false;
  redirect = false;
});
afterAll(async () => {
  await daemon?.close();
  await new Promise<void>((resolve) => fixture?.close(() => resolve()));
  vi.restoreAllMocks();
  delete process.env.OD_USER_STATE_DIR;
  cleanupIsolatedDataRoot();
});
it('account token is write-only, revision-checked and isolated, replace and clear supported', async () => {
  const saved = await setToken();
  expect(saved.json).toMatchObject({ configured: true, last4: '9234', revision: 1 });
  expect(saved.text).not.toContain(token);
  for (const user of [b, admin])
    expect((await call(user, 'GET', '/api/deploy/config?providerId=vercel')).json.configured).toBe(false);
  expect((await call(a, 'PUT', '/api/deploy/config', { providerId: 'vercel', revision: 0, token })).status).toBe(409);
  expect((await setToken(a, 'vercel', token + 'next')).json.revision).toBe(2);
  expect((await setToken(a, 'vercel', null)).json.configured).toBe(false);
});
it('no token is typed unavailable and host config never reaches the provider', async () => {
  await setToken(a, 'vercel', null);
  const id = await project();
  const count = requests.length;
  const response = await deploy(id);
  expect(response.json.error.code).toBe('MULTIUSER_DEPLOY_TOKEN_MISSING');
  expect(requests.length).toBe(count);
});
it.each(['vercel', 'cloudflare-pages'])(
  '%s deploy uses actor credentials and captured digest; history/status/check/redeploy/delete are owner only',
  async (provider) => {
    await setToken(a, provider, provider === 'vercel' ? token : cfToken);
    const id = await project();
    const start = requests.length;
    const preflight = await call(a, 'POST', `/api/projects/${id}/deploy/preflight`, {
      providerId: provider,
      fileName: 'index.html',
    });
    expect(preflight.status, preflight.text).toBe(200);
    const deployed = await deploy(id, a, provider);
    expect(deployed.status, deployed.text).toBe(200);
    expect(deployed.json.digest).toBe(preflight.json.digest);
    expect(deployed.json.status).toBe('ready');
    expect(requests.slice(start).map((r) => r.authorization)).toContain(
      `Bearer ${provider === 'vercel' ? token : cfToken}`,
    );
    if (provider === 'cloudflare-pages')
      expect(requests.slice(start).map((r) => r.authorization)).toContain(`Bearer ${jwt}`);
    await setToken(b, provider, bToken);
    const bProject = await project(b);
    const bStart = requests.length;
    const bDeployment = await deploy(bProject, b, provider);
    expect(bDeployment.status, bDeployment.text).toBe(200);
    const bAuthorizations = requests.slice(bStart).map((r) => r.authorization);
    expect(bAuthorizations).toContain(`Bearer ${bToken}`);
    expect(bAuthorizations).not.toContain(`Bearer ${token}`);
    expect(bAuthorizations).not.toContain(`Bearer ${cfToken}`);
    const bBase = `/api/projects/${bProject}/deployments/${bDeployment.json.id}`;
    for (const user of [a, admin]) {
      expect((await call(user, 'GET', `/api/projects/${bProject}/deployments`)).status).toBe(404);
      for (const [method, suffix] of [
        ['GET', ''], ['POST', '/status'], ['POST', '/check-link'], ['POST', '/redeploy'], ['DELETE', ''],
      ] as const) {
        const foreign = await call(user, method, bBase + suffix, method === 'POST' ? {} : undefined);
        const missing = await call(user, method, bBase.replace(bProject, randomUUID()) + suffix, method === 'POST' ? {} : undefined);
        expect(foreign.status).toBe(404);
        expect(foreign.json).toEqual(missing.json);
      }
    }
    const base = `/api/projects/${id}/deployments/${deployed.json.id}`;
    await call(a, 'PUT', `/api/multiuser/projects/${id}/shares`, { username: b.username, role: 'edit' });
    for (const user of [b, admin])
      for (const [method, suffix] of [
        ['GET', ''],
        ['POST', '/status'],
        ['POST', '/check-link'],
        ['POST', '/redeploy'],
        ['DELETE', ''],
      ] as const) {
        const foreign = await call(user, method, base + suffix, method === 'POST' ? {} : undefined);
        const missing = await call(
          user,
          method,
          base.replace(id, randomUUID()) + suffix,
          method === 'POST' ? {} : undefined,
        );
        expect(foreign.status).toBe(404);
        expect(foreign.json).toEqual(missing.json);
      }
    expect((await call(b, 'GET', `/api/projects/${id}/deployments`)).status).toBe(404);
    expect((await deploy(id, b, provider)).status).toBe(404);
    expect((await call(a, 'POST', base + '/status', {})).status).toBe(200);
    const originalStatusUrl = requests.at(-1)!.url;
    const originalConfig = await call(a, 'GET', `/api/deploy/config?providerId=${provider}`);
    expect((await call(a, 'PUT', '/api/deploy/config', {
      providerId: provider,
      revision: originalConfig.json.revision,
      ...(provider === 'vercel' ? { teamId: 'team-new' } : { accountId: 'b'.repeat(32), projectName: 'changed' }),
    })).status).toBe(200);
    const scopeStart = requests.length;
    expect((await call(a, 'POST', base + '/status', {})).status).toBe(200);
    expect(requests[scopeStart]!.url).toBe(originalStatusUrl);
    expect((await call(a, 'POST', base + '/check-link', {})).json.lastLinkCheck.reachable).toBe(true);
    await call(a, 'POST', `/api/projects/${id}/files`, { name: 'index.html', content: '<p>NEW</p>' });
    expect((await call(a, 'GET', base)).json.digest).toBe(deployed.json.digest);
    const again = await call(a, 'POST', base + '/redeploy', {});
    expect(again.status, again.text).toBe(200);
    expect(again.json.digest).not.toBe(deployed.json.digest);
    const n = requests.length;
    expect((await call(a, 'DELETE', base)).json).toEqual({ ok: true, externalDeleted: false });
    expect(requests.length).toBe(n);
    await call(a, 'DELETE', `/api/projects/${id}`);
    expect((await call(a, 'POST', `/api/projects/${id}/deployments/${again.json.id}/redeploy`, {})).status).toBe(404);
  },
);
it('provider metadata and failures cannot persist or return echoed credentials; redirects are refused', async () => {
  const id = await project();
  await setToken();
  echo = true;
  const success = await deploy(id);
  expect(success.status, success.text).toBe(200);
  expect(success.json.url).toBe('');
  failure = true;
  expect((await deploy(id)).json.error.code).toBe('MULTIUSER_DEPLOY_PROVIDER_FAILED');
  failure = false;
  echo = false;
  redirect = true;
  const count = requests.length;
  expect((await deploy(id)).json.error.code).toBe('MULTIUSER_DEPLOY_OUTBOUND_REFUSED');
  expect(requests.length - count).toBe(1);
});
it.each(['clear', 'replace', 'logout', 'disable', 'revoke', 'reset'])(
  '%s during upload stops before the next outbound request, writes no success',
  async (action) => {
    a.cookie = await login(daemon, a.username, a.password);
    await setToken(a, 'cloudflare-pages', cfToken);
    const id = await project();
    const existing = await deploy(id, a, 'cloudflare-pages');
    expect(existing.status, existing.text).toBe(200);
    holdPath = '/pages/assets/upload';
    const reached = new Promise<void>((resolve) => {
      held = resolve;
    });
    const pending = deploy(id, a, 'cloudflare-pages');
    await reached;
    const count = requests.length;
    if (action === 'clear' || action === 'replace')
      await setToken(a, 'cloudflare-pages', action === 'clear' ? null : cfToken + 'new');
    else if (action === 'logout') await call(a, 'POST', '/api/auth/logout', {});
    else if (action === 'disable') await call(admin, 'PATCH', `/api/auth/users/${a.id}`, { revision: await currentAccountRevision(daemon.request, a.id, admin.cookie), active: false });
    else if (action === 'revoke') await call(admin, 'POST', `/api/auth/users/${a.id}/sessions/revoke`, {});
    else await call(admin, 'POST', `/api/auth/users/${a.id}/password`, { password: a.password });
    release();
    const res = await pending;
    expect(res.json.error.code, res.text).toBe('MULTIUSER_DEPLOY_AUTHORITY_CHANGED');
    expect(requests.length).toBe(count);
    if (action === 'disable') await call(admin, 'PATCH', `/api/auth/users/${a.id}`, { revision: await currentAccountRevision(daemon.request, a.id, admin.cookie), active: true });
    a.cookie = await login(daemon, a.username, a.password);
    expect(
      (await call(a, 'GET', `/api/projects/${id}/deployments`)).json.deployments.map((row: { id: string }) => row.id),
    ).toEqual([existing.json.id]);
  },
);
it('token clear while DNS resolves opens no provider socket', async () => {
  await setToken();
  const id = await project();
  holdDns = true;
  const resolving = new Promise<void>((resolve) => {
    dnsHeld = resolve;
  });
  const count = requests.length;
  const pending = deploy(id);
  await resolving;
  await setToken(a, 'vercel', null);
  releaseDns();
  const response = await pending;
  expect(response.json.error.code).toBe('MULTIUSER_DEPLOY_AUTHORITY_CHANGED');
  expect(requests.length).toBe(count);
});
it('safe capture refuses links, missing references, file/count/byte limits and traversal', async () => {
  await setToken();
  const id = await project();
  symlinkSync(path.join(root, 'app.sqlite'), path.join(root, 'projects', id, 'leak'));
  expect((await deploy(id)).json.error.code).toBe('MULTIUSER_DEPLOY_CAPTURE_REFUSED');
  const count = await project();
  for (let i = 0; i < 501; i++) writeFileSync(path.join(root, 'projects', count, `file-${i}`), 'x');
  expect((await deploy(count)).json.error.code).toBe('MULTIUSER_DEPLOY_CAPTURE_REFUSED');
  const size = await project();
  writeFileSync(path.join(root, 'projects', size, 'large'), Buffer.alloc(25 * 1024 * 1024 + 1));
  expect((await deploy(size)).json.error.code).toBe('MULTIUSER_DEPLOY_CAPTURE_REFUSED');
  expect(
    (await call(a, 'POST', `/api/projects/${size}/deploy`, { fileName: '../other.html', providerId: 'vercel' })).status,
  ).toBeGreaterThanOrEqual(400);
});
it('finalize/handoff and zones/custom domains stay precisely refused', async () => {
  const id = await project();
  for (const suffix of ['finalize/openai', 'handoff']) {
    const res = await call(a, 'POST', `/api/projects/${id}/${suffix}`, {});
    expect(res.status).toBe(403);
    expect(res.json.error.details.reason).toContain('separate AI provider');
  }
  expect((await call(a, 'GET', '/api/deploy/cloudflare-pages/zones')).status).toBe(403);
  expect(
    (
      await call(a, 'POST', `/api/projects/${id}/deploy`, {
        fileName: 'index.html',
        providerId: 'cloudflare-pages',
        cloudflarePages: { zoneId: 'zone' },
      })
    ).status,
  ).toBe(403);
});
it('real od CLI uses the account session, accepts stdin tokens, refuses argv, and operates owned history as JSON', async () => {
  const cli = (args: string[], input = '') =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [path.resolve('dist/cli.js'), ...args], {
        env: { ...process.env, OD_DAEMON_URL: daemon.baseUrl },
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 30000,
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });
      child.on('error', reject);
      child.on('close', (code) => {
        responses.push(stdout, stderr);
        resolve({ code, stdout, stderr });
      });
      child.stdin.end(input);
    });
  const sessionFile = path.join(root, 's63-cli-session');
  const logged = await cli(
    [
      'session',
      'login',
      '--daemon-url',
      daemon.baseUrl,
      '--username',
      a.username,
      '--password-file',
      '-',
      '--session-file',
      sessionFile,
      '--json',
    ],
    a.password,
  );
  expect(logged.code, logged.stderr).toBe(0);
  const run = (args: string[], input = '') => cli(['deploy', ...args, '--session-file', sessionFile, '--json'], input);
  const help = await run(['--help']);
  expect(help.code, help.stderr).toBe(0);
  expect(help.stdout).toContain('od deploy config set|show|clear');
  expect((await run(['config', 'set', '--provider', 'vercel', '--token', token])).code).toBe(2);
  const summary = await run(['config', 'show', '--provider', 'vercel']);
  expect(summary.code, summary.stderr).toBe(0);
  const set = await run(
    [
      'config',
      'set',
      '--provider',
      'vercel',
      '--revision',
      String(JSON.parse(summary.stdout).revision),
      '--token-file',
      '-',
    ],
    token,
  );
  expect(set.code, set.stderr).toBe(0);
  expect(set.stdout).not.toContain(token);
  const id = await project();
  const deployed = await run(['run', id, '--file', 'index.html', '--provider', 'vercel']);
  expect(deployed.code, deployed.stderr).toBe(0);
  const record = JSON.parse(deployed.stdout);
  for (const op of ['list', 'status', 'check-link', 'redeploy', 'delete']) {
    const response = await run(op === 'list' ? [op, id] : [op, id, record.id]);
    expect(response.code, response.stderr).toBe(0);
    expect(() => JSON.parse(response.stdout)).not.toThrow();
  }
  const current = await run(['config', 'show', '--provider', 'vercel']);
  expect(
    (await run(['config', 'clear', '--provider', 'vercel', '--revision', String(JSON.parse(current.stdout).revision)]))
      .code,
  ).toBe(0);
});
// S64 ports REPRO-1, with the same hold → DELETE → release sequence for every async record effect.
it.each(['status', 'check-link', 'redeploy'])(
  '%s cannot revive or derive a new record after its source is deleted',
  async (action) => {
    await setToken();
    const id = await project();
    const deployed = await deploy(id);
    expect(deployed.status, deployed.text).toBe(200);
    const base = `/api/projects/${id}/deployments/${deployed.json.id}`;
    const missing = await call(a, 'POST', base.replace(deployed.json.id, randomUUID()) + `/${action}`, {});
    holdPath = action === 'status' ? '/v13/deployments/deployment-1' : action === 'check-link' ? '/link' : '/v13/deployments';
    const reached = new Promise<void>((resolve) => { held = resolve; });
    const pending = call(a, 'POST', `${base}/${action}`, {});
    await reached;
    try {
      expect((await call(a, 'DELETE', base)).json).toEqual({ ok: true, externalDeleted: false });
    } finally {
      release();
    }
    const response = await pending;
    expect(response.status, response.text).toBe(404);
    expect(response.json).toEqual(missing.json);
    expect((await call(a, 'GET', `/api/projects/${id}/deployments`)).json.deployments).toEqual([]);
  },
);
it('REPRO-2: Cloudflare path-normalizing account IDs are rejected without provider traffic', async () => {
  const count = requests.length;
  const current = await call(a, 'GET', '/api/deploy/config?providerId=cloudflare-pages');
  for (const accountId of ['.', '..', '%2e%2e', 'cf-account']) {
    const response = await call(a, 'PUT', '/api/deploy/config', {
      providerId: 'cloudflare-pages', revision: current.json.revision, token: cfToken, accountId, projectName: 'site',
    });
    expect(response.status, response.text).toBe(400);
  }
  expect(requests.length).toBe(count);
});
it('REPRO-3: link checks send no Authorization and foreign record status remains not found', async () => {
  await setToken();
  const id = await project();
  const deployed = await deploy(id);
  const base = `/api/projects/${id}/deployments/${deployed.json.id}`;
  const start = requests.length;
  expect((await call(a, 'POST', base + '/check-link', {})).status).toBe(200);
  expect(requests.slice(start).map((r) => r.authorization)).toEqual(['undefined']);
  expect((await call(b, 'POST', base + '/status', {})).status).toBe(404);
  expect(requests.length).toBe(start + 1);
});
it('the 100-record history cap has a specific typed actionable error before provider traffic', async () => {
  await setToken();
  const id = await project();
  const deployed = await deploy(id);
  const db = new Database(path.join(root, 'app.sqlite'));
  try {
    const source = db.prepare('SELECT locator FROM studio_deploy_records WHERE id=?').get(deployed.json.id) as { locator: string };
    const insert = db.prepare('INSERT INTO studio_deploy_records VALUES(?,?,?,?,?)');
    db.transaction(() => {
      for (let i = 1; i < 100; i++) {
        const recordId = randomUUID();
        insert.run(recordId, a.id, id, JSON.stringify({ ...deployed.json, id: recordId }), source.locator);
      }
    })();
  } finally { db.close(); }
  const count = requests.length;
  for (const route of [`/api/projects/${id}/deploy`, `/api/projects/${id}/deployments/${deployed.json.id}/redeploy`]) {
    const result = await call(a, 'POST', route, route.endsWith('/redeploy') ? {} : { fileName: 'index.html', providerId: 'vercel' });
    expect(result.status, result.text).toBe(409);
    expect(result.json.error).toMatchObject({
      code: 'MULTIUSER_DEPLOY_HISTORY_FULL',
      message: 'Deployment history is full (100 records). Delete a deployment record before deploying again.',
    });
  }
  expect(requests.length).toBe(count);
  expect((await call(a, 'DELETE', `/api/projects/${id}/deployments/${deployed.json.id}`)).status).toBe(200);
  expect((await deploy(id)).status).toBe(200);
});
it.each(['status', 'check-link'])('%s holds the same account outbound slot as deploy', async (action) => {
  await setToken();
  const id = await project();
  const deployed = await deploy(id);
  const base = `/api/projects/${id}/deployments/${deployed.json.id}`;
  holdPath = action === 'status' ? '/v13/deployments/deployment-1' : '/link';
  const reached = new Promise<void>((resolve) => { held = resolve; });
  const pending = call(a, 'POST', `${base}/${action}`, {});
  await reached;
  const count = requests.length;
  try {
    for (const suffix of ['/status', '/check-link', '/redeploy'])
      expect((await call(a, 'POST', base + suffix, {})).status).toBe(409);
    expect((await deploy(id)).status).toBe(409);
    expect(requests.length).toBe(count);
  } finally { release(); }
  expect((await pending).status).toBe(200);
  holdPath = null;
  expect((await call(a, 'POST', base + '/status', {})).status).toBe(200);
});
it('status and check-link together fill the two daemon outbound slots across accounts', async () => {
  await setToken();
  await setToken(b, 'vercel', bToken);
  await setToken(admin, 'vercel', token);
  const idA = await project();
  const idB = await project(b);
  const idC = await project(admin);
  const deployedA = await deploy(idA);
  const deployedB = await deploy(idB, b);
  holdPath = '/';
  const reachedA = new Promise<void>((resolve) => { held = resolve; });
  const pendingA = call(a, 'POST', `/api/projects/${idA}/deployments/${deployedA.json.id}/status`, {});
  await reachedA;
  const reachedB = new Promise<void>((resolve) => { held = resolve; });
  const pendingB = call(b, 'POST', `/api/projects/${idB}/deployments/${deployedB.json.id}/check-link`, {});
  await reachedB;
  const count = requests.length;
  try {
    expect((await deploy(idC, admin)).status).toBe(409);
    expect(requests.length).toBe(count);
  } finally { for (const resolve of heldReleases) resolve(); }
  expect((await pendingA).status).toBe(200);
  expect((await pendingB).status).toBe(200);
  holdPath = null;
  expect((await deploy(idC, admin)).status).toBe(200);
});
it('every stored column, SQLite/WAL, response and log is free of raw and encoded sentinels', () => {
  const db = new Database(path.join(root, 'app.sqlite'), { readonly: true });
  const dump = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).flatMap(
    ({ name }) => db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all(),
  );
  db.close();
  const scan = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      const stat = statSync(full);
      return stat.isDirectory() ? scan(full) : [full];
    });
  const data = scan(root)
    .filter((file) => !file.includes('host-state') && !file.includes('/projects/'))
    .map((file) => readFileSync(file).toString('utf8'));
  const haystack = [JSON.stringify(dump), ...data, ...responses, ...logs].join('\n');
  for (const secret of [token, cfToken, bToken, jwt, hostToken])
    for (const value of knownSecrets([secret]).values) expect(haystack).not.toContain(value);
  expect(requests.map((r) => r.authorization)).not.toContain(`Bearer ${hostToken}`);
});
