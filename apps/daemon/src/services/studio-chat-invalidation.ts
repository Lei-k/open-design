import type { StudioChatMessagesChangedSsePayload } from '@open-design/contracts';

/** Thin, bounded notifications after durable run publication; never carries transcript or credential data. */
export function createStudioChatInvalidation(publish: (projectId: string, event: StudioChatMessagesChangedSsePayload) => void) {
  const pending = new Map<string, { projectId: string; conversationId: string }>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  const send = (item: { projectId: string; conversationId: string }) => {
    try { publish(item.projectId, { type: 'chat-messages-changed', ...item, at: Date.now() }); }
    catch { /* A reconnect re-reads the authoritative transcript. */ }
  };
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    const items = [...pending.values()]; pending.clear();
    if (!closed) for (const item of items) send(item);
  };
  return {
    changed(projectId: string, conversationId: string, terminal = false) {
      if (closed) return;
      const key = JSON.stringify([projectId, conversationId]);
      const item = { projectId, conversationId };
      if (terminal) { pending.delete(key); send(item); return; }
      pending.set(key, item);
      if (pending.size >= 512) { flush(); return; }
      if (!timer) { timer = setTimeout(flush, 250); timer.unref(); }
    },
    stop() { closed = true; pending.clear(); if (timer) clearTimeout(timer); timer = null; },
  };
}
