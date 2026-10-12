// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { STUDIO_PARITY_LANES, type AuthAccount, type PersonalAccountStatus, type StudioExecutionSource, type StudioRuntimeCapabilities } from '@open-design/contracts';
import { CookieSession } from '../../src/multiuser/session';
import { StudioCapabilitiesProvider } from '../../src/runtime/studio-capabilities';
import { StudioComposerSource } from '../../src/runtime/StudioComposerSource';
import { notifyStudioProviderKeysChanged } from '../../src/runtime/studio-research';

const actor: AuthAccount = { id: 'A', username: 'A', role: 'user', active: true, passwordState: 'set', createdAt: 1, updatedAt: 1 };
const all: StudioExecutionSource[] = [
  { source: 'personal_subscription', agentId: 'codex' }, { source: 'company_pool', agentId: 'openai' },
  { source: 'personal_api_key', agentId: 'openai-byok' },
];
type Facts = { sources?: StudioExecutionSource[]; codex?: PersonalAccountStatus | null; key?: boolean };
let session: CookieSession;
let facts: Required<Facts>;
afterEach(() => { cleanup(); session?.dispose(); vi.unstubAllGlobals(); });

async function mount(props: Partial<Parameters<typeof StudioComposerSource>[0]> = {}, given: Facts = {}) {
  facts = { sources: all, codex: 'connected', key: true, ...given };
  const capabilities: StudioRuntimeCapabilities = { schemaVersion: 1, shell: 'studio', executionSources: facts.sources,
    features: Object.fromEntries(STUDIO_PARITY_LANES.map(({ id }) => [id, { status: 'pilot', reason: 'Pilot' }])) as StudioRuntimeCapabilities['features'] };
  const reads: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input); reads.push(url);
    if (url === '/api/auth/me') return Response.json({ account: actor, studio: capabilities, studioRevision: 1, studioMessageIdPrefix: 'mua_0123456789abcdef01234567_' });
    if (url === '/api/agent-accounts') return Response.json({ mode: 'multi-user', personalSubscriptionsEnabled: facts.sources.some((s) => s.agentId === 'codex'),
      companyPoolAvailable: facts.sources.some((s) => s.agentId === 'openai'), claude: { available: false },
      codex: { account: facts.codex ? { id: 'x', provider: 'codex', status: facts.codex, maskedIdentity: 'a***@example.com', planType: null,
        linkedAt: 1, verifiedAt: 1, lastProblem: null, rateLimits: null } : null, pendingAttempt: null } });
    if (url === '/api/multiuser/settings/provider-keys') return Response.json({ keys: [{ provider: 'openai', configured: facts.key, last4: facts.key ? 'Qz9K' : null,
      model: 'gpt-5.1', revision: 1, keyRevision: 1 }, { provider: 'tavily', configured: false, last4: null, model: '', revision: 0, keyRevision: 0 }] });
    return Response.json({ error: { code: 'NOT_FOUND', message: 'Unavailable' } }, { status: 404 });
  }));
  session = new CookieSession(); await session.verify();
  const handlers = { onChange: vi.fn(), onNewConversation: vi.fn(), onOpenSettings: vi.fn() };
  const view = render(<StudioCapabilitiesProvider session={session} generation={session.snapshot().generation} actor={actor} capabilities={capabilities}>
    <StudioComposerSource agentId="openai" {...handlers} {...props} />
  </StudioCapabilitiesProvider>);
  return { ...handlers, reads, view };
}
const trigger = () => within(screen.getByTestId('studio-execution-source')).getByRole('button', { name: /^Execution source/ });
const panel = async () => { fireEvent.click(trigger()); return screen.findByRole('dialog', { name: 'Execution source' }); };
const row = (dialog: HTMLElement, agentId: string) => dialog.querySelector(`[data-source-agent="${agentId}"]`) as HTMLElement;

it('selects among usable sources before the first turn and closes back to the trigger', async () => {
  const { onChange } = await mount();
  expect(trigger().textContent).toContain('OpenAI · company pool');
  const dialog = await panel();
  const radios = within(dialog).getAllByRole('radio') as HTMLInputElement[];
  expect(radios.map((radio) => radio.value)).toEqual(['codex', 'openai', 'openai-byok']);
  await waitFor(() => expect(radios.every((radio) => !radio.disabled)).toBe(true));
  expect(radios.find((radio) => radio.checked)?.value).toBe('openai');
  fireEvent.click(within(dialog).getByRole('radio', { name: 'OpenAI · your API key' }));
  expect(onChange).toHaveBeenCalledWith('openai-byok');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(trigger());
});

