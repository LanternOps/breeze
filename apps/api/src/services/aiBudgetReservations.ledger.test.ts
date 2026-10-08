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
    captureMessage: vi.fn(),
    recordInvocation: vi.fn(),
    getPlatformModelByModelId: vi.fn(),
    readConnectionOfferingRate: vi.fn(),
    // W10 (#7608): the real stamp reads the card through the ambient db; at
    // this SQL-shape level it is a pass-through no-card stamp (its own suite
    // and aiChargebackStamping.integration.test.ts cover the read).
    stampChargeback: vi.fn(),
  },
}));

vi.mock('../db', () => ({
  db: dbMock,
  runOutsideDbContext: hoisted.runOutsideDbContext,
  withSystemDbAccessContext: hoisted.withSystemDbAccessContext,
}));
vi.mock('../db/lockTimeout', () => ({ tightenLockTimeout: hoisted.tightenLockTimeout }));
vi.mock('./effectiveSettings', () => ({ getEffectiveAiBudget: hoisted.getEffectiveAiBudget }));
vi.mock('./sentry', () => ({ captureException: hoisted.captureException, captureMessage: hoisted.captureMessage }));
vi.mock('./aiModels/invocationLedgerWrite', () => ({ recordInvocation: hoisted.recordInvocation }));
vi.mock('./aiModels/platformModels', () => ({ getPlatformModelByModelId: hoisted.getPlatformModelByModelId }));
vi.mock('./aiModels/connectionOfferingRate', () => ({ readConnectionOfferingRate: hoisted.readConnectionOfferingRate }));
vi.mock('./aiChargeback/stampChargeback', () => ({ stampChargeback: hoisted.stampChargeback }));

