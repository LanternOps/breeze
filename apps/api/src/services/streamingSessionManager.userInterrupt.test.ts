/**
 * #11676: pressing Stop mid-reply (`POST /ai/sessions/:id/interrupt`) ends the
 * turn cleanly. The CLI closes an interrupted turn with a non-success result
 * (or a success flagged is_error); before, that went down the generic failure
 * path and the technician saw "An internal error occurred. Please try again."
 * for a stop they asked for. Now the turn publishes no `error`, `done` says
 * `stopped`, nothing reaches Sentry or the error log, and a real failure on a
 * turn nobody stopped still shows its error.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ queryMock: vi.fn(), settle: vi.fn(), capture: vi.fn() }));

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
  settleInvocation: m.settle,
}));
vi.mock('./aiModels/offeringHealth', async (orig) => ({
  ...(await orig<typeof import('./aiModels/offeringHealth')>()),
  noteProviderFailureForBinding: vi.fn(async () => undefined),
}));
vi.mock('./aiAgent', () => ({ sanitizeErrorForClient: () => 'An internal error occurred. Please try again.' }));
vi.mock('./sentry', () => ({ captureException: m.capture, captureMessage: vi.fn() }));
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
vi.mock('./flows/flowTools', () => ({ resolveFlowTools: async () => [] }));

import { db } from '../db';
import { StreamingSessionManager, type ActiveSession } from './streamingSessionManager';
import { __resetGatewayFailureNotesForTests } from './aiModels/gateway/failureNotes';
import { makeResolvedModel } from './aiModels/__fixtures__/resolvedModel';
import { baseAuth, baseDbSession, insertedAssistantMessages, sdkResult } from './__testutils__/streamingSessionManagerHarness';

type Ev = Record<string, unknown> & { type: string };

const GENERIC = 'An internal error occurred. Please try again.';
const PARTIAL = 'Step 1: confirm the practice management system';

const streamedPartial = [
  { type: 'stream_event', event: { type: 'message_start' } },
  { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
  { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: PARTIAL } } },
];
// The CLI's frames for the interrupted turn: the truncated assistant message, then the result.
const abortedAssistant = {
  type: 'assistant',
  aborted: true,
  message: { model: 'claude-x', content: [{ type: 'text', text: PARTIAL }], usage: { input_tokens: 1, output_tokens: 1 } },
};
const interruptedResult = { ...sdkResult({ subtype: 'error_during_execution' }), errors: ['Request was aborted.'] };
const interruptedIsError = { ...sdkResult(), is_error: true, result: 'Request interrupted by user' };

let manager: StreamingSessionManager;
let errorLog: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  m.settle.mockImplementation(async () => ({ costCents: 0, invocationIds: [], deferred: false }));
  __resetGatewayFailureNotesForTests();
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  manager = new StreamingSessionManager();
});
afterEach(() => {
  manager.shutdown();
  errorLog.mockRestore();
});

/**
 * One turn: the partial reply streams, then the query waits for an interrupt
 * (or, with `stop: false`, is simply released) before yielding `tail`.
 * `tail` may be an Error, which the iterator throws instead.
 */
async function runTurn(
  sessionId: string,
  tail: unknown[] | Error,
  opts: { stop?: boolean; interruptRejects?: boolean } = {},
): Promise<{ events: Ev[]; session: ActiveSession; interrupted: { interrupted: boolean; reason?: string } | null }> {
  const stop = opts.stop ?? true;
  let releaseStart!: () => void;
  const start = new Promise<void>((r) => (releaseStart = r));
  let releaseTail!: () => void;
  const tailGate = new Promise<void>((r) => (releaseTail = r));
  let streamed!: () => void;
  const partialSeen = new Promise<void>((r) => (streamed = r));
  let close!: () => void;
  const closed = new Promise<void>((r) => (close = r));
  const query = {
    async *[Symbol.asyncIterator]() {
      await start;
      yield* streamedPartial;
      streamed();
      await tailGate;
      if (tail instanceof Error) throw tail;
      yield* tail;
      // A live query outlives its turn: it waits for the next message until closed.
      await closed;
    },
    interrupt: vi.fn(async () => {
      if (opts.interruptRejects) throw new Error('control request failed');
      releaseTail();
    }),
    close: vi.fn(() => close()),
  };
  m.queryMock.mockImplementation(() => query);
  const session = await manager.getOrCreate(sessionId, baseDbSession, baseAuth, undefined, 'PROMPT', undefined, makeResolvedModel());
  expect(manager.tryTransitionToProcessing(session)).toBe(true);
  releaseStart();
  await partialSeen;
  // Only what the stop and the turn's end report counts (session setup in this
  // harness has unrelated fire-and-forget reads against the mocked db).
  await new Promise((r) => setTimeout(r, 5));
  m.capture.mockClear();
  errorLog.mockClear();
  let interrupted: { interrupted: boolean; reason?: string } | null = null;
  if (stop) {
    interrupted = await manager.interrupt(sessionId);
    if (opts.interruptRejects) releaseTail();
  } else {
    releaseTail();
  }
  const events = () => session.eventBus.getReplayEvents() as unknown as Ev[];
  for (let i = 0; i < 200 && !events().some((e) => e.type === 'done'); i++) {
    await new Promise((r) => setTimeout(r, 1));
  }
  // Let the turn's tail (state flip, after-done hooks) finish.
  await new Promise((r) => setTimeout(r, 5));
  return { events: session.eventBus.getReplayEvents() as unknown as Ev[], session, interrupted };
}

