import { afterEach, expect, it, vi } from 'vitest';
import { createStudioChatInvalidation } from '../../src/services/studio-chat-invalidation.js';

afterEach(() => vi.useRealTimers());
it('coalesces a burst independently for each conversation and carries only routing metadata', () => {
  vi.useFakeTimers(); const publish = vi.fn(); const service = createStudioChatInvalidation(publish);
  for (let i = 0; i < 100; i++) service.changed('project', 'a');
  service.changed('project', 'b'); expect(publish).not.toHaveBeenCalled();
  vi.advanceTimersByTime(250);
  expect(publish.mock.calls.map(([id, event]) => [id, Object.keys(event).sort(), event.conversationId])).toEqual([
    ['project', ['at', 'conversationId', 'projectId', 'type'], 'a'],
    ['project', ['at', 'conversationId', 'projectId', 'type'], 'b'],
  ]);
  service.stop();
});
it('publishes the terminal update immediately and removes its pending duplicate', () => {
  vi.useFakeTimers(); const publish = vi.fn(); const service = createStudioChatInvalidation(publish);
  service.changed('p', 'c'); service.changed('p', 'c', true);
  expect(publish).toHaveBeenCalledTimes(1); vi.advanceTimersByTime(250);
  expect(publish).toHaveBeenCalledTimes(1); service.stop();
});
it('bounds the pending conversations even when the clock cannot advance', () => {
  vi.useFakeTimers(); const publish = vi.fn(); const service = createStudioChatInvalidation(publish);
  for (let i = 0; i < 512; i++) service.changed('p', String(i));
  expect(publish).toHaveBeenCalledTimes(512); expect(vi.getTimerCount()).toBe(0);
  service.stop();
});
it('a broken observer cannot block another conversation or throw into the worker', () => {
  vi.useFakeTimers(); const seen: string[] = [];
  const service = createStudioChatInvalidation((_id, event) => { seen.push(event.conversationId); if (event.conversationId === 'a') throw new Error('closed'); });
  service.changed('p', 'a'); service.changed('p', 'b');
  expect(() => vi.advanceTimersByTime(250)).not.toThrow(); expect(seen).toEqual(['a', 'b']); service.stop();
});
it('shutdown clears pending notifications and refuses later work', () => {
  vi.useFakeTimers(); const publish = vi.fn(); const service = createStudioChatInvalidation(publish);
  service.changed('p', 'c'); service.stop(); service.changed('p', 'c', true);
  vi.runAllTimers(); expect(publish).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});
