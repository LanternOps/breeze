/**
 * W03 Task 7 — the manager seam for every Agent SDK surface (chat, topology,
 * helper, script builder, Office chat): the SDK call is built from the
 * ResolvedModel, a live query is reused only on an equal live-query key, and
 * each `result` settles through settleInvocation at the registry rate bound to
 * the turn — per-model DELTAS of the SDK's cumulative modelUsage against the
 * breeze session's persisted snapshot (W05 spike), never total_cost_usd.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SdkUsageSnapshot } from './aiModels/invocationUsage';

const m = vi.hoisted(() => ({
  queryImpl: null as null | ((args: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => unknown),
  queryArgs: [] as Array<{ prompt: AsyncIterable<unknown>; options: Record<string, unknown> }>,
  settleInvocation: vi.fn(),
  snapshots: new Map<string, unknown>(),
  readSdkUsageSnapshot: vi.fn(),
  markIndeterminate: vi.fn(async () => ({ kind: 'indeterminate' })),
  settleOrder: [] as string[],
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
    m.queryArgs.push(args);
    return m.queryImpl!(args);
  },
}));
vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve([])) })) })) })),
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
  settleApprovalWaits: vi.fn(() => false),
}));
vi.mock('./aiToolOutput', () => ({ redactAiToolOutputText: (s: string) => s, redactSensitiveToolInput: (i: unknown) => i }));
vi.mock('./clientIp', () => ({ getTrustedClientIpOrUndefined: () => undefined }));
vi.mock('./toolSources/resolver', () => ({ resolveTenantTools: vi.fn(async () => []) }));

import { StreamingSessionManager, type ActiveSession } from './streamingSessionManager';
import { makeResolvedModel, FIXTURE_STD_RATES } from './aiModels/__fixtures__/resolvedModel';
import { sdkModelOptions } from './aiModels/connectionFactory';
import { liveQueryKey, turnBindingFrom } from './aiModels/turnBinding';
import { priceUsage, sumCostCents, type SettleInvocationInput } from './aiModels/settleInvocation';
import {
  baseAuth, baseDbSession, HARNESS_ORG, HARNESS_USER, scriptedQuery, sdkResult, turnScriptedQuery,
} from './__testutils__/streamingSessionManagerHarness';

const SONNET = 'claude-sonnet-5-5';
const OPUS = 'claude-opus-5-5';
const HAIKU = 'claude-haiku-4-5';
const OPUS_RATES = { inputCentsPerM: 500, outputCentsPerM: 2500, cacheReadCentsPerM: 50, cacheWriteCentsPerM: 625 };

function snap(models: Record<string, [number, number]>): SdkUsageSnapshot {
  return {
    version: 1,
    models: Object.fromEntries(Object.entries(models).map(([k, [input, output]]) => [k, {
      tokens: { input, output, cacheRead: 0, cacheWrite: 0 }, webSearchRequests: 0,
    }])),
  };
}

function settleCalls(): SettleInvocationInput[] {
  return m.settleInvocation.mock.calls.map((c) => c[0] as SettleInvocationInput);
}

let mgr: StreamingSessionManager;

beforeEach(() => {
  vi.clearAllMocks();
  m.queryArgs.length = 0;
  m.snapshots.clear();
  m.settleOrder.length = 0;
  m.queryImpl = () => scriptedQuery([]);
  m.readSdkUsageSnapshot.mockImplementation(async ({ sessionId }: { sessionId: string }) =>
    (m.snapshots.get(sessionId) as SdkUsageSnapshot | undefined) ?? null);
  m.settleInvocation.mockImplementation(async (input: SettleInvocationInput) => {
    m.settleOrder.push('settle');
    if (input.sdkUsage?.nextSnapshot) m.snapshots.set(input.sdkUsage.sessionId, input.sdkUsage.nextSnapshot);
    return { costCents: sumCostCents(priceUsage(input.binding, input.usage)), invocationIds: ['i1'], deferred: false };
  });
  mgr = new StreamingSessionManager();
});

afterEach(() => {
  mgr.shutdown();
});

/** Create, claim the turn with its binding, push one message, wait for the processor to finish. */
async function runOneTurn(
  sessionId: string,
  resolved: ReturnType<typeof makeResolvedModel>,
  messages: unknown[],
  opts: { reservationId?: string; ledgerUserId?: string | null; sdkSessionId?: string | null; recordExtraUsage?: ActiveSession['recordExtraUsage'] } = {},
): Promise<ActiveSession> {
  m.queryImpl = (args) => turnScriptedQuery(args.prompt, [messages]);
  const session = await mgr.getOrCreate(
    sessionId, { ...baseDbSession, sdkSessionId: opts.sdkSessionId ?? null }, baseAuth, undefined, 'sys', 1, resolved,
    undefined, undefined, { budgetReservationId: opts.reservationId, ledgerUserId: opts.ledgerUserId ?? null },
  );
  if (opts.recordExtraUsage) session.recordExtraUsage = opts.recordExtraUsage;
  expect(mgr.tryTransitionToProcessing(session, opts.reservationId, { turnBinding: turnBindingFrom(resolved) })).toBe(true);
  session.inputController.pushMessage('hi');
  await session.processorPromise;
  return session;
}

