/**
 * Client side of the rich-text loss report (issue #3520).
 *
 * The API's rich-text subset is narrow (a fixed list of block, table and inline
 * tags — see richTextSanitize.ts), and sanitize-html discards anything outside
 * it. Block/version writes used to 200 with the extra markup quietly gone, so
 * an author who pasted a `<blockquote>` or an `<img>` only found out by
 * noticing their content missing later. (Tables themselves now survive —
 * issue #3484 — but block content inside a CELL is still flattened, and that
 * flattening is reported through this same channel.)
 *
 * Those write responses now carry a top-level `warnings` array naming what was
 * removed. This module turns that array into the tag list a toast can show;
 * the caller owns the copy and the toast so the wording stays localized.
 *
 * Wire format (apps/api/src/services/richTextSanitize.ts):
 *   { data: <resource>, warnings: [{ code, field, removedTags }] }
 */

export const RICH_TEXT_STRIP_WARNING_CODE = 'UNSUPPORTED_HTML_TAGS_REMOVED';

export interface RichTextStripWarning {
  code: string;
  /** Dotted path of the field the tags were removed from, e.g. `content.html`. */
  field: string;
  removedTags: string[];
}

function isStripWarning(value: unknown): value is RichTextStripWarning {
  if (!value || typeof value !== 'object') return false;
  const w = value as Record<string, unknown>;
  return w.code === RICH_TEXT_STRIP_WARNING_CODE && Array.isArray(w.removedTags);
}

/**
 * Every distinct tag the server removed from a write, across all fields of the
 * response, de-duplicated and sorted. Empty when nothing was lost — including
 * for older API builds that answer without a `warnings` key at all, so a
 * caller can wire this in unconditionally.
 */
export function strippedTagsFrom(body: unknown): string[] {
  if (!body || typeof body !== 'object') return [];
  const warnings = (body as Record<string, unknown>).warnings;
  if (!Array.isArray(warnings)) return [];
  const tags = new Set<string>();
  for (const warning of warnings) {
    if (!isStripWarning(warning)) continue;
    for (const tag of warning.removedTags) {
      if (typeof tag === 'string' && tag.length > 0) tags.add(tag);
    }
  }
  return [...tags].sort();
}
