// Issue #18, gate 2 end to end: a daemon started with `personalSandbox` runs
// login, identity read-back and personal runs inside the per-run sandbox. A
// task in alice's personal run cannot read bob's credential or the daemon
// database; its own project and CODEX_HOME stay usable. Skipped where bwrap
// cannot build the sandbox.
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupIsolatedDataRoot, loadIsolatedServerModule, multiUserOptions, provisionAccounts, startMultiUserDaemon,
  type Principal, type StartedMultiUserDaemon,
} from './multiuser-harness.js';
import { probePersonalSandbox } from '../../src/services/personal-sandbox.js';
import { PERSONAL_CODEX_MOCK, RUN_MOCK, codexHome, linkCodex, until } from './personal-codex-helpers.js';

const BWRAP = '/usr/bin/bwrap';
const usable = probePersonalSandbox(BWRAP, tmpdir());

describe.skipIf(!usable)('sandboxed personal lane through the daemon', () => {
  let daemon: StartedMultiUserDaemon;
  let dataRoot: string;
  let alice: Principal;
  let bob: Principal;

  beforeAll(async () => {
    delete process.env.OD_API_TOKEN;
    delete process.env.OD_DISABLE_API_AUTH;
    ({ dataRoot } = await loadIsolatedServerModule());
    daemon = await startMultiUserDaemon(multiUserOptions({ testMockAgentScript: RUN_MOCK,
      testPersonalCodexAppServer: PERSONAL_CODEX_MOCK, personalSandbox: { bwrapPath: BWRAP } }));
    [alice, bob] = (await provisionAccounts(daemon, ['sbx-alice', 'sbx-bob'])).users as [Principal, Principal];
    await linkCodex(daemon, dataRoot, alice, 'alice@example.com');
    await linkCodex(daemon, dataRoot, bob, 'bob@example.com');
  }, 120_000);

  afterAll(async () => { await daemon?.close(); cleanupIsolatedDataRoot(); });

  it('a personal run reads its own state but not another user\'s credential or the daemon database', async () => {
    const id = randomUUID();
    const project = await daemon.request({ method: 'POST', path: '/api/projects', cookie: alice.cookie, body: { id, name: id } });
    expect(project.status, project.text).toBe(200);
    const own = path.join(codexHome(dataRoot, alice.id), 'auth.json');
    const other = path.join(codexHome(dataRoot, bob.id), 'auth.json');
    const database = path.join(dataRoot, 'app.sqlite');
    const res = await daemon.request({ method: 'POST', path: '/api/runs', cookie: alice.cookie, body: {
      projectId: id, conversationId: project.json.conversationId, agentId: 'codex', executionSource: 'personal_subscription',
      message: `[mock-read=${own}] [mock-read=${other}] [mock-read=${database}]` } });
    expect(res.status, res.text).toBe(202);
    const run = await until(async () => (await daemon.request({ path: `/api/runs/${res.json.run.id}`, cookie: alice.cookie })).json,
      (value) => !['queued', 'running'].includes(value.status), 'personal run');
    expect(run.status, JSON.stringify(run)).toBe('succeeded');
    const reply = JSON.parse(run.output.text) as { reads: Record<string, string>; envKeys: string[] };
    expect(reply.reads).toEqual({ [own]: 'readable', [other]: 'ENOENT', [database]: 'ENOENT' });
    expect(reply.envKeys).toContain('PATH');
  });
});
