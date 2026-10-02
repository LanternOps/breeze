/**
 * AI chargeback W10 (#7608) Task 6: the chargeback snapshot is stamped at
 * ledger write, inside W03's settlement transaction, against real Postgres.
 * The settlement harness below (sys, q, bindingFor, reserve, settleInput, OK,
 * T, holdOrganizationLock and the lockTimeout mock) is copied verbatim from
 * aiInvocationSettlement.integration.test.ts (test-local by that suite's
 * convention).
 */
import './setup';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
  persistPendingSettlement,
  reserveAiBudget,
  settleAiBudgetReservation,
} from '../../services/aiBudgetReservations';
import type { TurnOutcome } from '../../services/aiModels/invocationUsage';
import { resolveModel } from '../../services/aiModels/resolveModel';
import {
  priceUsage,
  settleInvocation,
  toNewInvocations,
  type SettleInvocationInput,
} from '../../services/aiModels/settleInvocation';
import { turnBindingFrom, type TurnBinding } from '../../services/aiModels/turnBinding';
import { assignCard, seedAiCard } from './aiChargebackFixtures';
import { closeRegistryFixtures, fixtureSql } from './aiModelRegistryFixtures';
import { seedRegistryPartner, type SeededRegistryPartner } from './helpers/aiModelRegistrySeed';

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

async function ledgerFor(sessionId: string) {
  return q<{ chargeable: boolean; charge_billing_profile_id: string | null; charge_coverage: string | null;
    charge_basis: string | null; charge_currency: string | null; charge_amount: string | null; cost_cents: string }>(sql`
    SELECT chargeable, charge_billing_profile_id, charge_coverage, charge_basis, charge_currency,
           charge_amount::text AS charge_amount, cost_cents::text AS cost_cents
    FROM ai_invocations WHERE session_id = ${sessionId}::uuid ORDER BY created_at`);
}

