/**
 * Personal agent subscription accounts (multi-user mode only, #18).
 *
 * The daemon answers `/api/agent-accounts` only in multi-user mode and only to
 * a signed-in user; every other answer (404 in single-user mode, 401, network
 * error, unexpected shape) reads as `null`, so the settings section stays
 * hidden — fail closed. Requests carry no identity of their own: the session
 * cookie decides whose account is read.
 */
import type {
  PersonalAgentAccount,
  PersonalAgentAccountsResponse,
  PersonalLoginAttempt,
} from '@open-design/contracts';

export type AgentAccountResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; code: string | null };

function isAccountsResponse(value: unknown): value is PersonalAgentAccountsResponse {
  if (!value || typeof value !== 'object') return false;
  const body = value as Partial<PersonalAgentAccountsResponse>;
  return body.mode === 'multi-user'
    && typeof body.personalSubscriptionsEnabled === 'boolean'
    && !!body.codex && typeof body.codex === 'object';
}

export async function fetchPersonalAgentAccounts(): Promise<PersonalAgentAccountsResponse | null> {
  try {
    const resp = await fetch('/api/agent-accounts', { cache: 'no-store' });
    if (!resp.ok) return null;
    const body: unknown = await resp.json().catch(() => null);
    return isAccountsResponse(body) ? body : null;
  } catch {
    return null;
  }
}

async function call<T>(url: string, init: RequestInit, pick: (body: Record<string, unknown>) => T | undefined): Promise<AgentAccountResult<T>> {
  try {
    const resp = await fetch(url, { cache: 'no-store', ...init });
    const body = (await resp.json().catch(() => null)) as Record<string, unknown> | null;
    if (resp.ok && body) {
      const value = pick(body);
      if (value !== undefined) return { ok: true, value };
    }
    const error = body?.error as { code?: unknown } | undefined;
    return { ok: false, status: resp.status, code: typeof error?.code === 'string' ? error.code : null };
  } catch {
    return { ok: false, status: 0, code: null };
  }
}

const json = (method: string, body: unknown = {}): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const attemptOf = (body: Record<string, unknown>) => body.attempt as PersonalLoginAttempt | undefined;
const accountOf = (body: Record<string, unknown>) => body.account as PersonalAgentAccount | undefined;

export function startCodexLogin(): Promise<AgentAccountResult<PersonalLoginAttempt>> {
  return call('/api/agent-accounts/codex/logins', json('POST'), attemptOf);
}

export function readCodexLogin(attemptId: string): Promise<AgentAccountResult<PersonalLoginAttempt>> {
  return call(`/api/agent-accounts/codex/logins/${encodeURIComponent(attemptId)}`, { method: 'GET' }, attemptOf);
}

export function cancelCodexLogin(attemptId: string): Promise<AgentAccountResult<PersonalLoginAttempt>> {
  return call(`/api/agent-accounts/codex/logins/${encodeURIComponent(attemptId)}/cancel`, json('POST'), attemptOf);
}

/** Sends one minimal real request on the user's own plan; the caller must have their explicit consent. */
export function verifyCodexAccount(accountId: string): Promise<AgentAccountResult<PersonalAgentAccount>> {
  return call(`/api/agent-accounts/codex/accounts/${encodeURIComponent(accountId)}/verify`,
    json('POST', { consentToUsePlan: true }), accountOf);
}

export function unlinkCodexAccount(accountId: string): Promise<AgentAccountResult<true>> {
  return call(`/api/agent-accounts/codex/accounts/${encodeURIComponent(accountId)}`, { method: 'DELETE' },
    (body) => (body.unlinked === true ? true : undefined));
}
