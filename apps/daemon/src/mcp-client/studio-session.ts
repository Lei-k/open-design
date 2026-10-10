import { type SafeOutboundFetch, type SafeOutboundInit } from '../http/safe-outbound-fetch.js';
import { SseFrameReader, sseStopWhen, type SseFrame } from './sse-frames.js';

const VERSION = '2025-06-18';
export class StudioMcpProtocolError extends Error { constructor() { super('remote MCP protocol refused'); } }
type Message = { jsonrpc?: unknown; id?: unknown; result?: unknown; error?: unknown };
function message(raw: string): Message {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new StudioMcpProtocolError();
  return value as Message;
}
/** The JSON-RPC id of a `message` block, parsing each block at most once; null for anything else. */
function frameId(frame: SseFrame): unknown {
  if (frame.event !== 'message') return null;
  try { return message(frame.data).id; } catch { return null; }
}
const checkedResult = (value: Message, id: number): unknown => {
  if (value.jsonrpc !== '2.0' || value.id !== id || value.error !== undefined || value.result === undefined) throw new StudioMcpProtocolError();
  return value.result;
};

/**
 * One bounded session per operation. All messages, including the SSE POST
 * endpoint, use the same guard and authority hook. Event streams are parsed
 * incrementally (S62 A1): every chunk is read once, data-less comment /
 * keep-alive blocks are skipped (S62 A3), and frame count/size are capped
 * (`SseFrameReader`), so a hostile stream costs CPU linear in its bytes.
 */
export async function studioMcpSession(input: {
  safe: SafeOutboundFetch; url: string; transport: 'http' | 'sse'; signal: AbortSignal;
  beforeConnect: NonNullable<SafeOutboundInit['beforeConnect']>; live(): void;
  endpointAllowed(url: string): boolean;
}, operation: (rpc: (method: string, params?: unknown) => Promise<unknown>) => Promise<unknown>): Promise<unknown> {
  let seq = 0; let session: string | null = null; let protocolVersion: string = VERSION;
  const headers = () => ({ accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'mcp-protocol-version': protocolVersion,
    ...(session ? { 'mcp-session-id': session } : {}) });
  const envelope = (method: string, params: unknown, id?: number) => JSON.stringify({ jsonrpc: '2.0', ...(id ? { id } : {}), method, ...(params !== undefined ? { params } : {}) });
  const post = async (url: string, method: string, params: unknown, id?: number) => {
    input.live();
    let matched: string | undefined;
    const stopWhen = id === undefined ? undefined : sseStopWhen((frame) => frameId(frame) === id && (matched = frame.data, true));
    const response = await input.safe(url, { method: 'POST', headers: headers(), body: envelope(method, params, id), signal: input.signal,
      beforeConnect: input.beforeConnect, ...(stopWhen ? { stopWhen } : {}) });
    // The body ended without a match: finalize the reader at EOF (an unterminated block is discarded).
    if (stopWhen && matched === undefined) stopWhen.end();
    input.live();
    if (response.status < 200 || response.status >= 300) throw new StudioMcpProtocolError();
    const next = response.headers.get('mcp-session-id');
    if (next !== null) { if (!/^[\x21-\x7e]{1,256}$/.test(next)) throw new StudioMcpProtocolError(); session = next; }
    return { response, matched };
  };
  const initialize = async (rpc: (method: string, params?: unknown) => Promise<unknown>, notify: () => Promise<void>) => {
    const init = await rpc('initialize', { protocolVersion: VERSION, capabilities: {}, clientInfo: { name: 'OpenDesign Studio', version: '1' } }); input.live();
    if (!init || typeof init !== 'object' || !/^\d{4}-\d{2}-\d{2}$/.test(String((init as Record<string, unknown>).protocolVersion))) throw new StudioMcpProtocolError();
    protocolVersion = String((init as Record<string, unknown>).protocolVersion);
    await notify(); input.live();
    const result = await operation(rpc); input.live(); return result;
  };
  if (input.transport === 'http') {
    const rpc = async (method: string, params?: unknown) => {
      const id = ++seq; const { response, matched } = await post(input.url, method, params, id); input.live();
      // An event stream answers with the block the incremental reader already matched; never re-parse the body.
      const raw = /text\/event-stream/i.test(response.headers.get('content-type') ?? '') ? matched : response.text();
      if (!raw) throw new StudioMcpProtocolError(); return checkedResult(message(raw), id);
    };
    return initialize(rpc, async () => { await post(input.url, 'notifications/initialized', undefined); input.live(); });
  }
  // Legacy SSE keeps its inbound stream open while initialize/list/call POSTs run.
  const stop = new AbortController(); const signal = AbortSignal.any([input.signal, stop.signal]);
  const waits = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void }>();
  let endpoint: string | null = null; let started = false;
  let work: Promise<unknown> | undefined;
  const reader = new SseFrameReader();
  const rpc = async (method: string, params?: unknown) => {
    const id = ++seq;
    const answer = new Promise<unknown>((resolve, reject) => waits.set(id, { resolve, reject }));
    // Attach rejection handling before POST: revocation may end the stream during its await.
    answer.catch(() => {});
    await post(endpoint!, method, params, id); input.live();
    const result = await answer; input.live(); return result;
  };
  try {
    await input.safe(input.url, { headers: { accept: 'text/event-stream' }, signal, beforeConnect: input.beforeConnect,
      onChunk: (chunk) => handle(reader.push(chunk)) });
    // EOF: finalize the reader (complete blocks only; an unterminated one is discarded).
    handle(reader.end());
    input.live();
    if (!work) throw new StudioMcpProtocolError();
  } catch (error) {
    for (const waiter of waits.values()) waiter.reject(new StudioMcpProtocolError()); waits.clear();
    input.live();
    if (!stop.signal.aborted || !work) throw error;
  } finally { stop.abort(); }
  if (!work) throw new StudioMcpProtocolError();
  const result = await work; input.live(); return result;
  function handle(frames: SseFrame[]): void {
    // Recheck authority before acting on any message; data-less and unrelated
    // blocks are only counted (the runtime's 20 ms watch covers idle streams).
    for (const frame of frames) {
      if (frame.event !== 'endpoint' && frame.event !== 'message') continue;
      input.live();
      if (frame.event === 'endpoint' && !started) {
        const target = new URL(frame.data, input.url);
        if (target.origin !== new URL(input.url).origin || !input.endpointAllowed(target.toString())) throw new StudioMcpProtocolError();
        endpoint = target.toString(); started = true;
        work = initialize(rpc, async () => { await post(endpoint!, 'notifications/initialized', undefined); input.live(); });
        // End the inbound socket on both success and refusal, including while idle.
        work.then(() => stop.abort(), () => stop.abort());
      } else if (frame.event === 'message') {
        const value = message(frame.data); const waiter = waits.get(Number(value.id));
        if (waiter) { waits.delete(Number(value.id)); try { waiter.resolve(checkedResult(value, Number(value.id))); } catch (error) { waiter.reject(error); } }
      }
    }
  }
}
