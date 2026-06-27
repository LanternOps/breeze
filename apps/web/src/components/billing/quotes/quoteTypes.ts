// Shared client-side types + helpers for the quote / proposal billing UI.
// Mirrors invoiceTypes.ts. Money fields arrive from the API as numeric(12,2)
// strings (e.g. '123.40'); tax rate is a numeric(6,3) FRACTION string ('0.07').

import type { SellerSnapshot } from '../invoiceTypes';
export type { SellerSnapshot } from '../invoiceTypes';
export { sellerLines } from '../invoiceTypes';
import { STATUS_PILL } from '../invoiceTypes';

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
  /**
   * Amount actually invoiced on accept = one-time subtotal + tax on one-time
   * taxable lines (recurring is deferred to the Phase 4 contract). Derived
   * server-side in `getQuote`, so it's present on `GET /quotes/:id` but absent
   * from the list endpoint. The UI shows this as "Due on acceptance"; `total`
   * is the recurring-inclusive first-period figure shown separately. */
  dueOnAcceptanceTotal?: string;
  billToName: string | null;
  introNotes: string | null;
  terms: string | null;
  termsAndConditions: string | null;
  sellerSnapshot: SellerSnapshot | null;
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

/** Document branding resolved server-side (mirrors the PDF renderer) so the
 *  in-app Preview matches what the customer receives. Optional because test
 *  fixtures and the list endpoint don't carry it. */
export interface QuoteBranding {
  partnerName: string;
  logoUrl: string | null;
  /** Partner brand accent (hex); null → fall back to the app's primary accent. */
  primaryColor: string | null;
  footer: string | null;
  currencyCode: string;
  seller: SellerSnapshot | null;
}

/** Shape of `GET /quotes/:id` — `{ data: { quote, blocks, lines, branding } }`. */
export interface QuoteDetail {
  quote: Quote;
  blocks: QuoteBlock[];
  lines: QuoteLine[];
  branding?: QuoteBranding;
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
// Five semantic roles shared with the invoice pills (see STATUS_PILL): the
// colour reads the lifecycle (neutral → info while it's with the customer →
// success when won → warning when lapsing → danger when lost), and the label
// carries the finer distinction. sent/viewed share info; accepted/converted
// share success — collapsing the old blue/indigo/violet/emerald rainbow that
// was hard to tell apart at pill scale.
export const STATUS_COLORS: Record<QuoteStatus, string> = {
  draft: STATUS_PILL.neutral,
  sent: STATUS_PILL.info,
  viewed: STATUS_PILL.info,
  accepted: STATUS_PILL.success,
  declined: STATUS_PILL.danger,
  expired: STATUS_PILL.warning,
  converted: STATUS_PILL.success,
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
