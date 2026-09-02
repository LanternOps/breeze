import { describe, it, expect } from 'vitest';
import {
  timeEntryToLineSpec, ticketPartToLineSpec, partitionByCurrency, partitionTimeEntries, mergeAssembly,
  UNKNOWN_CURRENCY_KEY, type DraftLineSpec
} from './invoiceAssembly';

describe('timeEntryToLineSpec', () => {
  it('converts minutes to hours and computes line total; flags unapproved; non-taxable', () => {
    const spec = timeEntryToLineSpec({
      id: 'te1', ticketId: 'tk1', description: 'Onsite repair',
      durationMinutes: 90, hourlyRate: '120.00', isApproved: false
    }, 'USD');
    expect(spec).toMatchObject({
      sourceType: 'time_entry', sourceId: 'te1', ticketId: 'tk1',
      description: 'Onsite repair', quantity: '1.50', unitPrice: '120.00',
      taxable: false, customerVisible: true, lineTotal: '180.00', isUnapprovedTime: true
    });
  });
  it('defaults the description; an explicit zero rate stays a valid zero line', () => {
    const spec = timeEntryToLineSpec({ id: 'te2', ticketId: null, description: null, durationMinutes: 0, hourlyRate: '0.00', isApproved: true }, 'USD');
    expect(spec.description).toBe('Labor');
    expect(spec.unitPrice).toBe('0.00');
    expect(spec.lineTotal).toBe('0.00');
    expect(spec.isUnapprovedTime).toBe(false);
  });
  it('one minute at 7.25/h is 0.15, not 0.14 (review #2: exact half-up, same as the SQL summary)', () => {
    const spec = timeEntryToLineSpec(
      { id: 'te3', ticketId: null, description: null, durationMinutes: 1, hourlyRate: '7.25', isApproved: true }, 'USD'
    );
    expect(spec.quantity).toBe('0.02');
    expect(spec.lineTotal).toBe('0.15');
  });
  it('never substitutes zero for a NULL rate — that is an assembly gap, not a free line (review #1)', () => {
    expect(() => timeEntryToLineSpec(
      { id: 'te2', ticketId: null, description: null, durationMinutes: 60, hourlyRate: null, isApproved: true }, 'USD'
    )).toThrow(/hourly rate/i);
  });
});

describe('timeEntryToLineSpec currency threading', () => {
  it('rounds the line total at the invoice currency minor unit (JPY → whole units)', () => {
    const spec = timeEntryToLineSpec({
      id: 'te3', ticketId: 'tk1', description: 'Onsite repair',
      durationMinutes: 90, hourlyRate: '333.00', isApproved: true
    }, 'JPY');
    // 1.50h * 333.00 = 499.50 → whole-yen half-up round, not cent rounding
    expect(spec.lineTotal).toBe('500.00');
  });

  it('applies the single labor rounding rule: hours to 2dp first, then round in the currency (20 min x 1,000 JPY = 330)', () => {
    const spec = timeEntryToLineSpec({
      id: 'te4', ticketId: 'tk1', description: null,
      durationMinutes: 20, hourlyRate: '1000', isApproved: true
    }, 'JPY');
    // 0.33 h x 1000 = 330 — never 333 / 333.33 (exact-hours product).
    expect(spec.quantity).toBe('0.33');
    expect(spec.lineTotal).toBe('330.00');
    expect(Number(spec.lineTotal)).toBe(330);
  });
});

