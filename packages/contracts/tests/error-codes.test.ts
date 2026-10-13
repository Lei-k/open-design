import { describe, expect, it } from 'vitest';

import { API_ERROR_CODES, type ApiErrorCode } from '../src/errors';

describe('shared API error codes', () => {
  it('exposes every public workspace project-creation failure code', () => {
    expect(API_ERROR_CODES).toEqual(expect.arrayContaining([
      'WORKSPACE_CONTEXT_INCOMPLETE',
      'WORKSPACE_PROJECT_PERMISSION_DENIED',
      'WORKSPACE_AUTHORITY_UNAVAILABLE',
    ]));
  });

  it('exposes AGENT_RUNTIME_DEF_INVALID for runtime-def validation failures', () => {
    // Chat-run startup emits this code through the shared SSE/status error
    // envelopes when a checked-in runtime def is invalid. Keeping the
    // assertion in the contracts package ensures contract-only refactors
    // cannot drop the literal without this package's own test lane failing.
    expect(API_ERROR_CODES).toContain('AGENT_RUNTIME_DEF_INVALID');
  });

  it('exposes source-specific multi-user terminal run codes (#79)', () => {
    expect(API_ERROR_CODES).toEqual(expect.arrayContaining([
      'MULTIUSER_RUN_FAILED', 'MULTIUSER_RUN_START_FAILED', 'MULTIUSER_RUN_SHUTDOWN_TIMEOUT',
      'MULTIUSER_RUN_ADMISSION_REPLAYED', 'MULTIUSER_PERSONAL_RUN_FAILED', 'DAEMON_RESTARTED',
    ]));
  });

  it('keeps AGENT_RUNTIME_DEF_INVALID assignable to ApiErrorCode', () => {
    const code: ApiErrorCode = 'AGENT_RUNTIME_DEF_INVALID';
    expect(code).toBe('AGENT_RUNTIME_DEF_INVALID');
  });
});
