import { createHash } from 'node:crypto';

type HashableQuote = {
  id: string; currencyCode: string;
  subtotal: string; taxTotal: string; total: string;
  oneTimeTotal: string; monthlyRecurringTotal: string; annualRecurringTotal: string;
};
type HashableBlock = { id: string; blockType: string; content: unknown; sortOrder: number };
type HashableLine = {
  id: string; description: string; quantity: string; unitPrice: string; lineTotal: string;
  recurrence: string; taxable: boolean; customerVisible: boolean; sortOrder: number;
};

/**
 * Canonical, order-independent serialization of a quote's billable CONTENT,
 * hashed with SHA-256. Captured at accept time and stored on
 * quote_acceptances.quote_sha256 so a later edit (or a forged re-render) can be
 * detected. Sorting by (sortOrder, id) makes the hash independent of the array
 * order the caller happens to pass while staying sensitive to any value change.
 *
 * Deliberately EXCLUDES volatile workflow fields (status, quote number): the
 * quote legitimately transitions sent→converted during accept, so folding
 * `status` in would make a future re-verification of the now-'converted' quote
 * false-positive on tampering (C4). Only content that must stay immutable for
 * the signature to mean anything (money, lines, blocks, currency) is hashed.
 */
export function computeQuoteSha256(
  quote: HashableQuote,
  blocks: HashableBlock[],
  lines: HashableLine[]
): string {
  const canonical = {
    quote: {
      id: quote.id, currency: quote.currencyCode,
      subtotal: quote.subtotal, taxTotal: quote.taxTotal, total: quote.total,
      oneTime: quote.oneTimeTotal, monthly: quote.monthlyRecurringTotal, annual: quote.annualRecurringTotal,
    },
    blocks: [...blocks]
      .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))
      .map((b) => ({ id: b.id, type: b.blockType, sortOrder: b.sortOrder, content: b.content })),
    lines: [...lines]
      .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))
      .map((l) => ({
        id: l.id, description: l.description, quantity: l.quantity, unitPrice: l.unitPrice,
        lineTotal: l.lineTotal, recurrence: l.recurrence, taxable: l.taxable,
        customerVisible: l.customerVisible, sortOrder: l.sortOrder,
      })),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
