import { describe, it, expect, vi, beforeEach } from 'vitest';
import { calculateCostCents, recordUsageFromSdkResult } from './aiCostTracker';
import { db } from '../db';

// ============================================
// Mocks
// ============================================

// `sql` is used as a tagged template that builds increment expressions like
// `${aiSessions.totalCostCents} + ${costCents}`. We capture the interpolated
// values so tests can read back the exact cost that was written.
vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...args: unknown[]) => ({ _eq: args })),
  and: vi.fn((...args: unknown[]) => ({ _and: args })),
  desc: vi.fn((...args: unknown[]) => ({ _desc: args })),
  isNotNull: vi.fn((...args: unknown[]) => ({ _isNotNull: args })),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ _sql: strings, values }),
    {},
  ),
}));

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    update: vi.fn(),
    insert: vi.fn(),
    select: vi.fn(),
  },
}));

vi.mock('../db/schema', () => ({
  aiSessions: {
    id: 'id',
    model: 'model',
    totalInputTokens: 'totalInputTokens',
    totalOutputTokens: 'totalOutputTokens',
    totalCostCents: 'totalCostCents',
    turnCount: 'turnCount',
  },
  aiCostUsage: {
    orgId: 'orgId',
    period: 'period',
    periodKey: 'periodKey',
    inputTokens: 'inputTokens',
    outputTokens: 'outputTokens',
    totalCostCents: 'totalCostCents',
    messageCount: 'messageCount',
    toolExecutionCount: 'toolExecutionCount',
  },
  aiBudgets: { orgId: 'orgId', dailyBudgetCents: 'dailyBudgetCents' },
  organizations: { id: 'id', partnerId: 'partnerId' },
}));

vi.mock('./redis', () => ({ getRedis: vi.fn(() => ({})) }));
vi.mock('./rate-limit', () => ({ rateLimiter: vi.fn() }));
vi.mock('./effectiveSettings', () => ({ getEffectiveAiBudget: vi.fn() }));

const mockDb = db as unknown as {
  update: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
};

/**
 * Wire up chainable db mocks. `capturedSessionSet` holds the object passed to
 * `db.update(aiSessions).set({...})` — the cost recorded on the session row.
 * `sessionModel` is returned by the session-model lookup `db.select(...).limit(1)`.
 */
function setupDbMocks(sessionModel: string | null) {
  const capture: { sessionSet?: Record<string, unknown> } = {};

  mockDb.update.mockReturnValue({
    set: vi.fn((values: Record<string, unknown>) => {
      capture.sessionSet = values;
      return { where: vi.fn().mockResolvedValue(undefined) };
    }),
  });

  mockDb.insert.mockReturnValue({
    values: vi.fn(() => ({
      onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
    })),
  });

  // db.select(...) is used both for the session-model lookup and for the
  // anomaly-check budget/usage queries. Returning an empty array for the budget
  // query short-circuits anomaly checks; returning the model row drives the
  // token-pricing fallback.
  mockDb.select.mockImplementation((cols?: Record<string, unknown>) => {
    const isModelLookup = !!cols && 'model' in cols;
    const result = isModelLookup && sessionModel ? [{ model: sessionModel }] : [];
    return {
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue(result),
        })),
      })),
    };
  });

  return capture;
}

/** Extract the numeric cost the function tried to add to the session row. */
function recordedCostCents(captured: Record<string, unknown> | undefined): number {
  const expr = captured?.totalCostCents as { values?: unknown[] } | undefined;
  // sql`${col} + ${costCents}` → values = [colRef, costCents]
  return Number(expr?.values?.[1]);
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.BILLING_SERVICE_URL;
  delete process.env.BILLING_SERVICE_API_KEY;
});

// ============================================
// calculateCostCents
// ============================================

