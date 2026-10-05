/**
 * #3095 / #7667 / W03 Task 7 — how an Agent SDK turn's usage reaches the
 * ledger.
 *
 * #3095: settlement uses the session's canonical org (the ai_sessions row),
 * never `auth.orgId` (null for partner- and system-scoped technicians).
 * #7667: `total_cost_usd` is a running total. W03 removes it from billing
 * entirely: every turn settles through settleInvocation at the registry rate
 * bound to the turn, over the per-model DELTA of the SDK's cumulative
 * `modelUsage` against the breeze session's persisted snapshot (W05 spike).
 * The assistant-message accumulator is no longer a billing source; an
 * abandoned turn settles ZERO as `no_result` and leaves the snapshot alone,
 * so a resumed query's next delta recovers whatever the CLI persisted.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import type { SdkUsageSnapshot } from './aiModels/invocationUsage';

const m = vi.hoisted(() => ({
  queryMock: vi.fn(),
  settleInvocation: vi.fn(),
  snapshots: new Map<string, unknown>(),
  readSdkUsageSnapshot: vi.fn(),
  markIndeterminate: vi.fn(() => Promise.resolve()),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: m.queryMock }));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([])),
        })),
      })),
    })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })) })),
    insert: vi.fn(() => ({ values: vi.fn(() => Promise.resolve()) })),
  },
  withDbAccessContext: vi.fn((_ctx: unknown, fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
}));
vi.mock('../db/dbWriteExpectingRows', () => ({ dbWriteExpectingRows: vi.fn(async () => undefined) }));
vi.mock('./aiBudgetReservations', () => ({
  markAiBudgetReservationIndeterminate: m.markIndeterminate,
  readSdkUsageSnapshot: m.readSdkUsageSnapshot,
}));
vi.mock('./aiModels/platformModels', async (orig) => ({
  ...(await orig<typeof import('./aiModels/platformModels')>()),
  getPlatformModelByModelId: vi.fn(async () => null),
}));
vi.mock('./aiModels/settleInvocation', async (orig) => ({
  ...(await orig<typeof import('./aiModels/settleInvocation')>()),
  settleInvocation: m.settleInvocation,
}));
vi.mock('./aiAgent', () => ({ sanitizeErrorForClient: (e: unknown) => String(e) }));
vi.mock('./sentry', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('./aiAgentSdkTools', () => ({
  createBreezeMcpServer: vi.fn(() => ({ type: 'sdk' })),
  BREEZE_MCP_TOOL_NAMES: ['mcp__breeze__query_devices'],
}));
vi.mock('./aiAgentSdk', () => ({
  createSessionPreToolUse: vi.fn(() => vi.fn()),
  createSessionPostToolUse: vi.fn(() => vi.fn()),
}));
vi.mock('./aiToolOutput', () => ({
  redactAiToolOutputText: (s: string) => s,
  redactSensitiveToolInput: (i: unknown) => i,
}));
vi.mock('./clientIp', () => ({ getTrustedClientIpOrUndefined: () => undefined }));
vi.mock('./toolSources/resolver', () => ({ resolveTenantTools: vi.fn(async () => []) }));

import { StreamingSessionManager } from './streamingSessionManager';
import type { AuthContext } from '../middleware/auth';
import { makeResolvedModel } from './aiModels/__fixtures__/resolvedModel';
import { priceUsage, sumCostCents, type SettleInvocationInput } from './aiModels/settleInvocation';
import { scriptedQuery, sdkResult } from './__testutils__/streamingSessionManagerHarness';

const ORG = '0c0c0c0c-1111-4222-8333-444455556666';
const SONNET = 'claude-sonnet-5-5';

const DB_SESSION = {
  orgId: ORG,
  sdkSessionId: null as string | null,
  maxTurns: 50,
  turnCount: 0,
  systemPrompt: null,
};

/** Partner-scoped technician: orgId is null on the auth context (the #3095 trigger). */
const PARTNER_AUTH = {
  orgId: null,
  partnerId: 'aaaaaaaa-1111-4222-8333-444455556666',
  scope: 'partner',
  accessibleOrgIds: [ORG],
  user: { id: 'beefbeef-1111-4222-8333-444455556666', email: 'tech@msp.example.com' },
} as unknown as AuthContext;

/** Registry cents for SONNET at FIXTURE_STD_RATES (200 / 1000 / 20 / 250 cents per M). */
function cents(input: number, output: number, cacheRead = 0, cacheWrite = 0): number {
  return (input * 200 + output * 1000 + cacheRead * 20 + cacheWrite * 250) / 1e6;
}

