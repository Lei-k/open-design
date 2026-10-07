// Test-only stand-in for `codex app-server` (pinned protocol: codex 0.160.0),
// used by the multi-user personal-subscription tests (#18). JSON-RPC 2.0, one
// frame per line on stdio. It never opens a network connection, never talks to
// a provider and never reads host credentials: every bit of state lives in the
// CODEX_HOME the daemon handed it, so per-user home isolation is observable.
//
// Controls (all deterministic, all inside $CODEX_HOME):
// - Device login: after `account/login/start` (`chatgptDeviceCode`) the mock
//   waits for `$CODEX_HOME/.mock-device/<userCode>`, which stands for "the user
//   typed this code on the official page". JSON body:
//   { outcome, email?, planType? } where outcome is one of
//   approve | approve-stale-read | deny | expire | workspace | approve-replay | approve-after-cancel | approve-on-close.
//   `approve-stale-read` persists the credential but, like codex 0.154.0, answers this
//   process's next `account/read` without the account; a fresh process reads it from disk.
// - Turns: `$CODEX_HOME/mock-control.json` { turn?: ok|usage-limit|auth-invalid|workspace,
//   rateLimits?: ok|unavailable }. A prompt containing `[mock-delay-ms=N]` delays the turn;
//   `[mock-read=/abs/path]` reports in the reply whether that path was readable;
//   `[mock-write=relative/path]` writes a deterministic test artifact in cwd.
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

type Json = Record<string, unknown>;
const home = process.env.CODEX_HOME ?? '';
if (!home) { process.stderr.write('CODEX_HOME is required\n'); process.exit(2); }
const authFile = path.join(home, 'auth.json');
const threadsDir = path.join(home, 'sessions');

