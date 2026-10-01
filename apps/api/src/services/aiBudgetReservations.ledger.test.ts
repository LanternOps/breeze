import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

/**
 * W03 (#7601) additions to the reservation ledger, at the SQL-shape level:
 * the turn binding on the reservation, ledger-derived settlement, the bound-
 * rate check, re-binding on a stable-key replay, the persisted deferred
 * settlement and the SDK usage snapshot. The real-Postgres consequences are in
 * __tests__/integration/aiInvocationSettlement.integration.test.ts.
 */

const { dbMock, hoisted } = vi.hoisted(() => ({
  dbMock: { execute: vi.fn() },
  hoisted: {
    runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
    withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
    tightenLockTimeout: vi.fn(async () => 0),
    getEffectiveAiBudget: vi.fn(),
    captureException: vi.fn(),
    recordInvocation: vi.fn(),
    getPlatformModelByModelId: vi.fn(),
  },
}));

vi.mock('../db', () => ({
  db: dbMock,
  runOutsideDbContext: hoisted.runOutsideDbContext,
  withSystemDbAccessContext: hoisted.withSystemDbAccessContext,
}));
vi.mock('../db/lockTimeout', () => ({ tightenLockTimeout: hoisted.tightenLockTimeout }));
vi.mock('./effectiveSettings', () => ({ getEffectiveAiBudget: hoisted.getEffectiveAiBudget }));
vi.mock('./sentry', () => ({ captureException: hoisted.captureException, captureMessage: vi.fn() }));
vi.mock('./aiModels/invocationLedgerWrite', () => ({ recordInvocation: hoisted.recordInvocation }));
vi.mock('./aiModels/platformModels', () => ({ getPlatformModelByModelId: hoisted.getPlatformModelByModelId }));

import {
  AiBudgetBindingConflictError,
  AiBudgetPendingSettlementError,
  readSdkUsageSnapshot,
  reserveAiBudget,
  settleAiBudgetReservation,
  settleAiBudgetReservationDurably,
} from './aiBudgetReservations';
import type { NewInvocation } from './aiModels/invocationLedgerWrite';
import type { SdkUsageSnapshot } from './aiModels/invocationUsage';
import type { TurnBinding } from './aiModels/turnBinding';

const dialect = new PgDialect();
function q(callIndex: number): { sql: string; params: unknown[] } {
  return dialect.sqlToQuery(dbMock.execute.mock.calls[callIndex]![0] as SQL);
}
function allSql(): string[] {
  return dbMock.execute.mock.calls.map((c) => dialect.sqlToQuery(c[0] as SQL).sql);
}

const ORG_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PARTNER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SESSION_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OFFERING_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const RESERVATION_ID = '12121212-1212-4121-8121-121212121212';

const STD = { inputCentsPerM: 200, outputCentsPerM: 1000, cacheReadCentsPerM: 20, cacheWriteCentsPerM: 250 };
const FB = { inputCentsPerM: 100, outputCentsPerM: 500, cacheReadCentsPerM: 10, cacheWriteCentsPerM: 125 };
const BINDING: TurnBinding = {
  v: 1, surface: 'chat', role: 'default', partnerId: PARTNER_ID, offeringId: OFFERING_ID, connectionId: null,
  connectionKind: 'platform', configVersion: null, catalogRevisionId: null, funding: 'platform',
  logicalModel: 'claude-sonnet-5-5', wireModel: 'claude-sonnet-5-5', options: { effort: 'medium' },
  thinkingMode: 'adaptive', inferenceGeo: null, wireFingerprint: 'f',
  rateSnapshot: { source: 'platform', standard: STD },
  refusalFallback: { offeringId: 'fb', wireModel: 'claude-haiku-4-5', rateSnapshot: { source: 'platform', standard: FB } },
};

function reservationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: RESERVATION_ID, org_id: ORG_ID, idempotency_key: 'key-1', session_id: null, billing_source: 'platform',
    namespace: 'technician', daily_period_key: '2026-10-01', monthly_period_key: '2026-10', uncapped: true,
    reserved_cost_cents: '0.000000', actual_cost_cents: null, status: 'active', settlement_fingerprint: null,
    expires_at: '2026-10-01T12:30:00.000Z', model_binding: null, pending_settlement: null,
    ...overrides,
  };
}

function invocation(over: Partial<NewInvocation> = {}): NewInvocation {
  return {
    orgId: ORG_ID, surface: 'chat', offeringId: OFFERING_ID, fundingSource: 'platform',
    requestedModel: 'claude-sonnet-5-5', servedModel: 'claude-sonnet-5-5',
    tokens: { input: 1000, output: 200, cacheRead: 300, cacheWrite: 50 },
    rateSnapshot: { source: 'platform', standard: STD }, costCents: 0.5, ledgerMode: 'authoritative',
    ...over,
  };
}

afterEach(() => { vi.unstubAllEnvs(); });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('BILLING_SERVICE_URL', 'https://billing.example.test');
  vi.stubEnv('BILLING_SERVICE_API_KEY', 'test-billing-key');
  dbMock.execute.mockReset();
  hoisted.runOutsideDbContext.mockImplementation((fn: () => unknown) => fn());
  hoisted.withSystemDbAccessContext.mockImplementation((fn: () => unknown) => fn());
  hoisted.getEffectiveAiBudget.mockResolvedValue({ enabled: true, dailyBudgetCents: null, monthlyBudgetCents: null });
  let n = 0;
  hoisted.recordInvocation.mockImplementation(async () => `inv-${++n}`);
});

