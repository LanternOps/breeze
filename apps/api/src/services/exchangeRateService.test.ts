import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Reporting-only FX persistence (multi-currency spec §8, wave 7 #3779).
//
// The invariant under test is the one the owner fixed and never relitigated:
// the daily ECB feed can NEVER overwrite an operator's manual rate. That is
// enforced by the upsert's `WHERE exchange_rates.source <> 'manual'` conflict
// predicate, so this suite asserts the predicate is actually attached (the
// real-DB proof under both commit orderings is Task 5's integration suite).
//
// Everything else here is validation + the #1105 connection-hold rule: writes
// run inside runOutsideDbContext(() => withSystemDbAccessContext(...)), reads
// run in the AMBIENT context (the permissive `USING (true)` SELECT policy is
// what lets an org-scoped request read rates at all).
// ---------------------------------------------------------------------------

let contextDepth = 0;
let outsideCalls = 0;
let systemCalls = 0;

/** Depth at which each db verb was invoked, in call order. */
const insertDepths: number[] = [];
const deleteDepths: number[] = [];
const selectDepths: number[] = [];
const executeDepths: number[] = [];

/** Raw drizzle SQL objects handed to db.execute(), in call order. */
const executed: unknown[] = [];

/** `.values(...)` payloads handed to the insert builder, in call order. */
const insertValues: unknown[] = [];
/** `.onConflictDoUpdate(...)` configs, in call order. */
const conflictConfigs: Array<Record<string, unknown>> = [];
/** `.where(...)` conditions handed to the delete/select builders. */
const deleteWheres: unknown[] = [];
const selectWheres: unknown[] = [];
const selectLimits: unknown[] = [];

/** Terminal results, consumed in order by whichever builder is awaited. */
let results: unknown[] = [];

function nextResult(): unknown {
  return results.length > 0 ? results.shift() : [];
}

function chain(kind: 'insert' | 'delete' | 'select') {
  const c: Record<string, unknown> = {};
  const passthrough = (name: string) =>
    vi.fn((payload?: unknown) => {
      if (name === 'values') insertValues.push(payload);
      if (name === 'onConflictDoUpdate') conflictConfigs.push(payload as Record<string, unknown>);
      if (name === 'where') (kind === 'delete' ? deleteWheres : selectWheres).push(payload);
      if (name === 'limit') selectLimits.push(payload);
      return c;
    });
  for (const m of ['values', 'onConflictDoUpdate', 'onConflictDoNothing', 'returning', 'from', 'where', 'orderBy', 'limit', 'set']) {
    c[m] = passthrough(m);
  }
  (c as { then: unknown }).then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(nextResult()).then(resolve, reject);
  return c;
}

vi.mock('../db', () => ({
  db: {
    insert: vi.fn(() => { insertDepths.push(contextDepth); return chain('insert'); }),
    delete: vi.fn(() => { deleteDepths.push(contextDepth); return chain('delete'); }),
    select: vi.fn(() => { selectDepths.push(contextDepth); return chain('select'); }),
    execute: vi.fn((statement: unknown) => {
      executeDepths.push(contextDepth);
      executed.push(statement);
      return Promise.resolve(nextResult());
    }),
  },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
    systemCalls += 1;
    contextDepth += 1;
    try {
      return await fn();
    } finally {
      contextDepth -= 1;
    }
  }),
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => {
    outsideCalls += 1;
    const saved = contextDepth;
    contextDepth = 0;
    try {
      return await fn();
    } finally {
      contextDepth = saved;
    }
  }),
}));

import {
  upsertFeedRates,
  setManualRate,
  deleteManualRate,
  listExchangeRates,
  ExchangeRateServiceError,
  REPORTING_RATE_BASE_CODE,
  DEFAULT_MAX_STALENESS_DAYS,
  resolveReportingRate,
  resolveReportingRates,
  convertForReporting,
} from './exchangeRateService';

const FETCHED_AT = new Date('2026-09-03T06:00:00.000Z');

function feedRate(over: Partial<{ rateDate: string; baseCode: string; quoteCode: string; rate: string; fetchedAt: Date }> = {}) {
  return { rateDate: '2026-09-03', baseCode: 'EUR', quoteCode: 'USD', rate: '1.17', fetchedAt: FETCHED_AT, ...over };
}

