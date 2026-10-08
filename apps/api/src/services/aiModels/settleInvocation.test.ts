import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  settleDurably: vi.fn(),
  recordWithRollups: vi.fn(),
  markDebited: vi.fn(),
  recordFailure: vi.fn(),
  recordRetry: vi.fn(),
  debit: vi.fn(),
  getPlatformModelByModelId: vi.fn(),
  readConnectionOfferingRate: vi.fn(),
  attestUnboundRate: vi.fn(),
  readUnboundRateAttestation: vi.fn(),
  withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
  captureMessage: vi.fn(),
  captureException: vi.fn(),
  checkCostAnomalies: vi.fn(),
}));
vi.mock('../aiBudgetReservations', () => ({
  settleAiBudgetReservationDurably: m.settleDurably,
  attestUnboundRate: m.attestUnboundRate,
  readUnboundRateAttestation: m.readUnboundRateAttestation,
  recordInvocationsWithRollups: m.recordWithRollups,
  markCreditsDebited: m.markDebited,
  recordCreditDebitFailure: m.recordFailure,
  recordCreditDebitRetry: m.recordRetry,
  creditDebitIdempotencyKey: (id: string) => `ai-settlement:${id}`,
}));
vi.mock('../aiCostTracker', () => ({ debitBillingCredits: m.debit, checkCostAnomalies: m.checkCostAnomalies }));
vi.mock('./platformModels', () => ({ getPlatformModelByModelId: m.getPlatformModelByModelId }));
vi.mock('../sentry', () => ({ captureMessage: m.captureMessage, captureException: m.captureException }));
vi.mock('./connectionOfferingRate', () => ({ readConnectionOfferingRate: m.readConnectionOfferingRate }));
vi.mock('../../db', () => ({ runOutsideDbContext: (fn: () => unknown) => fn(), withSystemDbAccessContext: m.withSystemDbAccessContext }));

import type { BilledUsage, SdkUsageSnapshot, TurnOutcome } from './invocationUsage';
import { priceInvocation } from './pricing';
import {
  WEB_SEARCH_COST_CENTS,
  consistentPromptVariant,
  costEstimator,
  debitSettledCredits,
  priceUsage,
  quoteInvocationCents,
  settleInvocation,
  toNewInvocations,
  __resetSettleInvocationReportsForTests,
  type SettleInvocationInput,
} from './settleInvocation';
import { turnBindingFrom, withCarriedRates, type TurnBinding } from './turnBinding';
import { makeResolvedModel } from './__fixtures__/resolvedModel';

const STD = { inputCentsPerM: 200, outputCentsPerM: 1000, cacheReadCentsPerM: 20, cacheWriteCentsPerM: 250 };
const FAST = { inputCentsPerM: 1200, outputCentsPerM: 6000, cacheReadCentsPerM: 120, cacheWriteCentsPerM: 1500 };
const FB = { inputCentsPerM: 100, outputCentsPerM: 500, cacheReadCentsPerM: 10, cacheWriteCentsPerM: 125 };
const OTHER = { inputCentsPerM: 300, outputCentsPerM: 1500, cacheReadCentsPerM: 30, cacheWriteCentsPerM: 375 };
const B: TurnBinding = {
  v: 1, surface: 'chat', role: 'default', partnerId: 'p1', offeringId: 'off-1', connectionId: null,
  connectionKind: 'platform', configVersion: null, catalogRevisionId: null, funding: 'platform',
  logicalModel: 'claude-sonnet-5-5', wireModel: 'claude-sonnet-5-5', options: { effort: 'medium' },
  thinkingMode: 'adaptive', inferenceGeo: null, wireFingerprint: 'f',
  rateSnapshot: { source: 'platform', standard: STD },
  refusalFallback: { offeringId: 'fb', wireModel: 'claude-haiku-4-5', rateSnapshot: { source: 'platform', standard: FB } },
};
const T = { input: 1_000_000, output: 100_000, cacheRead: 0, cacheWrite: 0 };
const OK: TurnOutcome = {
  stopReason: 'end_turn', refused: false, refusalCategory: null, fallbackUsed: false,
  servedModel: 'claude-sonnet-5-5', providerModel: null, sdkReportedCostUsd: 9.99, fastDowngraded: false,
};
const use = (model: string, over: Partial<BilledUsage> = {}): BilledUsage => ({
  model, tokens: T, webSearchRequests: 0, speedServed: 'standard', providerModel: null, ...over,
});
const base = (over: Partial<SettleInvocationInput> = {}): SettleInvocationInput => ({
  binding: B, orgId: 'o1', userId: null, sessionId: null, agentRunId: null, sourceRef: null,
  usage: [use('claude-sonnet-5-5')], outcome: OK, reservationId: 'r1', ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  __resetSettleInvocationReportsForTests();
  m.settleDurably.mockResolvedValue({
    kind: 'settled', reservationId: 'r1', actualCostCents: 300, invocationIds: ['i1'], billingSource: 'platform', creditsDebitDue: true,
  });
  m.recordWithRollups.mockResolvedValue(['i1']);
  m.debit.mockResolvedValue({ kind: 'debited', replayed: false });
  m.recordRetry.mockResolvedValue({ attempts: 1, exhausted: false });
  m.getPlatformModelByModelId.mockResolvedValue(null);
  m.readConnectionOfferingRate.mockResolvedValue({ rate: null, reason: 'no_enabled_offering' });
  m.attestUnboundRate.mockImplementation(async (i: { attestation: unknown }) => i.attestation);
  m.readUnboundRateAttestation.mockResolvedValue(null);
  m.withSystemDbAccessContext.mockImplementation((fn: () => unknown) => fn());
  m.checkCostAnomalies.mockResolvedValue(undefined);
});

