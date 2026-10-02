import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  settleDurably: vi.fn(),
  recordWithRollups: vi.fn(),
  markDebited: vi.fn(),
  recordFailure: vi.fn(),
  recordRetry: vi.fn(),
  debit: vi.fn(),
  getPlatformModelByModelId: vi.fn(),
  captureMessage: vi.fn(),
  captureException: vi.fn(),
  checkCostAnomalies: vi.fn(),
}));
vi.mock('../aiBudgetReservations', () => ({
  settleAiBudgetReservationDurably: m.settleDurably,
  recordInvocationsWithRollups: m.recordWithRollups,
  markCreditsDebited: m.markDebited,
  recordCreditDebitFailure: m.recordFailure,
  recordCreditDebitRetry: m.recordRetry,
  creditDebitIdempotencyKey: (id: string) => `ai-settlement:${id}`,
}));
vi.mock('../aiCostTracker', () => ({ debitBillingCredits: m.debit, checkCostAnomalies: m.checkCostAnomalies }));
vi.mock('./platformModels', () => ({ getPlatformModelByModelId: m.getPlatformModelByModelId }));
vi.mock('../sentry', () => ({ captureMessage: m.captureMessage, captureException: m.captureException }));
vi.mock('../../db', () => ({ runOutsideDbContext: (fn: () => unknown) => fn() }));

import type { BilledUsage, SdkUsageSnapshot, TurnOutcome } from './invocationUsage';
import { priceInvocation } from './pricing';
import {
  WEB_SEARCH_COST_CENTS,
  costEstimator,
  debitSettledCredits,
  priceUsage,
  settleInvocation,
  __resetSettleInvocationReportsForTests,
  type SettleInvocationInput,
} from './settleInvocation';
import type { TurnBinding } from './turnBinding';

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
  servedModel: 'claude-sonnet-5-5', providerModel: null, sdkReportedCostUsd: 9.99,
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
