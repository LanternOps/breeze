import { describe, it, expect } from 'vitest';
import {
  buildGroupsParam,
  selectApproxTotal,
  type ReportingTotalResponse,
} from './approximateTotal';

const base = {
  targetCurrencyCode: 'CAD',
  requestedDate: '2026-09-03',
  maxStalenessDays: 7,
  groups: [],
  unavailableCurrencyCodes: [],
} as const;

describe('buildGroupsParam', () => {
  it('sorts, deduplicates by summing nothing and quantizes amounts to the minor unit', () => {
    expect(buildGroupsParam([{ code: 'usd', amount: 12300 }, { code: 'EUR', amount: '4100.00' }]))
      .toBe('EUR:4100.00,USD:12300.00');
  });
  it('is empty for an empty book', () => {
    expect(buildGroupsParam([])).toBe('');
  });
  it('drops groups with a blank code rather than sending a malformed pair', () => {
    expect(buildGroupsParam([{ code: '', amount: 1 }, { code: 'USD', amount: 2 }])).toBe('USD:2.00');
  });
  it('keeps the first group for an uppercased, trimmed currency code', () => {
    expect(buildGroupsParam([
      { code: ' usd ', amount: '1.25' },
      { code: 'USD', amount: '99.00' },
    ])).toBe('USD:1.25');
  });
  it('does not replace an invalid first occurrence with a later duplicate', () => {
    expect(buildGroupsParam([
      { code: 'USD', amount: '-1' },
      { code: 'usd', amount: '2.00' },
    ])).toBe('');
  });

  it('quantizes the float residue a per-currency rollup accumulates', () => {
    // Exactly what `sumByCurrency` produces: twelve two-decimal amounts added
    // as JS numbers. The raw sum carries >2 decimals and the server would
    // reject it with 400 INVALID_RATE, hiding the line.
    const parts = [1234.56, 89.99, 4321.01, 77.77, 1000.10, 250.25, 19.99, 8888.88, 6.66, 4444.44, 33.33, 12.17];
    const sum = parts.reduce((acc, n) => acc + n, 0);
    expect(String(sum)).not.toMatch(/^\d+(\.\d{1,2})?$/); // residue really is there
    expect(buildGroupsParam([{ code: 'USD', amount: sum }])).toBe(`USD:${sum.toFixed(2)}`);
  });

  it('quantizes at the ZERO-decimal minor unit for JPY', () => {
    expect(buildGroupsParam([{ code: 'JPY', amount: '1000.4' }])).toBe('JPY:1000.00');
    expect(buildGroupsParam([{ code: 'JPY', amount: '1000.5' }])).toBe('JPY:1001.00');
  });

  it('suppresses the WHOLE line when any leg is negative — never a partial basis', () => {
    // A credit note / refund adjustment can push one currency negative. Sending
    // only the positive legs would get an `available` total whose basis omits a
    // currency, which is exactly the partial approximation the spec forbids.
    expect(buildGroupsParam([{ code: 'USD', amount: 100 }, { code: 'EUR', amount: -5 }])).toBe('');
  });

  it('suppresses the WHOLE line when any leg is non-finite', () => {
    expect(buildGroupsParam([{ code: 'USD', amount: 100 }, { code: 'EUR', amount: Number.NaN }])).toBe('');
    expect(buildGroupsParam([{ code: 'USD', amount: 100 }, { code: 'EUR', amount: Number.POSITIVE_INFINITY }])).toBe('');
    expect(buildGroupsParam([{ code: 'USD', amount: 100 }, { code: 'EUR', amount: 'not-a-number' }])).toBe('');
  });

  it('accepts whitespace and exponent-notation amounts a rollup can hand it', () => {
    expect(buildGroupsParam([{ code: 'GBP', amount: ' 2.00 ' }, { code: 'EUR', amount: '1e3' }]))
      .toBe('EUR:1000.00,GBP:2.00');
  });
});

describe('selectApproxTotal', () => {
  it('shows the server total verbatim — this module never multiplies', () => {
    const res: ReportingTotalResponse = {
      ...base, status: 'available', rateDate: '2026-09-01', total: '23336.00',
    };
    expect(selectApproxTotal(res)).toEqual({
      status: 'available', amount: '23336.00', currencyCode: 'CAD', rateDate: '2026-09-01',
    });
  });

  it.each([
    ['a null response (not loaded / failed)', null],
    ['not-needed (single-currency book)', { ...base, status: 'not-needed', rateDate: null, total: '540.00' }],
    ['unavailable (any missing or stale leg)', { ...base, status: 'unavailable', rateDate: null, total: null, unavailableCurrencyCodes: ['EUR'] }],
    ['available but with no total', { ...base, status: 'available', rateDate: '2026-09-01', total: null }],
    ['available but with no rate date', { ...base, status: 'available', rateDate: null, total: '1.00' }],
  ])('hides the line for %s', (_label, res) => {
    expect(selectApproxTotal(res as ReportingTotalResponse | null)).toEqual({ status: 'hidden' });
  });
});
