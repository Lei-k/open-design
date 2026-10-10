/**
 * Provider-returned metadata is untrusted (#62, S60 Repair 1). A remote MCP
 * server or its authorization server can echo whatever it received — the
 * account's static header values, OAuth access/refresh tokens, the dynamic
 * client secret — into fields the daemon would otherwise persist in clear or
 * project in responses (`scope`, `serverInfo.name`, `protocolVersion`, …).
 *
 * Policy: only an allowlisted, size-bounded set of fields is ever kept (see the
 * callers), and every kept text is scrubbed against the known secrets of that
 * server before persistence or projection:
 *
 * - the known secrets are every credential representation the daemon itself
 *   sends for the server (`credentialsSent` over the exact headers/body the
 *   outbound builders emit — static header values, `Bearer <token>`,
 *   `Basic base64(clientId:clientSecret)`, form-encoded refresh tokens and
 *   client secrets), each expanded by `credentialRepresentations` into its
 *   scheme-less part, Basic payload and decoding, the secret half of
 *   `id:secret`, and percent-, form- and base64(url)-encoded forms (S60 Repair 2);
 * - any occurrence of a known secret (≥ 4 characters) is replaced;
 * - any remaining credential-like run that shares a 12-character window with a
 *   known secret (a fragment, or a secret with extra characters around it) is
 *   replaced too;
 * - shape checks reject credential-looking values even without a match: a
 *   credible payload after an auth-scheme word (`Basic`, `Bearer`, …) and a base64 run
 *   that decodes to readable text or to a known secret.
 *
 * Secrets shorter than 4 characters cannot be scrubbed meaningfully and are
 * ignored here; they are still never stored outside the sealed columns.
 */

export const REDACTED = '[redacted]';
const WINDOW = 12;
const RUN = /[A-Za-z0-9._~+/=:%-]{8,}/g;

export interface KnownSecrets {
  /** Full secrets, longest first. */
  values: string[];
  /** Every 12-character window of every secret long enough to have one. */
  windows: Set<string>;
}

const AUTH_SCHEME = /^(basic|bearer|dpop|digest|negotiate|hoba|mutual)$/i;
const BASE64_RUN = /^[A-Za-z0-9+/_-]{8,}={0,2}$/;
const formEncode = (value: string) => new URLSearchParams({ v: value }).toString().slice(2);

/** Decode a base64 / base64url run when it round-trips; null otherwise. */
function decodeBase64(run: string): string | null {
  if (!BASE64_RUN.test(run)) return null;
  const url = /[-_]/.test(run);
  const bytes = Buffer.from(run, url ? 'base64url' : 'base64');
  if (!bytes.length || bytes.toString(url ? 'base64url' : 'base64').replace(/=+$/, '') !== run.replace(/=+$/, '')) return null;
  return bytes.toString('latin1');
}
/** Base64 that decodes to readable text is an encoded value, not a name or scope. */
function readableBase64(run: string): string | null {
  if (run.length < 16) return null;
  const decoded = decodeBase64(run);
  if (!decoded || decoded.length < 8) return null;
  let printable = 0;
  for (let i = 0; i < decoded.length; i++) { const code = decoded.charCodeAt(i); if (code >= 0x20 && code < 0x7f) printable++; }
  return printable / decoded.length >= 0.9 ? decoded : null;
}

/**
 * Every representation of one credential as the daemon sends it or a provider
 * could echo it: the value, its scheme-less part ("Bearer x" → x), a Basic
 * payload and its decoding plus the secret half of `id:secret`, and the
 * percent-, form- and base64(url)-encoded forms of each.
 */
export function credentialRepresentations(value: string): string[] {
  return representations(value).exact;
}
/**
 * `exact`: every form, matched verbatim. `windowed`: the forms also matched by
 * 12-character overlap — all but the decoded `id:secret` pair, whose public
 * client id must not make ordinary metadata (an authorize URL's `client_id`)
 * look like a fragment; its secret half stays windowed.
 */
function representations(value: string): { exact: string[]; windowed: string[] } {
  const base = new Set<string>([value]);
  const exactOnly = new Set<string>();
  const parts = value.split(/\s+/).filter(Boolean);
  if (parts.length > 1) for (const part of parts) if (part.length >= 8) base.add(part);
  if (parts.length === 2 && /^basic$/i.test(parts[0]!)) {
    const decoded = decodeBase64(parts[1]!);
    if (decoded !== null) {
      const colon = decoded.indexOf(':');
      if (colon >= 0) { exactOnly.add(decoded); base.add(decoded.slice(colon + 1)); } else base.add(decoded);
    }
  }
  const encodings = (item: string) => {
    const out = [item];
    try { out.push(encodeURIComponent(item), formEncode(item)); } catch { /* lone surrogate */ }
    out.push(Buffer.from(item).toString('base64'), Buffer.from(item).toString('base64url'));
    return out;
  };
  const windowed = new Set<string>([...base].flatMap(encodings));
  const exact = new Set<string>([...windowed, ...[...exactOnly].flatMap(encodings)]);
  return { exact: [...exact], windowed: [...windowed] };
}

/** Form parameters whose values are credentials. */
const SECRET_FORM_PARAMS = new Set(['code', 'code_verifier', 'refresh_token', 'client_secret', 'client_assertion', 'password', 'assertion']);

