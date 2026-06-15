import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dbInsertMock, dbSelectMock } = vi.hoisted(() => ({
  dbInsertMock: vi.fn(),
  dbSelectMock: vi.fn(),
}));

vi.mock('../db', () => ({
  db: { insert: dbInsertMock, select: dbSelectMock },
}));

import {
  clientUsageDailyKey,
  clientUsageMonthlyKey,
  recordClientUsage,
  getOrgPeriodCostCents,
  checkClientBudget,
  getRemainingClientBudgetUsd,
} from './clientAiUsage';
import { defaultClientAiPolicy } from './clientAiPolicy';

const ORG = '0c0c0c0c-1111-4222-8333-444455556666';
const USER = 'beefbeef-1111-4222-8333-444455556666';

function setupInsert() {
  const onConflict = vi.fn(() => Promise.resolve());
  const values = vi.fn(() => ({ onConflictDoUpdate: onConflict }));
  dbInsertMock.mockImplementation(() => ({ values }));
  return { values, onConflict };
}

function setupSumSelect(totalCents: number) {
  dbSelectMock.mockImplementation(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve([{ total: totalCents }])),
    })),
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('period keys (UTC, mirrors aiCostTracker)', () => {
  it('formats daily and monthly keys', () => {
    const d = new Date(Date.UTC(2026, 5, 12, 23, 59));
    expect(clientUsageDailyKey(d)).toBe('2026-06-12');
    expect(clientUsageMonthlyKey(d)).toBe('2026-06');
  });
});

describe('recordClientUsage', () => {
  it('upserts a daily AND a monthly bucket keyed by (org, user, period, periodKey)', async () => {
    const { values, onConflict } = setupInsert();
    await recordClientUsage(ORG, USER, { inputTokens: 100, outputTokens: 50, costCents: 3, messageCount: 1 });

    expect(dbInsertMock).toHaveBeenCalledTimes(2);
    expect(values).toHaveBeenNthCalledWith(1, expect.objectContaining({
      orgId: ORG,
      clientUserId: USER,
      period: 'daily',
      periodKey: clientUsageDailyKey(),
      inputTokens: 100,
      outputTokens: 50,
      totalCostCents: 3,
      messageCount: 1,
      sessionCount: 0,
    }));
    expect(values).toHaveBeenNthCalledWith(2, expect.objectContaining({
      period: 'monthly',
      periodKey: clientUsageMonthlyKey(),
    }));
    expect(onConflict).toHaveBeenCalledTimes(2);
  });

  it('defaults absent delta fields to 0 (sessionCount-only bump on create)', async () => {
    const { values } = setupInsert();
    await recordClientUsage(ORG, USER, { sessionCount: 1 });
    expect(values).toHaveBeenNthCalledWith(1, expect.objectContaining({
      sessionCount: 1, messageCount: 0, inputTokens: 0, outputTokens: 0, totalCostCents: 0,
    }));
  });

  it('a failed daily upsert does not prevent the monthly upsert (additive counters)', async () => {
    const onConflict = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined);
    dbInsertMock.mockImplementation(() => ({ values: vi.fn(() => ({ onConflictDoUpdate: onConflict })) }));
    await expect(recordClientUsage(ORG, USER, { messageCount: 1 })).resolves.toBeUndefined();
    expect(dbInsertMock).toHaveBeenCalledTimes(2);
  });
});

describe('getOrgPeriodCostCents', () => {
  it('returns the SUM across the org users for the bucket', async () => {
    setupSumSelect(642.5);
    await expect(getOrgPeriodCostCents(ORG, 'daily', '2026-06-12')).resolves.toBe(642.5);
  });

  it('returns 0 when the bucket has no rows', async () => {
    dbSelectMock.mockImplementation(() => ({
      from: vi.fn(() => ({ where: vi.fn(() => Promise.resolve([])) })),
    }));
    await expect(getOrgPeriodCostCents(ORG, 'daily', '2026-06-12')).resolves.toBe(0);
  });
});

describe('checkClientBudget', () => {
  it('returns null when no budgets configured (no DB reads)', async () => {
    const policy = { ...defaultClientAiPolicy(ORG), enabled: true };
    await expect(checkClientBudget(policy)).resolves.toBeNull();
    expect(dbSelectMock).not.toHaveBeenCalled();
  });

  it('rejects when daily spend reaches the cap', async () => {
    setupSumSelect(500);
    const policy = { ...defaultClientAiPolicy(ORG), enabled: true, dailyBudgetCents: 500 };
    const msg = await checkClientBudget(policy);
    expect(msg).toContain('Daily AI budget');
  });

  it('rejects when monthly spend reaches the cap', async () => {
    setupSumSelect(10_000);
    const policy = { ...defaultClientAiPolicy(ORG), enabled: true, monthlyBudgetCents: 10_000 };
    const msg = await checkClientBudget(policy);
    expect(msg).toContain('Monthly AI budget');
  });

  it('allows when under both caps', async () => {
    setupSumSelect(10);
    const policy = { ...defaultClientAiPolicy(ORG), enabled: true, dailyBudgetCents: 500, monthlyBudgetCents: 10_000 };
    await expect(checkClientBudget(policy)).resolves.toBeNull();
  });
});

describe('getRemainingClientBudgetUsd', () => {
  it('returns undefined when unlimited', async () => {
    const policy = { ...defaultClientAiPolicy(ORG), enabled: true };
    await expect(getRemainingClientBudgetUsd(policy)).resolves.toBeUndefined();
  });

  it('returns the tighter of daily/monthly remaining, in USD', async () => {
    setupSumSelect(400); // both buckets report 400c spent
    const policy = {
      ...defaultClientAiPolicy(ORG), enabled: true,
      dailyBudgetCents: 500,    // 100c remaining
      monthlyBudgetCents: 10_000, // 9600c remaining
    };
    await expect(getRemainingClientBudgetUsd(policy)).resolves.toBe(1); // $1.00
  });

  it('clamps at 0 when overspent', async () => {
    setupSumSelect(900);
    const policy = { ...defaultClientAiPolicy(ORG), enabled: true, dailyBudgetCents: 500 };
    await expect(getRemainingClientBudgetUsd(policy)).resolves.toBe(0);
  });
});
