import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  checkAiRateLimit,
  checkBillingCredits,
  checkBillingCreditsDetailed,
  checkBudget,
  checkBudgetDetailed,
  checkSystemAiRateLimit,
  debitBillingCredits,
  deductBillingCredits,
  getUsageSummary,
  sumInputTokens,
  updateBudget,
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

// #4388 W04: `set`/`get` back the per-partner credit-balance cache
// (checkBillingCreditsDetailed writes it, getUsageSummary reads it).
// `mockResolvedValue` at creation survives `vi.clearAllMocks()` in the outer
// beforeEach (it only clears call tracking, not the implementation), so each
// test only needs to override what it cares about via `mockResolvedValueOnce`
// / `mockRejectedValueOnce`.
const { redisSet, redisGet } = vi.hoisted(() => ({
  redisSet: vi.fn().mockResolvedValue('OK'),
  redisGet: vi.fn().mockResolvedValue(null),
}));
vi.mock('./redis', () => ({ getRedis: vi.fn(() => ({ set: redisSet, get: redisGet })) }));
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

// Task 15 (#7601): getUsageSummary's billedTo is the funding a chat in the
// org would resolve to (resolveModel), falling back to the monthly rollup label.
const { resolveModelMock, readOrgPartnerIdMock } = vi.hoisted(() => ({
  resolveModelMock: vi.fn(),
  readOrgPartnerIdMock: vi.fn(),
}));
vi.mock('./aiModels/resolveModel', () => ({
  resolveModel: (...args: unknown[]) => resolveModelMock(...args),
}));
vi.mock('./aiModels/candidateLoader', () => ({
  readOrgPartnerId: (...args: unknown[]) => readOrgPartnerIdMock(...args),
}));

/** The funding a chat in the org resolves to, for the next getUsageSummary. */
function chatFundingOnce(funding: 'platform' | 'partner_key') {
  resolveModelMock.mockResolvedValueOnce({ ok: true, funding });
}

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
  resolveModelMock.mockReset().mockResolvedValue({ ok: true, funding: 'platform' });
  readOrgPartnerIdMock.mockReset().mockResolvedValue('partner-1');
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
  includedBalance?: number;
  purchasedBalance?: number;
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

describe('getUsageSummary billing display', () => {
  /** Route the no-column `db.select()` reads (daily, then monthly rollup row). */
  function rollupRows(daily: Record<string, unknown> | null, monthly: Record<string, unknown> | null) {
    setupDbMocks(null);
    const base = mockDb.select.getMockImplementation() as (cols?: Record<string, unknown>) => unknown;
    const queue = [daily, monthly];
    mockDb.select.mockImplementation((cols?: Record<string, unknown>) => {
      if (cols) return base(cols);
      const row = queue.shift() ?? null;
      return {
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue(row ? [row] : []) })),
        })),
      };
    });
  }

  it.each([
    ['partner_key', 'partner_key'],
    ['platform', 'platform'],
  ] as const)('billedTo is the funding a chat in this org would use (%s)', async (funding, billedTo) => {
    chatFundingOnce(funding);
    setupDbMocks(null);

    await expect(getUsageSummary('org-1')).resolves.toMatchObject({ billedTo });
    expect(readOrgPartnerIdMock).toHaveBeenCalledWith('org-1');
    expect(resolveModelMock).toHaveBeenCalledWith({ partnerId: 'partner-1', orgId: 'org-1', surface: 'chat' });
  });

  it('a chat funding label wins over a contradicting rollup label', async () => {
    chatFundingOnce('platform');
    rollupRows(null, { billingSource: 'partner_key', totalCostCents: 5 });

    await expect(getUsageSummary('org-1')).resolves.toMatchObject({ billedTo: 'platform' });
  });

  it('billedTo falls back to the monthly rollup label when chat cannot resolve', async () => {
    resolveModelMock.mockResolvedValueOnce({ ok: false, reason: 'no_eligible_model', recoverable: true, offeringId: null, message: 'm' });
    rollupRows(null, { billingSource: 'partner_key', totalCostCents: 5 });

    await expect(getUsageSummary('org-1')).resolves.toMatchObject({ billedTo: 'partner_key' });
  });

  it('billedTo is platform when chat cannot resolve and there is no monthly rollup', async () => {
    resolveModelMock.mockResolvedValueOnce({ ok: false, reason: 'registry_unavailable', recoverable: true, offeringId: null, message: 'm' });
    rollupRows(null, null);

    await expect(getUsageSummary('org-1')).resolves.toMatchObject({ billedTo: 'platform' });
  });

  it('does not resolve a chat model for an org with no partner; uses the rollup label', async () => {
    readOrgPartnerIdMock.mockResolvedValueOnce(null);
    rollupRows(null, { billingSource: 'partner_key', totalCostCents: 5 });

    await expect(getUsageSummary('org-1')).resolves.toMatchObject({ billedTo: 'partner_key' });
    expect(resolveModelMock).not.toHaveBeenCalled();
  });

  it('never throws when the chat resolution fails; degrades to the rollup label', async () => {
    resolveModelMock.mockRejectedValueOnce(new Error('db down'));
    rollupRows(null, { billingSource: 'partner_key', totalCostCents: 5 });

    await expect(getUsageSummary('org-1')).resolves.toMatchObject({ billedTo: 'partner_key' });
    expect(captureException).toHaveBeenCalled();
  });
});