/** Renders a drizzle SQL fragment's static text (StringChunks + nested SQL). */
function sqlText(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const n = node as Record<string, unknown>;
  if (Array.isArray(n.queryChunks)) return n.queryChunks.map(sqlText).join('');
  if (Array.isArray(n.value) && !('encoder' in n)) return (n.value as unknown[]).join('');
  return '';
}

/** Collects the BOUND PARAMETER values of a drizzle condition. A vacuous
 *  `expect(where).toBeDefined()` proves nothing (MEMORY: vacuous Drizzle
 *  where-clause assertions), so every filter assertion below walks these. */
function boundParams(node: unknown, out: unknown[] = []): unknown[] {
  // The `sql` tag keeps plain interpolated values as raw chunks (only helpers
  // like eq()/lte() wrap them in Param), so both shapes have to be collected.
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean' || node instanceof Date) {
    out.push(node);
    return out;
  }
  if (!node || typeof node !== 'object') return out;
  const n = node as Record<string, unknown>;
  if (Array.isArray(n.queryChunks)) {
    for (const chunk of n.queryChunks) boundParams(chunk, out);
    return out;
  }
  if ('encoder' in n && 'value' in n) out.push(n.value);
  return out;
}

beforeEach(() => {
  contextDepth = 0;
  outsideCalls = 0;
  systemCalls = 0;
  insertDepths.length = 0;
  deleteDepths.length = 0;
  selectDepths.length = 0;
  executeDepths.length = 0;
  executed.length = 0;
  insertValues.length = 0;
  conflictConfigs.length = 0;
  deleteWheres.length = 0;
  selectWheres.length = 0;
  selectLimits.length = 0;
  results = [];
});

describe('module contract', () => {
  it('pins EUR as the reporting pivot and a 7-day staleness ceiling', () => {
    expect(REPORTING_RATE_BASE_CODE).toBe('EUR');
    expect(DEFAULT_MAX_STALENESS_DAYS).toBe(7);
  });
});

describe('upsertFeedRates validation', () => {
  it('rejects a non-EUR base with UNSUPPORTED_BASE', async () => {
    await expect(upsertFeedRates([feedRate({ baseCode: 'USD', quoteCode: 'GBP' })]))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_BASE', status: 400 });
  });

  it('rejects base === quote with INVALID_CURRENCY', async () => {
    await expect(upsertFeedRates([feedRate({ quoteCode: 'EUR' })]))
      .rejects.toMatchObject({ code: 'INVALID_CURRENCY' });
  });

  it('rejects an unknown currency with INVALID_CURRENCY', async () => {
    await expect(upsertFeedRates([feedRate({ quoteCode: 'ZZZ' })]))
      .rejects.toMatchObject({ code: 'INVALID_CURRENCY' });
  });

  it.each([
    ['more than 8 decimals', '1.123456789'],
    ['zero', '0'],
    ['zero with decimals', '0.00000000'],
    ['negative', '-1.5'],
    ['not a number', 'abc'],
    // numeric(18,8) holds 10 integer digits; an 11th would reach Postgres as a
    // numeric field overflow, which escapes the route's coded-error mapping as
    // a 500 instead of the intended 400.
    ['more than 10 integer digits', '12345678901.5'],
    ['a very long integer part', '1'.repeat(40)],
  ])('rejects a rate that is %s with INVALID_RATE', async (_label, rate) => {
    await expect(upsertFeedRates([feedRate({ rate })])).rejects.toMatchObject({ code: 'INVALID_RATE' });
  });

  it.each([
    ['a non-ISO format', '02/09/2026'],
    ['an impossible month', '2026-13-01'],
    ['an impossible day', '2026-02-30'],
  ])('rejects %s rateDate with INVALID_DATE', async (_label, rateDate) => {
    await expect(upsertFeedRates([feedRate({ rateDate })])).rejects.toMatchObject({ code: 'INVALID_DATE' });
  });

  it('throws ExchangeRateServiceError instances (callers map at their own boundary)', async () => {
    await expect(upsertFeedRates([feedRate({ rate: '0' })])).rejects.toBeInstanceOf(ExchangeRateServiceError);
  });

  it('writes nothing for an empty batch', async () => {
    await expect(upsertFeedRates([])).resolves.toEqual({ submitted: 0, stored: 0, manualProtected: 0 });
    expect(insertDepths).toHaveLength(0);
    expect(outsideCalls).toBe(0);
  });
});

