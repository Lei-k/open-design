import { promises as dns } from 'node:dns';
import net from 'node:net';
import { Agent, buildConnector, fetch as undiciFetch } from 'undici';

/**
 * SSRF-guarded outbound HTTP for requests whose destination an account chose
 * (S60: account remote MCP servers — connection tests, OAuth metadata and
 * dynamic registration, the token endpoint, and later runtime calls).
 *
 * Policy, applied to the first request and to every redirect hop:
 *
 * - only `http:`/`https:` URLs without userinfo;
 * - the host is resolved once (or is an IP literal) and EVERY answer must be a
 *   public unicast address — loopback, unspecified, RFC 1918, CGNAT, link-local
 *   (including the cloud metadata 169.254.169.254 and fd00:ec2::254), ULA,
 *   site-local, multicast, reserved, documentation/benchmark ranges and IPv6
 *   forms that embed a blocked IPv4 address (IPv4-mapped, IPv4-compatible,
 *   NAT64, 6to4) are refused;
 * - the connection is pinned to the vetted address (the socket's DNS lookup
 *   returns it and nothing else), so a name cannot rebind between the check
 *   and the connect; TLS still verifies the certificate for the host name;
 * - redirects are followed manually for GET/HEAD only (bounded hops, each hop
 *   re-validated, caller headers dropped when the origin changes); any other
 *   method refuses a redirect;
 * - a total deadline covers name resolution, connect, headers and body (a
 *   lookup still pending at the deadline, or at a caller abort, is abandoned
 *   and its late answer never opens a socket), and the body is read into a
 *   bounded buffer (an oversized `content-length` is refused before reading);
 * - the caller's synchronous `beforeConnect` hook runs for every hop AFTER the
 *   host is resolved and vetted: once immediately before dispatch (nothing is
 *   awaited between it and the request being issued; it may supply that hop's
 *   credential headers / body, so secrets are produced only after the final
 *   check) and once more when the pinned socket is open, before any request
 *   byte is written. A throw refuses with `OutboundAuthorityRefused`, the
 *   socket is destroyed, and nothing is sent.
 *
 * There is no environment switch. Tests reach a loopback fixture only through
 * the programmatic `resolve` / `allowAddress` injection.
 */

export type OutboundRefusalReason = 'scheme' | 'credentials' | 'host' | 'address' | 'redirect' | 'timeout' | 'size' | 'network' | 'authority';

export class OutboundRequestRefused extends Error {
  constructor(readonly reason: OutboundRefusalReason) { super(`outbound request refused: ${reason}`); this.name = 'OutboundRequestRefused'; }
}
/** The caller's `beforeConnect` hook refused this hop; `cause` is what it threw. Nothing was sent. */
export class OutboundAuthorityRefused extends OutboundRequestRefused {
  constructor(override readonly cause: unknown) { super('authority'); this.name = 'OutboundAuthorityRefused'; }
}

/** One hop as `beforeConnect` sees it: already resolved and vetted. */
export interface OutboundHop {
  url: URL;
  /** 0 for the first request, then one per followed redirect. */
  hop: number;
  /** False once a redirect left the first request's origin (hook headers are then dropped). */
  sameOrigin: boolean;
  /** `dispatch`: immediately before the request is issued; `socket`: the pinned socket is open, nothing written yet. */
  phase: 'dispatch' | 'socket';
}
/** Per-hop additions a `dispatch` hook may return (credentials produced only after its final check). */
export interface OutboundHopAdditions { headers?: Record<string, string>; body?: string }

export interface SafeOutboundOptions {
  /** Test-only resolver injection; production resolves with the system resolver. */
  resolve?: (hostname: string) => Promise<string[]>;
  /** Test-only: additionally admit these exact addresses (a loopback fixture). */
  allowAddress?: (address: string) => boolean;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxRedirects?: number;
}

export interface SafeOutboundInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  /** Stop reading the body early once this returns true (e.g. one SSE event read). */
  stopWhen?: (received: Uint8Array) => boolean;
  /** Synchronous bounded stream consumer (runtime MCP SSE); throws to abort. */
  onChunk?: (received: Uint8Array) => void;
  /** Per-call ceilings (never above the helper's own). */
  timeoutMs?: number;
  maxResponseBytes?: number;
  /**
   * Synchronous authority hook, see the module comment. Throw to refuse. A
   * `dispatch` call may return headers (same-origin hops only) and a body
   * (non-GET/HEAD) to send with this hop.
   */
  beforeConnect?: (hop: OutboundHop) => OutboundHopAdditions | void;
}

