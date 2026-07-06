// Shared client-side types + helpers for the invoice billing UI.
// Money fields arrive from the API as numeric(12,2) strings (e.g. '123.40').

// Intentional duplicate of SellerSnapshot in apps/api/src/services/sellerSnapshot.ts
// and apps/portal/src/lib/api.ts — api/web/portal can't share a *runtime* package; keep in sync.
// (Type-only `@breeze/shared` imports are fine — erased at build; see the enum import below.)
/** Snapshot of the seller's contact info captured at invoice/quote creation time.
 *  Any field may be null if not filled in at the time. */
export interface SellerSnapshot {
  name: string | null;
  address: {
    line1: string | null;
    line2: string | null;
    city: string | null;
    region: string | null;
    postalCode: string | null;
    country: string | null;
  } | null;
  phone: string | null;
  email: string | null;
  website: string | null;
}

// Intentional duplicate of sellerAddressLines in apps/api/src/services/sellerSnapshot.ts
// and sellerLines in apps/portal/src/lib/api.ts — api/web/portal can't share a *runtime* package; keep in sync.
// (Type-only `@breeze/shared` imports are fine — erased at build; see the enum import below.)
/** Convert a SellerSnapshot address into an array of non-empty display lines. */
export function sellerLines(a: SellerSnapshot['address'] | null | undefined): string[] {
  if (!a) return [];
  const cityLine = [a.city, a.region, a.postalCode].filter(Boolean).join(', ');
  return [a.line1, a.line2, cityLine, a.country].filter((s): s is string => !!s && s.trim().length > 0);
}

// Invoice-domain enums come from the single source of truth in @breeze/shared
// (packages/shared/src/types/billing-enums.ts). Imported for the Record maps
// below and re-exported so existing './invoiceTypes' consumers are unaffected.
import type { InvoiceStatus, PaymentMethod, InvoiceLineSourceType } from '@breeze/shared';
import { computeQuoteProfit, type QuoteProfit } from '@breeze/shared';
export type { InvoiceStatus, PaymentMethod, InvoiceLineSourceType };

export interface InvoiceSummary {
  id: string;
  invoiceNumber: string | null;
  orgId: string;
  siteId: string | null;
  status: InvoiceStatus;
  currencyCode: string;
  issueDate: string | null;
  dueDate: string | null;
  sentAt: string | null;
  subtotal: string;
  taxRate: string | null;
  taxTotal: string;
  total: string;
  amountPaid: string;
  balance: string;
  /** Deposit due at issue (null = no deposit). Drives the deposit strip + the
   *  deposit paid/unpaid list badge; compared against `amountPaid` in cents. */
  depositDue?: string | null;
  billToName: string | null;
  notes: string | null;
  termsAndConditions: string | null;
  sellerSnapshot: SellerSnapshot | null;
  createdAt: string;
}

export interface InvoiceLine {
  id: string;
  invoiceId: string;
  sourceType: InvoiceLineSourceType;
  parentLineId: string | null;
  catalogItemId: string | null;
  name: string | null;
  description: string | null;
  quantity: string;
  unitPrice: string;
  costBasis: string | null;
  revenueAllocation: string | null;
  taxable: boolean;
  customerVisible: boolean;
  lineTotal: string;
  isUnapprovedTime: boolean;
  sortOrder: number;
}

// A line's title falls back to its description for legacy lines created before
// the name/description split; the blurb only renders when a distinct name exists.
export function lineTitle(l: { name: string | null; description: string | null }): string {
  return (l.name ?? l.description ?? '').trim();
}
export function lineBlurb(l: { name: string | null; description: string | null }): string | null {
  const b = l.name ? (l.description ?? '').trim() : '';
  return b || null;
}

/** Document branding resolved server-side (same partner/portal source the invoice
 *  PDF uses) so the in-app Preview matches what the customer receives. Optional
 *  because test fixtures and the list endpoint don't carry it. Mirrors
 *  QuoteBranding — invoices and quotes share the one letterhead. */
export interface InvoiceBranding {
  partnerName: string;
  logoUrl: string | null;
  /** Partner brand accent (hex); null → fall back to the app's primary accent. */
  primaryColor: string | null;
  footer: string | null;
  currencyCode: string;
  seller: SellerSnapshot | null;
}

export interface InvoiceDetail {
  invoice: InvoiceSummary;
  lines: InvoiceLine[];
  branding?: InvoiceBranding;
  /** Whether the partner has an active Stripe Connect account (gates "Send
   *  payment link"). Absent on older API responses → treated as not connected. */
  stripeConnected?: boolean;
}

export interface InvoicePayment {
  id: string;
  invoiceId: string;
  amount: string;
  method: PaymentMethod;
  reference: string | null;
  receivedAt: string;
  note: string | null;
  createdAt: string;
  /** Origin of the payment: 'stripe' = collected via online checkout (refund
   *  through Stripe, no manual void), 'manual' = recorded by an operator. */
  source?: 'stripe' | 'manual';
}

export const STATUS_LABELS: Record<InvoiceStatus, string> = {
  draft: 'Draft',
  sent: 'Sent',
  partially_paid: 'Partially paid',
  overdue: 'Overdue',
  paid: 'Paid',
  void: 'Void',
};