describe('upsertFeedRates persistence', () => {
  it('deduplicates identical keys (last write wins) and sorts the batch before writing', async () => {
    results = [[{ quoteCode: 'GBP' }, { quoteCode: 'USD' }, { quoteCode: 'USD' }]];
    await upsertFeedRates([
      feedRate({ rateDate: '2026-09-03', quoteCode: 'USD', rate: '1.10' }),
      feedRate({ rateDate: '2026-09-02', quoteCode: 'USD', rate: '1.09' }),
      feedRate({ rateDate: '2026-09-03', quoteCode: 'GBP', rate: '0.85' }),
      // duplicate key — must collapse onto the LAST value, not append a row.
      feedRate({ rateDate: '2026-09-03', quoteCode: 'USD', rate: '1.17' }),
    ]);

    const written = insertValues[0] as Array<Record<string, string>>;
    expect(written.map((r) => [r.rateDate, r.baseCode, r.quoteCode])).toEqual([
      ['2026-09-02', 'EUR', 'USD'],
      ['2026-09-03', 'EUR', 'GBP'],
      ['2026-09-03', 'EUR', 'USD'],
    ]);
    expect(written[2]!.rate).toBe('1.17000000');
    expect(written.every((r) => r.source === 'ecb')).toBe(true);
  });

  it('normalizes rates to the stored 8-decimal scale and uppercases codes', async () => {
    results = [[{ quoteCode: 'USD' }]];
    await upsertFeedRates([feedRate({ baseCode: 'eur', quoteCode: 'usd', rate: '1.17' })]);
    expect(insertValues[0]).toEqual([
      { rateDate: '2026-09-03', baseCode: 'EUR', quoteCode: 'USD', rate: '1.17000000', fetchedAt: FETCHED_AT, source: 'ecb' },
    ]);
  });

  it('attaches the manual-precedence conflict predicate (the feed can never clobber an override)', async () => {
    results = [[{ quoteCode: 'USD' }]];
    await upsertFeedRates([feedRate()]);

    const cfg = conflictConfigs[0]!;
    expect(Array.isArray(cfg.target)).toBe(true);
    expect((cfg.target as unknown[]).length).toBe(3);
    // THE invariant: without this predicate a feed run silently overwrites a
    // manual rate in one of the two commit orderings.
    const predicate = sqlText(cfg.setWhere);
    expect(predicate).toContain('<>');
    expect(predicate).toContain("'manual'");
    const setClause = cfg.set as Record<string, unknown>;
    expect(sqlText(setClause.source)).toContain("'ecb'");
  });

  it('reports how many contested cells the manual rows protected', async () => {
    // 3 submitted, 2 returned by the conditional upsert => 1 manual-protected.
    results = [[{ quoteCode: 'GBP' }, { quoteCode: 'USD' }]];
    const result = await upsertFeedRates([
      feedRate({ quoteCode: 'USD' }),
      feedRate({ quoteCode: 'GBP' }),
      feedRate({ quoteCode: 'CHF' }),
    ]);
    expect(result).toEqual({ submitted: 3, stored: 2, manualProtected: 1 });
  });

  it('writes outside any inherited DB context, under the system context (#1105)', async () => {
    results = [[{ quoteCode: 'USD' }]];
    await upsertFeedRates([feedRate()]);
    expect(outsideCalls).toBe(1);
    expect(systemCalls).toBe(1);
    // depth 0 would mean the write escaped the system context entirely.
    expect(insertDepths).toEqual([1]);
  });
});

