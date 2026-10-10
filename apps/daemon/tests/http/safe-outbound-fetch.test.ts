// S60 (#62, owner decision 2A): the SSRF guard for every outbound request the
// daemon makes on behalf of an account's remote MCP server. A loopback fixture
// is reachable only through the explicit test-only `allowAddress`/`resolve`
// injection; nothing here is configurable through the environment.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createSafeOutboundFetch, isPublicUnicastAddress, OutboundRequestRefused, type SafeOutboundFetch } from '../../src/http/safe-outbound-fetch.js';

let server: http.Server; let port: number;
const seen: Array<{ url: string; host: string; authorization: string | undefined }> = [];
beforeAll(async () => {
  server = http.createServer((req, res) => {
    seen.push({ url: req.url ?? '', host: req.headers.host ?? '', authorization: req.headers.authorization });
    if (req.url === '/ok') return void res.end('{"ok":true}');
    if (req.url === '/to-metadata') { res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }); return void res.end(); }
    if (req.url === '/to-self') { res.writeHead(302, { location: '/ok' }); return void res.end(); }
    if (req.url === '/to-other-origin') { res.writeHead(302, { location: `http://other.fixture.test:${port}/ok` }); return void res.end(); }
    if (req.url === '/loop') { res.writeHead(302, { location: '/loop' }); return void res.end(); }
    if (req.url === '/big-declared') { res.writeHead(200, { 'content-length': String(4 * 1024 * 1024) }); return void res.end(); }
    if (req.url === '/big-chunked') { res.writeHead(200); res.write(Buffer.alloc(600 * 1024)); res.write(Buffer.alloc(600 * 1024)); return void res.end(); }
    if (req.url === '/hang') return; // never answers
    if (req.url === '/sse') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: message\ndata: {"jsonrpc":"2.0","id":1}\n\n'); return; } // stays open
    res.statusCode = 404; res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });

const fixture = (overrides: Parameters<typeof createSafeOutboundFetch>[0] = {}): SafeOutboundFetch => createSafeOutboundFetch({
  resolve: async (host) => (host.endsWith('.fixture.test') ? ['127.0.0.1'] : []),
  allowAddress: (address) => address === '127.0.0.1',
  ...overrides,
});
async function refusal(promise: Promise<unknown>): Promise<string> {
  try { await promise; } catch (error) { if (error instanceof OutboundRequestRefused) return error.reason; throw error; }
  return 'allowed';
}

it.each([
  '127.0.0.1', '127.255.255.254', '0.0.0.0', '10.0.0.1', '100.64.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255',
  '192.0.0.8', '192.0.2.1', '192.168.1.1', '198.18.0.1', '198.51.100.7', '203.0.113.9', '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255',
  '::', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:169.254.169.254', '::127.0.0.1', '::ffff:0:10.0.0.1',
  '64:ff9b::a00:1', '64:ff9b:1::1', '2002:a00:1::1', '2002:7f00:1::', 'fc00::1', 'fd00:ec2::254', 'fe80::1', 'fe80::1%eth0', 'fec0::1',
  'ff02::1', '100::1', '2001::1', '2001:db8::1', '3fff::1', 'not-an-ip', '',
])('refuses the non-public address %s', (address) => {
  expect(isPublicUnicastAddress(address)).toBe(false);
});
it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111', '2a00:1450:4001::200e', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::1'])(
  'admits the public unicast address %s', (address) => {
    expect(isPublicUnicastAddress(address)).toBe(true);
  });

it.each(['ftp://example.com/', 'file:///etc/passwd', 'data:text/plain,hi', 'javascript:alert(1)', 'gopher://example.com/', 'not a url'])(
  'refuses the non-http(s) URL %s', async (url) => {
    expect(await refusal(createSafeOutboundFetch()(url))).toBe('scheme');
  });
