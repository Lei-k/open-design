import { describe, expect, it } from 'vitest';

import { ambiguousMentionTokens, buildInlineMentionParts, type InlineMentionEntity } from '../../src/utils/inlineMentions';

describe('buildInlineMentionParts', () => {
  it('skips entity matching when plain text has no mention marker', () => {
    const entities: InlineMentionEntity[] = Array.from({ length: 1_000 }, (_, index) => ({
      id: `file-${index}`,
      kind: 'file',
      label: `file-${index}.html`,
      token: `@file-${index}.html`,
    }));

    expect(buildInlineMentionParts('typing ordinary Chinese text without mentions', entities)).toBeNull();
  });

  it('does not normalize entities on plain text drafts', () => {
    const entity = {
      id: 'index.html',
      kind: 'file',
      label: 'index.html',
      get token() {
        throw new Error('token should not be read for plain text');
      },
    } as InlineMentionEntity;

    expect(buildInlineMentionParts('plain text only', [entity])).toBeNull();
  });

  it('still highlights known mentions when the draft contains a marker', () => {
    const parts = buildInlineMentionParts('Review @index.html', [
      { id: 'index.html', kind: 'file', label: 'index.html' },
    ]);

    expect(parts).toEqual([
      { kind: 'text', text: 'Review ' },
      {
        kind: 'mention',
        text: '@index.html',
        entity: {
          id: 'index.html',
          kind: 'file',
          label: 'index.html',
          token: '@index.html',
        },
      },
    ]);
  });

  it('reuses the normalized mention index across draft updates', () => {
    let tokenReads = 0;
    const entities: InlineMentionEntity[] = Array.from({ length: 1_000 }, (_, index) => ({
      id: `file-${index}`,
      kind: 'file',
      label: `file-${index}.html`,
      get token() {
        tokenReads += 1;
        return `@file-${index}.html`;
      },
    }));

    expect(buildInlineMentionParts('@missing-one', entities)).toEqual([
      {
        kind: 'mention',
        text: '@missing-one',
        entity: {
          id: 'unknown:@missing-one',
          kind: 'unknown',
          label: 'missing-one',
          token: '@missing-one',
          title: '@missing-one',
        },
      },
    ]);
    expect(buildInlineMentionParts('@missing-two', entities)).toEqual([
      {
        kind: 'mention',
        text: '@missing-two',
        entity: {
          id: 'unknown:@missing-two',
          kind: 'unknown',
          label: 'missing-two',
          token: '@missing-two',
          title: '@missing-two',
        },
      },
    ]);
    expect(tokenReads).toBe(entities.length);
  });

  it('preserves longest known mentions that contain spaces', () => {
    const parts = buildInlineMentionParts('Open @docs/read me.md now', [
      { id: 'docs/read me.md', kind: 'file', label: 'docs/read me.md' },
    ]);

    expect(parts).toEqual([
      { kind: 'text', text: 'Open ' },
      {
        kind: 'mention',
        text: '@docs/read me.md',
        entity: {
          id: 'docs/read me.md',
          kind: 'file',
          label: 'docs/read me.md',
          token: '@docs/read me.md',
        },
      },
      { kind: 'text', text: ' now' },
    ]);
  });
});

// Team catalogs (S40): two accounts' skills may share a name. The token alone
// cannot say which one a plain `@name` means, so it never resolves to whichever
// entry happens to be listed first.
describe('ambiguous same-kind mention tokens', () => {
  const own: InlineMentionEntity = { id: 'studio-skill:own', kind: 'skill', label: 'brand-voice' };
  const shared: InlineMentionEntity = { id: 'studio-skill:shared', kind: 'skill', label: 'brand-voice' };
  const alias: InlineMentionEntity = { id: 'studio-skill:shared', kind: 'skill', label: 'studio-skill:shared' };

  it('does not resolve a token two ids of one kind share', () => {
    expect(buildInlineMentionParts('use @brand-voice now', [own, shared], { highlightUnknown: false })).toBeNull();
    expect(buildInlineMentionParts('use @brand-voice now', [shared, own], { highlightUnknown: false })).toBeNull();
    // An unambiguous id alias still resolves to its own entity.
    const parts = buildInlineMentionParts('use @studio-skill:shared', [own, shared, alias], { highlightUnknown: false });
    expect(parts?.find((part) => part.kind === 'mention')).toMatchObject({ entity: { id: 'studio-skill:shared' } });
  });

  it('reports ambiguous occurrences in order and resolves them from a preferred list', () => {
    const text = '@brand-voice and @brand-voice';
    expect(ambiguousMentionTokens(text, [own, shared])).toEqual([
      { kind: 'skill', token: '@brand-voice' }, { kind: 'skill', token: '@brand-voice' },
    ]);
    const parts = buildInlineMentionParts(text, [own, shared], { highlightUnknown: false, prefer: [shared, own] });
    expect(parts?.filter((part) => part.kind === 'mention').map((part) => part.kind === 'mention' && part.entity.id))
      .toEqual(['studio-skill:shared', 'studio-skill:own']);
    // One preferred entry claims one occurrence; the other stays plain text.
    const one = buildInlineMentionParts(text, [own, shared], { highlightUnknown: false, prefer: [shared] });
    expect(one?.filter((part) => part.kind === 'mention').map((part) => part.kind === 'mention' && part.entity.id)).toEqual(['studio-skill:shared']);
  });

  it('keeps unambiguous and cross-kind tokens on their existing first-entry rule', () => {
    expect(ambiguousMentionTokens('@brand-voice', [own])).toEqual([]);
    const plugin: InlineMentionEntity = { id: 'plugin-x', kind: 'plugin', label: 'Notion' };
    const connector: InlineMentionEntity = { id: 'connector-x', kind: 'connector', label: 'Notion' };
    expect(ambiguousMentionTokens('@Notion', [plugin, connector])).toEqual([]);
    expect(buildInlineMentionParts('@Notion', [plugin, connector], { highlightUnknown: false })?.[0])
      .toMatchObject({ kind: 'mention', entity: { id: 'plugin-x' } });
  });
});