function assistantMsg(usage: Record<string, number>, text = 'hello') {
  return { type: 'assistant', message: { content: [{ type: 'text', text }], usage } };
}

/** A result whose cumulative modelUsage for SONNET is (input, output). */
function result(input: number, output: number, extra: Parameters<typeof sdkResult>[0] = {}) {
  return sdkResult({
    usage: { input_tokens: input, output_tokens: output },
    modelUsage: { [SONNET]: { inputTokens: input, outputTokens: output } },
    ...extra,
  });
}

function snap(input: number, output: number): SdkUsageSnapshot {
  return {
    version: 1,
    models: { [SONNET]: { tokens: { input, output, cacheRead: 0, cacheWrite: 0 }, webSearchRequests: 0 } },
  };
}

function settles(): SettleInvocationInput[] {
  return m.settleInvocation.mock.calls.map((c) => c[0] as SettleInvocationInput);
}

let manager: StreamingSessionManager;

beforeEach(() => {
  vi.clearAllMocks();
  m.snapshots.clear();
  m.readSdkUsageSnapshot.mockImplementation(async ({ sessionId }: { sessionId: string }) =>
    (m.snapshots.get(sessionId) as SdkUsageSnapshot | undefined) ?? null);
  m.settleInvocation.mockImplementation(async (input: SettleInvocationInput) => {
    if (input.sdkUsage?.nextSnapshot) m.snapshots.set(input.sdkUsage.sessionId, input.sdkUsage.nextSnapshot);
    return { costCents: sumCostCents(priceUsage(input.binding, input.usage)), invocationIds: ['i1'], deferred: false };
  });
  manager = new StreamingSessionManager();
});

afterEach(() => {
  manager.shutdown();
});

/**
 * Run one scripted query to completion. The gate holds the stream until the
 * per-user hook is attached (Office sessions attach it after getOrCreate).
 */
async function runSession(
  sessionId: string,
  messages: unknown[],
  opts: {
    resolved?: ReturnType<typeof makeResolvedModel>;
    budgetReservationId?: string;
    sdkSessionId?: string | null;
    withExtra?: boolean;
  } = {},
) {
  let releaseGate!: () => void;
  const gate = new Promise<void>((r) => (releaseGate = r));
  m.queryMock.mockImplementation(() => scriptedQuery(messages, gate));
  const session = await manager.getOrCreate(
    sessionId,
    { ...DB_SESSION, sdkSessionId: opts.sdkSessionId ?? null },
    PARTNER_AUTH,
    undefined,
    'PROMPT',
    undefined,
    opts.resolved ?? makeResolvedModel('platform'),
    undefined,
    undefined,
    opts.budgetReservationId ? { budgetReservationId: opts.budgetReservationId } : undefined,
  );
  const recordExtraUsage = vi.fn(
    (_u: { inputTokens: number; outputTokens: number; costCents: number }) => Promise.resolve(),
  );
  if (opts.withExtra) session.recordExtraUsage = recordExtraUsage;
  releaseGate();
  await session.processorPromise;
  const doneUsage = session.eventBus
    .getReplayEvents()
    .filter((e: any) => e.type === 'done' && e.usage)
    .map((e: any) => e.usage as { inputTokens: number; outputTokens: number; costCents: number });
  return { session, recordExtraUsage, doneUsage };
}

