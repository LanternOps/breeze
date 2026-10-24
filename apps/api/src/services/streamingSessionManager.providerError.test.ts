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

import { db } from '../db';
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

async function runTurn(
  sessionId: string,
  messages: unknown[],
  beforeRun?: () => void,
  resolved = makeResolvedModel(),
): Promise<Ev[]> {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  m.queryMock.mockImplementation(() => scriptedQuery(messages, gate));
  const session = await manager.getOrCreate(
    sessionId, baseDbSession, baseAuth, undefined, 'PROMPT', undefined, resolved,
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
    // The default fixture binding is the platform connection (#9534).
    const expected = providerFailureMessage(cause, false, { platformKey: true });
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
    expect(errorsOf(events)).toEqual([providerFailureMessage('rate_limited', false)]);
  });

  it('a failure after streamed output never promises a backup model (the offering is not cooled)', async () => {
    const events = await runTurn('s-output', [
      { type: 'stream_event', event: { type: 'message_start' } },
      { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Partial' } } },
      synthetic('server_error', 'API Error: 529'),
      isErrorResult(529),
    ]);
    const expected = providerFailureMessage('overloaded', true);
    expect(expected).not.toMatch(/backup/);
    expect(errorsOf(events)).toEqual([expected]);
  });

  it('an is_error turn that settles as a refusal publishes the refusal, not a provider error', async () => {
    const events = await runTurn('s-refused', [
      { type: 'system', subtype: 'model_refusal_no_fallback', api_refusal_category: 'cyber' },
      { ...sdkResult({ stop_reason: 'refusal' }), is_error: true },
    ]);
    expect(errorsOf(events)).toEqual([]);
    expect(events.some((e) => e.type === 'model_refusal')).toBe(true);
  });

  it('a retried-then-recovered 529 is never blamed for a later unrelated failure', async () => {
    const events = await runTurn('s-stale', [
      retry('overloaded', 529, 1),
      { type: 'stream_event', event: { type: 'message_start' } },
      { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
      { ...sdkResult({ subtype: 'error_during_execution' }), errors: ['boom'] },
    ]);
    expect(errorsOf(events)).toEqual(['An internal error occurred. Please try again.']);
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

// #9534: the CLI's synthetic text for a 401 is "Invalid API key · Fix external
// API key" — a Claude Code CTA that sends a hosted partner user to a BYO-key
// page that cannot fix a platform credential. It was persisted as the
// assistant turn, so it rendered on every reload of the conversation.
describe('#9534: a rejected key names who can fix it, and the CLI text is never persisted', () => {
  const CLI_TEXT = 'Invalid API key · Fix external API key';
  const authFrames = () => [retry('authentication_failed', 401, 1), synthetic('authentication_failed', CLI_TEXT), isErrorResult(401)];
  const persistedAssistantRows = () => vi.mocked(db.insert).mock.results
    .flatMap((r) => (r.value as { values: { mock: { calls: unknown[][] } } }).values.mock.calls)
    .map((call) => call[0] as { role?: string; content?: string | null; contentBlocks?: unknown })
    .filter((row) => row.role === 'assistant');

  it('platform key: the error tells the user to contact their administrator', async () => {
    const events = await runTurn('s-platform-401', authFrames());
    expect(errorsOf(events)).toEqual([providerFailureMessage('auth_failed', false, { platformKey: true })]);
    expect(errorsOf(events)[0]).toMatch(/contact your administrator/i);
  });

  it('partner BYO key: the error points at the key configured for this model', async () => {
    const events = await runTurn('s-byok-401', authFrames(), undefined, makeResolvedModel('anthropic_byok'));
    expect(errorsOf(events)).toEqual([providerFailureMessage('auth_failed', false, { platformKey: false })]);
    expect(errorsOf(events)[0]).not.toMatch(/server's/);
  });

  it('persists the client-safe message as the assistant turn, never the CLI text', async () => {
    await runTurn('s-persist-401', authFrames());
    const rows = persistedAssistantRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.content).toBe(providerFailureMessage('auth_failed', false, { platformKey: true }));
    expect(JSON.stringify(rows[0])).not.toContain('Invalid API key');
    expect(JSON.stringify(rows[0])).not.toContain('Fix external API key');
  });

  it('BYO key: the persisted turn carries the partner-key text, not the administrator one', async () => {
    await runTurn('s-persist-byok-401', authFrames(), undefined, makeResolvedModel('anthropic_byok'));
    const rows = persistedAssistantRows();
    const expected = providerFailureMessage('auth_failed', false, { platformKey: false });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.content).toBe(expected);
    expect(rows[0]?.contentBlocks).toEqual([{ type: 'text', text: expected }]);
  });

  it('an error-tagged message the MODEL wrote (not <synthetic>) keeps its own text', async () => {
    await runTurn('s-persist-model-error', [
      { type: 'assistant', error: 'max_output_tokens', message: { model: 'claude-x', content: [{ type: 'text', text: 'Partial answer' }], usage: { input_tokens: 1, output_tokens: 1 } } },
      sdkResult(),
    ]);
    expect(persistedAssistantRows().map((r) => r.content)).toEqual(['Partial answer']);
  });

  it('a real (non-synthetic) assistant message is still persisted verbatim', async () => {
    await runTurn('s-persist-ok', [
      { type: 'assistant', message: { model: 'claude-x', content: [{ type: 'text', text: 'All 4 devices are online.' }], usage: { input_tokens: 1, output_tokens: 1 } } },
      sdkResult(),
    ]);
    expect(persistedAssistantRows().map((r) => r.content)).toEqual(['All 4 devices are online.']);
  });
});
