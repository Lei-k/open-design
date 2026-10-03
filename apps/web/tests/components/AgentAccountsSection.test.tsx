// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersonalAgentAccount, PersonalAgentAccountsResponse, PersonalLoginAttempt } from '@open-design/contracts';
import { AGENT_ACCOUNT_POLL_MS, AgentAccountsSection } from '../../src/components/AgentAccountsSection';
import { I18nProvider } from '../../src/i18n';

const account: PersonalAgentAccount = {
  id: 'acc-1', provider: 'codex', status: 'connected', maskedIdentity: 'a***@example.com', planType: 'plus',
  linkedAt: 1_800_000_000_000, verifiedAt: null, lastProblem: null,
  rateLimits: { primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: null }, secondary: null, readAt: 1 },
};
const pending: PersonalLoginAttempt = {
  id: 'att-1', provider: 'codex', status: 'pending', failureCode: null, createdAt: 0, expiresAt: Date.now() + 15 * 60_000,
  verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234',
};
const view = (patch: Partial<PersonalAgentAccountsResponse['codex']> = {}, enabled = true): PersonalAgentAccountsResponse => ({
  mode: 'multi-user', personalSubscriptionsEnabled: enabled,
  codex: { account: null, pendingAttempt: null, ...patch }, claude: { available: false },
});

type Handler = (url: string, init?: RequestInit) => { status: number; body: unknown };
let handler: Handler;
const calls: Array<{ url: string; method: string; body: unknown }> = [];

function renderSection(initial: PersonalAgentAccountsResponse, locale: 'en' | 'zh-TW' = 'en') {
  return render(<I18nProvider initial={locale}><AgentAccountsSection initial={initial} /></I18nProvider>);
}

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null });
    const { status, body } = handler(url, init);
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('AgentAccountsSection', () => {
  it('shows the server switch as off and offers no action', () => {
    handler = () => ({ status: 200, body: view({}, false) });
    renderSection(view({}, false));
    expect(screen.getByText('Personal subscriptions are not enabled on this server.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Link my subscription' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('starts the device flow and shows only the official link and one-time code', async () => {
    handler = (url) => (url.endsWith('/logins') ? { status: 202, body: { attempt: pending } } : { status: 200, body: { attempt: pending } });
    const { container } = renderSection(view());
    expect(screen.getByText('Not linked')).toBeTruthy();
    expect(screen.getByText('Personal subscription')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Link my subscription' })); });
    const link = screen.getByRole('link', { name: 'Open the official sign-in page' }) as HTMLAnchorElement;
    expect(link.href).toBe('https://auth.openai.com/codex/device');
    expect(link.target).toBe('_blank');
    expect(link.rel).toContain('noopener');
    expect(screen.getByLabelText('Your one-time code').textContent).toBe('ABCD-1234');
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    expect(screen.getByText('Waiting for you to finish signing in…')).toBeTruthy();
    expect(screen.getByText(/Code expires in 1[45]:\d\d/)).toBeTruthy();
    // Never asks for a password or token.
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(container.querySelector('input[type="text"]')).toBeNull();
  });

  it('polls the pending attempt and reports a terminal outcome', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    let status: PersonalLoginAttempt['status'] = 'pending';
    handler = (url) => (url === '/api/agent-accounts'
      ? { status: 200, body: view() }
      : { status: 200, body: { attempt: status === 'pending' ? pending : { ...pending, status, failureCode: 'identity_in_use',
        verificationUrl: undefined, userCode: undefined } } });
    renderSection(view({ pendingAttempt: { ...pending, verificationUrl: undefined, userCode: undefined } }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByLabelText('Your one-time code').textContent).toBe('ABCD-1234');
    status = 'failed';
    await act(async () => { await vi.advanceTimersByTimeAsync(AGENT_ACCOUNT_POLL_MS - 1); });
    expect(screen.queryByText('This provider account is already linked to another OpenDesign user.')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByText('This provider account is already linked to another OpenDesign user.')).toBeTruthy();
    expect(screen.queryByLabelText('Your one-time code')).toBeNull();
  });

  it('shows the connected account, usage or unknown, and requires consent before verifying', async () => {
    handler = (url) => (url.endsWith('/verify')
      ? { status: 200, body: { account: { ...account, verifiedAt: 1_800_000_100_000 } } }
      : { status: 200, body: view({ account: { ...account, verifiedAt: 1_800_000_100_000 } }) });
    renderSection(view({ account }));
    expect(screen.getByText('a***@example.com')).toBeTruthy();
    expect(screen.getByText('plus')).toBeTruthy();
    expect(screen.getByText('42% used')).toBeTruthy();
    expect(screen.getByText('Not verified yet')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Verify with a minimal request' }));
    const send = screen.getByRole('button', { name: 'Send the request' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect(calls.some((call) => call.url.endsWith('/verify'))).toBe(false);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(send.disabled).toBe(false);
    await act(async () => { fireEvent.click(send); });
    expect(calls.find((call) => call.url.endsWith('/verify'))).toMatchObject({ method: 'POST', body: { consentToUsePlan: true } });
    expect(screen.getByText('Verified: your subscription can run agents.')).toBeTruthy();
    cleanup();
    renderSection(view({ account: { ...account, rateLimits: null } }));
    expect(screen.getByText('Unknown')).toBeTruthy();
  });

  it('confirms before unlinking', async () => {
    handler = (url) => (url.endsWith('/accounts/acc-1') ? { status: 200, body: { unlinked: true } } : { status: 200, body: view() });
    renderSection(view({ account }));
    fireEvent.click(screen.getByRole('button', { name: 'Unlink' }));
    expect(calls).toHaveLength(0);
    expect(screen.getByText(/does not revoke access at the provider/)).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Unlink account' })); });
    expect(calls[0]).toMatchObject({ url: '/api/agent-accounts/codex/accounts/acc-1', method: 'DELETE' });
    expect(screen.getByRole('button', { name: 'Link my subscription' })).toBeTruthy();
  });

  it('gives a clear next action for requires_reauth, disabled and usage-limit states', () => {
    handler = () => ({ status: 200, body: view() });
    renderSection(view({ account: { ...account, status: 'requires_reauth', lastProblem: 'reauth_required' } }));
    expect(screen.getByText('Sign-in expired')).toBeTruthy();
    expect(screen.getByText(/Re-authorize to keep using it/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Re-authorize' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Verify with a minimal request' })).toBeNull();
    cleanup();
    renderSection(view({ account: { ...account, status: 'disabled', lastProblem: 'workspace_not_allowed' } }));
    expect(screen.getByText(/Ask the workspace admin/)).toBeTruthy();
    cleanup();
    renderSection(view({ account: { ...account, lastProblem: 'usage_limit_reached' } }));
    expect(screen.getByText(/never switch to the company pool/)).toBeTruthy();
  });

  it('renders Claude Code as coming later with no action, and localizes the section', () => {
    handler = () => ({ status: 200, body: view() });
    renderSection(view(), 'zh-TW');
    const claude = screen.getByRole('article', { name: 'Claude Code' });
    expect(claude.getAttribute('aria-disabled')).toBe('true');
    expect(claude.querySelector('button')).toBeNull();
    expect(screen.getByText('即將推出')).toBeTruthy();
    expect(screen.getByRole('button', { name: '連結我的訂閱' })).toBeTruthy();
  });
});
