import sanitizeHtml from 'sanitize-html';

// Shared HTML-to-text flattening: inbound mail (Microsoft Graph and Gmail), the
// partner email renderer's text part, and the ticket importer (#8313, spec
// 2026-10-19 §5.4, through services/ticketImport/importText.ts). With no
// options the output is the same, byte for byte, as before the options existed
// (htmlToText.defaults.test.ts pins that against a frozen copy).

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
 * is far below it; only the tail of a pathological body is lost. Imports keep
 * it too: their bodies are sender-controlled mail as well.
 */
export const MAX_HTML_INPUT_LENGTH = 1_000_000;

export interface HtmlToTextOptions {
  /** Output clamp. Default MAX_HTML_DERIVED_TEXT_LENGTH (50,000). */
  maxOutputChars?: number;
  /**
   * 'drop' (default): a link becomes its text. 'inline': "text <url>", or
   * "<url>" when the text is the url or empty. Only absolute http, https and
   * mailto urls are kept; any other link keeps its text and loses its url.
   */
  links?: 'drop' | 'inline';
  /**
   * 'flatten' (default): a blockquote is a paragraph. 'prefix': every quoted
   * line starts with "> " per nesting level ("> > " two deep).
   */
  quotes?: 'flatten' | 'prefix';
  /**
   * Default: images are dropped. Given, each `<img>` calls it with its raw
   * `src` and `alt` (entities decoded, '' when absent), in document order; a
   * returned string is placed inline as text, `null` or '' drops the image.
   */
  image?: (src: string, alt: string) => string | null;
  /**
   * Default: none, the output is clamped silently. Given, a body whose input
   * or output was cut ends with a blank line and this marker; the marker counts
   * toward maxOutputChars.
   */
  truncationMarker?: string;
  /**
   * Strip the C0 control characters other than tab, line feed and carriage
   * return (what services/ticketImport/importedTicket.ts refuses). Default
   * false: only U+0001/U+0002 are removed, as before; the rest are kept.
   */
  stripControlChars?: boolean;
}

export interface HtmlToTextResult {
  text: string;
  /** The HTML was longer than MAX_HTML_INPUT_LENGTH; its tail was not converted. */
  truncatedInput: boolean;
  /** The converted text was cut to fit maxOutputChars (with the marker's room, if any). */
  truncatedOutput: boolean;
}

