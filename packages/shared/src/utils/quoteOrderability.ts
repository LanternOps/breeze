/**
 * Which quote lines belong in the parts order ("To be ordered") — the single
 * rule shared by the quote Detail tab, the draft editor hints, the send-flow
 * warning and the orders dashboard (#8232, #8233).
 *
 * Rule (product decision, #8232): a line is orderable ONLY when it carries a
 * distributor identifier — a SKU or a manufacturer part number. A free-text
 * description is never enough to order from, so a hardware line without an
 * identifier stays out of the order on purpose. The editor and send flow make
 * that visible instead of letting the line drop silently.
 */

/** The fields this rule reads. Kept structural so both the web `QuoteLine` and
 *  API/DB row shapes satisfy it without a mapping step. */
export interface QuoteOrderabilityLine {
  sku?: string | null;
  partNumber?: string | null;
  /** Catalog item type snapshotted at add-time; null/undefined = manual line. */
  itemType?: string | null;
  unitCost?: string | number | null;
}

function present(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

/** True when the line has a SKU or part number, so it can go on a parts order. */
export function isOrderableQuoteLine(line: QuoteOrderabilityLine): boolean {
  return present(line.sku) || present(line.partNumber);
}

/**
 * True when the line looks like something you buy rather than labor: a
 * hardware or software catalog line, or any non-service line carrying a unit
 * cost (a manual line with a cost is almost always a product). Any cost value
 * counts, including zero; a blank string does not.
 */
export function isProductLikeQuoteLine(line: QuoteOrderabilityLine): boolean {
  if (line.itemType === 'hardware' || line.itemType === 'software') return true;
  if (line.itemType === 'service') return false;
  const cost = line.unitCost;
  if (cost === null || cost === undefined) return false;
  return typeof cost === 'number' ? Number.isFinite(cost) : cost.trim() !== '';
}

/** A product-like line that will be left out of the parts order because it has
 *  no SKU or part number. This is what the editor, send flow and order
 *  breakdown warn about. */
export function isUnorderableProductLine(line: QuoteOrderabilityLine): boolean {
  return isProductLikeQuoteLine(line) && !isOrderableQuoteLine(line);
}