export interface SafeOutboundResponse {
  status: number;
  headers: Headers;
  body: Uint8Array;
  /** The URL that produced this response (after any followed redirects). */
  url: string;
  text(): string;
  json(): unknown;
}

export type SafeOutboundFetch = (url: string, init?: SafeOutboundInit) => Promise<SafeOutboundResponse>;

export const SAFE_OUTBOUND_DEFAULT_TIMEOUT_MS = 10_000;
export const SAFE_OUTBOUND_DEFAULT_MAX_BYTES = 1024 * 1024;
export const SAFE_OUTBOUND_DEFAULT_MAX_REDIRECTS = 3;

// ---- address classification ---------------------------------------------------

function ipv4Bytes(value: string): number[] | null {
  if (!net.isIPv4(value)) return null;
  return value.split('.').map((part) => Number(part));
}

/** Expand any valid IPv6 literal (no zone id) to 16 bytes. */
function ipv6Bytes(value: string): number[] | null {
  if (value.includes('%') || !net.isIPv6(value)) return null;
  let text = value.toLowerCase();
  let tail: number[] = [];
  const lastColon = text.lastIndexOf(':');
  const maybeV4 = text.slice(lastColon + 1);
  if (maybeV4.includes('.')) {
    const v4 = ipv4Bytes(maybeV4);
    if (!v4) return null;
    tail = v4;
    text = text.slice(0, lastColon + 1) + '0:0';
  }
  const [head, rest] = text.split('::') as [string, string | undefined];
  const groups = (part: string | undefined) => (part ? part.split(':').filter((item) => item.length > 0) : []);
  const left = groups(head); const right = groups(rest);
  const fill = rest === undefined ? 0 : 8 - left.length - right.length;
  if (fill < 0) return null;
  const words = [...left, ...Array<string>(fill).fill('0'), ...right].map((word) => parseInt(word, 16));
  if (words.length !== 8 || words.some((word) => !Number.isInteger(word) || word < 0 || word > 0xffff)) return null;
  const bytes = words.flatMap((word) => [word >> 8, word & 0xff]);
  if (tail.length) bytes.splice(12, 4, ...tail);
  return bytes;
}

const IPV4_BLOCKED: ReadonlyArray<readonly [number[], number]> = [
  [[0, 0, 0, 0], 8], [[10, 0, 0, 0], 8], [[100, 64, 0, 0], 10], [[127, 0, 0, 0], 8], [[169, 254, 0, 0], 16],
  [[172, 16, 0, 0], 12], [[192, 0, 0, 0], 24], [[192, 0, 2, 0], 24], [[192, 31, 196, 0], 24], [[192, 52, 193, 0], 24],
  [[192, 88, 99, 0], 24], [[192, 168, 0, 0], 16], [[192, 175, 48, 0], 24], [[198, 18, 0, 0], 15], [[198, 51, 100, 0], 24],
  [[203, 0, 113, 0], 24], [[224, 0, 0, 0], 4], [[240, 0, 0, 0], 4],
];

function inPrefix(bytes: readonly number[], prefix: readonly number[], bits: number): boolean {
  for (let bit = 0; bit < bits; bit++) {
    const index = bit >> 3; const mask = 0x80 >> (bit & 7);
    if ((bytes[index]! & mask) !== ((prefix[index] ?? 0) & mask)) return false;
  }
  return true;
}

function publicIpv4(bytes: readonly number[]): boolean {
  return !IPV4_BLOCKED.some(([prefix, bits]) => inPrefix(bytes, prefix, bits));
}

const V6 = (text: string) => ipv6Bytes(text)!;
const IPV6_BLOCKED_GLOBAL: ReadonlyArray<readonly [number[], number]> = [
  [V6('2001::'), 23], // IETF protocol assignments: Teredo, benchmarking, ORCHID, …
  [V6('2001:db8::'), 32], // documentation
  [V6('3fff::'), 20], // documentation
];

/**
 * True only for a public unicast address an account-chosen request may reach.
 * Unparseable input, zone ids and every special-purpose range are refused.
 */
