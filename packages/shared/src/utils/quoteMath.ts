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

/**
 * Deposit config as a discriminated union so illegal states ({ type: 'percent' }
 * with no percent, or a percent on a non-percent type) are unrepresentable at
 * compile time. Mirrors the QuoteDepositValidation union below.
 */
export type QuoteDepositConfig =
  /** No deposit. */
  | { type: 'none' }
  /** Whole-percent scale (30 = 30%), 2dp. May be NaN when normalized from a
   *  missing/blank source value — validateQuoteDeposit rejects it and
   *  computeQuoteTotals treats it as "no deposit" (both gate on isFinite). */
  | { type: 'percent'; percent: number }
  /** Eligibility lives on the lines (QuoteLineForMath.depositEligible). */
  | { type: 'selected_lines' };

export type QuoteDepositType = QuoteDepositConfig['type'];

/**
 * Normalize the flat persisted/wire pair (deposit_type, deposit_percent) into
 * the union. The DB and API keep the flat columns/fields — this is the single
 * read-boundary adapter, so construction sites don't hand-build literals.
 * A missing/blank percent on a 'percent' deposit becomes NaN (NOT a silent
 * 'none'): validateQuoteDeposit must still fail it with DEPOSIT_PERCENT_INVALID,
 * exactly as the pre-union code did.
 */
export function toQuoteDepositConfig(
  type: QuoteDepositType | null | undefined,
  percent: number | string | null | undefined,
): QuoteDepositConfig {
  if (type === 'percent') {
    const blank = percent === null || percent === undefined
      || (typeof percent === 'string' && percent.trim() === '');
    return { type: 'percent', percent: blank ? Number.NaN : Number(percent) };
  }
  if (type === 'selected_lines') return { type: 'selected_lines' };
  return { type: 'none' };
}

export interface QuoteLineForMath {
  quantity: string;
  unitPrice: string;
  unitCost?: string | null;
  taxable: boolean;
  customerVisible: boolean;
  recurrence: 'one_time' | 'monthly' | 'annual';
  /** Counts toward a 'selected_lines' deposit (one-time lines only). */
  depositEligible?: boolean;
  /** Catalog item type snapshotted at add-time; null/undefined = manual → 'other'. */
  itemType?: 'hardware' | 'software' | 'service' | null;
}

export interface QuoteCategorySubtotal {
  category: 'hardware' | 'software' | 'service' | 'other';
  oneTimeTotal: string;
  monthlyTotal: string;
  annualTotal: string;
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
  /** Deposit due at acceptance, or null when no (valid) deposit is configured. */
  depositDueTotal: string | null;
  /** Per-category subtotals over customer-visible lines; empty categories omitted. */
  categoryBreakdown: QuoteCategorySubtotal[];
}

