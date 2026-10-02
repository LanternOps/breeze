/**
 * W05 (#7603) Task 9 — the chat stream says what the model is doing and what
 * actually ran: `thinking_state` started/stopped around thinking blocks (never
 * a silent pause; W01 D1: SDK 0.3.286 carries no `updates` notes), and one
 * `turn_model` per turn, built from the turn OUTCOME (spike constraint 5),
 * published before `done` and persisted as ai_sessions.last_turn_model.
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

import { StreamingSessionManager } from './streamingSessionManager';
import { makeResolvedModel } from './aiModels/__fixtures__/resolvedModel';
import { turnBindingFrom } from './aiModels/turnBinding';
import { priceUsage, sumCostCents, type SettleInvocationInput } from './aiModels/settleInvocation';
import { db } from '../db';
import { captureException } from './sentry';
import { baseAuth, baseDbSession, sdkResult, turnScriptedQuery } from './__testutils__/streamingSessionManagerHarness';

let mgr: StreamingSessionManager;

beforeEach(() => {
  vi.clearAllMocks();
  m.queryArgs.length = 0;
  m.snapshots.clear();
  m.settleOrder.length = 0;
  m.queryImpl = null;
  m.readSdkUsageSnapshot.mockImplementation(async ({ sessionId }: { sessionId: string }) =>
    (m.snapshots.get(sessionId) as SdkUsageSnapshot | undefined) ?? null);
  m.settleInvocation.mockImplementation(async (input: SettleInvocationInput) => {
    if (input.sdkUsage?.nextSnapshot) m.snapshots.set(input.sdkUsage.sessionId, input.sdkUsage.nextSnapshot);
    return { costCents: sumCostCents(priceUsage(input.binding, input.usage)), invocationIds: ['i1'], deferred: false };
  });
  mgr = new StreamingSessionManager();
});

afterEach(() => {
  mgr.shutdown();
});

const ev = (event: Record<string, unknown>) => ({ type: 'stream_event', event });
const thinkingTurn = [
  ev({ type: 'message_start', message: {} }),
  ev({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }),
  ev({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'x' } }),
  ev({ type: 'content_block_stop', index: 0 }),
  ev({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
  ev({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Answer' } }),
  ev({ type: 'content_block_stop', index: 1 }),
];

/**
 * Run one turn and return every event the session published. `messages` is
 * either the turn's scripted SDK messages, or a raw generator for a query that
 * ends abnormally (throws / runs out with no `result`).
 */
async function published(
  messages: unknown[] | (() => AsyncGenerator<unknown>),
  resolved = makeResolvedModel('platform'),
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  m.queryImpl = (args) => (typeof messages === 'function'
    ? { [Symbol.asyncIterator]: () => messages(), interrupt: vi.fn(), close: vi.fn() }
    : turnScriptedQuery(args.prompt, [messages]));
  const session = await mgr.getOrCreate('s-th', baseDbSession, baseAuth, undefined, 'sys', 1, resolved, undefined, undefined, { budgetReservationId: 'r1' });
  vi.spyOn(session.eventBus, 'publish').mockImplementation((e) => { out.push(e as Record<string, unknown>); });
  expect(mgr.tryTransitionToProcessing(session, 'r1', { turnBinding: turnBindingFrom(resolved) })).toBe(true);
  session.inputController.pushMessage('hi');
  await session.processorPromise;
  return out;
}

const thinkingStates = (events: Array<Record<string, unknown>>) =>
  events.filter((e) => e.type === 'thinking_state').map((e) => e.state);
const indexOfStopped = (events: Array<Record<string, unknown>>) =>
  events.findIndex((e) => e.type === 'thinking_state' && e.state === 'stopped');

describe('thinking progress (W05; W01 D1: no `updates` notes on SDK 0.3.286)', () => {
  it('publishes thinking started → stopped around the thinking block, before the answer text', async () => {
    const types = (await published([...thinkingTurn, sdkResult({})])).map((e) => (e.type === 'thinking_state' ? `thinking:${e.state}` : e.type));
    const started = types.indexOf('thinking:started');
    const stopped = types.indexOf('thinking:stopped');
    expect(started).toBeGreaterThanOrEqual(0);
    expect(stopped).toBeGreaterThan(started);
    expect(stopped).toBeLessThan(types.indexOf('content_delta'));
  });

  it('a turn that ends while still thinking still publishes stopped (never a silent pause)', async () => {
    const events = await published([thinkingTurn[0], thinkingTurn[1], sdkResult({})]);
    expect(thinkingStates(events)).toEqual(['started', 'stopped']);
    expect(indexOfStopped(events)).toBeLessThan(events.findIndex((e) => e.type === 'done'));
  });

  it('a query that errors mid-thought publishes stopped before the error', async () => {
    const events = await published(async function* () {
      yield thinkingTurn[0];
      yield thinkingTurn[1];
      throw new Error('subprocess died');
    });
    expect(thinkingStates(events)).toEqual(['started', 'stopped']);
    expect(indexOfStopped(events)).toBeLessThan(events.findIndex((e) => e.type === 'error'));
  });

  it('a query that ends with no result mid-thought still publishes stopped', async () => {
    const events = await published(async function* () {
      yield thinkingTurn[0];
      yield thinkingTurn[1];
    });
    expect(thinkingStates(events)).toEqual(['started', 'stopped']);
  });

  it('a redacted_thinking block is thinking too', async () => {
    const events = await published([
      thinkingTurn[0],
      ev({ type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking', data: 'x' } }),
      ev({ type: 'content_block_stop', index: 0 }),
      sdkResult({}),
    ]);
    expect(thinkingStates(events)).toEqual(['started', 'stopped']);
  });

  it('a turn with no thinking publishes no thinking_state', async () => {
    const events = await published([thinkingTurn[0], ...thinkingTurn.slice(4), sdkResult({})]);
    expect(thinkingStates(events)).toEqual([]);
  });
});

describe('turn_model (W05 spike constraint 5)', () => {
  it('publishes turn_model with the served model before done', async () => {
    const events = await published([...thinkingTurn, sdkResult({})]);
    const tm = events.findIndex((e) => e.type === 'turn_model');
    expect(tm).toBeGreaterThan(-1);
    expect(tm).toBeLessThan(events.findIndex((e) => e.type === 'done'));
    expect(events[tm]!.turnModel).toMatchObject({ requestedDisplayName: 'Sonnet 5.5', servedModel: 'claude-sonnet-5-5' });
    expect(events.filter((e) => e.type === 'turn_model')).toHaveLength(1);
  });

  it('persists exactly the published turn model on the session row (what a reload reads)', async () => {
    const events = await published([...thinkingTurn, sdkResult({})]);
    const turnModel = events.find((e) => e.type === 'turn_model')!.turnModel;
    const sets = vi.mocked(db.update).mock.results.flatMap((r) =>
      (r.value as { set: ReturnType<typeof vi.fn> }).set.mock.calls.map((c) => c[0] as Record<string, unknown>));
    expect(sets).toContainEqual({ lastTurnModel: turnModel });
  });

  it('a failed persist never fails the turn: it is reported, and turn_model and done still publish', async () => {
    vi.mocked(db.update).mockImplementation(() => { throw new Error('db down'); });
    const events = await published([...thinkingTurn, sdkResult({})]);
    expect(events.some((e) => e.type === 'turn_model')).toBe(true);
    expect(events.some((e) => e.type === 'done')).toBe(true);
    expect(captureException).toHaveBeenCalled();
  });
});
