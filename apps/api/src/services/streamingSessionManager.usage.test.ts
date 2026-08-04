/**
 * #3095 — ai_sessions token counters recorded 0 for real sessions.
 *
 * Root cause: the background processor's `result` handler read
 * `session.auth.orgId`, which is null for partner- and system-scoped users,
 * and silently skipped usage recording for every turn of their sessions.
 * These tests pin the fix (use the canonical `session.orgId` from the DB row)
 * plus the fallback accumulation of per-API-call assistant usage for turns
 * whose `result` arrives with missing/zero usage, and the flush for turns
 * abandoned without a `result`.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

const { queryMock, recordUsageMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  recordUsageMock: vi.fn(() => Promise.resolve()),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock }));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([])),
        })),
      })),
    })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })) })),
    insert: vi.fn(() => ({ values: vi.fn(() => Promise.resolve()) })),
  },
  withDbAccessContext: vi.fn((_ctx: unknown, fn: () => unknown) => fn()),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock('./aiCostTracker', () => ({ recordUsageFromSdkResult: recordUsageMock }));
vi.mock('./aiAgent', () => ({ sanitizeErrorForClient: (e: unknown) => String(e) }));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));
vi.mock('./aiAgentSdkTools', () => ({
  createBreezeMcpServer: vi.fn(() => ({ type: 'sdk' })),
  BREEZE_MCP_TOOL_NAMES: ['mcp__breeze__query_devices'],
}));
vi.mock('./aiAgentSdk', () => ({
  createSessionPreToolUse: vi.fn(() => vi.fn()),
  createSessionPostToolUse: vi.fn(() => vi.fn()),
}));
vi.mock('./aiToolOutput', () => ({
  redactAiToolOutputText: (s: string) => s,
  redactSensitiveToolInput: (i: unknown) => i,
}));
vi.mock('./clientIp', () => ({ getTrustedClientIpOrUndefined: () => undefined }));

import { StreamingSessionManager } from './streamingSessionManager';
import type { AuthContext } from '../middleware/auth';

const ORG = '0c0c0c0c-1111-4222-8333-444455556666';

const DB_SESSION = {
  orgId: ORG,
  sdkSessionId: null,
  model: 'claude-sonnet-4-5-20250929',
  maxTurns: 50,
  turnCount: 0,
  systemPrompt: null,
};

/** Partner-scoped technician: orgId is null on the auth context (the #3095 trigger). */
const PARTNER_AUTH = {
  orgId: null,
  partnerId: 'aaaaaaaa-1111-4222-8333-444455556666',
  scope: 'partner',
  accessibleOrgIds: [ORG],
  user: { id: 'beefbeef-1111-4222-8333-444455556666', email: 'tech@msp.example.com' },
} as unknown as AuthContext;

function assistantMsg(usage: Record<string, number>, text = 'hello') {
  return {
    type: 'assistant',
    message: { content: [{ type: 'text', text }], usage },
  };
}

function resultMsg(overrides: Record<string, unknown> = {}) {
  return {
    type: 'result',
    subtype: 'success',
    total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
    num_turns: 1,
    ...overrides,
  };
}

function mockSdkQuery(messages: unknown[]) {
  queryMock.mockImplementation(() => ({
    async *[Symbol.asyncIterator]() {
      yield* messages as never[];
    },
    interrupt: vi.fn(),
    close: vi.fn(),
  }));
}

let manager: StreamingSessionManager;

beforeEach(() => {
  vi.clearAllMocks();
  manager = new StreamingSessionManager();
});

afterEach(() => {
  manager.shutdown();
});

async function runSession(sessionId: string, messages: unknown[]) {
  mockSdkQuery(messages);
  const session = await manager.getOrCreate(sessionId, DB_SESSION, PARTNER_AUTH, undefined, 'PROMPT', undefined);
  await session.processorPromise;
  return session;
}