export function isPublicUnicastAddress(address: string): boolean {
  const v4 = ipv4Bytes(address);
  if (v4) return publicIpv4(v4);
  const v6 = ipv6Bytes(address.replace(/^\[|\]$/g, ''));
  if (!v6) return false;
  const embedded = v6.slice(12);
  // ::ffff:a.b.c.d (IPv4-mapped) and 64:ff9b::a.b.c.d (NAT64) reach that IPv4 address.
  if (inPrefix(v6, V6('::ffff:0:0'), 96) || inPrefix(v6, V6('64:ff9b::'), 96)) return publicIpv4(embedded);
  // 6to4 embeds the IPv4 address in bytes 2..5.
  if (inPrefix(v6, V6('2002::'), 16)) return publicIpv4(v6.slice(2, 6));
  // Global unicast only: outside 2000::/3 is unspecified, loopback, IPv4-compatible,
  // IPv4-translated, local-use NAT64, discard, ULA (incl. fd00:ec2::254), link/site-local, multicast.
  if (!inPrefix(v6, V6('2000::'), 3)) return false;
  return !IPV6_BLOCKED_GLOBAL.some(([prefix, bits]) => inPrefix(v6, prefix, bits));
}

// ---- the guarded fetch ----------------------------------------------------------

interface Target { url: URL; address: string; family: 4 | 6 }

/** Resolve, abandoning the lookup when `signal` aborts (its late answer is ignored). */
function resolveWithin(lookup: Promise<string[]>, signal: AbortSignal): Promise<string[]> {
  if (signal.aborted) { lookup.catch(() => {}); return Promise.reject(signal.reason); }
  return new Promise<string[]>((resolve, reject) => {
    const onAbort = () => { lookup.catch(() => {}); reject(signal.reason); };
    signal.addEventListener('abort', onAbort, { once: true });
    lookup.then((value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(error); });
  });
}

async function vet(raw: string, options: SafeOutboundOptions, signal: AbortSignal, deadline: AbortSignal): Promise<Target> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new OutboundRequestRefused('scheme'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new OutboundRequestRefused('scheme');
  if (url.username || url.password) throw new OutboundRequestRefused('credentials');
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!host) throw new OutboundRequestRefused('host');
  const admitted = (address: string) => isPublicUnicastAddress(address) || options.allowAddress?.(address) === true;
  let addresses: string[];
  if (net.isIP(host)) addresses = [host];
  else {
    if (host === 'localhost' || host.endsWith('.localhost')) throw new OutboundRequestRefused('address');
    try {
      const lookup = options.resolve ? options.resolve(host)
        : dns.lookup(host, { all: true, verbatim: true }).then((entries) => entries.map((entry) => entry.address));
      addresses = await resolveWithin(lookup, signal);
    } catch {
      if (signal.aborted) throw new OutboundRequestRefused(deadline.aborted ? 'timeout' : 'network');
      throw new OutboundRequestRefused('host');
    }
  }
  if (!addresses.length) throw new OutboundRequestRefused('host');
  // Every answer must be admissible: a name that also points into private space is refused outright.
  if (!addresses.every(admitted)) throw new OutboundRequestRefused('address');
  const address = addresses[0]!;
  return { url, address, family: net.isIPv6(address) ? 6 : 4 };
}

/**
 * A dispatcher whose sockets can only reach the vetted address. `onSocket`
 * runs once the socket is connected, before undici writes the request; a
 * throw destroys the socket and fails the request.
 */
function pinnedAgent(target: Target, onSocket?: () => void): Agent {
  const connector = buildConnector({
    lookup: ((_hostname: string, options: { all?: boolean } | undefined, callback: (...args: unknown[]) => void) => {
      if (options?.all) callback(null, [{ address: target.address, family: target.family }]);
      else callback(null, target.address, target.family);
    }) as never,
  });
  return new Agent({
    connect: (connectOptions, callback) => connector(connectOptions, (error, socket) => {
      if (error || !socket) return void (callback as (e: Error | null, s: unknown) => void)(error ?? new Error('no socket'), null);
      try { onSocket?.(); }
      catch (refused) { socket.destroy(); return void (callback as (e: Error | null, s: unknown) => void)(refused instanceof Error ? refused : new Error('refused'), null); }
      callback(null, socket);
    }),
    connections: 1, pipelining: 0,
  });
}

