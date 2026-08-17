// Single source of truth for the proposal/contract rich-text subset. The same
// list constrains the TipTap editor (apps/web RichTextEditor) and the PDF
// renderer (richTextPdf.ts) — change all three together or not at all.
import sanitizeHtml from 'sanitize-html';

export const RICH_TEXT_ALLOWED_TAGS = ['p', 'br', 'strong', 'em', 'u', 'h3', 'h4', 'ul', 'ol', 'li', 'a'] as const;

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
  return { html, removedTags: [...removed].sort() };
}

/** Sanitize author/tenant HTML down to the proposal rich-text subset.
 * Applied at WRITE (store only clean content) and again at READ serialization
 * (defense in depth + covers rows written before this module existed). */
export function sanitizeRichTextHtml(html: string): string {
  return sanitizeHtml(html ?? '', OPTIONS);
}

/** `sanitizeRichTextHtml` + a report of the tags it discarded. Use on WRITE
 * paths so the author is told what was dropped; the read/render paths keep
 * using the silent variant (a legacy row must still render, not warn). */
export function sanitizeRichTextHtmlWithReport(html: string): RichTextSanitizeReport {
  return sanitizeWithReport(html, OPTIONS, RICH_TEXT_ALLOWED_TAGS);
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
