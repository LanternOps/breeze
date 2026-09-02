import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  calculateCatalogCostCents,
  calculateCostCents,
  checkAiRateLimit,
  checkBillingCredits,
  checkBillingCreditsDetailed,
  checkBudget,
  checkBudgetDetailed,
  checkSystemAiRateLimit,
  deductBillingCredits,
  getUsageSummary,
  recordSessionlessSdkUsage,
  recordUsage,
  recordUsageFromSdkResult,
  sumInputTokens,
} from './aiCostTracker';
import { db, withSystemDbAccessContext } from '../db';
import { getEffectiveAiBudget } from './effectiveSettings';
import { rateLimiter } from './rate-limit';
import { captureException, captureMessage } from './sentry';
import { evaluateAiBudgetThresholds } from './aiBudgetAlerts';

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
    // Default: no alert-event rows. `vi.clearAllMocks()` (used in beforeEach
    // below) only resets call tracking, not this implementation, so tests
    // that don't care about `alerts.fired` never have to stub it themselves.
    execute: vi.fn().mockResolvedValue([]),
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
    billingSource: 'billingSource',
    orgId: 'orgId',
    catalogEntryId: 'catalogEntryId',
    lastActivityAt: 'lastActivityAt',
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
    billingSource: 'billingSource',
  },
  aiBudgets: { orgId: 'orgId', dailyBudgetCents: 'dailyBudgetCents' },
  organizations: { id: 'id', partnerId: 'partnerId' },
}));

vi.mock('./redis', () => ({ getRedis: vi.fn(() => ({})) }));
vi.mock('./rate-limit', () => ({ rateLimiter: vi.fn() }));

// Single source of truth for an enabled, unlimited effective budget with the
// default alert ladder, same shape `getEffectiveAiBudget` itself defaults
// to. Used both as the module mock's default resolved value below and by
// the local `effectiveBudget()` override helper in the #4388 getUsageSummary
// describe block, so the 8 fields aren't typed out twice.
const { DEFAULT_EFFECTIVE_BUDGET } = vi.hoisted(() => ({
  DEFAULT_EFFECTIVE_BUDGET: {
    enabled: true,
    monthlyBudgetCents: null,
    dailyBudgetCents: null,
    maxTurnsPerSession: 50,
    messagesPerMinutePerUser: 20,
    messagesPerHourPerOrg: 200,
    approvalMode: 'per_step',
    alertThresholdPercents: [50, 80, 95],
  },
}));

