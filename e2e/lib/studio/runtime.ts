import { fork, execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { e2eWorkspaceRoot } from '../tools-dev/runtime.ts';
import { T } from '../timeouts.ts';

export interface StudioPrincipal { id: string; username: string; password: string; cookie: string }
export interface StudioResponse { status: number; json: any; text: string; cookie: string }
export interface StudioRuntime {
  root: string; origin: string; previewOrigin: string;
  admin: StudioPrincipal; a: StudioPrincipal; b: StudioPrincipal;
  request: (method: string, route: string, cookie?: string, body?: unknown) => Promise<StudioResponse>;
  linkCodex: (actor: StudioPrincipal) => Promise<void>;
  configureTurn: (actor: StudioPrincipal, control: { reply: string; artifactBytes?: Record<string, string> }) => Promise<void>;
  close: (preserve?: boolean) => Promise<void>;
}

/** Real cookies, two HTTPS hostnames, production export, real authorization.
 * Only the provider is mocked; no browser API interception or host credentials.
 * A subprocess isolates module-level data-root resolution from other UI suites.
 */
export async function createStudioRuntime(): Promise<StudioRuntime> {
  const workspaceRoot = e2eWorkspaceRoot();
  if (!existsSync(path.join(workspaceRoot, 'apps/web/out/index.html'))) {
    throw new Error('Studio browser acceptance requires pnpm --filter @open-design/web build (static export)');
  }
  const root = await mkdtemp(path.join(tmpdir(), 'od-studio-browser-'));
  await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-keyout', path.join(root, 'key.pem'), '-out', path.join(root, 'cert.pem')]);
  const tls = { key: await readFile(path.join(root, 'key.pem')), cert: await readFile(path.join(root, 'cert.pem')) };
  let target: URL | null = null;
  const proxies = await Promise.all([0, 1].map(async () => {
    const proxy = https.createServer(tls, (req, res) => {
      if (!target) { res.writeHead(503); res.end(); return; }
      const upstream = http.request({ hostname: target.hostname, port: target.port,
        path: req.url, method: req.method, headers: req.headers }, (incoming) => {
        res.writeHead(incoming.statusCode ?? 502, incoming.headers);
        incoming.pipe(res);
        res.once('close', () => incoming.destroy());
      });
      upstream.once('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      req.pipe(upstream);
      res.once('close', () => upstream.destroy());
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    return proxy;
  }));
  const origin = `https://127.0.0.1:${(proxies[0]!.address() as AddressInfo).port}`;
  const previewOrigin = `https://localhost:${(proxies[1]!.address() as AddressInfo).port}`;
  const logFile = await import('node:fs').then(({ openSync }) => openSync(path.join(root, 'daemon.log'), 'a', 0o600));
  const child = fork(fileURLToPath(new URL('./server.ts', import.meta.url)), [], {
    cwd: workspaceRoot, execArgv: ['--import', import.meta.resolve('tsx')],
    env: { ...process.env, OD_DATA_DIR: path.join(root, 'data'), AMR_HOME: path.join(root, 'amr'), CODEX_HOME: path.join(root, 'host-codex') },
    stdio: ['ignore', logFile, logFile, 'ipc'],
  });
  await import('node:fs').then(({ closeSync }) => closeSync(logFile));
  const close = async (preserve = false) => {
    for (const proxy of proxies) { proxy.closeAllConnections(); await new Promise<void>((resolve) => proxy.close(() => resolve())); }
    if (child.exitCode === null) {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGTERM');
      const killTimer = setTimeout(() => child.kill('SIGKILL'), T.medium);
      await exited; clearTimeout(killTimer);
    }
    if (!preserve) await rm(root, { recursive: true, force: true });
  };
  try {
    const ready = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Studio daemon startup timeout: ${root}`)), T.xlong);
      child.once('message', (message: { url: string }) => { clearTimeout(timer); resolve(message.url); });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Studio daemon exited ${code}: ${root}`)); });
      child.once('error', reject);
    });
    child.send({ dataRoot: path.join(root, 'data'), appOrigin: origin, previewOrigin, workspaceRoot });
    target = new URL(await ready);
    const request = (method: string, route: string, cookie = '', body?: unknown): Promise<StudioResponse> => new Promise((resolve, reject) => {
      const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const req = https.request(new URL(route, origin), { method, rejectUnauthorized: false,
        headers: { origin, ...(cookie ? { cookie } : {}), ...(bytes ? { 'content-type': 'application/json', 'content-length': String(bytes.length) } : {}) } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.once('end', () => {
          const text = Buffer.concat(chunks).toString();
          let json: unknown = null; try { json = JSON.parse(text); } catch { /* byte route */ }
          resolve({ status: res.statusCode ?? 0, json, text, cookie: res.headers['set-cookie']?.[0]?.split(';')[0] ?? '' });
        });
      });
      req.once('error', reject); if (bytes) req.end(bytes); else req.end();
    });
    const required = async (method: string, route: string, cookie: string, body?: unknown) => {
      const result = await request(method, route, cookie, body);
      if (result.status < 200 || result.status >= 300) throw new Error(`${method} ${route}: ${result.status} ${result.text}`);
      return result;
    };
    const password = 'studio-browser-fixture-password';
    const boot = await required('POST', '/api/auth/bootstrap', '', { bootstrapToken: 'studio-browser-fixture-bootstrap-secret', username: 'studio-admin', password });
    const login = await required('POST', '/api/auth/login', '', { username: 'studio-admin', password });
    const admin = { id: boot.json.account.id as string, username: 'studio-admin', password, cookie: login.cookie };
    const actors = await Promise.all(['studio-a', 'studio-b'].map(async (username) => {
      const made = await required('POST', '/api/auth/users', admin.cookie, { username, password, role: 'user' });
      const signed = await required('POST', '/api/auth/login', '', { username, password });
      const actor = { id: made.json.account.id as string, username, password, cookie: signed.cookie };
      await required('PUT', `/api/admin/users/${actor.id}/studio-pilot`, admin.cookie, { studioPilot: true, revision: 0 });
      return actor;
    }));
    const linkCodex = async (actor: StudioPrincipal) => {
      const started = await required('POST', '/api/agent-accounts/codex/logins', actor.cookie, {});
      const actorRoot = path.join(root, 'data/multiuser-runtime', createHash('sha256').update(actor.id).digest('hex'));
      const dirs = await import('node:fs/promises').then(({ readdir }) => readdir(actorRoot));
      const home = dirs.find((name) => name.startsWith('codex-login-'));
      if (!home) throw new Error('Mock device login has no approval home');
      const deviceDir = path.join(actorRoot, home, '.mock-device');
      await mkdir(deviceDir, { recursive: true });
      await writeFile(path.join(deviceDir, started.json.attempt.userCode), JSON.stringify({ outcome: 'approve', email: `${actor.username}@example.test`, planType: 'plus' }), { mode: 0o600 });
      const deadline = Date.now() + T.medium;
      while (Date.now() < deadline) {
        const current = await required('GET', `/api/agent-accounts/codex/logins/${started.json.attempt.id}`, actor.cookie);
        if (current.json.attempt.status === 'connected') return;
        if (current.json.attempt.status !== 'pending') throw new Error('Mock Codex connection failed');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error('Mock Codex connection timeout');
    };
    const configureTurn = async (actor: StudioPrincipal, control: { reply: string; artifactBytes?: Record<string, string> }) => {
      const home = path.join(root, 'data/multiuser-runtime', createHash('sha256').update(actor.id).digest('hex'), 'codex-home');
      await writeFile(path.join(home, 'mock-control.json'), JSON.stringify(control), { mode: 0o600 });
    };
    return { root, origin, previewOrigin, admin, a: actors[0]!, b: actors[1]!, request, linkCodex, configureTurn, close };
  } catch (error) { await close(true); throw error; }
}

export function studioProjectId(): string { return randomUUID(); }