export function computeQuoteTotals(
  lines: QuoteLineForMath[],
  taxRate: number | null,
  deposit?: QuoteDepositConfig | null,
): QuoteTotals {
  let oneTime = 0, monthly = 0, annual = 0, taxableBasis = 0, oneTimeTaxableBasis = 0;
  let eligibleCents = 0, eligibleTaxableCents = 0;
  const CATEGORY_ORDER = ['hardware', 'software', 'service', 'other'] as const;
  const cat: Record<string, { oneTime: number; monthly: number; annual: number }> = {};
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
    if (l.depositEligible && l.recurrence === 'one_time') {
      eligibleCents += lineCents;
      if (l.taxable) eligibleTaxableCents += lineCents;
    }
    const key = l.itemType ?? 'other';
    const bucket = (cat[key] ??= { oneTime: 0, monthly: 0, annual: 0 });
    if (l.recurrence === 'monthly') bucket.monthly += lineCents;
    else if (l.recurrence === 'annual') bucket.annual += lineCents;
    else bucket.oneTime += lineCents;
  }
  // First-period basis: one-time + first monthly period + first annual period.
  const subtotal = oneTime + monthly + annual;
  const rate = taxRate ?? 0;
  const taxCents = Math.floor(taxableBasis * rate + 0.5);
  // Tax on ONLY the one-time taxable lines — what accept actually invoices.
  const oneTimeTaxCents = Math.floor(oneTimeTaxableBasis * rate + 0.5);
  const dueOnAcceptanceCents = oneTime + oneTimeTaxCents;

  let depositCents: number | null = null;
  if (deposit && deposit.type === 'percent') {
    // The union guarantees a number, but not a *sane* one (NaN from a blank
    // normalized source, or ≤0 from an unvalidated caller) — money code keeps
    // the finite-positive gate rather than trusting compile-time alone.
    if (Number.isFinite(deposit.percent) && deposit.percent > 0) {
      depositCents = Math.floor(dueOnAcceptanceCents * (deposit.percent / 100) + 0.5);
    }
  } else if (deposit && deposit.type === 'selected_lines') {
    depositCents = eligibleCents + Math.floor(eligibleTaxableCents * rate + 0.5);
  }
  // A deposit that computes to $0.00 or less is "no deposit": collapse to null so
  // the persisted snapshot (recomputeAndPersist) and the accept-time `!= null`
  // guard agree with the documented contract, rather than storing a bogus "0.00".
  // validateQuoteDeposit still hard-blocks these before a quote can be sent.
  if (depositCents !== null && depositCents <= 0) depositCents = null;

  return {
    subtotal: fromCents(subtotal),
    taxTotal: fromCents(taxCents),
    total: fromCents(subtotal + taxCents),
    oneTimeTotal: fromCents(oneTime),
    monthlyRecurringTotal: fromCents(monthly),
    annualRecurringTotal: fromCents(annual),
    dueOnAcceptanceTotal: fromCents(dueOnAcceptanceCents),
    depositDueTotal: depositCents !== null ? fromCents(depositCents) : null,
    categoryBreakdown: CATEGORY_ORDER
      .filter((k) => cat[k])
      .map((k) => ({
        category: k,
        oneTimeTotal: fromCents(cat[k]!.oneTime),
        monthlyTotal: fromCents(cat[k]!.monthly),
        annualTotal: fromCents(cat[k]!.annual),
      })),
  };
}

export type QuoteDepositValidation =
  | { ok: true; depositDueTotal: string | null }
  | { ok: false; code: 'DEPOSIT_REQUIRES_ONE_TIME_LINES' | 'DEPOSIT_PERCENT_INVALID'
      | 'DEPOSIT_NO_ELIGIBLE_LINES' | 'DEPOSIT_NOT_BELOW_TOTAL'; message: string };

/** Spec rule: deposit needs ≥1 one-time visible line; 0 < deposit < dueOnAcceptanceTotal. */
export function validateQuoteDeposit(
  lines: QuoteLineForMath[],
  taxRate: number | null,
  deposit: QuoteDepositConfig,
): QuoteDepositValidation {
  if (deposit.type === 'none') return { ok: true, depositDueTotal: null };
  const totals = computeQuoteTotals(lines, taxRate, deposit);
  if (toCents(totals.dueOnAcceptanceTotal) <= 0) {
    return { ok: false, code: 'DEPOSIT_REQUIRES_ONE_TIME_LINES',
      message: 'A deposit needs at least one one-time, customer-visible line' };
  }
  if (deposit.type === 'percent') {
    const pct = deposit.percent;
    if (!Number.isFinite(pct) || pct <= 0 || pct >= 100) {
      return { ok: false, code: 'DEPOSIT_PERCENT_INVALID', message: 'Deposit percent must be between 0 and 100 (exclusive)' };
    }
  }
  const depositCents = totals.depositDueTotal !== null ? toCents(totals.depositDueTotal) : 0;
  if (deposit.type === 'selected_lines' && depositCents <= 0) {
    return { ok: false, code: 'DEPOSIT_NO_ELIGIBLE_LINES', message: 'Flag at least one one-time line as deposit-eligible' };
  }
  // Spec rule 0 < deposit: a percent so small it rounds to $0.00 is no deposit.
  if (deposit.type === 'percent' && depositCents <= 0) {
    return { ok: false, code: 'DEPOSIT_PERCENT_INVALID', message: 'Deposit percent is too small for this quote total' };
  }
  if (depositCents >= toCents(totals.dueOnAcceptanceTotal)) {
    return { ok: false, code: 'DEPOSIT_NOT_BELOW_TOTAL',
      message: 'Deposit must be less than the amount due on acceptance — remove the deposit instead' };
  }
  return { ok: true, depositDueTotal: totals.depositDueTotal };
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
  /**
   * Revenue (pre-tax) that the net figures above were computed from, split by
   * the same cadence — ONLY lines that have a cost (a line missing cost
   * contributes to neither the net nor the revenue here, same exclusion as
   * `linesMissingCost`). This is the denominator for a margin percent
   * (net / revenue · 100, see `marginPct`); a cadence with no cost-bearing
   * lines yields '0.00', which is how callers detect "nothing to compute a
   * percent from" rather than showing a misleading 0%.
   */
  oneTimeRevenue: string;
  monthlyRecurringRevenue: string;
  annualRecurringRevenue: string;
  /** Count of billed lines with no cost — excluded from net, so the figure is partial. */
  linesMissingCost: number;
}