async function readBounded(body: ReadableStream<Uint8Array> | null, limit: number, stopWhen?: (received: Uint8Array) => boolean,
  onChunk?: (received: Uint8Array) => void): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new OutboundRequestRefused('size');
      chunks.push(value);
      onChunk?.(Buffer.concat(chunks));
      if (stopWhen) {
        const joined = Buffer.concat(chunks);
        if (stopWhen(joined)) return joined;
      }
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export function createSafeOutboundFetch(options: SafeOutboundOptions = {}): SafeOutboundFetch {
  const ceilingTimeout = options.timeoutMs ?? SAFE_OUTBOUND_DEFAULT_TIMEOUT_MS;
  const ceilingBytes = options.maxResponseBytes ?? SAFE_OUTBOUND_DEFAULT_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? SAFE_OUTBOUND_DEFAULT_MAX_REDIRECTS;
  return async (raw, init = {}) => {
    const timeoutMs = Math.min(init.timeoutMs ?? ceilingTimeout, ceilingTimeout);
    const maxBytes = Math.min(init.maxResponseBytes ?? ceilingBytes, ceilingBytes);
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = init.signal ? AbortSignal.any([deadline, init.signal]) : deadline;
    const method = (init.method ?? 'GET').toUpperCase();
    let current = raw;
    let headers = { ...(init.headers ?? {}) };
    let origin: string | null = null;
    for (let hop = 0; ; hop++) {
      if (signal.aborted) throw new OutboundRequestRefused(deadline.aborted ? 'timeout' : 'network');
      const target = await vet(current, options, signal, deadline);
      if (origin !== null && target.url.origin !== origin) {
        // Never carry the caller's credentials to a different origin.
        headers = Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() === 'accept'));
      }
      origin ??= target.url.origin;
      const sameOrigin = target.url.origin === origin;
      // Authority hook, after resolution: synchronously before dispatch, and again on the open socket.
      let hookError: { error: unknown } | null = null;
      const runHook = (phase: OutboundHop['phase']): OutboundHopAdditions | void => {
        if (!init.beforeConnect) return undefined;
        try { return init.beforeConnect({ url: new URL(target.url), hop, sameOrigin, phase }); }
        catch (error) { hookError = { error }; throw new OutboundAuthorityRefused(error); }
      };
      const additions = runHook('dispatch') ?? {};
      const hopHeaders = sameOrigin && additions.headers ? { ...headers, ...additions.headers } : headers;
      const requestBody = method === 'GET' || method === 'HEAD' ? undefined : additions.body ?? init.body;
      const agent = pinnedAgent(target, init.beforeConnect ? () => { runHook('socket'); } : undefined);
      try {
        let response;
        try {
          // No await between the dispatch-phase hook above and issuing the request here.
          response = await undiciFetch(target.url, { method, headers: hopHeaders, redirect: 'manual', signal, dispatcher: agent,
            ...(requestBody !== undefined ? { body: requestBody } : {}) });
        } catch (error) {
          if (hookError) throw new OutboundAuthorityRefused((hookError as { error: unknown }).error);
          if (error instanceof OutboundRequestRefused) throw error;
          throw new OutboundRequestRefused(deadline.aborted ? 'timeout' : 'network');
        }
        if (response.status >= 300 && response.status < 400 && response.headers.has('location')) {
          await response.body?.cancel().catch(() => {});
          if ((method !== 'GET' && method !== 'HEAD') || hop >= maxRedirects) throw new OutboundRequestRefused('redirect');
          try { current = new URL(response.headers.get('location')!, target.url).toString(); }
          catch { throw new OutboundRequestRefused('redirect'); }
          continue;
        }
        const declared = Number(response.headers.get('content-length'));
        if (Number.isFinite(declared) && declared > maxBytes) {
          await response.body?.cancel().catch(() => {});
          throw new OutboundRequestRefused('size');
        }
        let body: Uint8Array;
        try { body = await readBounded(response.body as ReadableStream<Uint8Array> | null, maxBytes, init.stopWhen, init.onChunk); }
        catch (error) {
          if (error instanceof OutboundRequestRefused) throw error;
          throw new OutboundRequestRefused(deadline.aborted ? 'timeout' : 'network');
        }
        const finalUrl = target.url.toString();
        const responseHeaders = new Headers(response.headers as unknown as Headers);
        return { status: response.status, headers: responseHeaders, body, url: finalUrl,
          text: () => Buffer.from(body).toString('utf8'),
          json: () => JSON.parse(Buffer.from(body).toString('utf8')) as unknown };
      } finally {
        void agent.close().catch(() => {});
      }
    }
  };
}