describe('getUsageSummary catalog endpoint provenance (#3922 W4)', () => {
  it('names the endpoint when the org has a recent catalog-routed session', async () => {
    chatFundingOnce('partner_key');
    getCatalogEntryNameMock.mockResolvedValueOnce('OpenRouter');
    setupDbMocks(null, 'entry-1');

    await expect(getUsageSummary('org-1')).resolves.toMatchObject({
      catalogEndpointName: 'OpenRouter',
    });
    expect(getCatalogEntryNameMock).toHaveBeenCalledWith('entry-1');
  });

  it('is null when billed to the partner key but no session ever used a catalog endpoint', async () => {
    chatFundingOnce('partner_key');
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
    chatFundingOnce('partner_key');
    setupDbMocks(null, null);

    await expect(getUsageSummary('org-1')).resolves.toMatchObject({
      catalogEndpointName: null,
    });
    expect(getCatalogEntryNameMock).not.toHaveBeenCalled();
  });

  it('never narrows the lookup to catalog-routed sessions', async () => {
    chatFundingOnce('partner_key');
    getCatalogEntryNameMock.mockResolvedValueOnce('OpenRouter');
    const captured = setupDbMocks(null, 'entry-1');

    await getUsageSummary('org-1');

    // `isNotNull` is mocked to `{ _isNotNull: [...] }`, so an unfiltered
    // lookup leaves no such marker anywhere in the captured condition.
    expect(captured.catalogLookupWhere).toBeDefined();
    expect(JSON.stringify(captured.catalogLookupWhere)).not.toContain('_isNotNull');
  });

  it('is null without a lookup when billed to the platform key', async () => {
    chatFundingOnce('platform');
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

// ============================================
// #4388 W04: partner credit-balance cache
// ============================================
//
// checkBillingCreditsDetailed and getUsageSummary share one fetch-and-cache
// path, writing the last-seen balance to Redis (`ai:credits:<partnerId>`,
// 900s TTL) so /ai/usage can surface it without a billing-service round trip
// per page load. The write must never fail the credit check itself: a Redis
// outage degrades to "no cached balance to show", not a broken AI gate.

describe('checkBillingCreditsDetailed: partner credit cache (#4388 W04)', () => {
  it('caches the last credit balance per partner for /ai/usage (#4388)', async () => {
    const fetchMock = enableBillingService();
    fetchMock.mockResolvedValueOnce(billingCreditsResponse({
      allowed: true, remainingCredits: 1240, includedBalance: 0, purchasedBalance: 1240, plan: 'pro',
    }));
    setupDbMocks(null); // organizations partnerId lookup resolves 'partner-1'

    await checkBillingCreditsDetailed('org-cache-1', 'platform');

    // 900s, not 60s: the cache is now read-through from the usage page, and a
    // one-minute TTL meant the credits card had nothing to render on almost
    // every page load.
    expect(redisSet).toHaveBeenCalledWith(
      'ai:credits:partner-1',
      expect.stringContaining('"remaining":1240'),
      'EX',
      900,
    );
    const written = JSON.parse(redisSet.mock.calls[0]![1] as string);
    expect(written).toMatchObject({ remaining: 1240, includedBalance: 0, purchasedBalance: 1240 });
    expect(typeof written.fetchedAt).toBe('string');
  });

  it('defaults includedBalance/purchasedBalance to 0 when the billing response omits them (pre-deploy compat)', async () => {
    const fetchMock = enableBillingService();
    fetchMock.mockResolvedValueOnce(billingCreditsResponse({
      allowed: true, remainingCredits: 500, plan: 'pro',
    }));
    setupDbMocks(null);

    await checkBillingCreditsDetailed('org-cache-2', 'platform');

    const written = JSON.parse(redisSet.mock.calls[0]![1] as string);
    expect(written).toMatchObject({ remaining: 500, includedBalance: 0, purchasedBalance: 0 });
  });

  it('does not throw and still returns the access decision when the cache write fails', async () => {
    const fetchMock = enableBillingService();
    fetchMock.mockResolvedValueOnce(billingCreditsResponse({
      allowed: true, remainingCredits: 10, plan: 'pro',
    }));
    setupDbMocks(null);
    redisSet.mockRejectedValueOnce(new Error('redis down'));

    await expect(checkBillingCreditsDetailed('org-cache-3', 'platform')).resolves.toBeNull();
  });
});

// getUsageSummary's `credits` field: the partner-wide balance, surfaced only
// when the CALLER opted in (`includeCredits`) and only for platform-billed
// orgs. Read-through: a cache miss fills the cache from the billing service
// rather than rendering nothing. Must never throw: a Redis outage, a missing
// partner, a corrupt entry, or a billing outage all degrade to
// `credits: null`, never a 500.
const CACHED = { remaining: 1240, includedBalance: 0, purchasedBalance: 1240, fetchedAt: '2026-09-01T00:00:00.000Z' };

describe('getUsageSummary: credits (#4388 W04)', () => {
  beforeEach(() => {
    setupDbMocks(null); // organizations partnerId lookup resolves 'partner-1'
    // vi.clearAllMocks() clears recorded calls but NOT queued
    // mockResolvedValueOnce values, and several tests here deliberately leave
    // one unconsumed (they assert the cache is never read). Reset explicitly
    // so that queued value cannot surface in the next test.
    redisGet.mockReset();
    redisGet.mockResolvedValue(null);
    redisSet.mockReset();
    redisSet.mockResolvedValue('OK');
  });

  it('returns the cached credit balance when billed to the platform and a cache entry exists', async () => {
    chatFundingOnce('platform');
    redisGet.mockResolvedValueOnce(JSON.stringify(CACHED));

    const summary = await getUsageSummary('org1', { includeCredits: true });

    expect(summary.credits).toEqual(CACHED);
    expect(redisGet).toHaveBeenCalledWith('ai:credits:partner-1');
  });

  // The partner-wide pool must not reach an org-scoped caller. Proven against
  // a WARM cache, so a null here is the flag withholding it, not an empty
  // cache: without the gate this same fixture returns the balance above.
  it('is null when the caller did not ask for credits, even with a warm cache', async () => {
    chatFundingOnce('platform');
    redisGet.mockResolvedValueOnce(JSON.stringify(CACHED));

    const summary = await getUsageSummary('org1');

    expect(summary.credits).toBeNull();
    expect(redisGet).not.toHaveBeenCalled();
  });

  it('is null for BYOK orgs (billedTo partner_key): never even reads the cache', async () => {
    chatFundingOnce('partner_key');

    const summary = await getUsageSummary('org1', { includeCredits: true });

    expect(summary.credits).toBeNull();
    expect(redisGet).not.toHaveBeenCalled();
  });

  it('is null when the org has no partner id', async () => {
    chatFundingOnce('platform');
    mockDb.select.mockImplementation((cols?: Record<string, unknown>) => {
      const isPartnerLookup = !!cols && 'partnerId' in cols;
      return {
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue(isPartnerLookup ? [{ partnerId: null }] : []),
          })),
        })),
      };
    });

    const summary = await getUsageSummary('org1', { includeCredits: true });

    expect(summary.credits).toBeNull();
    expect(redisGet).not.toHaveBeenCalled();
  });

  it('is null when uncached and no billing service is configured (self-hosted)', async () => {
    chatFundingOnce('platform');
    redisGet.mockResolvedValueOnce(null);

    const summary = await getUsageSummary('org1', { includeCredits: true });

    expect(summary.credits).toBeNull();
  });

  it('never throws when the Redis read fails; degrades to null', async () => {
    chatFundingOnce('platform');
    redisGet.mockRejectedValueOnce(new Error('redis down'));

    await expect(getUsageSummary('org1', { includeCredits: true })).resolves.toMatchObject({ credits: null });
  });

  it('is null (not a throw) when the cached value is corrupt/not valid JSON', async () => {
    chatFundingOnce('platform');
    redisGet.mockResolvedValueOnce('not-json');

    await expect(getUsageSummary('org1', { includeCredits: true })).resolves.toMatchObject({ credits: null });
  });
});

