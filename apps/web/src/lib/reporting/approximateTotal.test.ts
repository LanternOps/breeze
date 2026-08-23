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
  it('sorts, deduplicates by summing nothing and normalizes amounts to strings', () => {
    expect(buildGroupsParam([{ code: 'usd', amount: 12300 }, { code: 'EUR', amount: '4100.00' }]))
      .toBe('EUR:4100.00,USD:12300');
  });
  it('is empty for an empty book', () => {
    expect(buildGroupsParam([])).toBe('');
  });
  it('drops groups with a blank code rather than sending a malformed pair', () => {
    expect(buildGroupsParam([{ code: '', amount: 1 }, { code: 'USD', amount: 2 }])).toBe('USD:2');
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
  it('skips amounts that are not plain non-negative decimals', () => {
    expect(buildGroupsParam([
      { code: 'CAD', amount: '-1' },
      { code: 'EUR', amount: '1e3' },
      { code: 'GBP', amount: ' 2.00 ' },
      { code: 'USD', amount: Number.NaN },
    ])).toBe('GBP:2.00');
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
