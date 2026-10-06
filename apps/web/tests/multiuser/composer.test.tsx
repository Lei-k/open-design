// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { PersonalAgentAccountsResponse } from '@open-design/contracts';
import { RunComposer, validRunMessage } from '../../src/multiuser/RunComposer';
import { RequestFailure } from '../../src/multiuser/session';
import { I18nProvider } from '../../src/i18n';
const accounts: PersonalAgentAccountsResponse = { mode: 'multi-user', personalSubscriptionsEnabled: true, codex: { account: { id: 'a', provider: 'codex', status: 'connected', maskedIdentity: 'a***@example.test', planType: null, linkedAt: 1, verifiedAt: null, lastProblem: null, rateLimits: null }, pendingAttempt: null }, claude: { available: false } };
afterEach(cleanup);
it('requires explicit choice, preserves personal selection on failure, and never falls back', async () => {
  const send = vi.fn(async () => { throw new RequestFailure(429, 'MULTIUSER_PERSONAL_USAGE_LIMIT'); });
  render(<I18nProvider initial="en"><RunComposer accounts={accounts} pinnedSource={null} send={send} /></I18nProvider>);
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'hello' } });
  expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('radio', { name: 'My Codex subscription' }));
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send' })));
  expect(send).toHaveBeenCalledExactlyOnceWith('hello', 'personal_subscription');
  expect(screen.getByRole('alert').textContent).toContain('subscription usage limit');
  expect((screen.getByRole('radio', { name: 'My Codex subscription' }) as HTMLInputElement).checked).toBe(true);
  expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('hello');
});
it.each([false, true])('disables personal choice when feature enabled=%s but no account is connected', (enabled) => {
  render(<I18nProvider initial="en"><RunComposer accounts={{ ...accounts, personalSubscriptionsEnabled: enabled, codex: { account: null, pendingAttempt: null } }} pinnedSource={null} send={vi.fn()} /></I18nProvider>);
  expect((screen.getByRole('radio', { name: 'My Codex subscription' }) as HTMLInputElement).disabled).toBe(true);
  expect(screen.getByRole('link', { name: 'Agent accounts' }).getAttribute('href')).toBe('/account/agents');
});
it('reflects a personal pin after disconnection as locked, without offering company', () => {
  render(<I18nProvider initial="en"><RunComposer accounts={{ ...accounts, codex: { account: { ...accounts.codex.account!, status: 'requires_reauth' }, pendingAttempt: null } }} pinnedSource="personal_subscription" send={vi.fn()} /></I18nProvider>);
  const sources = screen.getByRole('group', { name: 'Execution source' });
  expect(within(sources).getByText('Locked to My Codex subscription')).toBeTruthy();
  expect(screen.queryByRole('radio')).toBeNull();
  expect(screen.getByText(/pinned to its first/)).toBeTruthy();
  expect(screen.getByText(/sign-in expired/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'hello' } });
  expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
});
it('warns about a stale personal pin instead of suggesting a relink, and offers no send', () => {
  render(<I18nProvider initial="en"><RunComposer accounts={accounts} pinnedSource="personal_subscription" pinStale send={vi.fn()} /></I18nProvider>);
  expect(screen.getByRole('note').textContent).toMatch(/no longer linked/);
  expect(screen.queryByRole('link', { name: 'Agent accounts' })).toBeNull();
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'hello' } });
  expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
});
it('hides personal-account hints in a conversation pinned to the company pool', () => {
  render(<I18nProvider initial="en"><RunComposer accounts={{ ...accounts, codex: { account: null, pendingAttempt: null } }} pinnedSource="company_pool" send={vi.fn()} /></I18nProvider>);
  expect(screen.getByText('Locked to Company pool (test mock)')).toBeTruthy();
  expect(screen.queryByRole('link', { name: 'Agent accounts' })).toBeNull();
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'hello' } });
  expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false);
});
it('uses both the server character bound and its encoded UTF-8 message budget', () => {
  expect(validRunMessage('a'.repeat(64_000))).toBe(true);
  for (const text of ['', ' ', 'a'.repeat(64_001), '\u0001'.repeat(20_000), '界'.repeat(30_000)]) expect(validRunMessage(text)).toBe(false);
});
it('withdraws the company pool when the server reports it unavailable, keeping personal usable', async () => {
  const send = vi.fn(async () => {});
  render(<I18nProvider initial="en"><RunComposer accounts={{ ...accounts, companyPoolAvailable: false }} pinnedSource={null} send={send} /></I18nProvider>);
  expect((screen.getByRole('radio', { name: 'Company pool (test mock)' }) as HTMLInputElement).disabled).toBe(true);
  expect(screen.getByText('The company pool is not available on this server yet.')).toBeTruthy();
  fireEvent.click(screen.getByRole('radio', { name: 'My Codex subscription' }));
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'hello' } });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send' })));
  expect(send).toHaveBeenCalledExactlyOnceWith('hello', 'personal_subscription');
});
it('keeps the company pool when an older daemon omits the field', () => {
  render(<I18nProvider initial="en"><RunComposer accounts={accounts} pinnedSource={null} send={vi.fn()} /></I18nProvider>);
  expect((screen.getByRole('radio', { name: 'Company pool (test mock)' }) as HTMLInputElement).disabled).toBe(false);
  expect(screen.queryByText('The company pool is not available on this server yet.')).toBeNull();
});
