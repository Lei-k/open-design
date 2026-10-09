import {
  $getRoot,
  $isElementNode,
  $isLineBreakNode,
  $isParagraphNode,
  $isTextNode,
  type EditorState,
} from 'lexical';
import { $isMentionNode } from './MentionNode';
import type { InlineMentionEntity } from '../../utils/inlineMentions';

export interface SerializedComposer {
  text: string;
  /** Entities backed by an actual MentionNode currently in the tree. */
  present: InlineMentionEntity[];
  /**
   * `text` with every MentionNode replaced by one space. A pill already names
   * its entity by id; re-parsing its token text could only re-resolve it, and
   * for a token two entities share, to the wrong one.
   */
  plainText: string;
}

// Walk the tree by hand rather than calling `root.getTextContent()`, which
// joins block-level children with `\n\n`. The editor is constrained to a
// single paragraph (INSERT_PARAGRAPH is rewritten to a line break), so the
// outer block join is defensive only — when it does fire it uses a single
// `\n` so the wire format never grows a phantom blank line.
export function serializeComposer(state: EditorState): SerializedComposer {
  return state.read(() => {
    const present: InlineMentionEntity[] = [];
    const blocks: string[] = [];
    const plainBlocks: string[] = [];
    for (const block of $getRoot().getChildren()) {
      if (!$isParagraphNode(block)) {
        // Stray non-paragraph block (shouldn't happen): fall back to its text.
        blocks.push(block.getTextContent());
        plainBlocks.push(block.getTextContent());
        continue;
      }
      let line = '';
      let plain = '';
      for (const child of block.getChildren()) {
        if ($isMentionNode(child)) {
          line += child.getToken();
          plain += ' ';
          present.push(child.getEntity());
        } else if ($isLineBreakNode(child)) {
          line += '\n';
          plain += '\n';
        } else if ($isTextNode(child)) {
          line += child.getTextContent();
          plain += child.getTextContent();
        } else if ($isElementNode(child)) {
          line += child.getTextContent();
          plain += child.getTextContent();
        }
      }
      blocks.push(line);
      plainBlocks.push(plain);
    }
    return { text: blocks.join('\n'), present, plainText: plainBlocks.join('\n') };
  });
}