describe('setManualRate', () => {
  it('always stores source=manual even when a caller smuggles a source field', async () => {
    const row = { rateDate: '2026-09-03', baseCode: 'EUR', quoteCode: 'USD', rate: '1.20000000', source: 'manual', fetchedAt: FETCHED_AT };
    results = [[row]];
    const saved = await setManualRate({ rateDate: '2026-09-03', baseCode: 'EUR', quoteCode: 'USD', rate: '1.2', source: 'ecb' } as never);
    expect(saved).toEqual(row);
    expect(insertValues[0]).toMatchObject({ source: 'manual', rate: '1.20000000' });
    expect((insertValues[0] as Record<string, unknown>).source).not.toBe('ecb');
    const cfg = conflictConfigs[0]!;
    // No setWhere here: an operator override is unconditional by design.
    expect(cfg.setWhere).toBeUndefined();
    expect(sqlText((cfg.set as Record<string, unknown>).source)).toContain("'manual'");
  });

  it('validates through the same guards as the feed path', async () => {
    await expect(setManualRate({ rateDate: '2026-09-03', baseCode: 'GBP', quoteCode: 'USD', rate: '1.2' }))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_BASE' });
    await expect(setManualRate({ rateDate: 'yesterday', baseCode: 'EUR', quoteCode: 'USD', rate: '1.2' }))
      .rejects.toMatchObject({ code: 'INVALID_DATE' });
    await expect(setManualRate({ rateDate: '2026-09-03', baseCode: 'EUR', quoteCode: 'USD', rate: '0' }))
      .rejects.toMatchObject({ code: 'INVALID_RATE' });
    expect(insertDepths).toHaveLength(0);
  });

  it('writes outside any inherited DB context, under the system context', async () => {
    results = [[{ rateDate: '2026-09-03', baseCode: 'EUR', quoteCode: 'USD', rate: '1.20000000', source: 'manual', fetchedAt: FETCHED_AT }]];
    await setManualRate({ rateDate: '2026-09-03', baseCode: 'EUR', quoteCode: 'USD', rate: '1.2' });
    expect(outsideCalls).toBe(1);
    expect(systemCalls).toBe(1);
    expect(insertDepths).toEqual([1]);
  });
});

describe('deleteManualRate', () => {
  it('filters on source=manual so an ECB row can never be deleted through this path', async () => {
    results = [[{ rateDate: '2026-09-03' }]];
    const deleted = await deleteManualRate({ rateDate: '2026-09-03', baseCode: 'EUR', quoteCode: 'USD' });
    expect(deleted).toBe(true);

    const params = boundParams(deleteWheres[0]);
    expect(params).toContain('manual');
    expect(params).toContain('2026-09-03');
    expect(params).toContain('EUR');
    expect(params).toContain('USD');
    expect(deleteDepths).toEqual([1]);
    expect(outsideCalls).toBe(1);
    expect(systemCalls).toBe(1);
  });

  it('returns false when no manual cell matched', async () => {
    results = [[]];
    await expect(deleteManualRate({ rateDate: '2026-09-03', baseCode: 'EUR', quoteCode: 'USD' })).resolves.toBe(false);
  });

  it('validates the key before touching the database', async () => {
    await expect(deleteManualRate({ rateDate: '2026-09-03', baseCode: 'EUR', quoteCode: 'EUR' }))
      .rejects.toMatchObject({ code: 'INVALID_CURRENCY' });
    expect(deleteDepths).toHaveLength(0);
  });
});

describe('listExchangeRates', () => {
  it('reads in the AMBIENT context — never the system context', async () => {
    results = [[]];
    await listExchangeRates();
    expect(selectDepths).toEqual([0]);
    expect(systemCalls).toBe(0);
    expect(outsideCalls).toBe(0);
    expect(selectWheres[0]).toBeUndefined();
  });

  it('binds every supplied filter', async () => {
    results = [[]];
    await listExchangeRates({ baseCode: 'eur', quoteCode: 'usd', source: 'manual', onOrBefore: '2026-09-03' });
    const params = boundParams(selectWheres[0]);
    expect(params).toEqual(expect.arrayContaining(['EUR', 'USD', 'manual', '2026-09-03']));
  });

  it('rejects an invalid filter rather than silently ignoring it', async () => {
    await expect(listExchangeRates({ quoteCode: 'ZZZ' })).rejects.toMatchObject({ code: 'INVALID_CURRENCY' });
    await expect(listExchangeRates({ onOrBefore: '2026-13-01' })).rejects.toMatchObject({ code: 'INVALID_DATE' });
    expect(selectDepths).toHaveLength(0);
  });

  it('caps the page size', async () => {
    results = [[], []];
    await listExchangeRates();
    await listExchangeRates({ limit: 100_000 });
    expect(selectLimits).toEqual([200, 500]);
  });
});

// ---------------------------------------------------------------------------
// Resolution half (Task 4): EUR-pivot cross rates, UTC-day staleness and the
// discriminated `unavailable` contract.
//
// Two properties matter more than any single number here:
//  1. A cross rate is derived from ONE table snapshot. Two "latest leg" reads
//     can straddle a feed/manual commit and produce a hybrid rate that never
//     existed at any instant — the manual-precedence bug reappearing one layer
//     up. Every read assertion below counts the exchange_rates statements.
//  2. Absence is never guessed. `from === to` is the ONLY synthetic 1:1; a
//     missing or stale leg is `unavailable`, never 1.0 and never a partial.
// ---------------------------------------------------------------------------

