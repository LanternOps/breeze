// Single source of truth for quote totals, shared by the API (authoritative
// recompute on every mutation) and the web editor (optimistic "Live totals" rail
// while the user is mid-edit). Keeping one implementation here means the
// optimistic rail can never settle to a different figure than the server returns.
//
// The cents discipline mirrors invoiceMath/catalogPricing exactly: integer cents
// with a single round-half-up at the cent boundary, never rounding unitPrice
// first. These helpers are intentionally self-contained (no invoice-status / DB
// coupling) so the module is safe to import into the browser bundle.

/** Money string/number → integer cents (round-half-up — `Math.round` ties toward
 *  +∞ — on the ×100 product). Null/empty/non-finite → 0, so a stray NaN can't
 *  propagate to a literal "NaN" on the totals rail (this module is browser-safe
 *  and shared, so it can't assume every caller pre-validates). */
export function toCents(v: string | number | null | undefined): number {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/** Integer cents → 2-decimal money string. */
export function fromCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** Round-half-up of a fractional-cent amount. */
function roundHalfUp(n: number): number {
  return Math.floor(n + 0.5);
}

/** quantity × unitPrice in full precision, then a single round-half-up at the
 *  cent boundary. (Rounding unitPrice to cents first would lose sub-cent unit
 *  prices like 0.335 — 3 × 0.335 = 1.005 must round half-up to 1.01.) */
export function computeLineTotal(quantity: string | number, unitPrice: string | number): string {
  const fractionalCents = Number(quantity) * Number(unitPrice) * 100;
  return fromCents(roundHalfUp(fractionalCents));
}

export interface QuoteLineForMath {
  quantity: string;
  unitPrice: string;
  unitCost?: string | null;
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
  /**
   * The amount actually invoiced when the customer accepts the quote. Accept
   * auto-issues a one-time-only invoice (recurring lines defer to the recurring
   * contract), so this is the one-time subtotal PLUS tax on just the taxable
   * one-time lines. NOT `total`, which also rolls in the first monthly + annual
   * period. Must equal quoteAcceptService's invoice math.
   */
  dueOnAcceptanceTotal: string;
}

export function computeQuoteTotals(lines: QuoteLineForMath[], taxRate: number | null): QuoteTotals {
  let oneTime = 0, monthly = 0, annual = 0, taxableBasis = 0, oneTimeTaxableBasis = 0;
  for (const l of lines) {
    if (!l.customerVisible) continue;
    // Route per-line cents through computeLineTotal so they equal the persisted
    // line_total (rounded to cents) and match invoices exactly.
    const lineCents = toCents(computeLineTotal(l.quantity, l.unitPrice));
    if (l.recurrence === 'monthly') monthly += lineCents;
    else if (l.recurrence === 'annual') annual += lineCents;
    else oneTime += lineCents;
    if (l.taxable) {
      taxableBasis += lineCents;
      if (l.recurrence === 'one_time') oneTimeTaxableBasis += lineCents;
    }
  }
  // First-period basis: one-time + first monthly period + first annual period.
  const subtotal = oneTime + monthly + annual;
  const rate = taxRate ?? 0;
  const taxCents = Math.floor(taxableBasis * rate + 0.5);
  // Tax on ONLY the one-time taxable lines — what accept actually invoices.
  const oneTimeTaxCents = Math.floor(oneTimeTaxableBasis * rate + 0.5);
  return {
    subtotal: fromCents(subtotal),
    taxTotal: fromCents(taxCents),
    total: fromCents(subtotal + taxCents),
    oneTimeTotal: fromCents(oneTime),
    monthlyRecurringTotal: fromCents(monthly),
    annualRecurringTotal: fromCents(annual),
    dueOnAcceptanceTotal: fromCents(oneTime + oneTimeTaxCents),
  };
}

/** markup on cost = (price − cost) / cost · 100. Null when cost is absent/≤0. */
export function markupPct(price: string | number, cost: string | number | null | undefined): number | null {
  if (cost === null || cost === undefined || cost === '') return null;
  const c = Number(cost); const p = Number(price);
  if (!Number.isFinite(c) || c <= 0 || !Number.isFinite(p)) return null;
  return ((p - c) / c) * 100;
}

/** Unit price from a target markup% on cost, cent-rounded (round-half-up). */
export function priceFromMarkup(cost: string | number, markupPctValue: number): string {
  const c = Number(cost);
  if (!Number.isFinite(c) || !Number.isFinite(markupPctValue)) return '0.00';
  return fromCents(roundHalfUp(c * (1 + markupPctValue / 100) * 100));
}

export interface QuoteProfit {
  oneTimeNet: string;
  monthlyRecurringNet: string;
  annualRecurringNet: string;
  totalCost: string;
  /** Count of billed lines with no cost — excluded from net, so the figure is partial. */
  linesMissingCost: number;
}

/** Net = revenue − cost, EXCLUDING tax, over billed (customerVisible) lines, split
 *  by cadence. Lines with no unitCost are excluded and counted in linesMissingCost. */
export function computeQuoteProfit(lines: QuoteLineForMath[]): QuoteProfit {
  let oneTimeNet = 0, monthlyNet = 0, annualNet = 0, totalCost = 0, missing = 0;
  for (const l of lines) {
    if (!l.customerVisible) continue;
    if (l.unitCost === null || l.unitCost === undefined || l.unitCost === '') { missing++; continue; }
    const revenueCents = toCents(computeLineTotal(l.quantity, l.unitPrice));
    const costCents = toCents(computeLineTotal(l.quantity, l.unitCost));
    const netCents = revenueCents - costCents;
    totalCost += costCents;
    if (l.recurrence === 'monthly') monthlyNet += netCents;
    else if (l.recurrence === 'annual') annualNet += netCents;
    else oneTimeNet += netCents;
  }
  return {
    oneTimeNet: fromCents(oneTimeNet),
    monthlyRecurringNet: fromCents(monthlyNet),
    annualRecurringNet: fromCents(annualNet),
    totalCost: fromCents(totalCost),
    linesMissingCost: missing,
  };
}