describe('getOrCreate with a ResolvedModel', () => {
  it('builds the SDK call from the resolved model: wire model, W01 params, fallbackModel, connection env', async () => {
    const resolved = makeResolvedModel('anthropic_byok', {
      refusalFallback: {
        offeringId: 'fb', displayName: 'Haiku', wireModel: HAIKU,
        wireParams: { betas: [], applied: {} }, options: {}, rateSnapshot: makeResolvedModel().rateSnapshot,
      },
    });
    await mgr.getOrCreate('s1', baseDbSession, baseAuth, undefined, 'sys', 1, resolved, undefined, undefined, { ledgerUserId: 'u1' });
    const options = m.queryArgs[0]!.options;
    expect(options).toMatchObject({ ...sdkModelOptions(resolved), model: SONNET, fallbackModel: HAIKU });
    expect((options.env as Record<string, string>).ANTHROPIC_API_KEY).toBe('sk-partner');
  });

  it('a catalog model sends the provider wire id', async () => {
    await mgr.getOrCreate('s1', baseDbSession, baseAuth, undefined, 'sys', 1, makeResolvedModel('catalog'));
    expect(m.queryArgs[0]!.options.model).toBe('anthropic/claude-sonnet-5.5');
  });

  it('an idle live query is rotated when the live-query key moves (config_version bump)', async () => {
    const first = await mgr.getOrCreate('s1', baseDbSession, baseAuth, undefined, 'sys', 1, makeResolvedModel('anthropic_byok'));
    first.state = 'idle';
    const bumped = makeResolvedModel('anthropic_byok', { configVersion: 3 });
    const second = await mgr.getOrCreate('s1', baseDbSession, baseAuth, undefined, 'sys', 1, bumped);
    expect(second).not.toBe(first);
    expect(second.liveKey).toBe(liveQueryKey(turnBindingFrom(bumped)));
    expect(m.queryArgs).toHaveLength(2);
  });

  it('an idle live query is reused when only the rate moved (re-binds settlement, not the query)', async () => {
    const first = await mgr.getOrCreate('s1', baseDbSession, baseAuth, undefined, 'sys', 1, makeResolvedModel('anthropic_byok'));
    first.state = 'idle';
    const repriced = makeResolvedModel('anthropic_byok', {
      rateSnapshot: { source: 'linked_platform', standard: { ...FIXTURE_STD_RATES, inputCentsPerM: 999 } },
    });
    const again = await mgr.getOrCreate('s1', baseDbSession, baseAuth, undefined, 'sys', 1, repriced);
    expect(again).toBe(first);
  });

  it('a processing live query is left alone (the route answers 409)', async () => {
    const first = await mgr.getOrCreate('s1', baseDbSession, baseAuth, undefined, 'sys', 1, makeResolvedModel('anthropic_byok'));
    first.state = 'processing';
    const again = await mgr.getOrCreate('s1', baseDbSession, baseAuth, undefined, 'sys', 1,
      makeResolvedModel('anthropic_byok', { configVersion: 3 }));
    expect(again).toBe(first);
    expect(mgr.tryTransitionToProcessing(again, 'r2', { turnBinding: turnBindingFrom(makeResolvedModel('anthropic_byok', { configVersion: 3 })) })).toBe(false);
  });

  it('a session marked forceRecreate is rebuilt on the next turn even with an equal key', async () => {
    const resolved = makeResolvedModel();
    const first = await mgr.getOrCreate('s1', baseDbSession, baseAuth, undefined, 'sys', 1, resolved);
    first.state = 'idle';
    first.forceRecreate = true;
    const second = await mgr.getOrCreate('s1', baseDbSession, baseAuth, undefined, 'sys', 1, resolved);
    expect(second).not.toBe(first);
  });
});

