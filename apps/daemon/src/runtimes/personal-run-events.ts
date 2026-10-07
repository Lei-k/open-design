import path from 'node:path';
import { createHash } from 'node:crypto';
import { stampToolTiming, type ToolTimingClock } from './tool-timing.js';
import { parseCodexErrorDetail, type CodexErrorDetail } from './codex-error-info.js';
import type { ChatSseEvent, DaemonAgentPayload } from '@open-design/contracts';

const TEXT_LIMIT = 512 * 1024;
const EVENT_LIMIT = 2048;
const BYTE_LIMIT = 2 * 1024 * 1024;
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
  private pendingType: 'text_delta' | 'thinking_delta' = 'text_delta';
  private pendingOverflow = false;
  private marked = false;
  constructor(private readonly cwd: string, private readonly privateRoots: string[], private readonly emit: (event: ChatSseEvent) => void, private readonly clock?: ToolTimingClock) {}

  private scrub(text: string): string {
    for (const root of [...this.privateRoots].sort((a, b) => b.length - a.length)) if (root) text = text.replaceAll(root, '[private path]');
    return text
      .replace(/\b(?:Bearer\s+|sk-)[A-Za-z0-9._-]+/giu, '[credential omitted]')
      .replace(/\b[A-Z][A-Z0-9_]*\s*=\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s<>]+)/gu, '[environment omitted]')
      .replace(/(?<![\w:/])(?:\/(?:home|root|opt|tmp|var|etc|Users|host)\/|[A-Z]:\\)[^\s"<>]+/gu, '[private path]');
  }
  private mark(): void {
    this.truncated = true;
    if (this.marked) return;
    this.marked = true;
    this.emit({ event: 'agent', data: { type: 'status', label: 'warning', detail: 'Run event storage limit reached; some content was omitted.' } });
    this.emit({ event: 'diagnostic', data: { type: 'personal_event_budget', truncated: true, maxEvents: EVENT_LIMIT, maxBytes: BYTE_LIMIT } });
  }
  private send(event: ChatSseEvent): boolean {
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (bytes > 16 * 1024 || this.count >= EVENT_LIMIT || this.bytes + bytes > BYTE_LIMIT) { this.mark(); return false; }
    this.count++; this.bytes += bytes;
    this.emit(event); return true;
  }
  flush(): void {
    if (!this.pending) return;
    const original = this.pending;
    const safe = this.scrub(original);
    this.pending = '';
    const bounded = prefix(safe, Math.max(0, TEXT_LIMIT - this.textBytes));
    if (bounded !== safe || this.pendingOverflow) this.mark();
    this.pendingOverflow = false;
    // Keep each durable event small, including when the provider sends a huge delta.
    let remaining = bounded;
    while (remaining) {
      const delta = prefix(remaining, 8 * 1024);
      remaining = remaining.slice(delta.length);
      const event: ChatSseEvent = { event: 'agent', data: { type: this.pendingType, delta,
        ...(safe === original ? {} : { redacted: redacted(['delta']) }) } };
      if (!this.send(event)) break;
      this.textBytes += Buffer.byteLength(delta);
      if (this.pendingType === 'text_delta') this.text += delta;
    }
  }
  accept(event: Record<string, unknown>): void {
    stampToolTiming(event, this.clock);
    const type = event.type;
    if (type === 'error') this.errorDetail ??= parseCodexErrorDetail(event.codexErrorInfo);
    if ((type === 'text_delta' || type === 'thinking_delta') && typeof event.delta === 'string') {
      if (this.pendingType !== type) this.flush();
      this.pendingType = type;
      const room = Math.max(0, TEXT_LIMIT - Buffer.byteLength(this.pending));
      const part = prefix(event.delta, room);
      this.pending += part;
      if (part !== event.delta) this.pendingOverflow = true;
      const end = this.pending.lastIndexOf('\n') + 1;
      if (end > 0) {
        const tail = this.pending.slice(end);
        this.pending = this.pending.slice(0, end);
        this.flush();
        this.pending = tail;
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