/** Net = revenue − cost, EXCLUDING tax, over billed (customerVisible) lines, split
 *  by cadence. Lines with no unitCost (null/undefined/empty string — never entered)
 *  are excluded and counted in linesMissingCost. An EXPLICIT cost of 0 (e.g. a
 *  labor/service line deliberately marked "no cost" — Task B1) is NOT missing:
 *  it's a real, known cost of $0, so the line counts fully toward net (net =
 *  full revenue) and is never counted in linesMissingCost. Only the string
 *  `l.unitCost === null | undefined | ''` triggers the exclusion below — '0'/'0.00'
 *  fails that check and falls through to the normal cents math. */
export function computeQuoteProfit(lines: QuoteLineForMath[]): QuoteProfit {
  let oneTimeNet = 0, monthlyNet = 0, annualNet = 0, totalCost = 0, missing = 0;
  let oneTimeRevenue = 0, monthlyRevenue = 0, annualRevenue = 0;
  for (const l of lines) {
    if (!l.customerVisible) continue;
    if (l.unitCost === null || l.unitCost === undefined || l.unitCost === '') { missing++; continue; }
    const revenueCents = toCents(computeLineTotal(l.quantity, l.unitPrice));
    const costCents = toCents(computeLineTotal(l.quantity, l.unitCost));
    const netCents = revenueCents - costCents;
    totalCost += costCents;
    if (l.recurrence === 'monthly') { monthlyNet += netCents; monthlyRevenue += revenueCents; }
    else if (l.recurrence === 'annual') { annualNet += netCents; annualRevenue += revenueCents; }
    else { oneTimeNet += netCents; oneTimeRevenue += revenueCents; }
  }
  return {
    oneTimeNet: fromCents(oneTimeNet),
    monthlyRecurringNet: fromCents(monthlyNet),
    annualRecurringNet: fromCents(annualNet),
    totalCost: fromCents(totalCost),
    oneTimeRevenue: fromCents(oneTimeRevenue),
    monthlyRecurringRevenue: fromCents(monthlyRevenue),
    annualRecurringRevenue: fromCents(annualRevenue),
    linesMissingCost: missing,
  };
}

/**
 * Profit MARGIN = net / revenue · 100 — NOT markup (net / cost). Null when
 * revenue is zero, negative, or non-finite, which also covers "no cost-bearing
 * lines in this cadence" (computeQuoteProfit's revenue fields are 0 in that
 * case) — callers use null to suppress the percent instead of showing a
 * misleading 0% or NaN.
 */
export function marginPct(net: string | number, revenue: string | number): number | null {
  const n = Number(net); const r = Number(revenue);
  if (!Number.isFinite(n) || !Number.isFinite(r) || r <= 0) return null;
  return (n / r) * 100;
}
