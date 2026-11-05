/**
 * Source bodies to comment text for the ticket importer (#8313; spec
 * 2026-10-19 §5.4, the Zammad use in §6.5). A module calls one of these per
 * article body; both are pure (no I/O, no writes).
 *
 * - `htmlForImport`: a `text/html` body through the shared converter
 *   (inboundEmail/htmlToText.ts) with the import options fixed: links as
 *   "text <url>" (http, https, mailto only), blockquotes as "> " lines, the
 *   module's image resolver (inline images become placeholders, the rest are
 *   dropped), the C0 control characters importedTicket refuses stripped (F2),
 *   the 200,000-character ImportedComment limit, and the visible truncation
 *   marker. The 1,000,000-character input cap stays.
 * - `plainTextForImport`: a `text/plain` body skips the converter. Line endings
 *   become LF, the refused control characters are stripped, and the text is
 *   clamped the same way, with the same marker.
 *
 * Both report what was cut, for the run's counters.
 */
import { clampWithMarker, htmlToTextDetailed, type HtmlToTextResult } from '../inboundEmail/htmlToText';

/** `ImportedComment.content` and `ImportedTicket.description` (importedTicket.ts). */
export const IMPORT_TEXT_MAX_CHARS = 200_000;

export const IMPORT_TRUNCATION_MARKER = '[Truncated during import; the full message is in the source ticket.]';

/** What importedTicket's text rule refuses: C0 controls other than tab, LF and CR. */
const REFUSED_CONTROL_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

/**
 * Resolves one `<img>` (raw `src`, `alt`) to its inline text, e.g.
 * `[image: <filename>]`, or `null` to drop it (an external image).
 */
export type ImportImageResolver = (src: string, alt: string) => string | null;

export interface ImportTextOptions {
  /** Default IMPORT_TEXT_MAX_CHARS. */
  maxOutputChars?: number;
}

export function htmlForImport(
  html: string,
  opts: ImportTextOptions & { image?: ImportImageResolver } = {},
): HtmlToTextResult {
  return htmlToTextDetailed(html, {
    maxOutputChars: opts.maxOutputChars ?? IMPORT_TEXT_MAX_CHARS,
    links: 'inline',
    quotes: 'prefix',
    image: opts.image,
    truncationMarker: IMPORT_TRUNCATION_MARKER,
    stripControlChars: true,
  });
}

export function plainTextForImport(text: string, opts: ImportTextOptions = {}): { text: string; truncated: boolean } {
  const maxOutputChars = opts.maxOutputChars ?? IMPORT_TEXT_MAX_CHARS;
  if (!Number.isSafeInteger(maxOutputChars) || maxOutputChars < 1) {
    throw new RangeError(`maxOutputChars must be a positive integer, got ${maxOutputChars}`);
  }
  const normalized = text.replace(/\r\n?/g, '\n').replace(REFUSED_CONTROL_CHARS_RE, '');
  return clampWithMarker(normalized, maxOutputChars, IMPORT_TRUNCATION_MARKER);
}
