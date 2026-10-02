/**
 * #7794: when the model gateway gave up on an upstream (e.g. the response-header
 * deadline on a slow local server), the chat turn's error says why, instead of a
 * generic "internal error", a bare timeout, or nothing at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: m.queryMock }));
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

import { StreamingSessionManager } from './streamingSessionManager';
import { __resetGatewayFailureNotesForTests, noteGatewayFailure, takeGatewayFailureNote } from './aiModels/gateway/failureNotes';
import { makeResolvedModel } from './aiModels/__fixtures__/resolvedModel';
import { baseAuth, baseDbSession, scriptedQuery, sdkResult } from './__testutils__/streamingSessionManagerHarness';

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