// W03 Task 17: the deleted legacy recorders were the only trigger of the
// per-spend budget threshold / anomaly check; the registry path keeps it.
describe('budget threshold check after spend', () => {
  it('fires once per settled spend, with the session, for either funding source', async () => {
    await settleInvocation(base({ sessionId: 's1' }));
    expect(m.checkCostAnomalies).toHaveBeenCalledWith('s1', 'o1', 300);
    m.checkCostAnomalies.mockClear();
    m.settleDurably.mockResolvedValue({ kind: 'settled', reservationId: 'r1', actualCostCents: 300, invocationIds: ['i1'], billingSource: 'partner_key', creditsDebitDue: false });
    await settleInvocation(base({ binding: { ...B, funding: 'partner_key', connectionId: 'c1', connectionKind: 'anthropic_byok' } }));
    expect(m.checkCostAnomalies).toHaveBeenCalledWith(null, 'o1', 300);
  });

  it('fires on the unreserved path too', async () => {
    await settleInvocation(base({ reservationId: undefined }));
    expect(m.checkCostAnomalies).toHaveBeenCalledWith(null, 'o1', 300);
  });

  it('does not fire for a zero-cost turn, a deferred settlement, or a replayed one', async () => {
    const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    m.settleDurably.mockResolvedValueOnce({ kind: 'settled', reservationId: 'r1', actualCostCents: 0, invocationIds: ['i1'], billingSource: 'platform', creditsDebitDue: false });
    await settleInvocation(base({ usage: [use('claude-sonnet-5-5', { tokens: zero })] }));
    await settleInvocation(base({ reservationId: undefined, usage: [use('claude-sonnet-5-5', { tokens: zero })] }));
    m.settleDurably.mockResolvedValueOnce({ kind: 'deferred_indeterminate', reservationId: 'r1', persisted: true });
    await settleInvocation(base());
    m.settleDurably.mockResolvedValueOnce({ kind: 'already_settled', reservationId: 'r1', actualCostCents: 300, invocationIds: [], billingSource: 'platform', creditsDebitDue: false });
    await settleInvocation(base());
    expect(m.checkCostAnomalies).not.toHaveBeenCalled();
  });

  it('a failing check never fails the settlement', async () => {
    m.checkCostAnomalies.mockRejectedValue(new Error('db down'));
    await expect(settleInvocation(base())).resolves.toMatchObject({ costCents: 300, deferred: false });
  });
});

describe('priceUsage', () => {
  it('prices from the bound snapshot with priceInvocation, never from the SDK', () => {
    const [p] = priceUsage(B, [use('claude-sonnet-5-5')]);
    expect(p!.costCents).toBe(priceInvocation({ source: 'platform', standard: STD }, T, {}));
    expect(p!.costCents).toBe(300);   // 1M in × 200 + 0.1M out × 1000
  });
  it('a fallback-served row is priced at the fallback rate', () => {
    expect(priceUsage(B, [use('claude-haiku-4-5')])[0]!.costCents).toBe(150);
  });
  it('web search requests add the server-tool fee', () => {
    expect(priceUsage(B, [use('claude-sonnet-5-5', { webSearchRequests: 2 })])[0]!.costCents)
      .toBe(300 + 2 * WEB_SEARCH_COST_CENTS);
  });
  it('empty usage still yields one zero row at the primary model (the attempt is recorded)', () => {
    expect(priceUsage(B, [])).toEqual([expect.objectContaining({ model: 'claude-sonnet-5-5', costCents: 0 })]);
  });

  describe('served model and speed (W05 spike)', () => {
    const fastBinding: TurnBinding = { ...B, options: { effort: 'medium', speed: 'fast' }, rateSnapshot: { source: 'platform', standard: STD, option: { key: 'speed:fast', rates: FAST } } };

    it('bills the fast rate ONLY when the provider confirmed fast was served', () => {
      const [p] = priceUsage(fastBinding, [use('claude-sonnet-5-5', { speedServed: 'fast' })]);
      expect(p!.costCents).toBe(priceInvocation(fastBinding.rateSnapshot, T, { speed: 'fast' }));
      expect(p!.appliedSpeed).toBe('fast');
    });

    it('fast requested but standard served → the standard rate', () => {
      const [p] = priceUsage(fastBinding, [use('claude-sonnet-5-5', { speedServed: 'standard' })]);
      expect(p!.costCents).toBe(300);
      expect(p!.appliedSpeed).toBe('standard');
    });

    it('an SDK key the binding never named (the CLI\'s own refusal switch) is priced at that model\'s platform rate and flagged', () => {
      const [p] = priceUsage(B, [use('claude-sonnet-4-6')], { platformRates: new Map([['claude-sonnet-4-6', { source: 'platform', standard: OTHER }]]) });
      expect(p!.costCents).toBe(priceInvocation({ source: 'platform', standard: OTHER }, T, {}));
      expect(p!.unboundModel).toBe(true);
    });

    it('…at the bound rate when no platform row prices it, or when the turn is partner-funded', () => {
      expect(priceUsage(B, [use('claude-sonnet-4-6')])[0]).toMatchObject({ costCents: 300, unboundModel: true });
      const byok: TurnBinding = { ...B, funding: 'partner_key', connectionId: 'c1', connectionKind: 'anthropic_byok' };
      expect(priceUsage(byok, [use('claude-sonnet-4-6')], { platformRates: new Map([['claude-sonnet-4-6', { source: 'platform', standard: OTHER }]]) })[0])
        .toMatchObject({ costCents: 300, unboundModel: true });
    });
  });
});

describe('costEstimator', () => {
  it('estimates output caps from the resolved rate', () => {
    expect(costEstimator({ rateSnapshot: { source: 'platform', standard: STD }, options: {} })(1_000_000, 0)).toBe(200);
  });
});

