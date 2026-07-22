import { describe, it, expect } from 'vitest';
import { computeQuoteTotals, computeLineTotal, toCents, fromCents, markupPct, priceFromMarkup, computeQuoteProfit, marginPct, validateQuoteDeposit, toQuoteDepositConfig, type QuoteLineForMath } from './quoteMath';

const line = (over: Partial<QuoteLineForMath>): QuoteLineForMath => ({
  quantity: '1', unitPrice: '0', taxable: false, recurrence: 'one_time', customerVisible: true, ...over,
});

describe('quoteMath (shared)', () => {
  it('buckets one-time vs monthly vs annual and taxes only taxable lines', () => {
    const r = computeQuoteTotals([
      line({ quantity: '2', unitPrice: '500', recurrence: 'one_time', taxable: true }),
      line({ quantity: '10', unitPrice: '22', recurrence: 'monthly', taxable: true }),
      line({ quantity: '1', unitPrice: '1200', recurrence: 'annual', taxable: false }),
    ], 0.1);
    expect(r.oneTimeTotal).toBe('1000.00');
    expect(r.monthlyRecurringTotal).toBe('220.00');
    expect(r.annualRecurringTotal).toBe('1200.00');
    expect(r.subtotal).toBe('2420.00');
    expect(r.taxTotal).toBe('122.00'); // (1000 + 220) * 0.1
    expect(r.total).toBe('2542.00');
  });

  it('dueOnAcceptanceTotal is the one-time subtotal + tax on one-time lines only', () => {
    const r = computeQuoteTotals([
      line({ quantity: '1', unitPrice: '500', recurrence: 'one_time', taxable: true }),
      line({ quantity: '1', unitPrice: '1000', recurrence: 'monthly', taxable: true }),
    ], 0.1);
    expect(r.taxTotal).toBe('150.00');             // whole-quote tax incl. monthly
    expect(r.dueOnAcceptanceTotal).toBe('550.00'); // one-time 500 + its 50 tax
    expect(r.dueOnAcceptanceTotal).not.toBe(r.total);
  });

  it('excludes non-customer-visible lines and treats null taxRate as zero', () => {
    expect(computeQuoteTotals([line({ unitPrice: '100', customerVisible: false })], 0).subtotal).toBe('0.00');
    const r = computeQuoteTotals([line({ unitPrice: '100', taxable: true })], null);
    expect(r.taxTotal).toBe('0.00');
    expect(r.total).toBe('100.00');
  });

  it('rounds at the cent boundary without rounding unitPrice first', () => {
    // 0.05 * 0.70 = 0.035 → 3.4999.. cents → floor(+0.5) = 3 → 0.03 (not 0.04).
    expect(computeLineTotal('0.05', '0.70')).toBe('0.03');
    expect(computeQuoteTotals([line({ quantity: '0.05', unitPrice: '0.70' })], null).subtotal).toBe('0.03');
    // sub-cent unit prices survive: 3 * 0.335 = 1.005 → round half-up → 1.01.
    expect(computeLineTotal('3', '0.335')).toBe('1.01');
  });

  it('cents helpers round-trip and treat blank as zero', () => {
    expect(toCents('12.34')).toBe(1234);
    expect(toCents('')).toBe(0);
    expect(toCents(null)).toBe(0);
    expect(fromCents(1234)).toBe('12.34');
  });

  it('markupPct: (price-cost)/cost, null when cost absent/zero', () => {
    expect(markupPct('130', '100')).toBeCloseTo(30);
    expect(markupPct('130', null)).toBeNull();
    expect(markupPct('130', '0')).toBeNull();
  });

  it('priceFromMarkup: cost*(1+m), cent-rounded', () => {
    expect(priceFromMarkup('100', 30)).toBe('130.00');
    expect(priceFromMarkup('9.99', 50)).toBe('14.99'); // 14.985 -> 14.99
  });

  it('computeQuoteProfit: net by cadence, excl tax, billed-only, flags missing cost', () => {
    const lineHelper = (o: Partial<QuoteLineForMath>) => ({
      quantity: '1', unitPrice: '0', taxable: false, customerVisible: true, recurrence: 'one_time' as const, ...o,
    });
    const r = computeQuoteProfit([
      lineHelper({ unitPrice: '130', unitCost: '100' }),                       // one-time net 30
      lineHelper({ unitPrice: '40', unitCost: '25', recurrence: 'monthly' }),  // monthly net 15
      lineHelper({ unitPrice: '50', unitCost: null }),                         // missing cost
      lineHelper({ unitPrice: '99', unitCost: '50', customerVisible: false }), // excluded (not billed)
    ]);
    expect(r.oneTimeNet).toBe('30.00');
    expect(r.monthlyRecurringNet).toBe('15.00');
    expect(r.totalCost).toBe('125.00');
    expect(r.linesMissingCost).toBe(1);
    // Revenue is split by the SAME cadence rule, over the SAME cost-bearing
    // lines as net (the missing-cost line contributes to neither) — the
    // denominator marginPct needs for a per-cadence percent.
    expect(r.oneTimeRevenue).toBe('130.00');
    expect(r.monthlyRecurringRevenue).toBe('40.00');
    expect(r.annualRecurringRevenue).toBe('0.00');
  });

  it('computeQuoteProfit: an EXPLICIT cost of 0 ("no cost", Task B1) is NOT missing — full price counts as net, distinct from a null (never-entered) cost', () => {
    const lineHelper = (o: Partial<QuoteLineForMath>) => ({
      quantity: '1', unitPrice: '0', taxable: false, customerVisible: true, recurrence: 'one_time' as const, ...o,
    });
    const r = computeQuoteProfit([
      lineHelper({ unitPrice: '150', unitCost: '0' }),   // explicit no-cost labor line — net = full price
      lineHelper({ unitPrice: '80', unitCost: null }),   // genuinely missing/unknown cost
    ]);
    expect(r.linesMissingCost).toBe(1); // only the null line, NOT the explicit-0 line
    expect(r.oneTimeNet).toBe('150.00'); // 150 - 0, the null-cost line contributes nothing
    expect(r.totalCost).toBe('0.00');
    expect(r.oneTimeRevenue).toBe('150.00'); // only the cost-bearing (incl. $0-cost) line's revenue
  });

  it('marginPct: net/revenue·100 (margin, not markup); null on div-by-zero/non-finite', () => {
    expect(marginPct('30', '50')).toBeCloseTo(60);
    expect(marginPct('-10', '50')).toBeCloseTo(-20); // a loss is a valid (negative) margin
    expect(marginPct('10', '0')).toBeNull(); // no revenue to compute a percent from
    expect(marginPct('10', '-5')).toBeNull(); // negative revenue is nonsensical, not "0%"
    expect(marginPct('10', Number.NaN)).toBeNull();
    expect(marginPct(Number.NaN, '50')).toBeNull();
  });
});