describe('result → settleInvocation (registry price only)', () => {
  it('SDK reports $9.99: settlement receives token usage, the binding and the snapshot; the done event quotes the registry price', async () => {
    const resolved = makeResolvedModel();
    const session = await runOneTurn('s1', resolved, [
      sdkResult({
        total_cost_usd: 9.99,
        usage: { input_tokens: 1000, output_tokens: 100 },
        modelUsage: { [SONNET]: { inputTokens: 1000, outputTokens: 100, costUSD: 9.99 } },
      }),
    ], { reservationId: 'r1', ledgerUserId: 'u1' });

    expect(m.readSdkUsageSnapshot).toHaveBeenCalledWith({ orgId: HARNESS_ORG, sessionId: 's1' });
    const [input] = settleCalls();
    expect(input).toMatchObject({
      binding: turnBindingFrom(resolved), orgId: HARNESS_ORG, userId: 'u1', sessionId: 's1', reservationId: 'r1',
      usage: [{ model: SONNET, tokens: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 }, webSearchRequests: 0 }],
      outcome: expect.objectContaining({ sdkReportedCostUsd: 9.99 }),
      sdkUsage: { sessionId: 's1', nextSnapshot: snap({ [SONNET]: [1000, 100] }), usageConfirmed: true, usageNote: 'first_result' },
    });
    // The only SDK cost on the settle input is outcome telemetry.
    expect(JSON.stringify(input)).not.toMatch(/total_cost_usd|costUSD/);
    const done = session.eventBus.getReplayEvents().find((e) => e.type === 'done' && 'usage' in e && e.usage) as
      { usage: { costCents: number; inputTokens: number; outputTokens: number } } | undefined;
    expect(done!.usage.costCents).toBeCloseTo(0.3, 6);  // 1000×200/1e6 + 100×1000/1e6
    expect(done!.usage).toMatchObject({ inputTokens: 1000, outputTokens: 100 });
  });

  it('Office per-user usage hook gets the registry price even when the SDK reports $0, before settlement (#5557 order)', async () => {
    const extra = vi.fn(async () => { m.settleOrder.push('extra'); });
    await runOneTurn('s1', makeResolvedModel(), [
      sdkResult({ total_cost_usd: 0, usage: { input_tokens: 1000, output_tokens: 100 }, modelUsage: { [SONNET]: { inputTokens: 1000, outputTokens: 100 } } }),
    ], { recordExtraUsage: extra });
    expect(extra).toHaveBeenCalledWith({ inputTokens: 1000, outputTokens: 100, costCents: expect.closeTo(0.3, 6) });
    expect(m.settleOrder).toEqual(['extra', 'settle']);
  });

  it('settles at the binding the turn claimed (a rate change between turns re-binds settlement)', async () => {
    const created = makeResolvedModel();
    const repriced = makeResolvedModel('platform', {
      rateSnapshot: { source: 'platform', standard: { ...FIXTURE_STD_RATES, inputCentsPerM: 400 } },
    });
    m.queryImpl = (args) => turnScriptedQuery(args.prompt, [[
      sdkResult({ usage: { input_tokens: 1000, output_tokens: 0 }, modelUsage: { [SONNET]: { inputTokens: 1000 } } }),
    ]]);
    const session = await mgr.getOrCreate('s1', baseDbSession, baseAuth, undefined, 'sys', 1, created);
    mgr.tryTransitionToProcessing(session, 'r1', { turnBinding: turnBindingFrom(repriced) });
    session.inputController.pushMessage('hi');
    await session.processorPromise;
    expect(settleCalls()[0]!.binding).toEqual(turnBindingFrom(repriced));
  });

  it('two turns on one live query: turn 2 bills only its own tokens', async () => {
    const resolved = makeResolvedModel();
    m.queryImpl = (args) => turnScriptedQuery(args.prompt, [
      [sdkResult({ usage: { input_tokens: 1000, output_tokens: 100 }, modelUsage: { [SONNET]: { inputTokens: 1000, outputTokens: 100 } } })],
      // Cumulative modelUsage (and a usage block that is NOT trusted on a later turn of a live query).
      [sdkResult({ usage: { input_tokens: 2500, output_tokens: 300 }, modelUsage: { [SONNET]: { inputTokens: 2500, outputTokens: 300 } } })],
    ]);
    const session = await mgr.getOrCreate('s1', baseDbSession, baseAuth, undefined, 'sys', 1, resolved,
      undefined, undefined, { ledgerUserId: HARNESS_USER });
    mgr.tryTransitionToProcessing(session, 'r1', { turnBinding: turnBindingFrom(resolved) });
    session.inputController.pushMessage('one');
    await vi.waitFor(() => expect(m.settleInvocation).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(session.state).toBe('idle'));
    expect(mgr.tryTransitionToProcessing(session, 'r2', { turnBinding: turnBindingFrom(resolved) })).toBe(true);
    session.inputController.pushMessage('two');
    await session.processorPromise;

    const [t1, t2] = settleCalls();
    expect(t1!.usage).toEqual([expect.objectContaining({ model: SONNET, tokens: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 } })]);
    expect(t1!.reservationId).toBe('r1');
    expect(t2!.usage).toEqual([expect.objectContaining({ model: SONNET, tokens: { input: 1500, output: 200, cacheRead: 0, cacheWrite: 0 } })]);
    expect(t2!.reservationId).toBe('r2');
    expect(t2!.sdkUsage).toMatchObject({ usageNote: 'delta', nextSnapshot: snap({ [SONNET]: [2500, 300] }) });
  });

  it('a resumed session (new query, cumulative modelUsage carried) bills only the delta', async () => {
    m.snapshots.set('s1', snap({ [SONNET]: [1000, 100] }));
    await runOneTurn('s1', makeResolvedModel(), [
      sdkResult({ usage: { input_tokens: 800, output_tokens: 60 }, modelUsage: { [SONNET]: { inputTokens: 1800, outputTokens: 160 } } }),
    ], { sdkSessionId: 'sdk-1', reservationId: 'r1' });
    expect(m.queryArgs[0]!.options.resume).toBe('sdk-1');
    expect(settleCalls()[0]!.usage).toEqual([
      expect.objectContaining({ model: SONNET, tokens: { input: 800, output: 60, cacheRead: 0, cacheWrite: 0 } }),
    ]);
  });

  it('resume onto another model bills only the new model\'s delta at the new binding', async () => {
    m.snapshots.set('s1', snap({ [SONNET]: [1000, 100] }));
    const opus = makeResolvedModel('platform', {
      logicalModel: OPUS, wireModel: OPUS, offering: { id: 'off-opus', displayName: 'Opus' },
      rateSnapshot: { source: 'platform', standard: OPUS_RATES },
    });
    await runOneTurn('s1', opus, [
      sdkResult({
        usage: { input_tokens: 500, output_tokens: 50 },
        modelUsage: { [SONNET]: { inputTokens: 1000, outputTokens: 100 }, [OPUS]: { inputTokens: 500, outputTokens: 50 } },
      }),
    ], { sdkSessionId: 'sdk-1', reservationId: 'r1' });
    const [input] = settleCalls();
    expect(input!.usage).toEqual([expect.objectContaining({ model: OPUS, tokens: { input: 500, output: 50, cacheRead: 0, cacheWrite: 0 } })]);
    expect(input!.binding.wireModel).toBe(OPUS);
    expect(sumCostCents(priceUsage(input!.binding, input!.usage))).toBeCloseTo(500 * 500 / 1e6 + 50 * 2500 / 1e6, 6);
  });

  it('a CLI refusal fallback with no fallback_model (new modelUsage key) is billed under that key and forces a rebuild', async () => {
    m.snapshots.set('s1', snap({ [SONNET]: [1000, 100] }));
    const session = await runOneTurn('s1', makeResolvedModel(), [
      { type: 'system', subtype: 'model_refusal_fallback', api_refusal_category: 'cyber' },
      sdkResult({
        usage: { input_tokens: 300, output_tokens: 40 },
        modelUsage: { [SONNET]: { inputTokens: 1200, outputTokens: 110 }, [HAIKU]: { inputTokens: 300, outputTokens: 40 } },
      }),
    ], { sdkSessionId: 'sdk-1', reservationId: 'r1' });
    const [input] = settleCalls();
    expect(input!.usage).toEqual(expect.arrayContaining([
      expect.objectContaining({ model: SONNET, tokens: { input: 200, output: 10, cacheRead: 0, cacheWrite: 0 } }),
      expect.objectContaining({ model: HAIKU, tokens: { input: 300, output: 40, cacheRead: 0, cacheWrite: 0 } }),
    ]));
    expect(input!.outcome).toMatchObject({ fallbackUsed: true, servedModel: HAIKU, refusalCategory: 'cyber' });
    expect(session.forceRecreate).toBe(true);
  });

  it('a session-scope refusal fallback naming the model marks the live query for recreation and bills at the fallback', async () => {
    const resolved = makeResolvedModel('platform', {
      refusalFallback: {
        offeringId: 'fb', displayName: 'Haiku', wireModel: HAIKU,
        wireParams: { betas: [], applied: {} }, options: {}, rateSnapshot: makeResolvedModel().rateSnapshot,
      },
    });
    const session = await runOneTurn('s1', resolved, [
      { type: 'system', subtype: 'model_refusal_fallback', scope: 'session', fallback_model: HAIKU, api_refusal_category: 'cyber' },
      sdkResult({ usage: { input_tokens: 10, output_tokens: 1 }, modelUsage: { [HAIKU]: { inputTokens: 10, outputTokens: 1 } } }),
    ]);
    expect(session.forceRecreate).toBe(true);
    const [input] = settleCalls();
    expect(input!.usage[0]!.model).toBe(HAIKU);
    expect(input!.outcome).toMatchObject({ fallbackUsed: true, refusalCategory: 'cyber' });
  });

  it('an error result still settles (and releases) the turn reservation', async () => {
    await runOneTurn('s1', makeResolvedModel(), [
      sdkResult({ subtype: 'error_during_execution', usage: { input_tokens: 10, output_tokens: 1 }, modelUsage: { [SONNET]: { inputTokens: 10, outputTokens: 1 } } }),
    ], { reservationId: 'r1' });
    expect(settleCalls()[0]).toMatchObject({ reservationId: 'r1', outcome: expect.objectContaining({ stopReason: 'error' }) });
    expect(m.markIndeterminate).not.toHaveBeenCalled();
  });
});

