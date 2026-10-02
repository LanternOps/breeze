/**
 * AI model registry W09 (#7607): the failover FUNDING contract against real
 * Postgres + a recording billing stub. A hop is admitted, reserved, settled
 * and debited on its own; a failover never double-debits, never skips a
 * debit, and never bills a hop at another hop's rate.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { messagesUsage } from '../../services/aiModels/invocationUsage';
import {
  FailoverExhaustedError,
  reserveFailoverHop,
  runWithFailover,
  settleZeroUsageHop,
  type FailoverHop,
} from '../../services/aiModels/failoverDispatch';
import { priceInvocation } from '../../services/aiModels/pricing';
import { resolveModel } from '../../services/aiModels/resolveModel';
import { settleInvocation } from '../../services/aiModels/settleInvocation';
import { turnBindingFrom } from '../../services/aiModels/turnBinding';
import { hopIdempotencyKey } from '../../services/aiModels/failover';
import { agentRunReservationBaseKey, markStaleHopReservations } from '../../services/aiAgents/agentRunFailover';
import { closeRegistryFixtures, fixtureSql } from './aiModelRegistryFixtures';
import { seedFailoverPartner, setPartnerDefault, setPartnerFallbacks, type SeededFailoverPartner } from './helpers/aiModelFailoverSeed';

const RUN = !!process.env.DATABASE_URL;
afterAll(closeRegistryFixtures);

const SURFACE = 'script_reviewer' as const;
const TOKENS = { input: 1000, output: 400 };
const P_RATE = { inputCentsPerM: 200, outputCentsPerM: 1000, cacheReadCentsPerM: 20, cacheWriteCentsPerM: 250 };
const P2_RATE = { inputCentsPerM: 400, outputCentsPerM: 2000, cacheReadCentsPerM: 40, cacheWriteCentsPerM: 500 };

// Billing service stub: the credits check answers `allowed` unless scripted; every deduct is recorded.
type Deduct = { key: string | null; costCents: number };
let deducts: Deduct[] = [];
let creditsAllowed = true;
function installBillingStub(): void {
  process.env.BILLING_SERVICE_URL = 'https://billing.test.invalid';
  process.env.BILLING_SERVICE_API_KEY = 'test-billing-key';
  deducts = [];
  creditsAllowed = true;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/ai-credits/deduct')) {
      const body = JSON.parse(String(init!.body)) as { costCents: number; idempotencyKey?: string };
      deducts.push({ key: body.idempotencyKey ?? null, costCents: body.costCents });
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    if (u.endsWith('/ai-credits')) {
      return new Response(JSON.stringify({ allowed: creditsAllowed, remainingCredits: creditsAllowed ? 100_000 : 0, plan: 'pro' }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${u}`);
  }));
}

const status = (code: number, type: string) =>
  Object.assign(new Error(type), { status: code, error: { type: 'error', error: { type, message: type } } });
function message(model: string) {
  return {
    id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model,
    content: [{ type: 'text', text: '{"ok":true}' }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: TOKENS.input, output_tokens: TOKENS.output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  } as never;
}

const reResolver = (f: SeededFailoverPartner) =>
  ({ excludeOfferingIds, cause, origin }: { excludeOfferingIds: string[]; cause: never; origin: never }) => resolveModel({
    partnerId: f.partnerId, orgId: f.orgId, surface: SURFACE, excludeOfferingIds, failoverCause: cause, failoverOrigin: origin,
  });
const zeroSettle = (f: SeededFailoverPartner) =>
  settleZeroUsageHop({ orgId: f.orgId, userId: null, sessionId: null, agentRunId: null, sourceRef: 'w09' });

async function firstHop(f: SeededFailoverPartner, surface: typeof SURFACE | 'ai_agents' = SURFACE, key = `w09-funding:${randomUUID()}`): Promise<FailoverHop> {
  const r = await resolveModel({ partnerId: f.partnerId, orgId: f.orgId, surface });
  if (!r.ok) throw new Error(`resolveModel: ${r.reason}`);
  const binding = turnBindingFrom(r);
  const res = await reserveFailoverHop({ orgId: f.orgId })(r, binding, key);
  if (!res.ok) throw new Error(res.message);
  return { index: 0, resolved: r, binding, reservationId: res.reservationId, idempotencyKey: key, reservedCostCents: res.reservedCostCents };
}

/** One dispatch: each attempt throws the next scripted error, then serves; the serving hop is settled like a surface would. */
async function dispatch(f: SeededFailoverPartner, script: Array<Error | 'serve'>) {
  const first = await firstHop(f);
  const queue = [...script];
  const out = await runWithFailover({
    first,
    reResolve: reResolver(f) as never,
    reserveHop: reserveFailoverHop({ orgId: f.orgId }),
    attempt: async (hop) => {
      const next = queue.shift();
      if (next !== 'serve') throw next;
      return { wireModel: hop.binding.wireModel, message: message(hop.binding.wireModel) };
    },
    settleFailedHop: zeroSettle(f),
  });
  const settled = await settleInvocation({
    binding: out.hop.binding, orgId: f.orgId, userId: null, sessionId: null, agentRunId: null, sourceRef: 'w09',
    ...messagesUsage(out.hop.binding, [out.value]), reservationId: out.hop.reservationId,
  });
  return { first, out, settled };
}