// The only tags kept through sanitize-html: the ones whose boundaries carry
// layout. Everything else is dropped (its text kept); script/style/head/title
// contents are dropped entirely.
const BREAK_TAGS = [
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'ul', 'ol', 'table', 'pre', 'hr',
  'br', 'div', 'li', 'tr', 'td', 'th',
];
const NON_TEXT_TAGS = ['style', 'script', 'textarea', 'option', 'noscript', 'head', 'title'];
// The options before #8313, kept as one literal so the default path hands
// sanitize-html exactly what it always did.
const DEFAULT_SANITIZE: sanitizeHtml.IOptions = {
  allowedTags: BREAK_TAGS,
  allowedAttributes: {},
  nonTextTags: NON_TEXT_TAGS,
};
const LINK_SCHEMES = ['http', 'https', 'mailto'];
// Applied to sanitize-html OUTPUT, where every tag is bare (no attributes)
// except the import-mode `<a href="...">` and `<img alt="..." />`, every attribute
// value is entity-escaped (no raw `"`, `<`, `>`) and every literal `<` in text
// is escaped — so these match real tags only, none can run past its own tag,
// and none has a nested quantifier.
const PARAGRAPH_TAG_RE = /<\/?(?:p|h[1-6]|blockquote|ul|ol|table|pre)>|<hr ?\/?>/g;
const LINE_TAG_RE = /<br ?\/?>|<\/?(?:div|li|tr)>/g;
const CELL_TAG_RE = /<\/?t[dh]>/g;
const IMAGE_TAG_RE = /<img alt="([^"]*)" \/>|<img \/>/g;
// A link whose content is text only, then the other anchor shapes (content
// with layout tags, or a link that lost its url). `[^"]*` stops at the value's
// closing quote and `[^<]*` at the next tag, so each open tag is scanned once.
const ANCHOR_RE = /<a href="([^"]*)">([^<]*)<\/a>|<a href="([^"]*)">|<a>|<\/a>/g;
const LINK_URL_RE = /^(?:https?|mailto):\S/i;
const BLOCKQUOTE_OPEN_RE = /<blockquote>/g;
const BLOCKQUOTE_CLOSE_RE = /<\/blockquote>/g;
const LINE = '\u0001';
const PARA = '\u0002';
const QUOTE_OPEN = '\u0003';
const QUOTE_CLOSE = '\u0004';
const BREAK_RUN_RE = /[ \u0001\u0002]*[\u0001\u0002][ \u0001\u0002]*/g;
// The same run shape with the quote markers; used only with quotes: 'prefix'.
const QUOTE_RUN_RE = /[ \u0001-\u0004]*[\u0001-\u0004][ \u0001-\u0004]*/g;
// Sender text that would read as a marker, by mode. VT and FF are left to the
// whitespace collapse, which turns them into spaces.
const MARKER_CHARS_RE = /[\u0001\u0002]/g;
const QUOTE_MARKER_CHARS_RE = /[\u0001-\u0004]/g;
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000E-\u001F]/g;
const TRAILING_HIGH_SURROGATE_RE = /[\uD800-\uDBFF]$/;

/**
 * Convert an HTML email body to plain text for the ticket pipeline (#6687).
 *
 * 1. sanitize-html keeps only the layout tags above (bare), decoding entities
 *    in text and re-escaping only `&`, `<`, `>`. Import mode also keeps
 *    `<a href>` (http, https, mailto) and turns each `<img>` into
 *    `<img alt="resolver text" />`.
 * 2. Import mode: images and links become escaped text.
 * 3. Any U+0001/U+0002 now present is sender text (e.g. `&#2;`) — removed
 *    before those code points are used as break markers, so they stay
 *    unambiguous. Source whitespace is collapsed (not significant in HTML).
 * 4. Layout tags become markers (table cells a space); then entities decode.
 * 5. A run of adjacent markers collapses to one break — a blank line if any
 *    paragraph-level tag is in the run, else one newline — so `</div><div>`
 *    and `</li><li>` don't double-space. With quotes: 'prefix', blockquote
 *    boundaries are markers too and each line gets its "> " prefix.
 */
export function htmlToText(html: string, opts?: HtmlToTextOptions): string {
  return htmlToTextDetailed(html, opts).text;
}

/** htmlToText plus what was cut, for the importer's counters (spec §5.4). */
export function htmlToTextDetailed(html: string, opts: HtmlToTextOptions = {}): HtmlToTextResult {
  const maxOutputChars = opts.maxOutputChars ?? MAX_HTML_DERIVED_TEXT_LENGTH;
  if (!Number.isSafeInteger(maxOutputChars) || maxOutputChars < 1) {
    throw new RangeError(`maxOutputChars must be a positive integer, got ${maxOutputChars}`);
  }
  const inlineLinks = opts.links === 'inline';
  const prefixQuotes = opts.quotes === 'prefix';
  const truncatedInput = html.length > MAX_HTML_INPUT_LENGTH;

  let text = sanitizeHtml(html.slice(0, MAX_HTML_INPUT_LENGTH), sanitizeOptions(inlineLinks, opts.image));
  if (opts.image) text = text.replace(IMAGE_TAG_RE, (_tag, alt?: string) => (alt ? ` ${alt.replace(/&quot;/g, '"')} ` : ''));
  if (inlineLinks) text = renderLinks(text);
  text = text
    .replace(opts.stripControlChars ? CONTROL_CHARS_RE : prefixQuotes ? QUOTE_MARKER_CHARS_RE : MARKER_CHARS_RE, '')
    .replace(/\s+/g, ' ');
  if (prefixQuotes) {
    text = text.replace(BLOCKQUOTE_OPEN_RE, PARA + QUOTE_OPEN).replace(BLOCKQUOTE_CLOSE_RE, QUOTE_CLOSE + PARA);
  }
  text = text
    .replace(PARAGRAPH_TAG_RE, PARA)
    .replace(LINE_TAG_RE, LINE)
    .replace(CELL_TAG_RE, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\u00a0/g, ' ')
    .replace(/ {2,}/g, ' ');
  text = prefixQuotes
    ? renderQuotedBreaks(text, maxOutputChars)
    : text.replace(BREAK_RUN_RE, (run) => (run.includes(PARA) ? '\n\n' : '\n')).trim();

  if (opts.truncationMarker === undefined) {
    return { text: cutText(text, maxOutputChars), truncatedInput, truncatedOutput: text.length > maxOutputChars };
  }
  const clamped = clampWithMarker(text, maxOutputChars, opts.truncationMarker, truncatedInput);
  return { text: clamped.text, truncatedInput, truncatedOutput: clamped.truncated };
}

/**
 * `text` cut to at most `maxChars`, never through a surrogate pair: a high
 * surrogate left last is dropped (also when nothing was cut, as before).
 */
export function cutText(text: string, maxChars: number): string {
  return text.slice(0, maxChars).replace(TRAILING_HIGH_SURROGATE_RE, '');
}

/**
 * Clamp with a visible marker. A text longer than `maxChars`, or one whose
 * source was already cut (`sourceCut`), ends with a blank line and the marker;
 * the marker counts toward `maxChars`, so the result never exceeds it. When
 * the marker cannot fit at all, the text is cut without it. `truncated` says
 * whether any of `text` was removed.
 */
export function clampWithMarker(
  text: string,
  maxChars: number,
  marker: string,
  sourceCut = false,
): { text: string; truncated: boolean } {
  if (!sourceCut && text.length <= maxChars) return { text, truncated: false };
  const suffix = `\n\n${marker}`;
  if (!marker || suffix.length > maxChars) {
    return { text: cutText(text, maxChars), truncated: text.length > maxChars };
  }
  const room = maxChars - suffix.length;
  const truncated = text.length > room;
  const kept = (truncated ? cutText(text, room) : text).trimEnd();
  return { text: kept ? `${kept}${suffix}` : marker, truncated };
}

function sanitizeOptions(inlineLinks: boolean, image: HtmlToTextOptions['image']): sanitizeHtml.IOptions {
  if (!inlineLinks && !image) return DEFAULT_SANITIZE;
  const allowedTags = [...BREAK_TAGS];
  const allowedAttributes: Record<string, string[]> = {};
  const options: sanitizeHtml.IOptions = { allowedTags, allowedAttributes, nonTextTags: NON_TEXT_TAGS };
  if (inlineLinks) {
    allowedTags.push('a');
    allowedAttributes.a = ['href'];
    // A href with any other scheme, or protocol-relative, loses the attribute
    // here; renderLinks then also requires an absolute url.
    options.allowedSchemes = LINK_SCHEMES;
    options.allowProtocolRelative = false;
  }
  if (image) {
    allowedTags.push('img');
    allowedAttributes.img = ['alt'];
    // The resolver sees the raw src (before any scheme filtering: `cid:` and
    // relative urls are what an importer resolves) and its answer rides in
    // `alt`, which sanitize-html escapes like any attribute value.
    options.transformTags = {
      img: (_tag, attribs) => {
        const text = image(attribs.src ?? '', attribs.alt ?? '');
        const kept: sanitizeHtml.Attributes = text ? { alt: text } : {};
        return { tagName: 'img', attribs: kept };
      },
    };
  }
  return options;
}

// Entity-escaped sanitize-html text <-> plain text, for the pieces renderLinks
// reads and writes back (attribute values also escape `"`).
function decodeEscaped(value: string): string {
  return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}
function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The href to show, or null: absolute http, https and mailto only. */
function linkUrl(escapedHref: string): string | null {
  const url = decodeEscaped(escapedHref).trim();
  return LINK_URL_RE.test(url) ? url : null;
}

/**
 * Links (links: 'inline') become escaped text, still inside sanitize-html
 * output: "text <url>", "<url>" when the text is the url or empty, the text
 * alone when the url was dropped. A link whose content holds layout tags gets
 * " <url> " after that content. Anchors never nest (htmlparser2 closes an open
 * `<a>` at the next one), but the stack keeps a nested shape correct anyway.
 */
function renderLinks(sanitized: string): string {
  const open: Array<string | null> = [];
  return sanitized.replace(ANCHOR_RE, (tag: string, simpleHref?: string, simpleText?: string, openHref?: string) => {
    if (simpleHref !== undefined && simpleText !== undefined) {
      const url = linkUrl(simpleHref);
      if (!url) return simpleText;
      const bracketed = `&lt;${escapeText(url)}&gt;`;
      const shown = decodeEscaped(simpleText).replace(/\s+/g, ' ').trim();
      if (shown === '') return `${simpleText}${bracketed}`;
      if (shown !== url) return `${simpleText} ${bracketed}`;
      const lead = simpleText.length - simpleText.trimStart().length;
      const trail = simpleText.length - simpleText.trimEnd().length;
      return `${simpleText.slice(0, lead)}${bracketed}${simpleText.slice(simpleText.length - trail)}`;
    }
    if (openHref !== undefined) {
      open.push(linkUrl(openHref));
      return '';
    }
    if (tag === '<a>') {
      open.push(null);
      return '';
    }
    const url = open.pop();
    return url ? ` &lt;${escapeText(url)}&gt; ` : '';
  });
}

/**
 * The break step for quotes: 'prefix'. `text` is content separated by runs of
 * markers; each run is one break (a blank line when it holds a paragraph or
 * quote boundary) and moves the quote depth. Every line is prefixed with "> "
 * per level; a blank line takes the shallowest depth its run passed through,
 * so the line between a quote and the text after it is not quoted. Stops once
 * the output passes `budget`: the caller clamps anyway, and deep nesting
 * would otherwise cost depth × lines.
 */
function renderQuotedBreaks(text: string, budget: number): string {
  const runs = new RegExp(QUOTE_RUN_RE.source, 'g');
  let out = '';
  let depth = 0;
  let pos = 0;
  let paragraph = false;
  let blankDepth = 0;
  const emit = (content: string) => {
    if (!content) return;
    if (out) out += paragraph ? `\n${'> '.repeat(blankDepth).trimEnd()}\n` : '\n';
    out += '> '.repeat(depth) + content;
  };
  for (let run = runs.exec(text); run !== null && out.length <= budget; run = runs.exec(text)) {
    emit(text.slice(pos, run.index).trim());
    paragraph = false;
    blankDepth = depth;
    for (const marker of run[0]) {
      if (marker === QUOTE_OPEN) depth += 1;
      else if (marker === QUOTE_CLOSE) depth = Math.max(0, depth - 1);
      if (marker !== LINE && marker !== ' ') paragraph = true;
      blankDepth = Math.min(blankDepth, depth);
    }
    pos = runs.lastIndex;
  }
  if (out.length <= budget) emit(text.slice(pos).trim());
  return out;
}