// Read-through fill. The cache used to be written ONLY by an AI turn, so on a
// fleet that is not mid-conversation the credits card essentially never
// rendered and the header cost indicator flickered. getUsageSummary now fills
// the cache itself on a miss.
describe('getUsageSummary: credit cache read-through (#4388 W04)', () => {
  beforeEach(() => {
    setupDbMocks(null); // organizations partnerId lookup resolves 'partner-1'
    // vi.clearAllMocks() clears recorded calls but NOT queued
    // mockResolvedValueOnce values, and several tests here deliberately leave
    // one unconsumed (they assert the cache is never read). Reset explicitly
    // so that queued value cannot surface in the next test.
    redisGet.mockReset();
    redisGet.mockResolvedValue(null);
    redisSet.mockReset();
    redisSet.mockResolvedValue('OK');
  });

  it('a cache HIT does not call the billing service at all', async () => {
    const fetchMock = enableBillingService();
    chatFundingOnce('platform');
    redisGet.mockResolvedValueOnce(JSON.stringify(CACHED));

    const summary = await getUsageSummary('org1', { includeCredits: true });

    expect(summary.credits).toEqual(CACHED);
    // /ai/usage is polled by the header indicator on every page; a hit that
    // still round-trips to billing would defeat the cache entirely.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a cache MISS fetches from billing once and writes the cache with a 900s TTL', async () => {
    const fetchMock = enableBillingService();
    fetchMock.mockResolvedValueOnce(billingCreditsResponse({
      allowed: true, remainingCredits: 777, includedBalance: 200, purchasedBalance: 577, plan: 'pro',
    }));
    chatFundingOnce('platform');
    redisGet.mockResolvedValueOnce(null);

    const summary = await getUsageSummary('org1', { includeCredits: true });

    expect(summary.credits).toMatchObject({ remaining: 777, includedBalance: 200, purchasedBalance: 577 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://billing.internal/billing/api/internal/partners/partner-1/ai-credits',
      expect.objectContaining({ headers: { Authorization: 'Bearer billing-key' } }),
    );
    expect(redisSet).toHaveBeenCalledWith(
      'ai:credits:partner-1',
      expect.stringContaining('"remaining":777'),
      'EX',
      900,
    );
  });

  it('a billing HTTP failure on the miss path yields credits: null without throwing', async () => {
    const fetchMock = enableBillingService();
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
    chatFundingOnce('platform');
    redisGet.mockResolvedValueOnce(null);

    await expect(getUsageSummary('org1', { includeCredits: true })).resolves.toMatchObject({ credits: null });
  });

  it('a billing transport failure on the miss path yields credits: null without throwing', async () => {
    const fetchMock = enableBillingService();
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    chatFundingOnce('platform');
    redisGet.mockResolvedValueOnce(null);

    await expect(getUsageSummary('org1', { includeCredits: true })).resolves.toMatchObject({ credits: null });
  });
});

// breeze-billing mounts its internal router at `/billing/api/internal`
// (`app.route('/billing/api/internal', internalRoutes)`), and
// `breezeBillingClient.cancelSubscription` already uses that prefix. These two
// call sites were built against a bare `/api/internal`, so every credit check
// and every deduction 404'd in production: the gate failed open and platform AI
// spend was never deducted. Pin the full path so a prefix drift is a red test.
describe('billing internal route prefix (#5591)', () => {
  it('the credit check fetches /billing/api/internal/partners/:id/ai-credits', async () => {
    setupDbMocks(null);
    const fetchMock = enableBillingService();
    fetchMock.mockResolvedValueOnce(billingCreditsResponse({
      allowed: true, remainingCredits: 500, plan: 'pro',
    }));
    chatFundingOnce('platform');
    redisGet.mockResolvedValue(null);

    await getUsageSummary('org1', { includeCredits: true });

    expect(new URL(fetchMock.mock.calls[0]![0] as string).pathname).toBe(
      '/billing/api/internal/partners/partner-1/ai-credits',
    );
  });

  it('the deduction posts to /billing/api/internal/partners/:id/ai-credits/deduct', async () => {
    setupDbMocks(null);
    const fetchMock = enableBillingService();

    await deductBillingCredits('org-1', 40);

    expect(new URL(fetchMock.mock.calls[0]![0] as string).pathname).toBe(
      '/billing/api/internal/partners/partner-1/ai-credits/deduct',
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

// ============================================
// Keyed credit debit (W03 #7601 Step 8a; billing-service PR #25)
// ============================================
//
// The billing service dedupes a debit by (partner, idempotency key). Its zod
// schema STRIPS unknown body fields, so a misspelled key field silently
// becomes an unkeyed, un-deduplicated debit: the field name is pinned here.
// 4xx is terminal (the same key can never succeed); 5xx and transport errors
// are retried by the caller under the SAME key.

describe('debitBillingCredits (keyed)', () => {
  const KEY = 'ai-settlement:11111111-1111-4111-8111-111111111111';

  function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  }

  it('sends the key as the body field `idempotencyKey` AND the Idempotency-Key header', async () => {
    const fetchMock = enableBillingService();
    fetchMock.mockResolvedValueOnce(json(200, { success: true }));
    setupDbMocks(null);

    await debitBillingCredits('org-key-1', 12.345678, { idempotencyKey: KEY });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toMatch(/\/billing\/api\/internal\/partners\/[^/]+\/ai-credits\/deduct$/);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['costCents', 'idempotencyKey']);
    expect(body).toEqual({ costCents: 12.345678, idempotencyKey: KEY });
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe(KEY);
  });

  it('200 → debited; a replay (Idempotent-Replayed: true) is also success', async () => {
    const fetchMock = enableBillingService();
    fetchMock
      .mockResolvedValueOnce(json(200, { success: true }))
      .mockResolvedValueOnce(json(200, { success: true }, { 'Idempotent-Replayed': 'true' }));
    setupDbMocks(null);

    await expect(debitBillingCredits('org-key-2', 5, { idempotencyKey: KEY })).resolves.toEqual({ kind: 'debited', replayed: false });
    await expect(debitBillingCredits('org-key-2', 5, { idempotencyKey: KEY })).resolves.toEqual({ kind: 'debited', replayed: true });
  });

  it.each([
    [400, { error: 'invalid_idempotency_key', message: 'idempotencyKey: bad value ai-settlement:x' }, 'http_400:invalid_idempotency_key'],
    [409, { error: 'idempotency_key_reused', message: 'nothing was deducted' }, 'http_409:idempotency_key_reused'],
    [403, 'forbidden', 'http_403'],
    // A rotated / wrong billing API key, and a deployment pointed at a billing
    // service without the route: retrying either can never help.
    [401, { error: 'unauthorized' }, 'http_401:unauthorized'],
    [404, 'not found', 'http_404'],
  ])('%i is TERMINAL: rejected with a short code, never the response message', async (status, body, code) => {
    const fetchMock = enableBillingService();
    fetchMock.mockResolvedValueOnce(typeof body === 'string' ? new Response(body, { status }) : json(status, body));
    setupDbMocks(null);

    const result = await debitBillingCredits('org-key-3', 5, { idempotencyKey: KEY });
    expect(result).toEqual({ kind: 'rejected', status, code });
  });

  it.each([
    [503, { error: 'deduct_unconfirmed' }, 'http_503:deduct_unconfirmed'],
    [500, { error: 'internal_error' }, 'http_500:internal_error'],
    [502, 'bad gateway', 'http_502'],
    [429, { error: 'rate_limited' }, 'http_429:rate_limited'],
    [408, 'timeout', 'http_408'],
  ])('%i is RETRYABLE under the same key', async (status, body, code) => {
    const fetchMock = enableBillingService();
    fetchMock.mockResolvedValueOnce(typeof body === 'string' ? new Response(body, { status }) : json(status, body));
    setupDbMocks(null);

    await expect(debitBillingCredits('org-key-4', 5, { idempotencyKey: KEY })).resolves.toEqual({ kind: 'retryable', status, code });
  });

  it('a transport failure or timeout is RETRYABLE', async () => {
    const fetchMock = enableBillingService();
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
    setupDbMocks(null);

    await expect(debitBillingCredits('org-key-5', 5, { idempotencyKey: KEY })).resolves.toEqual({ kind: 'retryable', status: null, code: 'transport' });
  });

  it('an org with no partner to bill is TERMINAL (org_partner_missing)', async () => {
    enableBillingService();
    mockDb.select.mockImplementation(() => ({
      from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([]) })) })),
    }));
    await expect(debitBillingCredits('org-key-6', 5, { idempotencyKey: KEY }))
      .resolves.toEqual({ kind: 'rejected', status: null, code: 'org_partner_missing' });
  });

  it('no billing service configured → not_configured, no request', async () => {
    delete process.env.BILLING_SERVICE_URL;
    delete process.env.BILLING_SERVICE_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(debitBillingCredits('org-key-7', 5, { idempotencyKey: KEY })).resolves.toEqual({ kind: 'not_configured' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses an empty key or a non-positive amount before any request', async () => {
    const fetchMock = enableBillingService();
    setupDbMocks(null);
    await expect(debitBillingCredits('org-key-8', 5, { idempotencyKey: '' })).rejects.toThrow(/idempotencyKey/);
    await expect(debitBillingCredits('org-key-8', Number.NaN, { idempotencyKey: KEY })).rejects.toThrow(/costCents/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ============================================
// updateBudget — #5592
// ============================================

/**
 * Wire `db` for updateBudget: `existingRow` drives the `ai_budgets` lookup
 * (`undefined` = no row yet, so the insert branch runs). Returns the values
 * handed to `db.insert(aiBudgets).values(...)` / `db.update(...).set(...)`.
 */
function setupBudgetDbMocks(existingRow?: Record<string, unknown>) {
  const capture: {
    insertValues?: Record<string, unknown>;
    updateSet?: Record<string, unknown>;
  } = {};

  mockDb.select.mockImplementation(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn().mockResolvedValue(existingRow ? [existingRow] : []),
      })),
    })),
  }));

  mockDb.insert.mockReturnValue({
    values: vi.fn(async (values: Record<string, unknown>) => {
      capture.insertValues = values;
    }),
  });

  mockDb.update.mockReturnValue({
    set: vi.fn((values: Record<string, unknown>) => {
      capture.updateSet = values;
      return { where: vi.fn().mockResolvedValue(undefined) };
    }),
  });

  return capture;
}

