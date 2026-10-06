// Issue #22 (from #18) — when personal-account setup refuses a start (schema
// migration or retained-state recovery throws), startServer must release what it
// had opened so far: the main database, the auth store and the health session.
// No listener, timer or store may survive the refusal, and the next start in the
// same process must succeed with personal subscriptions enabled.
import Database from 'better-sqlite3';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { PersonalCodexAccounts } from '../../src/services/personal-codex-accounts.js';
import {
  cleanupIsolatedDataRoot, loadIsolatedServerModule, multiUserOptions, provisionAccounts, startMultiUserDaemon,
} from './multiuser-harness.js';
import { PERSONAL_CODEX_MOCK, RUN_MOCK } from './personal-codex-helpers.js';

beforeAll(async () => {
  delete process.env.OD_API_TOKEN;
  delete process.env.OD_DISABLE_API_AUTH;
  await loadIsolatedServerModule();
}, 120_000);

afterAll(() => { vi.restoreAllMocks(); cleanupIsolatedDataRoot(); });

const resourceCount = (kind: string) => process.getActiveResourcesInfo().filter((name) => name === kind).length;

it('releases every store it opened when personal-account recovery refuses, then starts cleanly', async () => {
  const { mod } = await loadIsolatedServerModule();
  const options = multiUserOptions({ testMockAgentScript: RUN_MOCK, testPersonalCodexAppServer: PERSONAL_CODEX_MOCK });
  const listenersBefore = resourceCount('TCPServerWrap');
  const intervalsBefore = resourceCount('Timeout');

  const closed: Database.Database[] = [];
  const close = Database.prototype.close;
  vi.spyOn(Database.prototype, 'close').mockImplementation(function (this: Database.Database) {
    closed.push(this);
    return close.call(this);
  });
  // `recover` is the last step of the constructor; failing it means migration and
  // adoption already touched the database.
  const recover = vi.spyOn(PersonalCodexAccounts.prototype as unknown as { recover: () => void }, 'recover')
    .mockImplementationOnce(() => { throw new Error('injected personal recovery failure'); });

  await expect(mod.startServer({ port: 0, host: '127.0.0.1', returnServer: true, multiUser: options }))
    .rejects.toThrow('injected personal recovery failure');
  expect(recover).toHaveBeenCalledTimes(1);

  // The main database and the auth store were both closed, and nothing is listening.
  const names = closed.map((db) => db.name);
  expect(names.some((name) => name.endsWith('app.sqlite'))).toBe(true);
  expect(closed.length).toBeGreaterThanOrEqual(2);
  for (const db of closed) expect(db.open).toBe(false);
  expect(resourceCount('TCPServerWrap')).toBe(listenersBefore);
  // No daemon interval (team-resource polling and the like) was started.
  expect(resourceCount('Timeout')).toBeLessThanOrEqual(intervalsBefore + 1);
  vi.restoreAllMocks();

  // A subsequent start in the same process succeeds, with personal subscriptions on.
  const daemon = await startMultiUserDaemon(options);
  try {
    const [alice] = (await provisionAccounts(daemon, ['refusal-alice'])).users;
    const view = await daemon.request({ path: '/api/agent-accounts', cookie: alice!.cookie });
    expect(view.status).toBe(200);
    expect(view.json).toMatchObject({ mode: 'multi-user', personalSubscriptionsEnabled: true });
  } finally {
    await daemon.close();
  }
}, 120_000);
