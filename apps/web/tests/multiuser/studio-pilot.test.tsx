// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MultiUserApp } from '../../src/multiuser/MultiUserApp';
import { I18nProvider } from '../../src/i18n';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('reads the target pilot and submits its revision, then requires a fresh read after conflict', async () => {
  window.history.replaceState({}, '', '/admin/users');
  const admin = { id: 'admin', username: 'Administrator', active: true, role: 'admin', passwordState: 'set' };
  const alice = { ...admin, id: 'alice', username: 'Alice', role: 'user' };
  let revision = 0;
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/auth/me') return json({ account: admin });
    if (url.startsWith('/api/auth/users?')) return json({ accounts: [admin, alice], page: { total: 2, offset: 0, limit: 20 } });
    expect(url).toBe('/api/admin/users/alice/studio-pilot');
    if (init?.method === 'PUT') { expect(JSON.parse(String(init.body))).toEqual({ studioPilot: true, revision: 0 }); revision = 1; return json({}, 409); }
    return json({ studioPilot: false, revision });
  });
  vi.stubGlobal('fetch', fetcher);
  render(<I18nProvider initial="en"><MultiUserApp setupToken={null} /></I18nProvider>);
  const row = (await screen.findByText('Alice')).closest('li')!;
  fireEvent.click(within(row).getByRole('button', { name: 'Studio pilot' }));
  await within(row).findByRole('button', { name: 'Enable Studio pilot' });
  await act(async () => fireEvent.click(within(row).getByRole('button', { name: 'Enable Studio pilot' })));
  expect(within(row).getByRole('alert')).toBeTruthy();
  expect(within(row).queryByRole('button', { name: 'Enable Studio pilot' })).toBeNull();
  fireEvent.click(within(row).getByRole('button', { name: 'Retry' }));
  await within(row).findByRole('button', { name: 'Enable Studio pilot' });
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1);
});