describe('reserveAiBudget with a turn binding (spec §9.2 bullet 1)', () => {
  it('writes model_binding in the INSERT and stamps the session in the SAME transaction', async () => {
    dbMock.execute
      .mockResolvedValueOnce([{ id: ORG_ID }])                       // org lock
      .mockResolvedValueOnce([])                                     // existing key lookup
      .mockResolvedValueOnce([{ id: SESSION_ID }])                   // session in org
      .mockResolvedValueOnce([reservationRow({ session_id: SESSION_ID })]) // INSERT
      .mockResolvedValueOnce([{ id: SESSION_ID }]);                  // session stamp

    await reserveAiBudget({ orgId: ORG_ID, idempotencyKey: 'key-1', billingSource: 'platform', sessionId: SESSION_ID, binding: BINDING });

    expect(hoisted.withSystemDbAccessContext).toHaveBeenCalledTimes(1);
    const insert = q(3);
    expect(insert.sql).toMatch(/INSERT INTO ai_budget_reservations[\s\S]*model_binding/);
    expect(insert.params).toContain(JSON.stringify(BINDING));
    const stamp = q(4);
    expect(stamp.sql).toMatch(/UPDATE ai_sessions[\s\S]*offering_id[\s\S]*offering_partner_id[\s\S]*options[\s\S]*model/);
    expect(stamp.params).toEqual(expect.arrayContaining([OFFERING_ID, PARTNER_ID, 'claude-sonnet-5-5', SESSION_ID, ORG_ID]));
  });

  it('a session stamp that matches no row throws (and so rolls the reservation back)', async () => {
    dbMock.execute
      .mockResolvedValueOnce([{ id: ORG_ID }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: SESSION_ID }])
      .mockResolvedValueOnce([reservationRow({ session_id: SESSION_ID })])
      .mockResolvedValueOnce([]);
    await expect(reserveAiBudget({
      orgId: ORG_ID, idempotencyKey: 'key-1', billingSource: 'platform', sessionId: SESSION_ID, binding: BINDING,
    })).rejects.toThrow(/AI session not found/);
  });

  it('refuses a binding whose funding differs from the reservation billing source, before inserting', async () => {
    dbMock.execute.mockResolvedValueOnce([{ id: ORG_ID }]).mockResolvedValueOnce([]);
    await expect(reserveAiBudget({
      orgId: ORG_ID, idempotencyKey: 'key-1', billingSource: 'partner_key', binding: BINDING,
    })).rejects.toThrow(/billing source does not match the turn binding/);
    expect(allSql().some((s) => s.includes('INSERT INTO ai_budget_reservations'))).toBe(false);
  });

  it('a stable-key replay with a changed binding RE-BINDS the still-active reservation (finding 4)', async () => {
    const repriced = { ...BINDING, rateSnapshot: { source: 'platform' as const, standard: { ...STD, inputCentsPerM: 999 } } };
    dbMock.execute
      .mockResolvedValueOnce([{ id: ORG_ID }])
      .mockResolvedValueOnce([reservationRow({ model_binding: BINDING })]) // existing, active, unsettled
      .mockResolvedValueOnce([{ id: RESERVATION_ID }]);                    // re-bind UPDATE

    const out = await reserveAiBudget({ orgId: ORG_ID, idempotencyKey: 'key-1', billingSource: 'platform', binding: repriced });

    expect(out).toMatchObject({ kind: 'unlimited', reservationId: RESERVATION_ID });
    const rebind = q(2);
    expect(rebind.sql).toMatch(/UPDATE ai_budget_reservations\s+SET model_binding/);
    expect(rebind.params).toContain(JSON.stringify(repriced));
  });

  it('a replay with the SAME binding changes nothing', async () => {
    dbMock.execute
      .mockResolvedValueOnce([{ id: ORG_ID }])
      .mockResolvedValueOnce([reservationRow({ model_binding: BINDING })]);
    await reserveAiBudget({ orgId: ORG_ID, idempotencyKey: 'key-1', billingSource: 'platform', binding: BINDING });
    expect(dbMock.execute).toHaveBeenCalledTimes(2);
  });

  it('never re-binds a reservation whose settlement is already pending', async () => {
    dbMock.execute
      .mockResolvedValueOnce([{ id: ORG_ID }])
      .mockResolvedValueOnce([reservationRow({ model_binding: BINDING, pending_settlement: { reservationId: RESERVATION_ID } })]);
    const repriced = { ...BINDING, wireFingerprint: 'g' };
    await expect(reserveAiBudget({ orgId: ORG_ID, idempotencyKey: 'key-1', billingSource: 'platform', binding: repriced }))
      .rejects.toBeInstanceOf(AiBudgetPendingSettlementError);
  });

  it('refuses a SAME-binding replay onto a reservation whose settlement is pending (review finding 2)', async () => {
    dbMock.execute
      .mockResolvedValueOnce([{ id: ORG_ID }])
      .mockResolvedValueOnce([reservationRow({ model_binding: BINDING, pending_settlement: { reservationId: RESERVATION_ID } })]);
    await expect(reserveAiBudget({ orgId: ORG_ID, idempotencyKey: 'key-1', billingSource: 'platform', binding: BINDING }))
      .rejects.toBeInstanceOf(AiBudgetPendingSettlementError);
  });
});