describe('calculateCostCents', () => {
  it('returns a non-zero cost for a current model with non-zero tokens', () => {
    // claude-sonnet-4-6 is $3/$15 per MTok → 300/1500 cents per MTok.
    // 1M in + 1M out = 300 + 1500 = 1800 cents.
    expect(calculateCostCents('claude-sonnet-4-6', 1_000_000, 1_000_000)).toBe(1800);
  });

  it.each([
    // [model, inputPerMTokCents, outputPerMTokCents]
    ['claude-opus-4-8', 500, 2500],
    ['claude-sonnet-4-6', 300, 1500],
    ['claude-haiku-4-5', 100, 500],
    ['claude-haiku-4-5-20251001', 100, 500],
    ['claude-fable-5', 1000, 5000],
    ['claude-sonnet-4-5-20250929', 300, 1500],
  ])('prices %s from MODEL_PRICING (no DEFAULT fallthrough)', (model, inCents, outCents) => {
    // 1M in / 1M out should equal exactly the per-MTok rates summed.
    const expected = inCents + outCents;
    expect(calculateCostCents(model, 1_000_000, 1_000_000)).toBe(expected);
    // And it must be a non-zero, finite number.
    expect(calculateCostCents(model, 1_000_000, 1_000_000)).toBeGreaterThan(0);
  });

  it('falls back to DEFAULT_PRICING and warns for an unknown model', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // DEFAULT_PRICING mirrors opus-tier 500/2500.
    expect(calculateCostCents('some-unreleased-model', 1_000_000, 1_000_000)).toBe(3000);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('some-unreleased-model'));
    warn.mockRestore();
  });

  it('returns 0 when there are no tokens', () => {
    expect(calculateCostCents('claude-opus-4-8', 0, 0)).toBe(0);
  });
});

// ============================================
// recordUsageFromSdkResult — token-based fallback (issue #1326)
// ============================================

describe('recordUsageFromSdkResult', () => {
  it('records a non-zero cost when total_cost_usd is 0 but tokens are present (uses result.model)', async () => {
    const captured = setupDbMocks(null);

    await recordUsageFromSdkResult('sess-1', 'org-1', {
      total_cost_usd: 0,
      usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
      num_turns: 1,
      model: 'claude-sonnet-4-6',
    });

    // 1M/1M on sonnet-4-6 → 1800 cents, NOT 0.
    expect(recordedCostCents(captured.sessionSet)).toBe(1800);
  });

  it('falls back to the session-row model when result.model is absent', async () => {
    const captured = setupDbMocks('claude-opus-4-8');

    await recordUsageFromSdkResult('sess-2', 'org-1', {
      total_cost_usd: 0,
      usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
      num_turns: 1,
      // no model — should be looked up from aiSessions row (opus-4-8 → 3000 cents)
    });

    expect(recordedCostCents(captured.sessionSet)).toBe(3000);
  });

  it('uses the SDK-reported cost verbatim when it is non-zero', async () => {
    const captured = setupDbMocks('claude-sonnet-4-6');

    await recordUsageFromSdkResult('sess-3', 'org-1', {
      total_cost_usd: 0.1234, // $0.1234 → 12.34 cents
      usage: { input_tokens: 5_000, output_tokens: 2_000 },
      num_turns: 2,
      model: 'claude-sonnet-4-6',
    });

    // Must record the exact SDK value, not a token-derived one.
    expect(recordedCostCents(captured.sessionSet)).toBe(12.34);
  });

  it('records 0 cost when both SDK cost and tokens are zero', async () => {
    const captured = setupDbMocks('claude-sonnet-4-6');

    await recordUsageFromSdkResult('sess-4', 'org-1', {
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
      num_turns: 1,
      model: 'claude-sonnet-4-6',
    });

    expect(recordedCostCents(captured.sessionSet)).toBe(0);
  });

  it('skips recording when orgId is empty', async () => {
    setupDbMocks('claude-sonnet-4-6');

    await recordUsageFromSdkResult('sess-5', '', {
      total_cost_usd: 0,
      usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
      num_turns: 1,
      model: 'claude-sonnet-4-6',
    });

    expect(mockDb.update).not.toHaveBeenCalled();
  });
});
