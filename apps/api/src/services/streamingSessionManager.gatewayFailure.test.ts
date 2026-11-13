/**
 * #7794: when the model gateway gave up on an upstream (e.g. the response-header
 * deadline on a slow local server), the chat turn's error says why, instead of a
 * generic "internal error", a bare timeout, or nothing at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: m.queryMock }));
// Wisp W04 Task 4: getOrCreate resolves the session's delegation grant itself
// (lookupWispGrant); every session in this suite is an ordinary one.
vi.mock('./wisp/chatCeiling', () => ({
  lookupWispGrant: vi.fn(async () => null),
  unreachableWispAuth: (auth: unknown) => auth,
  WispSessionUnavailableError: class WispSessionUnavailableError extends Error {},
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
  markAiBudgetReservationIndeterminate: vi.fn(() => Promise.resolve()),
  readSdkUsageSnapshot: vi.fn(async () => null),
}));
vi.mock('./aiModels/platformModels', async (orig) => ({
  ...(await orig<typeof import('./aiModels/platformModels')>()),
  getPlatformModelByModelId: vi.fn(async () => null),
}));
vi.mock('./aiModels/settleInvocation', async (orig) => ({
  ...(await orig<typeof import('./aiModels/settleInvocation')>()),
  settleInvocation: vi.fn(async () => ({ costCents: 0, invocationIds: [], deferred: false })),
}));
vi.mock('./aiAgent', () => ({ sanitizeErrorForClient: () => 'An internal error occurred. Please try again.' }));
vi.mock('./sentry', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('./aiAgentSdkTools', () => ({
  createBreezeMcpServer: vi.fn(() => ({ type: 'sdk' })),
  BREEZE_MCP_TOOL_NAMES: ['mcp__breeze__query_devices'],
}));
vi.mock('./aiAgentSdk', () => ({
  createSessionPreToolUse: vi.fn(() => vi.fn()),
  createSessionPostToolUse: vi.fn(() => vi.fn()),
  settleApprovalWaits: vi.fn(),
}));
vi.mock('./aiToolOutput', () => ({
  redactAiToolOutputText: (s: string) => s,
  redactSensitiveToolInput: (i: unknown) => i,
}));
vi.mock('./clientIp', () => ({ getTrustedClientIpOrUndefined: () => undefined }));
vi.mock('./toolSources/resolver', () => ({ resolveTenantTools: vi.fn(async () => []) }));

// Keeps the lazy real ./flows/flowTools graph (~5 s cold) out of whichever test reaches it first (#11011).
vi.mock('./flows/flowTools', () => ({ resolveFlowTools: async () => [] }));

import { StreamingSessionManager } from './streamingSessionManager';
import { settleInvocation } from './aiModels/settleInvocation';
import { __resetGatewayFailureNotesForTests, noteGatewayFailure, takeGatewayFailureNote } from './aiModels/gateway/failureNotes';
import { makeResolvedModel } from './aiModels/__fixtures__/resolvedModel';
import { baseAuth, baseDbSession, insertedAssistantMessages, scriptedQuery, sdkResult } from './__testutils__/streamingSessionManagerHarness';
import { db } from '../db';
import { UNSAFE_TOOL_CALL_NOTE } from './aiModels/gateway/openai/translateResponse';
import type { ToolExposure } from './aiModels/toolExposure';

const NOTE = 'The model endpoint did not start responding within 120 s (the gateway\'s response-header deadline).';

let manager: StreamingSessionManager;

beforeEach(() => {
  vi.clearAllMocks();
  __resetGatewayFailureNotesForTests();
  manager = new StreamingSessionManager();
});
afterEach(() => {
  manager.shutdown();
  vi.useRealTimers();
});

function errorMessages(session: { eventBus: { getReplayEvents(): Array<{ type: string }> } }): string[] {
  return session.eventBus.getReplayEvents()
    .flatMap((e) => (e.type === 'error' ? [String((e as { message?: unknown }).message)] : []));
}

async function runTurn(sessionId: string, messages: unknown[], beforeRun?: () => void) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  m.queryMock.mockImplementation(() => scriptedQuery(messages, gate));
  const session = await manager.getOrCreate(
    sessionId, baseDbSession, baseAuth, undefined, 'PROMPT', undefined, makeResolvedModel('openai_compatible'),
  );
  beforeRun?.();
  release();
  await session.processorPromise;
  return { session, errors: errorMessages(session) };
}

describe('gateway failure reason in the chat turn error (#7794)', () => {
  it('an error-result turn shows the gateway reason, not the generic sanitized text', async () => {
    const { errors } = await runTurn('s-err', [{ ...sdkResult({ subtype: 'error_during_execution' }), errors: ['API Error: 504'] }],
      () => noteGatewayFailure('s-err', NOTE));
    expect(errors).toEqual([NOTE]);
  });

  it('with no gateway note, the error-result path is unchanged', async () => {
    const { errors } = await runTurn('s-plain', [{ ...sdkResult({ subtype: 'error_during_execution' }), errors: ['boom'] }]);
    expect(errors).toEqual(['An internal error occurred. Please try again.']);
  });

  it('a "success" result flagged is_error (the CLI gave up after its retries) shows the gateway reason', async () => {
    const { errors } = await runTurn('s-iserr', [{ ...sdkResult(), is_error: true, result: 'API Error: 504 …' }],
      () => noteGatewayFailure('s-iserr', NOTE));
    expect(errors).toEqual([NOTE]);
  });

  it('a successful turn publishes no error and drops a stale note (a retry that recovered)', async () => {
    const { errors } = await runTurn('s-ok', [sdkResult()], () => noteGatewayFailure('s-ok', NOTE));
    expect(errors).toEqual([]);
    expect(takeGatewayFailureNote('s-ok')).toBeNull();
  });

  it('a query that throws (CLI process error) shows the gateway reason', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    m.queryMock.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() { await gate; throw new Error('Claude Code process exited with code 1'); },
      interrupt: vi.fn(), close: vi.fn(),
    }));
    const session = await manager.getOrCreate(
      's-throw', baseDbSession, baseAuth, undefined, 'PROMPT', undefined, makeResolvedModel('openai_compatible'),
    );
    noteGatewayFailure('s-throw', NOTE);
    release();
    await session.processorPromise;
    expect(errorMessages(session)).toEqual([NOTE]);
  });

  describe('a context-window refusal (#10577)', () => {
    const TOO_LARGE = 'This request is about 140,000 tokens, which does not fit.';
    const lastSettlement = () => vi.mocked(settleInvocation).mock.lastCall?.[0] as unknown as {
      outcome: { stopReason: string }; sdkUsage: { usageNote: string; usageConfirmed: boolean };
    };

    it('shows its reason and settles as context_window_exceeded, not no_result', async () => {
      const { errors } = await runTurn('s-window', [{ ...sdkResult(), is_error: true, modelUsage: {} }],
        () => noteGatewayFailure('s-window', TOO_LARGE, 'context_window_exceeded'));
      expect(errors).toEqual([TOO_LARGE]);
      const settled = lastSettlement();
      expect(settled.sdkUsage).toMatchObject({ usageNote: 'context_window_exceeded', usageConfirmed: true });
      expect(settled.outcome.stopReason).toBe('context_window_exceeded');
    });

    it('a query that throws after the refusal also settles by name', async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      m.queryMock.mockImplementation(() => ({
        async *[Symbol.asyncIterator]() { await gate; throw new Error('Claude Code process exited with code 1'); },
        interrupt: vi.fn(), close: vi.fn(),
      }));
      const session = await manager.getOrCreate(
        's-window-throw', baseDbSession, baseAuth, undefined, 'PROMPT', undefined, makeResolvedModel('openai_compatible'),
      );
      session.budgetReservationId = 'reservation-1';
      noteGatewayFailure('s-window-throw', TOO_LARGE, 'context_window_exceeded');
      release();
      await session.processorPromise;
      expect(errorMessages(session)).toEqual([TOO_LARGE]);
      expect(lastSettlement().sdkUsage).toMatchObject({ usageNote: 'context_window_exceeded', usageConfirmed: true });
    });

    it('a note left by an earlier turn is dropped when the next turn starts', async () => {
      const { session } = await runTurn('s-stale', [sdkResult()]);
      noteGatewayFailure('s-stale', TOO_LARGE, 'context_window_exceeded');
      session.state = 'idle';
      expect(manager.tryTransitionToProcessing(session)).toBe(true);
      expect(takeGatewayFailureNote('s-stale')).toBeNull();
    });

    it('a coded note on a turn that succeeded changes nothing', async () => {
      const { errors } = await runTurn('s-window-ok', [sdkResult()],
        () => noteGatewayFailure('s-window-ok', TOO_LARGE, 'context_window_exceeded'));
      expect(errors).toEqual([]);
      expect(lastSettlement().outcome.stopReason).not.toBe('context_window_exceeded');
    });

    it('an uncoded gateway note still settles as before', async () => {
      await runTurn('s-uncoded', [{ ...sdkResult(), is_error: true, modelUsage: {} }],
        () => noteGatewayFailure('s-uncoded', NOTE));
      expect(lastSettlement().sdkUsage).toMatchObject({ usageNote: 'no_result', usageConfirmed: false });
    });
  });

  describe('a refused tool-call batch (W04 #11397)', () => {
    const REFUSED = 'refused 1 tool call(s): delete_all_devices (not offered)';
    const CONSTRAINED_NOTE = 'This model produced a tool call Breeze could not use. Try again, or ask a narrower question.';
    const lastSettlement = () => vi.mocked(settleInvocation).mock.lastCall?.[0] as unknown as {
      outcome: { stopReason: string };
    };
    const refusedTurn = [
      { type: 'stream_event', event: { type: 'message_start', message: {} } },
      { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: UNSAFE_TOOL_CALL_NOTE } } },
      { type: 'assistant', message: { model: 'qwen', content: [{ type: 'text', text: UNSAFE_TOOL_CALL_NOTE }], usage: { input_tokens: 1, output_tokens: 1 } } },
      sdkResult(),
    ];

    async function runRefused(sessionId: string, promptMode: 'standard' | 'constrained' | null) {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      m.queryMock.mockImplementation(() => scriptedQuery(refusedTurn, gate));
      const session = await manager.getOrCreate(
        sessionId, baseDbSession, baseAuth, undefined, 'PROMPT', undefined, makeResolvedModel('openai_compatible'),
      );
      if (promptMode) {
        session.toolExposure = {
          profile: promptMode === 'constrained' ? 'minimal' : 'full', names: null, extraToolNames: [], promptMode,
          toolSearchAllowed: promptMode !== 'constrained', compactSchemas: promptMode === 'constrained', resultCharBudget: 1000,
          fingerprint: 'fp', droppedCustomNames: [], tooSmall: false,
        } satisfies ToolExposure;
      }
      noteGatewayFailure(sessionId, REFUSED, 'refused_tool_batch');
      release();
      await session.processorPromise;
      const deltas = session.eventBus.getReplayEvents()
        .flatMap((e) => (e.type === 'content_delta' ? [String((e as { delta?: unknown }).delta)] : []));
      const persisted = insertedAssistantMessages(vi.mocked(db.insert)).map((r) => r.content);
      return { session, deltas, persisted, errors: errorMessages(session) };
    }

    it('settles the turn as refused_tool_batch and shows no error', async () => {
      const { errors } = await runRefused('s-refused', null);
      expect(errors).toEqual([]);
      expect(lastSettlement().outcome.stopReason).toBe('refused_tool_batch');
      expect(takeGatewayFailureNote('s-refused')).toBeNull();
    });

    it('a constrained profile swaps the note for the narrower-question message, streamed and persisted', async () => {
      const { deltas, persisted } = await runRefused('s-refused-constrained', 'constrained');
      expect(deltas).toEqual([CONSTRAINED_NOTE]);
      expect(persisted).toEqual([CONSTRAINED_NOTE]);
      expect(lastSettlement().outcome.stopReason).toBe('refused_tool_batch');
    });

    it('the full exposure keeps the generic note unchanged', async () => {
      const { deltas, persisted } = await runRefused('s-refused-full', 'standard');
      expect(deltas).toEqual([UNSAFE_TOOL_CALL_NOTE]);
      expect(persisted).toEqual([UNSAFE_TOOL_CALL_NOTE]);
    });

    it('its log-safe description is never shown as a later failure\'s reason', async () => {
      const { errors } = await runTurn('s-refused-err', [{ ...sdkResult({ subtype: 'error_during_execution' }), errors: ['boom'] }],
        () => noteGatewayFailure('s-refused-err', REFUSED, 'refused_tool_batch'));
      expect(errors).toEqual(['An internal error occurred. Please try again.']);
      expect(lastSettlement().outcome.stopReason).toBe('refused_tool_batch');
    });
  });

  it('a note for another session never leaks into this one', async () => {
    const { errors } = await runTurn('s-mine', [{ ...sdkResult({ subtype: 'error_during_execution' }), errors: ['x'] }],
      () => noteGatewayFailure('s-other', NOTE));
    expect(errors).toEqual(['An internal error occurred. Please try again.']);
    expect(takeGatewayFailureNote('s-other')).toBe(NOTE);
  });

  it('a turn timeout names the gateway reason when there is one', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    m.queryMock.mockImplementation(() => scriptedQuery([], gate));
    const session = await manager.getOrCreate(
      's-timeout', baseDbSession, baseAuth, undefined, 'PROMPT', undefined, makeResolvedModel('openai_compatible'),
    );
    vi.useFakeTimers();
    session.state = 'processing';
    manager.startTurnTimeout(session);
    noteGatewayFailure('s-timeout', NOTE);
    vi.advanceTimersByTime(60 * 60_000);
    const errors = errorMessages(session);
    expect(errors).toEqual([`AI request timed out. ${NOTE}`]);
    vi.useRealTimers();
    release();
    await session.processorPromise;
  });
});
