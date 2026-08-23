import { describe, it, expect, vi, beforeEach } from 'vitest';
import { multiplyToCurrency } from '@breeze/shared';

// ---------------------------------------------------------------------------
// Server-side reporting totals (multi-currency spec §8, wave 7 #3779).
//
// The properties under test are the ones that make the "≈ approximate" line
// honest: ONE unavailable leg suppresses the WHOLE total (never a partial sum,
// never a placeholder, never a zero); the disclosed rate date is the OLDEST
// contributing leg; and the sum accumulates in bigint minor units, so a
// portfolio above Number.MAX_SAFE_INTEGER minor units totals EXACTLY.
//
// `convertForReporting` (the spec's reporting primitive) is mocked — this suite
// owns the totalling, not the FX resolution, which exchangeRateService.test.ts
// and its integration twin already prove.
// ---------------------------------------------------------------------------

const { FakeExchangeRateServiceError, convertForReporting, convertForReportingBatch } = vi.hoisted(() => ({
  FakeExchangeRateServiceError: class ExchangeRateServiceError extends Error {
    constructor(
      public readonly status: number,
      public readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = 'ExchangeRateServiceError';
    }
  },
  convertForReporting: vi.fn(),
  convertForReportingBatch: vi.fn(),
}));

vi.mock('./exchangeRateService', () => ({
  DEFAULT_MAX_STALENESS_DAYS: 7,
  ExchangeRateServiceError: FakeExchangeRateServiceError,
  assertIsoDate: (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ''))) {
      throw new FakeExchangeRateServiceError(400, 'INVALID_DATE', `"${value}" is not an ISO calendar date`);
    }
    return value;
  },
  convertForReporting: (...args: unknown[]) => convertForReporting(...args),
  // The batch primitive the module under test actually calls. Delegating to the
  // same per-pair mock keeps every rate/unavailability fixture below unchanged
  // while the production path stays single-snapshot.
  convertForReportingBatch: (
    items: readonly { amount: string; from: string }[], to: string, date: string,
  ) => {
    convertForReportingBatch(items, to, date);
    return Promise.all(items.map((i) => convertForReporting(i.amount, i.from, to, date)));
  },
}));

/** Terminal rows for the single `partners` read in resolvePartnerReportingCurrency. */
const { state: dbState } = vi.hoisted(() => ({
  state: {
    partnerRows: [] as unknown[],
    selectWheres: [] as unknown[],
    /** Context depth captured AT the moment `db.select()` ran, per read. */
    selectContexts: [] as { system: boolean; outsideRequestContext: boolean }[],
    systemDepth: 0,
    outsideDepth: 0,
  },
}));

vi.mock('../db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'limit']) {
    chain[m] = vi.fn((payload?: unknown) => {
      if (m === 'where') dbState.selectWheres.push(payload);
      return chain;
    });
  }
  (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) => resolve(dbState.partnerRows);
  return {
    db: {
      select: vi.fn(() => {
        dbState.selectContexts.push({
          system: dbState.systemDepth > 0,
          outsideRequestContext: dbState.outsideDepth > 0,
        });
        return chain;
      }),
    },
    // Faithful enough for the property under test: which context a read runs in.
    runOutsideDbContext: <T,>(fn: () => T): T => {
      dbState.outsideDepth += 1;
      try { return fn(); } finally { dbState.outsideDepth -= 1; }
    },
    withSystemDbAccessContext: async <T,>(fn: () => Promise<T>): Promise<T> => {
      dbState.systemDepth += 1;
      try { return await fn(); } finally { dbState.systemDepth -= 1; }
    },
  };
});

import {
  computeReportingTotal,
  parseGroupsParam,
  resolvePartnerReportingCurrency,
} from './reportingTotals';

const DATE = '2026-09-03';

/** Rate table for the mock: `${from}->${to}` → [rate, rateDate, source]. */
type RateSpec = [rate: string, rateDate: string, source: 'ecb' | 'manual' | 'mixed'];
let rates: Record<string, RateSpec> = {};
/** Currencies whose leg is unavailable, with the reason the FX service reports. */
let unavailable: Record<string, 'missing' | 'stale'> = {};