function legRow(quoteCode: string, rate: string, rateDate: string, source: 'ecb' | 'manual' = 'ecb') {
  return { quote_code: quoteCode, rate, rate_date: rateDate, source };
}

/** Statements that actually touched the rates table (the cross-rate division is
 *  pure arithmetic on already-read literals and touches no relation). */
function tableReads(): unknown[] {
  return executed.filter((s) => sqlText(s).includes('exchange_rates'));
}

describe('resolveReportingRate', () => {
  it('returns the ONLY synthetic 1:1 for from === to, with zero database reads', async () => {
    const result = await resolveReportingRate('usd', 'USD', '2026-09-03');
    expect(result).toEqual({
      status: 'available',
      fromCode: 'USD',
      toCode: 'USD',
      requestedDate: '2026-09-03',
      rate: '1.00000000',
      rateDate: '2026-09-03',
      source: 'identity',
      legs: [{ currencyCode: 'USD', kind: 'identity', rate: '1.00000000', rateDate: '2026-09-03', source: 'identity' }],
    });
    expect(executed).toHaveLength(0);
  });

  it('uses the stored EUR leg directly when the source currency is the pivot', async () => {
    results = [[legRow('USD', '1.17000000', '2026-09-03')]];
    const result = await resolveReportingRate('EUR', 'USD', '2026-09-03');
    expect(result).toMatchObject({ status: 'available', rate: '1.17000000', rateDate: '2026-09-03', source: 'ecb' });
    // No cross-rate division at all: one statement, and it is the leg read.
    expect(executed).toHaveLength(1);
    expect(tableReads()).toHaveLength(1);
  });

  it('derives a non-pivot pair as toLeg / fromLeg in Postgres numeric, from ONE table snapshot', async () => {
    results = [
      [legRow('USD', '1.17000000', '2026-09-03'), legRow('GBP', '0.85000000', '2026-09-03')],
      [{ rate: '0.72649573' }],
    ];
    const result = await resolveReportingRate('USD', 'GBP', '2026-09-03');
    expect(result).toMatchObject({ status: 'available', fromCode: 'USD', toCode: 'GBP', rate: '0.72649573' });

    // THE snapshot property: a second leg read is the bug.
    expect(tableReads()).toHaveLength(1);
    const division = sqlText(executed[1]);
    expect(division).toContain('numeric');
    expect(division).not.toContain('exchange_rates');
    expect(boundParams(executed[1])).toEqual(expect.arrayContaining(['1.17000000', '0.85000000', 8]));
  });

  it('reads the latest row on or before the requested date, newest first, one row per quote', async () => {
    results = [[legRow('USD', '1.17000000', '2026-09-01')]];
    await resolveReportingRate('EUR', 'USD', '2026-09-03');
    const text = sqlText(tableReads()[0]).replace(/\s+/g, ' ');
    // A future-dated row can never be selected: the bound ceiling IS the
    // requested date, and the ordering picks the newest eligible row.
    expect(text).toContain('rate_date <=');
    expect(text).toContain('DISTINCT ON (quote_code)');
    expect(text).toContain('ORDER BY quote_code, rate_date DESC');
    expect(boundParams(tableReads()[0])).toEqual(expect.arrayContaining(['2026-09-03', 'EUR', 'USD']));
  });

  it('reads in the AMBIENT context — the permissive SELECT policy is what makes that safe', async () => {
    results = [[legRow('USD', '1.17000000', '2026-09-03')]];
    await resolveReportingRate('EUR', 'USD', '2026-09-03');
    expect(executeDepths).toEqual([0]);
    expect(systemCalls).toBe(0);
    expect(outsideCalls).toBe(0);
  });

  it('accepts a leg exactly 7 UTC days old (the ceiling is inclusive)', async () => {
    results = [[legRow('USD', '1.17000000', '2026-09-03')]];
    const result = await resolveReportingRate('EUR', 'USD', '2026-09-10');
    expect(result.status).toBe('available');
  });

  it('marks a leg 8 UTC days old unavailable with reason "stale" and the last date it had', async () => {
    results = [[legRow('USD', '1.17000000', '2026-09-02')]];
    const result = await resolveReportingRate('EUR', 'USD', '2026-09-10');
    expect(result).toEqual({
      status: 'unavailable',
      fromCode: 'EUR',
      toCode: 'USD',
      requestedDate: '2026-09-10',
      unavailableLegs: [{ currencyCode: 'USD', reason: 'stale', lastRateDate: '2026-09-02' }],
    });
  });

  it('honours an explicitly narrowed staleness window', async () => {
    results = [[legRow('USD', '1.17000000', '2026-09-02')]];
    const result = await resolveReportingRate('EUR', 'USD', '2026-09-03', { maxStalenessDays: 0 });
    expect(result).toMatchObject({ status: 'unavailable', unavailableLegs: [{ reason: 'stale' }] });
  });

  it('marks a leg with no row at or before the date unavailable with reason "missing"', async () => {
    results = [[]];
    const result = await resolveReportingRate('EUR', 'USD', '2026-09-03');
    expect(result).toEqual({
      status: 'unavailable',
      fromCode: 'EUR',
      toCode: 'USD',
      requestedDate: '2026-09-03',
      unavailableLegs: [{ currencyCode: 'USD', reason: 'missing' }],
    });
  });

  it('suppresses the whole result when EITHER leg fails, listing both when both do', async () => {
    results = [[legRow('GBP', '0.85000000', '2026-09-03')]];
    const oneBad = await resolveReportingRate('USD', 'GBP', '2026-09-03');
    expect(oneBad).toMatchObject({
      status: 'unavailable',
      unavailableLegs: [{ currencyCode: 'USD', reason: 'missing' }],
    });
    // Never a derived rate off a single leg.
    expect(oneBad).not.toHaveProperty('rate');

    results = [[]];
    const bothBad = await resolveReportingRate('USD', 'GBP', '2026-09-03');
    expect((bothBad as { unavailableLegs: Array<{ currencyCode: string }> }).unavailableLegs.map((l) => l.currencyCode))
      .toEqual(['USD', 'GBP']);
  });

  it('discloses the OLDEST contributing leg date, never the freshest', async () => {
    results = [
      [legRow('USD', '1.17000000', '2026-09-03'), legRow('GBP', '0.85000000', '2026-08-30')],
      [{ rate: '0.72649573' }],
    ];
    const result = await resolveReportingRate('USD', 'GBP', '2026-09-03');
    expect(result).toMatchObject({ rateDate: '2026-08-30' });
  });

  it('reports source "mixed" when a manual leg is crossed with an ECB leg', async () => {
    results = [
      [legRow('USD', '1.17000000', '2026-09-03', 'manual'), legRow('GBP', '0.85000000', '2026-09-03')],
      [{ rate: '0.72649573' }],
    ];
    const mixed = await resolveReportingRate('USD', 'GBP', '2026-09-03');
    expect(mixed).toMatchObject({ source: 'mixed' });

    results = [
      [legRow('USD', '1.17000000', '2026-09-03', 'manual'), legRow('GBP', '0.85000000', '2026-09-03', 'manual')],
      [{ rate: '0.72649573' }],
    ];
    const bothManual = await resolveReportingRate('USD', 'GBP', '2026-09-03');
    expect(bothManual).toMatchObject({ source: 'manual' });
  });

  it('validates its arguments through the same guards as the write path', async () => {
    await expect(resolveReportingRate('ZZZ', 'USD', '2026-09-03')).rejects.toMatchObject({ code: 'INVALID_CURRENCY' });
    await expect(resolveReportingRate('EUR', 'USD', 'yesterday')).rejects.toMatchObject({ code: 'INVALID_DATE' });
    expect(executed).toHaveLength(0);
  });
});

