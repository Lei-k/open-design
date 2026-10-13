// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { StudioAutomationTemplate } from '@open-design/contracts';
import { StudioAutomationTemplates } from '../../src/components/StudioAutomationTemplates';

const template: StudioAutomationTemplate = { id: 'studio-template-private', title: 'Private brief', description: 'Keep context', purpose: 'Summarize',
  triggerKinds: ['manual'], sourceKinds: ['chat'], stages: [{ id: 'propose', kind: 'propose', title: 'Propose' }],
  outputSinks: ['memory'], reviewPolicy: 'always', tokenCompression: 'balanced', studioOwned: true };
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function mount(status = 200) {
  const posts: Record<string, any>[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    posts.push(JSON.parse(String(init?.body)));
    return Response.json(status === 200 ? { proposal: { id: 'proposal' } } : { error: { message: 'Template changed; review a fresh proposal' } }, { status });
  }));
  const onClose = vi.fn(); const onProposed = vi.fn();
  render(<StudioAutomationTemplates templates={[template, { ...template, id: 'built-in', studioOwned: undefined, title: 'Bundled' }]}
    onClose={onClose} onProposed={onProposed} />);
  return { posts, onClose, onProposed };
}
it('proposes a new template without writing directly, then refreshes the existing review section', async () => {
  const state = mount();
  const { id: _id, studioOwned: _owned, ...draft } = template;
  fireEvent.change(screen.getByTestId('studio-template-json'), { target: { value: JSON.stringify(draft) } });
  fireEvent.click(screen.getByTestId('studio-template-propose'));
  await waitFor(() => expect(state.onProposed).toHaveBeenCalledOnce());
  expect(state.onClose).toHaveBeenCalledOnce();
  expect(state.posts[0]).toMatchObject({ title: template.title, targetKind: 'automation-template', action: 'create', reviewPolicy: 'always' });
  expect(state.posts[0]?.targetRef).toBeUndefined();
  expect(JSON.parse(state.posts[0]?.patch.after)).toEqual(draft);
});
it.each(['update', 'delete'])('captures the reviewed private template snapshot for %s, excluding projection fields', async (action) => {
  const state = mount();
  expect(screen.queryByRole('option', { name: 'Bundled' })).toBeNull();
  fireEvent.change(screen.getByTestId('studio-template-select'), { target: { value: template.id } });
  if (action === 'update') fireEvent.change(screen.getByTestId('studio-template-json'), { target: { value: JSON.stringify({ ...JSON.parse((screen.getByTestId('studio-template-json') as HTMLTextAreaElement).value), title: 'Updated' }) } });
  fireEvent.click(screen.getByTestId(action === 'delete' ? 'studio-template-delete' : 'studio-template-propose'));
  await waitFor(() => expect(state.posts).toHaveLength(1));
  expect(state.posts[0]).toMatchObject({ action, targetRef: template.id, patch: { format: 'json' } });
  const before = JSON.parse(state.posts[0]?.patch.before);
  expect(before.id).toBe(template.id); expect(before.studioOwned).toBeUndefined();
  if (action === 'delete') expect(state.posts[0]?.patch.after).toBeUndefined();
  else expect(JSON.parse(state.posts[0]?.patch.after).title).toBe('Updated');
});
it('keeps invalid JSON local and shows daemon refusals without closing the editor', async () => {
  const state = mount(409);
  fireEvent.change(screen.getByTestId('studio-template-json'), { target: { value: '{' } });
  fireEvent.click(screen.getByTestId('studio-template-propose'));
  expect(state.posts).toEqual([]); expect(screen.getByRole('alert').textContent).toContain('valid JSON');
  fireEvent.change(screen.getByTestId('studio-template-select'), { target: { value: template.id } });
  fireEvent.click(screen.getByTestId('studio-template-propose'));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Template changed'));
  expect(state.onProposed).not.toHaveBeenCalled(); expect(state.onClose).not.toHaveBeenCalled();
});
