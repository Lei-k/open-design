import { expect, it } from 'vitest';
import { API_ERROR_CODES } from '@open-design/contracts';
import { multiUserTerminalErrorCode } from '../../src/routes/multiuser-runs.js';

it('names every terminal error by its execution source with a contract code and never echoes a raw reason (#79)', () => {
  const cases: Array<[Parameters<typeof multiUserTerminalErrorCode>[0], unknown, string]> = [
    ['personal_subscription', undefined, 'MULTIUSER_PERSONAL_RUN_FAILED'],
    ['company_pool', undefined, 'MULTIUSER_RUN_FAILED'],
    ['personal_subscription', 'shutdown_timeout', 'MULTIUSER_RUN_SHUTDOWN_TIMEOUT'],
    ['company_pool', 'shutdown_timeout', 'MULTIUSER_RUN_SHUTDOWN_TIMEOUT'],
    ['company_pool', 'ledger_admission_replayed', 'MULTIUSER_RUN_ADMISSION_REPLAYED'],
    ['company_pool', 'MULTIUSER_RUN_START_FAILED', 'MULTIUSER_RUN_START_FAILED'],
    ['company_pool', 'MULTIUSER_RUN_REQUEST_INVALID', 'MULTIUSER_RUN_REQUEST_INVALID'],
    ['company_pool', 'DAEMON_RESTARTED', 'DAEMON_RESTARTED'],
    ['personal_subscription', 'MULTIUSER_PERSONAL_USAGE_LIMIT', 'MULTIUSER_PERSONAL_USAGE_LIMIT'],
    // A personal-only code can never describe a company run.
    ['company_pool', 'MULTIUSER_PERSONAL_RUN_FAILED', 'MULTIUSER_RUN_FAILED'],
    ['company_pool', 'MULTIUSER_PERSONAL_UNAVAILABLE', 'MULTIUSER_RUN_FAILED'],
    ['personal_subscription', 'boom at /host/private with FAKE_SECRET', 'MULTIUSER_PERSONAL_RUN_FAILED'],
    ['company_pool', { message: 'FAKE_SECRET' }, 'MULTIUSER_RUN_FAILED'],
  ];
  for (const [source, reason, code] of cases) {
    expect(multiUserTerminalErrorCode(source, reason), `${source} ${String(reason)}`).toBe(code);
    expect((API_ERROR_CODES as readonly string[]).includes(code)).toBe(true);
  }
});
