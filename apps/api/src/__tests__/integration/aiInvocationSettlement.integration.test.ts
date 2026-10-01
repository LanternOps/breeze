/**
 * AI model registry W03 (#7601) Task 6: the single billing path against real
 * Postgres. ai_invocations is the source of truth for every rollup; the turn
 * binding lands with the reservation or not at all; money moves exactly once.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';

// Settlement waits up to 30 s for the org lock, twice. The contention cases
// below need it to give up fast; nothing else about the bound is under test.
vi.mock('../../db/lockTimeout', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/lockTimeout')>();
  return {
    ...actual,
    tightenLockTimeout: (executor: Parameters<typeof actual.tightenLockTimeout>[0], ms: number) =>
      actual.tightenLockTimeout(executor, Math.min(ms, 300)),
  };
});

import { db, withSystemDbAccessContext } from '../../db';
import { settleAndDebitAiReservations } from '../../jobs/aiBudgetReservationSweep';
import {
  AiBudgetPendingSettlementError,
  clearCreditDebitFailure,
  listFailedCreditDebits,
  listUndebitedPlatformSettlements,
  persistPendingSettlement,
  readSdkUsageSnapshot,
  replayPendingAiSettlements,
  reserveAiBudget,
  settleAiBudgetReservation,
} from '../../services/aiBudgetReservations';
import type { SdkUsageSnapshot, TurnOutcome } from '../../services/aiModels/invocationUsage';
import { getPlatformModelById } from '../../services/aiModels/platformModels';
import { priceInvocation } from '../../services/aiModels/pricing';
import { resolveModel } from '../../services/aiModels/resolveModel';
import { settleInvocation, type SettleInvocationInput } from '../../services/aiModels/settleInvocation';
import { turnBindingFrom, type TurnBinding } from '../../services/aiModels/turnBinding';
import { closeRegistryFixtures, fixtureSql } from './aiModelRegistryFixtures';
import { seedPricedPlatformModel, seedRegistryPartner, type SeededRegistryPartner } from './helpers/aiModelRegistrySeed';

const RUN = !!process.env.DATABASE_URL;
afterAll(closeRegistryFixtures);

// The platform connection is usable only with a platform key configured (no
// call is ever made with it here).
const savedPlatformKey = process.env.ANTHROPIC_API_KEY;
beforeEach(() => { process.env.ANTHROPIC_API_KEY = 'sk-ant-w03-integration-placeholder'; });
afterAll(() => {
  if (savedPlatformKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedPlatformKey;
});

const T = { input: 120_000, output: 40_000, cacheRead: 500_000, cacheWrite: 2_000 };
const OK = (model: string, sdk: number | null): TurnOutcome => ({
  stopReason: 'end_turn', refused: false, refusalCategory: null, fallbackUsed: false,
  servedModel: model, providerModel: null, sdkReportedCostUsd: sdk,
});

async function sys<R>(fn: () => Promise<R>): Promise<R> {
  return withSystemDbAccessContext(fn);
}
async function q<R extends Record<string, unknown>>(query: ReturnType<typeof sql>): Promise<R[]> {
  return sys(async () => {
    const result = await db.execute<R>(query);
    return ((result as unknown as { rows?: R[] }).rows ?? (result as unknown as R[]));
  });
}

async function bindingFor(s: SeededRegistryPartner, surface: 'chat' | 'ai_agents' = 'chat'): Promise<TurnBinding> {
  const r = await resolveModel({ partnerId: s.partnerId, orgId: s.orgId, surface });
  if (!r.ok) throw new Error(`resolveModel: ${r.reason}`);
  return turnBindingFrom(r);
}

async function reserve(s: SeededRegistryPartner, binding: TurnBinding, opts: { session?: boolean; key?: string } = {}): Promise<string> {
  const res = await reserveAiBudget({
    orgId: s.orgId, billingSource: binding.funding, idempotencyKey: opts.key ?? `t:${randomUUID()}`, binding,
    ...(opts.session === false ? {} : { sessionId: s.chatSessionId }),
  });
  if (res.kind === 'denied') throw new Error(res.message);
  return res.reservationId;
}

function settleInput(s: SeededRegistryPartner, binding: TurnBinding, reservationId: string | undefined, over: Partial<SettleInvocationInput> = {}): SettleInvocationInput {
  return {
    binding, orgId: s.orgId, userId: s.userId, sessionId: s.chatSessionId, agentRunId: null, sourceRef: null,
    usage: [{ model: binding.wireModel, tokens: T, webSearchRequests: 0, speedServed: 'standard', providerModel: null }],
    outcome: OK(binding.wireModel, 99.99), reservationId, ...over,
  };
}

// ---------------------------------------------------------------------------
// Billing service stub: records every deduct call; responses are scripted.
// ---------------------------------------------------------------------------
type DeductCall = { key: string | null; headerKey: string | null; costCents: number };
let deductCalls: DeductCall[] = [];
let deductResponses: Array<() => Promise<Response>> = [];

function installBillingStub(): void {
  process.env.BILLING_SERVICE_URL = 'https://billing.test.invalid';
  process.env.BILLING_SERVICE_API_KEY = 'test-billing-key';
  deductCalls = [];
  deductResponses = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (!String(url).endsWith('/ai-credits/deduct')) throw new Error(`unexpected fetch ${String(url)}`);
    const body = JSON.parse(String(init.body)) as { costCents: number; idempotencyKey?: string };
    deductCalls.push({
      key: body.idempotencyKey ?? null,
      headerKey: (init.headers as Record<string, string>)['Idempotency-Key'] ?? null,
      costCents: body.costCents,
    });
    const next = deductResponses.shift();
    return next ? next() : new Response(JSON.stringify({ success: true }), { status: 200 });
  }));
}

function callsFor(reservationId: string): DeductCall[] {
  return deductCalls.filter((c) => c.key === `ai-settlement:${reservationId}`);
}

async function reservationState(id: string) {
  const [row] = await q<{
    status: string; credits_debit_due_at: string | null; credits_debited_at: string | null;
    credits_debit_failed_at: string | null; credits_debit_error: string | null; credits_debit_attempts: number;
    pending_settlement: unknown; actual_cost_cents: string | null;
  }>(sql`SELECT status, credits_debit_due_at, credits_debited_at, credits_debit_failed_at, credits_debit_error,
                credits_debit_attempts, pending_settlement, actual_cost_cents
         FROM ai_budget_reservations WHERE id = ${id}::uuid`);
  return row!;
}

/** Push a due debit past the sweep's grace, as if it settled minutes ago. */
async function backdateDebit(id: string): Promise<void> {
  await fixtureSql`UPDATE ai_budget_reservations SET credits_debit_due_at = now() - interval '10 minutes' WHERE id = ${id}`;
}