// The semantic pill vocabulary (STATUS_PILL roles + StatusPillRole) now lives in
// ./shared/statusPillRoles — the shared sub-layer non-component modules (e.g.
// lib/api/contracts) can import from without reaching into invoice-specific
// component types. Re-exported here so existing './invoiceTypes' consumers are
// unaffected.
export { STATUS_PILL } from './shared/statusPillRoles';
export type { StatusPillRole } from './shared/statusPillRoles';
import { STATUS_PILL, type StatusPillRole } from './shared/statusPillRoles';

/** Source-of-truth status → { role, extra className } map. `STATUS_COLORS` (the
 *  class-string form) is derived from it so the two can't drift, and the status
 *  pills pass `role`/`className` straight to `<StatusPill>`. */
export const STATUS_ROLES: Record<InvoiceStatus, { role: StatusPillRole; className?: string }> = {
  draft: { role: 'neutral' },
  sent: { role: 'info' },
  partially_paid: { role: 'warning' },
  overdue: { role: 'danger' },
  paid: { role: 'success' },
  void: { role: 'neutral', className: 'line-through' },
};

export const STATUS_COLORS = Object.fromEntries(
  (Object.entries(STATUS_ROLES) as [InvoiceStatus, { role: StatusPillRole; className?: string }][]).map(
    ([status, { role, className }]) => [status, className ? `${STATUS_PILL[role]} ${className}` : STATUS_PILL[role]],
  ),
) as Record<InvoiceStatus, string>;

/** Display label for an invoice's status. The 'sent' lifecycle status means
 *  "issued"; it only reads as "Sent" once an email actually went out (sentAt).
 *  This keeps a plain Issue from mislabeling itself as Sent. */
export function statusLabel(invoice: { status: InvoiceStatus; sentAt: string | null }): string {
  if (invoice.status === 'sent' && !invoice.sentAt) return 'Issued';
  return STATUS_LABELS[invoice.status];
}

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: 'Cash',
  check: 'Check',
  bank_transfer: 'Bank transfer',
  card: 'Card',
  other: 'Other',
};

// Money/date formatters live in ./shared/format (the canonical copies, shared
// with quotes + contracts); re-exported here so existing './invoiceTypes'
// import sites are unaffected.
export { formatMoney, formatDate, sumByCurrency } from './shared/format';

/** Convert a stored tax-rate FRACTION (e.g. '0.07') to a percent string for an
 *  input ('7'), rounding the percent to 3 decimals — equivalently the numeric(8,5)
 *  fraction scale (5 fraction decimals = 3 percent decimals, e.g. 8.875%). Avoids
 *  float noise like `String(0.07 * 100)` → '7.000000000000001'.
 *  Returns '' for null/empty so the input shows its placeholder. */
export function pctFromFraction(frac: string | number | null): string {
  if (frac === null || frac === '') return '';
  return String(Number((Number(frac) * 100).toFixed(3)));
}

/** Per-line tax amount for the line-table Tax column: taxable lines get
 *  lineTotal × rate rounded to cents; non-taxable lines, a null/empty rate, or a
 *  non-positive rate return null (rendered as '—'). The header Tax stays the
 *  server's authoritative `taxTotal`, so a quote/invoice with many taxable lines
 *  can differ from the summed column by a rounding cent. Mirrors quoteTypes. */
export function lineTaxAmount(
  lineTotal: string | number,
  taxable: boolean,
  taxRate: string | number | null,
): number | null {
  if (!taxable) return null;
  const rate = taxRate === null || taxRate === '' ? 0 : Number(taxRate);
  const cents = Math.round(Number(lineTotal) * 100);
  if (!Number.isFinite(rate) || rate <= 0 || !Number.isFinite(cents)) return null;
  return Math.round(cents * rate) / 100;
}

/**
 * Internal profit summary for an invoice, computed with the same shared cents
 * math (`computeQuoteProfit`) the quote editor/detail rails use — so the invoice
 * margin is rounded and labelled identically to a quote's, with no second,
 * drifting implementation. (It does NOT assert numeric equality with any
 * originating quote: invoices are edited independently after issue and need not
 * originate from a quote at all.)
 *
 * Bundles are the subtlety. A bundle persists as a parent rollup line whose
 * `costBasis` is the FULL bundle cost (`Σ component.costBasis × component.qty`,
 * see `computeBundleEconomicsFrom`) plus child component lines that each carry
 * their OWN `costBasis` and may be `customerVisible`. Folding over every line
 * would count a visible component's cost twice (parent rollup + child). So we
 * fold over TOP-LEVEL lines only (`parentLineId === null`): the parent represents
 * each bundle exactly once, and every manual/catalog line is already top-level.
 * Children are excluded by parentage, not visibility — a *visible* component must
 * still not be double-counted.
 *
 * Each top-level line maps straight through (raw `quantity`/`unitPrice`/
 * `costBasis`, same as the quote mapping) so the shared cents math does a single
 * round and a null `costBasis` is counted in `linesMissingCost` (driving the
 * "estimate incomplete" warning) rather than silently booked as $0. Invoices are
 * one-time → `recurrence: 'one_time'`, so the monthly/annual nets stay 0 and
 * `MarginPanel` self-hides those rows. Billed-only (`customerVisible`) and
 * tax-excluded — the same contract as quotes.
 */
export function computeInvoiceProfit(lines: InvoiceLine[]): QuoteProfit {
  return computeQuoteProfit(
    lines
      .filter((l) => l.parentLineId === null)
      .map((l) => ({
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        unitCost: l.costBasis,
        taxable: l.taxable,
        customerVisible: l.customerVisible,
        recurrence: 'one_time' as const,
      })),
  );
}