describe('result usage recording — partner-scoped sessions (#3095)', () => {
  it('records non-zero usage using the canonical session orgId even when auth.orgId is null', async () => {
    await runSession('sess-partner', [
      resultMsg({ total_cost_usd: 0.03, usage: { input_tokens: 100, output_tokens: 50 } }),
    ]);

    expect(recordUsageMock).toHaveBeenCalledTimes(1);
    expect(recordUsageMock).toHaveBeenCalledWith('sess-partner', ORG, expect.objectContaining({
      total_cost_usd: 0.03,
      usage: expect.objectContaining({ input_tokens: 100, output_tokens: 50 }),
    }));
  });

  it('records usage on error-subtype results too (turns that die on tool errors)', async () => {
    await runSession('sess-err', [
      {
        ...resultMsg({ usage: { input_tokens: 70, output_tokens: 20 } }),
        subtype: 'error_during_execution',
        errors: ['tool blew up'],
      },
    ]);

    expect(recordUsageMock).toHaveBeenCalledTimes(1);
    expect(recordUsageMock).toHaveBeenCalledWith('sess-err', ORG, expect.objectContaining({
      usage: expect.objectContaining({ input_tokens: 70, output_tokens: 20 }),
    }));
  });
});

describe('fallback accumulation from assistant messages', () => {
  it('sums per-API-call assistant usage when the result usage is empty', async () => {
    await runSession('sess-fallback', [
      assistantMsg({ input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 300 }),
      assistantMsg({ input_tokens: 1500, output_tokens: 40, cache_creation_input_tokens: 200 }),
      resultMsg(), // zero usage from the SDK
    ]);

    expect(recordUsageMock).toHaveBeenCalledTimes(1);
    expect(recordUsageMock).toHaveBeenCalledWith('sess-fallback', ORG, expect.objectContaining({
      usage: {
        input_tokens: 2700,
        output_tokens: 120,
        cache_read_input_tokens: 300,
        cache_creation_input_tokens: 200,
      },
    }));
  });

  it('prefers SDK-reported result usage over the accumulator when present', async () => {
    await runSession('sess-sdk-wins', [
      assistantMsg({ input_tokens: 999, output_tokens: 999 }),
      resultMsg({ usage: { input_tokens: 100, output_tokens: 50 } }),
    ]);

    expect(recordUsageMock).toHaveBeenCalledWith('sess-sdk-wins', ORG, expect.objectContaining({
      usage: expect.objectContaining({ input_tokens: 100, output_tokens: 50 }),
    }));
  });

  it('resets the accumulator between turns (multi-turn sessions)', async () => {
    await runSession('sess-multiturn', [
      assistantMsg({ input_tokens: 100, output_tokens: 10 }),
      resultMsg(),
      assistantMsg({ input_tokens: 40, output_tokens: 5 }),
      resultMsg(),
    ]);

    expect(recordUsageMock).toHaveBeenCalledTimes(2);
    expect(recordUsageMock).toHaveBeenNthCalledWith(1, 'sess-multiturn', ORG, expect.objectContaining({
      usage: expect.objectContaining({ input_tokens: 100, output_tokens: 10 }),
    }));
    expect(recordUsageMock).toHaveBeenNthCalledWith(2, 'sess-multiturn', ORG, expect.objectContaining({
      usage: expect.objectContaining({ input_tokens: 40, output_tokens: 5 }),
    }));
  });

  it('flushes accumulated usage when the turn ends without a result message', async () => {
    await runSession('sess-abandoned', [
      assistantMsg({ input_tokens: 500, output_tokens: 60 }),
      // no result — subprocess died / stream closed mid-turn
    ]);

    expect(recordUsageMock).toHaveBeenCalledTimes(1);
    expect(recordUsageMock).toHaveBeenCalledWith('sess-abandoned', ORG, expect.objectContaining({
      usage: expect.objectContaining({ input_tokens: 500, output_tokens: 60 }),
      num_turns: 1,
    }));
  });

  it('does not double-record when a completed turn is followed by teardown', async () => {
    await runSession('sess-clean', [
      assistantMsg({ input_tokens: 100, output_tokens: 10 }),
      resultMsg({ usage: { input_tokens: 100, output_tokens: 10 } }),
    ]);

    // Only the result-driven record; the finally-flush sees an empty accumulator.
    expect(recordUsageMock).toHaveBeenCalledTimes(1);
  });
});