describe.skipIf(!RUN)('chargeback is stamped at ledger write (#7608)', () => {
  let s: SeededRegistryPartner;
  let binding: TurnBinding;
  beforeEach(async () => {
    delete process.env.BILLING_SERVICE_URL;
    delete process.env.BILLING_SERVICE_API_KEY;
    s = await seedRegistryPartner('platform');
    binding = await bindingFor(s);
  });

  it('a settled turn on a billable markup card is chargeable at cost × (1 + markup)', async () => {
    const card = await seedAiCard(s.partnerId, { aiMarkupPercent: '25.00' });
    await settleInvocation(settleInput(s, binding, await reserve(s, binding)));
    const [row] = await ledgerFor(s.chatSessionId);
    expect(row).toMatchObject({ chargeable: true, charge_billing_profile_id: card, charge_coverage: 'billable',
      charge_basis: 'markup', charge_currency: 'USD' });
    // RR2 on the stored cost: amount = cost_cents × 1.25 / 100, 6 dp
    expect(Number(row!.charge_amount)).toBeCloseTo(Number(row!.cost_cents) * 1.25 / 100, 6);
  });

  it('a price-list row for the served model wins', async () => {
    await seedAiCard(s.partnerId, { rates: [{ modelId: binding.wireModel, input: '1', output: '1', cacheRead: '1', cacheWrite: '1' }] });
    await settleInvocation(settleInput(s, binding, await reserve(s, binding)));
    const [row] = await ledgerFor(s.chatSessionId);
    // T = 120k + 40k + 500k + 2k = 662,000 tokens × 1 per million = 0.662
    expect(row).toMatchObject({ chargeable: true, charge_basis: 'price_list', charge_amount: '0.662000' });
  });

  it('a non-billable default card stamps coverage but is not chargeable (nobody billed by default)', async () => {
    await seedAiCard(s.partnerId, { aiCoverage: 'non_billable', aiMarkupPercent: null });
    await settleInvocation(settleInput(s, binding, await reserve(s, binding)));
    const [row] = await ledgerFor(s.chatSessionId);
    expect(row).toMatchObject({ chargeable: false, charge_coverage: 'non_billable', charge_amount: null });
  });

  it('the org\'s assigned card beats the partner default (one resolver)', async () => {
    await seedAiCard(s.partnerId, { aiMarkupPercent: '10.00' });
    const negotiated = await seedAiCard(s.partnerId, { isDefault: false, aiMarkupPercent: '50.00' });
    await assignCard(s.orgId, s.partnerId, negotiated);
    await settleInvocation(settleInput(s, binding, await reserve(s, binding)));
    const [row] = await ledgerFor(s.chatSessionId);
    expect(row!.charge_billing_profile_id).toBe(negotiated);
  });

  it('card edit after stamping leaves the row untouched', async () => {
    const card = await seedAiCard(s.partnerId, { aiMarkupPercent: '25.00' });
    await settleInvocation(settleInput(s, binding, await reserve(s, binding)));
    const before = await ledgerFor(s.chatSessionId);
    await fixtureSql`UPDATE billing_profiles SET ai_markup_percent = 90 WHERE id = ${card}`;
    await fixtureSql`UPDATE billing_profiles SET ai_coverage = 'included', ai_markup_percent = NULL WHERE id = ${card}`;
    expect(await ledgerFor(s.chatSessionId)).toEqual(before);
  });

  it('replay stamps with the card in force at replay (the snapshot moment is the ledger write)', async () => {
    const card = await seedAiCard(s.partnerId, { aiMarkupPercent: '10.00' });
    const id = await reserve(s, binding);
    const blocker = await holdOrganizationLock(s.orgId);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await settleInvocation(settleInput(s, binding, id))).deferred).toBe(true);
    } finally { await blocker.release(); error.mockRestore(); }
    expect(await ledgerFor(s.chatSessionId)).toHaveLength(0); // deferred: no ledger row yet
    await fixtureSql`UPDATE billing_profiles SET ai_markup_percent = 40 WHERE id = ${card}`;
    expect((await settleAndDebitAiReservations()).replayed).toBe(1);
    const [row] = await ledgerFor(s.chatSessionId);
    expect(Number(row!.charge_amount)).toBeCloseTo(Number(row!.cost_cents) * 1.40 / 100, 6);
  }, 30_000);

  it('stamping happens before the org lock: a held org lock defers, it does not wedge the stamp read', async () => {
    await seedAiCard(s.partnerId);
    // Reserve FIRST: admission also locks the org (Codex review finding 8).
    const reservationId = await reserve(s, binding);
    const blocker = await holdOrganizationLock(s.orgId);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const started = Date.now();
      expect((await settleInvocation(settleInput(s, binding, reservationId))).deferred).toBe(true);
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally { await blocker.release(); error.mockRestore(); }
  }, 30_000);

  // ---- Orchestrator requirements beyond the plan text (W10 dispatch, #7608) ----

  it('an unrecorded settlement (W03 unrecorded: true) writes no ledger row, so nothing is chargeable', async () => {
    await seedAiCard(s.partnerId, { aiMarkupPercent: '25.00' });
    const id = await reserve(s, binding);
    // A DIFFERENT settlement of this reservation already holds the pending slot
    // (the real W03 mechanism): once the org lock blocks twice,
    // persistPendingSettlement answers 'already_pending' and this one is unrecorded.
    const other = { orgId: s.orgId, reservationId: id, actualCostCents: 5, inputTokens: 10, outputTokens: 5 };
    expect(await persistPendingSettlement(other)).toBe('persisted');
    const blocker = await holdOrganizationLock(s.orgId);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const out = await settleInvocation(settleInput(s, binding, id));
      expect(out).toMatchObject({ deferred: true, unrecorded: true, invocationIds: [] });
    } finally { await blocker.release(); error.mockRestore(); warn.mockRestore(); }
    expect(await ledgerFor(s.chatSessionId)).toHaveLength(0);
    expect(await q(sql`SELECT 1 FROM ai_invocations WHERE org_id = ${s.orgId}::uuid`)).toHaveLength(0);
    expect(await q(sql`SELECT 1 FROM ai_invocations WHERE org_id = ${s.orgId}::uuid AND chargeable`)).toHaveLength(0);
    // The settlement that held the slot is untouched (still the one the sweep would replay).
    const [reservation] = await q<{ pending_settlement: unknown; status: string }>(sql`
      SELECT pending_settlement, status FROM ai_budget_reservations WHERE id = ${id}::uuid`);
    expect(reservation!.status).not.toBe('settled');
    expect(reservation!.pending_settlement).toMatchObject({ actualCostCents: 5, inputTokens: 10, outputTokens: 5 });
  }, 30_000);

  it('the no-reservation path (recordInvocationsWithRollups) stamps a chargeable row too', async () => {
    const card = await seedAiCard(s.partnerId, { aiMarkupPercent: '25.00' });
    const out = await settleInvocation(settleInput(s, binding, undefined));
    expect(out).toMatchObject({ deferred: false });
    expect(out.invocationIds).toHaveLength(1);
    const [row] = await ledgerFor(s.chatSessionId);
    expect(row).toMatchObject({ chargeable: true, charge_billing_profile_id: card, charge_coverage: 'billable',
      charge_basis: 'markup', charge_currency: 'USD' });
    expect(Number(row!.charge_amount)).toBeCloseTo(Number(row!.cost_cents) * 1.25 / 100, 6);
  });

  it('stamping leaves the settlement fingerprint alone: a replay of the SAME input is already_settled', async () => {
    const card = await seedAiCard(s.partnerId, { aiMarkupPercent: '25.00' });
    const id = await reserve(s, binding);
    const input = settleInput(s, binding, id);
    const first = await settleInvocation(input);
    expect(first.invocationIds).toHaveLength(1);
    // The card changes between the calls, so a stamp that leaked into the
    // fingerprint would now differ and throw 'Conflicting settlement'.
    await fixtureSql`UPDATE billing_profiles SET ai_markup_percent = 90 WHERE id = ${card}`;
    expect(await settleInvocation(input)).toEqual({ costCents: first.costCents, invocationIds: [], deferred: false });
    // The same settle input settleInvocation built, straight into the settlement.
    const replay = await settleAiBudgetReservation({
      orgId: s.orgId, reservationId: id, invocations: toNewInvocations(input, priceUsage(binding, input.usage)),
      messageCount: 1, toolExecutionCount: 0, session: { id: s.chatSessionId, turnCount: 1 },
    });
    expect(replay).toMatchObject({ kind: 'already_settled', invocationIds: [] });
    const rows = await ledgerFor(s.chatSessionId);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.charge_amount)).toBeCloseTo(Number(rows[0]!.cost_cents) * 1.25 / 100, 6);
  });
});
