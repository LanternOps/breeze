/**
 * #9428: every chat-turn `error` event carries a machine `code`, so a client
 * decides from the code (never the message text) whether "Try again" can help.
 * Message text is unchanged at every site (older clients keep working); a
 * timeout's gateway reason is ALSO carried as `detail`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: m.queryMock }));
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
import { __resetGatewayFailureNotesForTests, noteGatewayFailure } from './aiModels/gateway/failureNotes';
import { makeResolvedModel } from './aiModels/__fixtures__/resolvedModel';
import { baseAuth, baseDbSession, scriptedQuery, sdkResult } from './__testutils__/streamingSessionManagerHarness';

const NOTE = 'The model endpoint did not start responding within 120 s (the gateway\'s response-header deadline).';

type ErrorEvent = { type: 'error'; message: string; code?: string; detail?: string };

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

function errorsOf(session: { eventBus: { getReplayEvents(): Array<{ type: string }> } }): ErrorEvent[] {
  return session.eventBus.getReplayEvents().filter((e): e is ErrorEvent => e.type === 'error');
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
  return errorsOf(session);
}

const synthetic = (error: string, text: string) => ({
  type: 'assistant',
  error,
  message: { model: '<synthetic>', content: [{ type: 'text', text }], usage: { input_tokens: 0, output_tokens: 0 } },
});
const isErrorResult = (status: number) => ({ ...sdkResult(), is_error: true, api_error_status: status, result: `API Error: ${status}` });

async function timeOut(sessionId: string, beforeFire?: () => void) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  m.queryMock.mockImplementation(() => scriptedQuery([], gate));
  const session = await manager.getOrCreate(
    sessionId, baseDbSession, baseAuth, undefined, 'PROMPT', undefined, makeResolvedModel('openai_compatible'),
  );
  vi.useFakeTimers();
  session.state = 'processing';
  manager.startTurnTimeout(session);
  beforeFire?.();
  vi.advanceTimersByTime(60 * 60_000);
  const errors = errorsOf(session);
  vi.useRealTimers();
  release();
  await session.processorPromise;
  return { errors };
}

describe('error event codes (#9428)', () => {
  it('a turn timeout is coded timeout, with the stock message and no detail', async () => {
    const { errors } = await timeOut('s-timeout');
    expect(errors).toEqual([{ type: 'error', message: 'AI request timed out. Please try again.', code: 'timeout' }]);
  });

  it('a timeout behind a gateway failure keeps its message and carries the reason as detail', async () => {
    const { errors } = await timeOut('s-timeout-note', () => noteGatewayFailure('s-timeout-note', NOTE));
    expect(errors).toEqual([{ type: 'error', message: `AI request timed out. ${NOTE}`, code: 'timeout', detail: NOTE }]);
  });

  it('a failed result (error_during_execution) is a retryable provider_error', async () => {
    const errors = await runTurn('s-ede', [{ ...sdkResult({ subtype: 'error_during_execution' }), errors: ['boom'] }]);
    expect(errors).toEqual([{ type: 'error', message: 'An internal error occurred. Please try again.', code: 'provider_error' }]);
  });

  it('a failed result behind a gateway note keeps the note as its message', async () => {
    const errors = await runTurn('s-ede-note', [{ ...sdkResult({ subtype: 'error_during_execution' }), errors: ['API Error: 504'] }],
      () => noteGatewayFailure('s-ede-note', NOTE));
    expect(errors).toEqual([{ type: 'error', message: NOTE, code: 'provider_error' }]);
  });

  it('the per-query budget limit is budget_exceeded', async () => {
    const errors = await runTurn('s-budget', [{ ...sdkResult({ subtype: 'error_max_budget_usd' }), errors: [] }]);
    expect(errors).toEqual([{ type: 'error', message: 'AI budget limit reached for this query.', code: 'budget_exceeded' }]);
  });

  it('the conversation turn cap keeps its existing turn_limit_reached code', async () => {
    const errors = await runTurn('s-turns', [{ ...sdkResult({ subtype: 'error_max_turns' }), errors: [] }]);
    expect(errors).toEqual([expect.objectContaining({ code: 'turn_limit_reached' })]);
  });

  it.each([
    ['529 overloaded', 'server_error', 529, 'provider_error'],
    ['429 rate limit', 'rate_limit', 429, 'rate_limited'],
    ['401 auth', 'authentication_failed', 401, 'provider_auth'],
    ['low-credit 400', 'billing_error', 400, 'provider_quota'],
    ['unclassified 400', 'invalid_request', 400, 'provider_error'],
  ] as const)('a provider failure (%s) is coded from its cause', async (_name, sdkError, status, code) => {
    const errors = await runTurn(`s-${code}-${status}`, [synthetic(sdkError, `API Error: ${status}`), isErrorResult(status)]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe(code);
  });

  it('a context-window refusal is context_window_exceeded (a retry would be refused again)', async () => {
    const TOO_LARGE = 'This request is about 140,000 tokens, which does not fit.';
    const errors = await runTurn('s-window', [{ ...sdkResult(), is_error: true, modelUsage: {} }],
      () => noteGatewayFailure('s-window', TOO_LARGE, 'context_window_exceeded'));
    expect(errors).toEqual([{ type: 'error', message: TOO_LARGE, code: 'context_window_exceeded' }]);
  });

  it('a query that throws is a retryable provider_error', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    m.queryMock.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() { await gate; throw new Error('Claude Code process exited with code 1'); },
      interrupt: vi.fn(), close: vi.fn(),
    }));
    const session = await manager.getOrCreate(
      's-throw', baseDbSession, baseAuth, undefined, 'PROMPT', undefined, makeResolvedModel('openai_compatible'),
    );
    release();
    await session.processorPromise;
    expect(errorsOf(session)).toEqual([{ type: 'error', message: 'An internal error occurred. Please try again.', code: 'provider_error' }]);
  });
});
