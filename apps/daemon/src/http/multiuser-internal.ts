import type { Response } from 'express';
import type { AuthActor } from '../services/auth-service.js';
import { bindMultiUserActor } from './multiuser-gate.js';
import { setMultiUserStreamAuthority } from './multiuser-stream.js';

export interface InternalMultiUserResult { status: number; body: unknown }

/**
 * A response for daemon-initiated work that reuses a route's admission logic
 * (ownership, quotas, snapshots) as a background actor. There is no cookie:
 * `allowed` is the caller's server-side authority (active account, pilot,
 * owned resource) and is rechecked wherever the handler checks a stream.
 */
export function internalMultiUserResponse(actor: AuthActor, allowed: () => boolean): { res: Response; result: () => InternalMultiUserResult | null } {
  let outcome: InternalMultiUserResult | null = null;
  let status = 200;
  const locals: Record<string, unknown> = {};
  const res = {
    locals,
    req: { method: 'POST', path: '/internal', originalUrl: '/internal', headers: {} },
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    status(code: number) { status = code; return res; },
    json(body: unknown) { outcome = { status, body }; res.headersSent = true; res.writableEnded = true; return res; },
    send(body: unknown) { return res.json(body); },
    end() { res.writableEnded = true; if (!outcome) outcome = { status: 499, body: null }; return res; },
    setHeader() { return res; },
    set() { return res; },
    getHeader() { return undefined; },
    on() { return res; },
    once() { return res; },
    off() { return res; },
  };
  const response = res as unknown as Response;
  bindMultiUserActor(response, actor);
  setMultiUserStreamAuthority(response, allowed);
  return { res: response, result: () => outcome };
}