describe('settleInvocation', () => {
  it('SDK says $9.99 → ledger and settlement get the registry price; SDK cost is telemetry only', async () => {
    const out = await settleInvocation(base({
      userId: 'u1', sessionId: 's1', toolExecutionCount: 2, turnCount: 3,
    }));
    expect(out).toEqual({ costCents: 300, invocationIds: ['i1'], deferred: false });
    const call = m.settleDurably.mock.calls[0]![0];
    expect(call).toMatchObject({ orgId: 'o1', reservationId: 'r1', toolExecutionCount: 2, session: { id: 's1', turnCount: 3 } });
    expect(call.invocations).toEqual([expect.objectContaining({
      costCents: 300, sdkReportedCostUsd: 9.99, fundingSource: 'platform', offeringId: 'off-1',
      requestedModel: 'claude-sonnet-5-5', servedModel: 'claude-sonnet-5-5', userId: 'u1',
      tokens: T, fallbackUsed: false,
      rateSnapshot: { source: 'platform', standard: STD }, ledgerMode: 'authoritative',
    })]);
    // W10 (#7608): the rows reach the settlement UNSTAMPED; the settlement
    // transaction stamps them (the snapshot moment is the ledger write).
    expect(call.invocations[0]).not.toHaveProperty('charge');
    expect(call.invocations[0]).not.toHaveProperty('chargeable');
    expect(call).not.toHaveProperty('actualCostCents');
    expect(m.debit).toHaveBeenCalledWith('o1', 300, { idempotencyKey: 'ai-settlement:r1' });
    expect(m.markDebited).toHaveBeenCalledWith('r1');
  });

  it('partner_key funding never touches platform credits', async () => {
    m.settleDurably.mockResolvedValue({ kind: 'settled', reservationId: 'r1', actualCostCents: 300, invocationIds: ['i1'], billingSource: 'partner_key', creditsDebitDue: false });
    await settleInvocation(base({
      binding: { ...B, funding: 'partner_key', connectionId: 'c1', connectionKind: 'anthropic_byok' }, agentRunId: 'run-1',
    }));
    expect(m.debit).not.toHaveBeenCalled();
    expect(m.settleDurably.mock.calls[0]![0]).not.toHaveProperty('session');
  });

  it('server-side fallback: two rows, refused leg at the primary rate, served leg at the fallback rate', async () => {
    await settleInvocation(base({
      sourceRef: 'x',
      usage: [use('claude-sonnet-5-5'), use('claude-haiku-4-5')],
      outcome: { ...OK, fallbackUsed: true, refusalCategory: 'cyber', servedModel: 'claude-haiku-4-5', sdkReportedCostUsd: null },
    }));
    const rows = m.settleDurably.mock.calls[0]![0].invocations as Array<{ servedModel: string; stopReason: string; fallbackUsed: boolean; costCents: number; refusalCategory: string | null }>;
    expect(rows.map((r) => [r.servedModel, r.stopReason, r.fallbackUsed, r.costCents, r.refusalCategory])).toEqual([
      ['claude-sonnet-5-5', 'refusal', false, 300, 'cyber'],
      ['claude-haiku-4-5', 'end_turn', true, 150, 'cyber'],
    ]);
  });

  it('a plain two-call retry writes two ordinary rows (no refusal / fallback labels), one settlement', async () => {
    const { messagesUsage } = await import('./invocationUsage');
    const msg = { model: 'claude-sonnet-5-5', stop_reason: 'end_turn', content: [], usage: { input_tokens: 1_000_000, output_tokens: 100_000 } } as never;
    const billed = messagesUsage(B, [
      { wireModel: 'claude-sonnet-5-5', call: 0, message: msg },
      { wireModel: 'claude-sonnet-5-5', call: 1, message: msg },
    ]);
    await settleInvocation(base({ usage: billed.usage, outcome: billed.outcome }));
    expect(m.settleDurably).toHaveBeenCalledTimes(1);
    const rows = m.settleDurably.mock.calls[0]![0].invocations as Array<{ stopReason: string; fallbackUsed: boolean; costCents: number; refusalCategory: string | null }>;
    expect(rows.map((r) => [r.stopReason, r.fallbackUsed, r.costCents, r.refusalCategory])).toEqual([
      ['end_turn', false, 300, null], ['end_turn', false, 300, null],
    ]);
  });

  it('a genuine refusal fallback in call 0 stays labelled while the retry call 1 row is ordinary', async () => {
    const { messagesUsage } = await import('./invocationUsage');
    const ok = { model: 'claude-sonnet-5-5', stop_reason: 'end_turn', content: [], usage: { input_tokens: 1_000_000, output_tokens: 100_000 } } as never;
    const refused = { ...(ok as object), stop_reason: 'refusal', stop_details: { category: 'bio' } } as never;
    const fb = { ...(ok as object), model: 'claude-haiku-4-5' } as never;
    const billed = messagesUsage(B, [
      { wireModel: 'claude-sonnet-5-5', call: 0, message: refused },
      { wireModel: 'claude-haiku-4-5', call: 0, message: fb },
      { wireModel: 'claude-sonnet-5-5', call: 1, message: ok },
    ]);
    await settleInvocation(base({ usage: billed.usage, outcome: billed.outcome }));
    const rows = m.settleDurably.mock.calls[0]![0].invocations as Array<{ stopReason: string; fallbackUsed: boolean; refusalCategory: string | null }>;
    expect(rows.map((r) => [r.stopReason, r.fallbackUsed, r.refusalCategory])).toEqual([
      ['refusal', false, 'bio'], ['end_turn', true, 'bio'], ['end_turn', false, null],
    ]);
  });

  it('a provider-reported model that differs from the billed id keeps both visible', async () => {
    await settleInvocation(base({ usage: [use('claude-haiku-4-5', { providerModel: 'claude-haiku-4-5-20251001' })] }));
    expect(m.settleDurably.mock.calls[0]![0].invocations[0]).toMatchObject({
      requestedModel: 'claude-haiku-4-5', servedModel: 'claude-haiku-4-5-20251001',
    });
  });

  it('an unbound SDK key on a platform turn is priced at its platform rate, flagged, and visible as such', async () => {
    m.getPlatformModelByModelId.mockResolvedValue({ rates: OTHER, optionRates: null });
    await settleInvocation(base({ usage: [use('claude-sonnet-4-6')], outcome: { ...OK, fallbackUsed: true, servedModel: 'claude-sonnet-4-6' } }));
    expect(m.getPlatformModelByModelId).toHaveBeenCalledWith('claude-sonnet-4-6');
    expect(m.settleDurably.mock.calls[0]![0].invocations[0]).toMatchObject({
      requestedModel: 'claude-sonnet-4-6', servedModel: 'claude-sonnet-4-6', fallbackUsed: true,
      rateSnapshot: { source: 'platform', standard: OTHER },
      costCents: priceInvocation({ source: 'platform', standard: OTHER }, T, {}),
    });
  });

  it('fast requested but standard served: the ledger records speed as not applied', async () => {
    const fastBinding: TurnBinding = { ...B, options: { effort: 'medium', speed: 'fast' }, rateSnapshot: { source: 'platform', standard: STD, option: { key: 'speed:fast', rates: FAST } } };
    await settleInvocation(base({ binding: fastBinding }));
    expect(m.settleDurably.mock.calls[0]![0].invocations[0]).toMatchObject({
      costCents: 300, optionsSent: { effort: 'medium', speed: 'standard' },
    });
  });

  it('without a reservation, rows + rollups go through recordInvocationsWithRollups and the debit is keyed by the first ledger row', async () => {
    await settleInvocation(base({ reservationId: undefined, sessionId: 's1' }));
    expect(m.settleDurably).not.toHaveBeenCalled();
    expect(m.recordWithRollups).toHaveBeenCalledWith(expect.objectContaining({ orgId: 'o1', sessionId: 's1' }));
    expect(m.debit).toHaveBeenCalledWith('o1', 300, { idempotencyKey: 'ai-invocation:i1' });
    expect(m.markDebited).not.toHaveBeenCalled();
  });
});

