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
  description: string;
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

export interface InvoiceDetail {
  invoice: InvoiceSummary;
  lines: InvoiceLine[];
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

/**
 * Status-pill color roles, built from the app's semantic tokens (success /
 * warning / info / destructive) rather than raw Tailwind palette hues. Shared by
 * both the invoice and quote status pills (imported by quoteTypes) so the
 * vocabulary can't drift between the two sibling surfaces.
 *
 * Five roles, not a per-status rainbow: meaning drives the hue (neutral = not
 * sent, info = awaiting the customer, success = won/paid, warning = lapsing,
 * danger = lost/overdue). The text label carries the finer distinction (Sent vs
 * Viewed, Accepted vs Converted), so colour stays scannable.
 *
 * `info`/`success` base tokens are dark enough (L≈37-38%) to read on their own
 * 10% tint; `warning`/`danger` base tokens (amber L50% / red L56%) fail WCAG as
 * text on a light tint, so light mode uses a darker shade of the SAME token hue
 * and dark mode (where the bg is dark) uses the token directly.
 */
export const STATUS_PILL = {
  neutral: 'border-border bg-muted text-muted-foreground',
  info: 'border-info/30 bg-info/10 text-info',
  success: 'border-success/30 bg-success/10 text-success',
  warning: 'border-warning/40 bg-warning/15 text-[hsl(36_92%_28%)] dark:text-warning',
  danger: 'border-destructive/40 bg-destructive/10 text-[hsl(4_74%_42%)] dark:text-destructive',
} as const;

export const STATUS_COLORS: Record<InvoiceStatus, string> = {
  draft: STATUS_PILL.neutral,
  sent: STATUS_PILL.info,
  partially_paid: STATUS_PILL.warning,
  overdue: STATUS_PILL.danger,
  paid: STATUS_PILL.success,
  void: `${STATUS_PILL.neutral} line-through`,
};

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

/** Currency-aware money formatter (invoices carry their own currencyCode,
 *  unlike the USD-only lib/timeFormat.formatMoney). */
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
 *  input ('7'), rounding the percent to 3 decimals — equivalently the numeric(8,5)
 *  fraction scale (5 fraction decimals = 3 percent decimals, e.g. 8.875%). Avoids
 *  float noise like `String(0.07 * 100)` → '7.000000000000001'.
 *  Returns '' for null/empty so the input shows its placeholder. */
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