/** Hold `organizations FOR UPDATE` from another connection until release(). */
async function holdOrganizationLock(orgId: string): Promise<{ release: () => Promise<void> }> {
  const client = postgres(process.env.DATABASE_URL ?? '', { max: 1 });
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let locked!: () => void;
  const isLocked = new Promise<void>((resolve) => { locked = resolve; });
  const tx = client.begin(async (t) => {
    await t`SELECT 1 FROM organizations WHERE id = ${orgId} FOR UPDATE`;
    locked();
    await held;
  });
  await isLocked;
  return {
    release: async () => {
      release();
      await tx;
      await client.end();
    },
  };
}

describe.skipIf(!RUN)('ai_invocations is the source of truth for every rollup', () => {
  let s: SeededRegistryPartner;
  let binding: TurnBinding;

  beforeEach(async () => {
    delete process.env.BILLING_SERVICE_URL;
    delete process.env.BILLING_SERVICE_API_KEY;
    s = await seedRegistryPartner('platform');
    binding = await bindingFor(s);
  });

  it('binds the turn atomically: reservation + session offering in one transaction', async () => {
    const id = await reserve(s, binding);
    const [row] = await q<{ model_binding: { offeringId: string }; offering_id: string; options: unknown }>(sql`
      SELECT r.model_binding, s.offering_id, s.options FROM ai_budget_reservations r
      JOIN ai_sessions s ON s.id = r.session_id WHERE r.id = ${id}::uuid`);
    expect(row!.model_binding.offeringId).toBe(binding.offeringId);
    expect(row!.offering_id).toBe(binding.offeringId);
    expect(row!.options).toEqual(binding.options);
  });

  it('a binding that fails the session stamp leaves NO reservation behind', async () => {
    const other = await seedRegistryPartner('platform');
    const forged = { ...binding, partnerId: other.partnerId }; // composite (offering_id, offering_partner_id) FK must refuse
    const key = `t:${randomUUID()}`;
    await expect(reserveAiBudget({
      orgId: s.orgId, billingSource: forged.funding, sessionId: s.chatSessionId, idempotencyKey: key, binding: forged,
    })).rejects.toThrow();
    expect(await q(sql`SELECT 1 FROM ai_budget_reservations WHERE idempotency_key = ${key}`)).toHaveLength(0);
  });

  it('settled rollups equal the sum of the ledger rows, and the SDK\'s positive-but-wrong cost is never billed', async () => {
    const id = await reserve(s, binding);
    const out = await settleInvocation(settleInput(s, binding, id));
    const expected = priceInvocation(binding.rateSnapshot, T, {});
    expect(out.costCents).toBeCloseTo(expected, 6);
    expect(out.invocationIds).toHaveLength(1);

    const [ledger] = await q<{ cost_cents: string; sdk_reported_cost_usd: string; ledger_mode: string }>(sql`
      SELECT cost_cents, sdk_reported_cost_usd, ledger_mode FROM ai_invocations WHERE id = ${out.invocationIds[0]}::uuid`);
    expect(Number(ledger!.cost_cents)).toBeCloseTo(expected, 6);
    expect(Number(ledger!.sdk_reported_cost_usd)).toBe(99.99);
    expect(ledger!.ledger_mode).toBe('authoritative');

    const [session] = await q<{ c: string; i: number; o: number }>(sql`
      SELECT total_cost_cents AS c, total_input_tokens AS i, total_output_tokens AS o FROM ai_sessions WHERE id = ${s.chatSessionId}::uuid`);
    const [sums] = await q<{ c: string; i: string; o: string }>(sql`
      SELECT COALESCE(SUM(cost_cents), 0) AS c,
             COALESCE(SUM(input_tokens + cache_read_tokens + cache_write_tokens), 0) AS i,
             COALESCE(SUM(output_tokens), 0) AS o
      FROM ai_invocations WHERE session_id = ${s.chatSessionId}::uuid`);
    expect(Number(session!.c)).toBeCloseTo(Number(sums!.c), 6);
    expect(Number(session!.i)).toBe(Number(sums!.i));
    expect(Number(session!.o)).toBe(Number(sums!.o));

    const usage = await q<{ period: string; c: string }>(sql`
      SELECT period, total_cost_cents AS c FROM ai_cost_usage WHERE org_id = ${s.orgId}::uuid`);
    expect(usage.map((u) => u.period).sort()).toEqual(['daily', 'monthly']);
    for (const u of usage) expect(Number(u.c)).toBeCloseTo(Number(sums!.c), 6);
    expect(await reservationState(id)).toMatchObject({ status: 'settled' });
  });

  it('a $0 SDK cost on a model added by today\'s discovery bills its platform rate', async () => {
    const pm = (await getPlatformModelById(await seedPricedPlatformModel()))!;
    const fresh = { ...binding, wireModel: pm.modelId, logicalModel: pm.modelId, rateSnapshot: { source: 'platform' as const, standard: pm.rates! } };
    const out = await settleInvocation(settleInput(s, fresh, undefined, {
      sessionId: null, sourceRef: 'test',
      usage: [{ model: pm.modelId, tokens: T, webSearchRequests: 0, speedServed: 'standard', providerModel: null }],
      outcome: OK(pm.modelId, 0),
    }));
    expect(out.costCents).toBeGreaterThan(0);
    expect(out.costCents).toBeCloseTo(priceInvocation(fresh.rateSnapshot, T, {}), 6);
    const [usage] = await q<{ c: string }>(sql`
      SELECT total_cost_cents AS c FROM ai_cost_usage WHERE org_id = ${s.orgId}::uuid AND period = 'daily'`);
    expect(Number(usage!.c)).toBeCloseTo(out.costCents, 6);
  });

  it('a settlement carrying a rate the turn did not bind is rejected and writes nothing — not even the SDK snapshot', async () => {
    const id = await reserve(s, binding);
    const tampered = { ...binding, rateSnapshot: { ...binding.rateSnapshot, standard: { ...binding.rateSnapshot.standard, inputCentsPerM: 1 } } };
    const snapshot: SdkUsageSnapshot = { version: 1, models: { [binding.wireModel]: { tokens: T, webSearchRequests: 0 } } };
    await expect(settleInvocation(settleInput(s, tampered, id, {
      sdkUsage: { sessionId: s.chatSessionId, nextSnapshot: snapshot, usageConfirmed: true, usageNote: 'delta' },
    }))).rejects.toThrow(/does not match the turn binding/);
    expect(await q(sql`SELECT 1 FROM ai_invocations WHERE org_id = ${s.orgId}::uuid`)).toHaveLength(0);
    expect(await readSdkUsageSnapshot({ orgId: s.orgId, sessionId: s.chatSessionId })).toBeNull();
    expect(await reservationState(id)).toMatchObject({ status: 'active' });
  });

  it('the SDK usage snapshot advances in the settlement transaction, as a high-water mark', async () => {
    const first: SdkUsageSnapshot = { version: 1, models: { [binding.wireModel]: { tokens: T, webSearchRequests: 0 } } };
    await settleInvocation(settleInput(s, binding, await reserve(s, binding), {
      sdkUsage: { sessionId: s.chatSessionId, nextSnapshot: first, usageConfirmed: true, usageNote: 'first_result' },
    }));
    expect(await readSdkUsageSnapshot({ orgId: s.orgId, sessionId: s.chatSessionId })).toEqual(first);

    // An ordinary (delta) settlement carrying a lower snapshot — e.g. an older replay — never moves it backwards.
    const lower: SdkUsageSnapshot = { version: 1, models: { [binding.wireModel]: { tokens: { ...T, output: 1 }, webSearchRequests: 0 } } };
    await settleInvocation(settleInput(s, binding, await reserve(s, binding), {
      usage: [], sdkUsage: { sessionId: s.chatSessionId, nextSnapshot: lower, usageConfirmed: true, usageNote: 'delta' },
    }));
    expect(await readSdkUsageSnapshot({ orgId: s.orgId, sessionId: s.chatSessionId })).toEqual(first);
  });

  it('a snapshot_regressed settlement re-baselines the stored snapshot DOWN to the current reading (review finding 3)', async () => {
    const first: SdkUsageSnapshot = { version: 1, models: { [binding.wireModel]: { tokens: T, webSearchRequests: 0 } } };
    await settleInvocation(settleInput(s, binding, await reserve(s, binding), {
      sdkUsage: { sessionId: s.chatSessionId, nextSnapshot: first, usageConfirmed: true, usageNote: 'first_result' },
    }));
    const reset: SdkUsageSnapshot = { version: 1, models: { [binding.wireModel]: { tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, webSearchRequests: 0 } } };
    const out = await settleInvocation(settleInput(s, binding, await reserve(s, binding), {
      usage: [{ model: binding.wireModel, tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, webSearchRequests: 0, speedServed: 'standard', providerModel: null }],
      sdkUsage: { sessionId: s.chatSessionId, nextSnapshot: reset, usageConfirmed: false, usageNote: 'snapshot_regressed' },
    }));
    expect(out.costCents).toBeGreaterThan(0);
    expect(await readSdkUsageSnapshot({ orgId: s.orgId, sessionId: s.chatSessionId })).toEqual(reset);
  });

  it('a stable-key replay after a rate change re-binds the active reservation before dispatch (finding 4)', async () => {
    const agentBinding = await bindingFor(s, 'ai_agents');
    const key = `ai-agent-run:${randomUUID()}`;
    const first = await reserve(s, agentBinding, { session: false, key });
    const repriced = { ...agentBinding, rateSnapshot: { ...agentBinding.rateSnapshot, standard: { ...agentBinding.rateSnapshot.standard, inputCentsPerM: 999 } } };
    expect(await reserve(s, repriced, { session: false, key })).toBe(first);
    await expect(settleInvocation(settleInput(s, agentBinding, first, { sessionId: null })))
      .rejects.toThrow(/does not match the turn binding/);
    await expect(settleInvocation(settleInput(s, repriced, first, { sessionId: null })))
      .resolves.toMatchObject({ deferred: false });
    // Settled now: a further replay with yet another binding is refused, never re-bound.
    await expect(reserveAiBudget({ orgId: s.orgId, billingSource: 'platform', idempotencyKey: key, binding: agentBinding }))
      .rejects.toThrow();
  });

  it('never re-binds a reservation carrying a pending settlement', async () => {
    const agentBinding = await bindingFor(s, 'ai_agents');
    const key = `ai-agent-run:${randomUUID()}`;
    const id = await reserve(s, agentBinding, { session: false, key });
    await fixtureSql`UPDATE ai_budget_reservations SET pending_settlement = '{"x":1}'::jsonb WHERE id = ${id}`;
    await expect(reserveAiBudget({
      orgId: s.orgId, billingSource: 'platform', idempotencyKey: key, binding: { ...agentBinding, wireFingerprint: 'changed' },
    })).rejects.toBeInstanceOf(AiBudgetPendingSettlementError);
  });

  it('refuses a SAME-binding stable-key replay onto a reservation carrying a pending settlement (review finding 2)', async () => {
    const agentBinding = await bindingFor(s, 'ai_agents');
    const key = `ai-agent-run:${randomUUID()}`;
    const id = await reserve(s, agentBinding, { session: false, key });
    const deferred = { orgId: s.orgId, reservationId: id, actualCostCents: 5, inputTokens: 10, outputTokens: 5 };
    expect(await persistPendingSettlement(deferred)).toBe('persisted');
    // Still `active` (markIndeterminate is best effort): the replay must not get the hold back.
    expect(await reservationState(id)).toMatchObject({ status: 'active' });
    await expect(reserveAiBudget({ orgId: s.orgId, billingSource: 'platform', idempotencyKey: key, binding: agentBinding }))
      .rejects.toThrow(/pending settlement/);
    await expect(reserveAiBudget({ orgId: s.orgId, billingSource: 'platform', idempotencyKey: key }))
      .rejects.toThrow(/pending settlement/);
    expect((await reservationState(id)).pending_settlement).toMatchObject({ actualCostCents: 5 });
  });

  it('a settlement that is not the pending one is refused and the pending one survives to be replayed (review finding 2)', async () => {
    const agentBinding = await bindingFor(s, 'ai_agents');
    const id = await reserve(s, agentBinding, { session: false });
    const deferred = { orgId: s.orgId, reservationId: id, actualCostCents: 5, inputTokens: 10, outputTokens: 5 };
    expect(await persistPendingSettlement(deferred)).toBe('persisted');
    await expect(settleAiBudgetReservation({ ...deferred, actualCostCents: 7, outputTokens: 9 }))
      .rejects.toThrow(/pending settlement/);
    expect(await reservationState(id)).toMatchObject({ status: 'active', actual_cost_cents: null });
    expect((await reservationState(id)).pending_settlement).toMatchObject({ actualCostCents: 5 });
    // The pending settlement itself (the sweep's replay, or the deferring caller retrying) goes through.
    expect((await replayPendingAiSettlements()).filter((r) => r.reservationId === id)).toMatchObject([{ kind: 'settled', actualCostCents: 5 }]);
    expect(await reservationState(id)).toMatchObject({ status: 'settled', pending_settlement: null });
  });
});

