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
      .toEqual({ kind: 'query', value: 'EUR:4100.00,USD:12300.00' });
  });
  it('is `empty` — not `invalid` — for an empty book: nothing to ask, nothing to say', () => {
    expect(buildGroupsParam([])).toEqual({ kind: 'empty' });
  });
  it('drops groups with a blank code rather than sending a malformed pair', () => {
    expect(buildGroupsParam([{ code: '', amount: 1 }, { code: 'USD', amount: 2 }]))
      .toEqual({ kind: 'query', value: 'USD:2.00' });
  });
  it('keeps the first group for an uppercased, trimmed currency code', () => {
    expect(buildGroupsParam([
      { code: ' usd ', amount: '1.25' },
      { code: 'USD', amount: '99.00' },
    ])).toEqual({ kind: 'query', value: 'USD:1.25' });
  });
  it('does not replace an invalid first occurrence with a later duplicate', () => {
    expect(buildGroupsParam([
      { code: 'USD', amount: '-1' },
      { code: 'usd', amount: '2.00' },
    ])).toEqual({ kind: 'invalid' });
  });

  it('quantizes the float residue a per-currency rollup accumulates', () => {
    // Exactly what `sumByCurrency` produces: twelve two-decimal amounts added
    // as JS numbers. The raw sum carries >2 decimals and the server would
    // reject it with 400 INVALID_RATE, hiding the line.
    const parts = [1234.56, 89.99, 4321.01, 77.77, 1000.10, 250.25, 19.99, 8888.88, 6.66, 4444.44, 33.33, 12.17];
    const sum = parts.reduce((acc, n) => acc + n, 0);
    expect(String(sum)).not.toMatch(/^\d+(\.\d{1,2})?$/); // residue really is there
    expect(buildGroupsParam([{ code: 'USD', amount: sum }]))
      .toEqual({ kind: 'query', value: `USD:${sum.toFixed(2)}` });
  });

  it('quantizes at the ZERO-decimal minor unit for JPY', () => {
    expect(buildGroupsParam([{ code: 'JPY', amount: '1000.4' }])).toEqual({ kind: 'query', value: 'JPY:1000.00' });
    expect(buildGroupsParam([{ code: 'JPY', amount: '1000.5' }])).toEqual({ kind: 'query', value: 'JPY:1001.00' });
  });

  it('suppresses the WHOLE line when any leg is negative — never a partial basis', () => {
    // A credit note / refund adjustment can push one currency negative. Sending
    // only the positive legs would get an `available` total whose basis omits a
    // currency, which is exactly the partial approximation the spec forbids.
    expect(buildGroupsParam([{ code: 'USD', amount: 100 }, { code: 'EUR', amount: -5 }]))
      .toEqual({ kind: 'invalid' });
  });

  it('suppresses the WHOLE line when any leg is non-finite', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 'not-a-number'] as const) {
      expect(buildGroupsParam([{ code: 'USD', amount: 100 }, { code: 'EUR', amount: bad }]))
        .toEqual({ kind: 'invalid' });
    }
  });

  it('accepts whitespace and exponent-notation amounts a rollup can hand it', () => {
    expect(buildGroupsParam([{ code: 'GBP', amount: ' 2.00 ' }, { code: 'EUR', amount: '1e3' }]))
      .toEqual({ kind: 'query', value: 'EUR:1000.00,GBP:2.00' });
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
    ['a null response (nothing was asked)', null],
    ['not-needed (single-currency book)', { ...base, status: 'not-needed', rateDate: null, total: '540.00' }],
  ])('hides the line for %s — these are the ONLY two states with nothing to say', (_label, res) => {
    expect(selectApproxTotal(res as ReportingTotalResponse | null)).toEqual({ status: 'hidden' });
  });

  // #4415: `unavailable` is a rich answer, not an absence. Collapsing it into
  // `hidden` is what made four consecutive releases ship a line that silently
  // never rendered for partners with no exchange-rate coverage.
  it('surfaces `unavailable` with the codes the server could not convert', () => {
    const res: ReportingTotalResponse = {
      ...base,
      status: 'unavailable',
      rateDate: null,
      total: null,
      groups: [
        { currencyCode: 'USD', amount: '1.00', convertedAmount: null, rate: null, rateDate: null, source: null },
        { currencyCode: 'NGN', amount: '2.00', convertedAmount: null, rate: null, rateDate: null, source: null, reason: 'missing' },
      ],
      unavailableCurrencyCodes: ['NGN'],
    };
    expect(selectApproxTotal(res)).toEqual({
      status: 'unavailable', currencyCodes: ['NGN'], targetCurrencyCode: 'CAD', reason: 'missing',
    });
  });

  it('carries the `stale` reason through rather than flattening every failure to one word', () => {
    const res: ReportingTotalResponse = {
      ...base,
      status: 'unavailable',
      rateDate: null,
      total: null,
      groups: [{ currencyCode: 'EUR', amount: '2.00', convertedAmount: null, rate: null, rateDate: null, source: null, reason: 'stale' }],
      unavailableCurrencyCodes: ['EUR'],
    };
    expect(selectApproxTotal(res)).toEqual({
      status: 'unavailable', currencyCodes: ['EUR'], targetCurrencyCode: 'CAD', reason: 'stale',
    });
  });

  it('reports `mixed` when the failing legs disagree — never picks one and hides the other', () => {
    const res: ReportingTotalResponse = {
      ...base,
      status: 'unavailable',
      rateDate: null,
      total: null,
      groups: [
        { currencyCode: 'EUR', amount: '2.00', convertedAmount: null, rate: null, rateDate: null, source: null, reason: 'stale' },
        { currencyCode: 'NGN', amount: '3.00', convertedAmount: null, rate: null, rateDate: null, source: null, reason: 'missing' },
      ],
      unavailableCurrencyCodes: ['EUR', 'NGN'],
    };
    expect(selectApproxTotal(res)).toEqual({
      status: 'unavailable', currencyCodes: ['EUR', 'NGN'], targetCurrencyCode: 'CAD', reason: 'mixed',
    });
  });

  it('reports `mixed` when the server names codes but no reason at all', () => {
    const res: ReportingTotalResponse = {
      ...base, status: 'unavailable', rateDate: null, total: null, unavailableCurrencyCodes: ['ZAR'],
    };
    expect(selectApproxTotal(res)).toEqual({
      status: 'unavailable', currencyCodes: ['ZAR'], targetCurrencyCode: 'CAD', reason: 'mixed',
    });
  });

  it.each([
    ['available but with no total', { ...base, status: 'available', rateDate: '2026-09-01', total: null }],
    ['available but with no rate date', { ...base, status: 'available', rateDate: null, total: '1.00' }],
  ])('treats an unusable `available` body as unavailable, not as silence: %s', (_label, res) => {
    expect(selectApproxTotal(res as ReportingTotalResponse | null)).toEqual({
      status: 'unavailable', currencyCodes: [], targetCurrencyCode: 'CAD', reason: 'mixed',
    });
  });

  it('ignores a reason outside the contract rather than reporting it as `missing`', () => {
    // The body is unvalidated JSON at this point: a drifted server must not be
    // able to make the copy assert a cause the contract has no word for.
    const res = {
      ...base, status: 'unavailable', rateDate: null, total: null,
      groups: [{ currencyCode: 'EUR', amount: '2.00', convertedAmount: null, rate: null, rateDate: null, source: null, reason: 'gremlins' }],
      unavailableCurrencyCodes: ['EUR'],
    } as unknown as ReportingTotalResponse;
    expect(selectApproxTotal(res)).toEqual({
      status: 'unavailable', currencyCodes: ['EUR'], targetCurrencyCode: 'CAD', reason: 'mixed',
    });
  });

  it('ignores the reason of a group the server did NOT flag as unavailable', () => {
    const res: ReportingTotalResponse = {
      ...base,
      status: 'unavailable',
      rateDate: null,
      total: null,
      groups: [
        { currencyCode: 'EUR', amount: '2.00', convertedAmount: null, rate: null, rateDate: null, source: null, reason: 'stale' },
        { currencyCode: 'NGN', amount: '3.00', convertedAmount: null, rate: null, rateDate: null, source: null, reason: 'missing' },
      ],
      unavailableCurrencyCodes: ['NGN'],
    };
    expect(selectApproxTotal(res)).toEqual({
      status: 'unavailable', currencyCodes: ['NGN'], targetCurrencyCode: 'CAD', reason: 'missing',
    });
  });

  it('deduplicates and uppercases the codes it reports', () => {
    const res = {
      ...base, status: 'unavailable', rateDate: null, total: null,
      unavailableCurrencyCodes: ['ngn', 'NGN', 'eur'],
    } as unknown as ReportingTotalResponse;
    expect(selectApproxTotal(res)).toEqual({
      status: 'unavailable', currencyCodes: ['NGN', 'EUR'], targetCurrencyCode: 'CAD', reason: 'mixed',
    });
  });
});
