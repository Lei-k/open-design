import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  type LexicalEditor,
} from 'lexical';
import { $createMentionNode } from './MentionNode';
import { buildInlineMentionParts, type InlineMentionEntity } from '../../utils/inlineMentions';

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
      lines.forEach((line, i) => {
        if (i > 0) p.append($createLineBreakNode());
        if (!line) return;
        const parts = buildInlineMentionParts(line, entities, { highlightUnknown: false, prefer: claimable });
        if (!parts) {
          p.append($createTextNode(line));
          return;
        }
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
