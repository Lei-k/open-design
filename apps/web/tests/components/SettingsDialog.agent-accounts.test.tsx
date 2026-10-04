// @vitest-environment jsdom
//
// #18 — the Agent accounts section exists only when the daemon reports
// multi-user mode (version capability) AND answers the probe for a signed-in
// user. A single-user daemon is never probed; a refused probe (401, errors)
// keeps the settings nav exactly as before.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsDialog } from '../../src/components/SettingsDialog';
import { DEFAULT_CONFIG } from '../../src/state/config';
import type { AgentInfo, AppVersionInfo } from '../../src/types';

const AGENTS: AgentInfo[] = [{ id: 'codex', name: 'Codex', bin: 'codex', available: true }];
const MULTI_USER: AppVersionInfo = { version: '0.0.0', channel: 'test', packaged: false, platform: 'linux', arch: 'x64',
  capabilities: { slideRenderer: false, multiUser: true } };
let fetchMock: ReturnType<typeof vi.fn>;

function stubAgentAccounts(status: number, body: unknown) {
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === '/api/agent-accounts') {
      return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
}

async function renderSettings(appVersionInfo: AppVersionInfo | null = MULTI_USER) {
  const view = render(
    <SettingsDialog presentation="page" initial={{ ...DEFAULT_CONFIG }} agents={AGENTS} daemonLive appVersionInfo={appVersionInfo}
      initialSection="general" onPersist={vi.fn()} onPersistComposioKey={vi.fn()} onClose={vi.fn()} onRefreshAgents={vi.fn()} />,
  );
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return view;
}

describe('SettingsDialog agent accounts gating', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('never probes a single-user daemon', async () => {
    stubAgentAccounts(200, { mode: 'multi-user', personalSubscriptionsEnabled: true,
      codex: { account: null, pendingAttempt: null }, claude: { available: false } });
    for (const info of [null, { ...MULTI_USER, capabilities: { slideRenderer: true } }]) {
      await renderSettings(info);
      expect(screen.queryByTestId('settings-nav-agent-accounts')).toBeNull();
      cleanup();
    }
    expect(fetchMock.mock.calls.filter(([input]) => String(input) === '/api/agent-accounts')).toEqual([]);
  });

  it('stays hidden for a multi-user daemon that refuses the probe', async () => {
    for (const [status, body] of [[404, { error: { code: 'NOT_FOUND' } }], [401, { error: { code: 'UNAUTHORIZED' } }]] as const) {
      stubAgentAccounts(status, body);
      await renderSettings();
      expect(screen.queryByTestId('settings-nav-agent-accounts')).toBeNull();
      cleanup();
    }
  });

  it('appears for a signed-in multi-user session and opens the personal section', async () => {
    stubAgentAccounts(200, { mode: 'multi-user', personalSubscriptionsEnabled: false,
      codex: { account: null, pendingAttempt: null }, claude: { available: false } });
    await renderSettings();
    const nav = await screen.findByTestId('settings-nav-agent-accounts');
    fireEvent.click(nav);
    expect(screen.getByText('Personal subscriptions are not enabled on this server.')).toBeTruthy();
    expect(screen.getByRole('article', { name: 'Codex' })).toBeTruthy();
  });
});
