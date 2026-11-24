/**
 * #11818 — the Agent SDK `session_writes_lost` system message. When the CLI
 * could not save this session's transcript (full disk / quota), the next turn
 * must not `resume` it. The mock block mirrors streamingSessionManager.modelSwitch.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  queryImpl: null as null | ((args: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => unknown),
  queryArgs: [] as Array<{ prompt: AsyncIterable<unknown>; options: Record<string, unknown> }>,
  storePointer: vi.fn(async () => true),
  clearPointer: vi.fn(async () => true),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
    m.queryArgs.push(args);
    return m.queryImpl!(args);
  },
}));
vi.mock('./aiSdkSessionPointer', () => ({
  storeSdkSessionPointer: m.storePointer,
  clearSdkSessionPointer: m.clearPointer,
}));
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
  markAiBudgetReservationIndeterminate: vi.fn(async () => ({ kind: 'indeterminate' })),
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
vi.mock('./flows/flowTools', () => ({ resolveFlowTools: async () => [] }));

import { StreamingSessionManager } from './streamingSessionManager';
import { makeResolvedModel } from './aiModels/__fixtures__/resolvedModel';
import {
  baseAuth, baseDbSession, scriptedQuery, sdkResult, turnScriptedQuery,
} from './__testutils__/streamingSessionManagerHarness';

let mgr: StreamingSessionManager;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  m.queryArgs.length = 0;
  m.queryImpl = () => scriptedQuery([]);
  mgr = new StreamingSessionManager();
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  mgr.shutdown();
  errorSpy.mockRestore();
});

const init = (sid: string) => ({ type: 'system', subtype: 'init', session_id: sid });
const lost = (over: Record<string, unknown> = {}) => ({
  type: 'system', subtype: 'session_writes_lost', uuid: 'u1', session_id: 'sdk-1',
  error_code: 'ENOSPC', lost: ['transcript'], transcript_session_ids: ['sdk-1'], ...over,
});
const lostLines = () => errorSpy.mock.calls.filter((c: unknown[]) => String(c[0]).includes('session_writes_lost'));
const model = () => makeResolvedModel('anthropic_byok');
const settle = () => new Promise((r) => setTimeout(r, 25));

/**
 * One live query (turnScriptedQuery keeps the processor, and so the session,
 * alive across turns): turn 1 streams `messages`. `next` is the route's next
 * getOrCreate, called with the DB row as it would read if the pointer clear
 * had not landed (still `sdk-1`).
 */
async function liveSessionAfterTurn(messages: unknown[]) {
  m.queryImpl = (args) => turnScriptedQuery(args.prompt, [messages, [sdkResult({})]]);
  const first = await mgr.getOrCreate('s1', { ...baseDbSession }, baseAuth, undefined, 'sys', 1, model());
  first.inputController.pushMessage('hello');
  await settle();
  first.state = 'idle';
  const next = () =>
    mgr.getOrCreate('s1', { ...baseDbSession, sdkSessionId: 'sdk-1' }, baseAuth, undefined, 'sys', 1, model());
  return { first, next };
}

describe('session_writes_lost (#11818)', () => {
  it('transcript lost for this session: next turn recreates the query without resume, pointer cleared, one error log', async () => {
    const { first, next } = await liveSessionAfterTurn([init('sdk-1'), sdkResult({}), lost()]);
    expect(first.forceRecreate).toBe(true);
    expect(m.clearPointer).toHaveBeenCalledWith(expect.objectContaining({ breezeSessionId: 's1', sdkSessionId: 'sdk-1' }));
    expect(lostLines()).toHaveLength(1);
    expect(lostLines()[0]![1]).toMatchObject({ breezeSessionId: 's1', sdkSessionId: 'sdk-1', errorCode: 'ENOSPC', lost: ['transcript'] });
    expect(JSON.stringify(lostLines()[0])).not.toContain('hello');

    const second = await next(); // stale row still says sdk-1: the in-process block must win
    expect(second).not.toBe(first);
    expect(m.queryArgs).toHaveLength(2);
    expect(m.queryArgs[1]!.options.resume).toBeUndefined();
  });

  it('a failed pointer clear still blocks resume in this process', async () => {
    m.clearPointer.mockRejectedValueOnce(new Error('db down'));
    const { next } = await liveSessionAfterTurn([init('sdk-1'), sdkResult({}), lost()]);
    await next();
    expect(m.queryArgs.at(-1)!.options.resume).toBeUndefined();
  });

  it('transcript lost for a DIFFERENT session id: live query reused, nothing cleared', async () => {
    const { first, next } = await liveSessionAfterTurn([init('sdk-1'), sdkResult({}), lost({ transcript_session_ids: ['sdk-other'] })]);
    expect(first.forceRecreate).toBe(false);
    expect(m.clearPointer).not.toHaveBeenCalled();
    expect(lostLines()).toHaveLength(1);
    expect(await next()).toBe(first);
    expect(m.queryArgs).toHaveLength(1);
  });

  it('transcript lost but no transcript_session_ids: unchanged, logged', async () => {
    const { first } = await liveSessionAfterTurn([init('sdk-1'), sdkResult({}), lost({ transcript_session_ids: undefined })]);
    expect(first.forceRecreate).toBe(false);
    expect(m.clearPointer).not.toHaveBeenCalled();
    expect(lostLines()).toHaveLength(1);
  });

  it('only global_config lost: unchanged, logged', async () => {
    const { first, next } = await liveSessionAfterTurn([
      init('sdk-1'), sdkResult({}), lost({ lost: ['global_config'], transcript_session_ids: undefined }),
    ]);
    expect(first.forceRecreate).toBe(false);
    expect(m.clearPointer).not.toHaveBeenCalled();
    expect(lostLines()).toHaveLength(1);
    expect(await next()).toBe(first);
  });

  it('a stream that never emits it: no log, live query reused', async () => {
    const { first, next } = await liveSessionAfterTurn([init('sdk-1'), sdkResult({})]);
    expect(lostLines()).toHaveLength(0);
    expect(await next()).toBe(first);
  });
});
