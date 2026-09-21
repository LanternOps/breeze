import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AI_BUDGET_LOCK_TIMEOUT_MS,
  AI_BUDGET_SETTLEMENT_LOCK_TIMEOUT_MS,
  isAiBudgetLockTimeout,
  maxOutputTokensForAiBudget,
  reserveAiBudget,
  settleAiBudgetReservation,
  settleAiBudgetReservationDurably,
} from './aiBudgetReservations';

describe('maxOutputTokensForAiBudget', () => {
  it('keeps the provider ceiling for an unlimited reservation', () => {
    const calculateCostCents = vi.fn(() => 999);
    expect(maxOutputTokensForAiBudget({
      prompt: 'hello',
      requestedMaxOutputTokens: 1024,
      budgetCents: undefined,
      calculateCostCents,
    })).toBe(1024);
    expect(calculateCostCents).not.toHaveBeenCalled();
  });

  it('reduces output tokens so the conservative request cannot exceed the reservation', () => {
    const calculateCostCents = (inputTokens: number, outputTokens: number) =>
      inputTokens * 0.01 + outputTokens * 0.1;
    const cap = maxOutputTokensForAiBudget({
      prompt: 'hello',
      requestedMaxOutputTokens: 1024,
      budgetCents: 30,
      calculateCostCents,
    });
    expect(cap).not.toBeNull();
    const conservativeInputTokens = Buffer.byteLength('hello', 'utf8') + 256;
    expect(calculateCostCents(conservativeInputTokens, cap!)).toBeLessThanOrEqual(30);
    expect(calculateCostCents(conservativeInputTokens, cap! + 1)).toBeGreaterThan(30);
  });

  it('fails closed when the prompt alone consumes the reservation', () => {
    expect(maxOutputTokensForAiBudget({
      prompt: 'large request',
      requestedMaxOutputTokens: 1024,
      budgetCents: 1,
      calculateCostCents: () => 2,
    })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Transaction shape and lock bounding (review B2)
//
// These are unit tests on purpose. The property B2 is about — "admission runs
// in ONE system-scoped transaction, and its organization lock is bounded" — is
// a statement about which db helpers the module calls, and a mocked db is the
// only way to observe that deterministically. The integration suite proves the
// end-to-end consequence (20 concurrent admissions for one org complete
// instead of wedging the pool).
// ---------------------------------------------------------------------------

const { dbMock, hoisted } = vi.hoisted(() => ({
  dbMock: { execute: vi.fn() },
  hoisted: {
    runOutsideDbContext: vi.fn(),
    withSystemDbAccessContext: vi.fn(),
    withDbAccessContext: vi.fn(),
    getCurrentDbAccessContext: vi.fn(() => ({ scope: 'organization' as const })),
    tightenLockTimeout: vi.fn(async () => 0),
    getEffectiveAiBudget: vi.fn(),
    captureException: vi.fn(),
  },
}));

vi.mock('../db', () => ({
  db: dbMock,
  runOutsideDbContext: hoisted.runOutsideDbContext,
  withSystemDbAccessContext: hoisted.withSystemDbAccessContext,
  withDbAccessContext: hoisted.withDbAccessContext,
  getCurrentDbAccessContext: hoisted.getCurrentDbAccessContext,
}));
vi.mock('../db/lockTimeout', () => ({ tightenLockTimeout: hoisted.tightenLockTimeout }));
vi.mock('./effectiveSettings', () => ({ getEffectiveAiBudget: hoisted.getEffectiveAiBudget }));
vi.mock('./sentry', () => ({ captureException: hoisted.captureException }));

const ORG_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RESERVATION_ID = '12121212-1212-4121-8121-121212121212';

function reservationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: RESERVATION_ID,
    org_id: ORG_ID,
    idempotency_key: 'key-1',
    session_id: null,
    billing_source: 'platform',
    daily_period_key: '2026-09-10',
    monthly_period_key: '2026-09',
    uncapped: true,
    reserved_cost_cents: '0.000000',
    actual_cost_cents: null,
    status: 'active',
    settlement_fingerprint: null,
    expires_at: '2026-09-10T12:30:00.000Z',
    ...overrides,
  };
}

describe('reserveAiBudget transaction shape', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Passthroughs that record the nesting the module actually used.
    hoisted.runOutsideDbContext.mockImplementation((fn: () => unknown) => fn());
    hoisted.withSystemDbAccessContext.mockImplementation((fn: () => unknown) => fn());
    hoisted.withDbAccessContext.mockImplementation((_ctx: unknown, fn: () => unknown) => fn());
    hoisted.getEffectiveAiBudget.mockResolvedValue({
      enabled: true, dailyBudgetCents: null, monthlyBudgetCents: null,
    });
    dbMock.execute
      .mockResolvedValueOnce([{ id: ORG_ID }])   // organizations FOR UPDATE
      .mockResolvedValueOnce([])                  // existing reservation lookup
      .mockResolvedValueOnce([reservationRow()]); // INSERT ... RETURNING
  });

  it('runs in its OWN system-scoped transaction, never re-entering the caller org context', async () => {
    const result = await reserveAiBudget({
      orgId: ORG_ID, idempotencyKey: 'key-1', billingSource: 'platform',
    });

    expect(result).toMatchObject({ kind: 'unlimited', reservationId: RESERVATION_ID, status: 'active' });
    expect(hoisted.runOutsideDbContext).toHaveBeenCalledTimes(1);
    expect(hoisted.withSystemDbAccessContext).toHaveBeenCalledTimes(1);
    // B2: re-entering the ambient ORGANIZATION context is what made
    // getEffectiveAiBudget -> readWithPartnerAxisVisibility open a THIRD pooled
    // connection while this transaction still held `organizations FOR UPDATE`.
    expect(hoisted.withDbAccessContext).not.toHaveBeenCalled();
  });

  it('bounds the organization row lock before taking it', async () => {
    await reserveAiBudget({ orgId: ORG_ID, idempotencyKey: 'key-1', billingSource: 'platform' });

    expect(hoisted.tightenLockTimeout).toHaveBeenCalledTimes(1);
    expect(hoisted.tightenLockTimeout).toHaveBeenCalledWith(dbMock, AI_BUDGET_LOCK_TIMEOUT_MS);
    // The bound is applied BEFORE the lock it is meant to bound.
    const boundOrder = hoisted.tightenLockTimeout.mock.invocationCallOrder[0]!;
    const lockOrder = dbMock.execute.mock.invocationCallOrder[0]!;
    expect(boundOrder).toBeLessThan(lockOrder);
  });

  it.each([
    ['a Drizzle-wrapped driver error (what production raises)', () => Object.assign(
      new Error('Failed query'),
      { cause: Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' }) },
    )],
    ['a bare driver error', () => Object.assign(
      new Error('canceling statement due to lock timeout'), { code: '55P03' },
    )],
  ])('maps a lock_timeout (55P03) to AiBudgetLockTimeoutError rather than a bare 500 — %s', async (_label, build) => {
    dbMock.execute.mockReset();
    const pgError = build();
    dbMock.execute.mockRejectedValueOnce(pgError);

    const thrown = await reserveAiBudget({
      orgId: ORG_ID, idempotencyKey: 'key-1', billingSource: 'platform',
    }).catch((err: unknown) => err);

    expect(isAiBudgetLockTimeout(thrown)).toBe(true);
    expect((thrown as { code: string }).code).toBe('AI_BUDGET_LOCK_TIMEOUT');
    // Fail FAST: nothing was inserted, and the caller can answer 503 rather
    // than holding a pooled connection behind the lock.
    expect(dbMock.execute).toHaveBeenCalledTimes(1);
  });

  it('lets a non-lock database error through unchanged', async () => {
    dbMock.execute.mockReset();
    const pgError = Object.assign(new Error('Failed query'), {
      cause: Object.assign(new Error('connection terminated'), { code: '57P01' }),
    });
    dbMock.execute.mockRejectedValueOnce(pgError);

    const thrown = await reserveAiBudget({
      orgId: ORG_ID, idempotencyKey: 'key-1', billingSource: 'platform',
    }).catch((err: unknown) => err);

    expect(isAiBudgetLockTimeout(thrown)).toBe(false);
    expect(thrown).toBe(pgError);
  });
});

describe('monetary bounds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.runOutsideDbContext.mockImplementation((fn: () => unknown) => fn());
    hoisted.withSystemDbAccessContext.mockImplementation((fn: () => unknown) => fn());
  });

  it.each([
    ['above the ledger maximum', 1e15],
    ['negative', -1],
    ['not finite', Number.POSITIVE_INFINITY],
  ])('refuses a settlement amount that is %s, before touching the database', async (_label, amount) => {
    await expect(settleAiBudgetReservation({
      orgId: ORG_ID,
      reservationId: RESERVATION_ID,
      actualCostCents: amount,
      inputTokens: 1,
      outputTokens: 1,
    })).rejects.toThrow(/finite non-negative monetary amount/);
    // The guard runs before any transaction is opened — a malformed amount can
    // never reach `ai_cost_usage`.
    expect(dbMock.execute).not.toHaveBeenCalled();
  });

  it('refuses a negative token count', async () => {
    await expect(settleAiBudgetReservation({
      orgId: ORG_ID,
      reservationId: RESERVATION_ID,
      actualCostCents: 1,
      inputTokens: -1,
      outputTokens: 0,
    })).rejects.toThrow(/inputTokens must be a non-negative safe integer/);
    expect(dbMock.execute).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Settlement is the money path (review item 2)
// ---------------------------------------------------------------------------

describe('settleAiBudgetReservationDurably', () => {
  const settleInput = {
    orgId: ORG_ID,
    reservationId: RESERVATION_ID,
    actualCostCents: 12.5,
    inputTokens: 100,
    outputTokens: 50,
  };

  function primeSettleOnce(status = 'active') {
    // organizations FOR UPDATE -> reservation FOR UPDATE -> 2 aggregate upserts
    // -> reservation UPDATE ... RETURNING
    dbMock.execute
      .mockResolvedValueOnce([{ id: ORG_ID }])
      .mockResolvedValueOnce([reservationRow({ status, uncapped: false, reserved_cost_cents: '100.000000' })])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: RESERVATION_ID }]);
  }

  function lockTimeout() {
    return Object.assign(new Error('Failed query'), {
      cause: Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' }),
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.runOutsideDbContext.mockImplementation((fn: () => unknown) => fn());
    hoisted.withSystemDbAccessContext.mockImplementation((fn: () => unknown) => fn());
  });

  it('waits longer for the settlement lock than for admission', async () => {
    primeSettleOnce();
    await settleAiBudgetReservationDurably(settleInput);
    // Admission fails fast because the caller has spent nothing; settlement has
    // already paid the provider, so giving up cheaply LOSES the spend.
    expect(hoisted.tightenLockTimeout).toHaveBeenCalledWith(
      dbMock, AI_BUDGET_SETTLEMENT_LOCK_TIMEOUT_MS,
    );
    expect(AI_BUDGET_SETTLEMENT_LOCK_TIMEOUT_MS).toBeGreaterThan(AI_BUDGET_LOCK_TIMEOUT_MS);
  });

  it('retries once when the organization lock is contended, and settles', async () => {
    dbMock.execute.mockRejectedValueOnce(lockTimeout());
    primeSettleOnce();

    await expect(settleAiBudgetReservationDurably(settleInput))
      .resolves.toMatchObject({ kind: 'settled' });
    expect(hoisted.tightenLockTimeout).toHaveBeenCalledTimes(2);
  });

  it('marks the reservation indeterminate when it still cannot settle, instead of losing the cap', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Both settlement attempts time out on the org lock...
    dbMock.execute
      .mockRejectedValueOnce(lockTimeout())
      .mockRejectedValueOnce(lockTimeout())
      // ...then the indeterminate marking succeeds: org lock, reservation read,
      // the UPDATE.
      .mockResolvedValueOnce([{ id: ORG_ID }])
      .mockResolvedValueOnce([reservationRow({ status: 'active' })])
      .mockResolvedValueOnce([]);

    await expect(settleAiBudgetReservationDurably(settleInput))
      .resolves.toMatchObject({ kind: 'deferred_indeterminate', reservationId: RESERVATION_ID });

    // The 24h indeterminate window now applies, so a reconciliation can still
    // settle it — and the lost spend is visible rather than silent.
    expect(hoisted.captureException).toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      '[AI] budget settlement blocked twice on the organization lock',
      expect.objectContaining({ orgId: ORG_ID, reservationId: RESERVATION_ID, actualCostCents: 12.5 }),
    );
    error.mockRestore();
  });

  it('survives the indeterminate marking ALSO failing, without throwing at the caller', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    dbMock.execute
      .mockRejectedValueOnce(lockTimeout())
      .mockRejectedValueOnce(lockTimeout())
      .mockRejectedValueOnce(lockTimeout());

    // Metering is best-effort at every call site; a throw here would turn a
    // delivered AI response into a 500. The 30-minute active TTL still bounds
    // the held cap, so the tenant is never locked out indefinitely.
    await expect(settleAiBudgetReservationDurably(settleInput))
      .resolves.toMatchObject({ kind: 'deferred_indeterminate' });
    error.mockRestore();
  });

  it('rethrows a non-lock failure without retrying, because only contention is retryable', async () => {
    dbMock.execute
      .mockResolvedValueOnce([{ id: ORG_ID }])
      .mockResolvedValueOnce([reservationRow({ status: 'settled', settlement_fingerprint: 'different' })]);

    await expect(settleAiBudgetReservationDurably(settleInput))
      .rejects.toThrow(/Conflicting settlement/i);
    // One attempt only: retrying a conflicting settlement just raises twice.
    expect(hoisted.tightenLockTimeout).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// #5557 — the /client-ai (Office add-in) namespace.
//
// The add-in surface used to admit turns with a READ (checkClientBudget against
// client_ai_usage) and then spend, so two concurrent turns both passed. These
// assert the sub-cap arithmetic that replaces that read: a client reservation
// is the tighter of the ORGANIZATION cap (global — settled client spend already
// lands in ai_cost_usage) and the CLIENT sub-cap (whose in-flight side counts
// client-namespace holds only).
// ---------------------------------------------------------------------------

/**
 * Pull the interpolated values out of a Drizzle `sql` template. The literal SQL
 * arrives as StringChunk objects; anything interpolated with `${}` that is not
 * itself a SQL wrapper sits in `queryChunks` as the raw primitive.
 */
function sqlParamValues(query: unknown): unknown[] {
  const chunks = (query as { queryChunks?: unknown[] } | undefined)?.queryChunks ?? [];
  return chunks.filter((chunk) => chunk === null || typeof chunk !== 'object');
}

function usageRow(overrides: Record<string, unknown> = {}) {
  return {
    daily_usage: '0',
    monthly_usage: '0',
    daily_reserved: '0',
    monthly_reserved: '0',
    client_daily_usage: '0',
    client_monthly_usage: '0',
    client_daily_reserved: '0',
    client_monthly_reserved: '0',
    ...overrides,
  };
}

describe('reserveAiBudget — client namespace sub-cap (#5557)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks does NOT drain a queued mockResolvedValueOnce chain, and a
    // leftover response from the previous case silently answers the next one's
    // first query — which reads as a passing assertion about the wrong call.
    dbMock.execute.mockReset();
    hoisted.runOutsideDbContext.mockImplementation((fn: () => unknown) => fn());
    hoisted.withSystemDbAccessContext.mockImplementation((fn: () => unknown) => fn());
    hoisted.withDbAccessContext.mockImplementation((_ctx: unknown, fn: () => unknown) => fn());
    // Organization itself is uncapped: the ONLY fence in these cases is the
    // client sub-cap, which is precisely the gap #5557 reported.
    hoisted.getEffectiveAiBudget.mockResolvedValue({
      enabled: true, dailyBudgetCents: null, monthlyBudgetCents: null,
    });
  });

  /** lock → existing-reservation lookup → usage/held read → INSERT RETURNING. */
  function primeAdmission(usage: Record<string, unknown>, inserted: Record<string, unknown> = {}) {
    dbMock.execute
      .mockResolvedValueOnce([{ id: ORG_ID }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([usageRow(usage)])
      .mockResolvedValueOnce([reservationRow({
        namespace: 'client', uncapped: false, reserved_cost_cents: '0.000000', ...inserted,
      })]);
  }

  const clientInput = (clientBudget: { dailyBudgetCents: number | null; monthlyBudgetCents: number | null }) => ({
    orgId: ORG_ID,
    idempotencyKey: 'client-ai:key-1',
    billingSource: 'platform' as const,
    namespace: 'client' as const,
    clientBudget,
  });

  it('reserves the client sub-cap remainder even when the organization budget is unlimited', async () => {
    primeAdmission(
      { client_daily_usage: '400', client_daily_reserved: '100' },
      { reserved_cost_cents: '500.000000' },
    );

    const result = await reserveAiBudget(
      clientInput({ dailyBudgetCents: 1000, monthlyBudgetCents: null }),
    );

    expect(result).toMatchObject({ kind: 'reserved', reservedCostCents: 500 });
    // The amount actually written is the arithmetic under test, not the row the
    // mock hands back: 1000 cap − 400 settled − 100 held.
    const insertParams = sqlParamValues(dbMock.execute.mock.calls[3]?.[0]);
    expect(insertParams).toContain('client');
    expect(insertParams).toContain('500.000000');
  });

  it('denies a second concurrent add-in turn while the first still holds the sub-cap', async () => {
    primeAdmission({ client_daily_usage: '0', client_daily_reserved: '1000' });

    const result = await reserveAiBudget(
      clientInput({ dailyBudgetCents: 1000, monthlyBudgetCents: null }),
    );

    // An in-flight hold is NOT exhaustion — the caller retries, it does not go
    // to its IT provider.
    expect(result).toMatchObject({ kind: 'denied', reason: 'client_daily_budget_in_flight' });
    // Nothing inserted: lock, lookup, usage read only.
    expect(dbMock.execute).toHaveBeenCalledTimes(3);
  });

  it('denies with the exhausted reason when the sub-cap is spent, not merely held', async () => {
    primeAdmission({ client_monthly_usage: '5000' });

    const result = await reserveAiBudget(
      clientInput({ dailyBudgetCents: null, monthlyBudgetCents: 5000 }),
    );

    expect(result).toMatchObject({ kind: 'denied', reason: 'client_monthly_budget' });
    expect((result as { message: string }).message).toContain('$50.00');
  });

  it('never widens past the organization cap — the tighter of the two wins', async () => {
    hoisted.getEffectiveAiBudget.mockResolvedValue({
      enabled: true, dailyBudgetCents: 200, monthlyBudgetCents: null,
    });
    primeAdmission({}, { reserved_cost_cents: '200.000000' });

    const result = await reserveAiBudget(
      clientInput({ dailyBudgetCents: 100000, monthlyBudgetCents: null }),
    );

    expect(result).toMatchObject({ kind: 'reserved', reservedCostCents: 200 });
    expect(sqlParamValues(dbMock.execute.mock.calls[3]?.[0])).toContain('200.000000');
  });

  it('defaults to the technician namespace so every pre-#5557 call site is unchanged', async () => {
    dbMock.execute
      .mockResolvedValueOnce([{ id: ORG_ID }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([reservationRow({ namespace: 'technician' })]);

    const result = await reserveAiBudget({
      orgId: ORG_ID, idempotencyKey: 'key-1', billingSource: 'platform',
    });

    expect(result).toMatchObject({ kind: 'unlimited' });
    expect(sqlParamValues(dbMock.execute.mock.calls[2]?.[0])).toContain('technician');
  });

  it('refuses a client reservation with no sub-cap supplied rather than admitting on the org cap alone', async () => {
    await expect(reserveAiBudget({
      orgId: ORG_ID,
      idempotencyKey: 'client-ai:key-1',
      billingSource: 'platform',
      namespace: 'client',
    })).rejects.toThrow(/clientBudget is required/);
    expect(dbMock.execute).not.toHaveBeenCalled();
  });

  it('refuses a sub-cap on a technician reservation, where nothing would enforce it', async () => {
    await expect(reserveAiBudget({
      orgId: ORG_ID,
      idempotencyKey: 'key-1',
      billingSource: 'platform',
      clientBudget: { dailyBudgetCents: 100, monthlyBudgetCents: null },
    })).rejects.toThrow(/only meaningful/);
  });

  it('rejects an idempotency-key replay that arrives under a different namespace', async () => {
    dbMock.execute
      .mockResolvedValueOnce([{ id: ORG_ID }])
      .mockResolvedValueOnce([reservationRow({ namespace: 'technician' })]);

    await expect(reserveAiBudget(
      clientInput({ dailyBudgetCents: 1000, monthlyBudgetCents: null }),
    )).rejects.toThrow(/conflicts with another dispatch/);
  });
});
