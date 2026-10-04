// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MultiUserApp } from '../../src/multiuser/MultiUserApp';
import { I18nProvider } from '../../src/i18n';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const summary = { mode: 'multi-user', personalSubscriptionsEnabled: true, codex: { account: null, pendingAttempt: null }, claude: { available: false } };
const pending = { id: 'attempt-a', provider: 'codex', status: 'pending', expiresAt: Date.now() + 60_000, userCode: 'SYNTHETIC-A', verificationUrl: 'https://auth.openai.com/codex/device' };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });
it.each(['start', 'poll'])('withdraws a pending device code and fences deferred %s across account switch', async (step) => {
  window.history.replaceState({}, '', '/account/agents');
  let identity = 'alice'; let release!: (response: Response) => void;
  const held = new Promise<Response>((resolve) => { release = resolve; });
  let ownedSignal: AbortSignal | null | undefined;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/auth/me') return json({ account: { id: identity, username: identity, role: 'user', active: true } });
    if (url === '/api/agent-accounts') return json(summary);
    ownedSignal = init?.signal;
    if (url.endsWith('/logins') && step === 'poll') return json({ attempt: pending });
    return held;
  }));
  render(<I18nProvider initial="en"><MultiUserApp setupToken={null} /></I18nProvider>);
  await screen.findByRole('button', { name: 'Link my subscription' });
  if (step === 'poll') vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Link my subscription' })));
  if (step === 'poll') {
    expect(screen.getByText(pending.userCode)).toBeTruthy();
    await act(async () => vi.advanceTimersByTime(2000));
  }
  const oldSignal = ownedSignal;
  identity = 'bob'; await act(async () => window.dispatchEvent(new StorageEvent('storage', { key: 'open-design:auth-change', newValue: 'changed:account-switch' })));
  expect(oldSignal?.aborted).toBe(true);
  await act(async () => release(json({ attempt: pending })));
  expect(screen.getByText('bob')).toBeTruthy();
  expect(screen.queryByText(pending.userCode)).toBeNull();
  expect(window.location.href).not.toContain(pending.userCode);
  expect(JSON.stringify(localStorage)).not.toContain(pending.userCode);
  expect(JSON.stringify(sessionStorage)).not.toContain(pending.userCode);
});
it('withdraws the account page when its summary returns 401', async () => {
  window.history.replaceState({}, '', '/account/agents');
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url === '/api/auth/me'
    ? json({ account: { id: 'alice', username: 'alice', role: 'user', active: true } }) : json({}, 401)));
  render(<I18nProvider initial="en"><MultiUserApp setupToken={null} /></I18nProvider>);
  await screen.findByRole('button', { name: 'Sign in' });
  expect(screen.queryByText('alice')).toBeNull();
});