async function q<R extends Record<string, unknown>>(query: ReturnType<typeof sql>): Promise<R[]> {
  return withSystemDbAccessContext(async () => {
    const result = await db.execute<R>(query);
    return ((result as unknown as { rows?: R[] }).rows ?? (result as unknown as R[]));
  });
}
const ledger = (orgId: string) => q<{ offering_id: string; funding_source: string; cost_cents: string; stop_reason: string;
  failover_hop: number; failover_cause: string | null; failover_from_offering_id: string | null }>(sql`
  SELECT offering_id, funding_source, cost_cents, stop_reason, failover_hop, failover_cause, failover_from_offering_id
    FROM ai_invocations WHERE org_id = ${orgId}::uuid ORDER BY created_at, failover_hop`);
const reservationsLike = (orgId: string, key: string) => q<{ id: string; idempotency_key: string; status: string; billing_source: string }>(sql`
  SELECT id, idempotency_key, status, billing_source FROM ai_budget_reservations
   WHERE org_id = ${orgId}::uuid AND starts_with(idempotency_key, ${key}) ORDER BY idempotency_key`);
const tokens = { ...TOKENS, cacheRead: 0, cacheWrite: 0 };

describe.runIf(RUN)('W09 failover funding (F1–F6)', () => {
  let f: SeededFailoverPartner;
  const savedKey = process.env.ANTHROPIC_API_KEY;
  beforeEach(async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-w09-integration-placeholder';
    installBillingStub();
    f = await seedFailoverPartner();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.BILLING_SERVICE_URL;
    delete process.env.BILLING_SERVICE_API_KEY;
  });
  afterAll(() => { if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedKey; });

  it('platform->platform: the zero-cost failed hop never debits; the served hop debits once under its own key at ITS rate', async () => {
    await setPartnerFallbacks(f, SURFACE, [f.platformOffering2Id], false);
    const { first, out, settled } = await dispatch(f, [status(529, 'overloaded_error'), 'serve']);
    const expected = priceInvocation({ source: 'platform', standard: P2_RATE }, tokens, {});
    expect(settled.costCents).toBeCloseTo(expected, 6);
    expect(expected).not.toBeCloseTo(priceInvocation({ source: 'platform', standard: P_RATE }, tokens, {}), 6);
    expect(deducts).toEqual([{ key: `ai-settlement:${out.hop.reservationId}`, costCents: expect.closeTo(expected, 4) }]);
    const rows = await ledger(f.orgId);
    expect(rows.map((r) => [r.offering_id, r.funding_source, Number(r.cost_cents), r.failover_hop, r.failover_cause])).toEqual([
      [f.platformOfferingId, 'platform', 0, 0, null],
      [f.platformOffering2Id, 'platform', expect.closeTo(expected, 6), 1, 'overloaded'],
    ]);
    expect(rows[1]!.failover_from_offering_id).toBe(f.platformOfferingId);
    expect((await reservationsLike(f.orgId, first.idempotencyKey)).map((r) => [r.idempotency_key, r.status, r.billing_source])).toEqual([
      [first.idempotencyKey, 'settled', 'platform'],
      [`${first.idempotencyKey}:hop:1`, 'settled', 'platform'],
    ]);
  });

  it('re-settling the served hop (a retried settle) debits nothing more', async () => {
    await setPartnerFallbacks(f, SURFACE, [f.platformOffering2Id], false);
    const { out } = await dispatch(f, [status(529, 'overloaded_error'), 'serve']);
    await settleInvocation({
      binding: out.hop.binding, orgId: f.orgId, userId: null, sessionId: null, agentRunId: null, sourceRef: 'w09',
      ...messagesUsage(out.hop.binding, [out.value]), reservationId: out.hop.reservationId,
    });
    expect(deducts).toHaveLength(1);
    expect((await ledger(f.orgId)).filter((r) => r.failover_hop === 1)).toHaveLength(1);
  });

  it('re-settling the FAILED hop after the served one never debits it', async () => {
    await setPartnerFallbacks(f, SURFACE, [f.platformOffering2Id], false);
    const { first } = await dispatch(f, [status(529, 'overloaded_error'), 'serve']);
    await zeroSettle(f)(first);
    expect(deducts).toHaveLength(1);
    expect(deducts[0]!.key).not.toBe(`ai-settlement:${first.reservationId}`);
  });

  it('BYOK->platform with crossing on: the platform hop debits its registry cost; the BYOK hop debits nothing', async () => {
    await setPartnerDefault(f, SURFACE, f.byokOfferingId);
    await setPartnerFallbacks(f, SURFACE, [f.platformOfferingId], true);
    const { first, out, settled } = await dispatch(f, [status(429, 'rate_limit_error'), 'serve']);
    expect(first.resolved.funding).toBe('partner_key');
    expect(out.hop.resolved.funding).toBe('platform');
    expect(settled.costCents).toBeCloseTo(priceInvocation({ source: 'platform', standard: P_RATE }, tokens, {}), 6);
    expect(deducts).toEqual([{ key: `ai-settlement:${out.hop.reservationId}`, costCents: expect.closeTo(settled.costCents, 4) }]);
    expect((await ledger(f.orgId)).map((r) => [r.offering_id, r.funding_source, r.failover_hop])).toEqual([
      [f.byokOfferingId, 'partner_key', 0],
      [f.platformOfferingId, 'platform', 1],
    ]);
    expect((await reservationsLike(f.orgId, first.idempotencyKey)).map((r) => r.billing_source)).toEqual(['partner_key', 'platform']);
  });

  it('platform->BYOK with crossing on: nothing is debited (the partner\'s provider bills the BYOK hop)', async () => {
    await setPartnerFallbacks(f, SURFACE, [f.byokOfferingId], true);
    const { out, settled } = await dispatch(f, [status(529, 'overloaded_error'), 'serve']);
    expect(out.hop.resolved.funding).toBe('partner_key');
    expect(settled.costCents).toBeGreaterThan(0);
    expect(deducts).toEqual([]);
  });

  it('BYOK->platform with crossing off: no platform reservation, no deduct, FailoverExhaustedError', async () => {
    await setPartnerDefault(f, SURFACE, f.byokOfferingId);
    await setPartnerFallbacks(f, SURFACE, [f.platformOfferingId], false);
    const first = await firstHop(f);
    const e = await runWithFailover({
      first, reResolve: reResolver(f) as never, reserveHop: reserveFailoverHop({ orgId: f.orgId }),
      attempt: async () => { throw status(429, 'rate_limit_error'); }, settleFailedHop: zeroSettle(f),
    }).catch((x) => x);
    expect(e).toBeInstanceOf(FailoverExhaustedError);
    expect((await reservationsLike(f.orgId, first.idempotencyKey)).map((r) => [r.idempotency_key, r.status]))
      .toEqual([[first.idempotencyKey, 'settled']]);
    expect(deducts).toEqual([]);
  });

  it('the platform hop is not admitted when credits are exhausted: stops before reserving it', async () => {
    await setPartnerDefault(f, SURFACE, f.byokOfferingId);
    await setPartnerFallbacks(f, SURFACE, [f.platformOfferingId], true);
    const first = await firstHop(f);
    creditsAllowed = false;
    const e = await runWithFailover({
      first, reResolve: reResolver(f) as never, reserveHop: reserveFailoverHop({ orgId: f.orgId }),
      attempt: async () => { throw status(429, 'rate_limit_error'); }, settleFailedHop: zeroSettle(f),
    }).catch((x) => x);
    expect(e).toBeInstanceOf(FailoverExhaustedError);
    expect(e.stop).toBe('admission_denied');
    expect(await reservationsLike(f.orgId, first.idempotencyKey)).toHaveLength(1);
    expect(deducts).toEqual([]);
  });

  it('a fallback disabled after the first resolution is skipped at failover time (F2)', async () => {
    await setPartnerFallbacks(f, SURFACE, [f.platformOffering2Id], false);
    const first = await firstHop(f);
    await fixtureSql`UPDATE partner_ai_models SET enabled = false WHERE id = ${f.platformOffering2Id}`;
    const e = await runWithFailover({
      first, reResolve: reResolver(f) as never, reserveHop: reserveFailoverHop({ orgId: f.orgId }),
      attempt: async () => { throw status(529, 'overloaded_error'); }, settleFailedHop: zeroSettle(f),
    }).catch((x) => x);
    expect(e).toBeInstanceOf(FailoverExhaustedError);
    expect(await reservationsLike(f.orgId, first.idempotencyKey)).toHaveLength(1);
  });

  it('the served hop\'s rows can never be settled on the failed hop\'s reservation (binding mismatch)', async () => {
    await setPartnerDefault(f, SURFACE, f.byokOfferingId);
    await setPartnerFallbacks(f, SURFACE, [f.platformOfferingId], true);
    const first = await firstHop(f);                                                  // BYOK reservation
    const platform = await resolveModel({ partnerId: f.partnerId, orgId: f.orgId, surface: SURFACE,
      excludeOfferingIds: [f.byokOfferingId], failoverCause: 'rate_limited' });
    if (!platform.ok) throw new Error(platform.reason);
    const binding = turnBindingFrom(platform);
    await expect(settleInvocation({
      binding, orgId: f.orgId, userId: null, sessionId: null, agentRunId: null, sourceRef: 'w09',
      ...messagesUsage(binding, [{ wireModel: binding.wireModel, message: message(binding.wireModel) }]),
      reservationId: first.reservationId,
    })).rejects.toThrow();
    expect(deducts).toEqual([]);
    expect(await ledger(f.orgId)).toEqual([]);
  });

  it('a default switched to another funding mid-dispatch cannot be used to cross funding with crossing off (Codex 4)', async () => {
    await setPartnerDefault(f, SURFACE, f.byokOfferingId);
    await setPartnerFallbacks(f, SURFACE, [], false);
    const first = await firstHop(f);                                                   // BYOK
    await setPartnerDefault(f, SURFACE, f.platformOfferingId);
    const r = await resolveModel({ partnerId: f.partnerId, orgId: f.orgId, surface: SURFACE,
      excludeOfferingIds: [f.byokOfferingId], failoverCause: 'rate_limited',
      failoverOrigin: { offeringId: first.resolved.offering.id, funding: first.resolved.funding, connectionId: first.resolved.connection.id } });
    expect(r).toMatchObject({ ok: false });
  });

  it('the ledger rejects a row naming the served platform offering with partner_key funding (23514)', async () => {
    const err = await fixtureSql`
      INSERT INTO ai_invocations (org_id, surface, offering_id, funding_source, requested_model, served_model, ledger_mode)
      VALUES (${f.orgId}, ${SURFACE}, ${f.platformOfferingId}, 'partner_key', 'm', 'm', 'authoritative')`.catch((e) => e);
    expect((err as { code?: string }).code).toBe('23514');
  });
});