describe('resolveReportingRates (batch)', () => {
  it('loads every leg INCLUDING the target in one statement — never once per pair', async () => {
    results = [
      [
        legRow('USD', '1.17000000', '2026-09-03'),
        legRow('GBP', '0.85000000', '2026-09-03'),
        legRow('CAD', '1.58000000', '2026-09-03'),
        legRow('CHF', '0.93000000', '2026-09-03'),
      ],
      [{ rate: '0.79487179' }],
      [{ rate: '1.09411765' }],
      [{ rate: '0.58860759' }],
    ];
    const out = await resolveReportingRates(['USD', 'GBP', 'CAD'], 'CHF', '2026-09-03');
    expect(out).toHaveLength(3);
    expect(out.map((r) => r.fromCode)).toEqual(['USD', 'GBP', 'CAD']);
    expect(out.every((r) => r.status === 'available')).toBe(true);
    expect(out.every((r) => r.toCode === 'CHF')).toBe(true);

    // ONE table read, and the target leg is in it exactly once.
    expect(tableReads()).toHaveLength(1);
    const params = boundParams(tableReads()[0]);
    expect(params.filter((p) => p === 'CHF')).toHaveLength(1);
    expect(params).toEqual(expect.arrayContaining(['USD', 'GBP', 'CAD']));
  });

  it('collapses duplicate source currencies but preserves the caller\'s order and length', async () => {
    results = [
      [legRow('USD', '1.17000000', '2026-09-03'), legRow('GBP', '0.85000000', '2026-09-03')],
      [{ rate: '0.72649573' }],
    ];
    const out = await resolveReportingRates(['usd', 'USD', 'GBP'], 'GBP', '2026-09-03');
    expect(out.map((r) => r.fromCode)).toEqual(['USD', 'USD', 'GBP']);
    // GBP → GBP is the identity leg, resolved without a second lookup.
    expect(out[2]).toMatchObject({ status: 'available', source: 'identity', rate: '1.00000000' });
    expect(tableReads()).toHaveLength(1);
  });

  it('reports per-pair unavailability without failing the whole batch', async () => {
    results = [
      [legRow('USD', '1.17000000', '2026-09-03'), legRow('CHF', '0.93000000', '2026-09-03')],
      [{ rate: '0.79487179' }],
    ];
    const out = await resolveReportingRates(['USD', 'GBP'], 'CHF', '2026-09-03');
    expect(out[0]).toMatchObject({ status: 'available' });
    expect(out[1]).toMatchObject({ status: 'unavailable', unavailableLegs: [{ currencyCode: 'GBP', reason: 'missing' }] });
  });

  it('reads nothing at all for an empty request', async () => {
    await expect(resolveReportingRates([], 'CHF', '2026-09-03')).resolves.toEqual([]);
    expect(executed).toHaveLength(0);
  });
});