const send = (frame: Json) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`);
const notify = (method: string, params: Json) => send({ method, params });
const readJson = (file: string): Json | null => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as Json; } catch { return null; }
};
const control = () => readJson(path.join(home, 'mock-control.json')) ?? {};

let login: { loginId: string; userCode: string; timer: NodeJS.Timeout | null; outcome: Json | null } | null = null;
/** Set by `approve-stale-read`: this process has not reloaded the auth it just wrote. */
let staleAuth = false;

function writeAuth(outcome: Json): void {
  // Default umask on purpose: the daemon, not the provider, must enforce 0600.
  fs.writeFileSync(authFile, JSON.stringify({
    mock: true,
    email: typeof outcome.email === 'string' ? outcome.email : null,
    planType: typeof outcome.planType === 'string' ? outcome.planType : 'plus',
    tokens: { refresh_token: `mock-refresh-${randomBytes(8).toString('hex')}` },
  }));
}

function complete(loginId: string, success: boolean, error: string | null): void {
  notify('account/login/completed', { loginId, success, error });
}

function applyOutcome(outcome: Json): void {
  if (!login) return;
  const { loginId } = login;
  switch (outcome.outcome) {
    case 'approve': writeAuth(outcome); complete(loginId, true, null); login = null; return;
    case 'approve-stale-read': writeAuth(outcome); staleAuth = true; complete(loginId, true, null); login = null; return;
    case 'approve-replay':
      writeAuth(outcome);
      complete(loginId, true, null);
      complete(loginId, true, null);
      complete(randomUUID(), true, null);
      login = null;
      return;
    case 'deny': complete(loginId, false, 'access_denied: the user denied the device authorization'); login = null; return;
    case 'expire': complete(loginId, false, 'device code expired before authorization'); login = null; return;
    case 'workspace': complete(loginId, false, 'workspace policy does not allow device code login'); login = null; return;
    case 'approve-after-cancel':
    case 'approve-on-close':
      login.outcome = outcome; // completes later, on cancel / stdin EOF
      return;
    default: complete(loginId, false, 'mock: unknown outcome'); login = null;
  }
}

function pollDevice(): void {
  if (!login || login.outcome) return;
  const file = path.join(home, '.mock-device', login.userCode);
  const outcome = readJson(file);
  if (!outcome) return;
  // Consuming the file is the test's deterministic "the mock saw the decision" signal.
  fs.rmSync(file, { force: true });
  if (login.timer) clearInterval(login.timer);
  login.timer = null;
  applyOutcome(outcome);
}

function threadFile(id: string): string { return path.join(threadsDir, `${id.replace(/[^\w-]/g, '')}.json`); }

let activeTurn: { threadId: string; turnId: string; interrupted: boolean; release?: () => void } | null = null;

async function turn(id: number, params: Json): Promise<void> {
  const threadId = String(params.threadId ?? '');
  const input = Array.isArray(params.input) ? params.input as Json[] : [];
  const text = input.map((part) => (typeof part.text === 'string' ? part.text : '')).join('\n');
  const turnId = `turn_${randomUUID()}`;
  const active = { threadId, turnId, interrupted: false, release: undefined as (() => void) | undefined };
  activeTurn = active;
  send({ id, result: { turn: { id: turnId, status: 'inProgress', items: [] } } });
  notify('turn/started', { threadId, turn: { id: turnId, status: 'inProgress', items: [] } });
  const delay = /\[mock-delay-ms=(\d+)\]/u.exec(text);
  if (delay) await new Promise<void>((resolve) => { const timer = setTimeout(resolve, Math.min(Number(delay[1]), 5000)); active.release = () => { clearTimeout(timer); resolve(); }; });
  if (active.interrupted) return;
  const mode = fs.existsSync(authFile) ? String(control().turn ?? 'ok') : 'auth-invalid';
  const failed = (message: string, codexErrorInfo: string) => notify('turn/completed', {
    threadId, turn: { id: turnId, status: 'failed', items: [], error: { message, codexErrorInfo } },
  });
  if (mode === 'usage-limit') return failed("You've hit your usage limit.", 'usageLimitExceeded');
  if (mode === 'auth-invalid') return failed('unauthorized: provider session expired', 'unauthorized');
  if (mode === 'workspace') return failed('Your workspace does not allow this client', 'unauthorized');
  if (mode === 'model-error') return failed('Requested model is unavailable: FAKE_S3_SECRET at /host/private/s3', 'badRequest');
  const record = readJson(threadFile(threadId)) ?? { turns: 0 };
  record.turns = Number(record.turns ?? 0) + 1;
  fs.writeFileSync(threadFile(threadId), JSON.stringify(record));
  // `[mock-read=/abs/path]` stands for a task shell trying to read that path; the reply
  // says whether it could (isolation tests compare sandboxed and unsandboxed children).
  const reads: Record<string, string> = {};
  for (const match of text.matchAll(/\[mock-read=([^\]]+)\]/gu)) {
    try { fs.readFileSync(match[1]!); reads[match[1]!] = 'readable'; } catch (error) {
      reads[match[1]!] = (error as NodeJS.ErrnoException).code ?? 'error';
    }
  }
  const writes: string[] = [];
  for (const match of text.matchAll(/\[mock-write=([^\]]+)\]/gu)) {
    const relative = match[1]!.replaceAll('\\', '/');
    const target = path.resolve(process.cwd(), relative);
    const withinCwd = target.startsWith(`${path.resolve(process.cwd())}${path.sep}`);
    if (!withinCwd || relative.split('/').some((part) => part === '..' || part === '')) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `generated by ${turnId}\n`);
    writes.push(relative);
  }
  const parity = text.includes('[mock-parity]');
  if (parity) {
    notify('item/reasoning/summaryTextDelta', { threadId, turnId, itemId: 'reason', summaryIndex: 0, delta: 'Think through the layout.\n' });
    notify('warning', { threadId, message: 'Fixture warning' });
  }
  if (text.includes('[mock-progress]') || parity) {
    notify('turn/plan/updated', { threadId, turnId, plan: [
      { step: 'Draft the layout', status: 'inProgress' },
      { step: 'Verify the result', status: 'pending' },
    ] });
    const commandId = parity ? 'cmd_fixture' : `cmd_${randomUUID()}`;
    notify('item/started', { threadId, turnId, item: {
      type: 'commandExecution', id: commandId, command: 'test-command --redacted', aggregatedOutput: '', exitCode: null, status: 'inProgress',
    } });
    // Streamed output, each chunk past the normalizer's 250ms update throttle,
    // so every chunk becomes its own running-row (tool_in_flight) update.
    if (parity) {
      for (const delta of ['compiling PRIVATE_DELTA_OUTPUT=FAKE_S3_SECRET\n', 'wrote /host/private/s3/build.log\n']) {
        await new Promise((resolve) => setTimeout(resolve, 320));
        notify('item/commandExecution/outputDelta', { threadId, turnId, itemId: commandId, delta });
      }
    }
    notify('item/completed', { threadId, turnId, item: {
      type: 'commandExecution', id: commandId, command: 'test-command --redacted',
      aggregatedOutput: 'PRIVATE_COMMAND_OUTPUT=FAKE_S3_SECRET\nHOME=/host/private/s3\nAPI_TOKEN=FAKE_S3_SECRET\n', exitCode: 0, status: 'completed',
    } });
  }
  if (parity) {
    // Patch previews grow file by file before the item completes.
    const patch = [{ path: 'index.html', kind: 'add', diff: '+safe\n+<main></main>' }, { path: 'styles.css', kind: 'update', diff: '-a\n+b\n+c' }];
    for (const size of [1, 2]) notify('item/fileChange/patchUpdated', { threadId, turnId, itemId: 'file_fixture', changes: patch.slice(0, size) });
    for (const item of [
      { type: 'fileChange', id: 'file_fixture', status: 'completed', changes: patch },
      { type: 'mcpToolCall', id: 'mcp_fixture', server: 'fixture', tool: 'lookup', arguments: { secret: 'FAKE_S3_SECRET' }, result: { content: 'FAKE_S3_SECRET' }, status: 'completed' },
      { type: 'webSearch', id: 'web_fixture', query: 'layout', action: { type: 'search', query: 'layout' } },
    ]) notify('item/completed', { threadId, turnId, item });
    notify('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: { total: { inputTokens: 20, outputTokens: 10, reasoningOutputTokens: 2 } } });
  }
  for (const written of writes) {
    const fileId = `file_${randomUUID()}`;
    notify('item/completed', { threadId, turnId, item: {
      type: 'fileChange', id: fileId, status: 'completed', changes: [{ path: written, kind: 'add', diff: '+generated' }],
    } });
  }
  const normalReply = JSON.stringify({ codexHome: home, home: process.env.HOME ?? null, cwd: process.cwd(), threadId,
    turnsInThread: record.turns, message: text, envKeys: Object.keys(process.env).sort(),
    ...(Object.keys(reads).length > 0 ? { reads } : {}), ...(writes.length > 0 ? { writes } : {}) });
  fs.writeFileSync(path.join(home, 'mock-turn-evidence.json'), normalReply);
  // Deliberately exceeds the daemon's bounded final-text budget with
  // multi-byte characters, so integration tests cover UTF-8 truncation.
  const reply = parity ? 'Done.\n' : typeof control().reply === 'string' ? String(control().reply) : text.includes('[mock-large-output]') ? '界'.repeat(200_000) : normalReply;
  const itemId = `msg_${randomUUID()}`;
  notify('item/agentMessage/delta', { threadId, turnId, itemId, delta: reply });
  notify('item/completed', { threadId, turnId, item: { type: 'agentMessage', id: itemId, text: reply } });
  notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed', items: [] } });
}

function handle(frame: Json): void {
  const id = typeof frame.id === 'number' ? frame.id : null;
  const method = String(frame.method ?? '');
  const params = (frame.params && typeof frame.params === 'object' ? frame.params : {}) as Json;
  if (id === null) return; // `initialized` and other client notifications
  const fail = (code: number, message: string) => send({ id, error: { code, message } });
  switch (method) {
    case 'initialize': return send({ id, result: { userAgent: 'codex_mock/0.160.0 (mock)' } });
    case 'account/login/start': {
      if (params.type !== 'chatgptDeviceCode') return fail(-32602, 'mock supports chatgptDeviceCode only');
      const code = randomBytes(4).toString('hex').toUpperCase();
      login = { loginId: randomUUID(), userCode: `${code.slice(0, 4)}-${code.slice(4)}`, timer: null, outcome: null };
      login.timer = setInterval(pollDevice, 20);
      return send({ id, result: { type: 'chatgptDeviceCode', loginId: login.loginId, userCode: login.userCode,
        verificationUrl: `https://auth.openai.com/codex/device?mock=${randomBytes(6).toString('hex')}` } });
    }
    case 'account/login/cancel': {
      if (!login || params.loginId !== login.loginId) return send({ id, result: { status: 'notFound' } });
      const pending = login;
      if (pending.timer) clearInterval(pending.timer);
      login = null;
      send({ id, result: { status: 'canceled' } });
      if (pending.outcome?.outcome === 'approve-after-cancel') { writeAuth(pending.outcome); complete(pending.loginId, true, null); }
      return;
    }
    case 'account/read': {
      const auth = staleAuth ? null : readJson(authFile);
      return send({ id, result: { account: auth ? { type: 'chatgpt', email: auth.email ?? null, planType: auth.planType ?? 'unknown' } : null,
        requiresOpenaiAuth: true } });
    }
    case 'account/rateLimits/read': {
      const auth = readJson(authFile);
      if (!auth || control().rateLimits === 'unavailable') return fail(-32603, 'rate limits unavailable');
      return send({ id, result: { rateLimits: { limitId: 'codex', planType: auth.planType ?? null,
        primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1_900_000_000 }, secondary: null } } });
    }
    case 'account/logout': fs.rmSync(authFile, { force: true }); return send({ id, result: {} });
    case 'thread/start': {
      fs.mkdirSync(threadsDir, { recursive: true });
      const threadId = `thr_${randomUUID()}`;
      fs.writeFileSync(threadFile(threadId), JSON.stringify({ turns: 0 }));
      return send({ id, result: { thread: { id: threadId } } });
    }
    case 'thread/resume': {
      const threadId = String(params.threadId ?? '');
      if (!fs.existsSync(threadFile(threadId))) return fail(-32600, `no rollout found for thread id ${threadId}`);
      return send({ id, result: { thread: { id: threadId } } });
    }
    case 'turn/start': void turn(id, params); return;
    case 'turn/interrupt': {
      fs.writeFileSync(path.join(home, 'mock-interrupt.json'), JSON.stringify(params));
      send({ id, result: {} });
      if (activeTurn) {
        activeTurn.interrupted = true;
        activeTurn.release?.();
        notify('turn/completed', { threadId: activeTurn.threadId, turn: { id: activeTurn.turnId, status: 'interrupted', items: [] } });
      }
      return;
    }
    default: return fail(-32601, `mock: unsupported method ${method}`);
  }
}

let buffer = '';
process.stdin.on('data', (chunk: Buffer) => {
  buffer += chunk.toString('utf8');
  let newline: number;
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    try { handle(JSON.parse(line) as Json); } catch { /* ignore malformed frames */ }
  }
});
process.stdin.on('end', () => {
  if (login?.timer) clearInterval(login.timer);
  if (login?.outcome?.outcome === 'approve-on-close') { writeAuth(login.outcome); complete(login.loginId, true, null); }
  login = null;
  // Let pending turn timers finish writing, then exit like the real server does on EOF.
  setTimeout(() => process.exit(0), 10).unref();
});
