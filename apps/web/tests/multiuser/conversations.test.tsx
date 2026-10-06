// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MultiUserApp } from '../../src/multiuser/MultiUserApp';
import { I18nProvider } from '../../src/i18n';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function mount(load: () => Promise<Response>) {
  window.history.replaceState({}, '', '/projects/p1');
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/auth/me') return json({ account: { id: 'alice', username: 'alice', role: 'user', active: true } });
    if (url === '/api/projects/p1') return json({ project: { id: 'p1', name: 'Owned project' } });
    if (url === '/api/projects/p1/conversations') return load();
    if (url === '/api/multiuser/design-catalog') return json({
      skills: [{ id: 'builtin-skill', name: 'Built-in skill', displayName: { en: 'Built-in skill' } }],
      designSystems: [{ id: 'builtin-design', name: 'builtin-design', title: 'Built-in design' }],
    });
    if (url === '/api/multiuser/projects/p1/design-selections') return json({
      designs: [{ conversationId: 'c1', skillId: 'builtin-skill', designSystemId: 'builtin-design', locale: 'en' }],
    });
    throw new Error(`Unexpected request ${url}`);
  }));
  return render(<I18nProvider initial="en"><MultiUserApp setupToken={null} /></I18nProvider>);
}
it('keeps creation behind loading and shows the empty owned conversation state', async () => {
  let resolve!: (value: Response) => void;
  const pending = new Promise<Response>((r) => { resolve = r; });
  mount(() => pending);
  await screen.findByText('Loading…');
  expect(screen.queryByRole('button', { name: 'Create conversation' })).toBeNull();
  await act(async () => resolve(json({ conversations: [] })));
  expect(screen.getByText('No conversations yet. Create one to begin.')).toBeTruthy();
  expect(screen.getByLabelText('Conversation title')).toBeTruthy();
  expect(screen.getByRole('option', { name: 'Built-in skill' }).getAttribute('value')).toBe('builtin-skill');
  expect(screen.getByRole('option', { name: 'Built-in design' }).getAttribute('value')).toBe('builtin-design');
});
it('retries a failed read before exposing conversation links and creation', async () => {
  let fail = true;
  mount(async () => fail ? json({ error: { code: 'NOT_FOUND' } }, 404) : json({ conversations: [{ id: 'c1', title: 'Owned conversation' }] }));
  expect((await screen.findByRole('alert')).textContent).toBe('Project, conversation or run not found.');
  expect(screen.queryByRole('button', { name: 'Create conversation' })).toBeNull();
  fail = false;
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry' })));
  expect((await screen.findByRole('link', { name: 'Owned conversation' })).getAttribute('href')).toBe('/projects/p1/conversations/c1');
});
