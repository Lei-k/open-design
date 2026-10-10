// S62 A1 fixture: a hostile remote MCP server in a CHILD process, so the test
// process's CPU time (`process.cpuUsage()`) measures only the daemon parsing the
// stream, never the fixture producing it. Promoted from the S61 reviewer's
// slow-SSE reproducer (a scratch handoff outside git). The daemon reaches it
// only through the programmatic `testMcpOutbound` injection.
//
// Paths (streamable HTTP POST or legacy SSE GET + POST messages):
//   /http/drip, /sse/drip   tools/call answers with 12,000 tiny `ping` frames, 1 ms
//                           apart, and never the result (the reviewer's case);
//   /http/bulk, /sse/bulk   tools/call answers with 900 one-KiB `ping` frames,
//                           then the result (under every frame/size cap);
//   /http/notes             tools/call answers with 900 one-KiB JSON-RPC
//                           notifications (`event: message`), then the result;
//   /http/grow, /sse/grow   tools/call answers with ONE unfinished frame: ~930 KiB
//                           at once, then one more byte every millisecond, never
//                           a line end (S62 Repair 1, the reviewer's case);
//   /probe/grow             the same growing frame answers the connection test's
//                           `initialize` (streamable HTTP).
// GET /stats reports the bytes written for tools/call streams so far.
import { spawn, type ChildProcess } from 'node:child_process';

const SERVER = String.raw`
const http = require('node:http');
let streamBytes = 0; const legacy = new Map();
const write = (res, text) => { if (res.destroyed) return false; streamBytes += Buffer.byteLength(text); res.write(text); return true; };
const answer = (msg) => msg.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} } }
  : msg.method === 'tools/list' ? { tools: [{ name: 'lookup', inputSchema: { type: 'object' } }] } : { content: [{ type: 'text', text: 'bulk done' }] };
const frame = (id, msg) => 'event: message\ndata: ' + JSON.stringify({ jsonrpc: '2.0', id, result: answer(msg) }) + '\n\n';
function stream(res, kind, msg, end) {
  let n = 0;
  if (kind === 'grow') {
    write(res, 'event: message\ndata: ' + 'x'.repeat(950000));
    const tick = () => { if (n++ >= 50000 || !write(res, 'x')) return end && res.end(); setTimeout(tick, 1); };
    return tick();
  }
  if (kind === 'drip') {
    const tick = () => { if (n++ >= 12000 || !write(res, 'event: ping\ndata: ' + 'p'.repeat(60) + '\n\n')) return end && res.end(); setTimeout(tick, 1); };
    return tick();
  }
  const payload = kind === 'notes' ? 'event: message\ndata: ' + JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { note: 'n'.repeat(960) } }) + '\n\n'
    : 'event: ping\ndata: ' + 'p'.repeat(1000) + '\n\n';
  const tick = () => {
    if (n++ >= 900) { write(res, frame(msg.id, msg)); return end && res.end(); }
    if (!write(res, payload)) return; setImmediate(tick);
  };
  tick();
}
const server = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
    const url = new URL(req.url, 'http://x'); const [, transport, kind, tail] = url.pathname.split('/');
    if (url.pathname === '/stats') { res.writeHead(200, { 'content-type': 'application/json' }); return void res.end(JSON.stringify({ streamBytes })); }
    if (transport === 'sse' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream' }); const id = String(Math.random()).slice(2); legacy.set(id, res);
      res.on('close', () => legacy.delete(id)); return void res.write('event: endpoint\ndata: /sse/' + kind + '/msgs?s=' + id + '\n\n');
    }
    const msg = body ? JSON.parse(body) : {};
    if (transport === 'sse' && tail === 'msgs') {
      const out = legacy.get(url.searchParams.get('s')); res.writeHead(202); res.end();
      if (!out || msg.id === undefined) return;
      if (msg.method === 'tools/call') return stream(out, kind, msg, false);
      return void write(out, frame(msg.id, msg));
    }
    if (msg.id === undefined) { res.writeHead(202); return void res.end(); }
    if (msg.method === 'tools/call' || transport === 'probe') { res.writeHead(200, { 'content-type': 'text/event-stream' }); return stream(res, kind, msg, true); }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: answer(msg) }));
  });
});
server.listen(0, '127.0.0.1', () => process.stdout.write(server.address().port + '\n'));
`;

export interface SlowSseFixture { port: number; url(path: string): string; streamBytes(): Promise<number>; close(): Promise<void> }

export async function startSlowSseFixture(): Promise<SlowSseFixture> {
  const child: ChildProcess = spawn(process.execPath, ['-e', SERVER], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.stdout!.once('data', (data: Buffer) => resolve(Number(String(data).trim())));
  });
  return {
    port,
    url: (path) => `http://slow.fixture.test:${port}${path}`,
    streamBytes: async () => ((await (await fetch(`http://127.0.0.1:${port}/stats`)).json()) as { streamBytes: number }).streamBytes,
    close: async () => { child.kill(); await new Promise((resolve) => { if (child.exitCode !== null) resolve(null); else child.once('exit', resolve); }); },
  };
}