// Default: the fixture above. Individual tests override via
// `vi.mocked(getEffectiveAiBudget).mockResolvedValue(...)`.
vi.mock('./effectiveSettings', () => ({
  getEffectiveAiBudget: vi.fn().mockResolvedValue(DEFAULT_EFFECTIVE_BUDGET),
}));
vi.mock('./sentry', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('./aiBudgetAlerts', () => ({ evaluateAiBudgetThresholds: vi.fn().mockResolvedValue([]) }));

const { getLlmBillingSourceForOrgMock } = vi.hoisted(() => ({
  getLlmBillingSourceForOrgMock: vi.fn(),
}));
vi.mock('./llm/llmConfigResolver', () => ({
  getLlmBillingSourceForOrg: (...args: unknown[]) => getLlmBillingSourceForOrgMock(...args),
}));

const { getCatalogEntryNameMock } = vi.hoisted(() => ({
  getCatalogEntryNameMock: vi.fn(),
}));
vi.mock('./llmProviderCatalog', () => ({
  getCatalogEntryName: (...args: unknown[]) => getCatalogEntryNameMock(...args),
}));

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
/**
 * `recentCatalogEntryId`: `undefined` = the org has no sessions at all;
 * `null` = its most recent session ran direct (no catalog entry stamped);
 * a string = its most recent session routed through that catalog entry.
 */
function setupDbMocks(sessionModel: string | null, recentCatalogEntryId?: string | null) {
  const capture: {
    sessionSet?: Record<string, unknown>;
    /** The `where` condition of the recent-session catalog-entry lookup. */
    catalogLookupWhere?: unknown;
    aggregateValues: Array<Record<string, unknown>>;
    // The `set` object passed to onConflictDoUpdate on each aggregate upsert —
    // what actually gets applied when the (orgId, period, periodKey) row
    // already exists, i.e. every call after the first for a given period.
    aggregateConflictSets: Array<Record<string, unknown>>;
  } = { aggregateValues: [], aggregateConflictSets: [] };

  mockDb.update.mockReturnValue({
    set: vi.fn((values: Record<string, unknown>) => {
      capture.sessionSet = values;
      return { where: vi.fn().mockResolvedValue(undefined) };
    }),
  });

  mockDb.insert.mockReturnValue({
    values: vi.fn((values: Record<string, unknown>) => {
      capture.aggregateValues.push(values);
      return {
        onConflictDoUpdate: vi.fn((arg: { set: Record<string, unknown> }) => {
          capture.aggregateConflictSets.push(arg.set);
          return Promise.resolve(undefined);
        }),
      };
    }),
  });

  // db.select(...) is used both for the session-model lookup and for the
  // anomaly-check budget/usage queries. Returning an empty array for the budget
  // query short-circuits anomaly checks; returning the model row drives the
  // token-pricing fallback.
  mockDb.select.mockImplementation((cols?: Record<string, unknown>) => {
    const isModelLookup = !!cols && 'model' in cols;
    const isPartnerLookup = !!cols && 'partnerId' in cols;
    const isCatalogEntryLookup = !!cols && 'catalogEntryId' in cols;
    const result = isModelLookup && sessionModel
      ? [{ model: sessionModel }]
      : isPartnerLookup
        ? [{ partnerId: 'partner-1' }]
        : isCatalogEntryLookup && recentCatalogEntryId !== undefined
          ? [{ catalogEntryId: recentCatalogEntryId }]
          : [];
    // The recent-catalog-session lookup adds an `.orderBy()` step between
    // `.where()` and `.limit()`; every other query here goes straight from
    // `.where()` to `.limit()`. Both are wired on the same `where()` return so
    // either chain shape resolves to the same queued result.
    return {
      from: vi.fn(() => ({
        where: vi.fn((condition: unknown) => {
          if (isCatalogEntryLookup) capture.catalogLookupWhere = condition;
          return {
            limit: vi.fn().mockResolvedValue(result),
            orderBy: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue(result),
            })),
          };
        }),
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

/** Extract the numeric increment from a `sql\`${col} + ${n}\`` expression under `key`. */
function recordedIncrement(captured: Record<string, unknown> | undefined, key: string): number {
  const expr = captured?.[key] as { values?: unknown[] } | undefined;
  return Number(expr?.values?.[1]);
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.BILLING_SERVICE_URL;
  delete process.env.BILLING_SERVICE_API_KEY;
  getLlmBillingSourceForOrgMock.mockResolvedValue('platform');
  getCatalogEntryNameMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function enableBillingService(): ReturnType<typeof vi.fn> {
  process.env.BILLING_SERVICE_URL = 'https://billing.internal';
  process.env.BILLING_SERVICE_API_KEY = 'billing-key';
  const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function billingCreditsResponse(input: {
  allowed: boolean;
  remainingCredits: number;
  plan: string;
}): Response {
  return new Response(JSON.stringify(input), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('checkBillingCredits billing-source split', () => {
  it('enforces plan entitlement for partner-key usage', async () => {
    const fetchMock = enableBillingService();
    fetchMock.mockResolvedValueOnce(billingCreditsResponse({
      allowed: false,
      remainingCredits: 0,
      plan: 'starter',
    }));
    setupDbMocks(null);

    await expect(checkBillingCredits('org-1', 'partner_key')).resolves.toBe(
      'AI assistant requires the Community plan.',
    );
  });

  it('does not block partner-key usage when only Breeze credits are exhausted', async () => {
    const fetchMock = enableBillingService();
    fetchMock.mockResolvedValueOnce(billingCreditsResponse({
      allowed: false,
      remainingCredits: 0,
      plan: 'community',
    }));
    setupDbMocks(null);

    await expect(checkBillingCredits('org-1', 'partner_key')).resolves.toBeNull();
  });

  it('keeps exhausted-credit denial for platform usage', async () => {
    const fetchMock = enableBillingService();
    fetchMock.mockResolvedValueOnce(billingCreditsResponse({
      allowed: false,
      remainingCredits: 0,
      plan: 'community',
    }));
    setupDbMocks(null);

    await expect(checkBillingCredits('org-1', 'platform')).resolves.toBe(
      'You are out of AI credits. Purchase more credits to continue.',
    );
  });
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

describe('calculateCatalogCostCents', () => {
  it('prices each token type from the catalog snapshot rates', () => {
    const catalogPricing = {
      catalogEntryId: 'cat-1',
      revisionId: 'rev-1',
      inputCentsPerM: 200,
      outputCentsPerM: 1000,
      cacheReadCentsPerM: 20,
      cacheWriteCentsPerM: 250,
    };

    // 500,001 input = 100.0002 cents, 250,001 output = 250.001 cents,
    // 100,001 cache-read = 2.00002 cents, 200,001 cache-write = 50.00025
    // cents. The 402.00147-cent total rounds to exactly 402 cents.
    expect(calculateCatalogCostCents(
      catalogPricing,
      500_001,
      250_001,
      100_001,
      200_001,
    )).toBe(402);
  });
});

// ============================================
// recordUsageFromSdkResult — token-based fallback (issue #1326)
// ============================================

describe('recordUsageFromSdkResult', () => {
  it('uses catalog snapshot pricing instead of a nonzero SDK-reported cost', async () => {
    const captured = setupDbMocks(null);
    const catalogPricing = {
      catalogEntryId: 'cat-1',
      revisionId: 'rev-1',
      inputCentsPerM: 200,
      outputCentsPerM: 1000,
      cacheReadCentsPerM: 20,
      cacheWriteCentsPerM: 250,
    };

    await recordUsageFromSdkResult('sess-catalog', 'org-1', {
      total_cost_usd: 3.5,
      usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
      num_turns: 1,
      model: 'claude-sonnet-4-6',
    }, 'partner_key', catalogPricing);

    expect(recordedCostCents(captured.sessionSet)).toBe(1200);
    expect(recordedCostCents(captured.sessionSet)).not.toBe(350);
  });

  it('prices cache tokens from the catalog snapshot cache rates', async () => {
    const captured = setupDbMocks(null);
    const catalogPricing = {
      catalogEntryId: 'cat-1',
      revisionId: 'rev-1',
      inputCentsPerM: 200,
      outputCentsPerM: 1000,
      cacheReadCentsPerM: 20,
      cacheWriteCentsPerM: 250,
    };

    await recordUsageFromSdkResult('sess-catalog-cache', 'org-1', {
      total_cost_usd: 3.5,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 1_000_000,
        cache_creation_input_tokens: 1_000_000,
      },
      num_turns: 1,
      model: 'claude-sonnet-4-6',
    }, 'partner_key', catalogPricing);

    expect(recordedCostCents(captured.sessionSet)).toBe(270);
  });

  it('keeps the SDK-reported cost when catalog pricing is omitted', async () => {
    const captured = setupDbMocks(null);

    await recordUsageFromSdkResult('sess-no-catalog', 'org-1', {
      total_cost_usd: 0.1234,
      usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
      num_turns: 1,
      model: 'claude-sonnet-4-6',
    }, 'platform');

    expect(recordedCostCents(captured.sessionSet)).toBe(12.34);
  });

  it('stamps partner-key usage on the session and aggregate upsert without deducting credits', async () => {
    const fetchMock = enableBillingService();
    const captured = setupDbMocks(null);

    await recordUsageFromSdkResult('sess-partner-key', 'org-1', {
      total_cost_usd: 0.25,
      usage: { input_tokens: 100, output_tokens: 50 },
      num_turns: 1,
      model: 'claude-sonnet-4-6',
    }, 'partner_key');

    expect(captured.sessionSet?.billingSource).toBe('partner_key');
    expect(captured.aggregateValues).toHaveLength(2);
    for (const values of captured.aggregateValues) {
      expect(values.billingSource).toBe('partner_key');
    }
    for (const set of captured.aggregateConflictSets) {
      expect(set.billingSource).toBe('partner_key');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps platform credit deduction and stamps platform on every write path', async () => {
    const fetchMock = enableBillingService();
    const captured = setupDbMocks(null);

    await recordUsageFromSdkResult('sess-platform', 'org-1', {
      total_cost_usd: 0.25,
      usage: { input_tokens: 100, output_tokens: 50 },
      num_turns: 1,
      model: 'claude-sonnet-4-6',
    }, 'platform');

    expect(captured.sessionSet?.billingSource).toBe('platform');
    expect(captured.aggregateValues.every((values) => values.billingSource === 'platform')).toBe(true);
    expect(captured.aggregateConflictSets.every((set) => set.billingSource === 'platform')).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://billing.internal/api/internal/partners/partner-1/ai-credits/deduct',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('records a non-zero cost when total_cost_usd is 0 but tokens are present (uses result.model)', async () => {
    const captured = setupDbMocks(null);

    await recordUsageFromSdkResult('sess-1', 'org-1', {
      total_cost_usd: 0,
      usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
      num_turns: 1,
      model: 'claude-sonnet-4-6',
    }, 'platform');

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
    }, 'platform');
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
    }, 'platform');
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
    }, 'platform');
    expect(recordedCostCents(captured.sessionSet)).toBe(30);
  });

  it('falls back to the session-row model when result.model is absent', async () => {
    const captured = setupDbMocks('claude-opus-4-8');

    await recordUsageFromSdkResult('sess-2', 'org-1', {
      total_cost_usd: 0,
      usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
      num_turns: 1,
      // no model — should be looked up from aiSessions row (opus-4-8 → 3000 cents)
    }, 'platform');

    expect(recordedCostCents(captured.sessionSet)).toBe(3000);
  });

  it('uses the SDK-reported cost verbatim when it is non-zero', async () => {
    const captured = setupDbMocks('claude-sonnet-4-6');

    await recordUsageFromSdkResult('sess-3', 'org-1', {
      total_cost_usd: 0.1234, // $0.1234 → 12.34 cents
      usage: { input_tokens: 5_000, output_tokens: 2_000 },
      num_turns: 2,
      model: 'claude-sonnet-4-6',
    }, 'platform');

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
    }, 'platform');

    expect(recordedCostCents(captured.sessionSet)).toBe(0);
  });

  it('skips recording when orgId is empty', async () => {
    setupDbMocks('claude-sonnet-4-6');

    await recordUsageFromSdkResult('sess-5', '', {
      total_cost_usd: 0,
      usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
      num_turns: 1,
      model: 'claude-sonnet-4-6',
    }, 'platform');

    expect(mockDb.update).not.toHaveBeenCalled();
  });
});

// ============================================
// recordUsageFromSdkResult — tool_execution_count rollup
// ============================================
//
// Regression: a completed tool execution (a real ai_tool_executions row) never
// bumped ai_cost_usage.tool_execution_count on the live/SDK chat path. The
// aggregate insert hardcoded toolExecutionCount: 0, and the onConflictDoUpdate
// `set` didn't reference the column at all — so once the (orgId, period,
// periodKey) row existed (the common case, since daily/monthly rows are
// shared across many turns) the column could never move off 0 no matter how
// many tool calls ran.

describe('recordUsageFromSdkResult — tool_execution_count rollup', () => {
  it('increments tool_execution_count on the INSERT path when a tool ran this turn', async () => {
    const captured = setupDbMocks(null);

    await recordUsageFromSdkResult('sess-tool-1', 'org-1', {
      total_cost_usd: 0.11,
      usage: { input_tokens: 50_000, output_tokens: 300 },
      num_turns: 1,
      model: 'claude-sonnet-4-6',
      toolExecutionCount: 1,
    }, 'platform');

    expect(captured.aggregateValues).toHaveLength(2); // daily + monthly
    for (const values of captured.aggregateValues) {
      expect(values.toolExecutionCount).toBe(1);
    }
  });

  it('increments tool_execution_count via the onConflictDoUpdate SET (the row-already-exists path)', async () => {
    const captured = setupDbMocks(null);

    await recordUsageFromSdkResult('sess-tool-2', 'org-1', {
      total_cost_usd: 0.11,
      usage: { input_tokens: 50_000, output_tokens: 300 },
      num_turns: 1,
      model: 'claude-sonnet-4-6',
      toolExecutionCount: 1,
    }, 'platform');

    expect(captured.aggregateConflictSets).toHaveLength(2); // daily + monthly
    for (const set of captured.aggregateConflictSets) {
      // sql`${aiCostUsage.toolExecutionCount} + ${1}` — must add 1, not be absent/0.
      expect(recordedIncrement(set, 'toolExecutionCount')).toBe(1);
    }
  });

  it('leaves tool_execution_count untouched (adds 0) when no tool ran this turn', async () => {
    const captured = setupDbMocks(null);

    await recordUsageFromSdkResult('sess-no-tool', 'org-1', {
      total_cost_usd: 0.05,
      usage: { input_tokens: 1_000, output_tokens: 100 },
      num_turns: 1,
      model: 'claude-sonnet-4-6',
      // toolExecutionCount omitted — must default to 0, not throw or skip the column.
    }, 'platform');

    for (const values of captured.aggregateValues) {
      expect(values.toolExecutionCount).toBe(0);
    }
    for (const set of captured.aggregateConflictSets) {
      expect(recordedIncrement(set, 'toolExecutionCount')).toBe(0);
    }
  });
});

// ============================================
// Input-token accounting — cache reads/creations ARE input
// ============================================

/** The number added to ai_sessions.total_input_tokens / total_output_tokens. */
function recordedTokens(captured: Record<string, unknown> | undefined, key: 'totalInputTokens' | 'totalOutputTokens'): number {
  const expr = captured?.[key] as { values?: unknown[] } | undefined;
  return Number(expr?.values?.[1]);
}

describe('recordUsageFromSdkResult — input token accounting', () => {
  // Release QA: an 8-turn session showed total_input_tokens = 17 against
  // total_output_tokens = 1029 and $0.57 of spend. Prompt caching routes almost
  // the entire prompt through cache_read_input_tokens on every turn after the
  // first, and only the uncached remainder was being accumulated.
  it('counts cache-read and cache-creation tokens as input', async () => {
    const captured = setupDbMocks(null);

    await recordUsageFromSdkResult('sess-tokens', 'org-1', {
      total_cost_usd: 0.5,
      usage: {
        input_tokens: 17,
        output_tokens: 1_029,
        cache_read_input_tokens: 120_000,
        cache_creation_input_tokens: 4_500,
      },
      num_turns: 1,
      model: 'claude-sonnet-4-6',
    }, 'platform');

    expect(recordedTokens(captured.sessionSet, 'totalInputTokens')).toBe(17 + 120_000 + 4_500);
    expect(recordedTokens(captured.sessionSet, 'totalOutputTokens')).toBe(1_029);
  });

  it('records the same total on the daily/monthly org aggregates', async () => {
    const captured = setupDbMocks(null);

    await recordUsageFromSdkResult('sess-agg', 'org-1', {
      total_cost_usd: 0.5,
      usage: {
        input_tokens: 17,
        output_tokens: 1_029,
        cache_read_input_tokens: 120_000,
        cache_creation_input_tokens: 4_500,
      },
      num_turns: 1,
      model: 'claude-sonnet-4-6',
    }, 'platform');

    // One insert per period (daily + monthly); both carry the summed input.
    expect(captured.aggregateValues).toHaveLength(2);
    for (const values of captured.aggregateValues) {
      expect(values.inputTokens).toBe(17 + 120_000 + 4_500);
      expect(values.outputTokens).toBe(1_029);
    }
  });

  it('records a fully-cached turn as real input, not zero', async () => {
    const captured = setupDbMocks(null);

    await recordUsageFromSdkResult('sess-cached-only', 'org-1', {
      total_cost_usd: 0,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 1_000_000,
        cache_creation_input_tokens: 0,
      },
      num_turns: 1,
      model: 'claude-sonnet-4-6',
    }, 'platform');

    expect(recordedTokens(captured.sessionSet, 'totalInputTokens')).toBe(1_000_000);
    // ...and the cost path is untouched by the summing: still priced off the
    // SPLIT components (1M cache-read at 0.1x of 300 c/MTok = 30), never off the
    // sum. Summing into the pricing call would have billed 300 here.
    expect(recordedCostCents(captured.sessionSet)).toBe(30);
  });

  it('leaves cost alone when cache fields are present alongside real spend', async () => {
    // Guards against the obvious mis-fix: feeding the summed input back into
    // calculateCostCents would double-count cache tokens at the full input rate.
    const captured = setupDbMocks(null);

    await recordUsageFromSdkResult('sess-cost-guard', 'org-1', {
      total_cost_usd: 0,
      usage: {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
        cache_read_input_tokens: 1_000_000,
        cache_creation_input_tokens: 1_000_000,
      },
      num_turns: 1,
      model: 'claude-sonnet-4-6',
    }, 'platform');

    expect(recordedTokens(captured.sessionSet, 'totalInputTokens')).toBe(3_000_000);
    expect(recordedCostCents(captured.sessionSet)).toBe(2205); // unchanged from the pricing test above
  });

  it('is unaffected when the payload carries no cache fields at all', async () => {
    // Older/partial usage payloads and the vLLM path have no prompt caching.
    const captured = setupDbMocks(null);

    await recordUsageFromSdkResult('sess-nocache', 'org-1', {
      total_cost_usd: 0.1,
      usage: { input_tokens: 5_000, output_tokens: 2_000 },
      num_turns: 1,
      model: 'claude-sonnet-4-6',
    }, 'platform');

    expect(recordedTokens(captured.sessionSet, 'totalInputTokens')).toBe(5_000);
  });
});

describe('sumInputTokens', () => {
  it('sums the three disjoint slices the SDK splits input across', () => {
    expect(sumInputTokens({
      input_tokens: 17,
      cache_read_input_tokens: 120_000,
      cache_creation_input_tokens: 4_500,
    })).toBe(124_517);
  });

  it('treats missing and null components as 0', () => {
    expect(sumInputTokens({})).toBe(0);
    expect(sumInputTokens({ input_tokens: 10, cache_read_input_tokens: null })).toBe(10);
  });

  it('never throws on a nullish usage object', () => {
    // It sits ahead of the `done` publish that returns the session to 'idle';
    // a throw there strands the turn and hangs the client.
    expect(sumInputTokens(null)).toBe(0);
    expect(sumInputTokens(undefined)).toBe(0);
  });
});

// ============================================
// recordUsage — sessionless org-budget path (issue #1949)
// ============================================

describe('recordUsage', () => {
  it('uses catalog snapshot pricing instead of MODEL_PRICING', async () => {
    const captured = setupDbMocks(null);
    const catalogPricing = {
      catalogEntryId: 'cat-1',
      revisionId: 'rev-1',
      inputCentsPerM: 200,
      outputCentsPerM: 1000,
      cacheReadCentsPerM: 20,
      cacheWriteCentsPerM: 250,
    };

    await recordUsage(
      'sess-catalog',
      'org-1',
      'claude-sonnet-4-6',
      1_000_000,
      1_000_000,
      false,
      'partner_key',
      catalogPricing,
    );

    expect(recordedCostCents(captured.sessionSet)).toBe(1200);
  });

  it('keeps MODEL_PRICING cost when catalog pricing is omitted', async () => {
    const captured = setupDbMocks(null);

    await recordUsage(
      'sess-no-catalog',
      'org-1',
      'claude-sonnet-4-6',
      1_000_000,
      1_000_000,
      false,
      'platform',
    );

    expect(recordedCostCents(captured.sessionSet)).toBe(1800);
  });

  it('stamps partner-key on insert and conflict-update values without invoking billing deduction', async () => {
    const fetchMock = enableBillingService();
    const captured = setupDbMocks(null);

    await recordUsage(
      null,
      'org-1',
      'claude-sonnet-4-6',
      1_000,
      500,
      false,
      'partner_key',
    );

    expect(captured.aggregateValues).toHaveLength(2);
    expect(captured.aggregateValues.every((values) => values.billingSource === 'partner_key')).toBe(true);
    expect(captured.aggregateConflictSets.every((set) => set.billingSource === 'partner_key')).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps platform recording behavior while stamping the platform discriminator', async () => {
    const fetchMock = enableBillingService();
    const captured = setupDbMocks(null);

    await recordUsage(
      null,
      'org-1',
      'claude-sonnet-4-6',
      1_000,
      500,
      false,
      'platform',
    );

    expect(captured.aggregateValues.every((values) => values.billingSource === 'platform')).toBe(true);
    expect(captured.aggregateConflictSets.every((set) => set.billingSource === 'platform')).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('records the session row when a real sessionId is given', async () => {
    const captured = setupDbMocks(null);

    // sonnet-4-6 1M/1M → 1800 cents on the session row.
    await recordUsage('sess-1', 'org-1', 'claude-sonnet-4-6', 1_000_000, 1_000_000, true, 'platform');

    expect(mockDb.update).toHaveBeenCalledTimes(1);
    expect(recordedCostCents(captured.sessionSet)).toBe(1800);
  });

  it('skips the ai_sessions update but still writes org aggregates when sessionId is null', async () => {
    // The catalog AI enrichment flow has no ai_sessions row. Passing null must
    // NOT touch ai_sessions (the old non-UUID label threw and bypassed budgets,
    // issue #1949) yet must still record the org-budget aggregates.
    const captured = setupDbMocks(null);

    await recordUsage(null, 'org-1', 'claude-sonnet-4-6', 1_000_000, 1_000_000, true, 'platform');

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
      recordUsage(null, 'org-1', 'claude-sonnet-4-6', 100, 50, true, 'platform'),
    ).resolves.toBeUndefined();
  });

  it('evaluates budget thresholds after recording usage (#4388)', async () => {
    setupDbMocks(null);

    await recordUsage('sess-1', 'org-1', 'claude-sonnet-4-6', 1_000_000, 1_000_000, true, 'platform');
    await new Promise((r) => setImmediate(r)); // fire-and-forget settles

    expect(evaluateAiBudgetThresholds).toHaveBeenCalledWith('org-1');
  });
});

// ============================================
// recordSessionlessSdkUsage — headless agent runs (wave 3c review finding)
// ============================================

describe('recordSessionlessSdkUsage', () => {
  const agentRunUsage = {
    costCents: 40,
    usage: {
      input_tokens: 10,
      output_tokens: 20,
      cache_read_input_tokens: 90_000,
      cache_creation_input_tokens: 5_000,
    },
    numTurns: 5,
    toolExecutionCount: 3,
    model: 'claude-sonnet-4-6',
  };

  it('writes the org aggregates without touching ai_sessions', async () => {
    const captured = setupDbMocks(null);

    await recordSessionlessSdkUsage('org-1', agentRunUsage, 'platform');

    // There is no session row for a headless run.
    expect(mockDb.update).not.toHaveBeenCalled();
    expect(captured.aggregateValues).toHaveLength(2);
    expect(captured.aggregateValues.map((v) => v.period).sort()).toEqual(['daily', 'monthly']);
    for (const agg of captured.aggregateValues) {
      // The SDK's own figure, not a re-pricing of input+output.
      expect(agg.totalCostCents).toBe(40);
      // All three input slices, so a cached agent prompt is not under-reported.
      expect(agg.inputTokens).toBe(95_010);
      expect(agg.outputTokens).toBe(20);
      expect(agg.toolExecutionCount).toBe(3);
      expect(agg.messageCount).toBe(5);
    }
    for (const set of captured.aggregateConflictSets) {
      expect(recordedIncrement(set, 'inputTokens')).toBe(95_010);
      expect(recordedCostCents(set)).toBe(40);
      expect(recordedIncrement(set, 'messageCount')).toBe(5);
      expect(recordedIncrement(set, 'toolExecutionCount')).toBe(3);
    }
  });

  it('deducts platform AI credits — the gap that made agent runs effectively free', async () => {
    const fetchMock = enableBillingService();
    setupDbMocks(null);

    await recordSessionlessSdkUsage('org-1', agentRunUsage, 'platform');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://billing.internal/api/internal/partners/partner-1/ai-credits/deduct',
      expect.objectContaining({ method: 'POST' }),
    );
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body);
    expect(body).toEqual({ costCents: 40 });
  });

  it('never deducts credits for partner-key (BYOK) billing', async () => {
    const fetchMock = enableBillingService();
    setupDbMocks(null);

    await recordSessionlessSdkUsage('org-1', agentRunUsage, 'partner_key');

    expect(fetchMock).not.toHaveBeenCalled();
    const captured = setupDbMocks(null);
    await recordSessionlessSdkUsage('org-1', agentRunUsage, 'partner_key');
    expect(captured.aggregateValues.every((v) => v.billingSource === 'partner_key')).toBe(true);
  });

  it('records a cache-only turn that reports zero plain input/output tokens', async () => {
    const captured = setupDbMocks(null);

    await recordSessionlessSdkUsage('org-1', {
      costCents: 12,
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 200_000 },
      numTurns: 2,
    }, 'platform');

    expect(captured.aggregateValues).toHaveLength(2);
    expect(captured.aggregateValues[0]!.totalCostCents).toBe(12);
    expect(captured.aggregateValues[0]!.inputTokens).toBe(200_000);
  });

  it('prices from tokens when the SDK reported no cost (issue #1326 shape)', async () => {
    const captured = setupDbMocks(null);

    await recordSessionlessSdkUsage('org-1', {
      costCents: 0,
      usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
      numTurns: 1,
      model: 'claude-sonnet-4-6',
    }, 'platform');

    expect(captured.aggregateValues[0]!.totalCostCents).toBe(1800);
  });

  it('writes nothing at all for an empty result', async () => {
    const captured = setupDbMocks(null);

    await recordSessionlessSdkUsage('org-1', {
      costCents: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
      numTurns: 0,
    }, 'platform');

    expect(captured.aggregateValues).toHaveLength(0);
  });

  it('self-contexts every write (the caller is a contextless BullMQ processor)', async () => {
    setupDbMocks(null);

    await recordSessionlessSdkUsage('org-1', agentRunUsage, 'platform');

    // Both upserts (+ the credit lookup) run inside their own short system
    // context: a contextless write under forced RLS matches 0 rows.
    expect(vi.mocked(withSystemDbAccessContext).mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('getUsageSummary billing display', () => {
  it.each([
    ['partner_key', 'partner_key'],
    ['platform', 'platform'],
  ] as const)('reports billing-source lookup %s as %s', async (source, billedTo) => {
    getLlmBillingSourceForOrgMock.mockResolvedValueOnce(source);
    setupDbMocks(null);

    await expect(getUsageSummary('org-1')).resolves.toMatchObject({ billedTo });
    expect(getLlmBillingSourceForOrgMock).toHaveBeenCalledWith('org-1');
  });
});

describe('getUsageSummary catalog endpoint provenance (#3922 W4)', () => {
  it('names the endpoint when the org has a recent catalog-routed session', async () => {
    getLlmBillingSourceForOrgMock.mockResolvedValueOnce('partner_key');
    getCatalogEntryNameMock.mockResolvedValueOnce('OpenRouter');
    setupDbMocks(null, 'entry-1');

    await expect(getUsageSummary('org-1')).resolves.toMatchObject({
      catalogEndpointName: 'OpenRouter',
    });
    expect(getCatalogEntryNameMock).toHaveBeenCalledWith('entry-1');
  });

  it('is null when billed to the partner key but no session ever used a catalog endpoint', async () => {
    getLlmBillingSourceForOrgMock.mockResolvedValueOnce('partner_key');
    setupDbMocks(null, undefined);

    await expect(getUsageSummary('org-1')).resolves.toMatchObject({
      catalogEndpointName: null,
    });
    expect(getCatalogEntryNameMock).not.toHaveBeenCalled();
  });

  // Filtering the lookup to sessions that HAVE a catalog entry makes the note
  // sticky forever: once any session ever routed through an endpoint, the
  // usage page keeps claiming "billed to your key via <name>" in the present
  // tense after the partner has switched back to Anthropic (direct) or to a
  // different endpoint. The lookup must read the org's LATEST session.
  it('is null once the org\'s most recent session ran direct again after a catalog-routed one', async () => {
    getLlmBillingSourceForOrgMock.mockResolvedValueOnce('partner_key');
    setupDbMocks(null, null);

    await expect(getUsageSummary('org-1')).resolves.toMatchObject({
      catalogEndpointName: null,
    });
    expect(getCatalogEntryNameMock).not.toHaveBeenCalled();
  });

  it('never narrows the lookup to catalog-routed sessions', async () => {
    getLlmBillingSourceForOrgMock.mockResolvedValueOnce('partner_key');
    getCatalogEntryNameMock.mockResolvedValueOnce('OpenRouter');
    const captured = setupDbMocks(null, 'entry-1');

    await getUsageSummary('org-1');

    // `isNotNull` is mocked to `{ _isNotNull: [...] }`, so an unfiltered
    // lookup leaves no such marker anywhere in the captured condition.
    expect(captured.catalogLookupWhere).toBeDefined();
    expect(JSON.stringify(captured.catalogLookupWhere)).not.toContain('_isNotNull');
  });

  it('is null without a lookup when billed to the platform key', async () => {
    getLlmBillingSourceForOrgMock.mockResolvedValueOnce('platform');
    setupDbMocks(null, 'entry-1');

    await expect(getUsageSummary('org-1')).resolves.toMatchObject({
      catalogEndpointName: null,
    });
    expect(getCatalogEntryNameMock).not.toHaveBeenCalled();
  });
});

// ============================================
// #4388: /ai/usage effective budget + fired-alert ladder
// ============================================
//
// getUsageSummary used to read the raw `ai_budgets` row directly. It now
// reads the EFFECTIVE budget (org row merged with any partner-wide override,
// via getEffectiveAiBudget) so a partner-set cap is reflected here exactly
// like it already is in checkBudgetDetailed. It also reports which alert
// rungs have already fired for the org's current daily/monthly periods.

describe('getUsageSummary: effective budget + alert ladder (#4388)', () => {
  const effectiveBudget = (over: Record<string, unknown> = {}) => ({
    ...DEFAULT_EFFECTIVE_BUDGET,
    ...over,
  }) as Awaited<ReturnType<typeof getEffectiveAiBudget>>;

  const currentMonthKey = () => {
    const now = new Date();
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  };
  const currentDailyKey = () => {
    const now = new Date();
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
  };

  beforeEach(() => {
    setupDbMocks(null);
  });

  it('returns the EFFECTIVE budget (partner override wins) and the threshold ladder', async () => {
    // getUsageSummary reads ONLY getEffectiveAiBudget (the org row merged with
    // any partner-wide override); it no longer selects the raw `ai_budgets`
    // row, so what this helper resolves is exactly what ships.
    vi.mocked(getEffectiveAiBudget).mockResolvedValue(effectiveBudget({
      monthlyBudgetCents: 5000,
      dailyBudgetCents: null,
      approvalMode: 'per_step',
      alertThresholdPercents: [50, 80, 95],
    }));

    const summary = await getUsageSummary('org1');

    expect(summary.budget?.monthlyBudgetCents).toBe(5000);
    expect(summary.budget?.alertThresholdPercents).toEqual([50, 80, 95]);
    // #2190: the budget read must be self-contexted like checkBudgetDetailed.
    // getUsageSummary only wraps that one read (unlike checkBudget, which
    // also self-contexts a usage read), so it's called exactly once here.
    expect(vi.mocked(withSystemDbAccessContext)).toHaveBeenCalledTimes(1);
  });

  it('lists rungs fired in the current periods', async () => {
    vi.mocked(getEffectiveAiBudget).mockResolvedValue(effectiveBudget({ monthlyBudgetCents: 5000 }));
    vi.mocked(db.execute).mockResolvedValueOnce([
      {
        period: 'monthly',
        period_key: currentMonthKey(),
        threshold_pct: 80,
        created_at: '2026-09-03T10:00:00Z',
        delivered_at: '2026-09-03T10:00:05Z',
      },
    ] as never);

    const summary = await getUsageSummary('org1');

    expect(summary.alerts.fired).toEqual([
      {
        period: 'monthly',
        periodKey: currentMonthKey(),
        thresholdPct: 80,
        createdAt: '2026-09-03T10:00:00.000Z',
        deliveredAt: '2026-09-03T10:00:05.000Z',
      },
    ]);
  });

  it('reports an undelivered rung with a null deliveredAt', async () => {
    vi.mocked(getEffectiveAiBudget).mockResolvedValue(effectiveBudget({ dailyBudgetCents: 1000 }));
    vi.mocked(db.execute).mockResolvedValueOnce([
      {
        period: 'daily',
        period_key: currentDailyKey(),
        threshold_pct: 50,
        created_at: '2026-09-03T10:00:00Z',
        delivered_at: null,
      },
    ] as never);

    const summary = await getUsageSummary('org1');

    expect(summary.alerts.fired).toEqual([
      {
        period: 'daily',
        periodKey: currentDailyKey(),
        thresholdPct: 50,
        createdAt: '2026-09-03T10:00:00.000Z',
        deliveredAt: null,
      },
    ]);
  });

  // The instruction not to use a vacuous assertion here means: don't just
  // stub db.execute to return whatever and check the mapping (the test
  // above already does that). Separately prove the query itself is scoped
  // to THIS org and THIS org's current daily/monthly period keys, by
  // asserting on the exact rendered SQL text and interpolated values that
  // reached the mocked db.execute call.
  it('scopes the fired-events query to this org and its current daily/monthly period keys', async () => {
    vi.mocked(getEffectiveAiBudget).mockResolvedValue(effectiveBudget());
    const executeMock = vi.mocked(db.execute);

    await getUsageSummary('org-scope-1');

    expect(executeMock).toHaveBeenCalledTimes(1);
    const queryArg = executeMock.mock.calls[0]![0] as unknown as {
      _sql: TemplateStringsArray;
      values: unknown[];
    };
    const renderedSql = queryArg._sql.join('?');
    expect(renderedSql).toContain('FROM ai_budget_alert_events');
    expect(renderedSql).toContain("period = 'daily'");
    expect(renderedSql).toContain("period = 'monthly'");
    expect(queryArg.values).toEqual(['org-scope-1', currentDailyKey(), currentMonthKey()]);
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

    const res = await checkBudget('org-1', 'platform');

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

    await expect(checkBudget('org-1', 'platform')).resolves.toBeNull();
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

    await recordUsage(null, 'org-1', 'claude-sonnet-4-6', 100, 50, false, 'platform');

    // Both aggregates written, each inside its own short context (a third call
    // may come from the fire-and-forget anomaly check — assert at least the two
    // awaited upserts).
    expect(captured.aggregateValues.length).toBe(2);
    expect(vi.mocked(withSystemDbAccessContext).mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

// ============================================
// checkSystemAiRateLimit — org-scoped bucket for SYSTEM principals
// ============================================
//
// Reached from `buildExtensionAiContext` whenever the acting principal is not a
// user (an extension's bulk enrichment batch). It deliberately skips the
// per-USER bucket `checkAiRateLimit` also consults — that bucket is keyed
// `ai:msg:user:<id>` with no org component, so a synthetic actor id would put
// every tenant's automation in ONE deployment-wide 20/min bucket. These tests
// pin the three properties that makes load-bearing: the key it uses, the
// ceiling it reads, and the fact that it never touches the user bucket.

describe('checkSystemAiRateLimit', () => {
  const orgBudget = (over: Record<string, unknown> = {}) => ({
    enabled: true,
    monthlyBudgetCents: null,
    dailyBudgetCents: null,
    maxTurnsPerSession: 50,
    messagesPerMinutePerUser: 20,
    messagesPerHourPerOrg: 200,
    approvalMode: 'per_step',
    ...over,
  }) as Awaited<ReturnType<typeof getEffectiveAiBudget>>;

  it('checks exactly one bucket — ai:msg:org:<id> at the org hourly ceiling', async () => {
    vi.mocked(getEffectiveAiBudget).mockResolvedValue(orgBudget({ messagesPerHourPerOrg: 750 }));
    vi.mocked(rateLimiter).mockResolvedValue(
      { allowed: true, resetAt: new Date() } as Awaited<ReturnType<typeof rateLimiter>>,
    );

    await expect(checkSystemAiRateLimit('org-sys-1')).resolves.toBeNull();

    // Exactly one call: the per-user bucket must NOT be consulted for a system
    // principal (it is deployment-global for a synthetic actor id).
    expect(vi.mocked(rateLimiter)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(rateLimiter)).toHaveBeenCalledWith(
      expect.anything(),
      'ai:msg:org:org-sys-1',
      750,
      3600,
    );
  });

  it('falls back to a 200/hr ceiling when no effective budget row is available', async () => {
    // getEffectiveAiBudget can resolve nullish for an org with no budget row;
    // the ceiling must not collapse to `undefined` (which rateLimiter would
    // treat as no limit at all).
    vi.mocked(getEffectiveAiBudget).mockResolvedValue(
      undefined as unknown as Awaited<ReturnType<typeof getEffectiveAiBudget>>,
    );
    vi.mocked(rateLimiter).mockResolvedValue(
      { allowed: true, resetAt: new Date() } as Awaited<ReturnType<typeof rateLimiter>>,
    );

    await expect(checkSystemAiRateLimit('org-sys-2')).resolves.toBeNull();
    expect(vi.mocked(rateLimiter)).toHaveBeenCalledWith(
      expect.anything(),
      'ai:msg:org:org-sys-2',
      200,
      3600,
    );
  });

  it('rejects with the reset time once the org hourly ceiling is exceeded', async () => {
    const resetAt = new Date('2026-08-27T12:00:00.000Z');
    vi.mocked(getEffectiveAiBudget).mockResolvedValue(orgBudget());
    vi.mocked(rateLimiter).mockResolvedValue(
      { allowed: false, resetAt } as Awaited<ReturnType<typeof rateLimiter>>,
    );

    await expect(checkSystemAiRateLimit('org-sys-3')).resolves.toBe(
      `Organization rate limit exceeded. Try again at ${resetAt.toISOString()}`,
    );
  });

  it('self-contexts its effective-budget read (#2190 — it is NOT Redis-only)', async () => {
    vi.mocked(getEffectiveAiBudget).mockResolvedValue(orgBudget());
    vi.mocked(rateLimiter).mockResolvedValue(
      { allowed: true, resetAt: new Date() } as Awaited<ReturnType<typeof rateLimiter>>,
    );

    await checkSystemAiRateLimit('org-sys-4');

    // Contextless (the enrichment/agent paths hold no ambient request
    // transaction) this read RLS-filters to 0 rows and throws a 404.
    expect(vi.mocked(withSystemDbAccessContext)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getEffectiveAiBudget)).toHaveBeenCalledWith('org-sys-4');
  });
});

// ============================================
// Permanent-vs-transient AI denials (review round 2)
// ============================================
//
// `checkBudget`/`checkBillingCredits` answer "is this org allowed to spend?" with
// a human string, which erases WHY. A caller that retries (the workspace ingest
// job) needs the why: a daily cap rolls over, an org with AI switched off or a
// partner on a plan without AI never does. Collapsing both into one retryable
// shape burned every ingest attempt and stalled the whole pipeline behind a
// feature the tenant had simply turned off.

describe('checkBillingCreditsDetailed', () => {
  it('classifies the free/starter plan gate as PERMANENT', async () => {
    const fetchMock = enableBillingService();
    fetchMock.mockResolvedValueOnce(billingCreditsResponse({
      allowed: false, remainingCredits: 0, plan: 'starter',
    }));
    setupDbMocks(null);

    await expect(checkBillingCreditsDetailed('org-cd-1', 'platform')).resolves.toEqual({
      message: 'AI assistant requires the Community plan.',
      reason: 'plan_gate',
      permanent: true,
    });
  });

  it('classifies exhausted prepaid credits as TRANSIENT (a top-up clears it)', async () => {
    const fetchMock = enableBillingService();
    fetchMock.mockResolvedValueOnce(billingCreditsResponse({
      allowed: false, remainingCredits: 0, plan: 'community',
    }));
    setupDbMocks(null);

    await expect(checkBillingCreditsDetailed('org-cd-2', 'platform')).resolves.toMatchObject({
      reason: 'credits_exhausted',
      permanent: false,
    });
  });

  it('keeps the legacy string-or-null wrapper in step with the detailed result', async () => {
    const fetchMock = enableBillingService();
    fetchMock.mockResolvedValue(billingCreditsResponse({
      allowed: false, remainingCredits: 0, plan: 'starter',
    }));
    setupDbMocks(null);

    await expect(checkBillingCredits('org-cd-3', 'platform')).resolves.toBe(
      'AI assistant requires the Community plan.',
    );
  });
});

describe('checkBudgetDetailed', () => {
  const budget = (over: Record<string, unknown> = {}) => ({
    enabled: true,
    monthlyBudgetCents: null,
    dailyBudgetCents: null,
    maxTurnsPerSession: 50,
    messagesPerMinutePerUser: 20,
    messagesPerHourPerOrg: 200,
    approvalMode: 'per_step',
    ...over,
  }) as Awaited<ReturnType<typeof getEffectiveAiBudget>>;

  it('classifies an org with AI switched off as PERMANENT', async () => {
    vi.mocked(getEffectiveAiBudget).mockResolvedValue(budget({ enabled: false }));
    setupDbMocks(null);

    await expect(checkBudgetDetailed('org-bd-1', 'platform')).resolves.toEqual({
      message: 'AI features are disabled for this organization',
      reason: 'ai_disabled',
      permanent: true,
    });
  });

  it('classifies a spent daily cap as TRANSIENT (it rolls over at UTC midnight)', async () => {
    vi.mocked(getEffectiveAiBudget).mockResolvedValue(budget({ dailyBudgetCents: 1000 }));
    mockDb.select.mockImplementation(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([{ totalCostCents: 1000 }]) })),
      })),
    }));

    await expect(checkBudgetDetailed('org-bd-2', 'platform')).resolves.toMatchObject({
      reason: 'daily_budget',
      permanent: false,
    });
  });

  it('classifies a spent monthly cap as TRANSIENT', async () => {
    vi.mocked(getEffectiveAiBudget).mockResolvedValue(
      budget({ dailyBudgetCents: null, monthlyBudgetCents: 5000 }),
    );
    mockDb.select.mockImplementation(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([{ totalCostCents: 5000 }]) })),
      })),
    }));

    await expect(checkBudgetDetailed('org-bd-3', 'platform')).resolves.toMatchObject({
      reason: 'monthly_budget',
      permanent: false,
    });
  });

  it('propagates a PERMANENT plan gate from the credit check ahead of any budget read', async () => {
    const fetchMock = enableBillingService();
    fetchMock.mockResolvedValueOnce(billingCreditsResponse({
      allowed: false, remainingCredits: 0, plan: 'free',
    }));
    vi.mocked(getEffectiveAiBudget).mockResolvedValue(budget());
    setupDbMocks(null);

    await expect(checkBudgetDetailed('org-bd-4', 'partner_key')).resolves.toMatchObject({
      reason: 'plan_gate',
      permanent: true,
    });
    // The plan gate short-circuits — no budget row is read at all.
    expect(vi.mocked(getEffectiveAiBudget)).not.toHaveBeenCalled();
  });

  it('resolves null (and the wrapper stays null) when the org is within budget', async () => {
    vi.mocked(getEffectiveAiBudget).mockResolvedValue(budget({ dailyBudgetCents: 1000 }));
    mockDb.select.mockImplementation(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([{ totalCostCents: 1 }]) })),
      })),
    }));

    await expect(checkBudgetDetailed('org-bd-5', 'platform')).resolves.toBeNull();
    await expect(checkBudget('org-bd-5', 'platform')).resolves.toBeNull();
  });
});

