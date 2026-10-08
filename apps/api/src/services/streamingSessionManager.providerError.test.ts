/**
 * #7785: a chat turn the CLI ends with `{subtype:'success', is_error:true}`
 * after a provider status error (529 / 429 / 401 / low-credit 400) publishes a
 * client-safe error event. Before, the stream carried only `turn_model` and
 * `done`, and the technician saw an empty answer with no reason.
 *
 * Frames are the real Agent SDK CLI 0.3.286 shapes from the W09 lab (L1):
 * docs/testing/lab/2026-10-02-ai-model-registry-w09-l1-l3.md.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ queryMock: vi.fn(), settle: vi.fn() }));

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
  settleInvocation: m.settle,
}));
vi.mock('./aiModels/offeringHealth', async (orig) => ({
  ...(await orig<typeof import('./aiModels/offeringHealth')>()),
  noteProviderFailureForBinding: vi.fn(async () => undefined),
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
import { __resetGatewayFailureNotesForTests, noteGatewayFailure } from './aiModels/gateway/failureNotes';
import { providerFailureMessage } from './aiModels/providerFailureMessage';
import { makeResolvedModel } from './aiModels/__fixtures__/resolvedModel';
import { baseAuth, baseDbSession, scriptedQuery, sdkResult } from './__testutils__/streamingSessionManagerHarness';

let manager: StreamingSessionManager;

beforeEach(() => {
  vi.clearAllMocks();
  m.settle.mockImplementation(async () => ({ costCents: 0, invocationIds: [], deferred: false }));
  __resetGatewayFailureNotesForTests();
  manager = new StreamingSessionManager();
});
afterEach(() => {
  manager.shutdown();
});

type Ev = Record<string, unknown> & { type: string };

async function runTurn(sessionId: string, messages: unknown[], beforeRun?: () => void): Promise<Ev[]> {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  m.queryMock.mockImplementation(() => scriptedQuery(messages, gate));
  const session = await manager.getOrCreate(
    sessionId, baseDbSession, baseAuth, undefined, 'PROMPT', undefined, makeResolvedModel(),
  );
  beforeRun?.();
  release();
  await session.processorPromise;
  return session.eventBus.getReplayEvents() as unknown as Ev[];
}

const errorsOf = (events: Ev[]) => events.filter((e) => e.type === 'error').map((e) => e.message);

const synthetic = (error: string, text: string) => ({
  type: 'assistant',
  error,
  message: { model: '<synthetic>', content: [{ type: 'text', text }], usage: { input_tokens: 0, output_tokens: 0 } },
});
const retry = (error: string, status: number, attempt: number) => ({
  type: 'system', subtype: 'api_retry', error, error_status: status, attempt,
});
const isErrorResult = (apiErrorStatus: number) => ({ ...sdkResult(), is_error: true, api_error_status: apiErrorStatus, result: `API Error: ${apiErrorStatus}` });

describe('#7785: a pre-output provider failure publishes an error', () => {
  it.each([
    ['529 overloaded', [retry('overloaded', 529, 1), retry('overloaded', 529, 2), synthetic('server_error', 'API Error: 529 Overloaded'), isErrorResult(529)], 'overloaded'],
    ['429 rate limit', [retry('rate_limit', 429, 1), synthetic('rate_limit', 'API Error: 429'), isErrorResult(429)], 'rate_limited'],
    ['401 auth', [retry('authentication_failed', 401, 1), synthetic('authentication_failed', 'Invalid API key'), isErrorResult(401)], 'auth_failed'],
    ['low-credit 400', [synthetic('billing_error', 'Credit balance is too low'), isErrorResult(400)], 'quota_exhausted'],
  ] as const)('%s: error event names the cause, then turn_model, then done', async (_name, frames, cause) => {
    const events = await runTurn(`s-${cause}`, [...frames]);
    const expected = providerFailureMessage({ cause, terminal: true }, false);
    expect(errorsOf(events)).toEqual([expected]);
    const types = events.map((e) => e.type);
    expect(types.indexOf('error')).toBeLessThan(types.indexOf('done'));
    expect(types.filter((t) => t === 'done')).toHaveLength(1);
  });

  it('the raw synthetic provider text is never streamed as answer content', async () => {
    const events = await runTurn('s-raw', [synthetic('server_error', 'API Error: 529 {"type":"error"}'), isErrorResult(529)]);
    expect(events.some((e) => e.type === 'content_delta')).toBe(false);
  });

  it('an unclassified is_error result still publishes a generic error (never a silent empty turn)', async () => {
    const events = await runTurn('s-unknown', [synthetic('invalid_request', 'API Error: 400 bad'), isErrorResult(400)]);
    expect(errorsOf(events)).toEqual([providerFailureMessage(null, false)]);
  });

  it('a gateway note still wins over the classified cause (#7794)', async () => {
    const NOTE = 'The model endpoint did not start responding in time.';
    const events = await runTurn('s-note', [synthetic('server_error', 'x'), isErrorResult(529)], () => noteGatewayFailure('s-note', NOTE));
    expect(errorsOf(events)).toEqual([NOTE]);
  });

  it('an error_during_execution result after a classified failure names the cause instead of the generic sanitized text', async () => {
    const events = await runTurn('s-ede', [
      synthetic('rate_limit', 'API Error: 429'),
      { ...sdkResult({ subtype: 'error_during_execution' }), errors: ['API Error: 429'] },
    ]);
    expect(errorsOf(events)).toEqual([providerFailureMessage({ cause: 'rate_limited', terminal: true }, false)]);
  });

  it('a successful turn publishes no error', async () => {
    const events = await runTurn('s-ok', [sdkResult()]);
    expect(errorsOf(events)).toEqual([]);
  });

  it('settlement of the failed turn is unchanged: settled once, zero tokens, done carries zero usage', async () => {
    const events = await runTurn('s-settle', [synthetic('server_error', 'x'), isErrorResult(529)]);
    expect(m.settle).toHaveBeenCalledTimes(1);
    const done = events.find((e) => e.type === 'done') as { usage?: { inputTokens: number; outputTokens: number; costCents: number } };
    expect(done.usage).toEqual({ inputTokens: 0, outputTokens: 0, costCents: 0 });
  });
});
