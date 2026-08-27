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

const { queryMock, recordUsageMock, calculateCostCentsMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  recordUsageMock: vi.fn(() => Promise.resolve()),
  calculateCostCentsMock: vi.fn(() => 42),
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

vi.mock('./aiCostTracker', () => ({
  recordUsageFromSdkResult: recordUsageMock,
  calculateCostCents: calculateCostCentsMock,
  // Pure helper — kept real so these tests exercise the actual summing rule.
  sumInputTokens: (u: Record<string, number | null | undefined>) =>
    (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
}));
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
import { withDbAccessContext } from '../db';
import type { AuthContext } from '../middleware/auth';
import type { UsableLlmConfig } from './llm/llmConfigResolver';

const ORG = '0c0c0c0c-1111-4222-8333-444455556666';

const DB_SESSION = {
  orgId: ORG,
  sdkSessionId: null,
  model: 'claude-sonnet-4-5-20250929',
  maxTurns: 50,
  turnCount: 0,
  systemPrompt: null,
};

const PLATFORM_CONFIG = {
  source: 'platform' as const,
  apiKey: 'platform-key',
  model: 'claude-sonnet-4-6',
};

const PARTNER_CONFIG = {
  source: 'partner' as const,
  partnerId: 'aaaaaaaa-1111-4222-8333-444455556666',
  apiKey: 'partner-key',
  model: 'claude-sonnet-4-6',
  configId: 'config-1',
  configVersion: 3,
  endpoint: { kind: 'anthropic' as const },
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

function mockSdkQuery(messages: unknown[], gate: Promise<void> = Promise.resolve()) {
  queryMock.mockImplementation(() => ({
    async *[Symbol.asyncIterator]() {
      await gate;
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

async function runSession(
  sessionId: string,
  messages: unknown[],
  resolved: UsableLlmConfig = PLATFORM_CONFIG,
) {
  mockSdkQuery(messages);
  const session = await manager.getOrCreate(
    sessionId,
    DB_SESSION,
    PARTNER_AUTH,
    undefined,
    'PROMPT',
    undefined,
    resolved,
  );
  await session.processorPromise;
  return session;
}

describe('result usage recording — partner-scoped sessions (#3095)', () => {
  it('passes partner_key from the immutable session config snapshot', async () => {
    await runSession('sess-byok', [
      resultMsg({ total_cost_usd: 0.03, usage: { input_tokens: 100, output_tokens: 50 } }),
    ], PARTNER_CONFIG);

    expect(recordUsageMock).toHaveBeenCalledWith(
      'sess-byok',
      ORG,
      expect.objectContaining({ total_cost_usd: 0.03 }),
      'partner_key',
      // 5th arg: the catalog pricing snapshot (#3922 W3) — undefined for a
      // direct-Anthropic partner session, which prices from MODEL_PRICING.
      undefined,
    );
  });

  it('records non-zero usage using the canonical session orgId even when auth.orgId is null', async () => {
    await runSession('sess-partner', [
      resultMsg({ total_cost_usd: 0.03, usage: { input_tokens: 100, output_tokens: 50 } }),
    ]);

    expect(recordUsageMock).toHaveBeenCalledTimes(1);
    expect(recordUsageMock).toHaveBeenCalledWith('sess-partner', ORG, expect.objectContaining({
      total_cost_usd: 0.03,
      usage: expect.objectContaining({ input_tokens: 100, output_tokens: 50 }),
    }), 'platform', undefined);
    // The RLS db-access context must also be built from the DB-row org, not auth.orgId (null).
    expect(vi.mocked(withDbAccessContext)).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'organization', orgId: ORG }),
      expect.any(Function),
    );
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
    }), 'platform', undefined);
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
    }), 'platform', undefined);
  });

  it('prefers SDK-reported result usage over the accumulator when present', async () => {
    await runSession('sess-sdk-wins', [
      assistantMsg({ input_tokens: 999, output_tokens: 999 }),
      resultMsg({ usage: { input_tokens: 100, output_tokens: 50 } }),
    ]);

    expect(recordUsageMock).toHaveBeenCalledWith('sess-sdk-wins', ORG, expect.objectContaining({
      usage: expect.objectContaining({ input_tokens: 100, output_tokens: 50 }),
    }), 'platform', undefined);
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
    }), 'platform', undefined);
    expect(recordUsageMock).toHaveBeenNthCalledWith(2, 'sess-multiturn', ORG, expect.objectContaining({
      usage: expect.objectContaining({ input_tokens: 40, output_tokens: 5 }),
    }), 'platform', undefined);
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
    }), 'platform', undefined);
  });

  it('feeds abandoned-turn usage to the per-user recordExtraUsage hook (client sessions)', async () => {
    let releaseGate!: () => void;
    const gate = new Promise<void>((r) => (releaseGate = r));
    mockSdkQuery([assistantMsg({ input_tokens: 500, output_tokens: 60 })], gate);

    const session = await manager.getOrCreate(
      'sess-abandoned-extra',
      DB_SESSION,
      PARTNER_AUTH,
      undefined,
      'PROMPT',
      undefined,
      PLATFORM_CONFIG,
    );
    const recordExtraUsage = vi.fn(() => Promise.resolve());
    session.recordExtraUsage = recordExtraUsage;

    releaseGate();
    await session.processorPromise;

    // Org ledger and per-user ledger both get the abandoned turn's tokens.
    expect(recordUsageMock).toHaveBeenCalledWith('sess-abandoned-extra', ORG, expect.objectContaining({
      usage: expect.objectContaining({ input_tokens: 500, output_tokens: 60 }),
    }), 'platform', undefined);
    expect(recordExtraUsage).toHaveBeenCalledWith({ inputTokens: 500, outputTokens: 60, costCents: 42 });
    expect(calculateCostCentsMock).toHaveBeenCalledWith('claude-sonnet-4-5-20250929', 500, 60, 0, 0);
  });

  it('reports cache tokens as input on the per-user hook and the done event', async () => {
    // Release QA: an 8-turn session read 17 input tokens / 1029 output / $0.57.
    // On every turn past the first, prompt caching moves nearly the whole prompt
    // into cache_read, so the uncached slice alone is meaningless.
    mockSdkQuery([
      resultMsg({
        total_cost_usd: 0.57,
        usage: {
          input_tokens: 17,
          output_tokens: 1_029,
          cache_read_input_tokens: 120_000,
          cache_creation_input_tokens: 4_500,
        },
      }),
    ]);

    const session = await manager.getOrCreate(
      'sess-cache-surfaces',
      DB_SESSION,
      PARTNER_AUTH,
      undefined,
      'PROMPT',
      undefined,
      PLATFORM_CONFIG,
    );
    const recordExtraUsage = vi.fn(() => Promise.resolve());
    session.recordExtraUsage = recordExtraUsage;

    await session.processorPromise;

    const done = session.eventBus.getReplayEvents().find((e: any) => e.type === 'done') as any;
    expect(done?.usage).toEqual({
      inputTokens: 17 + 120_000 + 4_500,
      outputTokens: 1_029,
      costCents: 57,
    });
    expect(recordExtraUsage).toHaveBeenCalledWith({
      inputTokens: 17 + 120_000 + 4_500,
      outputTokens: 1_029,
      costCents: 57,
    });
    // The org-level recorder still receives the SPLIT components — it prices
    // them at their different rates and does its own summing for the columns.
    expect(recordUsageMock).toHaveBeenCalledWith('sess-cache-surfaces', ORG, expect.objectContaining({
      usage: {
        input_tokens: 17,
        output_tokens: 1_029,
        cache_read_input_tokens: 120_000,
        cache_creation_input_tokens: 4_500,
      },
    }), 'platform', undefined);
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
