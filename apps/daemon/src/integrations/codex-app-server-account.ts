// Per-user `codex app-server` process for the personal-subscription lane (#18).
//
// One isolated child per account action (device login, identity read-back,
// verification turn, personal run). The child gets an explicit environment:
// its own CODEX_HOME, a HOME/TMPDIR beside it and the resolved daemon data root
// (root AGENTS.md data-directory contract). Nothing else is inherited, so host
// provider keys and another user's CODEX_HOME never reach it.
//
// stderr is drained and discarded and frames are never logged: device codes and
// verification URLs travel on this channel.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { sandboxedCommand, type PersonalSandbox } from '../services/personal-sandbox.js';

type Json = Record<string, unknown>;

export class AppServerRpcError extends Error {
  constructor(readonly method: string, readonly code: number | null) {
    super(`app-server ${method} failed${code === null ? '' : ` (${code})`}`);
    this.name = 'AppServerRpcError';
  }
}

export interface AppServerEnvironment {
  /** Executable plus fixed arguments (this slice: node + the repository mock). */
  command: readonly [string, ...string[]];
  codexHome: string;
  home: string;
  temp: string;
  cwd: string;
  dataRoot: string;
  /**
   * When set, the child starts inside this bubblewrap sandbox: only CODEX_HOME,
   * HOME, TMPDIR and the working directory are writable, and nothing else of the
   * daemon data root exists inside (`personal-sandbox.ts`).
   */
  sandbox?: PersonalSandbox | null;
}

/** Fixed search path inside the sandbox, where only system directories exist. */
const SANDBOX_PATH = '/usr/local/bin:/usr/bin:/bin';

export function appServerEnv(env: AppServerEnvironment): NodeJS.ProcessEnv {
  return { HOME: env.home, TMPDIR: env.temp, TMP: env.temp, TEMP: env.temp, OD_DATA_DIR: env.dataRoot, CODEX_HOME: env.codexHome,
    ...(env.sandbox ? { PATH: SANDBOX_PATH } : {}) };
}

export function spawnAppServer(env: AppServerEnvironment): ChildProcessWithoutNullStreams {
  const [bin, ...args] = env.sandbox
    ? sandboxedCommand(env.sandbox, { codexHome: env.codexHome, home: env.home, temp: env.temp, cwd: env.cwd }, env.command)
    : env.command;
  const child = spawn(bin, args, { cwd: env.cwd, env: appServerEnv(env), stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.on('data', () => {});
  child.stdin.on('error', () => {});
  child.on('error', () => {});
  return child;
}

/** Wait for exit after closing stdin, escalating to TERM/KILL within bounds. */
export async function closeChild(child: ChildProcessWithoutNullStreams, graceMs = 1_500): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));
  const within = async (ms: number) => {
    let timer: NodeJS.Timeout | undefined;
    const done = await Promise.race([exited.then(() => true), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), ms); })]);
    if (timer) clearTimeout(timer);
    return done;
  };
  try { child.stdin.end(); } catch { /* already closed */ }
  if (await within(graceMs)) return;
  child.kill('SIGTERM');
  if (await within(1_000)) return;
  child.kill('SIGKILL');
  await within(1_000);
}

/** Minimal JSON-RPC client for account methods (`account/*`, `initialize`). */
export class AppServerAccountClient {
  readonly child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private buffer = '';
  private readonly pending = new Map<number, { method: string; resolve: (value: Json) => void; reject: (error: Error) => void }>();
  private readonly listeners = new Set<(method: string, params: Json) => void>();

  constructor(env: AppServerEnvironment) {
    this.child = spawnAppServer(env);
    this.child.stdout.on('data', (chunk: Buffer) => this.read(chunk));
    this.child.once('close', () => {
      for (const entry of this.pending.values()) entry.reject(new AppServerRpcError(entry.method, null));
      this.pending.clear();
    });
  }

  onNotification(listener: (method: string, params: Json) => void): void {
    this.listeners.add(listener);
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      clientInfo: { name: 'open-design', title: 'Open Design', version: '0.0.0' },
      capabilities: { experimentalApi: false, requestAttestation: false },
    });
    this.write({ jsonrpc: '2.0', method: 'initialized', params: {} });
  }

  request(method: string, params: Json | null, timeoutMs = 10_000): Promise<Json> {
    const id = this.nextId++;
    return new Promise<Json>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AppServerRpcError(method, null));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, {
        method,
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.write({ jsonrpc: '2.0', id, method, ...(params === null ? {} : { params }) });
    });
  }

  close(): Promise<void> {
    return closeChild(this.child);
  }

  private write(frame: Json): void {
    if (this.child.stdin.destroyed) return;
    try { this.child.stdin.write(`${JSON.stringify(frame)}\n`); } catch { /* child gone */ }
  }

  private read(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let frame: Json;
      try { frame = JSON.parse(line) as Json; } catch { continue; }
      if (!frame || typeof frame !== 'object') continue;
      if (typeof frame.id === 'number' && typeof frame.method !== 'string') {
        const entry = this.pending.get(frame.id);
        this.pending.delete(frame.id);
        if (!entry) continue;
        if (frame.error !== undefined) {
          const code = (frame.error as { code?: unknown } | null)?.code;
          entry.reject(new AppServerRpcError(entry.method, typeof code === 'number' ? code : null));
        } else entry.resolve(frame.result && typeof frame.result === 'object' ? frame.result as Json : {});
        continue;
      }
      if (typeof frame.method === 'string' && frame.id === undefined) {
        const params = frame.params && typeof frame.params === 'object' ? frame.params as Json : {};
        for (const listener of this.listeners) listener(frame.method, params);
      } else if (typeof frame.id === 'number' && typeof frame.method === 'string') {
        // Server-to-client request: nothing here answers one.
        this.write({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'unsupported request' } });
      }
    }
  }
}
