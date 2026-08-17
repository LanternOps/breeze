// Single source of truth for the proposal/contract rich-text subset. The same
// list constrains the TipTap editor (apps/web RichTextEditor) and the PDF
// renderer (richTextPdf.ts) — change all three together or not at all.
// Browser rendering of the subset lives in apps/web (Tailwind `prose`) and
// apps/portal (`.quote-rich-text` rules in its globals.css); both need styling
// for any structural tag added here.
import sanitizeHtml from 'sanitize-html';

const RICH_TEXT_FLOW_TAGS = ['p', 'br', 'strong', 'em', 'u', 'h3', 'h4', 'ul', 'ol', 'li', 'a'] as const;

/** Table structure permitted inside a `rich_text` body (issue #3484). Authors
 *  paste real tables out of Word/Google Docs/external proposals, and before
 *  this the whole grid collapsed into run-together text.
 *
 *  NO attributes are allowed on any of these — in particular `colspan` and
 *  `rowspan` are dropped, so a merged Word cell lands in a single column
 *  rather than spanning. Every cell's text still survives; only the merge is
 *  lost. Spanning would have to be honoured by all three renderers (browser,
 *  PDF grid, TipTap) to be worth allowing, and `rowspan` in particular has no
 *  sane representation in the PDF row-at-a-time renderer. */
export const RICH_TEXT_TABLE_TAGS = ['table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td'] as const;

export const RICH_TEXT_ALLOWED_TAGS: readonly string[] = [...RICH_TEXT_FLOW_TAGS, ...RICH_TEXT_TABLE_TAGS];

/** Inline-only marks for table cells / column labels: no block-level structure
 *  by design (Spec A decision #4). Shares the hardened link rules below. */
export const INLINE_RICH_TEXT_ALLOWED_TAGS = ['strong', 'em', 'u', 'a', 'br'] as const;

const ALLOWED_SCHEMES = ['http', 'https'];

// sanitize-html runs transformTags in onopentag, *before* its own scheme
// filter (naughtyHref) runs later on the attribute value — so a `javascript:`
// href is still present when this transform sees it. Check the scheme
// ourselves so we don't force rel/target onto a link we're about to strip.
function hasAllowedScheme(href: string): boolean {
  const trimmed = href.trim();
  // Protocol-relative (`//evil.example`) has no scheme but still navigates
  // off-origin under the page's own scheme — treat it as disallowed (paired
  // with allowProtocolRelative: false below, which strips the attribute).
  if (trimmed.startsWith('//')) return false;
  const scheme = trimmed.match(/^([a-z][a-z0-9+.-]*):/i)?.[1];
  if (!scheme) return true; // no scheme (relative URL) — let allowedSchemes/naughtyHref decide
  return ALLOWED_SCHEMES.includes(scheme.toLowerCase());
}

// Force safe rel/target on links that survive scheme filtering — but not on
// an `<a>` whose href is disallowed (e.g. `javascript:`), which must come out
// as a bare `<a>` with no attributes at all. Shared by both the block-level
// and inline-only sanitize profiles below.
const enforceSafeAnchor: sanitizeHtml.Transformer = (tagName, attribs) =>
  attribs.href && hasAllowedScheme(attribs.href)
    ? { tagName, attribs: { ...attribs, rel: 'noopener noreferrer', target: '_blank' } }
    : { tagName, attribs: {} };

// A `//host/path` href navigates off-origin under the page's scheme; reject it
// so a protocol-relative link can't smuggle a navigation past the http/https
// scheme allowlist (hasAllowedScheme also strips its rel/target above). Shared
// by both profiles.
const LINK_OPTIONS: Pick<sanitizeHtml.IOptions, 'allowedAttributes' | 'allowedSchemes' | 'allowProtocolRelative' | 'transformTags' | 'disallowedTagsMode'> = {
  allowedAttributes: { a: ['href', 'rel', 'target'] },
  allowedSchemes: ALLOWED_SCHEMES,
  allowProtocolRelative: false,
  transformTags: { a: enforceSafeAnchor },
  disallowedTagsMode: 'discard',
};

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [...RICH_TEXT_ALLOWED_TAGS],
  ...LINK_OPTIONS,
};

const INLINE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [...INLINE_RICH_TEXT_ALLOWED_TAGS],
  ...LINK_OPTIONS,
};

const PLAIN_TEXT_OPTIONS: sanitizeHtml.IOptions = { allowedTags: [], allowedAttributes: {} };