describe('settleAiBudgetReservation with ledger rows', () => {
  function primeSettle(row = reservationRow({ model_binding: BINDING })) {
    dbMock.execute
      .mockResolvedValueOnce([{ id: ORG_ID }])          // org lock
      .mockResolvedValueOnce([row])                      // reservation FOR UPDATE
      .mockResolvedValueOnce([])                         // ai_cost_usage daily
      .mockResolvedValueOnce([])                         // ai_cost_usage monthly
      .mockResolvedValueOnce([{ id: RESERVATION_ID }]);  // settle UPDATE
  }

  it('derives the totals from the rows, inserts each row in the transaction and marks the debit due', async () => {
    primeSettle();
    const rows = [invocation(), invocation({ requestedModel: 'claude-haiku-4-5', servedModel: 'claude-haiku-4-5', fallbackUsed: true, rateSnapshot: { source: 'platform', standard: FB }, costCents: 0.25 })];

    const out = await settleAiBudgetReservation({ orgId: ORG_ID, reservationId: RESERVATION_ID, invocations: rows });

    expect(out).toEqual({
      kind: 'settled', reservationId: RESERVATION_ID, actualCostCents: 0.75,
      invocationIds: ['inv-1', 'inv-2'], billingSource: 'platform', creditsDebitDue: true,
    });
    expect(hoisted.recordInvocation).toHaveBeenCalledTimes(2);
    // input = uncached + cache read + cache write, as sumInputTokens() stores it
    const daily = q(2);
    expect(daily.params).toEqual(expect.arrayContaining([2 * 1350, 2 * 200, '0.750000']));
    const settle = q(4);
    expect(settle.sql).toMatch(/pending_settlement = NULL/);
    expect(settle.sql).toMatch(/credits_debit_due_at/);
  });

  it('no billing service configured (self-hosted): platform spend is never marked due, so enabling billing later cannot debit a backlog', async () => {
    vi.stubEnv('BILLING_SERVICE_URL', '');
    primeSettle();
    const out = await settleAiBudgetReservation({ orgId: ORG_ID, reservationId: RESERVATION_ID, invocations: [invocation()] });
    expect(out).toMatchObject({ kind: 'settled', creditsDebitDue: false, billingSource: 'platform' });
  });

  it('partner_key spend is never due for a platform debit', async () => {
    primeSettle(reservationRow({ billing_source: 'partner_key', model_binding: { ...BINDING, funding: 'partner_key' } }));
    const out = await settleAiBudgetReservation({
      orgId: ORG_ID, reservationId: RESERVATION_ID, invocations: [invocation({ fundingSource: 'partner_key' })],
    });
    expect(out).toMatchObject({ kind: 'settled', creditsDebitDue: false, billingSource: 'partner_key' });
  });

  it('rejects a row priced at a rate the turn did not bind, and writes no ledger row', async () => {
    dbMock.execute.mockResolvedValueOnce([{ id: ORG_ID }]).mockResolvedValueOnce([reservationRow({ model_binding: BINDING })]);
    await expect(settleAiBudgetReservation({
      orgId: ORG_ID, reservationId: RESERVATION_ID,
      invocations: [invocation({ rateSnapshot: { source: 'platform', standard: { ...STD, inputCentsPerM: 1 } } })],
    })).rejects.toThrow(/does not match the turn binding/);
    expect(hoisted.recordInvocation).not.toHaveBeenCalled();
  });

  it('accepts the bound rate with a web-search fee annotation', async () => {
    primeSettle();
    await expect(settleAiBudgetReservation({
      orgId: ORG_ID, reservationId: RESERVATION_ID,
      invocations: [invocation({ rateSnapshot: { source: 'platform', standard: STD, serverToolFees: { webSearchRequests: 2, centsEach: 1 } } as never })],
    })).resolves.toMatchObject({ kind: 'settled' });
  });

  it('accepts an unbound model the CLI switched to only at its own current platform rate', async () => {
    const OTHER = { inputCentsPerM: 300, outputCentsPerM: 1500, cacheReadCentsPerM: 30, cacheWriteCentsPerM: 375 };
    hoisted.getPlatformModelByModelId.mockResolvedValue({ rates: OTHER, optionRates: null });
    primeSettle();
    await expect(settleAiBudgetReservation({
      orgId: ORG_ID, reservationId: RESERVATION_ID,
      invocations: [invocation({ requestedModel: 'claude-sonnet-4-6', servedModel: 'claude-sonnet-4-6', fallbackUsed: true, rateSnapshot: { source: 'platform', standard: OTHER } })],
    })).resolves.toMatchObject({ kind: 'settled' });

    dbMock.execute.mockReset();
    dbMock.execute.mockResolvedValueOnce([{ id: ORG_ID }]).mockResolvedValueOnce([reservationRow({ model_binding: BINDING })]);
    await expect(settleAiBudgetReservation({
      orgId: ORG_ID, reservationId: RESERVATION_ID,
      invocations: [invocation({ requestedModel: 'claude-sonnet-4-6', fallbackUsed: true, rateSnapshot: { source: 'platform', standard: { ...OTHER, inputCentsPerM: 1 } } })],
    })).rejects.toThrow(/does not match the turn binding/);
  });

  it('rejects a row whose funding differs from the reservation billing source', async () => {
    dbMock.execute.mockResolvedValueOnce([{ id: ORG_ID }]).mockResolvedValueOnce([reservationRow()]);
    await expect(settleAiBudgetReservation({
      orgId: ORG_ID, reservationId: RESERVATION_ID, invocations: [invocation({ fundingSource: 'partner_key' })],
    })).rejects.toThrow(/funding/);
  });

  it('needs invocations or explicit totals', async () => {
    await expect(settleAiBudgetReservation({ orgId: ORG_ID, reservationId: RESERVATION_ID } as never))
      .rejects.toThrow(/needs invocations or explicit totals/);
    expect(dbMock.execute).not.toHaveBeenCalled();
  });

  it('a replay of an already-settled reservation inserts nothing and returns no ids', async () => {
    // Prime once to capture the fingerprint, then replay against a settled row.
    primeSettle();
    const rows = [invocation()];
    await settleAiBudgetReservation({ orgId: ORG_ID, reservationId: RESERVATION_ID, invocations: rows });
    const fingerprint = q(4).params.find((p) => typeof p === 'string' && /^[0-9a-f]{64}$/.test(p));
    dbMock.execute.mockReset();
    hoisted.recordInvocation.mockClear();
    dbMock.execute.mockResolvedValueOnce([{ id: ORG_ID }])
      .mockResolvedValueOnce([reservationRow({ status: 'settled', settlement_fingerprint: fingerprint, actual_cost_cents: '0.500000' })]);
    await expect(settleAiBudgetReservation({ orgId: ORG_ID, reservationId: RESERVATION_ID, invocations: rows }))
      .resolves.toMatchObject({ kind: 'already_settled', invocationIds: [], creditsDebitDue: false });
    expect(hoisted.recordInvocation).not.toHaveBeenCalled();
  });
});