describe('credits are debited exactly once per reservation (finding 1)', () => {
  it('a repeated settlement of the same reservation debits once, with the reservation key', async () => {
    m.settleDurably
      .mockResolvedValueOnce({ kind: 'settled', reservationId: 'r1', actualCostCents: 300, invocationIds: ['i1'], billingSource: 'platform', creditsDebitDue: true })
      .mockResolvedValueOnce({ kind: 'already_settled', reservationId: 'r1', actualCostCents: 300, invocationIds: [], billingSource: 'platform', creditsDebitDue: false });
    await settleInvocation(base());
    await settleInvocation(base());
    expect(m.debit).toHaveBeenCalledTimes(1);
    expect(m.debit).toHaveBeenCalledWith('o1', 300, { idempotencyKey: 'ai-settlement:r1' });
    expect(m.markDebited).toHaveBeenCalledWith('r1');
  });

  it('a deferred settlement debits nothing now (the sweep replays and debits later)', async () => {
    m.settleDurably.mockResolvedValue({ kind: 'deferred_indeterminate', reservationId: 'r1', persisted: true });
    const out = await settleInvocation(base());
    expect(out.deferred).toBe(true);
    expect(m.debit).not.toHaveBeenCalled();
  });

  it('a persisted deferral is a clean deferral (not unrecorded, nothing reported)', async () => {
    m.settleDurably.mockResolvedValue({ kind: 'deferred_indeterminate', reservationId: 'r1', persisted: true });
    const out = await settleInvocation(base());
    expect(out.unrecorded).toBeFalsy();
    expect(m.captureMessage).not.toHaveBeenCalled();
  });

  it('a deferral that could NOT be persisted is reported as unrecorded spend, never as a clean deferral (review S1)', async () => {
    m.settleDurably.mockResolvedValue({ kind: 'deferred_indeterminate', reservationId: 'r1', persisted: false });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = await settleInvocation(base());
    error.mockRestore();
    expect(out).toMatchObject({ deferred: true, unrecorded: true, invocationIds: [] });
    expect(m.debit).not.toHaveBeenCalled();
    // W10 (#7608): never falls back to the no-reservation ledger write, which
    // would stamp (and so charge back) a turn whose spend is recorded nowhere.
    expect(m.recordWithRollups).not.toHaveBeenCalled();
    expect(m.captureMessage).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      eventCode: 'ai_settlement_unrecorded',
      tags: expect.objectContaining({ org_id: 'o1', ai_reservation_id: 'r1' }),
    }));
  });

  it('the debit amount is the settled amount the reservation stored (what the sweep re-sends)', async () => {
    m.settleDurably.mockResolvedValue({ kind: 'settled', reservationId: 'r1', actualCostCents: 299.999999, invocationIds: ['i1'], billingSource: 'platform', creditsDebitDue: true });
    await settleInvocation(base());
    expect(m.debit).toHaveBeenCalledWith('o1', 299.999999, { idempotencyKey: 'ai-settlement:r1' });
  });
});

describe('debitSettledCredits: 4xx terminal, 5xx/network retried under the same key', () => {
  it('a 4xx rejection is stamped failed, never retried, and reported with an eventCode', async () => {
    m.debit.mockResolvedValue({ kind: 'rejected', status: 409, code: 'http_409:idempotency_key_reused' });
    await debitSettledCredits({ orgId: 'o1', reservationId: 'r1', costCents: 300 });
    expect(m.recordFailure).toHaveBeenCalledWith('r1', 'http_409:idempotency_key_reused');
    expect(m.recordRetry).not.toHaveBeenCalled();
    expect(m.markDebited).not.toHaveBeenCalled();
    expect(m.captureMessage).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      eventCode: 'ai_credit_debit_rejected', tags: expect.objectContaining({ ai_billing_http_status: '409' }),
    }));
  });

  it.each([
    [{ kind: 'retryable', status: 503, code: 'http_503:deduct_unconfirmed' }],
    [{ kind: 'retryable', status: 500, code: 'http_500:internal_error' }],
    [{ kind: 'retryable', status: null, code: 'transport' }],
  ])('a retryable failure (%o) is counted, not stamped failed, not reported', async (result) => {
    m.debit.mockResolvedValue(result);
    await debitSettledCredits({ orgId: 'o1', reservationId: 'r1', costCents: 300 });
    expect(m.recordRetry).toHaveBeenCalledWith('r1', result.code);
    expect(m.recordFailure).not.toHaveBeenCalled();
    expect(m.markDebited).not.toHaveBeenCalled();
    expect(m.captureMessage).not.toHaveBeenCalled();
  });

  it('retries exhausted → reported with its own eventCode', async () => {
    m.debit.mockResolvedValue({ kind: 'retryable', status: 503, code: 'http_503:deduct_unconfirmed' });
    m.recordRetry.mockResolvedValue({ attempts: 24, exhausted: true });
    await debitSettledCredits({ orgId: 'o1', reservationId: 'r1', costCents: 300 });
    expect(m.captureMessage).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ eventCode: 'ai_credit_debit_retries_exhausted' }));
  });

  it('no billing service configured → nothing stamped either way', async () => {
    m.debit.mockResolvedValue({ kind: 'not_configured' });
    await debitSettledCredits({ orgId: 'o1', reservationId: 'r1', costCents: 300 });
    expect(m.markDebited).not.toHaveBeenCalled();
    expect(m.recordFailure).not.toHaveBeenCalled();
    expect(m.recordRetry).not.toHaveBeenCalled();
  });

  it('never throws: a failing stamp is reported (scrubbed) and the sweep retries later', async () => {
    m.markDebited.mockRejectedValue(Object.assign(new Error('Failed query: UPDATE ... params: secret'), { params: ['secret'] }));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(debitSettledCredits({ orgId: 'o1', reservationId: 'r1', costCents: 300 })).resolves.toBeUndefined();
    const logged = JSON.stringify(error.mock.calls);
    expect(logged).not.toContain('secret');
    error.mockRestore();
  });
});