// ---------------------------------------------------------------------------
// Table cells are inline-only (issue #3484)
//
// sanitize-html's allowedTags is FLAT — it has no notion of "allowed, but not
// inside a <td>". Left at that, a `rich_text` body could carry a <p>/<ul>/
// nested <table> inside a cell, which the browser renders natively but the PDF
// grid (fixed-height, single wrapped run sequence per cell) cannot. Rather
// than let the three renderers drift, cell CONTENT keeps the same inline-only
// contract the structured `table` block already has (Spec A decision #4): the
// pass below re-sanitizes every <td>/<th> body through the inline profile.
//
// Block boundaries inside a cell become <br /> instead of vanishing, so
// Word's `<td><p>a</p><p>b</p></td>` reads "a / b" rather than "ab", and a
// nested table's cells flatten to one line each. The tags it removes are
// merged into the *WithReport payload (#3520), so the author is still told.
//
// The scan runs on sanitize-html OUTPUT, which is balanced and attribute-free
// on these tags, and everything it re-emits is either a literal <td>/<th>
// delimiter copied from that output or the result of another sanitize-html
// pass — so it cannot reintroduce markup the sanitizer just removed.
// ---------------------------------------------------------------------------

/** Block-level tag boundaries inside a cell — each becomes a line break before
 *  the inline profile discards the tag itself. Both edges are matched (not just
 *  the closing one) so text sitting BEFORE a nested block still separates from
 *  it; collapseBreaks then folds the runs of `<br />` this produces. */
const CELL_BLOCK_BOUNDARY_RE = /<(\/?)(p|div|h[1-6]|li|ul|ol|tr|thead|tbody|tfoot|table|td|th)(?:\s[^>]*)?\/?>/gi;

/** Matches a `<td>`/`<th>` open or close tag in sanitize-html's own output. */
const CELL_TAG_RE = /<(\/?)(?:td|th)(?:\s[^>]*)?>/gi;

/** Line-break token as sanitize-html emits it. */
const BREAK = '<br />';
/** Single break tag — deliberately NOT a repeated group. A `(?:<br…>\s*){2,}`
 *  form reads more directly but trips CodeQL's ReDoS rule (js/redos), so the
 *  runs are collapsed by splitting on ONE break and rejoining, which is linear
 *  in the input by construction. */
const SINGLE_BREAK_RE = /<br\s*\/?>/i;

/** Drop the empty segments that a run of `<br />` (or a leading/trailing one)
 *  produces, so `<p>a</p><p>b</p>` reads "a / b" and not "/ a // b /". */
function collapseBreaks(html: string): string {
  return html
    .split(SINGLE_BREAK_RE)
    .filter((segment) => segment.trim().length > 0)
    .join(BREAK);
}

function normalizeCellBody(inner: string, removed?: Set<string>): string {
  // The rewrite consumes these tags before sanitize-html can observe them, so
  // record them here — otherwise the cell pass would strip block structure
  // silently, which is exactly the defect #3520 fixed.
  const withBreaks = inner.replace(CELL_BLOCK_BOUNDARY_RE, (_whole, closing: string, tag: string) => {
    if (removed && !closing) removed.add(tag.toLowerCase());
    return BREAK;
  });
  if (!removed) return collapseBreaks(sanitizeInlineRichText(withBreaks));
  const report = sanitizeInlineRichTextWithReport(withBreaks);
  for (const tag of report.removedTags) removed.add(tag);
  return collapseBreaks(report.html);
}

/**
 * Re-sanitize each outermost `<td>`/`<th>` body down to the inline profile.
 * Idempotent (the read path re-runs it on already-normalized rows) and a no-op
 * on HTML with no cells at all.
 */
function normalizeTableCells(html: string, removed?: Set<string>): string {
  if (!html.includes('<td') && !html.includes('<th')) return html;
  let out = '';
  let copiedTo = 0;
  let innerStart = 0;
  let depth = 0;
  CELL_TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CELL_TAG_RE.exec(html))) {
    if (match[1] !== '/') {
      // Only the OUTERMOST cell is rewritten; cells of a nested table are part
      // of that body and get flattened by the inline pass along with it.
      if (depth === 0) {
        out += html.slice(copiedTo, CELL_TAG_RE.lastIndex);
        innerStart = CELL_TAG_RE.lastIndex;
      }
      depth += 1;
      continue;
    }
    if (depth === 0) continue; // stray `</td>` with no open tag — copy verbatim
    depth -= 1;
    if (depth === 0) {
      out += normalizeCellBody(html.slice(innerStart, match.index), removed);
      copiedTo = match.index; // resume at the closing tag, keeping it as-is
    }
  }
  // An unclosed final cell leaves copiedTo before its body, so the tail below
  // still copies the original bytes rather than dropping them.
  return out + html.slice(copiedTo);
}

