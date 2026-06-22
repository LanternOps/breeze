import { describe, it, expect } from 'vitest';
import { addMonthsToDate, buildContractSpecsFromQuote } from './quoteToContract';
import type { QuoteForContract, QuoteLineForContract } from './quoteToContract';

const quote: QuoteForContract = {
  orgId: 'org-1',
  partnerId: 'partner-1',
  quoteNumber: 'Q-1001',
  currencyCode: 'USD',
  terms: 'Net 30',
};

function line(over: Partial<QuoteLineForContract>): QuoteLineForContract {
  return {
    recurrence: 'monthly',
    customerVisible: true,
    description: 'Managed endpoint',
    unitPrice: '99.00',
    quantity: '1',
    taxable: false,
    catalogItemId: null,
    termMonths: null,
    ...over,
  };
}

describe('addMonthsToDate', () => {
  it('adds whole months, date-only, UTC', () => {
    expect(addMonthsToDate('2026-06-21', 12)).toBe('2027-06-21');
    expect(addMonthsToDate('2026-06-21', 1)).toBe('2026-07-21');
  });

  it('rolls month overflow forward', () => {
    // Jan 31 + 1 month has no Feb 31 -> JS rolls into March (acceptable, documented).
    expect(addMonthsToDate('2026-01-31', 1)).toBe('2026-03-03');
  });

  it('throws on malformed date string', () => {
    expect(() => addMonthsToDate('2026-6-1', 1)).toThrow();
    expect(() => addMonthsToDate('not-a-date', 1)).toThrow();
  });

  it('throws on non-positive months', () => {
    expect(() => addMonthsToDate('2026-06-21', 0)).toThrow();
    expect(() => addMonthsToDate('2026-06-21', -1)).toThrow();
  });
});

describe('buildContractSpecsFromQuote', () => {
  it('returns no specs when there are no recurring lines', () => {
    const specs = buildContractSpecsFromQuote(
      quote,
      [line({ recurrence: 'one_time' })],
      '2026-06-21',
      'user-1',
    );
    expect(specs).toEqual([]);
  });

  it('groups all monthly lines into one interval=1 contract', () => {
    const specs = buildContractSpecsFromQuote(
      quote,
      [
        line({ recurrence: 'monthly', description: 'EDR', unitPrice: '10.00', quantity: '25' }),
        line({ recurrence: 'monthly', description: 'Backup', unitPrice: '5.00', taxable: true }),
        line({ recurrence: 'one_time', description: 'Onboarding' }),
      ],
      '2026-06-21',
      'user-1',
    );
    expect(specs).toHaveLength(1);
    const c = specs[0]!;
    expect(c.intervalMonths).toBe(1);
    expect(c.notes).toBe('Auto-created from accepted quote Q-1001');
    expect(c.billingTiming).toBe('advance');
    expect(c.orgId).toBe('org-1');
    expect(c.partnerId).toBe('partner-1');
    expect(c.currencyCode).toBe('USD');
    expect(c.terms).toBe('Net 30');
    expect(c.createdBy).toBe('user-1');
    expect(c.name).toBe('Q-1001 — Monthly');
    expect(c.lines.map((l) => l.description)).toEqual(['EDR', 'Backup']);
    expect(c.lines.every((l) => l.lineType === 'manual')).toBe(true);
    expect(c.lines[1]!.taxable).toBe(true);
    expect(c.lines.map((l) => l.sortOrder)).toEqual([0, 1]);
    expect(c.lines[0]!.manualQuantity).toBe('25');
    expect(c.lines[0]!.unitPrice).toBe('10.00');
  });

  it('produces two contracts when both monthly and annual lines exist', () => {
    const specs = buildContractSpecsFromQuote(
      quote,
      [
        line({ recurrence: 'monthly', description: 'EDR' }),
        line({ recurrence: 'annual', description: 'License', unitPrice: '1200.00' }),
      ],
      '2026-06-21',
      'user-1',
    );
    expect(specs).toHaveLength(2);
    const monthly = specs.find((s) => s.intervalMonths === 1)!;
    const annual = specs.find((s) => s.intervalMonths === 12)!;
    expect(monthly.name).toBe('Q-1001 — Monthly');
    expect(annual.name).toBe('Q-1001 — Annual');
    expect(monthly.lines).toHaveLength(1);
    expect(annual.lines).toHaveLength(1);
  });

  it('excludes non-customer-visible recurring lines', () => {
    const specs = buildContractSpecsFromQuote(
      quote,
      [line({ recurrence: 'monthly', customerVisible: false })],
      '2026-06-21',
      'user-1',
    );
    expect(specs).toEqual([]);
  });

  it('sets endDate from a single unambiguous termMonths, else null', () => {
    const uniform = buildContractSpecsFromQuote(
      quote,
      [
        line({ recurrence: 'monthly', termMonths: 12 }),
        line({ recurrence: 'monthly', termMonths: 12 }),
      ],
      '2026-06-21',
      'user-1',
    );
    expect(uniform[0]!.endDate).toBe('2027-06-21');

    const mixed = buildContractSpecsFromQuote(
      quote,
      [
        line({ recurrence: 'monthly', termMonths: 12 }),
        line({ recurrence: 'monthly', termMonths: 24 }),
      ],
      '2026-06-21',
      'user-1',
    );
    expect(mixed[0]!.endDate).toBeNull();
  });

  it('leaves endDate null when no line carries a termMonths', () => {
    const specs = buildContractSpecsFromQuote(
      quote,
      [
        line({ recurrence: 'monthly', termMonths: null }),
        line({ recurrence: 'monthly', termMonths: null }),
      ],
      '2026-06-21',
      'user-1',
    );
    expect(specs[0]!.endDate).toBeNull();
  });

  it('falls back to USD when the quote has no currency', () => {
    const specs = buildContractSpecsFromQuote(
      { ...quote, currencyCode: null },
      [line({ recurrence: 'monthly' })],
      '2026-06-21',
      'user-1',
    );
    expect(specs[0]!.currencyCode).toBe('USD');
  });

  it('drops catalogItemId so the contract bills the frozen quote price, not the live catalog price', () => {
    const specs = buildContractSpecsFromQuote(
      quote,
      [line({ recurrence: 'monthly', catalogItemId: 'cat-123', unitPrice: '42.00' })],
      '2026-06-21',
      'user-1',
    );
    expect(specs[0]!.lines[0]!.catalogItemId).toBeNull();
    expect(specs[0]!.lines[0]!.unitPrice).toBe('42.00');
  });

  it('annual line with termMonths=12 gets endDate; monthly line with termMonths=null gets endDate===null', () => {
    const specs = buildContractSpecsFromQuote(
      quote,
      [
        line({ recurrence: 'annual', termMonths: 12, description: 'Annual license', unitPrice: '1200.00' }),
        line({ recurrence: 'monthly', termMonths: null, description: 'Monthly mgmt', unitPrice: '99.00' }),
      ],
      '2026-06-21',
      'user-1',
    );
    expect(specs).toHaveLength(2);
    const annual = specs.find((s) => s.intervalMonths === 12)!;
    const monthly = specs.find((s) => s.intervalMonths === 1)!;
    expect(annual.endDate).toBe(addMonthsToDate('2026-06-21', 12));
    expect(monthly.endDate).toBeNull();
  });
});