import {
  AiBudgetBindingConflictError,
  AiBudgetPendingSettlementError,
  attestUnboundRate,
  MAX_PENDING_SETTLEMENT_REPLAY_ATTEMPTS,
  readSdkUsageSnapshot,
  replayPendingAiSettlements,
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

const NO_CARD = { chargeable: false, billingProfileId: null, coverage: null, basis: null, currency: null, amount: null };
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
  hoisted.stampChargeback.mockImplementation(async (_orgId: string, rows: NewInvocation[]) =>
    rows.map((r) => (r.ledgerMode === 'authoritative' ? { ...r, charge: { ...NO_CARD } } : r)));
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

  it('stamps the chargeback snapshot BEFORE the org lock, in the same transaction, and inserts the STAMPED rows (W10 #7608, P3)', async () => {
    primeSettle();
    const rows = [invocation()];
    await settleAiBudgetReservation({ orgId: ORG_ID, reservationId: RESERVATION_ID, invocations: rows });
    expect(hoisted.stampChargeback).toHaveBeenCalledTimes(1);
    expect(hoisted.stampChargeback).toHaveBeenCalledWith(ORG_ID, rows);
    // The card read never lengthens the org-lock hold: it runs before the lock statement.
    expect(q(0).sql).toMatch(/FROM organizations[\s\S]*FOR UPDATE/);
    expect(hoisted.stampChargeback.mock.invocationCallOrder[0]!).toBeLessThan(dbMock.execute.mock.invocationCallOrder[0]!);
    expect(hoisted.withSystemDbAccessContext).toHaveBeenCalledTimes(1);
    expect(hoisted.recordInvocation).toHaveBeenCalledWith(expect.objectContaining({ charge: NO_CARD }));
    // The input itself stays unstamped (it is what the fingerprint hashes).
    expect(rows[0]).not.toHaveProperty('charge');
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

  describe('an unbound BYOK refusal-fallback key at its own offering rate (#7773)', () => {
    const CONN_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const OTHER = { inputCentsPerM: 300, outputCentsPerM: 1500, cacheReadCentsPerM: 30, cacheWriteCentsPerM: 375 };
    const BYOK: TurnBinding = {
      ...BINDING, funding: 'partner_key', connectionId: CONN_ID, connectionKind: 'anthropic_byok',
      rateSnapshot: { source: 'linked_platform', standard: STD }, refusalFallback: null,
    };
    const byokRow = (rateSnapshot: NewInvocation['rateSnapshot'], over: Partial<NewInvocation> = {}) => invocation({
      fundingSource: 'partner_key', requestedModel: 'claude-sonnet-4-6', servedModel: 'claude-sonnet-4-6',
      fallbackUsed: true, rateSnapshot, ...over,
    });
    const byokReservation = () => reservationRow({ billing_source: 'partner_key', model_binding: BYOK });

    it('accepts it only at the rate the in-transaction reader re-reads on the binding\'s own connection', async () => {
      hoisted.readConnectionOfferingRate.mockResolvedValue({ rate: { source: 'offering', standard: OTHER } });
      primeSettle(byokReservation());
      await expect(settleAiBudgetReservation({
        orgId: ORG_ID, reservationId: RESERVATION_ID, invocations: [byokRow({ source: 'offering', standard: OTHER })],
      })).resolves.toMatchObject({ kind: 'settled', creditsDebitDue: false });
      expect(hoisted.readConnectionOfferingRate).toHaveBeenCalledWith({
        partnerId: PARTNER_ID, connectionId: CONN_ID, connectionKind: 'anthropic_byok', model: 'claude-sonnet-4-6',
      });
      // In the settlement transaction: no second context (no second pooled connection).
      expect(hoisted.withSystemDbAccessContext).toHaveBeenCalledTimes(1);
      expect(hoisted.readConnectionOfferingRate.mock.invocationCallOrder[0]!)
        .toBeGreaterThan(dbMock.execute.mock.invocationCallOrder[1]!); // after the reservation FOR UPDATE
      expect(hoisted.getPlatformModelByModelId).not.toHaveBeenCalled();
      expect(hoisted.recordInvocation).toHaveBeenCalledTimes(1);
    });

    it('rejects a rate the reader does not return now (changed, or no offering any more), and writes nothing', async () => {
      hoisted.readConnectionOfferingRate.mockResolvedValue({ rate: { source: 'offering', standard: { ...OTHER, inputCentsPerM: 1 } } });
      dbMock.execute.mockResolvedValueOnce([{ id: ORG_ID }]).mockResolvedValueOnce([byokReservation()]);
      await expect(settleAiBudgetReservation({
        orgId: ORG_ID, reservationId: RESERVATION_ID, invocations: [byokRow({ source: 'offering', standard: OTHER })],
      })).rejects.toThrow(/does not match the turn binding/);

      hoisted.readConnectionOfferingRate.mockResolvedValue({ rate: null, reason: 'no_enabled_offering' });
      dbMock.execute.mockReset();
      dbMock.execute.mockResolvedValueOnce([{ id: ORG_ID }]).mockResolvedValueOnce([byokReservation()]);
      await expect(settleAiBudgetReservation({
        orgId: ORG_ID, reservationId: RESERVATION_ID, invocations: [byokRow({ source: 'offering', standard: OTHER })],
      })).rejects.toThrow(/does not match the turn binding/);
      expect(hoisted.recordInvocation).not.toHaveBeenCalled();
    });

    it('never accepts the exception for a row not flagged fallbackUsed, or for a platform-sourced rate', async () => {
      hoisted.readConnectionOfferingRate.mockResolvedValue({ rate: { source: 'offering', standard: OTHER } });
      dbMock.execute.mockResolvedValueOnce([{ id: ORG_ID }]).mockResolvedValueOnce([byokReservation()]);
      await expect(settleAiBudgetReservation({
        orgId: ORG_ID, reservationId: RESERVATION_ID, invocations: [byokRow({ source: 'offering', standard: OTHER }, { fallbackUsed: false })],
      })).rejects.toThrow(/does not match the turn binding/);

      hoisted.getPlatformModelByModelId.mockResolvedValue({ rates: OTHER, optionRates: null });
      dbMock.execute.mockReset();
      dbMock.execute.mockResolvedValueOnce([{ id: ORG_ID }]).mockResolvedValueOnce([byokReservation()]);
      await expect(settleAiBudgetReservation({
        orgId: ORG_ID, reservationId: RESERVATION_ID, invocations: [byokRow({ source: 'platform', standard: OTHER })],
      })).rejects.toThrow(/does not match the turn binding/);
      expect(hoisted.recordInvocation).not.toHaveBeenCalled();
    });

    it('a rejected BYOK re-read is logged with what it found, so a repriced/disabled offering is diagnosable', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      hoisted.readConnectionOfferingRate.mockResolvedValue({ rate: null, reason: 'no_enabled_offering' });
      dbMock.execute.mockResolvedValueOnce([{ id: ORG_ID }]).mockResolvedValueOnce([byokReservation()]);
      await expect(settleAiBudgetReservation({
        orgId: ORG_ID, reservationId: RESERVATION_ID, invocations: [byokRow({ source: 'offering', standard: OTHER })],
      })).rejects.toThrow(/does not match the turn binding/);
      expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
        eventCode: 'ai_unbound_byok_rate_rejected', model: 'claude-sonnet-4-6', connectionId: CONN_ID,
        offeringId: OFFERING_ID, reason: 'no_enabled_offering', rowRateSource: 'offering', currentRateSource: null,
      }));
      warn.mockRestore();
    });

    it('a platform-funded turn can never use the BYOK exception, even with an offering-sourced rate the reader would match', async () => {
      hoisted.readConnectionOfferingRate.mockResolvedValue({ rate: { source: 'offering', standard: OTHER } });
      dbMock.execute.mockResolvedValueOnce([{ id: ORG_ID }]).mockResolvedValueOnce([reservationRow({ model_binding: { ...BINDING, connectionId: CONN_ID } })]);
      await expect(settleAiBudgetReservation({
        orgId: ORG_ID, reservationId: RESERVATION_ID,
        invocations: [invocation({ requestedModel: 'claude-sonnet-4-6', fallbackUsed: true, rateSnapshot: { source: 'offering', standard: OTHER } })],
      })).rejects.toThrow(/does not match the turn binding/);
      expect(hoisted.readConnectionOfferingRate).not.toHaveBeenCalled();
      expect(hoisted.recordInvocation).not.toHaveBeenCalled();
    });

    it('no offering on the connection: the bound-rate row settles without a re-read', async () => {
      primeSettle(byokReservation());
      await expect(settleAiBudgetReservation({
        orgId: ORG_ID, reservationId: RESERVATION_ID, invocations: [byokRow({ source: 'linked_platform', standard: STD })],
      })).resolves.toMatchObject({ kind: 'settled' });
      expect(hoisted.readConnectionOfferingRate).not.toHaveBeenCalled();
    });

    it('a platform turn never consults the connection reader', async () => {
      const OTHER_PLATFORM = { source: 'platform' as const, standard: OTHER };
      hoisted.getPlatformModelByModelId.mockResolvedValue({ rates: OTHER, optionRates: null });
      primeSettle();
      await expect(settleAiBudgetReservation({
        orgId: ORG_ID, reservationId: RESERVATION_ID,
        invocations: [invocation({ requestedModel: 'claude-sonnet-4-6', fallbackUsed: true, rateSnapshot: OTHER_PLATFORM })],
      })).resolves.toMatchObject({ kind: 'settled' });
      expect(hoisted.readConnectionOfferingRate).not.toHaveBeenCalled();
    });

    describe('attested rate (unbound_rate_attestations)', () => {
      const OFFERING_RATE = { source: 'offering' as const, standard: OTHER };
      const attestedReservation = (over: Record<string, unknown> = {}) => reservationRow({
        billing_source: 'partner_key', model_binding: BYOK,
        unbound_rate_attestations: { 'claude-sonnet-4-6': { connectionId: CONN_ID, offeringId: 'off-x', rate: OFFERING_RATE } },
        ...over,
      });

      it('a row at the attested rate settles with NO live re-read, even if the offering was since repriced or removed', async () => {
        hoisted.readConnectionOfferingRate.mockResolvedValue({ rate: { source: 'offering', standard: { ...OTHER, inputCentsPerM: 1 } }, offeringId: 'off-x' });
        primeSettle(attestedReservation());
        await expect(settleAiBudgetReservation({
          orgId: ORG_ID, reservationId: RESERVATION_ID, invocations: [byokRow(OFFERING_RATE)],
        })).resolves.toMatchObject({ kind: 'settled' });

        hoisted.readConnectionOfferingRate.mockResolvedValue({ rate: null, reason: 'no_enabled_offering' });
        primeSettle(attestedReservation());
        await expect(settleAiBudgetReservation({
          orgId: ORG_ID, reservationId: RESERVATION_ID, invocations: [byokRow(OFFERING_RATE)],
        })).resolves.toMatchObject({ kind: 'settled' });
        expect(hoisted.readConnectionOfferingRate).not.toHaveBeenCalled();
        expect(hoisted.recordInvocation).toHaveBeenCalledTimes(2);
      });

      it('an attestation for a different connection is not accepted: falls to the live re-read', async () => {
        const other = { 'claude-sonnet-4-6': { connectionId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', offeringId: 'off-x', rate: OFFERING_RATE } };
        hoisted.readConnectionOfferingRate.mockResolvedValue({ rate: { source: 'offering', standard: { ...OTHER, inputCentsPerM: 1 } }, offeringId: 'off-x' });
        dbMock.execute.mockResolvedValueOnce([{ id: ORG_ID }]).mockResolvedValueOnce([attestedReservation({ unbound_rate_attestations: other })]);
        await expect(settleAiBudgetReservation({
          orgId: ORG_ID, reservationId: RESERVATION_ID, invocations: [byokRow(OFFERING_RATE)],
        })).rejects.toThrow(/does not match the turn binding/);
        expect(hoisted.readConnectionOfferingRate).toHaveBeenCalledTimes(1);
        expect(hoisted.recordInvocation).not.toHaveBeenCalled();
      });

      it('a tampered rate (differs from the attestation and from the live read) is rejected, nothing recorded', async () => {
        const tampered = { source: 'offering' as const, standard: { ...OTHER, outputCentsPerM: 1 } };
        hoisted.readConnectionOfferingRate.mockResolvedValue({ rate: OFFERING_RATE, offeringId: 'off-x' });
        dbMock.execute.mockResolvedValueOnce([{ id: ORG_ID }]).mockResolvedValueOnce([attestedReservation()]);
        await expect(settleAiBudgetReservation({
          orgId: ORG_ID, reservationId: RESERVATION_ID, invocations: [byokRow(tampered)],
        })).rejects.toThrow(/does not match the turn binding/);
        expect(hoisted.recordInvocation).not.toHaveBeenCalled();
      });

      it('the reservation FOR UPDATE select includes unbound_rate_attestations', async () => {
        primeSettle(attestedReservation());
        await settleAiBudgetReservation({
          orgId: ORG_ID, reservationId: RESERVATION_ID, invocations: [byokRow(OFFERING_RATE)],
        });
        expect(q(1).sql).toMatch(/unbound_rate_attestations[\s\S]*FROM ai_budget_reservations[\s\S]*FOR UPDATE/);
      });
    });
  });

  describe('attestUnboundRate (#7773)', () => {
    const CONN = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const ENTRY = { connectionId: CONN, offeringId: 'off-1', rate: { source: 'offering' as const, standard: STD } };
    const input = { orgId: ORG_ID, reservationId: RESERVATION_ID, model: 'claude-sonnet-4-6', attestation: ENTRY };

    it('one UPDATE, new entry on the LEFT of || (first write wins), scoped by id + org + settleable status; returns the parsed entry', async () => {
      dbMock.execute.mockResolvedValueOnce([{ attestations: { 'claude-sonnet-4-6': ENTRY } }]);
      await expect(attestUnboundRate(input)).resolves.toEqual(ENTRY);
      expect(dbMock.execute).toHaveBeenCalledTimes(1);
      const { sql: text, params } = q(0);
      expect(text).toMatch(/UPDATE ai_budget_reservations/);
      expect(text).toContain('|| COALESCE(unbound_rate_attestations');
      expect(text).toMatch(/WHERE id = \$\d::uuid AND org_id = \$\d::uuid/);
      expect(text).toMatch(/status IN \('active', 'indeterminate', 'expired'\)/);
      expect(params).toEqual(expect.arrayContaining([RESERVATION_ID, ORG_ID, JSON.stringify({ 'claude-sonnet-4-6': ENTRY })]));
    });

    it('returns the STORED entry when an earlier write exists', async () => {
      const stored = { ...ENTRY, offeringId: 'off-0', rate: { source: 'offering' as const, standard: FB } };
      dbMock.execute.mockResolvedValueOnce([{ attestations: { 'claude-sonnet-4-6': stored } }]);
      await expect(attestUnboundRate(input)).resolves.toEqual(stored);
    });

    it('returns null when no row comes back (settled, released or gone)', async () => {
      dbMock.execute.mockResolvedValueOnce([]);
      await expect(attestUnboundRate(input)).resolves.toBeNull();
    });
  });

  describe('carried rates across a same-connection switch (W05)', () => {
    const OPUS = { inputCentsPerM: 500, outputCentsPerM: 2500, cacheReadCentsPerM: 50, cacheWriteCentsPerM: 625 };
    // Bound to Opus now; the session switched away from Sonnet, whose late
    // delta (spike Q6) is reported under the Sonnet key.
    const SWITCHED: TurnBinding = {
      ...BINDING, wireModel: 'claude-opus-5-5', logicalModel: 'claude-opus-5-5',
      rateSnapshot: { source: 'platform', standard: OPUS },
      carriedRates: [{ wireModel: 'claude-sonnet-5-5', rateSnapshot: { source: 'platform', standard: STD } }],
    };

    it('accepts a row under a carried model key priced at exactly its carried snapshot', async () => {
      primeSettle(reservationRow({ model_binding: SWITCHED }));
      await expect(settleAiBudgetReservation({
        orgId: ORG_ID, reservationId: RESERVATION_ID,
        invocations: [
          invocation({ requestedModel: 'claude-opus-5-5', servedModel: 'claude-opus-5-5', rateSnapshot: { source: 'platform', standard: OPUS } }),
          invocation(), // claude-sonnet-5-5 at STD = the carried snapshot
        ],
      })).resolves.toMatchObject({ kind: 'settled' });
    });

    it('rejects a carried model key priced at anything but its carried snapshot', async () => {
      dbMock.execute.mockResolvedValueOnce([{ id: ORG_ID }]).mockResolvedValueOnce([reservationRow({ model_binding: SWITCHED })]);
      await expect(settleAiBudgetReservation({
        orgId: ORG_ID, reservationId: RESERVATION_ID,
        invocations: [invocation({ rateSnapshot: { source: 'platform', standard: { ...STD, inputCentsPerM: 1 } } })],
      })).rejects.toThrow(/does not match the turn binding/);
      expect(hoisted.recordInvocation).not.toHaveBeenCalled();
    });

    it('a carried snapshot is accepted only for ITS model key, never for another unbound key', async () => {
      dbMock.execute.mockResolvedValueOnce([{ id: ORG_ID }]).mockResolvedValueOnce([reservationRow({ model_binding: SWITCHED })]);
      await expect(settleAiBudgetReservation({
        orgId: ORG_ID, reservationId: RESERVATION_ID,
        invocations: [invocation({ requestedModel: 'claude-sonnet-4-6', servedModel: 'claude-sonnet-4-6' })],
      })).rejects.toThrow(/does not match the turn binding/);
      expect(hoisted.recordInvocation).not.toHaveBeenCalled();
    });

    it('a stable-key replay of a binding WITH carried rates is the same binding (parse keeps carriedRates)', async () => {
      dbMock.execute
        .mockResolvedValueOnce([{ id: ORG_ID }])
        .mockResolvedValueOnce([reservationRow({ model_binding: JSON.parse(JSON.stringify(SWITCHED)) })]);
      await reserveAiBudget({ orgId: ORG_ID, idempotencyKey: 'key-1', billingSource: 'platform', binding: SWITCHED });
      expect(dbMock.execute).toHaveBeenCalledTimes(2); // no re-bind UPDATE
    });
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

  /** A rebaseline also asks whether a NEWER pending re-baseline exists for the session. */
  function primeRebaseline(stored: unknown, newerPending: Array<{ id: string }> = []) {
    dbMock.execute
      .mockResolvedValueOnce([{ id: ORG_ID }])
      .mockResolvedValueOnce([reservationRow({ model_binding: BINDING })])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ sdk_usage_snapshot: stored }])   // session snapshot FOR UPDATE
      .mockResolvedValueOnce(newerPending)                       // newer pending re-baseline?
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

  it('a rebaseline (snapshot_regressed turn) DOES move the stored snapshot down (review finding 3)', async () => {
    primeRebaseline(NEXT);
    await settleAiBudgetReservation({
      orgId: ORG_ID, reservationId: RESERVATION_ID, invocations: [invocation()],
      sdkUsage: { sessionId: SESSION_ID, nextSnapshot: PREV, rebaseline: true, baseSnapshot: NEXT },
    });
    expect(allSql().some((s) => /SET sdk_usage_snapshot/.test(s))).toBe(true);
  });

  it('a rebaseline superseded by a NEWER pending re-baseline on the session leaves the snapshot alone (re-review)', async () => {
    primeRebaseline(NEXT, [{ id: 'newer-reservation' }]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await settleAiBudgetReservation({
      orgId: ORG_ID, reservationId: RESERVATION_ID, invocations: [invocation()],
      sdkUsage: { sessionId: SESSION_ID, nextSnapshot: PREV, rebaseline: true, baseSnapshot: NEXT },
    });
    warn.mockRestore();
    expect(allSql().some((s) => /SET sdk_usage_snapshot/.test(s))).toBe(false);
    expect(allSql().some((s) => /SET status = 'settled'/.test(s))).toBe(true);
  });

  it('a rebaseline whose base is no longer the stored snapshot (a newer turn settled first) leaves it alone (review S10)', async () => {
    const OTHER: SdkUsageSnapshot = { version: 1, models: { 'claude-sonnet-5-5': { tokens: { input: 3, output: 1, cacheRead: 0, cacheWrite: 0 }, webSearchRequests: 0 } } };
    primeRebaseline(OTHER);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await settleAiBudgetReservation({
      orgId: ORG_ID, reservationId: RESERVATION_ID, invocations: [invocation()],
      sdkUsage: { sessionId: SESSION_ID, nextSnapshot: PREV, rebaseline: true, baseSnapshot: NEXT },
    });
    warn.mockRestore();
    expect(allSql().some((s) => /SET sdk_usage_snapshot/.test(s))).toBe(false);
    // The ledger row and the settle itself still go through.
    expect(allSql().some((s) => /SET status = 'settled'/.test(s))).toBe(true);
  });

  it('readSdkUsageSnapshot ignores a pending REBASELINE: the next turn bills against the stored snapshot (review S10)', async () => {
    dbMock.execute
      .mockResolvedValueOnce([{ sdk_usage_snapshot: NEXT }])
      .mockResolvedValueOnce([{ snapshot: PREV, rebaseline: true }]);
    await expect(readSdkUsageSnapshot({ orgId: ORG_ID, sessionId: SESSION_ID })).resolves.toEqual(NEXT);
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
    const pending = JSON.parse(persist.params.find((p) => typeof p === 'string' && p.startsWith('{')) as string);
    expect(pending).toMatchObject({ reservationId: RESERVATION_ID, invocations: [expect.objectContaining({ costCents: 0.5 })] });
    // W10 (#7608): what is persisted is UNSTAMPED, so the replay stamps with the card in force at replay.
    expect(pending.invocations[0]).not.toHaveProperty('charge');
    error.mockRestore();
  });
});

