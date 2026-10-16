/**
 * #8605: length caps for an invoice line description sent to an accounting
 * provider. Both QuickBooks (SalesItemLine `Description`, "Max 4000 chars")
 * and Xero (line item `Description`, 4000) cap the text. Neither documents
 * whether it counts UTF-16 units or code points, so the cap is applied in
 * UTF-16 units: a string within N units is within N code points too. A cut
 * never ends on the high half of a surrogate pair.
 */

/** The first `max` UTF-16 units of `text`, one fewer if that would split a surrogate pair. */
export function sliceUtf16(text: string, max: number): string {
  if (max <= 0) return '';
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? max - 1 : max;
  return text.slice(0, end);
}

/**
 * `text` within `max` UTF-16 units. When it is too long, the text before
 * `keep` (which must be the end of `text`) is truncated so `keep` survives
 * whole. If `keep` alone exceeds the cap (unreachable for the disclosure and
 * date suffixes, which are tens of characters), the whole text is cut instead.
 */
export function capWithSuffix(text: string, keep: string, max: number): string {
  if (text.length <= max) return text;
  if (!keep || !text.endsWith(keep) || keep.length >= max) return sliceUtf16(text, max);
  return `${sliceUtf16(text.slice(0, text.length - keep.length), max - keep.length)}${keep}`;
}
