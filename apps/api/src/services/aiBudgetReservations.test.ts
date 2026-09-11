import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AI_BUDGET_LOCK_TIMEOUT_MS,
  isAiBudgetLockTimeout,
  maxOutputTokensForAiBudget,
  reserveAiBudget,
  settleAiBudgetReservation,
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
