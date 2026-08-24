import { multiplyToCurrency, roundToCurrency } from '@breeze/shared';
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

export function computeLineTotal(quantity: string, unitPrice: string, currencyCode = 'USD'): string {
  // Exact decimal product (scaled integers — never a double, review #2), then
  // ONE half-up round at the currency's minor-unit boundary (cents for 2-decimal
  // currencies; whole units for JPY). Matches SQL ROUND(quantity * price, scale).
  return multiplyToCurrency(quantity, unitPrice, currencyCode);
}

export interface TotalsLine {
  lineTotal: string;
  taxable: boolean;
  customerVisible: boolean;
}

export function computeInvoiceTotals(
  lines: TotalsLine[],
  taxRate: string | null,
  currencyCode = 'USD'
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
  // Tax is computed at the classic cent boundary first — `roundHalfUp(cents * rate)`
  // is kept verbatim so 2-decimal results stay bit-identical to the historical
  // integer-cents path (rounding the major-unit float instead loses ties to FP
  // noise: 145¢ × 0.10 → 0.14499999999999998 → 0.14, and ¥400 × 7.125% →
  // 28.499999999999996 → 28). The CURRENCY then decides the final rounding
  // boundary of each persisted figure (spec §4: persisted amounts must be
  // representable in the currency's minor unit; JPY → whole units).
  const taxCents = roundHalfUp(taxableCents * rate);
  const subtotal = roundToCurrency(subtotalCents / 100, currencyCode);
  const taxTotal = roundToCurrency(taxCents / 100, currencyCode);
  const total = roundToCurrency(Number(subtotal) + Number(taxTotal), currencyCode);
  return { subtotal, taxTotal, total };
}

export function resolveEffectiveTaxRate(input: {
  taxExempt: boolean;
  orgRate: string | null;
  partnerRate: string | null;
}): string {
  // Fraction with scale 5 (3 percent decimals) — see numeric(8,5) tax_rate columns.
  if (input.taxExempt) return '0.00000';
  const rate = input.orgRate ?? input.partnerRate ?? '0';
  return Number(rate).toFixed(5);
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
