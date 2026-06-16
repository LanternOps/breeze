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

// Work in integer cents to avoid float drift, then format to 2dp strings.
function cents(n: string): number { return Math.round(parseFloat(n) * 100); }
function fmt(c: number): string { return (c / 100).toFixed(2); }

export function computeQuoteTotals(lines: QuoteLineForMath[], taxRate: number | null): QuoteTotals {
  let oneTime = 0, monthly = 0, annual = 0, taxableBasis = 0;
  for (const l of lines) {
    if (!l.customerVisible) continue;
    const lineCents = Math.round((cents(l.quantity) / 100) * cents(l.unitPrice));
    if (l.recurrence === 'monthly') monthly += lineCents;
    else if (l.recurrence === 'annual') annual += lineCents;
    else oneTime += lineCents;
    if (l.taxable) taxableBasis += lineCents;
  }
  // First-invoice basis: one-time + first monthly period + first annual period.
  const subtotal = oneTime + monthly + annual;
  const tax = taxRate ? Math.round(taxableBasis * taxRate) : 0;
  return {
    subtotal: fmt(subtotal),
    taxTotal: fmt(tax),
    total: fmt(subtotal + tax),
    oneTimeTotal: fmt(oneTime),
    monthlyRecurringTotal: fmt(monthly),
    annualRecurringTotal: fmt(annual),
  };
}
