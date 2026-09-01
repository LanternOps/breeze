import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ db: {}, withSystemDbAccessContext: (fn: () => unknown) => fn(), runOutsideDbContext: (fn: () => unknown) => fn() }));
vi.mock('./effectiveSettings', () => ({ getEffectiveAiBudget: vi.fn(), DEFAULT_AI_ALERT_THRESHOLD_PERCENTS: [50, 80, 95] }));
vi.mock('./llm/llmConfigResolver', () => ({ getLlmBillingSourceForOrg: vi.fn() }));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));

import { computeBudgetPct, evaluateAiBudgetThresholds, normalizeAlertThresholds, periodKeysFor, pickRung } from './aiBudgetAlerts';
import { db } from '../db';
import { getEffectiveAiBudget } from './effectiveSettings';
import { getLlmBillingSourceForOrg } from './llm/llmConfigResolver';

describe('normalizeAlertThresholds', () => {
  it('sorts and dedupes', () => {
    expect(normalizeAlertThresholds([95, 50, 80, 50])).toEqual([50, 80, 95]);
  });
  it('accepts an empty ladder', () => {
    expect(normalizeAlertThresholds([])).toEqual([]);
  });
  it.each([[0], [100], [50.5], [-1]])('rejects %s', (bad) => {
    expect(() => normalizeAlertThresholds([bad])).toThrow(RangeError);
  });
});

describe('computeBudgetPct', () => {
  it('floors', () => expect(computeBudgetPct(7999, 10000)).toBe(79));
  it('hits the boundary exactly', () => expect(computeBudgetPct(8000, 10000)).toBe(80));
  it('handles real-typed cents', () => expect(computeBudgetPct(7999.6, 10000)).toBe(79));
  it.each([[null], [undefined], [0], [-5]])('returns null for cap %s', (cap) => {
    expect(computeBudgetPct(500, cap as number | null | undefined)).toBeNull();
  });
  it('is not capped at 100', () => expect(computeBudgetPct(12000, 10000)).toBe(120));
});

describe('pickRung', () => {
  it('returns the highest rung at or below pct', () => expect(pickRung(96, [50, 80, 95])).toBe(95));
  it('returns null below the lowest rung', () => expect(pickRung(49, [50, 80, 95])).toBeNull());
  it('always includes 100', () => expect(pickRung(100, [])).toBe(100));
  it('returns 100 when over budget', () => expect(pickRung(120, [50])).toBe(100));
});

describe('periodKeysFor', () => {
  it('uses UTC', () => {
    expect(periodKeysFor(new Date('2026-09-30T23:30:00Z'))).toEqual({ daily: '2026-09-30', monthly: '2026-09' });
    expect(periodKeysFor(new Date('2026-10-01T00:30:00Z'))).toEqual({ daily: '2026-10-01', monthly: '2026-10' });
  });
});

describe('evaluateAiBudgetThresholds', () => {
  const dialect = new PgDialect();
  const executed: string[] = [];
  // Queue of per-call return values, consumed in call order. Using a queue (rather
  // than chained `mockResolvedValueOnce`) so every call — including the advisory-lock
  // `tx.execute` between the usage read and the insert — still runs through the
  // implementation below and gets its SQL text captured into `executed`.
  let responses: unknown[] = [];
  beforeEach(() => {
    executed.length = 0;
    responses = [];
    (db as unknown as Record<string, unknown>).execute = vi.fn(async (q: SQL) => {
      executed.push(dialect.sqlToQuery(q).sql);
      return responses.length > 0 ? responses.shift() : [{ id: 'evt-1' }];
    });
    (db as unknown as Record<string, unknown>).transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db));
    vi.mocked(getLlmBillingSourceForOrg).mockResolvedValue('platform');
  });

  it('does nothing when AI is disabled', async () => {
    vi.mocked(getEffectiveAiBudget).mockResolvedValue({ enabled: false, monthlyBudgetCents: 10000, dailyBudgetCents: null, alertThresholdPercents: [50, 80, 95] } as never);
    await expect(evaluateAiBudgetThresholds('org1')).resolves.toEqual([]);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('skips periods with no cap and inserts the highest crossed rung for capped ones', async () => {
    vi.mocked(getEffectiveAiBudget).mockResolvedValue({ enabled: true, monthlyBudgetCents: 10000, dailyBudgetCents: null, alertThresholdPercents: [50, 80, 95] } as never);
    // 1st execute = usage read, 2nd = advisory lock (tx.execute — return value unused), 3rd = insert
    responses = [[{ total_cost_cents: 9600 }], [], [{ id: 'evt-1' }]];
    const created = await evaluateAiBudgetThresholds('org1');
    expect(created).toEqual([{ id: 'evt-1', period: 'monthly', thresholdPct: 95 }]);
    expect(executed.join('\n')).toContain('threshold_pct >=');
    expect(executed.join('\n')).toContain('ON CONFLICT');
  });

  it('returns nothing when the insert is suppressed (rung already fired)', async () => {
    vi.mocked(getEffectiveAiBudget).mockResolvedValue({ enabled: true, monthlyBudgetCents: 10000, dailyBudgetCents: null, alertThresholdPercents: [50, 80, 95] } as never);
    // usage read, then advisory lock (unused), then insert suppressed by the monotonic guard
    responses = [[{ total_cost_cents: 8100 }], [], []];
    await expect(evaluateAiBudgetThresholds('org1')).resolves.toEqual([]);
  });
});
