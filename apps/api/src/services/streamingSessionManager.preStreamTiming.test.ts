/**
 * #11004 wiring: getOrCreate's creation path records its phases into the
 * caller's pre-stream timer — the MCP server build and the subprocess spawn
 * by name — so a slow one is named in the single warn line. Every
 * performance.now() call advances the fake clock by 600 ms, so EVERY recorded
 * phase crosses the 500 ms threshold and appears in the line.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  queryImpl: null as null | ((args: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => unknown),
  queryArgs: [] as Array<{ prompt: AsyncIterable<unknown>; options: Record<string, unknown> }>,
  settleInvocation: vi.fn(),
  snapshots: new Map<string, unknown>(),
  readSdkUsageSnapshot: vi.fn(),
  markIndeterminate: vi.fn(async () => ({ kind: 'indeterminate' })),
  settleOrder: [] as string[],
  listRefusalAlternatives: vi.fn(),
  noteProviderFailureForBinding: vi.fn(async (..._a: unknown[]) => undefined),
}));
// W09 (#7607): the chat cooldown write (Redis; fails open).
vi.mock('./aiModels/offeringHealth', () => ({ noteProviderFailureForBinding: m.noteProviderFailureForBinding }));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
    m.queryArgs.push(args);
    return m.queryImpl!(args);
  },
}));
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
// W11: a registry with an active variant for chat/claude-small. The fixture's
// default profile (claude-standard) has none, so every existing test still
// sends the base prompt.
vi.mock('./aiModels/promptVariants', async (orig) => ({
  ...(await orig<typeof import('./aiModels/promptVariants')>()),
  PROMPT_VARIANTS: [
    { id: 'chat/claude-small@1', surface: 'chat', profile: 'claude-small', version: 1, state: 'active', canaryPercent: 0, guidance: 'Small guidance.', hypothesis: 'h' },
  ],
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
// Keeps the lazy real ./flows/flowTools graph (~5 s cold) out of whichever test reaches it first (#11011).
vi.mock('./flows/flowTools', () => ({ resolveFlowTools: async () => [] }));

import { StreamingSessionManager } from './streamingSessionManager';
import { makeResolvedModel } from './aiModels/__fixtures__/resolvedModel';
import { withPreStreamTiming } from './aiPreStreamTiming';
import { baseAuth, baseDbSession, scriptedQuery } from './__testutils__/streamingSessionManagerHarness';

let mgr: StreamingSessionManager;
beforeEach(() => {
  vi.clearAllMocks();
  m.queryArgs.length = 0;
  m.queryImpl = () => scriptedQuery([]);
  mgr = new StreamingSessionManager();
});
afterEach(() => {
  mgr.shutdown();
  vi.restoreAllMocks();
});

describe('getOrCreate pre-stream phases (#11004)', () => {
  it('names the MCP server build and the spawn inside the caller\'s timer', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => (clock += 600));

    await withPreStreamTiming('chat.message', { sessionId: 's1' }, () =>
      mgr.getOrCreate('s1', baseDbSession, baseAuth, undefined, 'sys', 1, makeResolvedModel('anthropic_byok')));

    const lines = warn.mock.calls.map((call) => String(call[0])).filter((l) => l.includes('[AI] slow pre-stream setup'));
    expect(lines).toHaveLength(1);
    for (const phase of ['wispGrant', 'approvalMode', 'tenantTools', 'mcpServer', 'prepareSdkChild', 'stampProvenance', 'spawn']) {
      expect(lines[0], `phase ${phase}`).toMatch(new RegExp(`[=,]${phase}=\\d+ms`));
    }
    expect(m.queryArgs).toHaveLength(1);
  });

  it('records nothing and logs nothing when the caller is not timing the request', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => (clock += 600));
    await mgr.getOrCreate('s2', baseDbSession, baseAuth, undefined, 'sys', 1, makeResolvedModel('anthropic_byok'));
    expect(warn.mock.calls.filter((call) => String(call[0]).includes('slow pre-stream setup'))).toHaveLength(0);
  });
});
