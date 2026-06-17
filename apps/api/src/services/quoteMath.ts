import { toCents, fromCents, computeLineTotal } from './invoiceMath';

export interface QuoteLineForMath {
  quantity: string;
  unitPrice: string;
  taxable: boolean;
  customerVisible: boolean;
  recurrence: 'one_time' | 'monthly' | 'annual';
}

export interface QuoteTotals {
  subtotal: string;
  taxTotal: string;
  total: string;
  oneTimeTotal: string;
  monthlyRecurringTotal: string;
  annualRecurringTotal: string;
}

export function computeQuoteTotals(lines: QuoteLineForMath[], taxRate: number | null): QuoteTotals {
  let oneTime = 0, monthly = 0, annual = 0, taxableBasis = 0;
  for (const l of lines) {
    if (!l.customerVisible) continue;
    // Route through the canonical billing helpers so quote per-line cents equal
    // the persisted line_total (rounded to cents) and match invoices exactly:
    // a single round-half-up at the cent boundary, never rounding unitPrice first.
    const lineCents = toCents(computeLineTotal(l.quantity, l.unitPrice));
    if (l.recurrence === 'monthly') monthly += lineCents;
    else if (l.recurrence === 'annual') annual += lineCents;
    else oneTime += lineCents;
    if (l.taxable) taxableBasis += lineCents;
  }
  // First-invoice basis: one-time + first monthly period + first annual period.
  const subtotal = oneTime + monthly + annual;
  // Match invoiceMath.computeInvoiceTotals' round-half-up; nullish so a 0 rate
  // and null both yield 0 tax.
  const rate = taxRate ?? 0;
  const taxCents = Math.floor(taxableBasis * rate + 0.5);
  return {
    subtotal: fromCents(subtotal),
    taxTotal: fromCents(taxCents),
    total: fromCents(subtotal + taxCents),
    oneTimeTotal: fromCents(oneTime),
    monthlyRecurringTotal: fromCents(monthly),
    annualRecurringTotal: fromCents(annual),
  };
}