describe('SDK usage snapshot (W05 spike): advanced in the settlement transaction', () => {
  const PREV: SdkUsageSnapshot = { version: 1, models: { 'claude-sonnet-5-5': { tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, webSearchRequests: 0 } } };
  const NEXT: SdkUsageSnapshot = { version: 1, models: { 'claude-sonnet-5-5': { tokens: { input: 20, output: 9, cacheRead: 0, cacheWrite: 0 }, webSearchRequests: 0 } } };

  function primeWithSnapshot(stored: unknown) {
    dbMock.execute
      .mockResolvedValueOnce([{ id: ORG_ID }])
      .mockResolvedValueOnce([reservationRow({ model_binding: BINDING })])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ sdk_usage_snapshot: stored }])   // session snapshot FOR UPDATE
      .mockResolvedValueOnce([{ id: SESSION_ID }])               // snapshot UPDATE (if any)
      .mockResolvedValueOnce([{ id: RESERVATION_ID }]);
  }

  it('writes the next snapshot before the reservation is marked settled', async () => {
    primeWithSnapshot(PREV);
    await settleAiBudgetReservation({
      orgId: ORG_ID, reservationId: RESERVATION_ID, invocations: [invocation()],
      sdkUsage: { sessionId: SESSION_ID, nextSnapshot: NEXT },
    });
    const sqls = allSql();
    const write = sqls.findIndex((s) => /UPDATE ai_sessions\s+SET sdk_usage_snapshot/.test(s));
    const settled = sqls.findIndex((s) => /SET status = 'settled'/.test(s));
    expect(write).toBeGreaterThan(-1);
    expect(write).toBeLessThan(settled);
    expect(q(write).params).toContain(JSON.stringify(NEXT));
  });

  it('does not write when the next snapshot equals the stored one (no_result / empty turn)', async () => {
    dbMock.execute
      .mockResolvedValueOnce([{ id: ORG_ID }])
      .mockResolvedValueOnce([reservationRow({ model_binding: BINDING })])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ sdk_usage_snapshot: NEXT }])
      .mockResolvedValueOnce([{ id: RESERVATION_ID }]);
    await settleAiBudgetReservation({
      orgId: ORG_ID, reservationId: RESERVATION_ID, invocations: [invocation()],
      sdkUsage: { sessionId: SESSION_ID, nextSnapshot: NEXT },
    });
    expect(allSql().some((s) => /SET sdk_usage_snapshot/.test(s))).toBe(false);
  });

  it('never moves a stored snapshot backwards (an older deferred replay keeps the high-water mark)', async () => {
    primeWithSnapshot(NEXT);
    await settleAiBudgetReservation({
      orgId: ORG_ID, reservationId: RESERVATION_ID, invocations: [invocation()],
      sdkUsage: { sessionId: SESSION_ID, nextSnapshot: PREV },
    });
    expect(allSql().some((s) => /SET sdk_usage_snapshot/.test(s))).toBe(false);
  });

  it('readSdkUsageSnapshot merges the stored snapshot with any pending (deferred) settlement for the session', async () => {
    dbMock.execute
      .mockResolvedValueOnce([{ sdk_usage_snapshot: PREV }])
      .mockResolvedValueOnce([{ snapshot: NEXT }]);
    await expect(readSdkUsageSnapshot({ orgId: ORG_ID, sessionId: SESSION_ID })).resolves.toEqual(NEXT);
  });

  it('readSdkUsageSnapshot returns null for a session with no snapshot', async () => {
    dbMock.execute.mockResolvedValueOnce([{ sdk_usage_snapshot: null }]).mockResolvedValueOnce([]);
    await expect(readSdkUsageSnapshot({ orgId: ORG_ID, sessionId: SESSION_ID })).resolves.toBeNull();
  });
});