describe('updateBudget', () => {
  it('persists approvalMode on the FIRST save for an org with no ai_budgets row', async () => {
    const capture = setupBudgetDbMocks();

    await updateBudget('org-budget-1', { approvalMode: 'auto_approve' });

    expect(mockDb.insert).toHaveBeenCalledTimes(1);
    expect(mockDb.update).not.toHaveBeenCalled();
    // The bug (#5592): the insert branch enumerated columns and omitted
    // approvalMode, so the row fell back to the `per_step` column default and
    // the user's choice was silently discarded until a second save.
    expect(capture.insertValues?.approvalMode).toBe('auto_approve');
  });

  it('defaults approvalMode to per_step when the first save does not set it', async () => {
    const capture = setupBudgetDbMocks();

    await updateBudget('org-budget-2', { enabled: false });

    expect(capture.insertValues?.approvalMode).toBe('per_step');
  });

  it('carries every settings field through the insert branch', async () => {
    const capture = setupBudgetDbMocks();

    await updateBudget('org-budget-3', {
      enabled: false,
      monthlyBudgetCents: 5000,
      dailyBudgetCents: 250,
      maxTurnsPerSession: 10,
      messagesPerMinutePerUser: 5,
      messagesPerHourPerOrg: 60,
      approvalMode: 'hybrid_plan',
      alertThresholdPercents: [50, 90],
      toolRateLimitMultiplier: 3,
    });

    expect(capture.insertValues).toMatchObject({
      orgId: 'org-budget-3',
      enabled: false,
      monthlyBudgetCents: 5000,
      dailyBudgetCents: 250,
      maxTurnsPerSession: 10,
      messagesPerMinutePerUser: 5,
      messagesPerHourPerOrg: 60,
      approvalMode: 'hybrid_plan',
      alertThresholdPercents: [50, 90],
      toolRateLimitMultiplier: 3,
    });
  });

  it('updates in place (no insert) when a row already exists', async () => {
    const capture = setupBudgetDbMocks({ orgId: 'org-budget-4' });

    await updateBudget('org-budget-4', { approvalMode: 'action_plan' });

    expect(mockDb.insert).not.toHaveBeenCalled();
    expect(capture.updateSet?.approvalMode).toBe('action_plan');
  });
});