describe('aborted / abandoned turns', () => {
  it('a turn with no result bills zero (no_result), leaves the snapshot alone and settles the reservation', async () => {
    m.snapshots.set('s1', snap({ [SONNET]: [1000, 100] }));
    m.queryImpl = (args) => ({
      async *[Symbol.asyncIterator]() {
        for await (const _ of args.prompt) {
          yield { type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }], usage: { input_tokens: 400, output_tokens: 20 } } };
          return; // subprocess died mid-turn
        }
      },
      interrupt: vi.fn(),
      close: vi.fn(),
    });
    const resolved = makeResolvedModel();
    const session = await mgr.getOrCreate('s1', baseDbSession, baseAuth, undefined, 'sys', 1, resolved,
      undefined, undefined, { ledgerUserId: 'u1' });
    const extra = vi.fn(async () => undefined);
    session.recordExtraUsage = extra;
    mgr.tryTransitionToProcessing(session, 'r1', { turnBinding: turnBindingFrom(resolved) });
    session.inputController.pushMessage('hi');
    await session.processorPromise;

    const [input] = settleCalls();
    expect(input).toMatchObject({
      reservationId: 'r1', usage: [], sessionId: 's1', userId: 'u1',
      sdkUsage: { sessionId: 's1', nextSnapshot: null, usageConfirmed: false, usageNote: 'no_result' },
    });
    expect(sumCostCents(priceUsage(input!.binding, input!.usage))).toBe(0);
    expect(m.snapshots.get('s1')).toEqual(snap({ [SONNET]: [1000, 100] }));
    expect(m.markIndeterminate).not.toHaveBeenCalled();
    expect(extra).not.toHaveBeenCalled();
  });

  it('a failed zero settlement of an abandoned turn keeps the reservation held (indeterminate), never leaked', async () => {
    m.settleInvocation.mockRejectedValueOnce(new Error('db down'));
    await runOneTurn('s1', makeResolvedModel(), [], { reservationId: 'r1' });
    expect(m.settleInvocation).toHaveBeenCalledTimes(1);
    expect(m.markIndeterminate).toHaveBeenCalledWith({ orgId: HARNESS_ORG, reservationId: 'r1' });
  });

  it('an idle session torn down with no turn in flight settles nothing', async () => {
    const session = await mgr.getOrCreate('s1', baseDbSession, baseAuth, undefined, 'sys', 1, makeResolvedModel());
    await session.processorPromise;
    expect(m.settleInvocation).not.toHaveBeenCalled();
    expect(m.markIndeterminate).not.toHaveBeenCalled();
  });
});
