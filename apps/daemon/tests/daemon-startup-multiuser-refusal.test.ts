import { describe, expect, it, vi } from 'vitest';
import { MULTIUSER_NOT_LAUNCH_READY_ACK } from '../src/services/multiuser-mode.js';

const startServer = vi.fn();
vi.mock('../src/server.js', () => ({ startServer }));

import { startDaemonRuntime } from '../src/daemon-startup.js';

describe('production daemon startup', () => {
  it('refuses a multiUser option before starting a listener', async () => {
    await expect(startDaemonRuntime({
      multiUser: {
        acknowledgeNotLaunchReady: MULTIUSER_NOT_LAUNCH_READY_ACK,
        allowedOrigins: ['https://example.test'],
      },
    } as Parameters<typeof startDaemonRuntime>[0])).rejects.toThrow(/multi.?user.*test-only|test-only.*multi.?user/i);
    expect(startServer).not.toHaveBeenCalled();
  });
});
