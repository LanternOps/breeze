// Shared client-side types + helpers for the quote / proposal billing UI.
// Mirrors invoiceTypes.ts. Money fields arrive from the API as numeric(12,2)
// strings (e.g. '123.40'); tax rate is a numeric(6,3) FRACTION string ('0.07').

export type QuoteStatus =
  | 'draft' | 'sent' | 'viewed' | 'accepted' | 'declined' | 'expired' | 'converted';

export type QuoteLineRecurrence = 'one_time' | 'monthly' | 'annual';
export type QuoteLineSourceType = 'catalog' | 'bundle' | 'manual';
export type QuoteBlockType = 'heading' | 'rich_text' | 'image' | 'line_items';

/** A row from `GET /quotes` / the `quote` field of `GET /quotes/:id`. */
export interface Quote {
  id: string;
  quoteNumber: string | null;
  partnerId: string;
  orgId: string;
  siteId: string | null;
  status: QuoteStatus;
  currencyCode: string;
  issueDate: string | null;
  expiryDate: string | null;
  subtotal: string;
  taxRate: string | null;
  taxTotal: string;
  total: string;
  oneTimeTotal: string;
  monthlyRecurringTotal: string;
  annualRecurringTotal: string;
  billToName: string | null;
  introNotes: string | null;
  terms: string | null;
  acceptedAt: string | null;
  declinedAt: string | null;
  convertedAt: string | null;
  convertedInvoiceId: string | null;
  sentAt: string | null;
  viewedAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface QuoteBlock {
  id: string;
  quoteId: string;
  orgId: string;
  blockType: QuoteBlockType;
  /** Block-type-discriminated payload (heading text / rich_text html / image ref / line_items label). */
  content: Record<string, unknown>;
  sortOrder: number;
  createdAt: string;
}

export interface QuoteLine {
  id: string;
  quoteId: string;
  blockId: string | null;
  orgId: string;
  sourceType: QuoteLineSourceType;
  catalogItemId: string | null;
  parentLineId: string | null;
  description: string;
  quantity: string;
  unitPrice: string;
  taxable: boolean;
  customerVisible: boolean;
  lineTotal: string;
  recurrence: QuoteLineRecurrence;
  termMonths: number | null;
  billingFrequency: string | null;
  sortOrder: number;
  createdAt: string;
}

/** Shape of `GET /quotes/:id` — `{ data: { quote, blocks, lines } }`. */
export interface QuoteDetail {
  quote: Quote;
  blocks: QuoteBlock[];
  lines: QuoteLine[];
}

export const STATUS_LABELS: Record<QuoteStatus, string> = {
  draft: 'Draft',
  sent: 'Sent',
  viewed: 'Viewed',
  accepted: 'Accepted',
  declined: 'Declined',
  expired: 'Expired',
  converted: 'Converted',
};

// Tailwind badge classes per status (mirrors the invoice/contract status-pill style).
export const STATUS_COLORS: Record<QuoteStatus, string> = {
  draft: 'border-border bg-muted text-muted-foreground',
  sent: 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-400',
  viewed: 'border-indigo-500/30 bg-indigo-500/10 text-indigo-700 dark:text-indigo-400',
  accepted: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  declined: 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400',
  expired: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
  converted: 'border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-400',
};

/** Display label for a quote's status. The 'sent' lifecycle status only reads as
 *  "Sent" once an email actually went out (sentAt); otherwise it's "Issued". */
export function statusLabel(quote: { status: QuoteStatus; sentAt: string | null }): string {
  if (quote.status === 'sent' && !quote.sentAt) return 'Issued';
  return STATUS_LABELS[quote.status];
}

/** Currency-aware money formatter (quotes carry their own currencyCode, unlike
 *  the USD-only lib/timeFormat.formatMoney). Identical to invoiceTypes.formatMoney. */
export function formatMoney(value: string | number | null | undefined, currencyCode = 'USD'): string {
  const n = typeof value === 'number' ? value : Number(value);
  const safe = Number.isFinite(n) ? n : 0;
  try {
    return safe.toLocaleString('en-US', { style: 'currency', currency: currencyCode || 'USD' });
  } catch {
    // Unknown/invalid currency code → fall back to plain 2-decimal + code suffix.
    return `${safe.toFixed(2)} ${currencyCode || ''}`.trim();
  }
}

/** Convert a stored tax-rate FRACTION (e.g. '0.07') to a percent string for an
 *  input ('7'), rounding to 3 decimals to match the numeric(6,3)-on-fraction
 *  scale. Returns '' for null/empty so the input shows its placeholder. */
export function pctFromFraction(frac: string | number | null): string {
  if (frac === null || frac === '') return '';
  return String(Number((Number(frac) * 100).toFixed(3)));
}

/** Render an ISO date (YYYY-MM-DD or timestamp) as a short locale date, '—' if absent. */
export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString();
}

/** Compact recurrence suffix for a line: 'one-time' | '/mo' | '/yr'. */
export function formatRecurrence(recurrence: QuoteLineRecurrence): string {
  switch (recurrence) {
    case 'monthly':
      return '/mo';
    case 'annual':
      return '/yr';
    case 'one_time':
    default:
      return 'one-time';
  }
}
