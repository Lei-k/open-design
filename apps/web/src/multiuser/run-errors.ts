import type { Dict } from '../i18n/types';
import { RequestFailure } from './session';
const codes: Record<string, keyof Dict> = {
  MULTIUSER_QUEUE_LIMIT: 'multiuserRuns.queueLimit',
  MULTIUSER_QUOTA_EXHAUSTED: 'multiuserRuns.quota',
  MULTIUSER_PERSONAL_DISABLED: 'multiuserRuns.personalDisabled',
  MULTIUSER_PERSONAL_UNAVAILABLE: 'multiuserRuns.personalUnavailable',
  MULTIUSER_PERSONAL_CONSENT_REQUIRED: 'multiuserRuns.personalConsent',
  MULTIUSER_PERSONAL_QUEUE_LIMIT: 'multiuserRuns.personalQueue',
  MULTIUSER_PERSONAL_BUSY: 'multiuserRuns.personalBusy',
  MULTIUSER_PERSONAL_REAUTH_REQUIRED: 'multiuserRuns.personalReauth',
  MULTIUSER_PERSONAL_USAGE_LIMIT: 'multiuserRuns.personalUsage',
  MULTIUSER_PERSONAL_WORKSPACE_NOT_ALLOWED: 'multiuserRuns.personalWorkspace',
  MULTIUSER_PERSONAL_RUN_FAILED: 'multiuserRuns.personalFailed',
  MULTIUSER_EXECUTION_SOURCE_MISMATCH: 'multiuserRuns.pinned',
  AGENT_EXECUTION_FAILED: 'multiuserRuns.verificationFailed',
  MULTIUSER_AGENT_FORBIDDEN: 'multiuserRuns.mockOnly',
  MULTIUSER_PROVIDER_DISABLED: 'multiuserRuns.mockOnly',
  MULTIUSER_IMPORTED_PROJECT_FORBIDDEN: 'multiuserRuns.managedOnly',
  NOT_FOUND: 'multiuserRuns.notFound',
  PROJECT_NOT_FOUND: 'multiuserRuns.notFound',
};
export function runErrorKey(error: unknown): keyof Dict {
  const code = typeof error === 'string' ? error : error instanceof RequestFailure ? error.code : null;
  if (code && codes[code]) return codes[code];
  if (error instanceof RequestFailure && error.status === 404) return 'multiuserRuns.notFound';
  return 'multiuser.requestError';
}
export function isAbort(error: unknown) { return error instanceof DOMException && error.name === 'AbortError'; }