describe.skipIf(!RUN)('money moves exactly once (Step 8a, findings 1 and 2)', () => {
  let s: SeededRegistryPartner;
  let binding: TurnBinding;

  beforeEach(async () => {
    installBillingStub();
    s = await seedRegistryPartner('platform');
    binding = await bindingFor(s);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.BILLING_SERVICE_URL;
    delete process.env.BILLING_SERVICE_API_KEY;
  });

  it('debits the settled amount once, keyed by the reservation, and stamps it', async () => {
    const id = await reserve(s, binding);
    await settleInvocation(settleInput(s, binding, id));
    const state = await reservationState(id);
    expect(callsFor(id)).toEqual([{ key: `ai-settlement:${id}`, headerKey: `ai-settlement:${id}`, costCents: Number(state.actual_cost_cents) }]);
    expect(state.credits_debited_at).not.toBeNull();
  });

  it('concurrent settles of the same reservation write one ledger row and debit once', async () => {
    const id = await reserve(s, binding);
    const input = settleInput(s, binding, id);
    const results = await Promise.all([settleInvocation(input), settleInvocation(input)]);
    expect(results.map((r) => r.invocationIds.length).sort()).toEqual([0, 1]);
    expect(await q(sql`SELECT 1 FROM ai_invocations WHERE session_id = ${s.chatSessionId}::uuid`)).toHaveLength(1);
    expect(callsFor(id)).toHaveLength(1);
  });

  it('a lost response is retried by the sweep under the SAME key and amount; a second sweep does nothing', async () => {
    deductResponses.push(async () => { throw new TypeError('fetch failed'); });
    const id = await reserve(s, binding);
    await settleInvocation(settleInput(s, binding, id));
    expect(await reservationState(id)).toMatchObject({ credits_debited_at: null, credits_debit_failed_at: null, credits_debit_attempts: 1, credits_debit_error: 'transport' });

    // Not yet past the grace: the settling call may still be in flight.
    expect((await listUndebitedPlatformSettlements()).map((r) => r.reservationId)).not.toContain(id);
    await backdateDebit(id);
    deductResponses.push(async () => new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Idempotent-Replayed': 'true' } }));
    await settleAndDebitAiReservations();

    const calls = callsFor(id);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
    expect((await reservationState(id)).credits_debited_at).not.toBeNull();

    await settleAndDebitAiReservations();
    expect(callsFor(id)).toHaveLength(2);
  });

  it('a 5xx (deduct_unconfirmed) is retried, not stamped failed', async () => {
    deductResponses.push(async () => new Response(JSON.stringify({ error: 'deduct_unconfirmed' }), { status: 503 }));
    const id = await reserve(s, binding);
    await settleInvocation(settleInput(s, binding, id));
    expect(await reservationState(id)).toMatchObject({ credits_debit_failed_at: null, credits_debit_error: 'http_503:deduct_unconfirmed' });
    await backdateDebit(id);
    await settleAndDebitAiReservations();
    expect(callsFor(id)).toHaveLength(2);
    expect((await reservationState(id)).credits_debited_at).not.toBeNull();
  });

  it('a 4xx is terminal: stamped failed with a short code, never retried, listed for an operator, re-drivable', async () => {
    deductResponses.push(async () => new Response(
      JSON.stringify({ error: 'idempotency_key_reused', message: 'Idempotency key was already used with a different costCents' }),
      { status: 409 },
    ));
    const id = await reserve(s, binding);
    await settleInvocation(settleInput(s, binding, id));
    const state = await reservationState(id);
    expect(state.credits_debit_failed_at).not.toBeNull();
    expect(state.credits_debit_error).toBe('http_409:idempotency_key_reused');
    expect(state.credits_debited_at).toBeNull();

    await backdateDebit(id);
    expect((await listUndebitedPlatformSettlements()).map((r) => r.reservationId)).not.toContain(id);
    await settleAndDebitAiReservations();
    expect(callsFor(id)).toHaveLength(1);
    expect((await listFailedCreditDebits()).map((r) => r.reservationId)).toContain(id);

    expect(await clearCreditDebitFailure(id)).toBe(true);
    await settleAndDebitAiReservations();
    expect(callsFor(id)).toHaveLength(2);
    expect((await reservationState(id)).credits_debited_at).not.toBeNull();
    expect((await listFailedCreditDebits()).map((r) => r.reservationId)).not.toContain(id);
  });

  it('lock contention twice → rows persisted pending, not lost; the sweep replays ledger + rollups exactly once and debits once', async () => {
    const id = await reserve(s, binding);
    const snapshot: SdkUsageSnapshot = { version: 1, models: { [binding.wireModel]: { tokens: T, webSearchRequests: 0 } } };
    const blocker = await holdOrganizationLock(s.orgId);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const out = await settleInvocation(settleInput(s, binding, id, {
        sdkUsage: { sessionId: s.chatSessionId, nextSnapshot: snapshot, usageConfirmed: true, usageNote: 'first_result' },
      }));
      expect(out.deferred).toBe(true);
    } finally {
      await blocker.release();
      error.mockRestore();
    }
    const pending = await reservationState(id);
    expect(pending.pending_settlement).not.toBeNull();
    expect(pending.status).not.toBe('settled');
    expect(callsFor(id)).toHaveLength(0);
    expect(await q(sql`SELECT 1 FROM ai_invocations WHERE session_id = ${s.chatSessionId}::uuid`)).toHaveLength(0);
    // The next turn must bill against the pending turn's snapshot, not the stale stored one.
    expect(await readSdkUsageSnapshot({ orgId: s.orgId, sessionId: s.chatSessionId })).toEqual(snapshot);

    const first = await settleAndDebitAiReservations();
    const second = await settleAndDebitAiReservations();
    expect(first.replayed).toBe(1);
    expect(second.replayed).toBe(0);
    expect(await q(sql`SELECT 1 FROM ai_invocations WHERE session_id = ${s.chatSessionId}::uuid`)).toHaveLength(1);
    const [session] = await q<{ c: string; snap: unknown }>(sql`
      SELECT total_cost_cents AS c, sdk_usage_snapshot AS snap FROM ai_sessions WHERE id = ${s.chatSessionId}::uuid`);
    expect(Number(session!.c)).toBeCloseTo(priceInvocation(binding.rateSnapshot, T, {}), 6);
    expect(session!.snap).toEqual(snapshot);
    const settled = await reservationState(id);
    expect(settled).toMatchObject({ status: 'settled', pending_settlement: null });
    expect(settled.credits_debited_at).not.toBeNull();
    expect(callsFor(id)).toHaveLength(1);
    expect(await replayPendingAiSettlements()).toEqual([]);
  }, 30_000);

  it('partner-funded spend never reaches the billing service', async () => {
    const b = await seedRegistryPartner('byok');
    const byokBinding = await bindingFor(b);
    expect(byokBinding.funding).toBe('partner_key');
    const id = await reserve(b, byokBinding);
    await settleInvocation(settleInput(b, byokBinding, id));
    await settleAndDebitAiReservations();
    expect(deductCalls).toHaveLength(0);
    expect(await reservationState(id)).toMatchObject({ status: 'settled', credits_debit_due_at: null });
  });
});
