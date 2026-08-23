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
    expect(written[2].rate).toBe('1.17000000');
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

    const cfg = conflictConfigs[0];
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
    const cfg = conflictConfigs[0];
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