// ============================================
// Billing-service telemetry (review round 2)
// ============================================
//
// Both billing calls are deliberately FAIL-OPEN: a billing outage must not take
// AI down for every tenant. The defect was that they were also fail-SILENT —
// `deductBillingCredits` ignored the HTTP status entirely, so a 500 or a 403
// from the billing service dropped platform-funded spend on the floor with no
// console line and no Sentry event, and `checkBillingCredits` returned a bare
// `null` (= allowed) from four different failure branches. The behaviour stays
// fail-open; only the silence goes away.
//
// Every test uses a DISTINCT org id on purpose: the capture helper throttles to
// one event per key per hour, and the key is org-scoped, so reusing an id would
// make a later assertion pass or fail depending on test ORDER.

describe('billing telemetry', () => {
  it('deductBillingCredits reports a non-2xx billing response with its status, without throwing', async () => {
    const fetchMock = enableBillingService();
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 502 }));
    setupDbMocks(null);

    await expect(deductBillingCredits('org-tel-1', 42)).resolves.toBeUndefined();

    expect(vi.mocked(captureMessage)).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        eventCode: 'ai_billing_credits_deduct_failed',
        tags: expect.objectContaining({ ai_billing_http_status: '502' }),
      }),
    );
  });

  it('deductBillingCredits stays silent on a 2xx deduction', async () => {
    const fetchMock = enableBillingService();
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    setupDbMocks(null);

    await deductBillingCredits('org-tel-2', 7);

    expect(vi.mocked(captureMessage)).not.toHaveBeenCalled();
    expect(vi.mocked(captureException)).not.toHaveBeenCalled();
  });

  it('deductBillingCredits reports a transport failure and still does not throw', async () => {
    const fetchMock = enableBillingService();
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    setupDbMocks(null);

    await expect(deductBillingCredits('org-tel-3', 42)).resolves.toBeUndefined();
    expect(vi.mocked(captureException)).toHaveBeenCalled();
  });

  it('deductBillingCredits reports an org with no partner to bill', async () => {
    enableBillingService();
    mockDb.select.mockImplementation(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([]) })), // org row absent
      })),
    }));

    await expect(deductBillingCredits('org-tel-4', 42)).resolves.toBeUndefined();
    expect(vi.mocked(captureMessage)).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ eventCode: 'ai_billing_org_partner_missing' }),
    );
  });

  it('checkBillingCredits reports a non-2xx credit check but still fails OPEN', async () => {
    const fetchMock = enableBillingService();
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 500 }));
    setupDbMocks(null);

    // Fail-open is the point: a billing outage must not block AI for everyone.
    await expect(checkBillingCredits('org-tel-5', 'platform')).resolves.toBeNull();
    expect(vi.mocked(captureMessage)).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        eventCode: 'ai_billing_credits_check_failed',
        tags: expect.objectContaining({ ai_billing_http_status: '500' }),
      }),
    );
  });

  it('checkBillingCredits reports a transport failure but still fails OPEN', async () => {
    const fetchMock = enableBillingService();
    fetchMock.mockRejectedValueOnce(new Error('socket hang up'));
    setupDbMocks(null);

    await expect(checkBillingCredits('org-tel-6', 'platform')).resolves.toBeNull();
    expect(vi.mocked(captureException)).toHaveBeenCalled();
  });

  it('says nothing when the billing service is simply not configured (self-hosted default)', async () => {
    delete process.env.BILLING_SERVICE_URL;
    delete process.env.BILLING_SERVICE_API_KEY;
    setupDbMocks(null);

    await expect(checkBillingCredits('org-tel-7', 'platform')).resolves.toBeNull();
    await expect(deductBillingCredits('org-tel-7', 42)).resolves.toBeUndefined();
    // A deployment mode, not a failure — reporting it would be pure noise.
    expect(vi.mocked(captureMessage)).not.toHaveBeenCalled();
    expect(vi.mocked(captureException)).not.toHaveBeenCalled();
  });
});
