// S62 A1/A3: the incremental remote-MCP event-stream reader.
import { describe, expect, it } from 'vitest';
import { SseFrameReader, SseLimitExceeded, sseStopWhen } from '../../src/mcp-client/sse-frames.js';
import { OutboundRequestRefused } from '../../src/http/safe-outbound-fetch.js';

const bytes = (text: string) => new TextEncoder().encode(text);

describe('SseFrameReader', () => {
  it('returns only newly completed blocks, across arbitrary chunk splits and CRLF/CR line endings', () => {
    const text = 'event: endpoint\r\ndata: /m?s=1\r\n\r\nevent: message\ndata: {"id":1}\n\ndata: a\rdata: b\r\r: end\n';
    for (let size = 1; size <= 7; size++) {
      const reader = new SseFrameReader(); const frames = [];
      const all = bytes(text);
      for (let i = 0; i < all.length; i += size) frames.push(...reader.push(all.subarray(i, i + size)));
      expect(frames, `chunk ${size}`).toEqual([{ event: 'endpoint', data: '/m?s=1' }, { event: 'message', data: '{"id":1}' }, { event: 'message', data: 'a\nb' }]);
    }
  });
  it('keeps a multi-byte character split between chunks intact', () => {
    const all = bytes('data: héllo ☃\n\n'); const reader = new SseFrameReader();
    const split = all.indexOf(0xe2) + 1;
    expect([...reader.push(all.subarray(0, split)), ...reader.push(all.subarray(split))]).toEqual([{ event: 'message', data: 'héllo ☃' }]);
  });
  it('skips comment / keep-alive / retry-only blocks (A3)', () => {
    expect(new SseFrameReader().push(bytes(': ping\n\n:keep-alive\nretry: 1000\n\nevent: endpoint\ndata: /x\n\n'))).toEqual([{ event: 'endpoint', data: '/x' }]);
  });
  it('caps the frame count and the frame size, including an unfinished frame, as an outbound size refusal', () => {
    const counted = new SseFrameReader({ maxFrames: 3, maxFrameChars: 100 });
    expect(() => counted.push(bytes(': a\n\n'.repeat(4)))).toThrow(SseLimitExceeded);
    const sized = new SseFrameReader({ maxFrames: 10, maxFrameChars: 16 });
    expect(() => sized.push(bytes(`data: ${'x'.repeat(20)}`))).toThrow(SseLimitExceeded);
    try { new SseFrameReader({ maxFrames: 1, maxFrameChars: 8 }).push(bytes('data: 123456789\n\n')); }
    catch (error) { expect(error).toBeInstanceOf(OutboundRequestRefused); expect((error as OutboundRequestRefused).reason).toBe('size'); }
  });
  it('parses many frames in linear time', () => {
    const reader = new SseFrameReader({ maxFrames: 1_000_000, maxFrameChars: 1024 });
    const chunk = bytes('event: ping\ndata: pppp\n\n'.repeat(50));
    const started = process.cpuUsage(); let total = 0;
    for (let i = 0; i < 4000; i++) total += reader.push(chunk).length;
    const used = process.cpuUsage(started); expect(total).toBe(200_000);
    expect((used.user + used.system) / 1000).toBeLessThan(2_000);
  });
});

describe('sseStopWhen', () => {
  it('reads JSON to its end and stops an event stream at the matching block', () => {
    const json = sseStopWhen(() => true);
    expect(json(bytes('  {"jsonrpc":"2.0"'))).toBe(false); expect(json(bytes('\n\n'))).toBe(false);
    const stream = sseStopWhen((frame) => frame.data === 'two');
    expect(stream(bytes('data: one\n\nda'))).toBe(false); expect(stream(bytes('ta: two\n'))).toBe(false); expect(stream(bytes('\n'))).toBe(true);
  });
});
