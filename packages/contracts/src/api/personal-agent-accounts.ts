/**
 * Personal agent subscription accounts (multi-user mode only, #18).
 *
 * A platform user links THEIR OWN provider subscription through the provider's
 * official device-code flow. These DTOs never carry provider tokens, auth file
 * contents or another user's data. `userCode` / `verificationUrl` appear only
 * on the owner's pending login attempt and disappear once it is terminal.
 * See `specs/current/web-multiuser-personal-subscription.md`.
 */

/** Where a run's provider capacity comes from. Omitted means `company_pool`. */
/** `personal_api_key` runs on the actor's own encrypted provider key (#62/#63). */
export type RunExecutionSource = 'company_pool' | 'personal_subscription' | 'personal_api_key';

export type PersonalAgentProvider = 'codex';

export type PersonalLoginAttemptStatus = 'pending' | 'connected' | 'denied' | 'expired' | 'canceled' | 'failed';

/** Stable reason for a `failed` login attempt. */
export type PersonalLoginFailureCode =
  | 'identity_unavailable'
  | 'workspace_not_allowed'
  | 'interrupted'
  | 'provider_error';

export interface PersonalLoginAttempt {
  id: string;
  provider: PersonalAgentProvider;
  status: PersonalLoginAttemptStatus;
  failureCode: PersonalLoginFailureCode | null;
  createdAt: number;
  expiresAt: number;
  /** Present only while `status === 'pending'` and only for the owner. */
  verificationUrl?: string;
  userCode?: string;
}

export type PersonalAccountStatus = 'connected' | 'requires_reauth' | 'disabled';

/** Last provider-side problem seen on this account; never switches the run source. */
export type PersonalAccountProblem = 'reauth_required' | 'usage_limit_reached' | 'workspace_not_allowed';

export interface PersonalRateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

/** Provider-reported snapshot; `null` on the account means "unknown", never "unlimited". */
export interface PersonalRateLimits {
  primary: PersonalRateLimitWindow | null;
  secondary: PersonalRateLimitWindow | null;
  readAt: number;
}

export interface PersonalAgentAccount {
  id: string;
  provider: PersonalAgentProvider;
  status: PersonalAccountStatus;
  /** Masked e-mail, e.g. `a***@example.com`. */
  maskedIdentity: string;
  planType: string | null;
  linkedAt: number;
  verifiedAt: number | null;
  lastProblem: PersonalAccountProblem | null;
  rateLimits: PersonalRateLimits | null;
}

/** `GET /api/agent-accounts` — the actor's own view. */
export interface PersonalAgentAccountsResponse {
  mode: 'multi-user';
  /** Server-side enablement switch; off means "not enabled on this server". */
  personalSubscriptionsEnabled: boolean;
  /**
   * Whether a company provider is enabled for admission. Evaluated
   * from current server policy. Absent on older daemons.
   */
  companyPoolAvailable?: boolean;
  codex: { account: PersonalAgentAccount | null; pendingAttempt: PersonalLoginAttempt | null };
  claude: { available: false };
}

export interface PersonalLoginAttemptResponse {
  attempt: PersonalLoginAttempt;
}

export interface PersonalAccountResponse {
  account: PersonalAgentAccount;
}

/** `POST /api/agent-accounts/codex/accounts/:accountId/verify` body. */
export interface PersonalAccountVerifyRequest {
  /** Must be literally `true`: the minimal request consumes the user's own plan. */
  consentToUsePlan: true;
}

/** `GET /api/admin/agent-accounts` — non-sensitive metadata only. */
export interface AdminPersonalAccountsResponse {
  personalWorkerCapacity: number;
  activePersonalRuns: number;
  queuedPersonalRuns: number;
  users: Record<string, {
    codex: { linked: boolean; status: PersonalAccountStatus | null; linkedAt: number | null;
      verifiedAt: number | null; updatedAt: number | null };
    /** Visibility only; personal runs are not charged to the company worker-time budget. */
    personalWorkerMs: number;
  }>;
}