describe('settleAiBudgetReservationDurably persists a contended settlement (finding 2)', () => {
  const lockTimeout = () => Object.assign(new Error('Failed query'), {
    cause: Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' }),
  });

  it('two lock timeouts → the priced rows are written to pending_settlement (no org lock), then deferred', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    dbMock.execute
      .mockRejectedValueOnce(lockTimeout())
      .mockRejectedValueOnce(lockTimeout())
      .mockResolvedValueOnce([{ id: RESERVATION_ID }])   // pending_settlement UPDATE
      .mockResolvedValueOnce([{ id: ORG_ID }])           // indeterminate: org lock
      .mockResolvedValueOnce([reservationRow()])
      .mockResolvedValueOnce([]);
    const input = { orgId: ORG_ID, reservationId: RESERVATION_ID, invocations: [invocation()] };

    await expect(settleAiBudgetReservationDurably(input))
      .resolves.toEqual({ kind: 'deferred_indeterminate', reservationId: RESERVATION_ID, persisted: true });

    const persist = q(2);
    expect(persist.sql).toMatch(/UPDATE ai_budget_reservations SET pending_settlement/);
    expect(persist.sql).not.toMatch(/organizations/);
    expect(JSON.parse(persist.params.find((p) => typeof p === 'string' && p.startsWith('{')) as string))
      .toMatchObject({ reservationId: RESERVATION_ID, invocations: [expect.objectContaining({ costCents: 0.5 })] });
    error.mockRestore();
  });
});
