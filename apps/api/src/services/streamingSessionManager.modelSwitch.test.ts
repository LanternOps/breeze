/**
 * W05 (#7603) — a model switch on a live chat session. Spike constraint 2:
 * the switch recreates the query with `resume` and the TARGET's own wire
 * options, never `setModel`, and the user who asked for it gets no "provider
 * configuration changed" notice. Spike constraint 4: after the switch, a late
 * delta reported under the previous model's key bills at that model's rate.
 *
 * The mock block and lifecycle hooks are copied verbatim from
 * streamingSessionManager.modelBinding.test.ts.
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
  listRefusalAlternatives: vi.fn(),
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
vi.mock('./aiModels/refusals', async (orig) => ({
  ...(await orig<typeof import('./aiModels/refusals')>()),
  listRefusalAlternatives: m.listRefusalAlternatives,
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
import { db } from '../db';
import { REFUSAL_DOCS_URL } from './aiModels/refusals';
import { captureException } from './sentry';
import {
  baseAuth, baseDbSession, HARNESS_ORG, HARNESS_USER, insertedAssistantMessages, scriptedQuery, sdkResult, turnScriptedQuery,
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

import { withCarriedRates } from './aiModels/turnBinding';

const HAIKU_RATES = { inputCentsPerM: 100, outputCentsPerM: 500, cacheReadCentsPerM: 10, cacheWriteCentsPerM: 125 };
const haiku = () => makeResolvedModel('anthropic_byok', {
  offering: { id: 'off-haiku', displayName: 'Haiku 4.5' }, logicalModel: HAIKU, wireModel: HAIKU,
  thinking: 'budget', wireParams: { thinking: { type: 'disabled' }, betas: [], applied: {} }, options: {},
  rateSnapshot: { source: 'linked_platform', standard: HAIKU_RATES },
});
const opus = () => makeResolvedModel('anthropic_byok', {
  offering: { id: 'off-opus', displayName: 'Opus 5.5' }, logicalModel: OPUS, wireModel: OPUS,
  wireParams: { thinking: { type: 'adaptive' }, effort: 'high', betas: [], applied: { effort: 'high' } },
  options: { effort: 'high' }, rateSnapshot: { source: 'linked_platform', standard: OPUS_RATES },
});

describe('model switch on a live session (W05 spike constraints 2 and 4)', () => {
  it('an idle session switched to another model is recreated with resume: <sdkSessionId> and the target\'s sdkModelOptions; setModel is never called; no "configuration changed" error is published', async () => {
    const setModel = vi.fn();
    m.queryImpl = () => ({ ...scriptedQuery([]), setModel });
    const first = await mgr.getOrCreate('s-switch', { ...baseDbSession, sdkSessionId: 'sdk-1' }, baseAuth, undefined, 'sys', 1, haiku());
    first.state = 'idle';
    const publish = vi.spyOn(first.eventBus, 'publish');

    const second = await mgr.getOrCreate(
      's-switch', { ...baseDbSession, sdkSessionId: 'sdk-1' }, baseAuth, undefined, 'sys', 1, opus(),
      undefined, undefined, { modelSwitch: true },
    );

    expect(second).not.toBe(first);
    const last = m.queryArgs.at(-1)!.options;
    expect(last.resume).toBe('sdk-1');
    expect(last).toMatchObject(sdkModelOptions(opus()));
    expect(last.model).toBe(OPUS);
    expect(setModel).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });

  it('a key change WITHOUT modelSwitch keeps W03\'s rotation notice (a provider/config rotation, not a user switch)', async () => {
    m.queryImpl = () => scriptedQuery([]);
    const first = await mgr.getOrCreate('s-rot', baseDbSession, baseAuth, undefined, 'sys', 1, haiku());
    first.state = 'idle';
    const publish = vi.spyOn(first.eventBus, 'publish');
    await mgr.getOrCreate('s-rot', baseDbSession, baseAuth, undefined, 'sys', 1, opus());
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });

  it('after a switch, a delta reported under the previous model\'s key is billed at the previous model\'s rate', async () => {
    // Haiku's interrupted turn under-counted (spike Q6): its snapshot says 100/100,
    // the resumed Opus query's cumulative modelUsage carries Haiku 150/120.
    m.snapshots.set('s-carry', snap({ [HAIKU]: [100, 100] }));
    const resolved = opus();
    const binding = withCarriedRates(turnBindingFrom(resolved), [{ wireModel: HAIKU, rateSnapshot: haiku().rateSnapshot }]);
    m.queryImpl = (args) => turnScriptedQuery(args.prompt, [[sdkResult({
      modelUsage: {
        [HAIKU]: { inputTokens: 150, outputTokens: 120 },
        [OPUS]: { inputTokens: 40, outputTokens: 30 },
      },
    })]]);
    const session = await mgr.getOrCreate('s-carry', { ...baseDbSession, sdkSessionId: 'sdk-1' }, baseAuth, undefined, 'sys', 1, resolved,
      undefined, undefined, { budgetReservationId: 'res-1', modelSwitch: true });
    expect(mgr.tryTransitionToProcessing(session, 'res-1', { turnBinding: binding })).toBe(true);
    session.inputController.pushMessage('continue');
    await session.processorPromise;

    const settled = settleCalls().at(-1)!;
    expect(settled.binding.carriedRates).toEqual([{ wireModel: HAIKU, rateSnapshot: haiku().rateSnapshot }]);
    const priced = priceUsage(settled.binding, settled.usage);
    const haikuRow = priced.find((p) => p.model === HAIKU)!;
    const opusRow = priced.find((p) => p.model === OPUS)!;
    expect(haikuRow.rate.standard).toEqual(HAIKU_RATES);      // 50 in / 20 out at Haiku's rate
    expect(haikuRow.tokens).toMatchObject({ input: 50, output: 20 });
    expect(opusRow.rate.standard).toEqual(OPUS_RATES);
  });
});
