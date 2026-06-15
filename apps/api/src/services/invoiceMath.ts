import type { InvoiceStatus } from './invoiceTypes';

// Cents helpers (same contract as catalogPricing.ts). Exported so the money
// seams in invoiceService.ts route through the same integer-cents discipline
// rather than re-introducing float arithmetic. Round-half-up at the cent boundary.
export function toCents(v: string | number | null | undefined): number {
  if (v === null || v === undefined || v === '') return 0;
  return Math.round(Number(v) * 100);
}
export function fromCents(cents: number): string {
  return (cents / 100).toFixed(2);
}
// Round-half-up of a fractional cent amount.
function roundHalfUp(n: number): number {
  return Math.floor(n + 0.5);
}

export function computeLineTotal(quantity: string, unitPrice: string): string {
  // quantity * unitPrice in full precision, then a single round-half-up at the
  // cent boundary. (Rounding unitPrice to cents first would lose sub-cent unit
  // prices like 0.335 — 3 * 0.335 = 1.005 must round half-up to 1.01, not 1.02.)
  const fractionalCents = Number(quantity) * Number(unitPrice) * 100;
  return fromCents(roundHalfUp(fractionalCents));
}

export interface TotalsLine {
  lineTotal: string;
  taxable: boolean;
  customerVisible: boolean;
}

export function computeInvoiceTotals(
  lines: TotalsLine[],
  taxRate: string | null
): { subtotal: string; taxTotal: string; total: string } {
  let subtotalCents = 0;
  let taxableCents = 0;
  for (const l of lines) {
    if (!l.customerVisible) continue;
    const c = toCents(l.lineTotal);
    subtotalCents += c;
    if (l.taxable) taxableCents += c;
  }
  const rate = taxRate ? Number(taxRate) : 0;
  const taxCents = roundHalfUp(taxableCents * rate);
  const totalCents = subtotalCents + taxCents;
  return { subtotal: fromCents(subtotalCents), taxTotal: fromCents(taxCents), total: fromCents(totalCents) };
}

export function resolveEffectiveTaxRate(input: {
  taxExempt: boolean;
  orgRate: string | null;
  partnerRate: string | null;
}): string {
  if (input.taxExempt) return '0.000';
  const rate = input.orgRate ?? input.partnerRate ?? '0';
  return Number(rate).toFixed(3);
}

export function deriveInvoiceStatus(input: {
  voided: boolean;
  issued: boolean;
  total: string;
  amountPaid: string;
  dueDate: string | null; // ISO date
  asOf: Date;
}): InvoiceStatus {
  if (input.voided) return 'void';
  if (!input.issued) return 'draft';
  const balanceCents = toCents(input.total) - toCents(input.amountPaid);
  if (balanceCents <= 0) return 'paid';
  const pastDue = input.dueDate !== null && new Date(input.dueDate + 'T23:59:59Z').getTime() < input.asOf.getTime();
  if (pastDue) return 'overdue';
  if (toCents(input.amountPaid) > 0) return 'partially_paid';
  return 'sent';
}
