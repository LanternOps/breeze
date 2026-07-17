// Single source of truth for the proposal/contract rich-text subset. The same
// list constrains the TipTap editor (apps/web RichTextEditor) and the PDF
// renderer (richTextPdf.ts) — change all three together or not at all.
import sanitizeHtml from 'sanitize-html';

export const RICH_TEXT_ALLOWED_TAGS = ['p', 'br', 'strong', 'em', 'u', 'h3', 'h4', 'ul', 'ol', 'li', 'a'] as const;

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

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [...RICH_TEXT_ALLOWED_TAGS],
  allowedAttributes: { a: ['href', 'rel', 'target'] },
  allowedSchemes: ALLOWED_SCHEMES,
  // A `//host/path` href navigates off-origin under the page's scheme; reject it
  // so a protocol-relative link can't smuggle a navigation past the http/https
  // scheme allowlist (hasAllowedScheme also strips its rel/target above).
  allowProtocolRelative: false,
  // Force safe rel/target on links that survive scheme filtering — but not on
  // an `<a>` whose href is disallowed (e.g. `javascript:`), which must come
  // out as a bare `<a>` with no attributes at all.
  transformTags: {
    a: (tagName, attribs) =>
      attribs.href && hasAllowedScheme(attribs.href)
        ? { tagName, attribs: { ...attribs, rel: 'noopener noreferrer', target: '_blank' } }
        : { tagName, attribs: {} },
  },
  disallowedTagsMode: 'discard',
};

/** Sanitize author/tenant HTML down to the proposal rich-text subset.
 * Applied at WRITE (store only clean content) and again at READ serialization
 * (defense in depth + covers rows written before this module existed). */
export function sanitizeRichTextHtml(html: string): string {
  return sanitizeHtml(html ?? '', OPTIONS);
}
