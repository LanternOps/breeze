/**
 * Reading helpers for the long-form legal text on customer documents (a quote's
 * Terms & Conditions and its contract blocks), shared so the portal and the
 * staff Preview summarise an agreement identically.
 *
 * Line-based section detection for free-text Terms & Conditions. No markdown
 * dependency: a line that starts with a number ("1.", "2.1", "3)") or an
 * ALL-CAPS label ("CONFIDENTIALITY:") is a heading; everything else is body.
 */
const HEADING_RE = /^\s*(\d+(\.\d+)*[.)]?|[A-Z][A-Z &/-]{3,}:?)(\s|$)/;
/** A numbered line longer than this is a sentence, not a heading. */
const MAX_HEADING_CHARS = 100;

export type TermsBlock =
  | { kind: 'heading'; text: string; id: string }
  | { kind: 'para'; text: string };

export function parseTermsSections(text: string): { blocks: TermsBlock[]; sectionCount: number } {
  const blocks: TermsBlock[] = [];
  let sectionCount = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.length <= MAX_HEADING_CHARS && HEADING_RE.test(raw)) {
      sectionCount += 1;
      blocks.push({ kind: 'heading', text: line, id: `terms-section-${sectionCount}` });
    } else {
      blocks.push({ kind: 'para', text: line });
    }
  }
  return { blocks, sectionCount };
}

/** Reading time at 200 wpm, never below one minute. */
export function textReadMinutes(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(words / 200));
}

/** Reading time of sanitized rich-text HTML (a rendered contract template).
 *  Tags become spaces so `</p><p>` never glues two words into one. */
export function htmlReadMinutes(html: string): number {
  return textReadMinutes(html.replace(/<[^>]*>/g, ' '));
}