describe.runIf(RUN)('W09 agent-run hop keys', () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-w09-integration-placeholder';
    installBillingStub();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.BILLING_SERVICE_URL;
    delete process.env.BILLING_SERVICE_API_KEY;
  });

  it('a re-drive reserves the SAME hop reservation, and settling it twice debits once', async () => {
    const f = await seedFailoverPartner();
    const r = await resolveModel({ partnerId: f.partnerId, orgId: f.orgId, surface: 'ai_agents' });
    if (!r.ok) throw new Error(r.reason);
    const binding = turnBindingFrom(r);
    const key = `ai-agent-run:${randomUUID()}:hop:1`;
    const a = await reserveFailoverHop({ orgId: f.orgId })(r, binding, key);
    const b = await reserveFailoverHop({ orgId: f.orgId })(r, binding, key);          // the re-driven run
    if (!a.ok || !b.ok) throw new Error('not admitted');
    expect(b.reservationId).toBe(a.reservationId);
    const settle = () => settleInvocation({
      binding, orgId: f.orgId, userId: null, sessionId: null, agentRunId: null, sourceRef: 'w09',
      ...messagesUsage(binding, [{ wireModel: binding.wireModel, message: message(binding.wireModel) }]), reservationId: a.reservationId,
    });
    await settle();
    await settle();
    expect(deducts.filter((d) => d.key === `ai-settlement:${a.reservationId}`)).toHaveLength(1);
  });

  it('a crash after recording hop 1 but before settling hop 0: re-drive marks hop 0 indeterminate, never debits it, and reserves hop 1', async () => {
    const f = await seedFailoverPartner();
    const r = await resolveModel({ partnerId: f.partnerId, orgId: f.orgId, surface: 'ai_agents' });
    if (!r.ok) throw new Error(r.reason);
    const runId = randomUUID();
    const base = agentRunReservationBaseKey(runId);
    const hop0 = await reserveFailoverHop({ orgId: f.orgId })(r, turnBindingFrom(r), base);   // dispatched, never settled
    if (!hop0.ok) throw new Error('not admitted');

    // The re-driven run (startHopFor → hop 1) closes the window before reserving its own hop.
    expect(await markStaleHopReservations({ runId, orgId: f.orgId, uptoHop: 1 })).toBe(1);
    const [row] = await fixtureSql`SELECT status FROM ai_budget_reservations WHERE id = ${hop0.reservationId}`;
    expect(row!.status).toBe('indeterminate');
    // Idempotent: a second re-drive finds nothing active to mark.
    expect(await markStaleHopReservations({ runId, orgId: f.orgId, uptoHop: 1 })).toBe(0);

    const hop1 = await reserveFailoverHop({ orgId: f.orgId })(r, turnBindingFrom(r), hopIdempotencyKey(base, 1));
    if (!hop1.ok) throw new Error('hop 1 not admitted');
    expect(hop1.reservationId).not.toBe(hop0.reservationId);
    expect((await reservationsLike(f.orgId, base)).map((x) => [x.idempotency_key, x.status])).toEqual([
      [base, 'indeterminate'],
      [`${base}:hop:1`, 'active'],
    ]);
    expect(deducts).toEqual([]);
  });
});
