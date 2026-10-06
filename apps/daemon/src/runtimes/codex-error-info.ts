/**
 * The safe, structured part of a Codex failure.
 *
 * `codex app-server` attaches `codexErrorInfo` to both the `error` notification
 * and a failed turn's `turn.error` (`TurnError` in the generated v2 schema).
 * It is either a bare reason (`"usageLimitExceeded"`, `"unauthorized"`, …) or
 * a single-key object whose key is the reason and whose value may carry the
 * upstream `httpStatusCode`, e.g. `{ "responseStreamDisconnected":
 * { "httpStatusCode": 502 } }`.
 *
 * Only the reason name and an HTTP status survive normalization. Everything
 * else in the payload (free text, nested details) is dropped, so this shape is
 * safe to forward on run events. An unrecognised reason is kept verbatim as
 * long as it looks like a protocol identifier, so a newer CLI's reason is not
 * lost; anything else yields no detail at all.
 */
export interface CodexErrorDetail {
  reason: string;
  httpStatusCode?: number;
}

const REASON = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;

export function codexErrorDetail(info: unknown): CodexErrorDetail | null {
  if (typeof info === 'string') return REASON.test(info) ? { reason: info } : null;
  if (!info || typeof info !== 'object' || Array.isArray(info)) return null;
  const keys = Object.keys(info);
  if (keys.length !== 1) return null;
  const reason = keys[0]!;
  if (!REASON.test(reason)) return null;
  const body = (info as Record<string, unknown>)[reason];
  const status = body && typeof body === 'object' ? (body as Record<string, unknown>).httpStatusCode : undefined;
  return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
    ? { reason, httpStatusCode: status }
    : { reason };
}

/** Re-validate a detail this module produced (e.g. after it crossed a frame boundary). */
export function parseCodexErrorDetail(value: unknown): CodexErrorDetail | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { reason, httpStatusCode } = value as Record<string, unknown>;
  if (typeof reason !== 'string' || !REASON.test(reason)) return null;
  return typeof httpStatusCode === 'number' && Number.isInteger(httpStatusCode) && httpStatusCode >= 100 && httpStatusCode <= 599
    ? { reason, httpStatusCode }
    : { reason };
}
