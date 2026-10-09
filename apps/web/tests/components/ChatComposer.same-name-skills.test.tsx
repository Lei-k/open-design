// @vitest-environment jsdom
/**
 * Team catalogs (S40): an account can see its own `brand-voice` skill and
 * another account's shared `brand-voice` side by side. The two have the same
 * `@brand-voice` token, so the Composer must keep each pill's skill id through
 * deletion and draft restoration instead of re-resolving the name to whichever
 * catalog entry is listed first.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createRef, type ComponentProps } from 'react';
import { $getRoot, $getSelection, $isElementNode, $isRangeSelection } from 'lexical';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatComposer, type ChatComposerHandle } from '../../src/components/ChatComposer';
import { $isMentionNode } from '../../src/components/composer/MentionNode';
import { saveComposerDraftExtras } from '../../src/runtime/chat/composer-draft';
import { flushMounts, getComposerEditor, pressEnter, typeAndSettle } from '../helpers/lexical-composer';

const KEY = 'od:chat-composer:draft:project-1:conv-1';
const base = {
  description: 'Write in the brand voice.', triggers: [], mode: 'prototype' as const, previewType: 'html',
  designSystemRequired: false, defaultFor: [], upstream: null, hasBody: true, examplePrompt: '', aggregatesExamples: false,
};
// The daemon lists the account's own entries before shared ones.
const OWN = { ...base, id: 'studio-skill:own', name: 'brand-voice' };
const SHARED = { ...base, id: 'studio-skill:shared', name: 'brand-voice',
  studioShare: { role: 'use' as const, ownerUsername: 'owner-a', memberCount: 2 } };
const SKILLS = [OWN, SHARED];

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/skills') return Response.json({ skills: SKILLS });
    if (url === '/api/plugins') return Response.json({ plugins: [] });
    if (url === '/api/mcp/servers') return Response.json({ servers: [], templates: [] });
    if (url === '/api/projects/project-1' && init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body ?? '{}')) as { skillId?: string };
      return Response.json({ project: { id: 'project-1', name: 'Project', skillId: body.skillId ?? null, designSystemId: null,
        createdAt: 1, updatedAt: 1, metadata: { kind: 'prototype' } } });
    }
    return Response.json({});
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); window.localStorage.clear(); cleanup(); });

function renderComposer(overrides: Partial<ComponentProps<typeof ChatComposer>> = {}) {
  const ref = createRef<ChatComposerHandle>();
  const onSend = vi.fn();
  render(
    <ChatComposer ref={ref} projectId="project-1" projectFiles={[]} streaming={false} onEnsureProject={async () => 'project-1'}
      onSend={onSend} onStop={vi.fn()} skills={SKILLS} {...overrides} />,
  );
  return { ref, onSend };
}

const pills = () => Array.from(screen.getByTestId('chat-composer-input').querySelectorAll('[data-mention-kind="skill"]'));
const pillIds = () => pills().map((pill) => pill.getAttribute('data-mention-id'));

/** Type at the end of the editor without replacing existing pills. */
async function appendInComposer(text: string) {
  const editor = getComposerEditor();
  act(() => {
    editor.update(() => {
      $getRoot().selectEnd();
      const selection = $getSelection();
      if ($isRangeSelection(selection)) selection.insertText(text);
    }, { discrete: true });
  });
  await act(async () => { await Promise.resolve(); });
}

/** Delete one pill node, as Backspace over an atomic mention does. */
async function deletePill(id: string) {
  const editor = getComposerEditor();
  act(() => {
    editor.update(() => {
      for (const block of $getRoot().getChildren()) {
        if (!$isElementNode(block)) continue;
        for (const child of block.getChildren()) if ($isMentionNode(child) && child.getEntity().id === id) child.remove();
      }
    }, { discrete: true });
  });
  await act(async () => { await Promise.resolve(); });
}

async function pick(index = 0) {
  const picker = await screen.findByTestId('mention-popover');
  const options = within(picker).getAllByRole('option', { name: /brand-voice/ });
  fireEvent.click(options[index]!);
}

async function sentSkillIds(onSend: ReturnType<typeof vi.fn>) {
  pressEnter();
  await act(async () => { await Promise.resolve(); });
  await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
  return (onSend.mock.calls[0]?.[3] as { skillIds?: string[] } | undefined)?.skillIds ?? [];
}

describe('same-name skills in the Composer', () => {
  it('keeps the remaining pill\'s own id after the other same-name pill is deleted', async () => {
    const { onSend } = renderComposer();
    await flushMounts();
    await typeAndSettle('@brand');
    await pick(0);
    await waitFor(() => expect(pills()).toHaveLength(1));
    await appendInComposer('@brand');
    await pick(0);
    await waitFor(() => expect(pills()).toHaveLength(2));
    expect(new Set(pillIds())).toEqual(new Set([OWN.id, SHARED.id]));

    // Delete the account's own pill: only the shared skill stays selected.
    await deletePill(OWN.id);
    await waitFor(() => expect(pillIds()).toEqual([SHARED.id]));
    expect(await sentSkillIds(onSend)).toEqual([SHARED.id]);
  });

  it('restores a refreshed draft to the saved skill id, not the first same-name entry', async () => {
    window.localStorage.setItem(KEY, '@brand-voice tighten the copy');
    saveComposerDraftExtras(KEY, { attachments: [], commentAttachments: [], quotes: [],
      context: { skillIds: [SHARED.id], mcpServerIds: [], connectorIds: [], workspaceItems: [] } });
    const { onSend } = renderComposer({ draftStorageKey: KEY });
    await flushMounts();
    await waitFor(() => expect(screen.getByTestId('staged-contexts').textContent).toContain('brand-voice'));
    // The user keeps typing; the restored selection must survive the edit.
    await appendInComposer(' please');
    expect(await sentSkillIds(onSend)).toEqual([SHARED.id]);
  });

  it('restores a queued draft with its pill bound to the queued skill id', async () => {
    const { ref, onSend } = renderComposer();
    await flushMounts();
    act(() => {
      ref.current!.restoreDraft({ text: '@brand-voice tighten the copy',
        meta: { skillIds: [SHARED.id], context: { skillIds: [SHARED.id], mcpServerIds: [], connectorIds: [], workspaceItems: [] } } });
    });
    await act(async () => { await Promise.resolve(); });
    await waitFor(() => expect(pillIds()).toEqual([SHARED.id]));
    expect(await sentSkillIds(onSend)).toEqual([SHARED.id]);
  });
});
