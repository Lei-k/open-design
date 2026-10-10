/**
 * Incremental, bounded Server-Sent Events reader for remote MCP streams (S62 A1).
 *
 * A hostile server can answer one request with a long stream of tiny frames.
 * The S61 parser re-joined and re-parsed the whole buffer on every chunk, so one
 * `tools/call` cost CPU quadratic in the stream length. This reader is linear:
 *
 * - each chunk is decoded once (a streaming UTF-8 decoder keeps a split code
 *   point for the next chunk) and appended to the unfinished tail only;
 * - only newly completed blocks are split out, by a forward scan from where the
 *   previous scan stopped, and the consumed prefix is dropped once per chunk;
 * - blocks without a `data:` line (comments such as `: ping`, `retry:` only)
 *   are skipped (S62 A3), and the caller decides cheaply by event name whether a
 *   block is worth parsing at all;
 * - at most `maxFrames` blocks per stream and `maxFrameChars` (decoded
 *   characters) per block, including an unfinished one; exceeding either throws
 *   `SseLimitExceeded`.
 *
 * Line endings follow the SSE specification: CRLF, LF and lone CR.
 */
import { OutboundRequestRefused } from '../http/safe-outbound-fetch.js';

/** A stream past its frame count or frame size bound: refused as an outbound `size` violation. */
export class SseLimitExceeded extends OutboundRequestRefused { constructor() { super('size'); this.name = 'SseLimitExceeded'; } }

export interface SseFrame { event: string; data: string }

export const SSE_DEFAULT_LIMITS = { maxFrames: 1024, maxFrameChars: 1024 * 1024 } as const;

export class SseFrameReader {
  private readonly decoder = new TextDecoder('utf-8');
  private tail = '';
  /** Index in `tail` up to which no block separator can start (resume the scan here). */
  private scanned = 0;
  private pendingCr = false;
  private frames = 0;
  constructor(private readonly limits: { maxFrames: number; maxFrameChars: number } = SSE_DEFAULT_LIMITS) {}

  /** Feed the next chunk; returns only the blocks it completed (data-less blocks omitted). */
  push(bytes: Uint8Array): SseFrame[] {
    let text = this.decoder.decode(bytes, { stream: true });
    if (this.pendingCr) { text = `\r${text}`; this.pendingCr = false; }
    // A CR at the very end may be the first half of a CRLF; decide with the next chunk.
    if (text.endsWith('\r')) { this.pendingCr = true; text = text.slice(0, -1); }
    if (text.includes('\r')) text = text.replace(/\r\n?/g, '\n');
    this.tail += text;
    const out: SseFrame[] = [];
    let start = 0;
    for (;;) {
      const end = this.tail.indexOf('\n\n', Math.max(start, this.scanned));
      if (end < 0) break;
      const block = this.tail.slice(start, end);
      start = end + 2; this.scanned = start;
      if (block.length > this.limits.maxFrameChars || ++this.frames > this.limits.maxFrames) throw new SseLimitExceeded();
      const frame = parseBlock(block);
      if (frame) out.push(frame);
    }
    if (start) { this.tail = this.tail.slice(start); this.scanned = 0; }
    // Resume the next scan one character early: a separator may straddle chunks.
    this.scanned = Math.max(0, this.tail.length - 1);
    if (this.tail.length > this.limits.maxFrameChars) throw new SseLimitExceeded();
    return out;
  }
}

function parseBlock(block: string): SseFrame | null {
  let event = 'message'; let data: string[] | null = null;
  for (const line of block.split('\n')) {
    if (line.startsWith('data:')) (data ??= []).push(line.slice(line.startsWith('data: ') ? 6 : 5));
    else if (line.startsWith('event:')) event = line.slice(6).trim() || 'message';
  }
  return data ? { event, data: data.join('\n') } : null;
}

const isSpace = (byte: number) => byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;

/**
 * A `stopWhen` for a response that may be JSON or an event stream, decided by
 * its first non-space byte: JSON (`{`/`[`) is read to its end (still bounded by
 * the guarded fetch), an event stream stops at the first block `matches`
 * accepts. Each chunk is parsed once; see `SseFrameReader`.
 */
export function sseStopWhen(matches: (frame: SseFrame) => boolean,
  limits: { maxFrames: number; maxFrameChars: number } = SSE_DEFAULT_LIMITS): (chunk: Uint8Array) => boolean {
  const reader = new SseFrameReader(limits); let mode: 'json' | 'sse' | null = null;
  return (chunk) => {
    if (mode === null) {
      const first = chunk.findIndex((byte) => !isSpace(byte));
      if (first >= 0) mode = chunk[first] === 0x7b || chunk[first] === 0x5b ? 'json' : 'sse';
    }
    if (mode === 'json') return false;
    return reader.push(chunk).some(matches);
  };
}
