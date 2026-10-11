import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { studioProvider } from '../../src/deploy/studio-provider.js';

// Keep sockets real; only the deadline clock is controlled. Native AbortSignal.timeout
// is replaced with equivalent controllable deadlines so 90-second cases take no real sleep.
async function fixture() {
  let reached: () => void = () => {};
  let release: () => void = () => {};
  let bodyBytes = 0;
  const server = http.createServer(async (req, res) => {
    for await (const chunk of req) bodyBytes += Buffer.byteLength(chunk);
    reached();
    await new Promise<void>((resolve) => { release = resolve; });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ id: 'deployment-1', url: 'site.vercel.app', readyState: 'READY' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const deadlines: { at: number; controller: AbortController }[] = [];
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    const controller = new AbortController();
    deadlines.push({ at: Date.now() + ms, controller });
    return controller.signal;
  });
  const clock = (ms: number) => {
    vi.setSystemTime(Date.now() + ms);
    for (const deadline of deadlines)
      if (deadline.at <= Date.now()) deadline.controller.abort(new DOMException('Timed out', 'TimeoutError'));
  };
  const provider = studioProvider({
    provider: 'vercel', config: { providerId: 'vercel', configured: true, last4: '1234', revision: 1 },
    authorize: () => 'S64-provider-token-1234',
    outbound: {
      apiOrigin: `http://deploy.fixture.test.invalid:${(server.address() as AddressInfo).port}`,
      resolve: async () => ['127.0.0.1'], allowAddress: (address) => address === '127.0.0.1',
    },
  });
  return {
    provider, clock, deadlines,
    arrived: () => new Promise<void>((resolve) => { reached = resolve; }),
    release: () => release(), bytes: () => bodyBytes,
    close: async () => {
      release();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
it('a 60 MiB inline upload below the 64 MiB capture cap survives controlled latency beyond 10 seconds', async () => {
  const f = await fixture();
  try {
    const arrived = f.arrived();
    const pending = f.provider.deploy(Array.from({ length: 3 }, (_, i) => ({
      file: `asset-${i}.bin`, data: Buffer.alloc(20 * 1024 * 1024),
    })), 'project', 'preview');
    // Attach the failure handler before advancing deadlines.
    const settled = pending.then((result) => ({ result }), (error: unknown) => ({ error }));
    await arrived;
    expect(f.bytes()).toBeGreaterThan(60 * 1024 * 1024);
    f.clock(10_001);
    f.release();
    expect(await settled).toMatchObject({ result: { status: 'ready' } });
  } finally { await f.close(); }
});
it('the inline upload ceiling is enforced at 90 seconds even when the fixture never replies', async () => {
  const f = await fixture();
  try {
    const arrived = f.arrived();
    const pending = f.provider.deploy([{ file: 'index.html', data: Buffer.from('<p>Hi</p>') }], 'project', 'preview');
    const settled = pending.then(() => null, (error: unknown) => error);
    await arrived;
    expect(f.deadlines[0]!.at - Date.now()).toBe(90_000);
    f.clock(89_999);
    expect(f.deadlines[0]!.controller.signal.aborted).toBe(false);
    f.clock(1);
    expect(await settled).toMatchObject({ reason: 'timeout' });
  } finally { await f.close(); }
});
it.each(['.', '..', '%2e%2e'])('refuses a captured Cloudflare account path segment %s before outbound resolution', async (accountId) => {
  const resolve = vi.fn(async () => ['127.0.0.1']);
  const provider = studioProvider({
    provider: 'cloudflare-pages',
    config: { providerId: 'cloudflare-pages', configured: true, last4: '1234', revision: 1, accountId, projectName: 'site' },
    authorize: () => 'S64-provider-token-1234',
    outbound: { apiOrigin: 'http://deploy.fixture.test.invalid:1', resolve, allowAddress: () => true },
  });
  await expect(provider.status('deployment-1')).rejects.toMatchObject({ reason: 'host' });
  expect(resolve).not.toHaveBeenCalled();
});
