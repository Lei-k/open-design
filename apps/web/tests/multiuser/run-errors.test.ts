import { expect, it } from 'vitest';
import { runErrorKey } from '../../src/multiuser/run-errors';
import { en } from '../../src/i18n/locales/en';
import { zhTW } from '../../src/i18n/locales/zh-TW';
import { zhCN } from '../../src/i18n/locales/zh-CN';
it('gives every documented run refusal a specific translated explanation', () => {
  const codes = ['MULTIUSER_QUEUE_LIMIT', 'MULTIUSER_QUOTA_EXHAUSTED', 'MULTIUSER_PERSONAL_DISABLED', 'MULTIUSER_PERSONAL_UNAVAILABLE', 'MULTIUSER_PERSONAL_CONSENT_REQUIRED', 'MULTIUSER_PERSONAL_QUEUE_LIMIT', 'MULTIUSER_PERSONAL_BUSY', 'MULTIUSER_PERSONAL_REAUTH_REQUIRED', 'MULTIUSER_PERSONAL_USAGE_LIMIT', 'MULTIUSER_PERSONAL_WORKSPACE_NOT_ALLOWED', 'MULTIUSER_PERSONAL_RUN_FAILED', 'MULTIUSER_EXECUTION_SOURCE_MISMATCH', 'NOT_FOUND'];
  expect(new Set(codes.map(runErrorKey)).size).toBe(codes.length);
  for (const code of codes) {
    const key = runErrorKey(code);
    expect(key).not.toBe('multiuser.requestError');
    expect(zhTW[key]).not.toBe(en[key]); expect(zhCN[key]).not.toBe(en[key]);
  }
  expect(runErrorKey('UNRECOGNIZED_PRIVATE_SERVER_MESSAGE')).toBe('multiuser.requestError');
});