// ---------------------------------------------------------------------------
// Loss reporting (issue #3520)
//
// sanitize-html discards out-of-subset tags by design and says nothing about
// it, so a write that submits <table>/<blockquote>/<h1> used to 200 with the
// content quietly gone. The *-WithReport variants below run the SAME single
// sanitize pass and additionally report which tag names the parser saw but the
// profile does not allow, so a write path can tell the author what it dropped.
//
// Detection uses sanitize-html's public `onOpenTag` observer, which fires on
// the source tag before transformTags and before the allowedTags filter — so
// it sees discarded tags too. It is deliberately NOT a wildcard `transformTags`
// entry: that would couple production sanitisation to transform ordering.
// The collector Set is created per call; never hoist it into module-level
// options, which are shared by the read/render paths.
// ---------------------------------------------------------------------------

/** A rich-text field's sanitized value plus what sanitisation removed. */
export interface RichTextSanitizeReport {
  /** The sanitized HTML — byte-identical to the non-reporting variant. */
  html: string;
  /**
   * Lowercased, de-duplicated, sorted tag names that were present in the input
   * and discarded because the profile does not allow them.
   *
   * TAG removal only. Attribute stripping (`style`, `class`, `id`) and rejected
   * `href` schemes (`javascript:`, protocol-relative) are NOT reported here —
   * those are hostile/no-content-loss cases, and naming them would turn every
   * pasted-from-Word save into a scary warning.
   */
  removedTags: string[];
}

/** Warning payload returned to API clients when a write lost markup. */
export const RICH_TEXT_STRIP_WARNING_CODE = 'UNSUPPORTED_HTML_TAGS_REMOVED';

export interface RichTextStripWarning {
  code: typeof RICH_TEXT_STRIP_WARNING_CODE;
  /** Dotted path of the field within the written payload, e.g. `content.html`. */
  field: string;
  removedTags: string[];
}

/**
 * Build a warning for a field, or `null` when nothing was removed. Callers
 * collect these into the `warnings` array they hand back to the client.
 */
export function richTextStripWarning(field: string, report: RichTextSanitizeReport): RichTextStripWarning | null {
  return report.removedTags.length === 0
    ? null
    : { code: RICH_TEXT_STRIP_WARNING_CODE, field, removedTags: report.removedTags };
}

function sanitizeWithReport(
  input: string,
  options: sanitizeHtml.IOptions,
  allowedTags: readonly string[],
  normalizeCells = false,
): RichTextSanitizeReport {
  const allowed = new Set<string>(allowedTags);
  const removed = new Set<string>();
  const html = sanitizeHtml(input ?? '', {
    ...options,
    // htmlparser2 lowercases tag names, so `<TABLE>` arrives as `table`.
    onOpenTag: (name) => {
      if (!allowed.has(name)) removed.add(name);
    },
  });
  // The cell pass removes tags the OUTER profile allows (a <p> or a nested
  // <table> is fine in the body, not in a cell), so its own removals are
  // merged in here — otherwise those strips would be silent again.
  const normalized = normalizeCells ? normalizeTableCells(html, removed) : html;
  return { html: normalized, removedTags: [...removed].sort() };
}

/** Sanitize author/tenant HTML down to the proposal rich-text subset.
 * Applied at WRITE (store only clean content) and again at READ serialization
 * (defense in depth + covers rows written before this module existed). */
export function sanitizeRichTextHtml(html: string): string {
  return normalizeTableCells(sanitizeHtml(html ?? '', OPTIONS));
}

/** `sanitizeRichTextHtml` + a report of the tags it discarded. Use on WRITE
 * paths so the author is told what was dropped; the read/render paths keep
 * using the silent variant (a legacy row must still render, not warn). */
export function sanitizeRichTextHtmlWithReport(html: string): RichTextSanitizeReport {
  return sanitizeWithReport(html, OPTIONS, RICH_TEXT_ALLOWED_TAGS, true);
}

/** Sanitize author/tenant HTML down to inline marks only (no block structure) —
 * used for table cells and column labels, which render inside a fixed-layout
 * cell rather than the flowing document body (Spec A decision #4). Shares the
 * same hardened link rules as sanitizeRichTextHtml. */
export function sanitizeInlineRichText(html: string): string {
  return sanitizeHtml(html ?? '', INLINE_OPTIONS);
}

/** `sanitizeInlineRichText` + a report of the tags it discarded (WRITE paths). */
export function sanitizeInlineRichTextWithReport(html: string): RichTextSanitizeReport {
  return sanitizeWithReport(html, INLINE_OPTIONS, INLINE_RICH_TEXT_ALLOWED_TAGS);
}

/** Strip ALL markup — used for plain-text-only fields (table captions, callout
 * titles) where no HTML at all is allowed. */
export function sanitizePlainText(text: string): string {
  return sanitizeHtml(text ?? '', PLAIN_TEXT_OPTIONS);
}

/** `sanitizePlainText` + a report of the tags it discarded (WRITE paths).
 * Every tag is disallowed in this profile, so any markup at all is reported. */
export function sanitizePlainTextWithReport(text: string): RichTextSanitizeReport {
  return sanitizeWithReport(text, PLAIN_TEXT_OPTIONS, []);
}
