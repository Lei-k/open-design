import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  type LexicalEditor,
} from 'lexical';
import { $createMentionNode } from './MentionNode';
import { buildInlineMentionParts, type InlineMentionEntity, type InlineMentionOccurrence, type InlineMentionPart } from '../../utils/inlineMentions';

// Rebuild the whole editor from a plain `@token` string. Known `@token`
// runs (matched against `entities`) become atomic MentionNodes; everything
// else is plain text. Newlines map to LineBreakNodes inside a single
// paragraph so serialization round-trips to single `\n`. Caret is placed at
// the end inside the same update so post-seed typing keeps the caret.
// A token two entities of one kind share (same-name skills from two accounts)
// becomes a pill only when `prefer` names which one; otherwise it stays text.
export function setComposerFromText(
  editor: LexicalEditor,
  text: string,
  entities: InlineMentionEntity[],
  prefer: readonly InlineMentionEntity[] = [],
  mentions: readonly InlineMentionOccurrence[] = [],
): void {
  // One pool for the whole draft, so each preferred entity claims one occurrence.
  const claimable = [...prefer];
  // `discrete: true` commits the update synchronously. This matters both for
  // tests reading the state back on the next line AND for the host's
  // setText/clear → onChange round-trip, where a deferred update could let a
  // stale serialize slip through before the rebuild lands. On a mounted editor
  // it behaves like a normal update (just flushed immediately).
  editor.update(
    () => {
      const root = $getRoot();
      root.clear();
      const p = $createParagraphNode();
      const lines = text.split('\n');
      let offset = 0;
      lines.forEach((line, i) => {
        if (i > 0) p.append($createLineBreakNode());
        const parts: InlineMentionPart[] = [];
        let cursor = 0;
        for (const mention of mentions) {
          const start = mention.start - offset; const end = mention.end - offset;
          if (start < cursor || end > line.length || end <= start || line.slice(start, end) !== mention.token) continue;
          const gap = line.slice(cursor, start);
          parts.push(...(buildInlineMentionParts(gap, entities, { highlightUnknown: false, prefer: claimable }) ?? [{ kind: 'text' as const, text: gap }]));
          parts.push({ kind: 'mention', entity: mention, text: mention.token! });
          cursor = end;
        }
        const tail = line.slice(cursor);
        parts.push(...(buildInlineMentionParts(tail, entities, { highlightUnknown: false, prefer: claimable }) ?? [{ kind: 'text' as const, text: tail }]));
        offset += line.length + 1;
        for (const part of parts) {
          const claimed = part.kind === 'mention' ? claimable.indexOf(part.entity) : -1;
          if (claimed !== -1) claimable.splice(claimed, 1);
        }
        for (const part of parts) {
          if (part.kind === 'mention' && part.entity.kind !== 'unknown') {
            p.append(
              $createMentionNode({
                mentionId: part.entity.id,
                mentionKind: part.entity.kind,
                token: part.text,
                label: part.entity.label,
                title: part.entity.title,
              }),
            );
          } else if (part.text) {
            p.append($createTextNode(part.text));
          }
        }
      });
      root.append(p);
      p.selectEnd();
    },
    { discrete: true },
  );
}