it('discloses every unavailable source with its reason and the entry the account can fix', async () => {
  const { onChange, onOpenSettings } = await mount({}, { sources: [{ source: 'personal_subscription', agentId: 'codex' }, { source: 'personal_api_key', agentId: 'openai-byok' }],
    codex: null, key: false });
  const dialog = await panel();
  await waitFor(() => expect((within(row(dialog, 'codex')).getByRole('radio') as HTMLInputElement).disabled).toBe(true));
  // Personal Codex advertised but not linked: its existing link flow lives in Settings → Agent accounts.
  expect(row(dialog, 'codex').textContent).toContain('Link your Codex subscription to use this source.');
  fireEvent.click(within(row(dialog, 'codex')).getByRole('button', { name: 'Link Codex in Settings' }));
  expect(onOpenSettings).toHaveBeenLastCalledWith('agentAccounts');
  // Company pool off: administrator-owned, no entry.
  const company = await panel();
  expect((within(row(company, 'openai')).getByRole('radio') as HTMLInputElement).disabled).toBe(true);
  expect(row(company, 'openai').textContent).toContain('The company pool is turned off by an administrator.');
  expect(within(row(company, 'openai')).queryByRole('button')).toBeNull();
  // Own key advertised but not saved.
  const key = within(row(company, 'openai-byok'));
  expect((key.getByRole('radio') as HTMLInputElement).disabled).toBe(true);
  expect(row(company, 'openai-byok').textContent).toContain('Add your own OpenAI API key to use this source.');
  expect((key.getByRole('radio') as HTMLInputElement).getAttribute('aria-describedby')).toBeTruthy();
  fireEvent.click(key.getByRole('button', { name: 'Add key in Settings' }));
  expect(onOpenSettings).toHaveBeenLastCalledWith('agentAccounts');
  expect(onChange).not.toHaveBeenCalled();
  // The current source cannot run: the trigger says so instead of hiding it.
  expect(trigger().getAttribute('aria-label')).toContain('cannot be used now');
});

it('states server-disabled personal sources without an entry', async () => {
  await mount({ agentId: 'openai' }, { sources: [{ source: 'company_pool', agentId: 'openai' }] });
  const dialog = await panel();
  for (const agentId of ['codex', 'openai-byok']) {
    expect((within(row(dialog, agentId)).getByRole('radio') as HTMLInputElement).disabled).toBe(true);
    expect(row(dialog, agentId).textContent).toContain('Not enabled on this server. An administrator manages this.');
    expect(within(row(dialog, agentId)).queryByRole('button')).toBeNull();
  }
});

it('shows a reauthorize entry when the Codex sign-in expired', async () => {
  const { onOpenSettings } = await mount({ agentId: 'codex' }, { codex: 'requires_reauth' });
  const dialog = await panel();
  await waitFor(() => expect(row(dialog, 'codex').textContent).toContain('Your Codex sign-in expired.'));
  fireEvent.click(within(row(dialog, 'codex')).getByRole('button', { name: 'Re-authorize in Settings' }));
  expect(onOpenSettings).toHaveBeenCalledWith('agentAccounts');
});

it('re-reads key state after Settings saves a key', async () => {
  const { reads } = await mount({}, { key: false });
  const dialog = await panel();
  await waitFor(() => expect((within(row(dialog, 'openai-byok')).getByRole('radio') as HTMLInputElement).disabled).toBe(true));
  facts.key = true;
  const before = reads.filter((url) => url.endsWith('/provider-keys')).length;
  notifyStudioProviderKeysChanged();
  await waitFor(() => expect(reads.filter((url) => url.endsWith('/provider-keys')).length).toBeGreaterThan(before));
  await waitFor(() => expect((within(row(dialog, 'openai-byok')).getByRole('radio') as HTMLInputElement).disabled).toBe(false));
});

it('keeps a pinned conversation on its source and offers a new conversation with another one', async () => {
  const { onChange, onNewConversation } = await mount({ agentId: 'codex', pinned: true });
  expect(trigger().getAttribute('aria-label')).toContain('fixed for this conversation');
  const dialog = await panel();
  expect(dialog.textContent).toContain('Fixed for this conversation');
  expect(within(dialog).queryAllByRole('radio')).toHaveLength(0);
  expect(row(dialog, 'codex').getAttribute('aria-current')).toBe('true');
  expect(within(row(dialog, 'codex')).queryByRole('button')).toBeNull();
  await waitFor(() => expect(within(row(dialog, 'openai')).getByRole('button', { name: 'New conversation with OpenAI · company pool' })).toBeTruthy());
  fireEvent.click(within(row(dialog, 'openai-byok')).getByRole('button', { name: 'New conversation with OpenAI · your API key' }));
  expect(onNewConversation).toHaveBeenCalledWith('openai-byok');
  expect(onChange).not.toHaveBeenCalled();
});

it('offers no new-conversation action on a pinned conversation the actor cannot extend', async () => {
  await mount({ agentId: 'openai', pinned: true, onNewConversation: undefined });
  const dialog = await panel();
  expect(within(dialog).queryAllByRole('button', { name: /^New conversation/ })).toHaveLength(0);
});

it('hides personal Codex in media-only projects (#63)', async () => {
  await mount({ agentId: 'openai', mediaOnly: true });
  const dialog = await panel();
  expect(row(dialog, 'codex')).toBeNull();
  expect(within(dialog).getAllByRole('radio').map((radio) => (radio as HTMLInputElement).value)).toEqual(['openai', 'openai-byok']);
});

it('closes on Escape and returns focus to the trigger', async () => {
  await mount();
  const dialog = await panel();
  fireEvent.keyDown(dialog, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(trigger());
});

it('keeps the per-turn Codex model and effort pickers labelled on the Codex source', async () => {
  const onModelChange = vi.fn();
  await mount({ agentId: 'codex', onModelChange });
  fireEvent.change(screen.getByRole('combobox', { name: 'Model' }), { target: { value: 'gpt-6-sol' } });
  expect(onModelChange).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-6-sol' }));
  expect(screen.getByTestId('studio-codex-reasoning')).toBeTruthy();
});

it('closes when the already-selected source is chosen again, without a change', async () => {
  const { onChange } = await mount({ agentId: 'openai' });
  const dialog = await panel();
  await waitFor(() => expect((within(row(dialog, 'openai')).getByRole('radio') as HTMLInputElement).checked).toBe(true));
  fireEvent.click(within(row(dialog, 'openai')).getByRole('radio'));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(onChange).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(trigger());
});