describe('ticketPartToLineSpec', () => {
  it('rounds the line total at the invoice currency minor unit (JPY → whole units)', () => {
    const spec = ticketPartToLineSpec({
      id: 'p2', ticketId: 'tk1', catalogItemId: 'c1', description: 'Cable',
      quantity: '3', unitPrice: '333.50', costBasis: null
    }, 'JPY');
    // 3 * 333.50 = 1000.50 → '1001.00' (whole yen), never '1000.50'
    expect(spec.lineTotal).toBe('1001.00');
  });

  it('maps qty/price/cost; parts are taxable by default', () => {
    const spec = ticketPartToLineSpec({
      id: 'p1', ticketId: 'tk1', catalogItemId: 'c1', description: 'SSD 1TB',
      quantity: '2', unitPrice: '95.00', costBasis: '60.00'
    }, 'USD');
    expect(spec).toMatchObject({
      sourceType: 'part', sourceId: 'p1', ticketId: 'tk1', catalogItemId: 'c1',
      description: 'SSD 1TB', quantity: '2', unitPrice: '95.00', costBasis: '60.00',
      taxable: true, customerVisible: true, lineTotal: '190.00', isUnapprovedTime: false
    });
  });
});

describe('partitionByCurrency', () => {
  const toSpec = (row: { id: string; currencyCode: string | null }, currency: string): DraftLineSpec => ({
    sourceType: 'time_entry', sourceId: row.id, catalogItemId: null, ticketId: null,
    description: `row ${row.id} in ${currency}`, quantity: '1.00', unitPrice: '1.00', costBasis: null,
    taxable: false, customerVisible: true, lineTotal: '1.00', isUnapprovedTime: false
  });

  it('includes header-currency rows and buckets the rest by their own currency (null → UNKNOWN)', () => {
    const result = partitionByCurrency([
      { id: 'a', currencyCode: 'EUR' },
      { id: 'b', currencyCode: 'USD' },
      { id: 'c', currencyCode: null }
    ], 'EUR', toSpec);
    expect(result.included).toHaveLength(1);
    expect(result.included[0]!.sourceId).toBe('a');
    expect(result.blockedByCurrency.USD).toHaveLength(1);
    expect(result.blockedByCurrency.USD![0]!.sourceId).toBe('b');
    expect(result.blockedByCurrency[UNKNOWN_CURRENCY_KEY]).toHaveLength(1);
    expect(result.blockedByCurrency[UNKNOWN_CURRENCY_KEY]![0]!.sourceId).toBe('c');
    expect(Object.keys(result.blockedByCurrency).sort()).toEqual([UNKNOWN_CURRENCY_KEY, 'USD']);
  });

  it("builds blocked specs in the row's own currency and included specs in the header currency", () => {
    const result = partitionByCurrency([
      { id: 'a', currencyCode: 'EUR' },
      { id: 'b', currencyCode: 'JPY' },
      { id: 'c', currencyCode: null }
    ], 'EUR', toSpec);
    expect(result.included[0]!.description).toBe('row a in EUR');
    expect(result.blockedByCurrency.JPY![0]!.description).toBe('row b in JPY');
    // Null snapshot: no currency to round in, fall back to the header currency.
    expect(result.blockedByCurrency[UNKNOWN_CURRENCY_KEY]![0]!.description).toBe('row c in EUR');
  });

  it('blocked totals are honest in the source currency (JPY row on a USD header rounds to whole yen)', () => {
    const result = partitionByCurrency(
      [{ id: 'te', ticketId: null, description: null, durationMinutes: 20, hourlyRate: '1000', isApproved: true, currencyCode: 'JPY' }],
      'USD', timeEntryToLineSpec
    );
    expect(result.included).toEqual([]);
    expect(result.blockedByCurrency.JPY![0]!.lineTotal).toBe('330.00');
  });

  it('returns empty buckets for no rows and never creates keys for empty buckets', () => {
    const result = partitionByCurrency([], 'USD', toSpec);
    expect(result).toEqual({ included: [], blockedByCurrency: {}, missingRate: [] });
    const onlyIncluded = partitionByCurrency([{ id: 'a', currencyCode: 'USD' }], 'USD', toSpec);
    expect(onlyIncluded.blockedByCurrency).toEqual({});
  });
});

