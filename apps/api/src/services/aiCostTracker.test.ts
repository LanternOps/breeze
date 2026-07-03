import { describe, it, expect, vi, beforeEach } from 'vitest';
import { calculateCostCents, checkAiRateLimit, checkBudget, recordUsage, recordUsageFromSdkResult } from './aiCostTracker';
import { db, withSystemDbAccessContext } from '../db';
import { getEffectiveAiBudget } from './effectiveSettings';
import { rateLimiter } from './rate-limit';

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
  const capture: {
    sessionSet?: Record<string, unknown>;
    aggregateValues: Array<Record<string, unknown>>;
  } = { aggregateValues: [] };

  mockDb.update.mockReturnValue({
    set: vi.fn((values: Record<string, unknown>) => {
      capture.sessionSet = values;
      return { where: vi.fn().mockResolvedValue(undefined) };
    }),
  });

  mockDb.insert.mockReturnValue({
    values: vi.fn((values: Record<string, unknown>) => {
      capture.aggregateValues.push(values);
      return { onConflictDoUpdate: vi.fn().mockResolvedValue(undefined) };
    }),
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

  it('prices cache read (0.1x input) and cache creation (1.25x input) tokens', () => {
    // sonnet-4-6 input rate = 300 cents/MTok.
    // 1M cache-read  → 300 * 0.1  = 30 cents.
    // 1M cache-write → 300 * 1.25 = 375 cents.
    // No input/output tokens, so the total is purely the cache cost.
    expect(calculateCostCents('claude-sonnet-4-6', 0, 0, 1_000_000, 0)).toBe(30);
    expect(calculateCostCents('claude-sonnet-4-6', 0, 0, 0, 1_000_000)).toBe(375);
  });

  it('adds cache cost on top of input+output (cached request costs more)', () => {
    // sonnet-4-6: 1M in + 1M out = 1800 cents (baseline, no cache).
    const baseline = calculateCostCents('claude-sonnet-4-6', 1_000_000, 1_000_000);
    // Same in/out plus 1M cache-read (+30) and 1M cache-write (+375) = 2205.
    const withCache = calculateCostCents('claude-sonnet-4-6', 1_000_000, 1_000_000, 1_000_000, 1_000_000);
    expect(baseline).toBe(1800);
    expect(withCache).toBe(2205);
    expect(withCache).toBeGreaterThan(baseline);
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

  it('includes cache tokens in the fallback cost (cached request priced higher than in+out alone)', async () => {
    // First: in+out only → 1800 cents on sonnet-4-6 (1M/1M).
    const baselineCapture = setupDbMocks(null);
    await recordUsageFromSdkResult('sess-cache-base', 'org-1', {
      total_cost_usd: 0,
      usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
      num_turns: 1,
      model: 'claude-sonnet-4-6',
    });
    expect(recordedCostCents(baselineCapture.sessionSet)).toBe(1800);

    // Now the same in+out PLUS cache tokens. cache-read 1M (+30) and
    // cache-write 1M (+375) must be added on top → 2205 cents.
    const cachedCapture = setupDbMocks(null);
    await recordUsageFromSdkResult('sess-cache', 'org-1', {
      total_cost_usd: 0,
      usage: {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
        cache_read_input_tokens: 1_000_000,
        cache_creation_input_tokens: 1_000_000,
      },
      num_turns: 1,
      model: 'claude-sonnet-4-6',
    });
    const cachedCost = recordedCostCents(cachedCapture.sessionSet);
    expect(cachedCost).toBe(2205);
    expect(cachedCost).toBeGreaterThan(1800);
  });

  it('prices a $0 result that only has cache tokens (no uncached in/out)', async () => {
    // Fully-cached follow-up turn: input_tokens/output_tokens can be ~0 while the
    // real spend is entirely cache reads. Must NOT record $0.
    const captured = setupDbMocks(null);
    await recordUsageFromSdkResult('sess-cache-only', 'org-1', {
      total_cost_usd: 0,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 1_000_000, // sonnet-4-6: 300 * 0.1 = 30 cents
        cache_creation_input_tokens: 0,
      },
      num_turns: 1,
      model: 'claude-sonnet-4-6',
    });
    expect(recordedCostCents(captured.sessionSet)).toBe(30);
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

// ============================================
// recordUsage — sessionless org-budget path (issue #1949)
// ============================================

describe('recordUsage', () => {
  it('records the session row when a real sessionId is given', async () => {
    const captured = setupDbMocks(null);

    // sonnet-4-6 1M/1M → 1800 cents on the session row.
    await recordUsage('sess-1', 'org-1', 'claude-sonnet-4-6', 1_000_000, 1_000_000, true);

    expect(mockDb.update).toHaveBeenCalledTimes(1);
    expect(recordedCostCents(captured.sessionSet)).toBe(1800);
  });

  it('skips the ai_sessions update but still writes org aggregates when sessionId is null', async () => {
    // The catalog AI enrichment flow has no ai_sessions row. Passing null must
    // NOT touch ai_sessions (the old non-UUID label threw and bypassed budgets,
    // issue #1949) yet must still record the org-budget aggregates.
    const captured = setupDbMocks(null);

    await recordUsage(null, 'org-1', 'claude-sonnet-4-6', 1_000_000, 1_000_000, true);

    // No session update at all.
    expect(mockDb.update).not.toHaveBeenCalled();

    // Both daily and monthly aggregate inserts still happen, carrying the spend.
    expect(captured.aggregateValues.length).toBe(2);
    const periods = captured.aggregateValues.map((v) => v.period).sort();
    expect(periods).toEqual(['daily', 'monthly']);
    for (const agg of captured.aggregateValues) {
      expect(agg.orgId).toBe('org-1');
      expect(agg.totalCostCents).toBe(1800); // 1M/1M sonnet-4-6
      expect(agg.inputTokens).toBe(1_000_000);
      expect(agg.outputTokens).toBe(1_000_000);
      expect(agg.toolExecutionCount).toBe(1); // isToolExecution=true
    }
  });

  it('does not throw on the sessionless path (budget enforcement always sees the spend)', async () => {
    setupDbMocks(null);
    await expect(
      recordUsage(null, 'org-1', 'claude-sonnet-4-6', 100, 50, true),
    ).resolves.toBeUndefined();
  });
});

// ============================================
// #2190 — self-contexted DB ops (no ambient request transaction)
// ============================================
//
// The distributor catalog import routes opt out of the auth middleware's auto
// request-transaction, so checkBudget / checkAiRateLimit / recordUsage now run
// with NO ambient DB context on that path. Each DB op in this module must open
// its own short withSystemDbAccessContext (which reuses an ambient context when
// one is active, so all other callers are unchanged). These tests run with the
// '../db' mock's pass-through withSystemDbAccessContext and assert the wrapper
// actually guards the DB work — a regression back to bare `db` calls would drop
// the wrapper calls and silently skip budget enforcement / usage recording
// under RLS.

describe('#2190 self-contexted DB ops', () => {
  const effectiveBudget = (over: Record<string, unknown> = {}) => ({
    enabled: true,
    monthlyBudgetCents: null,
    dailyBudgetCents: null,
    maxTurnsPerSession: 50,
    messagesPerMinutePerUser: 20,
    messagesPerHourPerOrg: 200,
    approvalMode: 'per_step',
    ...over,
  }) as Awaited<ReturnType<typeof getEffectiveAiBudget>>;

  it('checkBudget wraps the effective-budget read and the usage read, and still enforces the budget', async () => {
    vi.mocked(getEffectiveAiBudget).mockResolvedValue(effectiveBudget({ dailyBudgetCents: 1000 }));
    // Daily usage row at the budget → must be blocked.
    mockDb.select.mockImplementation(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([{ totalCostCents: 1000 }]) })),
      })),
    }));

    const res = await checkBudget('org-1');

    expect(res).toContain('Daily AI budget exceeded');
    // getEffectiveAiBudget + the daily usage read each ran inside the wrapper.
    expect(vi.mocked(withSystemDbAccessContext).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('checkBudget still allows when under budget (wrapper is a pass-through, not a filter)', async () => {
    vi.mocked(getEffectiveAiBudget).mockResolvedValue(effectiveBudget({ dailyBudgetCents: 1000, monthlyBudgetCents: 5000 }));
    mockDb.select.mockImplementation(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([{ totalCostCents: 1 }]) })),
      })),
    }));

    await expect(checkBudget('org-1')).resolves.toBeNull();
    // budget read + daily read + monthly read all self-contexted.
    expect(vi.mocked(withSystemDbAccessContext).mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('checkAiRateLimit wraps its getEffectiveAiBudget read (it is NOT Redis-only)', async () => {
    vi.mocked(getEffectiveAiBudget).mockResolvedValue(effectiveBudget());
    vi.mocked(rateLimiter).mockResolvedValue({ allowed: true, resetAt: new Date() } as Awaited<ReturnType<typeof rateLimiter>>);

    await expect(checkAiRateLimit('u1', 'org-1')).resolves.toBeNull();
    expect(vi.mocked(withSystemDbAccessContext)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getEffectiveAiBudget)).toHaveBeenCalledWith('org-1');
  });

  it('recordUsage (sessionless) wraps each aggregate upsert and still writes both periods', async () => {
    const captured = setupDbMocks(null);

    await recordUsage(null, 'org-1', 'claude-sonnet-4-6', 100, 50, false);

    // Both aggregates written, each inside its own short context (a third call
    // may come from the fire-and-forget anomaly check — assert at least the two
    // awaited upserts).
    expect(captured.aggregateValues.length).toBe(2);
    expect(vi.mocked(withSystemDbAccessContext).mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