/**
 * The credential values in one outbound request exactly as the outbound layer
 * emits it: every header value the caller supplies as a credential, and the
 * secret parameters of an `application/x-www-form-urlencoded` body (raw and as
 * encoded on the wire). Feed the result to `knownSecrets`.
 */
export function credentialsSent(request: { headers?: Record<string, string>; body?: string }): string[] {
  const out: string[] = [];
  for (const value of Object.values(request.headers ?? {})) if (value) out.push(value);
  if (request.body) {
    for (const [name, value] of new URLSearchParams(request.body)) if (SECRET_FORM_PARAMS.has(name) && value) out.push(value);
    for (const pair of request.body.split('&')) {
      const [name, value] = pair.split('=') as [string, string | undefined];
      if (value && SECRET_FORM_PARAMS.has(name)) out.push(value);
    }
  }
  return out;
}

/** Collect the secrets — with every representation of each — for scrubbing. */
export function knownSecrets(values: Iterable<string | null | undefined>): KnownSecrets {
  const set = new Set<string>();
  const windowSources = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string' || !value) continue;
    const forms = representations(value);
    for (const form of forms.exact) if (form.length >= 4) set.add(form);
    for (const form of forms.windowed) if (form.length >= 4) windowSources.add(form);
  }
  const list = [...set].sort((a, b) => b.length - a.length);
  const windows = new Set<string>();
  for (const value of windowSources) for (let i = 0; i + WINDOW <= value.length; i++) windows.add(value.slice(i, i + WINDOW));
  return { values: list, windows };
}

function overlaps(text: string, secrets: KnownSecrets): boolean {
  for (let i = 0; i + WINDOW <= text.length; i++) if (secrets.windows.has(text.slice(i, i + WINDOW))) return true;
  return false;
}

/** Scheme words are ordinary metadata too; only a credible payload makes a credential. */
function credentialPayload(text: string, secrets: KnownSecrets): boolean {
  return carriesSecret(text, secrets) || readableBase64(text) !== null
    || /^[A-Za-z0-9._~+/-]{16,}={0,2}$/.test(text);
}

/** True when `text` contains a known secret or a fragment of one, directly or base64-encoded. */
export function carriesSecret(text: string, secrets: KnownSecrets): boolean {
  if (secrets.values.some((secret) => text.includes(secret)) || overlaps(text, secrets)) return true;
  const decoded = decodeBase64(text);
  return decoded !== null && (secrets.values.some((secret) => decoded.includes(secret)) || overlaps(decoded, secrets));
}

/** Replace every known secret, every credential after an auth-scheme word, and every credential-like run. */
export function scrubSecrets(text: string, secrets: KnownSecrets): string {
  let out = text;
  for (const secret of secrets.values) if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  out = out.replace(/\b(basic|bearer|dpop|digest|negotiate|hoba|mutual)(\s+)(?!\[redacted\])(\S+)/gi,
    (match, scheme: string, gap: string, payload: string) => credentialPayload(payload, secrets) ? `${scheme}${gap}${REDACTED}` : match);
  return out.replace(RUN, (run) => (overlaps(run, secrets) || carriesSecret(run, secrets) || readableBase64(run) !== null ? REDACTED : run));
}

/** A display string from a provider: printable, bounded, scrubbed; null when nothing usable remains. */
export function untrustedText(value: unknown, secrets: KnownSecrets, max = 128): string | null {
  if (typeof value !== 'string') return null;
  const printable = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').trim();
  if (!printable) return null;
  // Scrub before bounding, so a cut never leaves a secret prefix behind; bound again after.
  const scrubbed = scrubSecrets(printable.slice(0, max * 4), secrets).slice(0, max).trim();
  return scrubbed && scrubbed !== REDACTED ? scrubbed : null;
}

const SCOPE_TOKEN = /^[\x21\x23-\x5b\x5d-\x7e]{1,128}$/;

/**
 * An OAuth scope string (RFC 6749 §3.3) from a provider: only syntactically
 * valid scope tokens, at most 32, at most 1,024 characters, and never a token
 * that carries or overlaps a known secret. Null when nothing remains.
 */
export function untrustedScope(value: unknown, secrets: KnownSecrets): string | null {
  if (typeof value !== 'string') return null;
  const kept: string[] = [];
  const tokens = value.slice(0, 8192).split(/[ \t\r\n]+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (!token) continue;
    if (AUTH_SCHEME.test(token) && tokens[i + 1] && credentialPayload(tokens[i + 1]!, secrets)) { i++; continue; }
    if (!SCOPE_TOKEN.test(token) || carriesSecret(token, secrets) || readableBase64(token) !== null || kept.includes(token)) continue;
    if (kept.length >= 32 || [...kept, token].join(' ').length > 1024) break;
    kept.push(token);
  }
  return kept.length ? kept.join(' ') : null;
}

/** An MCP protocol version is a date string; anything else is dropped. */
export function untrustedProtocolVersion(value: unknown): string | null {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

/** An OAuth `token_type`: a short token, else the RFC 6750 default. */
export function untrustedTokenType(value: unknown): string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(value) ? value : 'Bearer';
}
