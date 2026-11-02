/**
 * AI model registry W03 (#7601) Task 6: the single billing path against real
 * Postgres. ai_invocations is the source of truth for every rollup; the turn
 * binding lands with the reservation or not at all; money moves exactly once.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';

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
import { aiAgentRuns, aiAgents } from '../../db/schema';
import { settleComputeCents } from '../../services/aiCostTracker';
import {
  listFailedPlatformCreditDebits,
  listUndeliveredCreditDebits,
  redriveFailedCreditDebit,
  replayDeadPendingSettlement,
  requeueFailedCreditDebits,
} from '../../services/aiCreditDebits';
import {
  AiBudgetPendingSettlementError,
  clearCreditDebitFailure,
  listFailedCreditDebits,
  listDeadPendingSettlements,
  listUndebitedPlatformSettlements,
  MAX_PENDING_SETTLEMENT_REPLAY_ATTEMPTS,
  attestUnboundRate,
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
import { quoteInvocationCents, settleInvocation, type SettleInvocationInput } from '../../services/aiModels/settleInvocation';
import { deleteAnthropicConnection } from '../../services/aiModels/anthropicConnectionWrites';
import { turnBindingFrom, type TurnBinding } from '../../services/aiModels/turnBinding';
import { closeRegistryFixtures, fixtureSql, seedOffering } from './aiModelRegistryFixtures';
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
  servedModel: model, providerModel: null, sdkReportedCostUsd: sdk, fastDowngraded: false,
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

    const [ledger] = await q<{ cost_cents: string; sdk_reported_cost_usd: string; ledger_mode: string; prompt_profile: string | null; prompt_variant: string | null; occurred_at: unknown }>(sql`
      SELECT cost_cents, sdk_reported_cost_usd, ledger_mode, prompt_profile, prompt_variant, occurred_at FROM ai_invocations WHERE id = ${out.invocationIds[0]}::uuid`);
    expect(Number(ledger!.cost_cents)).toBeCloseTo(expected, 6);
    expect(Number(ledger!.sdk_reported_cost_usd)).toBe(99.99);
    expect(ledger!.ledger_mode).toBe('authoritative');
    // W11: a settlement with no live-query provenance records the binding's profile, no variant, and its turn time.
    expect(binding.promptProfile).toBeDefined();
    expect(ledger).toMatchObject({ prompt_profile: binding.promptProfile, prompt_variant: null });
    expect(ledger!.occurred_at).not.toBeNull();

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

  it('#10413: the CLI background call settles as model_role background, fallback_used false, at its own platform rate', async () => {
    const bg = (await getPlatformModelById(await seedPricedPlatformModel()))!;
    const id = await reserve(s, binding);
    const BGT = { input: 900, output: 15, cacheRead: 0, cacheWrite: 0 };
    const out = await settleInvocation(settleInput(s, binding, id, {
      usage: [
        { model: binding.wireModel, tokens: T, webSearchRequests: 0, speedServed: 'standard', providerModel: null },
        { model: bg.modelId, tokens: BGT, webSearchRequests: 0, speedServed: 'standard', providerModel: null },
      ],
    }));
    const expected = priceInvocation(binding.rateSnapshot, T, {}) + priceInvocation({ source: 'platform', standard: bg.rates! }, BGT, {});
    expect(out.costCents).toBeCloseTo(expected, 6);
    const rows = await q<{ requested_model: string; model_role: string | null; fallback_used: boolean; cost_cents: string }>(sql`
      SELECT requested_model, model_role, fallback_used, cost_cents FROM ai_invocations
      WHERE org_id = ${s.orgId}::uuid ORDER BY (requested_model = ${binding.wireModel}) DESC`);
    expect(rows.map((r) => [r.requested_model, r.model_role, r.fallback_used])).toEqual([
      [binding.wireModel, 'primary', false],
      [bg.modelId, 'background', false],
    ]);
    expect(rows.reduce((sum, r) => sum + Number(r.cost_cents), 0)).toBeCloseTo(expected, 6);
    expect(await reservationState(id)).toMatchObject({ status: 'settled' });
  });

  it('#10413: ai_invocations_model_role_chk ties model_role fallback to fallback_used', async () => {
    // Resolves to the violated constraint's name (drizzle wraps the pg error in `cause`), or null when the row inserted.
    const insert = (role: string, fallbackUsed: boolean) => q(sql`
      INSERT INTO ai_invocations (org_id, surface, funding_source, requested_model, served_model, ledger_mode, model_role, fallback_used)
      VALUES (${s.orgId}::uuid, 'chat', 'platform', 'm', 'm', 'shadow', ${role}, ${fallbackUsed})`)
      .then(() => null, (e: { cause?: { constraint_name?: string } }) => e.cause?.constraint_name ?? 'unexpected error');
    expect(await insert('background', true)).toBe('ai_invocations_model_role_chk');
    expect(await insert('fallback', false)).toBe('ai_invocations_model_role_chk');
    expect(await insert('helper', false)).toBe('ai_invocations_model_role_chk');
    expect(await insert('fallback', true)).toBeNull();
    expect(await insert('background', false)).toBeNull();
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

  it('a deferred re-baseline replayed after a newer turn settled does not move the snapshot back under it (review S10)', async () => {
    const snap = (input: number, output: number): SdkUsageSnapshot => ({
      version: 1, models: { [binding.wireModel]: { tokens: { input, output, cacheRead: 0, cacheWrite: 0 }, webSearchRequests: 0 } },
    });
    const own = (input: number, output: number) => [{ model: binding.wireModel, tokens: { input, output, cacheRead: 0, cacheWrite: 0 }, webSearchRequests: 0, speedServed: 'standard' as const, providerModel: null }];
    const high = snap(1_000_000, 500_000);
    await settleInvocation(settleInput(s, binding, await reserve(s, binding), {
      sdkUsage: { sessionId: s.chatSessionId, nextSnapshot: high, usageConfirmed: true, usageNote: 'first_result' },
    }));

    // Turn 1: the CLI's counters restarted (regressed) and its settlement is deferred by lock contention.
    const t1 = await reserve(s, binding);
    const base1 = await readSdkUsageSnapshot({ orgId: s.orgId, sessionId: s.chatSessionId });
    expect(base1).toEqual(high);
    const blocker = await holdOrganizationLock(s.orgId);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const out = await settleInvocation(settleInput(s, binding, t1, {
        usage: own(10, 5),
        sdkUsage: { sessionId: s.chatSessionId, nextSnapshot: snap(10, 5), baseSnapshot: base1, usageConfirmed: false, usageNote: 'snapshot_regressed' },
      }));
      expect(out).toMatchObject({ deferred: true });
      expect(out.unrecorded).toBeFalsy();
    } finally {
      await blocker.release();
      error.mockRestore();
    }

    // Turn 2 does not bill against turn 1's pending re-baseline; it regresses against
    // the stored snapshot itself and settles NOW, moving the snapshot to its reading.
    const base2 = await readSdkUsageSnapshot({ orgId: s.orgId, sessionId: s.chatSessionId });
    expect(base2).toEqual(high);
    await settleInvocation(settleInput(s, binding, await reserve(s, binding), {
      usage: own(30, 15),
      sdkUsage: { sessionId: s.chatSessionId, nextSnapshot: snap(40, 20), baseSnapshot: base2, usageConfirmed: false, usageNote: 'snapshot_regressed' },
    }));
    expect(await readSdkUsageSnapshot({ orgId: s.orgId, sessionId: s.chatSessionId })).toEqual(snap(40, 20));

    // The late replay of turn 1 settles its ledger row but leaves turn 2's snapshot alone:
    // writing snap(10, 5) back would bill turn 2's 30/15 tokens again on turn 3.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const replayed = await replayPendingAiSettlements();
    warn.mockRestore();
    expect(replayed.filter((r) => r.reservationId === t1)).toMatchObject([{ kind: 'settled' }]);
    expect(await reservationState(t1)).toMatchObject({ status: 'settled', pending_settlement: null });
    expect(await readSdkUsageSnapshot({ orgId: s.orgId, sessionId: s.chatSessionId })).toEqual(snap(40, 20));
    expect(await q(sql`SELECT 1 FROM ai_invocations WHERE session_id = ${s.chatSessionId}::uuid`)).toHaveLength(3);
  }, 30_000);

  it('W11: a deferred settlement replays its prompt provenance and its turn time, not the replay time', async () => {
    const small: TurnBinding = { ...binding, promptProfile: 'claude-small' };
    const id = await reserve(s, small);
    const at = new Date('2026-09-15T12:00:00.000Z');
    const blocker = await holdOrganizationLock(s.orgId);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const out = await settleInvocation(settleInput(s, small, id, {
        prompt: { profile: 'claude-small', variant: 'chat/claude-small@1' }, occurredAt: at,
      }));
      expect(out).toMatchObject({ deferred: true });
      expect(out.unrecorded).toBeFalsy();
    } finally {
      await blocker.release();
      error.mockRestore();
    }
    expect(await q(sql`SELECT 1 FROM ai_invocations WHERE session_id = ${s.chatSessionId}::uuid`)).toHaveLength(0);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const replayed = await replayPendingAiSettlements();
    warn.mockRestore();
    expect(replayed.filter((r) => r.reservationId === id)).toMatchObject([{ kind: 'settled' }]);
    const rows = await q<{ prompt_profile: string | null; prompt_variant: string | null; occurred_at: string | Date; created_at: string | Date }>(sql`
      SELECT prompt_profile, prompt_variant, occurred_at, created_at FROM ai_invocations WHERE session_id = ${s.chatSessionId}::uuid`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ prompt_profile: 'claude-small', prompt_variant: 'chat/claude-small@1' });
    expect(new Date(rows[0]!.occurred_at).toISOString()).toBe(at.toISOString());
    expect(new Date(rows[0]!.created_at).getTime()).toBeGreaterThan(at.getTime());
  }, 30_000);

  it('two deferred re-baselines on one session: the NEWEST wins on replay, so the next turn bills only its own delta (re-review)', async () => {
    const snap = (input: number, output: number): SdkUsageSnapshot => ({
      version: 1, models: { [binding.wireModel]: { tokens: { input, output, cacheRead: 0, cacheWrite: 0 }, webSearchRequests: 0 } },
    });
    const own = (input: number, output: number) => [{ model: binding.wireModel, tokens: { input, output, cacheRead: 0, cacheWrite: 0 }, webSearchRequests: 0, speedServed: 'standard' as const, providerModel: null }];
    const high = snap(1_000_000, 500_000);
    await settleInvocation(settleInput(s, binding, await reserve(s, binding), {
      sdkUsage: { sessionId: s.chatSessionId, nextSnapshot: high, usageConfirmed: true, usageNote: 'first_result' },
    }));

    // Turns 1 and 2 both regress against the stored snapshot (the counters restarted)
    // and both settlements are deferred by lock contention.
    const t1 = await reserve(s, binding);
    const t2 = await reserve(s, binding);
    const blocker = await holdOrganizationLock(s.orgId);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const base1 = await readSdkUsageSnapshot({ orgId: s.orgId, sessionId: s.chatSessionId });
      expect(await settleInvocation(settleInput(s, binding, t1, {
        usage: own(10, 5),
        sdkUsage: { sessionId: s.chatSessionId, nextSnapshot: snap(10, 5), baseSnapshot: base1, usageConfirmed: false, usageNote: 'snapshot_regressed' },
      }))).toMatchObject({ deferred: true });
      const base2 = await readSdkUsageSnapshot({ orgId: s.orgId, sessionId: s.chatSessionId });
      expect(base2).toEqual(high);
      expect(await settleInvocation(settleInput(s, binding, t2, {
        usage: own(30, 15),
        sdkUsage: { sessionId: s.chatSessionId, nextSnapshot: snap(40, 20), baseSnapshot: base2, usageConfirmed: false, usageNote: 'snapshot_regressed' },
      }))).toMatchObject({ deferred: true });
    } finally {
      await blocker.release();
      error.mockRestore();
    }

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await replayPendingAiSettlements();
    warn.mockRestore();
    expect(await reservationState(t1)).toMatchObject({ status: 'settled' });
    expect(await reservationState(t2)).toMatchObject({ status: 'settled' });
    // Turn 2's reading is the truth. Leaving turn 1's snap(10, 5) here would make turn 3
    // bill turn 2's 30/15 tokens a second time.
    expect(await readSdkUsageSnapshot({ orgId: s.orgId, sessionId: s.chatSessionId })).toEqual(snap(40, 20));
  }, 30_000);

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

describe.skipIf(!RUN)('pending settlement replay has no head-of-line (#7700 review finding 5)', () => {
  /** A pending settlement that can never replay (it names another reservation), backdated to sort first. */
  async function poisoned(s: SeededRegistryPartner, binding: TurnBinding, day: string, sdkSnapshot?: SdkUsageSnapshot): Promise<string> {
    const id = await reserve(s, binding, { session: false });
    const pending = {
      reservationId: randomUUID(), orgId: s.orgId, actualCostCents: 1, inputTokens: 1, outputTokens: 1,
      ...(sdkSnapshot ? { sdkUsage: { sessionId: s.chatSessionId, nextSnapshot: sdkSnapshot } } : {}),
    };
    await fixtureSql`UPDATE ai_budget_reservations SET pending_settlement = ${fixtureSql.json(pending)},
                     updated_at = ${day}::timestamptz WHERE id = ${id}`;
    return id;
  }
  const attemptsOf = async (id: string) => (await q<{ a: number; dead: string | null; err: string | null }>(sql`
    SELECT pending_settlement_attempts AS a, pending_settlement_dead_at AS dead, pending_settlement_error AS err
      FROM ai_budget_reservations WHERE id = ${id}::uuid`))[0]!;

  it('a failing replay moves to the back of the queue, so it cannot starve the rows behind it', async () => {
    const s = await seedRegistryPartner('platform');
    const binding = await bindingFor(s, 'ai_agents');
    const a = await poisoned(s, binding, '2000-01-01');
    const b = await poisoned(s, binding, '2000-01-02');
    await replayPendingAiSettlements(1);
    expect(await attemptsOf(a)).toMatchObject({ a: 1, dead: null });
    await replayPendingAiSettlements(1);
    // Before the fix the same (oldest, still failing) row was picked again forever.
    expect(await attemptsOf(b)).toMatchObject({ a: 1, dead: null });
    expect(await attemptsOf(a)).toMatchObject({ a: 1 });
    expect((await attemptsOf(a)).err).toMatch(/does not belong/);
  });

  it('after N failures the row is stamped dead: excluded from replay and from the SDK snapshot merge, listed for an operator', async () => {
    const s = await seedRegistryPartner('platform');
    const binding = await bindingFor(s, 'ai_agents');
    const snapshot: SdkUsageSnapshot = { version: 1, models: { [binding.wireModel]: { tokens: T, webSearchRequests: 0 } } };
    const a = await poisoned(s, binding, '2000-01-01', snapshot);
    expect(await readSdkUsageSnapshot({ orgId: s.orgId, sessionId: s.chatSessionId })).toEqual(snapshot);
    await fixtureSql`UPDATE ai_budget_reservations SET pending_settlement_attempts = ${MAX_PENDING_SETTLEMENT_REPLAY_ATTEMPTS - 1},
                     updated_at = '2000-01-01' WHERE id = ${a}`;
    await replayPendingAiSettlements(1);
    const dead = await attemptsOf(a);
    expect(dead.a).toBe(MAX_PENDING_SETTLEMENT_REPLAY_ATTEMPTS);
    expect(dead.dead).not.toBeNull();
    // Excluded from replay: another run does not touch it, even as the oldest row.
    await fixtureSql`UPDATE ai_budget_reservations SET updated_at = '2000-01-01' WHERE id = ${a}`;
    await replayPendingAiSettlements(1);
    expect((await attemptsOf(a)).a).toBe(MAX_PENDING_SETTLEMENT_REPLAY_ATTEMPTS);
    // A dead settlement is not billed, so the next turn must not bill against its snapshot either.
    expect(await readSdkUsageSnapshot({ orgId: s.orgId, sessionId: s.chatSessionId })).toBeNull();
    expect((await listDeadPendingSettlements(500)).find((r) => r.reservationId === a))
      .toMatchObject({ orgId: s.orgId, attempts: MAX_PENDING_SETTLEMENT_REPLAY_ATTEMPTS });
  });
});