describe('unreserved debit reporting (review S4)', () => {
  it('throttles per (eventCode, org), not globally, and tags the first ledger row so an operator can recover it', async () => {
    m.debit.mockResolvedValue({ kind: 'rejected', status: 409, code: 'http_409:x' });
    m.recordWithRollups.mockResolvedValueOnce(['i-o1']).mockResolvedValueOnce(['i-o2']).mockResolvedValueOnce(['i-o1b']);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await settleInvocation(base({ reservationId: undefined, orgId: 'o1' }));
    await settleInvocation(base({ reservationId: undefined, orgId: 'o2' }));
    await settleInvocation(base({ reservationId: undefined, orgId: 'o1' }));   // same org inside the window: log only
    error.mockRestore();
    const reports = m.captureMessage.mock.calls.filter(([, o]) => o.eventCode === 'ai_credit_debit_rejected');
    expect(reports).toHaveLength(2);
    expect(reports.map(([, o]) => o.tags)).toEqual([
      expect.objectContaining({ org_id: 'o1', ai_invocation_id: 'i-o1' }),
      expect.objectContaining({ org_id: 'o2', ai_invocation_id: 'i-o2' }),
    ]);
  });

  it('a thrown unreserved debit is reported with the org and first ledger row', async () => {
    m.debit.mockRejectedValue(new Error('socket hang up'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await settleInvocation(base({ reservationId: undefined }));
    error.mockRestore();
    expect(m.captureException).toHaveBeenCalledWith(expect.any(Error), undefined, expect.objectContaining({
      org_id: 'o1', ai_invocation_id: 'i1',
    }));
  });

  it('the settled-debit rejection throttle is per org too', async () => {
    m.debit.mockResolvedValue({ kind: 'rejected', status: 409, code: 'http_409:x' });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await debitSettledCredits({ orgId: 'o1', reservationId: 'r1', costCents: 1 });
    await debitSettledCredits({ orgId: 'o2', reservationId: 'r2', costCents: 1 });
    error.mockRestore();
    expect(m.captureMessage.mock.calls.filter(([, o]) => o.eventCode === 'ai_credit_debit_rejected')).toHaveLength(2);
  });
});

describe('SDK usage snapshot (W05 spike)', () => {
  const NEXT: SdkUsageSnapshot = { version: 1, models: { 'claude-sonnet-5-5': { tokens: T, webSearchRequests: 0 } } };

  it('passes the next snapshot into the SAME settlement call (advanced in its transaction)', async () => {
    await settleInvocation(base({ sessionId: 's1', sdkUsage: { sessionId: 's1', nextSnapshot: NEXT, usageConfirmed: true, usageNote: 'delta' } }));
    expect(m.settleDurably.mock.calls[0]![0].sdkUsage).toEqual({ sessionId: 's1', nextSnapshot: NEXT });
  });

  it('a rebaseline carries the snapshot it was computed against, so a late replay can tell it is stale (review S10)', async () => {
    const PREV: SdkUsageSnapshot = { version: 1, models: { 'claude-sonnet-5-5': { tokens: { ...T, input: T.input * 2 }, webSearchRequests: 0 } } };
    await settleInvocation(base({ sessionId: 's1', usage: [], sdkUsage: {
      sessionId: 's1', nextSnapshot: NEXT, baseSnapshot: PREV, usageConfirmed: false, usageNote: 'snapshot_regressed',
    } }));
    expect(m.settleDurably.mock.calls[0]![0].sdkUsage).toEqual({ sessionId: 's1', nextSnapshot: NEXT, rebaseline: true, baseSnapshot: PREV });
  });

  it('snapshot_regressed is reported to Sentry with its eventCode', async () => {
    await settleInvocation(base({ usage: [], sdkUsage: { sessionId: 's1', nextSnapshot: NEXT, usageConfirmed: false, usageNote: 'snapshot_regressed' } }));
    expect(m.captureMessage).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ eventCode: 'ai_usage_snapshot_regressed' }));
  });

  it('any other unconfirmed usage is a structured warning, not a Sentry event', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await settleInvocation(base({ usage: [], sdkUsage: { sessionId: 's1', nextSnapshot: null, usageConfirmed: false, usageNote: 'no_result' } }));
    expect(m.captureMessage).not.toHaveBeenCalled();
    expect(warn.mock.calls.flat().join(' ')).toContain('ai_usage_unconfirmed');
    warn.mockRestore();
  });
});

describe('priceUsage: carried rates across a switch (W05 spike constraint 4)', () => {
  const HAIKU_RATE = { source: 'linked_platform' as const, standard: { inputCentsPerM: 100, outputCentsPerM: 500, cacheReadCentsPerM: 10, cacheWriteCentsPerM: 125 } };
  it('a BYOK delta under the previous model\'s key is billed at the previous model\'s rate, not the bound one', () => {
    const binding = withCarriedRates(turnBindingFrom(makeResolvedModel('anthropic_byok')), [
      { wireModel: 'claude-haiku-4-5', rateSnapshot: HAIKU_RATE },
    ]);
    const [row] = priceUsage(binding, [{
      model: 'claude-haiku-4-5', tokens: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
      webSearchRequests: 0, speedServed: 'standard', providerModel: null,
    }]);
    expect(row!.rate).toBe(HAIKU_RATE);
    expect(row!.costCents).toBe(100);
    expect(row!.unboundModel).toBe(false);   // a carried model is not a fallback
  });
});