// Block-scoped so this `line` helper (default unitPrice '100.00') doesn't
// collide with the module-level `line` helper above (default unitPrice '0').
{
  const line = (over: Partial<QuoteLineForMath>): QuoteLineForMath => ({
    quantity: '1', unitPrice: '100.00', taxable: false, customerVisible: true,
    recurrence: 'one_time', ...over,
  });

  describe('deposit math', () => {
    it('percent deposit = percent of dueOnAcceptanceTotal (one-time + one-time tax)', () => {
      const lines = [
        line({ unitPrice: '1000.00', taxable: true }),
        line({ unitPrice: '500.00', recurrence: 'monthly' }), // recurring excluded
      ];
      // dueOnAcceptance = 1000 + 10% tax = 1100.00; 30% => 330.00
      const t = computeQuoteTotals(lines, 0.1, { type: 'percent', percent: 30 });
      expect(t.dueOnAcceptanceTotal).toBe('1100.00');
      expect(t.depositDueTotal).toBe('330.00');
    });

    it('percent deposit rounds half-up at the cent boundary', () => {
      // 33.335 => 33.34 (dueOnAcceptance 100.00, 33.335%)
      const t = computeQuoteTotals([line({ unitPrice: '100.00' })], null, { type: 'percent', percent: 33.335 });
      expect(t.depositDueTotal).toBe('33.34');
    });

    it('selected_lines deposit sums flagged one-time lines + tax on flagged taxable lines', () => {
      const lines = [
        line({ unitPrice: '6200.00', taxable: true, depositEligible: true, itemType: 'hardware' }),
        line({ unitPrice: '1100.00', taxable: false, depositEligible: true, itemType: 'hardware' }),
        line({ unitPrice: '2400.00', taxable: true, depositEligible: false }),           // not flagged
        line({ unitPrice: '99.00', depositEligible: true, recurrence: 'monthly' }),      // recurring never counts
        line({ unitPrice: '50.00', depositEligible: true, customerVisible: false }),     // hidden never counts
      ];
      // 6200 + 1100 + 10% of 6200 = 7920.00
      const t = computeQuoteTotals(lines, 0.1, { type: 'selected_lines' });
      expect(t.depositDueTotal).toBe('7920.00');
    });

    it('depositDueTotal is null for type none / missing config', () => {
      expect(computeQuoteTotals([line({})], null).depositDueTotal).toBeNull();
      expect(computeQuoteTotals([line({})], null, { type: 'none' }).depositDueTotal).toBeNull();
    });

    it('depositDueTotal is null (not "0.00") when a deposit computes to zero', () => {
      // A percent so small it rounds to $0.00, and a selected_lines deposit with no
      // eligible lines, must both collapse to null so the persisted snapshot and the
      // accept-time guard read them as "no deposit", not a bogus $0.00 deposit.
      expect(computeQuoteTotals([line({ unitPrice: '1.00' })], null, { type: 'percent', percent: 0.4 }).depositDueTotal).toBeNull();
      expect(computeQuoteTotals([line({ unitPrice: '100.00', depositEligible: false })], null, { type: 'selected_lines' }).depositDueTotal).toBeNull();
      // And null when the only one-time line was "deleted" (percent type, no one-time lines left).
      expect(computeQuoteTotals([line({ recurrence: 'monthly' })], null, { type: 'percent', percent: 30 }).depositDueTotal).toBeNull();
    });

    it('categoryBreakdown groups by itemType with manual lines under other, omitting empty categories', () => {
      const lines = [
        line({ unitPrice: '6200.00', itemType: 'hardware' }),
        line({ unitPrice: '1100.00', itemType: 'hardware' }),
        line({ unitPrice: '300.00', itemType: 'service', recurrence: 'monthly' }),
        line({ unitPrice: '2400.00' }), // manual, no itemType
        line({ unitPrice: '10.00', customerVisible: false, itemType: 'software' }), // hidden excluded entirely
      ];
      const t = computeQuoteTotals(lines, null);
      expect(t.categoryBreakdown).toEqual([
        { category: 'hardware', oneTimeTotal: '7300.00', monthlyTotal: '0.00', annualTotal: '0.00' },
        { category: 'service', oneTimeTotal: '0.00', monthlyTotal: '300.00', annualTotal: '0.00' },
        { category: 'other', oneTimeTotal: '2400.00', monthlyTotal: '0.00', annualTotal: '0.00' },
      ]);
    });
  });

  describe('validateQuoteDeposit', () => {
    it('accepts a valid percent deposit', () => {
      const r = validateQuoteDeposit([line({ unitPrice: '1000.00' })], null, { type: 'percent', percent: 30 });
      expect(r).toEqual({ ok: true, depositDueTotal: '300.00' });
    });
    it('type none is always ok with null total', () => {
      expect(validateQuoteDeposit([], null, { type: 'none' })).toEqual({ ok: true, depositDueTotal: null });
    });
    it('rejects deposit without one-time customer-visible lines', () => {
      const r = validateQuoteDeposit([line({ recurrence: 'monthly' })], null, { type: 'percent', percent: 30 });
      expect(r).toMatchObject({ ok: false, code: 'DEPOSIT_REQUIRES_ONE_TIME_LINES' });
    });
    it('rejects percent type without a usable percent', () => {
      // A missing/blank persisted percent normalizes to NaN — validation must
      // still fail it (the union makes `percent: null` unrepresentable).
      expect(validateQuoteDeposit([line({})], null, toQuoteDepositConfig('percent', null)))
        .toMatchObject({ ok: false, code: 'DEPOSIT_PERCENT_INVALID' });
      expect(validateQuoteDeposit([line({})], null, { type: 'percent', percent: Number.NaN }))
        .toMatchObject({ ok: false, code: 'DEPOSIT_PERCENT_INVALID' });
      expect(validateQuoteDeposit([line({})], null, { type: 'percent', percent: 100 }))
        .toMatchObject({ ok: false, code: 'DEPOSIT_PERCENT_INVALID' });
    });
    it('rejects a percent that rounds the deposit to zero cents', () => {
      // dueOnAcceptance 1.00; 0.4% => 0.4 cents => rounds to 0 — a $0.00 deposit is no deposit
      const r = validateQuoteDeposit([line({ unitPrice: '1.00' })], null, { type: 'percent', percent: 0.4 });
      expect(r).toMatchObject({ ok: false, code: 'DEPOSIT_PERCENT_INVALID' });
    });
    it('rejects selected_lines with no eligible one-time line', () => {
      const r = validateQuoteDeposit([line({ depositEligible: false })], null, { type: 'selected_lines' });
      expect(r).toMatchObject({ ok: false, code: 'DEPOSIT_NO_ELIGIBLE_LINES' });
    });
    it('rejects deposit >= dueOnAcceptanceTotal (all lines flagged = "no deposit")', () => {
      const r = validateQuoteDeposit([line({ depositEligible: true })], null, { type: 'selected_lines' });
      expect(r).toMatchObject({ ok: false, code: 'DEPOSIT_NOT_BELOW_TOTAL' });
    });
  });

  describe('toQuoteDepositConfig (flat DB/wire pair → union)', () => {
    it('maps each type, coercing numeric-string percents', () => {
      expect(toQuoteDepositConfig('none', null)).toEqual({ type: 'none' });
      expect(toQuoteDepositConfig('selected_lines', null)).toEqual({ type: 'selected_lines' });
      expect(toQuoteDepositConfig('percent', 30)).toEqual({ type: 'percent', percent: 30 });
      // DB numeric columns arrive as strings.
      expect(toQuoteDepositConfig('percent', '30.00')).toEqual({ type: 'percent', percent: 30 });
      // Zero/negative pass through as-is — the isFinite && >0 gates downstream
      // reject them, same as the pre-union Number() coercion did.
      expect(toQuoteDepositConfig('percent', 0)).toEqual({ type: 'percent', percent: 0 });
      expect(toQuoteDepositConfig('percent', '-5')).toEqual({ type: 'percent', percent: -5 });
    });

    it('treats a missing type as none', () => {
      expect(toQuoteDepositConfig(null, '30.00')).toEqual({ type: 'none' });
      expect(toQuoteDepositConfig(undefined, null)).toEqual({ type: 'none' });
    });

    it('drops a stray percent on non-percent types (illegal state normalized away)', () => {
      expect(toQuoteDepositConfig('selected_lines', '30.00')).toEqual({ type: 'selected_lines' });
      expect(toQuoteDepositConfig('none', 15)).toEqual({ type: 'none' });
    });

    it('normalizes a missing/blank percent on a percent deposit to NaN (still rejected, never silently "none")', () => {
      for (const missing of [null, undefined, '', '  '] as const) {
        const cfg = toQuoteDepositConfig('percent', missing);
        expect(cfg.type).toBe('percent');
        expect(cfg.type === 'percent' && Number.isNaN(cfg.percent)).toBe(true);
        // Compute treats it as "no deposit"…
        expect(computeQuoteTotals([line({ unitPrice: '100.00' })], null, cfg).depositDueTotal).toBeNull();
        // …but validation still hard-fails it, matching the pre-union behavior.
        expect(validateQuoteDeposit([line({ unitPrice: '100.00' })], null, cfg))
          .toMatchObject({ ok: false, code: 'DEPOSIT_PERCENT_INVALID' });
      }
    });
  });
}