const errorsOf = (events: Ev[]) => events.filter((e) => e.type === 'error').map((e) => e.message);
const donesOf = (events: Ev[]) => events.filter((e) => e.type === 'done');

describe('#11676: a user-requested stop is not an error', () => {
  it.each([
    ['error_during_execution result', [abortedAssistant, interruptedResult]],
    ['success result flagged is_error', [abortedAssistant, interruptedIsError]],
  ] as const)('%s after interrupt(): no error event, done says stopped', async (_name, tail) => {
    const { events, interrupted } = await runTurn(`s-stop-${_name.length}`, [...tail]);
    expect(interrupted).toEqual({ interrupted: true });
    expect(errorsOf(events)).toEqual([]);
    const dones = donesOf(events);
    expect(dones).toHaveLength(1);
    expect(dones[0]).toMatchObject({ type: 'done', stopped: true });
  });

  it('keeps the partial reply: it was streamed and persisted as the assistant turn', async () => {
    const { events } = await runTurn('s-stop-partial', [abortedAssistant, interruptedResult]);
    const text = events.filter((e) => e.type === 'content_delta').map((e) => e.delta).join('');
    expect(text).toBe(PARTIAL);
    expect(insertedAssistantMessages(vi.mocked(db.insert)).map((r) => r.content)).toEqual([PARTIAL]);
  });

  it('reports nothing to Sentry and logs nothing at error level', async () => {
    await runTurn('s-stop-quiet', [abortedAssistant, interruptedResult]);
    expect(m.capture).not.toHaveBeenCalled();
    expect(errorLog).not.toHaveBeenCalled();
  });

  it('an iterator that aborts after interrupt() also ends as a clean stop', async () => {
    const abort = Object.assign(new Error('Operation aborted'), { name: 'AbortError' });
    const { events } = await runTurn('s-stop-abort', abort);
    expect(errorsOf(events)).toEqual([]);
    expect(donesOf(events)).toEqual([{ type: 'done', stopped: true }]);
    expect(m.capture).not.toHaveBeenCalled();
    expect(errorLog).not.toHaveBeenCalled();
  });

  it('a non-abort crash after interrupt() is still reported', async () => {
    const { events } = await runTurn('s-stop-crash', new Error('subprocess exited 137'));
    expect(errorsOf(events)).toEqual([GENERIC]);
    expect(m.capture).toHaveBeenCalled();
  });

  it('the session stays usable: idle after the stopped turn', async () => {
    const { session } = await runTurn('s-stop-idle', [abortedAssistant, interruptedResult]);
    expect(session.state).toBe('idle');
    expect(session.userInterrupted).toBe(false);
  });
});

describe('#11676 controls: real failures still show their error', () => {
  it('the same failed result on a turn nobody stopped publishes the generic error', async () => {
    const { events } = await runTurn('s-nostop', [interruptedResult], { stop: false });
    expect(errorsOf(events)).toEqual([GENERIC]);
    expect(donesOf(events)[0]).not.toHaveProperty('stopped');
  });

  it('an is_error result on a turn nobody stopped still publishes an error', async () => {
    const { events } = await runTurn('s-nostop-iserror', [interruptedIsError], { stop: false });
    expect(errorsOf(events)).toHaveLength(1);
  });

  it('an interrupt the SDK refused does not mark the turn stopped', async () => {
    const { events, interrupted } = await runTurn('s-refused-stop', [interruptedResult], { interruptRejects: true });
    expect(interrupted).toEqual({ interrupted: false, reason: 'Failed to interrupt SDK query' });
    expect(errorsOf(events)).toEqual([GENERIC]);
  });

  it('a stop left over from an earlier turn never hides the next turn\'s failure', async () => {
    const { session } = await runTurn('s-leftover', [interruptedResult], { stop: false });
    session.userInterrupted = true; // e.g. a Stop that landed as the turn finished
    expect(manager.tryTransitionToProcessing(session)).toBe(true);
    expect(session.userInterrupted).toBe(false);
  });
});