describe('partitionTimeEntries — null rate is a structured gap, never zero (review #1)', () => {
  const row = (id: string, hourlyRate: string | null, currencyCode: string | null = 'EUR') => ({
    id, ticketId: 'tk1', description: 'Work', durationMinutes: 90, hourlyRate, isApproved: true, currencyCode
  });

  it('routes a null-rate entry to missingRate with its hours, and neither includes nor currency-blocks it', () => {
    const result = partitionTimeEntries([row('a', '100.00'), row('b', null)], 'EUR');
    expect(result.included.map((s) => s.sourceId)).toEqual(['a']);
    expect(result.blockedByCurrency).toEqual({});
    expect(result.missingRate).toEqual([
      { sourceType: 'time_entry', sourceId: 'b', ticketId: 'tk1', description: 'Work', quantity: '1.50', currencyCode: 'EUR' }
    ]);
  });

  it('a null-rate entry in another currency is still a missing-rate gap (there is no amount to block)', () => {
    const result = partitionTimeEntries([row('b', null, 'USD')], 'EUR');
    expect(result.included).toEqual([]);
    expect(result.blockedByCurrency).toEqual({});
    expect(result.missingRate.map((m) => m.sourceId)).toEqual(['b']);
  });

  it('an explicit 0.00 rate is a valid zero line, not a gap', () => {
    const result = partitionTimeEntries([row('z', '0.00')], 'EUR');
    expect(result.missingRate).toEqual([]);
    expect(result.included).toHaveLength(1);
    expect(result.included[0]).toMatchObject({ sourceId: 'z', unitPrice: '0.00', lineTotal: '0.00' });
  });

  it('rated rows in another currency still go to blockedByCurrency', () => {
    const result = partitionTimeEntries([row('u', '50.00', 'USD')], 'EUR');
    expect(result.blockedByCurrency.USD!.map((s) => s.sourceId)).toEqual(['u']);
    expect(result.missingRate).toEqual([]);
  });
});

describe('mergeAssembly', () => {
  const spec = (id: string): DraftLineSpec => ({
    sourceType: 'part', sourceId: id, catalogItemId: null, ticketId: null, description: id,
    quantity: '1', unitPrice: '1.00', costBasis: null, taxable: true, customerVisible: true,
    lineTotal: '1.00', isUnapprovedTime: false
  });

  it('concatenates included and merges blocked keys across parts', () => {
    const gap = (id: string) => ({ sourceType: 'time_entry' as const, sourceId: id, ticketId: null, description: id, quantity: '1.00', currencyCode: 'USD' });
    const merged = mergeAssembly(
      { included: [spec('a')], blockedByCurrency: { USD: [spec('b')], GBP: [spec('c')] }, missingRate: [gap('m1')] },
      { included: [spec('d')], blockedByCurrency: { USD: [spec('e')] }, missingRate: [] },
      { included: [], blockedByCurrency: {}, missingRate: [gap('m2')] }
    );
    expect(merged.included.map((s) => s.sourceId)).toEqual(['a', 'd']);
    expect(merged.missingRate.map((m) => m.sourceId)).toEqual(['m1', 'm2']);
    expect(merged.blockedByCurrency.USD!.map((s) => s.sourceId)).toEqual(['b', 'e']);
    expect(merged.blockedByCurrency.GBP!.map((s) => s.sourceId)).toEqual(['c']);
    expect(Object.keys(merged.blockedByCurrency).sort()).toEqual(['GBP', 'USD']);
  });

  it('returns empty result with no parts and does not mutate inputs', () => {
    expect(mergeAssembly()).toEqual({ included: [], blockedByCurrency: {}, missingRate: [] });
    const part = { included: [spec('a')], blockedByCurrency: { USD: [spec('b')] }, missingRate: [] };
    const merged = mergeAssembly(part, part);
    expect(merged.included).toHaveLength(2);
    expect(merged.blockedByCurrency.USD).toHaveLength(2);
    expect(part.included).toHaveLength(1);
    expect(part.blockedByCurrency.USD).toHaveLength(1);
  });
});
