// Labels for the quote editor's rail "Contents" outline (#9867). A long
// proposal used to list "Rich text", "Image" and "Table" several times each,
// which did not help navigation. Each entry now prefers the author's own words:
// the block's label/caption/title, else the first words of its text, else the
// block-type name qualified by the nearest heading above it.
import type { QuoteBlock } from './quoteTypes';

/** Max characters of a text excerpt before it is cut at a word and ellipsized.
 *  The outline entry also truncates visually; this keeps the accessible name short. */
export const OUTLINE_EXCERPT_MAX = 40;

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Plain-text excerpt of stored (sanitized) block HTML. DOMParser builds an
 *  inert document — no scripts run and no images load — so this is safe on
 *  author content. Falls back to tag stripping where DOMParser is absent. */
export function htmlExcerpt(html: string, max = OUTLINE_EXCERPT_MAX): string {
  if (!html) return '';
  let text: string;
  if (typeof DOMParser !== 'undefined') {
    // Block-level tags carry no whitespace of their own: "<p>A</p><p>B</p>"
    // would read "AB". Pad tag boundaries before taking textContent.
    const spaced = html.replace(/</g, ' <');
    text = new DOMParser().parseFromString(spaced, 'text/html').body.textContent ?? '';
  } else {
    text = html.replace(/<[^>]*>/g, ' ');
  }
  return textExcerpt(text, max);
}

/** Collapse whitespace and cut plain text at a word boundary, ellipsized. */
export function textExcerpt(text: string, max = OUTLINE_EXCERPT_MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** The author's own words for a block, or '' when it has none. Pricing,
 *  heading and contract blocks are labelled by the editor itself. */
export function blockContentLabel(block: QuoteBlock): string {
  const c = (block.content ?? {}) as Record<string, unknown>;
  switch (block.blockType) {
    case 'rich_text':
      return htmlExcerpt(str(c.html));
    case 'image':
      return textExcerpt(str(c.caption));
    case 'table':
      return htmlExcerpt(str(c.caption));
    case 'callout':
      return textExcerpt(str(c.title)) || htmlExcerpt(str(c.html));
    default:
      return '';
  }
}

/** Text of the closest heading block before `index` in document order, or ''. */
export function nearestHeadingAbove(sortedBlocks: QuoteBlock[], index: number): string {
  for (let i = index - 1; i >= 0; i -= 1) {
    const b = sortedBlocks[i];
    if (b?.blockType === 'heading') {
      const text = textExcerpt(str((b.content as Record<string, unknown> | null)?.text));
      if (text) return text;
    }
  }
  return '';
}