describe('replayPendingAiSettlements dead-letter (#7700 review finding 5)', () => {
  it('a failed replay is counted and moved to the back; the last allowed failure stamps it dead and reports ai_settlement_replay_dead', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    hoisted.captureMessage.mockClear();
    dbMock.execute
      .mockResolvedValueOnce([{ id: RESERVATION_ID, org_id: ORG_ID, pending_settlement: { reservationId: 'someone-else', orgId: ORG_ID } }])
      .mockResolvedValueOnce([{ attempts: MAX_PENDING_SETTLEMENT_REPLAY_ATTEMPTS, dead: true }]);

    await expect(replayPendingAiSettlements(10)).resolves.toEqual([]);

    expect(allSql()[0]).toMatch(/pending_settlement_dead_at IS NULL/);
    const failure = q(1);
    expect(failure.sql).toMatch(/SET pending_settlement_attempts = pending_settlement_attempts \+ 1/);
    expect(failure.sql).toMatch(/updated_at = now\(\)/);
    expect(failure.params).toContain(RESERVATION_ID);
    expect(hoisted.captureMessage).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ eventCode: 'ai_settlement_replay_dead' }));
    error.mockRestore();
  });

  it('a failure below the cap reports no dead-letter event', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    hoisted.captureMessage.mockClear();
    dbMock.execute
      .mockResolvedValueOnce([{ id: RESERVATION_ID, org_id: ORG_ID, pending_settlement: { reservationId: 'someone-else', orgId: ORG_ID } }])
      .mockResolvedValueOnce([{ attempts: 1, dead: false }]);
    await replayPendingAiSettlements(10);
    expect(hoisted.captureMessage).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
