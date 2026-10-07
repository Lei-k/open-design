import path from 'node:path';
import { createHash } from 'node:crypto';
import { stampToolTiming, type ToolTimingClock } from './tool-timing.js';
import { parseCodexErrorDetail, type CodexErrorDetail } from './codex-error-info.js';
import { runSseEventToPersistedAgentEvent } from './chat-run-messages.js';
import type { ChatSseEvent, DaemonAgentPayload } from '@open-design/contracts';

const TEXT_LIMIT = 512 * 1024;
const EVENT_LIMIT = 2048;
const BYTE_LIMIT = 2 * 1024 * 1024;
const EVENT_BYTES = 16 * 1024;
/** The personal child's own environment names (appServerEnv) plus host identity. */
const RUN_ENV_NAMES = 'HOME|TMPDIR|TMP|TEMP|OD_DATA_DIR|CODEX_HOME|PATH|USER|USERNAME|LOGNAME|SHELL|PWD|OLDPWD|HOSTNAME';
/**
 * A name that carries a secret by convention (`API_TOKEN`, `SECRET_KEY`, `db_password`, `apiKey`),
 * ending at a word boundary so counters such as `max_tokens` or `token_count` stay ordinary code.
 */
const SECRET_NAME = String.raw`(?:(?:[A-Za-z_][\w-]*?[_-])?(?:token|secret|passw(?:or)?d|pwd|credentials?|cookie|(?:api|access|private|secret)[_-]?key)|[A-Za-z_][\w-]*?[_-]key)\d*\b`;
const VALUE = String.raw`(?:"[^"\n]*"|'[^'\n]*'|[^\s"'<>,;]+)`;
// `NAME=value` for both; the `NAME: value` (YAML/header) form only for upper-case env-style names,
// so prose such as "API token: optional" is untouched.
const SENSITIVE_ASSIGNMENT = new RegExp(String.raw`\b((?:${RUN_ENV_NAMES}|(?i:${SECRET_NAME}))\s*=\s*|(?:${RUN_ENV_NAMES}|[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIALS?)[A-Z0-9_]*)\s*:\s+)${VALUE}`, 'gu');
const CREDENTIAL_TOKEN = /\bBearer\s+[\w.~+/=-]{8,}|\bsk-[\w-]{20,}|\b(?:gh[pousr]_|github_pat_|xox[abprs]-)[\w-]{20,}|\bAKIA[0-9A-Z]{16}\b|\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/giu;
const redacted = (fields: string[]) => ({ policy: 'personal-subscription' as const, fields });
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const identifier = (value: unknown) => typeof value === 'string' && /^[\w.:/#-]{1,160}$/u.test(value) && !value.startsWith('/') ? value : `redacted-${createHash('sha256').update(String(value)).digest('hex').slice(0, 24)}`;
function prefix(text: string, bytes: number): string {
  const buffer = Buffer.from(text);
  let end = Math.min(bytes, buffer.length);
  while (end > 0 && end < buffer.length && (buffer[end]! & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString('utf8');
}

/** Privacy/storage boundary AFTER the shared Codex normalizer, never a protocol parser.
 * Tool arguments and results are deny-by-default. Text is buffered through a
 * complete line so a path/credential split across deltas cannot evade scrubbing.
 * Lifecycle frames are emitted by the caller outside this bounded content budget.
 */
export class PersonalRunEvents {
  text = '';
  errorDetail: CodexErrorDetail | null = null;
  truncated = false;
  private count = 0;
  private bytes = 0;
  private textBytes = 0;
  private pending = '';
  private pendingBytes = 0;
  private lastStored = '';
  private readonly inFlight = new Map<string, string>();
  private pendingType: 'text_delta' | 'thinking_delta' = 'text_delta';
  private pendingOverflow = false;
  private marked = false;
  constructor(private readonly cwd: string, private readonly privateRoots: string[], private readonly emit: (event: ChatSseEvent) => void, private readonly clock?: ToolTimingClock) {}

  /**
   * #77: only sensitive values are removed, so ordinary code (`WIDTH=1440`,
   * `API_URL = "https://…"`) and `<question-form>` content keep their meaning.
   * Sensitive means: this run's private roots (every run-environment path
   * value), the value assigned to a run-environment / host-identity name or a
   * secret-shaped name, and credential-shaped tokens wherever they appear.
   */
  private scrub(text: string): string {
    // Assignments first: a value is removed whole, before a root inside it is rewritten.
    text = text.replace(SENSITIVE_ASSIGNMENT, (_match, name: string) => `${name}[value omitted]`).replace(CREDENTIAL_TOKEN, '[credential omitted]');
    for (const root of [...this.privateRoots].sort((a, b) => b.length - a.length)) if (root) text = text.replaceAll(root, '[private path]');
    return text
      .replace(/(?<![\w:/])(?:\/(?:home|root|opt|tmp|var|etc|Users|host)\/|[A-Z]:\\)[^\s"<>]+/gu, '[private path]');
  }
  private mark(): void {
    this.truncated = true;
    if (this.marked) return;
    this.marked = true;
    this.publish({ event: 'agent', data: { type: 'status', label: 'warning', detail: 'Run event storage limit reached; some content was omitted.' } });
    this.publish({ event: 'diagnostic', data: { type: 'personal_event_budget', truncated: true, maxEvents: EVENT_LIMIT, maxBytes: BYTE_LIMIT } });
  }
  /**
   * #76: a frame that says nothing new — the stored form of the previous frame
   * again, or a running row's update whose only change was a dropped field —
   * is never streamed, stored or charged to the budget. Dropping it here keeps
   * live SSE, the mid-run transcript and the final transcript identical.
   */
  private repeats(event: ChatSseEvent): boolean {
    const persisted = runSseEventToPersistedAgentEvent(event.event, event.data);
    if (!persisted) return false;
    if (persisted.kind === 'text' || persisted.kind === 'thinking') { this.lastStored = ''; return false; }
    if (event.event === 'agent' && event.data.type === 'tool_in_flight') {
      const json = JSON.stringify(event.data);
      if (this.inFlight.get(event.data.id) === json) return true;
      this.inFlight.set(event.data.id, json);
    }
    const key = JSON.stringify(persisted);
    if (key === this.lastStored) return true;
    this.lastStored = key;
    return false;
  }
  private publish(event: ChatSseEvent): void {
    if (!this.repeats(event)) this.emit(event);
  }
  private send(event: ChatSseEvent): boolean {
    if (this.repeats(event)) return true;
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (bytes > EVENT_BYTES || this.count >= EVENT_LIMIT || this.bytes + bytes > BYTE_LIMIT) { this.mark(); return false; }
    this.count++; this.bytes += bytes;
    this.emit(event); return true;
  }
  flush(): void {
    if (!this.pending) return;
    const original = this.pending;
    const safe = this.scrub(original);
    this.pending = '';
    this.pendingBytes = 0;
    const bounded = Buffer.from(prefix(safe, Math.max(0, TEXT_LIMIT - this.textBytes)));
    if (bounded.length !== Buffer.byteLength(safe) || this.pendingOverflow) this.mark();
    this.pendingOverflow = false;
    // Keep each durable event under the per-event limit, including a huge or
    // escape-heavy delta: a JSON-escaped byte grows at most 6x, so a chunk that
    // does not fit at 8 KiB always fits at 2 KiB. One encode per flush.
    const event = (delta: string): ChatSseEvent => ({ event: 'agent', data: { type: this.pendingType, delta,
      ...(safe === original ? {} : { redacted: redacted(['delta']) }) } });
    for (let start = 0; start < bounded.length;) {
      let next: ChatSseEvent | null = null;
      let end = start;
      for (const size of [8 * 1024, 2 * 1024]) {
        end = Math.min(start + size, bounded.length);
        while (end > start && end < bounded.length && (bounded[end]! & 0xc0) === 0x80) end--;
        next = event(bounded.subarray(start, end).toString('utf8'));
        if (Buffer.byteLength(JSON.stringify(next)) <= EVENT_BYTES) break;
      }
      if (!next || !this.send(next)) break;
      const delta = (next.data as { delta: string }).delta;
      this.textBytes += end - start;
      if (this.pendingType === 'text_delta') this.text += delta;
      start = end;
    }
  }
  accept(event: Record<string, unknown>): void {
    stampToolTiming(event, this.clock);
    const type = event.type;
    if (type === 'error') this.errorDetail ??= parseCodexErrorDetail(event.codexErrorInfo);
    if ((type === 'text_delta' || type === 'thinking_delta') && typeof event.delta === 'string') {
      if (this.pendingType !== type) this.flush();
      this.pendingType = type;
      // Near-linear: only the new part is measured and searched for a line end.
      const room = Math.max(0, TEXT_LIMIT - this.pendingBytes);
      const part = Buffer.byteLength(event.delta) <= room ? event.delta : prefix(event.delta, room);
      this.pending += part;
      this.pendingBytes += Buffer.byteLength(part);
      if (part !== event.delta) this.pendingOverflow = true;
      const newline = part.lastIndexOf('\n');
      if (newline >= 0) {
        const tail = part.slice(newline + 1);
        this.pending = this.pending.slice(0, this.pending.length - tail.length);
        this.flush();
        this.pending = tail;
        this.pendingBytes = Buffer.byteLength(tail);
      }
      return;
    }
    this.flush();
    let data: DaemonAgentPayload | null = null;
    if (type === 'status') data = { type, label: identifier(event.label),
      ...(typeof event.sessionId === 'string' ? { sessionId: identifier(event.sessionId) } : {}),
      ...(event.detail || event.model ? { redacted: redacted(['detail', 'model']) } : {}) };
    if (type === 'thinking_start') data = { type };
    if (type === 'thinking_tokens' && typeof event.tokens === 'number' && Number.isFinite(event.tokens)) data = { type, tokens: event.tokens };
    if (type === 'tool_use' || type === 'tool_in_flight') {
      const input = record(event.input);
      const safe: Record<string, unknown> = {};
      if (/todo|update_plan/iu.test(String(event.name))) {
        const items = Array.isArray(input.todos) ? input.todos : Array.isArray(input.plan) ? input.plan : [];
        safe.todos = items.slice(0, 64).map((item) => {
          const task = record(item);
          return { content: this.scrub(String(task.content ?? task.step ?? '')).slice(0, 500),
            status: ['pending', 'in_progress', 'completed'].includes(String(task.status)) ? task.status : 'pending' };
        });
      }
      const stat = record(input.od_diff_stat);
      if (Number.isSafeInteger(stat.added) && Number(stat.added) >= 0 && Number.isSafeInteger(stat.removed) && Number(stat.removed) >= 0) {
        safe.od_diff_stat = { added: stat.added, removed: stat.removed };
      }
      const file = input.file_path ?? input.path;
      if (typeof file === 'string') {
        const relative = path.relative(this.cwd, path.resolve(this.cwd, file)).replaceAll('\\', '/');
        if (relative && relative !== '..' && !relative.startsWith('../') && !path.isAbsolute(relative)) safe.file_path = relative.slice(0, 1024);
      }
      data = type === 'tool_in_flight'
        ? { type, id: identifier(event.id), name: identifier(event.name), input: safe,
          redacted: redacted(['input', 'output']), startedAt: Number(event.startedAt) }
        : { type, id: identifier(event.id), name: identifier(event.name), input: safe,
          redacted: redacted(['input']), ...(typeof event.startedAt === 'number' ? { startedAt: event.startedAt } : {}) };
    }
    if (type === 'tool_result') data = { type, toolUseId: identifier(event.toolUseId),
      content: '[Tool output omitted by personal-subscription privacy policy]', isError: event.isError === true,
      redacted: redacted(['content']), ...(typeof event.completedAt === 'number' ? { completedAt: event.completedAt } : {}) };
    if (type === 'usage') {
      const usage = record(event.usage);
      data = { type, usage: Object.fromEntries(['input_tokens', 'output_tokens'].flatMap((key) =>
        typeof usage[key] === 'number' && Number.isFinite(usage[key]) && Number(usage[key]) >= 0 ? [[key, usage[key]]] : [])) };
    }
    if (data) this.send({ event: 'agent', data });
    else if (type !== 'turn_end') this.send({ event: 'diagnostic', data: { type: 'personal_provider_event',
      providerType: identifier(type), redacted: redacted(['payload']) } });
  }
}