describe('W11 prompt provenance', () => {
  const input = (over: Partial<SettleInvocationInput> = {}): SettleInvocationInput => ({
    binding: { ...B, promptProfile: 'claude-standard' }, orgId: 'org-1', userId: null, sessionId: 's1', agentRunId: null,
    sourceRef: null, usage: [use('claude-sonnet-5-5')], outcome: OK, ...over,
  });
  const rowsOf = (i: SettleInvocationInput) => toNewInvocations(i, priceUsage(i.binding, i.usage));

  it('a one-shot surface records the binding profile and no variant', () => {
    expect(rowsOf(input())[0]).toMatchObject({ promptProfile: 'claude-standard', promptVariant: null });
  });
  it('the live query provenance wins over the binding (a reused query keeps its prompt)', () => {
    const rows = rowsOf(input({ binding: { ...B, promptProfile: 'claude-standard' }, prompt: { profile: 'claude-frontier', variant: 'chat/claude-frontier@1' } }));
    expect(rows[0]).toMatchObject({ promptProfile: 'claude-frontier', promptVariant: 'chat/claude-frontier@1' });
  });
  it('every leg of a refusal-fallback turn carries the same provenance', () => {
    const rows = rowsOf(input({
      usage: [use('claude-sonnet-5-5'), use('claude-haiku-4-5')],
      outcome: { ...OK, fallbackUsed: true, refused: true, stopReason: 'end_turn', refusalCategory: 'cyber' },
      prompt: { profile: 'claude-standard', variant: null },
    }));
    expect(rows.map((r) => [r.promptProfile, r.promptVariant])).toEqual([['claude-standard', null], ['claude-standard', null]]);
  });
  it('drops a variant that does not match the bound surface (never hands the CHECK a row it rejects)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rows = rowsOf(input({ binding: { ...B, surface: 'helper' }, prompt: { profile: 'claude-frontier', variant: 'chat/claude-frontier@1' } }));
    expect(rows[0]).toMatchObject({ promptProfile: 'claude-frontier', promptVariant: null });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('prompt variant does not match'), expect.anything());
    // Gate G3 reads Sentry: the drop must be reported there, not only logged.
    expect(m.captureMessage).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ eventCode: 'ai_prompt_variant_mismatch' }));
    warn.mockRestore();
  });
  it('a matching variant reports nothing to Sentry', () => {
    rowsOf(input({ prompt: { profile: 'claude-standard', variant: 'chat/claude-standard@1' } }));
    expect(m.captureMessage).not.toHaveBeenCalled();
  });
  it.each([
    ['another profile', 'chat/claude-small@1', 'chat', 'claude-frontier'],
    ['generic', 'chat/claude-small@1', 'chat', 'generic'],
    ['no profile', 'chat/claude-small@1', 'chat', null],
    ['a malformed id', 'claude-small', 'chat', 'claude-small'],
  ] as const)('consistentPromptVariant drops %s', (_n, variant, surface, profile) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(consistentPromptVariant(variant, surface, profile)).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
  it('consistentPromptVariant keeps a variant that matches its surface and profile', () => {
    expect(consistentPromptVariant('chat/claude-small@1', 'chat', 'claude-small')).toBe('chat/claude-small@1');
    expect(consistentPromptVariant(null, 'chat', 'claude-small')).toBeNull();
  });
  it('stamps one occurredAt on every leg of a settlement (the turn time a deferred replay keeps)', () => {
    const at = new Date('2026-09-15T12:00:00Z');
    const rows = rowsOf(input({ usage: [use('claude-sonnet-5-5'), use('claude-haiku-4-5')], occurredAt: at }));
    expect(rows.map((r) => r.occurredAt)).toEqual([at, at]);
    const stamped = rowsOf(input({ usage: [use('claude-sonnet-5-5'), use('claude-haiku-4-5')] }));
    expect(stamped[0]!.occurredAt).toBeInstanceOf(Date);
    expect(stamped[1]!.occurredAt).toBe(stamped[0]!.occurredAt);
  });
  it('a binding persisted before W11 (no promptProfile) records NULL', () => {
    const { promptProfile: _p, ...legacy } = { ...B, promptProfile: undefined };
    expect(rowsOf(input({ binding: legacy as typeof B }))[0]).toMatchObject({ promptProfile: null, promptVariant: null });
  });
  it('settleInvocation hands the reservation settlement rows carrying the provenance', async () => {
    await settleInvocation(base({ binding: { ...B, promptProfile: 'claude-small' }, prompt: { profile: 'claude-small', variant: 'chat/claude-small@1' } }));
    expect(m.settleDurably.mock.calls[0]![0].invocations).toEqual([expect.objectContaining({
      promptProfile: 'claude-small', promptVariant: 'chat/claude-small@1', occurredAt: expect.any(Date),
    })]);
  });
});

describe('W09 ledger provenance', () => {
  const noUsageOutcome = (servedModel: string): TurnOutcome => ({
    stopReason: 'end_turn', refused: false, refusalCategory: null, fallbackUsed: false,
    servedModel, providerModel: null, sdkReportedCostUsd: null, fastDowngraded: false,
  });

  it('toNewInvocations writes the SERVED hop\'s offering, connection and funding, plus where it failed over from', () => {
    const binding = turnBindingFrom(makeResolvedModel('anthropic_byok', {
      offering: { id: 'off-k', displayName: 'K' },
      failover: { fromOfferingId: 'off-p', hop: 1, cause: 'rate_limited' },
    }));
    const [row] = toNewInvocations({
      binding, orgId: 'org-1', userId: null, sessionId: null, agentRunId: null, sourceRef: null,
      usage: [], outcome: noUsageOutcome(binding.wireModel),
    }, priceUsage(binding, []));
    expect(row).toMatchObject({
      offeringId: 'off-k', connectionId: 'conn-1', fundingSource: 'partner_key',
      failoverFromOfferingId: 'off-p', failoverHop: 1, failoverCause: 'rate_limited',
    });
  });

  it('a turn with no failover writes hop 0 and no cause', () => {
    const binding = turnBindingFrom(makeResolvedModel('platform'));
    const [row] = toNewInvocations({
      binding, orgId: 'org-1', userId: null, sessionId: null, agentRunId: null, sourceRef: null,
      usage: [], outcome: noUsageOutcome(binding.wireModel),
    }, priceUsage(binding, []));
    expect(row).toMatchObject({ failoverFromOfferingId: null, failoverHop: 0, failoverCause: null });
  });
});