function installFxMock(): void {
  convertForReporting.mockImplementation(async (amount: string, from: string, to: string, date: string) => {
    if (from === to) {
      return {
        status: 'available', fromCode: from, toCode: to, requestedDate: date,
        rate: '1.00000000', rateDate: date, source: 'identity', legs: [],
        amount: String(amount), convertedAmount: multiplyToCurrency(amount, '1', to),
      };
    }
    const badLegs = [from, to].filter((c) => unavailable[c]);
    if (badLegs.length > 0) {
      return {
        status: 'unavailable', fromCode: from, toCode: to, requestedDate: date,
        unavailableLegs: badLegs.map((c) => ({ currencyCode: c, reason: unavailable[c]! })),
      };
    }
    const spec = rates[`${from}->${to}`] ?? ['1.00000000', date, 'ecb' as const];
    const [rate, rateDate, source] = spec;
    return {
      status: 'available', fromCode: from, toCode: to, requestedDate: date,
      rate, rateDate, source, legs: [],
      amount: String(amount), convertedAmount: multiplyToCurrency(amount, rate, to),
    };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  rates = {};
  unavailable = {};
  dbState.partnerRows = [];
  dbState.selectWheres.length = 0;
  installFxMock();
});

describe('computeReportingTotal', () => {
  it('reports not-needed — with the exact native sum — when every group is already in the target', async () => {
    const result = await computeReportingTotal(
      [{ currencyCode: 'USD', amount: '100.25' }, { currencyCode: 'USD', amount: '0.75' }], 'USD', DATE);
    expect(result.status).toBe('not-needed');
    expect(result.total).toBe('101.00');
    expect(result.targetCurrencyCode).toBe('USD');
    expect(result.requestedDate).toBe(DATE);
    expect(result.maxStalenessDays).toBe(7);
    expect(result.unavailableCurrencyCodes).toEqual([]);
  });

  it('reports not-needed with a null total for an empty group list', async () => {
    const result = await computeReportingTotal([], 'EUR', DATE);
    expect(result.status).toBe('not-needed');
    expect(result.total).toBeNull();
    expect(result.groups).toEqual([]);
    expect(convertForReporting).not.toHaveBeenCalled();
    expect(convertForReportingBatch).not.toHaveBeenCalled();
  });

  it('totals mixed groups exactly and discloses the OLDEST contributing rate date', async () => {
    rates['USD->CAD'] = ['1.35000000', '2026-09-02', 'ecb'];
    rates['EUR->CAD'] = ['1.50000000', '2026-08-30', 'manual'];
    const result = await computeReportingTotal([
      { currencyCode: 'USD', amount: '100.00' },
      { currencyCode: 'EUR', amount: '200.00' },
      { currencyCode: 'CAD', amount: '10.00' },
    ], 'CAD', DATE);

    expect(result.status).toBe('available');
    // 135.00 + 300.00 + 10.00
    expect(result.total).toBe('445.00');
    // The label never claims more freshness than its weakest leg.
    expect(result.rateDate).toBe('2026-08-30');
    expect(result.groups.map((g) => [g.currencyCode, g.convertedAmount, g.rate, g.source])).toEqual([
      ['USD', '135.00', '1.35000000', 'ecb'],
      ['EUR', '300.00', '1.50000000', 'manual'],
      ['CAD', '10.00', '1.00000000', 'identity'],
    ]);
    expect(result.unavailableCurrencyCodes).toEqual([]);
  });

  // Under READ COMMITTED each statement takes its OWN snapshot, so a total
  // assembled from one FX round trip per group can mix legs from two database
  // states (the hybrid cross-rate failure, one layer up) — and costs up to 2N
  // round trips per dashboard request. The whole total must come from ONE
  // batched call covering every source currency AND the target.
  it('resolves every group in ONE batched FX call — never one round trip per group', async () => {
    rates['USD->CAD'] = ['1.35000000', '2026-09-02', 'ecb'];
    rates['EUR->CAD'] = ['1.50000000', '2026-09-02', 'ecb'];
    rates['GBP->CAD'] = ['1.70000000', '2026-09-02', 'ecb'];
    await computeReportingTotal([
      { currencyCode: 'USD', amount: '1.00' },
      { currencyCode: 'EUR', amount: '1.00' },
      { currencyCode: 'GBP', amount: '1.00' },
      { currencyCode: 'CAD', amount: '1.00' },
    ], 'CAD', DATE);

    expect(convertForReportingBatch).toHaveBeenCalledTimes(1);
    expect(convertForReportingBatch.mock.calls[0]).toEqual([
      [
        { amount: '1.00', from: 'USD' },
        { amount: '1.00', from: 'EUR' },
        { amount: '1.00', from: 'GBP' },
        { amount: '1.00', from: 'CAD' },
      ],
      'CAD',
      DATE,
    ]);
  });

  it('suppresses the WHOLE total when ONE leg is unavailable, echoing every group with its reason', async () => {
    rates['USD->CAD'] = ['1.35000000', '2026-09-02', 'ecb'];
    unavailable['NGN'] = 'stale';
    const result = await computeReportingTotal([
      { currencyCode: 'USD', amount: '100.00' },
      { currencyCode: 'NGN', amount: '5000.00' },
    ], 'CAD', DATE);

    expect(result.status).toBe('unavailable');
    expect(result.total).toBeNull();
    expect(result.rateDate).toBeNull();
    expect(result.unavailableCurrencyCodes).toEqual(['NGN']);
    // Never a partial total — but the authoritative segmentation stays visible.
    expect(result.groups).toHaveLength(2);
    const usd = result.groups.find((g) => g.currencyCode === 'USD')!;
    expect(usd.amount).toBe('100.00');
    expect(usd.convertedAmount).toBe('135.00');
    const ngn = result.groups.find((g) => g.currencyCode === 'NGN')!;
    expect(ngn.amount).toBe('5000.00');
    expect(ngn.convertedAmount).toBeNull();
    expect(ngn.rate).toBeNull();
    expect(ngn.rateDate).toBeNull();
    expect(ngn.source).toBeNull();
    expect(ngn.reason).toBe('stale');
  });

  it('marks every group unavailable when the TARGET leg itself is unavailable', async () => {
    unavailable['CLP'] = 'missing';
    const result = await computeReportingTotal([
      { currencyCode: 'USD', amount: '100.00' },
      { currencyCode: 'EUR', amount: '50.00' },
    ], 'CLP', DATE);
    expect(result.status).toBe('unavailable');
    expect(result.total).toBeNull();
    expect(result.unavailableCurrencyCodes).toEqual(['USD', 'EUR']);
    expect(result.groups.every((g) => g.reason === 'missing')).toBe(true);
  });

  it('rounds at the ZERO-decimal minor unit and totals whole yen for a JPY target', async () => {
    rates['USD->JPY'] = ['147.51000000', '2026-09-03', 'ecb'];
    rates['EUR->JPY'] = ['172.49000000', '2026-09-03', 'ecb'];
    const result = await computeReportingTotal([
      { currencyCode: 'USD', amount: '10.00' },
      { currencyCode: 'EUR', amount: '10.00' },
      { currencyCode: 'JPY', amount: '5.00' },
    ], 'JPY', DATE);
    expect(result.status).toBe('available');
    expect(result.groups.map((g) => g.convertedAmount)).toEqual(['1475.00', '1725.00', '5.00']);
    expect(result.total).toBe('3205.00');
  });

  it('totals a portfolio above Number.MAX_SAFE_INTEGER minor units EXACTLY (bigint, never a double)', async () => {
    const codes = ['USD', 'GBP', 'CHF', 'CAD', 'AUD', 'NZD', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF'];
    for (const c of codes) rates[`${c}->EUR`] = ['1.00000000', '2026-09-03', 'ecb'];
    const result = await computeReportingTotal(
      codes.map((currencyCode) => ({ currencyCode, amount: '99999999999999.99' })), 'EUR', DATE);
    expect(result.status).toBe('available');
    // 12 × 99999999999999.99 = 1199999999999999.88 → 119999999999999988 minor
    // units, well above Number.MAX_SAFE_INTEGER (9007199254740991).
    // Asserted as a DIGIT STRING: a JS number accumulator loses the trailing
    // .88 entirely at this magnitude, so this case only passes on the bigint path.
    expect(result.total).toBe('1199999999999999.88');
  });

  it('calls convertForReporting once per DISTINCT currency, not once per group', async () => {
    rates['USD->EUR'] = ['0.90000000', '2026-09-03', 'ecb'];
    const result = await computeReportingTotal([
      { currencyCode: 'USD', amount: '10.00' },
      { currencyCode: 'USD', amount: '20.00' },
      { currencyCode: 'USD', amount: '30.00' },
    ], 'EUR', DATE);
    expect(convertForReporting).toHaveBeenCalledTimes(1);
    // The merged group carries the exact native sum and its single conversion.
    expect(result.groups).toEqual([expect.objectContaining({ currencyCode: 'USD', amount: '60.00', convertedAmount: '54.00' })]);
    expect(result.total).toBe('54.00');
  });

  it('passes the requested date through verbatim to the FX primitive', async () => {
    rates['USD->EUR'] = ['0.90000000', '2026-01-02', 'ecb'];
    await computeReportingTotal([{ currencyCode: 'USD', amount: '1.00' }], 'EUR', '2026-01-02');
    expect(convertForReporting).toHaveBeenCalledWith('1.00', 'USD', 'EUR', '2026-01-02');
  });

  it.each([
    ['unknown target', [{ currencyCode: 'USD', amount: '1.00' }], 'ZZZ'],
    ['unknown group currency', [{ currencyCode: 'ZZZ', amount: '1.00' }], 'USD'],
  ])('raises a 400 ExchangeRateServiceError for an %s', async (_label, groups, target) => {
    await expect(computeReportingTotal(groups as never, target, DATE)).rejects.toMatchObject({
      name: 'ExchangeRateServiceError', status: 400, code: 'INVALID_CURRENCY',
    });
  });

  it('raises a 400 for a malformed date', async () => {
    await expect(computeReportingTotal([], 'USD', '09/03/2026')).rejects.toMatchObject({ status: 400, code: 'INVALID_DATE' });
  });

  it.each(['abc', '', '1.005', '-5.00'])('raises a 400 for the non-exact amount %j', async (amount) => {
    await expect(computeReportingTotal([{ currencyCode: 'USD', amount }], 'USD', DATE))
      .rejects.toMatchObject({ status: 400, code: 'INVALID_RATE' });
  });

  it('raises a 400 for an amount with cents in a ZERO-decimal currency', async () => {
    await expect(computeReportingTotal([{ currencyCode: 'JPY', amount: '100.50' }], 'JPY', DATE))
      .rejects.toMatchObject({ status: 400, code: 'INVALID_RATE' });
  });
});

describe('parseGroupsParam', () => {
  it('parses CODE:amount pairs, normalizing the code', async () => {
    expect(parseGroupsParam('usd:12300.00,EUR:4100.00')).toEqual([
      { currencyCode: 'USD', amount: '12300.00' },
      { currencyCode: 'EUR', amount: '4100.00' },
    ]);
  });

  it.each(['USD', 'USD:', ':12', 'USD:abc', 'USD:-5', 'USD:1.00,', ',USD:1.00', 'USD:1.00:2'])(
    'rejects the malformed groups value %j with a 400', (raw) => {
      expect(() => parseGroupsParam(raw)).toThrowError(expect.objectContaining({ status: 400 }));
    });

  it('rejects an unknown currency code with a 400', () => {
    expect(() => parseGroupsParam('ZZZ:1.00')).toThrowError(expect.objectContaining({ status: 400, code: 'INVALID_CURRENCY' }));
  });

  it('rejects a duplicated currency with a 400', () => {
    expect(() => parseGroupsParam('USD:1.00,USD:2.00')).toThrowError(expect.objectContaining({ status: 400, code: 'INVALID_CURRENCY' }));
  });

  it('rejects more than 34 groups (the whole supported list is the ceiling)', () => {
    const raw = Array.from({ length: 35 }, (_, i) => `USD:${i}.00`).join(',');
    expect(() => parseGroupsParam(raw)).toThrowError(expect.objectContaining({ status: 400 }));
  });
});

describe('resolvePartnerReportingCurrency', () => {
  beforeEach(() => { dbState.selectContexts.length = 0; });

  // `partners` RLS is breeze_has_partner_access(id), and an organization-scoped
  // token carries an EMPTY accessible-partner list — so this read must not run
  // in the ambient request context, or it returns zero rows for exactly the
  // viewer the server-side fallback exists to serve (a 409 for a partner that
  // has a currency configured). Proven end to end against real Postgres in
  // __tests__/integration/reportingTotalsPartnerCurrencyScope.integration.test.ts.
  it('reads partners in a system context entered OUTSIDE the request context', async () => {
    dbState.partnerRows = [{ currencyCode: 'CAD' }];
    await resolvePartnerReportingCurrency('p1');
    expect(dbState.selectContexts).toEqual([{ system: true, outsideRequestContext: true }]);
  });

  it('returns the partner currency code', async () => {
    dbState.partnerRows = [{ currencyCode: 'CAD' }];
    await expect(resolvePartnerReportingCurrency('p1')).resolves.toBe('CAD');
    expect(dbState.selectWheres).toHaveLength(1);
  });

  it('returns null when the partner row is missing', async () => {
    dbState.partnerRows = [];
    await expect(resolvePartnerReportingCurrency('p1')).resolves.toBeNull();
  });

  it('returns null — never a USD substitute — for an unknown stored code', async () => {
    dbState.partnerRows = [{ currencyCode: 'XXX' }];
    await expect(resolvePartnerReportingCurrency('p1')).resolves.toBeNull();
  });
});
