import sanitizeHtml from 'sanitize-html';

// Shared HTML-to-text flattening for inbound mail (Microsoft Graph and Gmail).

/**
 * Upper bound on the plain text derived from an HTML body. Matches the ticket
 * description / comment content limit enforced by the shared validators
 * (`packages/shared/src/validators/tickets.ts`, `max(50_000)`), so an enormous
 * HTML mail can't write a larger description than the API would ever accept.
 */
export const MAX_HTML_DERIVED_TEXT_LENGTH = 50_000;

/**
 * Cap on the raw HTML handed to the parser. sanitize-html is super-linear on
 * deeply nested unclosed tags (a 560K-char `<span>a` × N body took ~2.7 s), and
 * this runs inline in the shared mailbox poll worker on sender-controlled
 * input. 1M chars is ~20× the text clamp — ordinary (even Word-bloated) mail
 * is far below it; only the tail of a pathological body is lost.
 */
export const MAX_HTML_INPUT_LENGTH = 1_000_000;

// The only tags kept through sanitize-html: the ones whose boundaries carry
// layout. Everything else is dropped (its text kept); script/style/head/title
// contents are dropped entirely.
const BREAK_TAGS = [
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'ul', 'ol', 'table', 'pre', 'hr',
  'br', 'div', 'li', 'tr', 'td', 'th',
];
const NON_TEXT_TAGS = ['style', 'script', 'textarea', 'option', 'noscript', 'head', 'title'];
// Applied to sanitize-html OUTPUT, where every tag is bare (no attributes) and
// every literal `<` in text is escaped — so these match real tags only and
// cannot backtrack across attacker-shaped markup.
const PARAGRAPH_TAG_RE = /<\/?(?:p|h[1-6]|blockquote|ul|ol|table|pre)>|<hr ?\/?>/g;
const LINE_TAG_RE = /<br ?\/?>|<\/?(?:div|li|tr)>/g;
const CELL_TAG_RE = /<\/?t[dh]>/g;
const PARA = '\u0002';
const LINE = '\u0001';
const BREAK_RUN_RE = /[ \u0001\u0002]*[\u0001\u0002][ \u0001\u0002]*/g;

/**
 * Convert an HTML email body to plain text for the ticket pipeline (#6687).
 *
 * 1. sanitize-html keeps only the layout tags above (bare), decoding entities
 *    in text and re-escaping only `&`, `<`, `>`.
 * 2. Any U+0001/U+0002 now present is sender text (e.g. `&#2;`) — removed
 *    before those code points are used as break markers, so they stay
 *    unambiguous. Source whitespace is collapsed (not significant in HTML).
 * 3. Layout tags become markers (table cells a space); then entities decode.
 * 4. A run of adjacent markers collapses to one break — a blank line if any
 *    paragraph-level tag is in the run, else one newline — so `</div><div>`
 *    and `</li><li>` don't double-space.
 */
export function htmlToText(html: string): string {
  const sanitized = sanitizeHtml(html.slice(0, MAX_HTML_INPUT_LENGTH), {
    allowedTags: BREAK_TAGS,
    allowedAttributes: {},
    nonTextTags: NON_TEXT_TAGS,
  });
  const text = sanitized
    .replace(/[\u0001\u0002]/g, '')
    .replace(/\s+/g, ' ')
    .replace(PARAGRAPH_TAG_RE, PARA)
    .replace(LINE_TAG_RE, LINE)
    .replace(CELL_TAG_RE, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/ /g, ' ')
    .replace(/ {2,}/g, ' ')
    .replace(BREAK_RUN_RE, (run) => (run.includes(PARA) ? '\n\n' : '\n'))
    .trim()
    .slice(0, MAX_HTML_DERIVED_TEXT_LENGTH);
  // Don't leave half a surrogate pair where the clamp cut.
  return text.replace(/[\uD800-\uDBFF]$/, '');
}
