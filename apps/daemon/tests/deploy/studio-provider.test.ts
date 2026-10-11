import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { studioProvider, StudioDeployAuthorityRefused } from '../../src/deploy/studio-provider.js';

// Keep sockets real; only the deadline clock is controlled. Native AbortSignal.timeout
// is replaced with equivalent controllable deadlines so 90-second cases take no real sleep.
async function fixture(authorize = () => 'S64-provider-token-1234', ceilingMs?: number) {
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
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
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
    authorize, ...(ceilingMs === undefined ? {} : { ceilingMs }),
    outbound: {
      apiOrigin: `http://deploy.fixture.test.invalid:${(server.address() as AddressInfo).port}`,
      resolve: async () => ['127.0.0.1'], allowAddress: (address) => address === '127.0.0.1',
    },
  });
  return {
    provider, clock, deadlines,
    arrived: () => new Promise<void>((resolve) => { reached = resolve; }),
    release: () => release(), bytes: () => bodyBytes,
    disconnect: () => server.closeAllConnections(),
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

it.each(['deploy', 'status', 'check-link'] as const)('%s polls live authority during held I/O, aborts at next 250 ms tick and clears timer', async (action) => {
  let live = true;
  const refused = new Error('authority changed');
  const authorize = vi.fn(() => { if (!live) throw refused; return 'S65-test-credential-1234'; });
  const f = await fixture(authorize);
  try {
    const arrived = f.arrived();
    const pending = action === 'deploy' ? f.provider.deploy([{ file: 'index.html', data: Buffer.from('<p>Hi</p>') }], 'project', 'preview')
      : action === 'status' ? f.provider.status('deployment-1') : f.provider.checkLink('https://site.vercel.app');
    const settled = pending.then(() => null, (error: unknown) => error);
    await arrived;
    const calls = authorize.mock.calls.length;
    live = false;
    vi.advanceTimersByTime(249);
    expect(authorize.mock.calls.length).toBe(calls);
    vi.advanceTimersByTime(1);
    expect(await settled).toMatchObject({ cause: refused, message: 'Deployment authority changed.' });
    expect(vi.getTimerCount()).toBe(0);
  } finally { await f.close(); }
});
it.each(['status', 'check-link'] as const)('%s refresh has a five-second ceiling and cleans its authority timer on timeout', async (action) => {
  const f = await fixture(undefined, 5_000);
  try {
    const arrived = f.arrived();
    const pending = action === 'status' ? f.provider.status('deployment-1') : f.provider.checkLink('https://site.vercel.app');
    const settled = pending.then(() => null, (error: unknown) => error);
    await arrived;
    expect(f.deadlines[0]!.at - Date.now()).toBe(5_000);
    f.clock(4_999); expect(f.deadlines[0]!.controller.signal.aborted).toBe(false);
    f.clock(1); expect(await settled).toMatchObject({ reason: 'timeout' });
    expect(vi.getTimerCount()).toBe(0);
  } finally { await f.close(); }
});
it('preserves changed authority when a transport failure settles before the next poll', async () => {
  let live = true;
  const refused = new Error('authority changed');
  const f = await fixture(() => { if (!live) throw refused; return 'S65-test-credential-1234'; });
  try {
    const arrived = f.arrived();
    const pending = f.provider.status('deployment-1').then(() => null, (error: unknown) => error);
    await arrived;
    live = false;
    f.disconnect();
    expect(await pending).toBe(refused);
    expect(vi.getTimerCount()).toBe(0);
  } finally { await f.close(); }
});
// Independent reviewer PP-1: unlike a held response, the provider has not read
// the upload. Use real clocks/sockets to observe cancellation under backpressure.
it('PP-1 mid-upload withdrawal closes the socket before the provider reads the full body', async () => {
  let upload: http.IncomingMessage | undefined;
  let reached: () => void = () => {};
  let requests = 0;
  let received = 0;
  let closed = false;
  let live = true;
  const server = http.createServer((req) => {
    requests++;
    upload = req;
    req.pause();
    req.socket.on('close', () => { closed = true; });
    reached();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const provider = studioProvider({
      provider: 'vercel', config: { providerId: 'vercel', configured: true, last4: '1234', revision: 1 },
      authorize: () => { if (!live) throw new Error('withdrawn'); return 'S65-test-credential-1234'; },
      outbound: {
        apiOrigin: `http://deploy.fixture.test.invalid:${(server.address() as AddressInfo).port}`,
        resolve: async () => ['127.0.0.1'], allowAddress: (address) => address === '127.0.0.1',
      },
    });
    const arrived = new Promise<void>((resolve) => { reached = resolve; });
    const big = Buffer.alloc(24 * 1024 * 1024, 0x61);
    const settled = provider.deploy([{ file: 'index.html', data: big }], 'project', 'preview').then(() => null, (error: unknown) => error);
    await arrived;
    expect(upload?.complete).toBe(false);
    live = false;
    expect(await settled).toBeInstanceOf(StudioDeployAuthorityRefused);
    upload!.on('data', (chunk: Buffer) => { received += chunk.length; });
    upload!.on('error', () => {});
    upload!.resume();
    await vi.waitFor(() => expect(closed).toBe(true), { timeout: 2000 });
    expect(received).toBeLessThan(big.length);
    expect(requests).toBe(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 30_000);