describe.skipIf(!RUN)('disconnect while a BYOK turn is in flight (#7700 review finding 1)', () => {
  it('the turn still settles (ledger row + rollup) on its soft-disconnected offering, and the key material is gone', async () => {
    const s = await seedRegistryPartner('byok');
    const binding = await bindingFor(s);
    expect(binding.funding).toBe('partner_key');
    const id = await reserve(s, binding);   // reserved + dispatched

    expect(await deleteAnthropicConnection({ partnerId: s.partnerId, connectionId: s.connectionId! })).toBe(true);

    const out = await settleInvocation(settleInput(s, binding, id));
    expect(out.deferred).toBe(false);
    expect(out.invocationIds).toHaveLength(1);
    const [ledger] = await q<{ offering_id: string; connection_id: string; funding_source: string }>(sql`
      SELECT offering_id, connection_id, funding_source FROM ai_invocations WHERE id = ${out.invocationIds[0]}::uuid`);
    expect(ledger).toEqual({ offering_id: s.offeringId, connection_id: s.connectionId, funding_source: 'partner_key' });
    const [usage] = await q<{ c: string }>(sql`
      SELECT total_cost_cents AS c FROM ai_cost_usage WHERE org_id = ${s.orgId}::uuid AND period = 'daily'`);
    expect(Number(usage!.c)).toBeCloseTo(out.costCents, 6);

    // Revocation still removes the secret; the row stays only as provenance.
    const [conn] = await q<{ status: string; api_key_encrypted: string | null; key_fingerprint: string | null; key_last4: string | null; config_version: number }>(sql`
      SELECT status, api_key_encrypted, key_fingerprint, key_last4, config_version FROM partner_ai_connections WHERE id = ${s.connectionId}::uuid`);
    expect(conn).toEqual({ status: 'disconnected', api_key_encrypted: null, key_fingerprint: null, key_last4: null, config_version: 2 });
    const [off] = await q<{ enabled: boolean }>(sql`SELECT enabled FROM partner_ai_models WHERE id = ${s.offeringId}::uuid`);
    expect(off!.enabled).toBe(false);
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

  it('two CONCURRENT sweeps over one undebited reservation send only the identical key + amount and stamp it once (review T3)', async () => {
    deductResponses.push(async () => { throw new TypeError('fetch failed'); });
    const id = await reserve(s, binding);
    await settleInvocation(settleInput(s, binding, id));
    expect(await reservationState(id)).toMatchObject({ credits_debited_at: null, credits_debit_attempts: 1 });
    await backdateDebit(id);

    await Promise.all([settleAndDebitAiReservations(), settleAndDebitAiReservations()]);

    const calls = callsFor(id);
    const amount = Number((await reservationState(id)).actual_cost_cents);
    // The original (lost) call plus one per sweep that saw the row: never a
    // different key or amount, so the billing service's idempotency makes it one charge.
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.length).toBeLessThanOrEqual(3);
    for (const call of calls) expect(call).toEqual({ key: `ai-settlement:${id}`, headerKey: `ai-settlement:${id}`, costCents: amount });
    const stamped = await q<{ at: string | null }>(sql`SELECT credits_debited_at::text AS at FROM ai_budget_reservations WHERE id = ${id}::uuid`);
    expect(stamped[0]!.at).not.toBeNull();

    // Exactly one stamp: a later sweep neither re-sends nor re-stamps.
    await settleAndDebitAiReservations();
    expect(callsFor(id)).toHaveLength(calls.length);
    const restamped = await q<{ at: string | null }>(sql`SELECT credits_debited_at::text AS at FROM ai_budget_reservations WHERE id = ${id}::uuid`);
    expect(restamped[0]!.at).toBe(stamped[0]!.at);
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

describe.skipIf(!RUN)('an unbound BYOK refusal-fallback key at its own offering rate (#7773)', () => {
  const OWN = { inputCentsPerM: 300, outputCentsPerM: 1500, cacheReadCentsPerM: 30, cacheWriteCentsPerM: 375 };
  const swapped = (model: string): TurnOutcome => ({ ...OK(model, 1.23), fallbackUsed: true });

  async function priceOffering(offeringId: string): Promise<void> {
    await fixtureSql`
      UPDATE partner_ai_models SET price_input_cents_per_m = 300, price_output_cents_per_m = 1500,
             price_cache_read_cents_per_m = 30, price_cache_write_cents_per_m = 375
       WHERE id = ${offeringId}`;
  }

  async function settleUnbound(b: SeededRegistryPartner, binding: TurnBinding, model: string) {
    const id = await reserve(b, binding);
    const out = await settleInvocation(settleInput(b, binding, id, {
      usage: [{ model, tokens: T, webSearchRequests: 0, speedServed: 'standard', providerModel: null }],
      outcome: swapped(model),
    }));
    expect(out.deferred).toBe(false);
    expect(out.invocationIds).toHaveLength(1);
    const [row] = await q<{ requested_model: string; fallback_used: boolean; rate_snapshot: unknown; cost_cents: string; funding_source: string }>(sql`
      SELECT requested_model, fallback_used, rate_snapshot, cost_cents, funding_source
      FROM ai_invocations WHERE id = ${out.invocationIds[0]}::uuid`);
    return { out, row: row!, state: await reservationState(id) };
  }

  it('prices it at the own price of that model\'s enabled offering on the SAME connection, re-verified in the settlement transaction', async () => {
    const b = await seedRegistryPartner('byok');
    const binding = await bindingFor(b);
    const fbModel = `w7773-fb-${randomUUID()}`;
    await priceOffering(await seedOffering({ partnerId: b.partnerId, connectionId: b.connectionId, modelId: fbModel, source: 'manual', enabled: true }));

    const { out, row, state } = await settleUnbound(b, binding, fbModel);
    const expected = priceInvocation({ source: 'offering', standard: OWN }, T, {});
    expect(row).toMatchObject({ requested_model: fbModel, fallback_used: true, funding_source: 'partner_key' });
    expect(row.rate_snapshot).toEqual({ source: 'offering', standard: OWN });
    expect(Number(row.cost_cents)).toBeCloseTo(expected, 6);
    expect(out.costCents).toBeCloseTo(expected, 6);
    expect(Number(state.actual_cost_cents)).toBeCloseTo(expected, 6);
    expect(state.credits_debit_due_at).toBeNull();
  });

  it('an unpriced offering linked to a platform row takes the linked row\'s rate', async () => {
    const b = await seedRegistryPartner('byok');
    const binding = await bindingFor(b);
    const fbModel = `w7773-linked-${randomUUID()}`;
    const linkedId = await seedPricedPlatformModel(fbModel);
    await fixtureSql`
      UPDATE ai_platform_models SET input_cents_per_m = 300, output_cents_per_m = 1500,
             cache_read_cents_per_m = 30, cache_write_cents_per_m = 375
       WHERE id = ${linkedId}`;
    await seedOffering({ partnerId: b.partnerId, connectionId: b.connectionId, platformModelId: linkedId, modelId: fbModel, source: 'discovered', enabled: true });

    const { row } = await settleUnbound(b, binding, fbModel);
    expect(row.rate_snapshot).toEqual({ source: 'linked_platform', standard: OWN });
    expect(Number(row.cost_cents)).toBeCloseTo(priceInvocation({ source: 'linked_platform', standard: OWN }, T, {}), 6);
  });

  it('no enabled offering for that model on the connection (a disabled one; one on another partner\'s connection) keeps the bound rate', async () => {
    const b = await seedRegistryPartner('byok');
    const binding = await bindingFor(b);
    const other = await seedRegistryPartner('byok');
    const fbModel = `w7773-none-${randomUUID()}`;
    await priceOffering(await seedOffering({ partnerId: b.partnerId, connectionId: b.connectionId, modelId: fbModel, source: 'manual', enabled: false }));
    await priceOffering(await seedOffering({ partnerId: other.partnerId, connectionId: other.connectionId, modelId: fbModel, source: 'manual', enabled: true }));

    const { row } = await settleUnbound(b, binding, fbModel);
    expect(row).toMatchObject({ requested_model: fbModel, fallback_used: true });
    expect(row.rate_snapshot).toEqual(binding.rateSnapshot);
    expect(Number(row.cost_cents)).toBeCloseTo(priceInvocation(binding.rateSnapshot, T, {}), 6);
  });

  // Round 2: a settlement deferred by org-lock contention replays later. A
  // partner that reprices, disables or deletes the fallback offering in the
  // meantime must not dead-letter it: it settles at the rate the turn ran at,
  // verified in-tx against the attestation the turn wrote on its reservation.
  it.each([
    ['repriced', (id: string) => fixtureSql`UPDATE partner_ai_models SET price_input_cents_per_m = 999 WHERE id = ${id}`],
    ['disabled', (id: string) => fixtureSql`UPDATE partner_ai_models SET enabled = false WHERE id = ${id}`],
    ['deleted', (id: string) => fixtureSql`DELETE FROM partner_ai_models WHERE id = ${id}`],
  ] as const)('a deferred settlement replays at the turn-time rate after the offering is %s, exactly once', async (_label, mutate) => {
    const b = await seedRegistryPartner('byok');
    const binding = await bindingFor(b);
    const fbModel = `w7773-replay-${randomUUID()}`;
    const offeringId = await seedOffering({ partnerId: b.partnerId, connectionId: b.connectionId, modelId: fbModel, source: 'manual', enabled: true });
    await priceOffering(offeringId);
    const id = await reserve(b, binding);

    const blocker = await holdOrganizationLock(b.orgId);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const out = await settleInvocation(settleInput(b, binding, id, {
        usage: [{ model: fbModel, tokens: T, webSearchRequests: 0, speedServed: 'standard', providerModel: null }],
        outcome: swapped(fbModel),
      }));
      expect(out).toMatchObject({ deferred: true });
      expect(out.unrecorded).toBeFalsy();
    } finally {
      await blocker.release();
      error.mockRestore();
    }
    await mutate(offeringId);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = await replayPendingAiSettlements();
    const second = await replayPendingAiSettlements();
    warn.mockRestore();
    expect(first.filter((r) => r.reservationId === id)).toMatchObject([{ kind: 'settled' }]);
    expect(second.filter((r) => r.reservationId === id)).toEqual([]);
    const expected = priceInvocation({ source: 'offering', standard: OWN }, T, {});
    expect(await reservationState(id)).toMatchObject({ status: 'settled', pending_settlement: null });
    expect(Number((await reservationState(id)).actual_cost_cents)).toBeCloseTo(expected, 6);
    const rows = await q<{ rate_snapshot: unknown; cost_cents: string }>(sql`
      SELECT rate_snapshot, cost_cents FROM ai_invocations WHERE org_id = ${b.orgId}::uuid AND requested_model = ${fbModel}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.rate_snapshot).toEqual({ source: 'offering', standard: OWN });
    expect(Number(rows[0]!.cost_cents)).toBeCloseTo(expected, 6);
  }, 30_000);

  const fbUsage = (model: string) => [{ model, tokens: T, webSearchRequests: 0, speedServed: 'standard' as const, providerModel: null }];
  async function attestationsOf(id: string): Promise<unknown> {
    const [row] = await q<{ unbound_rate_attestations: unknown }>(sql`
      SELECT unbound_rate_attestations FROM ai_budget_reservations WHERE id = ${id}::uuid`);
    return row!.unbound_rate_attestations;
  }

  it('a repeated settle of a settled turn reprices from its attestation after the offering is deleted: already_settled, one ledger row', async () => {
    const b = await seedRegistryPartner('byok');
    const binding = await bindingFor(b);
    const fbModel = `w7773-again-${randomUUID()}`;
    const offeringId = await seedOffering({ partnerId: b.partnerId, connectionId: b.connectionId, modelId: fbModel, source: 'manual', enabled: true });
    await priceOffering(offeringId);
    const id = await reserve(b, binding);
    const input = settleInput(b, binding, id, { usage: fbUsage(fbModel), outcome: swapped(fbModel) });
    const first = await settleInvocation(input);
    expect(first.invocationIds).toHaveLength(1);

    await fixtureSql`DELETE FROM partner_ai_models WHERE id = ${offeringId}`;
    const again = await settleInvocation(input);   // would bill the bound rate -> "Conflicting settlement" without the attestation
    expect(again).toMatchObject({ deferred: false, invocationIds: [] });
    expect(again.costCents).toBeCloseTo(first.costCents, 6);
    expect(await q(sql`SELECT 1 FROM ai_invocations WHERE org_id = ${b.orgId}::uuid AND requested_model = ${fbModel}`)).toHaveLength(1);
  });

  it('the quote attests the decision the settlement then bills, even after a reprice in between', async () => {
    const b = await seedRegistryPartner('byok');
    const binding = await bindingFor(b);
    const fbModel = `w7773-quote-${randomUUID()}`;
    const offeringId = await seedOffering({ partnerId: b.partnerId, connectionId: b.connectionId, modelId: fbModel, source: 'manual', enabled: true });
    await priceOffering(offeringId);
    const id = await reserve(b, binding);
    const quoted = await quoteInvocationCents(binding, fbUsage(fbModel), { orgId: b.orgId, reservationId: id });
    expect(quoted).toBeCloseTo(priceInvocation({ source: 'offering', standard: OWN }, T, {}), 6);
    expect(await attestationsOf(id)).toEqual({
      [`${b.connectionId}:${fbModel}`]: { connectionId: b.connectionId, offeringId, rate: { source: 'offering', standard: OWN } },
    });

    await fixtureSql`UPDATE partner_ai_models SET price_input_cents_per_m = 999 WHERE id = ${offeringId}`;
    const out = await settleInvocation(settleInput(b, binding, id, { usage: fbUsage(fbModel), outcome: swapped(fbModel) }));
    expect(out.costCents).toBeCloseTo(quoted, 6);
    expect(Number((await reservationState(id)).actual_cost_cents)).toBeCloseTo(quoted, 6);
  });

  it('a miss is attested too: an offering enabled after the quote does not change what the turn bills', async () => {
    const b = await seedRegistryPartner('byok');
    const binding = await bindingFor(b);
    const fbModel = `w7773-miss-${randomUUID()}`;
    const offeringId = await seedOffering({ partnerId: b.partnerId, connectionId: b.connectionId, modelId: fbModel, source: 'manual', enabled: false });
    await priceOffering(offeringId);
    const id = await reserve(b, binding);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const quoted = await quoteInvocationCents(binding, fbUsage(fbModel), { orgId: b.orgId, reservationId: id });
      expect(quoted).toBeCloseTo(priceInvocation(binding.rateSnapshot, T, {}), 6);
      await fixtureSql`UPDATE partner_ai_models SET enabled = true WHERE id = ${offeringId}`;
      const out = await settleInvocation(settleInput(b, binding, id, { usage: fbUsage(fbModel), outcome: swapped(fbModel) }));
      expect(out.costCents).toBeCloseTo(quoted, 6);
    } finally {
      warn.mockRestore();
    }
    const [row] = await q<{ rate_snapshot: unknown }>(sql`
      SELECT rate_snapshot FROM ai_invocations WHERE org_id = ${b.orgId}::uuid AND requested_model = ${fbModel}`);
    expect(row!.rate_snapshot).toEqual(binding.rateSnapshot);
  });

  it('attestUnboundRate on real Postgres: first write wins, and a settled reservation takes no new entry', async () => {
    const b = await seedRegistryPartner('byok');
    const binding = await bindingFor(b);
    const model = `w7773-fww-${randomUUID()}`;
    const id = await reserve(b, binding);
    const at = (input: number) => ({ connectionId: b.connectionId!, offeringId: null, rate: { source: 'offering' as const, standard: { ...OWN, inputCentsPerM: input } } });
    const attest = (input: number, reservationId = id, m = model) => withSystemDbAccessContext(
      () => attestUnboundRate({ orgId: b.orgId, reservationId, model: m, attestation: at(input) }), 'test.attest');

    expect(await attest(111)).toEqual(at(111));
    expect(await attest(222)).toEqual(at(111));   // the second writer gets the stored entry back
    expect(await attestationsOf(id)).toEqual({ [`${b.connectionId}:${model}`]: at(111) });

    await settleInvocation(settleInput(b, binding, id));   // the bound turn settles the reservation
    expect((await reservationState(id)).status).toBe('settled');
    const other = `w7773-late-${randomUUID()}`;
    expect(await attest(333, id, other)).toBeNull();
    expect(await attestationsOf(id)).toEqual({ [`${b.connectionId}:${model}`]: at(111) });
  });

  it('a stable-key retry that rebinds the reservation clears the old attempt\'s attestations', async () => {
    const b = await seedRegistryPartner('byok');
    const binding = await bindingFor(b);
    const fbModel = `w7773-rebind-${randomUUID()}`;
    await priceOffering(await seedOffering({ partnerId: b.partnerId, connectionId: b.connectionId, modelId: fbModel, source: 'manual', enabled: true }));
    const key = `t:${randomUUID()}`;
    const id = await reserve(b, binding, { key });
    await quoteInvocationCents(binding, fbUsage(fbModel), { orgId: b.orgId, reservationId: id });
    expect(await attestationsOf(id)).not.toBeNull();

    const rebound: TurnBinding = { ...binding, rateSnapshot: { ...binding.rateSnapshot, standard: { ...binding.rateSnapshot.standard, inputCentsPerM: binding.rateSnapshot.standard.inputCentsPerM + 1 } } };
    expect(await reserve(b, rebound, { key })).toBe(id);
    expect(await attestationsOf(id)).toBeNull();
  });

  it('an enabled, priced offering of that model on ANOTHER connection of the same partner is never used', async () => {
    const b = await seedRegistryPartner('byok');
    const binding = await bindingFor(b);
    const fbModel = `w7773-otherconn-${randomUUID()}`;
    // The partner's other connection is a gateway one.
    const [second] = await fixtureSql`
      INSERT INTO partner_ai_connections (partner_id, kind, name, base_url, status)
      VALUES (${b.partnerId}, 'openai_compatible', 'W7773 second', 'https://llm.example.test/v1', 'active')
      RETURNING id`;
    await priceOffering(await seedOffering({ partnerId: b.partnerId, connectionId: String(second!.id), modelId: fbModel, source: 'manual', enabled: true }));

    const { row } = await settleUnbound(b, binding, fbModel);
    expect(row.rate_snapshot).toEqual(binding.rateSnapshot);
    expect(Number(row.cost_cents)).toBeCloseTo(priceInvocation(binding.rateSnapshot, T, {}), 6);
  });
});

// ---------------------------------------------------------------------------
// #9451 + #7717: compute and unreserved token debits are keyed and durable, and
// an operator can re-drive anything that failed terminally — always under the
// ORIGINAL key and amount, so the billing service's dedupe makes a re-drive
// unable to double-charge.
// ---------------------------------------------------------------------------

async function seedAgentRun(s: SeededRegistryPartner, reservedCents = 25): Promise<string> {
  return sys(async () => {
    // One agent per (org, kind): reuse it for a second run in the same org.
    const [agent] = (await db.select({ id: aiAgents.id }).from(aiAgents)
      .where(and(eq(aiAgents.orgId, s.orgId), eq(aiAgents.kind, 'triage'))).limit(1))
      .concat(await db.insert(aiAgents).values({
        orgId: s.orgId, partnerId: null, kind: 'triage', name: 'Compute debit fixture', createdBy: s.userId,
      }).onConflictDoNothing().returning({ id: aiAgents.id }));
    const [run] = await db.insert(aiAgentRuns).values({
      agentId: agent!.id, orgId: s.orgId, triggerKind: 'manual', dedupeKey: `compute-${randomUUID()}`,
      modeAtStart: 'shadow', policySnapshot: { schemaVersion: 1 } as never, computeReservedCents: reservedCents,
    }).returning({ id: aiAgentRuns.id });
    return run!.id as string;
  });
}

function computeCallsFor(runId: string): DeductCall[] {
  return deductCalls.filter((c) => c.key?.startsWith(`ai-compute:${runId}:`));
}

async function creditDebitRow(key: string) {
  const [row] = await q<{
    id: string; source: string; source_id: string; cost_cents: string; debited_at: string | null;
    failed_at: string | null; error: string | null; attempts: number;
  }>(sql`SELECT id, source, source_id, cost_cents, debited_at, failed_at, error, attempts
         FROM ai_credit_debits WHERE idempotency_key = ${key}`);
  return row;
}

async function backdateCreditDebit(key: string): Promise<void> {
  await fixtureSql`UPDATE ai_credit_debits SET created_at = now() - interval '10 minutes' WHERE idempotency_key = ${key}`;
}

async function computeRollup(orgId: string): Promise<number> {
  const [row] = await q<{ c: string | null }>(sql`
    SELECT compute_cents AS c FROM ai_cost_usage WHERE org_id = ${orgId}::uuid AND period = 'daily'`);
  return Number(row?.c ?? 0);
}

const billingStatus = (code: number, error?: string) => async () =>
  new Response(JSON.stringify(error ? { error } : { success: false }), { status: code });

describe.skipIf(!RUN)('compute and unreserved token debits are keyed and durable (#9451, #7717 item 2)', () => {
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

  it('compute debits once under ai-compute:<runId>:<attempt>; a second settle of the same attempt changes nothing', async () => {
    const runId = await seedAgentRun(s);
    await settleComputeCents(s.orgId, runId, 13, 'platform');
    const calls = computeCallsFor(runId);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.key).toMatch(new RegExp(`^ai-compute:${runId}:\\d+$`));
    expect(calls[0]).toEqual({ key: calls[0]!.key, headerKey: calls[0]!.key, costCents: 13 });
    const row = await creditDebitRow(calls[0]!.key!);
    expect(row).toMatchObject({ source: 'compute', source_id: runId, attempts: 0, failed_at: null });
    expect(row!.debited_at).not.toBeNull();

    // The reservation-release path (transitionRunStatus) settling the same
    // attempt again, at the reservation, must neither re-bill nor re-roll-up.
    await settleComputeCents(s.orgId, runId, 25, 'platform');
    expect(computeCallsFor(runId)).toHaveLength(1);
    const [run] = await q<{ compute_cents: number; compute_reserved_cents: number | null }>(sql`
      SELECT compute_cents, compute_reserved_cents FROM ai_agent_runs WHERE id = ${runId}::uuid`);
    expect(run).toEqual({ compute_cents: 13, compute_reserved_cents: null });
    expect(await computeRollup(s.orgId)).toBe(13);
  });

  it('partner_key compute is charged on the run and rollup once, and never debited', async () => {
    const runId = await seedAgentRun(s);
    await settleComputeCents(s.orgId, runId, 13, 'partner_key');
    await settleComputeCents(s.orgId, runId, 13, 'partner_key');
    expect(deductCalls).toHaveLength(0);
    expect(await q(sql`SELECT 1 FROM ai_credit_debits WHERE source_id = ${runId}::uuid`)).toHaveLength(0);
    expect(await computeRollup(s.orgId)).toBe(13);
  });

  it('a lost compute response is retried by the sweep under the SAME key and amount, then never again', async () => {
    deductResponses.push(async () => { throw new TypeError('fetch failed'); });
    const runId = await seedAgentRun(s);
    await settleComputeCents(s.orgId, runId, 13, 'platform');
    const key = computeCallsFor(runId)[0]!.key!;
    expect(await creditDebitRow(key)).toMatchObject({ debited_at: null, failed_at: null, attempts: 1, error: 'transport' });

    // Inside the grace the settling call may still be in flight: the sweep leaves it.
    expect((await listUndeliveredCreditDebits()).map((r) => r.idempotencyKey)).not.toContain(key);
    await backdateCreditDebit(key);
    await settleAndDebitAiReservations();
    const calls = computeCallsFor(runId);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
    expect((await creditDebitRow(key))!.debited_at).not.toBeNull();

    await settleAndDebitAiReservations();
    expect(computeCallsFor(runId)).toHaveLength(2);
  });

  it('inside a caller\'s open SYSTEM transaction that already updated the run (the reaper inside admission): no self-deadlock; the intent commits with the caller and the sweep sends it', async () => {
    const runId = await seedAgentRun(s);
    await sys(async () => {
      // What transitionRunStatus does first, uncommitted, in admission's transaction.
      await db.execute(sql`UPDATE ai_agent_runs SET status = 'failed' WHERE id = ${runId}::uuid`);
      await Promise.race([
        settleComputeCents(s.orgId, runId, 25, 'platform'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('settleComputeCents blocked on the caller\'s own row lock')), 10_000)),
      ]);
    });
    // Not sent inline (it was not committed yet); owed durably.
    expect(computeCallsFor(runId)).toHaveLength(0);
    const [row] = await q<{ key: string; debited_at: string | null }>(sql`
      SELECT idempotency_key AS key, debited_at FROM ai_credit_debits WHERE source_id = ${runId}::uuid`);
    expect(row).toMatchObject({ debited_at: null });
    await backdateCreditDebit(row!.key);
    await settleAndDebitAiReservations();
    expect(computeCallsFor(runId)).toEqual([{ key: row!.key, headerKey: row!.key, costCents: 25 }]);
  }, 30_000);

  it('a deployment with no billing service records no debit intent (nothing to owe, nothing to replay later) and cannot re-drive', async () => {
    delete process.env.BILLING_SERVICE_URL;
    delete process.env.BILLING_SERVICE_API_KEY;
    const runId = await seedAgentRun(s);
    await settleComputeCents(s.orgId, runId, 13, 'platform');
    const out = await settleInvocation(settleInput(s, binding, undefined));
    expect(await q(sql`SELECT 1 FROM ai_credit_debits WHERE org_id = ${s.orgId}::uuid`)).toHaveLength(0);
    expect(out.invocationIds).toHaveLength(1);
    expect(await computeRollup(s.orgId)).toBe(13);   // still charged on the run + rollup
    await expect(redriveFailedCreditDebit({ source: 'compute', id: randomUUID() })).rejects.toThrow(/billing service/);
    await expect(requeueFailedCreditDebits({ orgId: s.orgId, limit: 10 })).rejects.toThrow(/billing service/);
  });

  it('a reclaimed run is a new attempt: it debits under a NEW key', async () => {
    const runId = await seedAgentRun(s);
    await settleComputeCents(s.orgId, runId, 13, 'platform');
    // What the enqueue_failed reclaim does: re-stamp queued_at, reopen settlement.
    await fixtureSql`UPDATE ai_agent_runs SET queued_at = now() + interval '1 second', compute_settled_at = NULL,
                     compute_reserved_cents = 25 WHERE id = ${runId}`;
    await settleComputeCents(s.orgId, runId, 7, 'platform');
    const calls = computeCallsFor(runId);
    expect(calls.map((c) => c.costCents)).toEqual([13, 7]);
    expect(new Set(calls.map((c) => c.key)).size).toBe(2);
  });

  it('an unreserved platform token settlement writes its debit intent with the ledger rows; the sweep retries a 5xx under the same key', async () => {
    deductResponses.push(billingStatus(503, 'deduct_unconfirmed'));
    const out = await settleInvocation(settleInput(s, binding, undefined));
    expect(out.invocationIds).toHaveLength(1);
    const key = `ai-invocation:${out.invocationIds[0]}`;
    const row = await creditDebitRow(key);
    expect(row).toMatchObject({ source: 'invocation', source_id: out.invocationIds[0], attempts: 1, error: 'http_503:deduct_unconfirmed', failed_at: null });
    expect(Number(row!.cost_cents)).toBeCloseTo(out.costCents, 6);

    await backdateCreditDebit(key);
    await settleAndDebitAiReservations();
    const calls = deductCalls.filter((c) => c.key === key);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
    expect(calls[0]!.costCents).toBe(Number(row!.cost_cents));
    expect((await creditDebitRow(key))!.debited_at).not.toBeNull();
  });
});

describe.skipIf(!RUN)('operator re-drive of terminally failed debits (#7717 item 1)', () => {
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

  it('a billing-key rotation (401/403): every source is listed as auth, bulk re-queued, and re-sent under its ORIGINAL key and amount', async () => {
    deductResponses.push(billingStatus(401, 'unauthorized'), billingStatus(401, 'unauthorized'), billingStatus(403));
    const reservationId = await reserve(s, binding);
    await settleInvocation(settleInput(s, binding, reservationId));
    const runId = await seedAgentRun(s);
    await settleComputeCents(s.orgId, runId, 13, 'platform');
    const unreserved = await settleInvocation(settleInput(s, binding, undefined));
    const firstCalls = [...deductCalls];
    expect(firstCalls).toHaveLength(3);

    const failed = await listFailedPlatformCreditDebits({ orgId: s.orgId, failureClass: 'auth' });
    expect(failed.map((f) => f.source).sort()).toEqual(['compute', 'invocation', 'settlement']);
    expect(failed.map((f) => f.idempotencyKey).sort()).toEqual(firstCalls.map((c) => c.key).sort());
    expect(failed.find((f) => f.source === 'settlement')).toMatchObject({ id: reservationId, error: 'http_401:unauthorized', failureClass: 'auth' });
    expect(failed.find((f) => f.source === 'invocation')!.idempotencyKey).toBe(`ai-invocation:${unreserved.invocationIds[0]}`);

    // Terminal: the sweep does not touch them on its own.
    await backdateDebit(reservationId);
    await settleAndDebitAiReservations();
    expect(deductCalls).toHaveLength(3);

    const requeued = await requeueFailedCreditDebits({ orgId: s.orgId, failureClass: 'auth', limit: 100 });
    expect(requeued.map((r) => r.source).sort()).toEqual(['compute', 'invocation', 'settlement']);
    // As if the operator fixed the key a while after the rotation: past the grace.
    await fixtureSql`UPDATE ai_credit_debits SET created_at = now() - interval '10 minutes' WHERE org_id = ${s.orgId}`;
    await settleAndDebitAiReservations();
    const byKey = (a: DeductCall, b: DeductCall) => a.key!.localeCompare(b.key!);
    // Same key, same amount for every row: the billing service's dedupe makes it one charge.
    expect(deductCalls.slice(3).sort(byKey)).toEqual([...firstCalls].sort(byKey));
    expect(await listFailedPlatformCreditDebits({ orgId: s.orgId })).toEqual([]);
    expect((await reservationState(reservationId)).credits_debited_at).not.toBeNull();

    // Nothing is left to re-drive, and a further sweep sends nothing.
    expect(await requeueFailedCreditDebits({ orgId: s.orgId, failureClass: 'auth', limit: 100 })).toEqual([]);
    await settleAndDebitAiReservations();
    expect(deductCalls).toHaveLength(6);
  });

  it('the failure-class and time-window filters only re-queue what they match', async () => {
    deductResponses.push(billingStatus(409, 'idempotency_key_reused'), billingStatus(401));
    const runA = await seedAgentRun(s);
    await settleComputeCents(s.orgId, runA, 13, 'platform');
    const runB = await seedAgentRun(s);
    await settleComputeCents(s.orgId, runB, 9, 'platform');
    expect((await listFailedPlatformCreditDebits({ orgId: s.orgId })).map((f) => f.failureClass).sort()).toEqual(['auth', 'rejected']);
    expect((await listFailedPlatformCreditDebits({ orgId: s.orgId, failureClass: 'rejected' })).map((f) => f.idempotencyKey))
      .toEqual([computeCallsFor(runA)[0]!.key]);

    const hourAgo = new Date(Date.now() - 3_600_000);
    expect(await requeueFailedCreditDebits({ orgId: s.orgId, failureClass: 'auth', failedBefore: hourAgo, limit: 100 })).toEqual([]);
    expect(await requeueFailedCreditDebits({ orgId: s.orgId, failureClass: 'auth', failedAfter: hourAgo, limit: 100 })).toHaveLength(1);
    expect((await listFailedPlatformCreditDebits({ orgId: s.orgId })).map((f) => f.failureClass)).toEqual(['rejected']);
  });

  it('a single re-drive sends immediately under the original key; refused again it is re-stamped failed; a row that is not failed is not_found', async () => {
    deductResponses.push(billingStatus(401), billingStatus(401));
    const runId = await seedAgentRun(s);
    await settleComputeCents(s.orgId, runId, 13, 'platform');
    const [row] = await listFailedPlatformCreditDebits({ orgId: s.orgId });
    expect(row).toBeDefined();

    expect(await redriveFailedCreditDebit({ source: 'compute', id: row!.id })).toEqual({ kind: 'attempted', outcome: 'rejected' });
    expect(await listFailedPlatformCreditDebits({ orgId: s.orgId })).toHaveLength(1);

    expect(await redriveFailedCreditDebit({ source: 'compute', id: row!.id })).toEqual({ kind: 'attempted', outcome: 'debited' });
    const calls = computeCallsFor(runId);
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map((c) => JSON.stringify(c))).size).toBe(1);
    expect(await redriveFailedCreditDebit({ source: 'compute', id: row!.id })).toEqual({ kind: 'not_found' });
    expect(await redriveFailedCreditDebit({ source: 'settlement', id: randomUUID() })).toEqual({ kind: 'not_found' });
  });
});

describe.skipIf(!RUN)('dead pending settlement replay (#7717 item 3)', () => {
  let s: SeededRegistryPartner;

  beforeEach(async () => {
    installBillingStub();
    s = await seedRegistryPartner('platform');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.BILLING_SERVICE_URL;
    delete process.env.BILLING_SERVICE_API_KEY;
  });

  /** A real turn deferred by lock contention (priced ledger rows persisted), then given up on. */
  async function deadPending(binding: TurnBinding, over: Partial<SettleInvocationInput> = {}): Promise<string> {
    const id = await reserve(s, binding);
    const blocker = await holdOrganizationLock(s.orgId);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await settleInvocation(settleInput(s, binding, id, over))).deferred).toBe(true);
    } finally {
      await blocker.release();
      error.mockRestore();
    }
    await fixtureSql`UPDATE ai_budget_reservations SET pending_settlement_attempts = ${MAX_PENDING_SETTLEMENT_REPLAY_ATTEMPTS},
                     pending_settlement_error = 'boom', pending_settlement_dead_at = now() WHERE id = ${id}`;
    return id;
  }

  it('replays a dead settlement once and debits it under its own reservation key', async () => {
    const binding = await bindingFor(s);
    const id = await deadPending(binding);
    expect((await listDeadPendingSettlements(500)).map((r) => r.reservationId)).toContain(id);
    expect(deductCalls).toHaveLength(0);

    expect(await replayDeadPendingSettlement(id)).toMatchObject({ kind: 'replayed', settlement: 'settled', debit: 'debited' });
    const amount = Number((await reservationState(id)).actual_cost_cents);
    expect(amount).toBeCloseTo(priceInvocation(binding.rateSnapshot, T, {}), 6);
    expect(callsFor(id)).toEqual([{ key: `ai-settlement:${id}`, headerKey: `ai-settlement:${id}`, costCents: amount }]);
    expect(await q(sql`SELECT 1 FROM ai_invocations WHERE session_id = ${s.chatSessionId}::uuid`)).toHaveLength(1);
    expect(await reservationState(id)).toMatchObject({ status: 'settled', pending_settlement: null });
    expect((await listDeadPendingSettlements(500)).map((r) => r.reservationId)).not.toContain(id);

    expect(await replayDeadPendingSettlement(id)).toEqual({ kind: 'not_found' });
    expect(callsFor(id)).toHaveLength(1);
  }, 30_000);

  it('refuses an SDK-usage settlement whose usage a later turn of the same session already billed', async () => {
    const binding = await bindingFor(s);
    const snapshot: SdkUsageSnapshot = { version: 1, models: { [binding.wireModel]: { tokens: T, webSearchRequests: 0 } } };
    const id = await deadPending(binding, {
      sdkUsage: { sessionId: s.chatSessionId, nextSnapshot: snapshot, usageConfirmed: true, usageNote: 'first_result' },
    });
    // A later turn settles in the same session: its delta was taken against the
    // stored snapshot, which never saw the dead turn, so it billed that usage.
    const later = await reserve(s, binding);
    await settleInvocation(settleInput(s, binding, later));

    expect(await replayDeadPendingSettlement(id)).toEqual({ kind: 'superseded' });
    expect(callsFor(id)).toHaveLength(0);
    expect((await listDeadPendingSettlements(500)).map((r) => r.reservationId)).toContain(id);
  }, 30_000);
});