it('refuses URL credentials, literal private hosts and localhost names before any socket', async () => {
  const guarded = createSafeOutboundFetch({ resolve: async () => { throw new Error('must not resolve'); } });
  expect(await refusal(guarded('https://user:pass@example.com/'))).toBe('credentials');
  expect(await refusal(guarded(`http://127.0.0.1:${port}/ok`))).toBe('address');
  expect(await refusal(guarded('http://[::1]/'))).toBe('address');
  expect(await refusal(guarded('http://[::ffff:7f00:1]/'))).toBe('address');
  expect(await refusal(guarded('http://2130706433/'))).toBe('address'); // 127.0.0.1 in integer form
  expect(await refusal(guarded('http://0x7f.0.0.1/'))).toBe('address');
  expect(await refusal(guarded('http://169.254.169.254/latest/meta-data/'))).toBe('address');
  expect(await refusal(guarded('http://[fd00:ec2::254]/'))).toBe('address');
  expect(await refusal(guarded('http://localhost/'))).toBe('address');
  expect(await refusal(guarded('http://api.localhost/'))).toBe('address');
});
it('checks every DNS answer after resolution', async () => {
  const resolving = (answers: string[]) => createSafeOutboundFetch({ resolve: async () => answers });
  expect(await refusal(resolving(['10.0.0.7'])('https://mcp.example.com/'))).toBe('address');
  expect(await refusal(resolving(['8.8.8.8', '192.168.0.4'])('https://mcp.example.com/'))).toBe('address');
  expect(await refusal(resolving(['::ffff:169.254.169.254'])('https://mcp.example.com/'))).toBe('address');
  expect(await refusal(resolving([])('https://mcp.example.com/'))).toBe('host');
  expect(await refusal(createSafeOutboundFetch({ resolve: async () => { throw new Error('NXDOMAIN'); } })('https://mcp.example.com/'))).toBe('host');
});
it('pins the socket to the vetted address: no second lookup can rebind it', async () => {
  let lookups = 0;
  const guarded = createSafeOutboundFetch({ resolve: async () => { lookups++; return lookups === 1 ? ['127.0.0.1'] : ['10.9.9.9']; },
    allowAddress: (address) => address === '127.0.0.1' });
  // `rebind.invalid` has no system DNS answer: success proves the connection used the vetted address only.
  const response = await guarded(`http://rebind.invalid:${port}/ok`);
  expect(response.status).toBe(200);
  expect(response.json()).toEqual({ ok: true });
  expect(lookups).toBe(1);
  expect(seen.at(-1)?.host).toBe(`rebind.invalid:${port}`);
  // The next request re-resolves and is refused for the private answer.
  expect(await refusal(guarded(`http://rebind.invalid:${port}/ok`))).toBe('address');
});
it('re-validates every redirect hop and refuses a hop into private space', async () => {
  expect(await refusal(fixture()(`http://mcp.fixture.test:${port}/to-metadata`))).toBe('address');
  expect((await fixture()(`http://mcp.fixture.test:${port}/to-self`)).status).toBe(200);
  expect(await refusal(fixture()(`http://mcp.fixture.test:${port}/loop`))).toBe('redirect');
  expect(await refusal(fixture()(`http://mcp.fixture.test:${port}/to-self`, { method: 'POST', body: '{}' }))).toBe('redirect');
});
it('drops caller credentials when a redirect changes origin', async () => {
  seen.length = 0;
  const response = await fixture()(`http://mcp.fixture.test:${port}/to-other-origin`, { headers: { authorization: 'Bearer S60_SECRET_SENTINEL', accept: 'application/json' } });
  expect(response.status).toBe(200);
  expect(seen[0]?.authorization).toBe('Bearer S60_SECRET_SENTINEL');
  expect(seen[1]?.authorization).toBeUndefined();
});
it('bounds response size, declared or streamed', async () => {
  expect(await refusal(fixture()(`http://mcp.fixture.test:${port}/big-declared`))).toBe('size');
  expect(await refusal(fixture()(`http://mcp.fixture.test:${port}/big-chunked`))).toBe('size');
});
it('enforces a total deadline', async () => {
  const started = Date.now();
  expect(await refusal(fixture({ timeoutMs: 300 })(`http://mcp.fixture.test:${port}/hang`))).toBe('timeout');
  expect(Date.now() - started).toBeLessThan(3_000);
});
it('can stop reading an open event stream after the first event', async () => {
  const response = await fixture({ timeoutMs: 2_000 })(`http://mcp.fixture.test:${port}/sse`, {
    stopWhen: (received) => Buffer.from(received).toString('utf8').includes('\n\n') });
  expect(response.text()).toContain('"jsonrpc":"2.0"');
});
