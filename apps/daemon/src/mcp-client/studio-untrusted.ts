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
 * - any occurrence of a known secret (≥ 4 characters) is replaced;
 * - any remaining credential-like run that shares a 12-character window with a
 *   known secret (a fragment, or a secret with extra characters around it) is
 *   replaced too.
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

/** Collect the secrets (and the obvious derived forms a provider sees) for scrubbing. */
export function knownSecrets(values: Iterable<string | null | undefined>): KnownSecrets {
  const set = new Set<string>();
  const add = (value: string) => {
    if (value.length < 4) return;
    set.add(value);
    // The URL-encoded form a provider may echo from a form body or query string.
    try { const encoded = encodeURIComponent(value); if (encoded !== value) set.add(encoded); } catch { /* lone surrogate */ }
  };
  for (const value of values) {
    if (typeof value !== 'string' || !value) continue;
    add(value);
    // "Bearer <token>", "Basic <b64>": the credential part on its own.
    for (const part of value.split(/\s+/)) if (part.length >= 8 && part !== value) add(part);
  }
  const list = [...set].sort((a, b) => b.length - a.length);
  const windows = new Set<string>();
  for (const value of list) for (let i = 0; i + WINDOW <= value.length; i++) windows.add(value.slice(i, i + WINDOW));
  return { values: list, windows };
}

function overlaps(text: string, secrets: KnownSecrets): boolean {
  for (let i = 0; i + WINDOW <= text.length; i++) if (secrets.windows.has(text.slice(i, i + WINDOW))) return true;
  return false;
}

/** True when `text` contains a known secret or a fragment of one. */
export function carriesSecret(text: string, secrets: KnownSecrets): boolean {
  return secrets.values.some((secret) => text.includes(secret)) || overlaps(text, secrets);
}

/** Replace every known secret, and every credential-like run overlapping one. */
export function scrubSecrets(text: string, secrets: KnownSecrets): string {
  let out = text;
  for (const secret of secrets.values) if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  return out.replace(RUN, (run) => (overlaps(run, secrets) ? REDACTED : run));
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
  for (const token of value.slice(0, 8192).split(/[ \t\r\n]+/)) {
    if (!token || !SCOPE_TOKEN.test(token) || carriesSecret(token, secrets) || kept.includes(token)) continue;
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
