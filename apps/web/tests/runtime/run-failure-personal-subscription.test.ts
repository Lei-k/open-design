import { API_ERROR_CODES } from '@open-design/contracts';
import { describe, expect, it } from 'vitest';
import { resolveRunFailureUi } from '../../src/runtime/amr-guidance';
import { en } from '../../src/i18n/locales/en';

// A Studio actor's personal-subscription run fails with a typed MULTIUSER_*
// code (#55). Every such code must name its own fix instead of falling to the
// generic local-runtime card, and never promise a different payer.
const PERSONAL_CODES = API_ERROR_CODES.filter((code) => code.startsWith('MULTIUSER_PERSONAL_') || code.startsWith('MULTIUSER_RUN_')
  || ['MULTIUSER_EXECUTION_SOURCE_MISMATCH', 'MULTIUSER_CAPABILITY_UNAVAILABLE', 'MULTIUSER_AGENT_FORBIDDEN'].includes(code));

describe('personal-subscription run failures', () => {
  it.each(PERSONAL_CODES)('%s has its own translated copy', (code) => {
    const ui = resolveRunFailureUi(code, null, 'codex');
    expect(ui.titleKey).not.toBe('chat.runError.title.generic');
    expect(en[ui.titleKey as keyof typeof en]).toBeTruthy();
    expect(en[ui.messageKey as keyof typeof en]).toBeTruthy();
  });

  it('retries what the actor can recover on the same source and explains the rest', () => {
    for (const code of ['MULTIUSER_PERSONAL_USAGE_LIMIT', 'MULTIUSER_PERSONAL_REAUTH_REQUIRED', 'MULTIUSER_PERSONAL_UNAVAILABLE',
      'MULTIUSER_PERSONAL_QUEUE_LIMIT', 'MULTIUSER_PERSONAL_RUN_FAILED', 'MULTIUSER_RUN_FAILED', 'MULTIUSER_RUN_SHUTDOWN_TIMEOUT']) {
      expect([code, resolveRunFailureUi(code, null, 'codex').primaryAction]).toEqual([code, 'retry']);
    }
    // Retrying a pinned conversation or an unavailable capability reproduces the refusal.
    for (const code of ['MULTIUSER_EXECUTION_SOURCE_MISMATCH', 'MULTIUSER_CAPABILITY_UNAVAILABLE', 'MULTIUSER_PERSONAL_DISABLED']) {
      expect([code, resolveRunFailureUi(code, null, 'codex').primaryAction]).toEqual([code, 'contact-support']);
    }
  });

  it('keeps the local Codex CLI classification unchanged', () => {
    expect(resolveRunFailureUi('AGENT_UNAVAILABLE', null, 'codex').titleKey).toBe('chat.runError.title.cliMissing');
  });
});