describe('result settlement — partner-scoped sessions (#3095)', () => {
  it('threads a durable reservation into the settlement', async () => {
    await runSession('sess-reserved', [result(100, 50)], { budgetReservationId: '77777777-7777-4777-8777-777777777777' });

    expect(settles()).toHaveLength(1);
    expect(settles()[0]).toMatchObject({
      sessionId: 'sess-reserved', orgId: ORG, reservationId: '77777777-7777-4777-8777-777777777777',
    });
    expect(m.markIndeterminate).not.toHaveBeenCalled();
  });

  it('a provider exit with no result settles the reservation at ZERO as no_result (released, not held)', async () => {
    await runSession('sess-unknown', [], { budgetReservationId: '77777777-7777-4777-8777-777777777777' });

    expect(settles()).toHaveLength(1);
    expect(settles()[0]).toMatchObject({
      reservationId: '77777777-7777-4777-8777-777777777777',
      usage: [],
      sourceRef: 'abandoned_turn',
      sdkUsage: { nextSnapshot: null, usageConfirmed: false, usageNote: 'no_result' },
    });
    expect(m.markIndeterminate).not.toHaveBeenCalled();
  });

  it('retains the reservation as indeterminate only when that zero settlement itself fails', async () => {
    m.settleInvocation.mockRejectedValueOnce(new Error('db down'));
    await runSession('sess-unknown-fail', [], { budgetReservationId: '77777777-7777-4777-8777-777777777777' });

    expect(m.markIndeterminate).toHaveBeenCalledWith({
      orgId: ORG,
      reservationId: '77777777-7777-4777-8777-777777777777',
    });
  });

  it('settles a BYOK session with the binding\'s partner_key funding', async () => {
    await runSession('sess-byok', [result(100, 50)], { resolved: makeResolvedModel('anthropic_byok') });

    expect(settles()[0]!.binding).toMatchObject({ funding: 'partner_key', connectionId: 'conn-1' });
  });

  it('settles on the canonical session orgId even when auth.orgId is null, with no ledger user by default', async () => {
    await runSession('sess-partner', [result(100, 50)]);

    expect(settles()).toHaveLength(1);
    expect(settles()[0]).toMatchObject({
      orgId: ORG,
      userId: null,
      usage: [expect.objectContaining({ model: SONNET, tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 } })],
    });
    expect(m.readSdkUsageSnapshot).toHaveBeenCalledWith({ orgId: ORG, sessionId: 'sess-partner' });
  });

  it('settles error-subtype results too (turns that die on tool errors)', async () => {
    await runSession('sess-err', [{ ...result(70, 20, { subtype: 'error_during_execution' }), errors: ['tool blew up'] }]);

    expect(settles()).toHaveLength(1);
    expect(settles()[0]).toMatchObject({
      usage: [expect.objectContaining({ tokens: expect.objectContaining({ input: 70, output: 20 }) })],
      outcome: expect.objectContaining({ stopReason: 'error' }),
    });
  });
});

describe('billing source: modelUsage deltas, never the assistant accumulator', () => {
  it('a result without modelUsage bills nothing, even after assistant messages reported tokens', async () => {
    await runSession('sess-no-model-usage', [
      assistantMsg({ input_tokens: 1200, output_tokens: 80 }),
      sdkResult({ usage: { input_tokens: 0, output_tokens: 0 } }),
    ]);

    expect(settles()).toHaveLength(1);
    expect(settles()[0]).toMatchObject({ usage: [], sdkUsage: { usageNote: 'no_result', usageConfirmed: false } });
  });

  it('an abandoned turn bills ZERO, leaves the snapshot alone and skips the per-user hook', async () => {
    m.snapshots.set('sess-abandoned', snap(1000, 100));
    const { recordExtraUsage } = await runSession('sess-abandoned', [
      assistantMsg({ input_tokens: 500, output_tokens: 60 }),
      // no result — subprocess died / stream closed mid-turn
    ], { withExtra: true });

    expect(settles()).toHaveLength(1);
    expect(settles()[0]).toMatchObject({
      usage: [], sourceRef: 'abandoned_turn', turnCount: 1,
      sdkUsage: { nextSnapshot: null, usageNote: 'no_result' },
    });
    expect(m.snapshots.get('sess-abandoned')).toEqual(snap(1000, 100));
    expect(recordExtraUsage).not.toHaveBeenCalled();
  });

  it('reports cache tokens as input on the per-user hook and the done event, priced per component', async () => {
    // Release QA: an 8-turn session read 17 input tokens / 1029 output. On
    // every turn past the first, prompt caching moves nearly the whole prompt
    // into cache_read, so the uncached slice alone is meaningless.
    const { recordExtraUsage, doneUsage } = await runSession('sess-cache-surfaces', [
      sdkResult({
        total_cost_usd: 0.57,
        usage: { input_tokens: 17, output_tokens: 1_029, cache_read_input_tokens: 120_000, cache_creation_input_tokens: 4_500 },
        modelUsage: {
          [SONNET]: { inputTokens: 17, outputTokens: 1_029, cacheReadInputTokens: 120_000, cacheCreationInputTokens: 4_500 },
        },
      }),
    ], { withExtra: true });

    const expected = {
      inputTokens: 17 + 120_000 + 4_500,
      outputTokens: 1_029,
      costCents: expect.closeTo(cents(17, 1_029, 120_000, 4_500), 6),
    };
    expect(doneUsage).toEqual([expected]);
    expect(recordExtraUsage).toHaveBeenCalledWith(expected);
    // The settlement still receives the SPLIT components — they price differently.
    expect(settles()[0]!.usage[0]!.tokens).toEqual({ input: 17, output: 1_029, cacheRead: 120_000, cacheWrite: 4_500 });
  });

  it('does not settle twice when a completed turn is followed by teardown', async () => {
    await runSession('sess-clean', [
      assistantMsg({ input_tokens: 100, output_tokens: 10 }),
      result(100, 10),
    ]);

    // Only the result-driven settlement; the finally sees no turn in flight.
    expect(settles()).toHaveLength(1);
  });
});

