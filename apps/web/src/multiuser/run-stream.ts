import { parseSseFrame, type ParsedSseFrame } from '../providers/sse';
import type { OwnedSession } from './owned';
import { isAbort } from './run-errors';
import { RequestFailure } from './session';
type Frame = Extract<ParsedSseFrame, { kind: 'event' }>;
export const RECONNECT_BASE_MS = 1_500;
export const RECONNECT_MAX_MS = 30_000;

/**
 * Persisted sequence is the replay cursor. Reconnects must never append it twice.
 * Reconnect delays double up to a ceiling and reset only after a connection
 * delivered a new event; a bare replay does not count as progress.
 */
export function watchRunEvents(
  owner: OwnedSession, runId: string,
  onEvent: (frame: Frame) => void, onReconnect: (reconnecting: boolean) => void,
  onFailure: (error: unknown) => void,
): () => void {
  const controller = new AbortController();
  const release = owner.session.bindMount(controller, owner.generation);
  let lastSeq = 0;
  let terminal = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const cancelReader = () => { void reader?.cancel().catch(() => {}); if (timer) clearTimeout(timer); };
  controller.signal.addEventListener('abort', cancelReader, { once: true });
  async function connect() {
    if (controller.signal.aborted || terminal) return;
    try {
      const response = await owner.session.stream(`/api/runs/${encodeURIComponent(runId)}/events`, controller.signal, owner.generation, lastSeq ? String(lastSeq) : undefined);
      if (controller.signal.aborted) { await response.body?.cancel(); return; }
      if (!response.body) throw new Error('Missing event stream');
      reader = response.body.getReader();
      onReconnect(false);
      const decoder = new TextDecoder();
      let buffer = '';
      while (!controller.signal.aborted && !terminal) {
        const next = await reader.read();
        if (controller.signal.aborted) break;
        if (next.done) break;
        buffer += decoder.decode(next.value, { stream: true });
        let boundary: RegExpExecArray | null;
        while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
          const frame = parseSseFrame(buffer.slice(0, boundary.index));
          buffer = buffer.slice(boundary.index + boundary[0].length);
          if (frame?.kind !== 'event') continue;
          const seq = Number(frame.id);
          if (!Number.isSafeInteger(seq) || seq <= lastSeq) continue;
          lastSeq = seq;
          failures = 0;
          onEvent(frame);
          if (frame.event === 'end') { terminal = true; break; }
        }
      }
    } catch (error) {
      if (controller.signal.aborted || isAbort(error)) return;
      if (error instanceof RequestFailure && error.status >= 400 && error.status < 500) terminal = true;
      onFailure(error);
    } finally {
      await reader?.cancel().catch(() => {});
      reader?.releaseLock(); reader = undefined;
    }
    if (!controller.signal.aborted && !terminal) {
      onReconnect(true);
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** failures, RECONNECT_MAX_MS);
      failures = Math.min(failures + 1, 16);
      timer = setTimeout(() => { void connect(); }, delay);
    }
  }
  void connect();
  return () => { release(); controller.signal.removeEventListener('abort', cancelReader); };
}
