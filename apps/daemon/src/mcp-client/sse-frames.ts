/**
 * Incremental, bounded Server-Sent Events reader for remote MCP streams (S62 A1,
 * S62 Repair 1).
 *
 * A hostile server can answer one request with a long stream of tiny frames, or
 * with ONE frame that grows a byte at a time and never ends. Both must cost CPU
 * linear in the bytes received:
 *
 * - each chunk is decoded once (a streaming UTF-8 decoder keeps a split code
 *   point for the next chunk) and only the newly decoded characters are scanned
 *   for a line end; the scan never revisits earlier text;
 * - the unfinished line is kept as a list of fragments and joined exactly once,
 *   when its line end arrives; a completed block is never re-joined or re-split;
 * - line endings follow the SSE specification: CRLF, LF and lone CR. A CR ends
 *   its line immediately; an LF that directly follows it (possibly in the next
 *   chunk) is swallowed, so a block terminated by `\r\r` is dispatched without
 *   waiting for more bytes;
 * - blocks without a `data:` line (comments such as `: ping`, `retry:` only)
 *   are skipped (S62 A3), and the caller decides cheaply by event name whether a
 *   block is worth parsing at all;
 * - at most `maxFrames` blocks per stream and `maxFrameChars` (decoded
 *   characters, line ends included) per block; the size bound is enforced on the
 *   accumulated length of the unfinished block BEFORE anything is joined.
 *   Exceeding either throws `SseLimitExceeded`;
 * - `end()` finalizes the stream at EOF as the specification says: a pending
 *   unterminated block is discarded, never dispatched.
 */
import { OutboundRequestRefused } from '../http/safe-outbound-fetch.js';

/** A stream past its frame count or frame size bound: refused as an outbound `size` violation. */
export class SseLimitExceeded extends OutboundRequestRefused { constructor() { super('size'); this.name = 'SseLimitExceeded'; } }

export interface SseFrame { event: string; data: string }

export const SSE_DEFAULT_LIMITS = { maxFrames: 1024, maxFrameChars: 1024 * 1024 } as const;

const LF = 0x0a; const CR = 0x0d;

export class SseFrameReader {
  private readonly decoder = new TextDecoder('utf-8');
  /** Fragments of the current unfinished line, joined once at its line end. */
  private line: string[] = [];
  private lineChars = 0;
  /** Characters (line ends included) of the completed lines of the current block. */
  private blockChars = 0;
  private event = 'message';
  private data: string[] | null = null;
  /** The previous chunk ended in CR: an LF opening the next chunk belongs to it. */
  private swallowLf = false;
  private frames = 0;
  private ended = false;
  constructor(private readonly limits: { maxFrames: number; maxFrameChars: number } = SSE_DEFAULT_LIMITS) {}

  /** Feed the next chunk; returns only the blocks it completed (data-less blocks omitted). */
  push(bytes: Uint8Array): SseFrame[] {
    if (this.ended) return [];
    return this.feed(this.decoder.decode(bytes, { stream: true }));
  }

  /** EOF: flush the decoder; an unterminated trailing block is discarded (SSE spec). */
  end(): SseFrame[] {
    if (this.ended) return [];
    const out = this.feed(this.decoder.decode());
    this.ended = true; this.line = []; this.lineChars = 0; this.resetBlock();
    return out;
  }

  private feed(text: string): SseFrame[] {
    const out: SseFrame[] = [];
    const n = text.length; let i = 0;
    if (this.swallowLf && n) { if (text.charCodeAt(0) === LF) i = 1; this.swallowLf = false; }
    while (i < n) {
      // Forward scan of the new characters only.
      let j = i; let code = 0;
      for (; j < n; j++) { code = text.charCodeAt(j); if (code === LF || code === CR) break; }
      if (j > i) {
        this.lineChars += j - i;
        // The cap applies to the accumulated block before any join.
        if (this.blockChars + this.lineChars > this.limits.maxFrameChars) throw new SseLimitExceeded();
        this.line.push(text.slice(i, j));
      }
      if (j >= n) break;
      i = j + 1;
      if (code === CR) {
        if (i < n) { if (text.charCodeAt(i) === LF) i += 1; } else this.swallowLf = true;
      }
      const frame = this.endLine();
      if (frame) out.push(frame);
    }
    return out;
  }

  private endLine(): SseFrame | null {
    const line = this.line.length === 0 ? '' : this.line.length === 1 ? this.line[0]! : this.line.join('');
    this.line = []; this.lineChars = 0;
    if (line === '') {
      // A blank line ends the block: count it, dispatch it if it carried data.
      if (++this.frames > this.limits.maxFrames) throw new SseLimitExceeded();
      const frame = this.data ? { event: this.event, data: this.data.join('\n') } : null;
      this.resetBlock();
      return frame;
    }
    this.blockChars += line.length + 1;
    if (this.blockChars > this.limits.maxFrameChars) throw new SseLimitExceeded();
    if (line.charCodeAt(0) === 0x3a) return null; // `:` comment / keep-alive
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.charCodeAt(0) === 0x20) value = value.slice(1);
    if (field === 'data') (this.data ??= []).push(value);
    else if (field === 'event') this.event = value.trim() || 'message';
    return null;
  }

  private resetBlock(): void { this.event = 'message'; this.data = null; this.blockChars = 0; }
}

const isSpace = (byte: number) => byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;

/** A `stopWhen` that can also be finalized at EOF (`end`), see `SseFrameReader.end`. */
export type SseStopWhen = ((chunk: Uint8Array) => boolean) & { end(): boolean };

/**
 * A `stopWhen` for a response that may be JSON or an event stream, decided by
 * its first non-space byte: JSON (`{`/`[`) is read to its end (the guarded
 * fetch keeps chunks in a list and joins them once), an event stream stops at
 * the first block `matches` accepts. Each chunk is parsed once; see
 * `SseFrameReader`. Call `end()` after the body ended without a match.
 */
export function sseStopWhen(matches: (frame: SseFrame) => boolean,
  limits: { maxFrames: number; maxFrameChars: number } = SSE_DEFAULT_LIMITS): SseStopWhen {
  const reader = new SseFrameReader(limits); let mode: 'json' | 'sse' | null = null;
  const stop = ((chunk: Uint8Array) => {
    if (mode === null) {
      const first = chunk.findIndex((byte) => !isSpace(byte));
      if (first >= 0) mode = chunk[first] === 0x7b || chunk[first] === 0x5b ? 'json' : 'sse';
    }
    if (mode === 'json') return false;
    return reader.push(chunk).some(matches);
  }) as SseStopWhen;
  stop.end = () => mode !== 'json' && reader.end().some(matches);
  return stop;
}