/**
 * #7667 — the SDK's `total_cost_usd` is a RUNNING total. W03 never reads it
 * for billing: each turn is charged the registry price of its own modelUsage
 * delta, and every consumer (ledger, per-user hook, done event) reads that
 * one number.
 */
describe('per-turn registry cost (supersedes the #7667 running-total hotfix)', () => {
  it('bills each turn of one live query its own modelUsage delta, whatever total_cost_usd says', async () => {
    const { recordExtraUsage, doneUsage } = await runSession('sess-cumulative', [
      result(100, 10, { total_cost_usd: 0.01 }),
      result(250, 25, { total_cost_usd: 0.025 }),
      result(450, 45, { total_cost_usd: 0.045 }),
    ], { withExtra: true });

    expect(settles().map((s) => s.usage[0]!.tokens)).toEqual([
      { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
      { input: 150, output: 15, cacheRead: 0, cacheWrite: 0 },
      { input: 200, output: 20, cacheRead: 0, cacheWrite: 0 },
    ]);
    const perTurn = [cents(100, 10), cents(150, 15), cents(200, 20)];
    expect(doneUsage.map((u) => u.costCents)).toEqual(perTurn.map((c) => expect.closeTo(c, 6)));
    expect(recordExtraUsage.mock.calls.map((c) => c[0].costCents)).toEqual(perTurn.map((c) => expect.closeTo(c, 6)));
  });

  it('bills the first result after a resume only its delta over the stored snapshot, not the carried-over total', async () => {
    m.snapshots.set('sess-resumed', snap(1000, 100));
    const { doneUsage } = await runSession('sess-resumed', [
      // Cumulative across the transcript; total_cost_usd carries earlier queries.
      result(1100, 110, { total_cost_usd: 0.5 }),
      result(1200, 120, { total_cost_usd: 0.53 }),
    ], { sdkSessionId: 'sdk-prior-session' });

    expect(m.queryMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ options: expect.objectContaining({ resume: 'sdk-prior-session' }) }),
    );
    expect(settles().map((s) => s.usage[0]!.tokens)).toEqual([
      { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
      { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
    ]);
    expect(doneUsage.map((u) => u.costCents)).toEqual([expect.closeTo(cents(100, 10), 6), expect.closeTo(cents(100, 10), 6)]);
  });

  it('with no snapshot, the first result bills its own result.usage (modelUsage only caps it)', async () => {
    await runSession('sess-first', [
      sdkResult({
        total_cost_usd: 0.5,
        usage: { input_tokens: 100, output_tokens: 10 },
        // Carries earlier transcript turns.
        modelUsage: { [SONNET]: { inputTokens: 1000, outputTokens: 100 } },
      }),
    ]);

    expect(settles()[0]).toMatchObject({
      usage: [expect.objectContaining({ tokens: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 } })],
      sdkUsage: { usageNote: 'first_result', nextSnapshot: snap(1000, 100) },
    });
  });

  it('the same tokens cost the same registry price whether the SDK reports $0 or $9.99', async () => {
    const zero = await runSession('sess-zero', [result(1000, 100, { total_cost_usd: 0 })]);
    const high = await runSession('sess-high', [result(1000, 100, { total_cost_usd: 9.99 })]);

    expect(zero.doneUsage[0]!.costCents).toBeCloseTo(cents(1000, 100), 6);
    expect(high.doneUsage[0]!.costCents).toBeCloseTo(cents(1000, 100), 6);
    expect(settles()[1]!.outcome.sdkReportedCostUsd).toBe(9.99); // telemetry only
  });

  it('a decreased modelUsage component re-baselines and bills the turn\'s own usage (snapshot_regressed), never a negative bill', async () => {
    m.snapshots.set('sess-decreasing', snap(500, 50));
    const { doneUsage } = await runSession('sess-decreasing', [result(400, 40, { total_cost_usd: 0.04 })]);

    expect(settles()[0]).toMatchObject({
      usage: [{ model: SONNET, tokens: { input: 400, output: 40 } }],
      sdkUsage: { usageNote: 'snapshot_regressed', usageConfirmed: false, nextSnapshot: snap(400, 40) },
    });
    expect(doneUsage[0]!.costCents).toBeGreaterThan(0);
  });

  it('bills deltas across error-subtype results on the same query', async () => {
    await runSession('sess-interrupted', [
      result(100, 10),
      { ...result(180, 18, { subtype: 'error_during_execution' }), errors: ['interrupted'] },
      result(300, 30),
    ]);

    expect(settles().map((s) => s.usage[0]!.tokens.input)).toEqual([100, 80, 120]);
  });
});
