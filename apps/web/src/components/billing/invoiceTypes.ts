// Shared client-side types + helpers for the invoice billing UI.
// Money fields arrive from the API as numeric(12,2) strings (e.g. '123.40').

export type InvoiceStatus =
  | 'draft' | 'sent' | 'partially_paid' | 'overdue' | 'paid' | 'void';

export type PaymentMethod = 'cash' | 'check' | 'bank_transfer' | 'card' | 'other';

export interface InvoiceSummary {
  id: string;
  invoiceNumber: string | null;
  orgId: string;
  siteId: string | null;
  status: InvoiceStatus;
  currencyCode: string;
  issueDate: string | null;
  dueDate: string | null;
  subtotal: string;
  taxRate: string | null;
  taxTotal: string;
  total: string;
  amountPaid: string;
  balance: string;
  billToName: string | null;
  notes: string | null;
  createdAt: string;
}

export interface InvoiceLine {
  id: string;
  invoiceId: string;
  sourceType: 'time_entry' | 'part' | 'catalog' | 'bundle' | 'manual' | 'contract';
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
}

export const STATUS_LABELS: Record<InvoiceStatus, string> = {
  draft: 'Draft',
  sent: 'Sent',
  partially_paid: 'Partially paid',
  overdue: 'Overdue',
  paid: 'Paid',
  void: 'Void',
};

// Tailwind badge classes per status (mirrors the device/org status-pill style).
export const STATUS_COLORS: Record<InvoiceStatus, string> = {
  draft: 'border-border bg-muted text-muted-foreground',
  sent: 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-400',
  partially_paid: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
  overdue: 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400',
  paid: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  void: 'border-border bg-muted text-muted-foreground line-through',
};

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
 *  input ('7'), rounding to 3 decimals to match the numeric(6,3)-on-fraction
 *  scale. Avoids float noise like `String(0.07 * 100)` → '7.000000000000001'.
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
