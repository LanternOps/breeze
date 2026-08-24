import { describe, it, expect } from 'vitest';
import {
  buildEcbRatesUrl,
  fetchLatestEcbRates,
  FrankfurterClientError,
  FRANKFURTER_DEFAULT_BASE_URL,
} from './frankfurterClient';

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text, {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

describe('buildEcbRatesUrl', () => {
  it('targets /v2/rates and pins base=EUR, sorted unique quotes and an EXPLICIT ECB provider filter', () => {
    const url = new URL(buildEcbRatesUrl(FRANKFURTER_DEFAULT_BASE_URL, ['USD', 'GBP', 'USD']));
    // /v2/latest does not exist in v2 — it 404s (verified 2026-08-23).
    expect(url.pathname.endsWith('/v2/rates')).toBe(true);
    expect(url.searchParams.get('base')).toBe('EUR');
    expect(url.searchParams.get('quotes')).toBe('GBP,USD');
    // v2 blends providers by default — the filter is never omitted (spec §8).
    expect(url.searchParams.get('providers')).toBe('ECB');
  });

  it('never requests EUR against itself', () => {
    const url = new URL(buildEcbRatesUrl(FRANKFURTER_DEFAULT_BASE_URL, ['EUR', 'USD']));
    expect(url.searchParams.get('quotes')).toBe('USD');
  });
});

describe('fetchLatestEcbRates', () => {
  it('parses flat v2 rows, keeps each row’s own date and reports uncovered currencies as unavailable — never 1:1', async () => {
    const fetchImpl = (async () =>
      jsonResponse([
        { date: '2026-08-21', base: 'EUR', quote: 'GBP', rate: 0.8567 },
        { date: '2026-08-20', base: 'EUR', quote: 'USD', rate: 1.1699 },
      ])) as unknown as typeof fetch;

    const result = await fetchLatestEcbRates(['USD', 'GBP', 'KES'], { fetchImpl });

    expect(result.rates).toEqual([
      { rateDate: '2026-08-21', baseCode: 'EUR', quoteCode: 'GBP', rate: '0.85670000' },
      { rateDate: '2026-08-20', baseCode: 'EUR', quoteCode: 'USD', rate: '1.16990000' },
    ]);
    expect(result.unavailableQuoteCodes).toEqual(['KES']);
    expect(result.rates.some((r) => r.quoteCode === 'KES')).toBe(false);
  });

  it('accepts a string rate encoding', async () => {
    const fetchImpl = (async () =>
      jsonResponse([{ date: '2026-08-21', base: 'EUR', quote: 'USD', rate: '1.16990000' }])) as unknown as typeof fetch;
    const result = await fetchLatestEcbRates(['USD'], { fetchImpl });
    expect(result.rates).toEqual([{ rateDate: '2026-08-21', baseCode: 'EUR', quoteCode: 'USD', rate: '1.16990000' }]);
  });

  it('normalizes a padded whole part textually, without a float step', async () => {
    const fetchImpl = (async () =>
      jsonResponse([{ date: '2026-08-21', base: 'EUR', quote: 'USD', rate: '0001.1699' }])) as unknown as typeof fetch;
    const result = await fetchLatestEcbRates(['USD'], { fetchImpl });
    expect(result.rates[0]!.rate).toBe('1.16990000');
  });

  it('ignores rows for currencies that were not requested', async () => {
    const fetchImpl = (async () =>
      jsonResponse([
        { date: '2026-08-21', base: 'EUR', quote: 'USD', rate: 1.1699 },
        { date: '2026-08-21', base: 'EUR', quote: 'CHF', rate: 0.94 },
      ])) as unknown as typeof fetch;
    const result = await fetchLatestEcbRates(['USD'], { fetchImpl });
    expect(result.rates.map((r) => r.quoteCode)).toEqual(['USD']);
    expect(result.unavailableQuoteCodes).toEqual([]);
  });

  it.each([
    ['429', 429, 'transient'],
    ['503', 503, 'transient'],
    ['400', 400, 'permanent'],
    ['404 (wrong endpoint)', 404, 'permanent'],
  ])('classifies HTTP %s as %s', async (_label, status, kind) => {
    const fetchImpl = (async () => jsonResponse({ status, message: 'not found' }, { status })) as unknown as typeof fetch;
    await expect(fetchLatestEcbRates(['USD'], { fetchImpl })).rejects.toMatchObject({ kind });
  });

  it('treats a network throw as transient', async () => {
    const fetchImpl = (async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch;
    await expect(fetchLatestEcbRates(['USD'], { fetchImpl })).rejects.toBeInstanceOf(FrankfurterClientError);
    await expect(fetchLatestEcbRates(['USD'], { fetchImpl })).rejects.toMatchObject({ kind: 'transient' });
  });

  it.each([
    ['malformed JSON', () => jsonResponse('not json')],
    ['a v1-style envelope object instead of an array', () => jsonResponse({ base: 'EUR', date: '2026-08-21', rates: { USD: 1.1699 } })],
    // A payload in which NO row is usable is a protocol change, not a bad row.
    ['a wholly malformed row array', () => jsonResponse([{ nope: 1 }, 'not-a-row'])],
    ['an array whose every row has the wrong base', () => jsonResponse([{ date: '2026-08-21', base: 'USD', quote: 'GBP', rate: 0.79 }])],
  ])('classifies %s as permanent', async (_label, makeResponse) => {
    const fetchImpl = (async () => makeResponse()) as unknown as typeof fetch;
    await expect(fetchLatestEcbRates(['USD'], { fetchImpl })).rejects.toMatchObject({ kind: 'permanent' });
  });

  // Feed resilience: ONE bad row must never cost the other currencies their
  // update for the day. Rejections are collected and reported, never fatal —
  // and a rejected pair stays UNAVAILABLE, never 1:1.
  describe('partial-batch degradation', () => {
    it.each([
      ['an unknown currency', { date: '2026-08-21', base: 'EUR', quote: 'ZZZ', rate: 1.5 }, 'ZZZ'],
      ['an over-precision rate', { date: '2026-08-21', base: 'EUR', quote: 'CHF', rate: '0.123456789' }, 'CHF'],
      ['an over-long integer part', { date: '2026-08-21', base: 'EUR', quote: 'CHF', rate: '12345678901.5' }, 'CHF'],
      ['an invalid date', { date: '21/08/2026', base: 'EUR', quote: 'CHF', rate: 0.94 }, 'CHF'],
      ['a non-positive rate', { date: '2026-08-21', base: 'EUR', quote: 'CHF', rate: 0 }, 'CHF'],
      ['the wrong base', { date: '2026-08-21', base: 'USD', quote: 'CHF', rate: 0.94 }, 'CHF'],
      ['a non-object row', 'not-a-row', null],
    ])('stores the good rows and reports %s', async (_label, badRow, hint) => {
      const fetchImpl = (async () =>
        jsonResponse([
          { date: '2026-08-21', base: 'EUR', quote: 'USD', rate: 1.1699 },
          badRow,
          { date: '2026-08-21', base: 'EUR', quote: 'GBP', rate: 0.8567 },
        ])) as unknown as typeof fetch;

      const result = await fetchLatestEcbRates(['USD', 'GBP', 'CHF'], { fetchImpl });

      expect(result.rates.map((r) => r.quoteCode).sort()).toEqual(['GBP', 'USD']);
      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0]!.quoteCode).toBe(hint);
      expect(result.rejected[0]!.reason).toBeTruthy();
      // The rejected pair is UNAVAILABLE — nothing stored, never 1:1.
      expect(result.unavailableQuoteCodes).toContain('CHF');
      expect(result.rates.some((r) => r.quoteCode === 'CHF')).toBe(false);
    });

    it('discards BOTH readings of a contradicted currency but keeps the rest', async () => {
      const fetchImpl = (async () =>
        jsonResponse([
          { date: '2026-08-21', base: 'EUR', quote: 'USD', rate: 1.1699 },
          { date: '2026-08-21', base: 'EUR', quote: 'USD', rate: 1.2 },
          { date: '2026-08-21', base: 'EUR', quote: 'GBP', rate: 0.8567 },
        ])) as unknown as typeof fetch;

      const result = await fetchLatestEcbRates(['USD', 'GBP'], { fetchImpl });

      expect(result.rates.map((r) => r.quoteCode)).toEqual(['GBP']);
      expect(result.unavailableQuoteCodes).toEqual(['USD']);
      expect(result.rejected.map((r) => r.quoteCode)).toEqual(['USD']);
    });

    it('reports a clean response with an empty rejection list', async () => {
      const fetchImpl = (async () =>
        jsonResponse([{ date: '2026-08-21', base: 'EUR', quote: 'USD', rate: 1.1699 }])) as unknown as typeof fetch;
      const result = await fetchLatestEcbRates(['USD'], { fetchImpl });
      expect(result.rejected).toEqual([]);
    });
  });

  it('rejects an over-sized body as permanent', async () => {
    const fetchImpl = (async () =>
      new Response('[]', { status: 200, headers: { 'content-type': 'application/json', 'content-length': '2000000' } })) as unknown as typeof fetch;
    await expect(fetchLatestEcbRates(['USD'], { fetchImpl })).rejects.toMatchObject({ kind: 'permanent' });
  });

  it.each([
    ['unset', undefined],
    // docker-compose maps `${FRANKFURTER_BASE_URL:-}`, so "not configured" reaches
    // the process as the EMPTY STRING. It must fall back to the public default,
    // never build `new URL('/rates')` and throw (wave-7 Global Constraints).
    ['empty', ''],
    ['whitespace-only', '   '],
  ])('treats a %s FRANKFURTER_BASE_URL as unset and uses the public default', async (_label, value) => {
    const previous = process.env.FRANKFURTER_BASE_URL;
    if (value === undefined) delete process.env.FRANKFURTER_BASE_URL;
    else process.env.FRANKFURTER_BASE_URL = value;
    let seen = '';
    const fetchImpl = (async (input: string) => {
      seen = String(input);
      return jsonResponse([{ date: '2026-08-21', base: 'EUR', quote: 'USD', rate: 1.1699 }]);
    }) as unknown as typeof fetch;
    try {
      await fetchLatestEcbRates(['USD'], { fetchImpl });
    } finally {
      if (previous === undefined) delete process.env.FRANKFURTER_BASE_URL;
      else process.env.FRANKFURTER_BASE_URL = previous;
    }
    expect(seen.startsWith(`${FRANKFURTER_DEFAULT_BASE_URL}/rates?`)).toBe(true);
  });

  it('honours a configured FRANKFURTER_BASE_URL mirror', async () => {
    const previous = process.env.FRANKFURTER_BASE_URL;
    process.env.FRANKFURTER_BASE_URL = 'https://fx.internal.example/v2/';
    let seen = '';
    const fetchImpl = (async (input: string) => {
      seen = String(input);
      return jsonResponse([{ date: '2026-08-21', base: 'EUR', quote: 'USD', rate: 1.1699 }]);
    }) as unknown as typeof fetch;
    try {
      await fetchLatestEcbRates(['USD'], { fetchImpl });
    } finally {
      if (previous === undefined) delete process.env.FRANKFURTER_BASE_URL;
      else process.env.FRANKFURTER_BASE_URL = previous;
    }
    expect(seen.startsWith('https://fx.internal.example/v2/rates?')).toBe(true);
  });

  it('returns an empty result without fetching when no quote codes remain', async () => {
    let called = 0;
    const fetchImpl = (async () => { called += 1; return jsonResponse([]); }) as unknown as typeof fetch;
    const result = await fetchLatestEcbRates(['EUR'], { fetchImpl });
    expect(called).toBe(0);
    expect(result).toEqual({ rates: [], requestedQuoteCodes: [], unavailableQuoteCodes: [], rejected: [] });
  });

  it('reports EVERY requested code as unavailable for an empty array response', async () => {
    const fetchImpl = (async () => jsonResponse([])) as unknown as typeof fetch;
    const result = await fetchLatestEcbRates(['USD', 'GBP'], { fetchImpl });
    expect(result.rates).toEqual([]);
    expect(result.unavailableQuoteCodes).toEqual(['GBP', 'USD']);
  });
});