describe('convertForReporting', () => {
  it('rounds half-up at the TARGET currency minor unit (JPY → whole yen)', async () => {
    results = [
      [legRow('USD', '1.17000000', '2026-09-03'), legRow('JPY', '172.50000000', '2026-09-03')],
      [{ rate: '147.43589744' }],
    ];
    const result = await convertForReporting('100', 'USD', 'JPY', '2026-09-03');
    expect(result).toMatchObject({
      status: 'available',
      amount: '100',
      rate: '147.43589744',
      // Zero-decimal rounding: 100 x 147.43589744 = 14743.589744 rounds to a
      // WHOLE yen (14744), not to 14743.59. The string keeps the numeric(_,2)
      // storage shape the shared formatter emits for every currency.
      convertedAmount: '14744.00',
    });
  });

  it('rounds to cents for a 2-decimal target', async () => {
    results = [[legRow('USD', '1.17000000', '2026-09-03')]];
    const result = await convertForReporting('250.00', 'EUR', 'USD', '2026-09-03');
    expect(result).toMatchObject({ convertedAmount: '292.50', amount: '250.00' });
  });

  it('returns the unavailable result unchanged rather than throwing for absence', async () => {
    results = [[]];
    const result = await convertForReporting('100', 'EUR', 'USD', '2026-09-03');
    expect(result).toMatchObject({ status: 'unavailable', unavailableLegs: [{ reason: 'missing' }] });
    // Never a zero, never a placeholder amount the caller could mistake for money.
    expect(result).not.toHaveProperty('convertedAmount');
    expect(result).not.toHaveProperty('amount');
  });

  it('still throws for a validation failure (absence is not the same as a bad request)', async () => {
    await expect(convertForReporting('100', 'EUR', 'ZZZ', '2026-09-03')).rejects.toBeInstanceOf(ExchangeRateServiceError);
  });

  it('converts an identity pair without touching the database', async () => {
    const result = await convertForReporting('1234.56', 'USD', 'USD', '2026-09-03');
    expect(result).toMatchObject({ convertedAmount: '1234.56', source: 'identity' });
    expect(executed).toHaveLength(0);
  });
});