// #7773 (#7766 residual): the CLI swaps a BYOK turn to a model the binding
// never named (on the Agent SDK, resolveModel drops a refusal fallback priced
// differently from the primary, so this is the common BYOK case).
describe('unbound BYOK refusal fallback priced at its own offering rate (#7773)', () => {
  const BYOK: TurnBinding = {
    ...B, funding: 'partner_key', connectionId: 'c1', connectionKind: 'anthropic_byok',
    rateSnapshot: { source: 'linked_platform', standard: STD }, refusalFallback: null,
  };
  const OWN_RATE = { source: 'offering' as const, standard: OTHER };
  const swapped = { ...OK, fallbackUsed: true, servedModel: 'claude-sonnet-4-6' };

  it('priceUsage bills an unbound BYOK key at its connection offering rate, flagged', () => {
    const [p] = priceUsage(BYOK, [use('claude-sonnet-4-6')], { connectionRates: new Map([['claude-sonnet-4-6', OWN_RATE]]) });
    expect(p!.rate).toBe(OWN_RATE);
    expect(p!.costCents).toBe(priceInvocation(OWN_RATE, T, {}));
    expect(p!.unboundModel).toBe(true);
  });

  it('a connection rate never prices a platform turn, and a platform rate never prices a BYOK turn', () => {
    expect(priceUsage(B, [use('claude-sonnet-4-6')], { connectionRates: new Map([['claude-sonnet-4-6', OWN_RATE]]) })[0])
      .toMatchObject({ costCents: 300, rate: B.rateSnapshot });
    expect(priceUsage(BYOK, [use('claude-sonnet-4-6')], { platformRates: new Map([['claude-sonnet-4-6', { source: 'platform', standard: OTHER }]]) })[0])
      .toMatchObject({ costCents: 300, rate: BYOK.rateSnapshot });
  });

  it('settleInvocation reads the rate on the binding\'s own connection and writes it on the ledger row', async () => {
    m.readConnectionOfferingRate.mockResolvedValue({ rate: OWN_RATE, offeringId: 'off-own' });
    m.settleDurably.mockResolvedValue({ kind: 'settled', reservationId: 'r1', actualCostCents: 450, invocationIds: ['i1'], billingSource: 'partner_key', creditsDebitDue: false });
    const out = await settleInvocation(base({ binding: BYOK, usage: [use('claude-sonnet-4-6')], outcome: swapped }));
    expect(m.readConnectionOfferingRate).toHaveBeenCalledWith({
      partnerId: 'p1', connectionId: 'c1', connectionKind: 'anthropic_byok', model: 'claude-sonnet-4-6',
    });
    // Pre-settlement read: its own short system context, never the request's.
    expect(m.withSystemDbAccessContext).toHaveBeenCalledTimes(1);
    expect(m.getPlatformModelByModelId).not.toHaveBeenCalled();
    expect(m.settleDurably.mock.calls[0]![0].invocations[0]).toMatchObject({
      requestedModel: 'claude-sonnet-4-6', fundingSource: 'partner_key', fallbackUsed: true,
      rateSnapshot: OWN_RATE, costCents: priceInvocation(OWN_RATE, T, {}),
    });
    expect(out.costCents).toBe(priceInvocation(OWN_RATE, T, {}));
    expect(m.debit).not.toHaveBeenCalled();
  });

  it('only unbound keys are looked up: the bound model is never re-read', async () => {
    m.readConnectionOfferingRate.mockResolvedValue({ rate: OWN_RATE, offeringId: 'off-own' });
    await settleInvocation(base({ binding: BYOK, usage: [use('claude-sonnet-5-5'), use('claude-sonnet-4-6')], outcome: swapped }));
    expect(m.readConnectionOfferingRate).toHaveBeenCalledTimes(1);
  });

  it('no enabled priced offering on the connection → the bound (primary) rate, and the reason is recorded', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    m.readConnectionOfferingRate.mockResolvedValue({ rate: null, reason: 'no_enabled_offering' });
    await settleInvocation(base({ binding: BYOK, usage: [use('claude-sonnet-4-6')], outcome: swapped }));
    expect(m.settleDurably.mock.calls[0]![0].invocations[0]).toMatchObject({
      requestedModel: 'claude-sonnet-4-6', fallbackUsed: true, rateSnapshot: BYOK.rateSnapshot, costCents: 300,
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('bound rate'), expect.objectContaining({
      eventCode: 'ai_unbound_byok_rate_bound_fallback', model: 'claude-sonnet-4-6', reason: 'no_enabled_offering',
    }));
    warn.mockRestore();
  });

  it('a failing rate read never fails the turn: bound rate, reason lookup_failed', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    m.readConnectionOfferingRate.mockRejectedValue(new Error('db down'));
    await expect(settleInvocation(base({ binding: BYOK, usage: [use('claude-sonnet-4-6')], outcome: swapped })))
      .resolves.toMatchObject({ costCents: 300 });
    expect(err).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ reason: 'lookup_failed', model: 'claude-sonnet-4-6' }));
    err.mockRestore();
  });

  it('a platform turn is unchanged: platform row lookup, no connection read', async () => {
    m.getPlatformModelByModelId.mockResolvedValue({ rates: OTHER, optionRates: null });
    await settleInvocation(base({ usage: [use('claude-sonnet-4-6')], outcome: swapped }));
    expect(m.readConnectionOfferingRate).not.toHaveBeenCalled();
    expect(m.settleDurably.mock.calls[0]![0].invocations[0]).toMatchObject({ rateSnapshot: { source: 'platform', standard: OTHER } });
  });

  it('with a reservationId, attests the read rate on the reservation and prices at the RETURNED entry (first write wins)', async () => {
    const STORED = { source: 'offering' as const, standard: { ...OTHER, inputCentsPerM: OTHER.inputCentsPerM + 7 } };
    m.readConnectionOfferingRate.mockResolvedValue({ rate: OWN_RATE, offeringId: 'off-own' });
    m.attestUnboundRate.mockResolvedValue({ connectionId: 'c1', offeringId: 'off-stored', rate: STORED });
    await settleInvocation(base({ binding: BYOK, usage: [use('claude-sonnet-4-6')], outcome: swapped }));
    expect(m.attestUnboundRate).toHaveBeenCalledTimes(1);
    expect(m.attestUnboundRate).toHaveBeenCalledWith({
      orgId: 'o1', reservationId: 'r1', model: 'claude-sonnet-4-6',
      attestation: { connectionId: BYOK.connectionId, offeringId: 'off-own', rate: OWN_RATE },
    });
    expect(m.settleDurably.mock.calls[0]![0].invocations[0]).toMatchObject({
      rateSnapshot: STORED, costCents: priceInvocation(STORED, T, {}),
    });
  });

  it('attestUnboundRate returning null (reservation not settleable) -> bound rate, reason recorded', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    m.readConnectionOfferingRate.mockResolvedValue({ rate: OWN_RATE, offeringId: 'off-own' });
    m.attestUnboundRate.mockResolvedValue(null);
    await settleInvocation(base({ binding: BYOK, usage: [use('claude-sonnet-4-6')], outcome: swapped }));
    expect(m.settleDurably.mock.calls[0]![0].invocations[0]).toMatchObject({ rateSnapshot: BYOK.rateSnapshot, costCents: 300 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('bound rate'), expect.objectContaining({
      eventCode: 'ai_unbound_byok_rate_bound_fallback', model: 'claude-sonnet-4-6', reason: 'reservation_not_settleable',
    }));
    warn.mockRestore();
  });

  it('attestUnboundRate throwing never fails the turn: bound rate, reason lookup_failed', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    m.readConnectionOfferingRate.mockResolvedValue({ rate: OWN_RATE, offeringId: 'off-own' });
    m.attestUnboundRate.mockRejectedValue(new Error('lock timeout'));
    await expect(settleInvocation(base({ binding: BYOK, usage: [use('claude-sonnet-4-6')], outcome: swapped })))
      .resolves.toMatchObject({ costCents: 300 });
    expect(err).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ reason: 'lookup_failed', model: 'claude-sonnet-4-6' }));
    err.mockRestore();
  });

  it('no reservationId -> nothing attested; quoteInvocationCents never attests', async () => {
    m.readConnectionOfferingRate.mockResolvedValue({ rate: OWN_RATE, offeringId: 'off-own' });
    await settleInvocation(base({ binding: BYOK, usage: [use('claude-sonnet-4-6')], outcome: swapped, reservationId: undefined }));
    await quoteInvocationCents(BYOK, [use('claude-sonnet-4-6')]);
    expect(m.attestUnboundRate).not.toHaveBeenCalled();
  });

  it('an existing attestation is returned without a live read or a new attestation', async () => {
    const STORED = { source: 'offering' as const, standard: { ...OTHER, inputCentsPerM: OTHER.inputCentsPerM + 3 } };
    m.readUnboundRateAttestation.mockResolvedValue({ connectionId: 'c1', offeringId: 'off-s', rate: STORED });
    await settleInvocation(base({ binding: BYOK, usage: [use('claude-sonnet-4-6')], outcome: swapped }));
    expect(m.readUnboundRateAttestation).toHaveBeenCalledWith({
      orgId: 'o1', reservationId: 'r1', connectionId: 'c1', model: 'claude-sonnet-4-6',
    });
    expect(m.readConnectionOfferingRate).not.toHaveBeenCalled();
    expect(m.attestUnboundRate).not.toHaveBeenCalled();
    expect(m.settleDurably.mock.calls[0]![0].invocations[0]).toMatchObject({
      rateSnapshot: STORED, costCents: priceInvocation(STORED, T, {}),
    });
  });

  it('an existing null-rate attestation prices the bound rate, reason attested_bound_rate', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    m.readUnboundRateAttestation.mockResolvedValue({ connectionId: 'c1', offeringId: null, rate: null });
    await settleInvocation(base({ binding: BYOK, usage: [use('claude-sonnet-4-6')], outcome: swapped }));
    expect(m.readConnectionOfferingRate).not.toHaveBeenCalled();
    expect(m.attestUnboundRate).not.toHaveBeenCalled();
    expect(m.settleDurably.mock.calls[0]![0].invocations[0]).toMatchObject({ rateSnapshot: BYOK.rateSnapshot, costCents: 300 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('bound rate'), expect.objectContaining({
      eventCode: 'ai_unbound_byok_rate_bound_fallback', reason: 'attested_bound_rate',
    }));
    warn.mockRestore();
  });

  it('a miss with a reservation is attested too, as { offeringId: null, rate: null }', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    m.readConnectionOfferingRate.mockResolvedValue({ rate: null, reason: 'no_enabled_offering' });
    await settleInvocation(base({ binding: BYOK, usage: [use('claude-sonnet-4-6')], outcome: swapped }));
    expect(m.attestUnboundRate).toHaveBeenCalledWith({
      orgId: 'o1', reservationId: 'r1', model: 'claude-sonnet-4-6',
      attestation: { connectionId: 'c1', offeringId: null, rate: null },
    });
    expect(m.settleDurably.mock.calls[0]![0].invocations[0]).toMatchObject({ rateSnapshot: BYOK.rateSnapshot, costCents: 300 });
    warn.mockRestore();
  });

  it('quoteInvocationCents with a reservation reads and attests; without one it does neither', async () => {
    m.readConnectionOfferingRate.mockResolvedValue({ rate: OWN_RATE, offeringId: 'off-own' });
    await quoteInvocationCents(BYOK, [use('claude-sonnet-4-6')], { orgId: 'o1', reservationId: 'r1' });
    expect(m.readUnboundRateAttestation).toHaveBeenCalledTimes(1);
    expect(m.attestUnboundRate).toHaveBeenCalledTimes(1);
    vi.clearAllMocks();
    m.readConnectionOfferingRate.mockResolvedValue({ rate: OWN_RATE, offeringId: 'off-own' });
    m.withSystemDbAccessContext.mockImplementation((fn: () => unknown) => fn());
    await quoteInvocationCents(BYOK, [use('claude-sonnet-4-6')]);
    expect(m.readUnboundRateAttestation).not.toHaveBeenCalled();
    expect(m.attestUnboundRate).not.toHaveBeenCalled();
  });

  it('quoteInvocationCents quotes the same number settleInvocation bills', async () => {
    m.readConnectionOfferingRate.mockResolvedValue({ rate: OWN_RATE, offeringId: 'off-own' });
    await expect(quoteInvocationCents(BYOK, [use('claude-sonnet-4-6')])).resolves.toBe(priceInvocation(OWN_RATE, T, {}));
  });
});
