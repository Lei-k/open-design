import type { Response } from 'express';

const AUTHORITY = 'multiUserStreamAuthority';
const BOUND = 'multiUserStreamBound';
/** Idle streams close within one second; every payload rechecks synchronously. */
export const MULTIUSER_STREAM_RECHECK_MS = 1_000;

export function setMultiUserStreamAuthority(res: Response, check: () => boolean): void {
  res.locals[AUTHORITY] = check;
}

/** Single-user streams have no cookie authority; multi-user streams fail closed. */
export function multiUserStreamAllowed(res: Response): boolean {
  // A response without Express locals never passed the multi-user gate.
  const check = res.locals?.[AUTHORITY] as (() => boolean) | undefined;
  if (!check) return true;
  let allowed = false;
  try { allowed = check(); } catch { /* unavailable persistence is not authority */ }
  if (!allowed && !res.writableEnded) res.end();
  return allowed;
}

export function bindMultiUserStream(res: Response): void {
  if (!res.locals?.[AUTHORITY] || res.locals[BOUND]) return;
  res.locals[BOUND] = true;
  const timer = setInterval(() => { multiUserStreamAllowed(res); }, MULTIUSER_STREAM_RECHECK_MS);
  timer.unref();
  const cleanup = () => { clearInterval(timer); };
  res.once('close', cleanup);
  res.once('finish', cleanup);
}
