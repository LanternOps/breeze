import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

const { queryMock, recordUsageMock, capturedQueryArgs } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  recordUsageMock: vi.fn(() => Promise.resolve()),
  capturedQueryArgs: [] as Array<{ prompt: unknown; options: Record<string, unknown> }>,
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock }));

vi.mock('../db', () => ({
  db: {
    // Only DB read on this path: the aiBudgets approvalMode lookup
    // (streamingSessionManager.getOrCreate). Return auto_approve so the
    // approval-mode prompt injection is observable.
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([{ approvalMode: 'auto_approve' }])),
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
vi.mock('./aiToolOutput', () => ({ redactAiToolOutputText: (s: string) => s }));
vi.mock('./clientIp', () => ({ getTrustedClientIpOrUndefined: () => undefined }));

import { StreamingSessionManager } from './streamingSessionManager';
import type { AuthContext } from '../middleware/auth';
import type { AiStreamEvent } from '@breeze/shared/types/ai';

const ORG = '0c0c0c0c-1111-4222-8333-444455556666';

const DB_SESSION = {
  orgId: ORG,
  sdkSessionId: null,
  model: 'claude-sonnet-4-5-20250929',
  maxTurns: 50,
  turnCount: 0,
  systemPrompt: null,
};

const AUTH = {
  orgId: ORG,
  scope: 'organization',
  accessibleOrgIds: [ORG],
  user: { id: 'beefbeef-1111-4222-8333-444455556666', email: 'finance.user@contoso.com' },
} as unknown as AuthContext;

const RESULT_MSG = {
  type: 'result',
  subtype: 'success',
  total_cost_usd: 0.03,
  usage: { input_tokens: 100, output_tokens: 50 },
  num_turns: 1,
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** queryMock returns an async-iterable Query stub gated on `gate`. */
function mockSdkQuery(messages: unknown[], gate: Promise<void>) {
  queryMock.mockImplementation((args: { prompt: unknown; options: Record<string, unknown> }) => {
    capturedQueryArgs.push(args);
    return {
      async *[Symbol.asyncIterator]() {
        await gate;
        yield* messages as never[];
      },
      interrupt: vi.fn(),
      close: vi.fn(),
    };
  });
}

let manager: StreamingSessionManager;

beforeEach(() => {
  vi.clearAllMocks();
  capturedQueryArgs.length = 0;
  manager = new StreamingSessionManager();
});

afterEach(() => {
  manager.shutdown();
});

describe('getOrCreate — approval-mode prompt injection option', () => {
  it('injects the technician approval-mode suffix by default (existing behavior)', async () => {
    const gate = deferred();
    gate.resolve();
    mockSdkQuery([], gate.promise);

    const session = await manager.getOrCreate('sess-default', DB_SESSION, AUTH, undefined, 'BASE PROMPT', undefined);
    await session.processorPromise;

    expect(capturedQueryArgs[0]!.options.systemPrompt).toContain('BASE PROMPT');
    expect(capturedQueryArgs[0]!.options.systemPrompt).toContain('## Approval Mode');
  });

  it('suppresses the suffix when injectApprovalModeInstructions is false (client sessions)', async () => {
    const gate = deferred();
    gate.resolve();
    mockSdkQuery([], gate.promise);

    const session = await manager.getOrCreate(
      'sess-client', DB_SESSION, AUTH, undefined, 'BASE PROMPT', undefined,
      undefined, undefined, { injectApprovalModeInstructions: false },
    );
    await session.processorPromise;

    expect(capturedQueryArgs[0]!.options.systemPrompt).toBe('BASE PROMPT');
  });
});

describe('result handling — usage-bearing done + recordExtraUsage', () => {
  it('publishes done with usage and invokes recordExtraUsage with the turn cost', async () => {
    const gate = deferred();
    mockSdkQuery([RESULT_MSG], gate.promise);

    const session = await manager.getOrCreate(
      'sess-usage', DB_SESSION, AUTH, undefined, 'BASE PROMPT', undefined,
      undefined, undefined, { injectApprovalModeInstructions: false },
    );

    const recordExtraUsage = vi.fn(() => Promise.resolve());
    session.recordExtraUsage = recordExtraUsage;
    session.clientWriteMode = 'readwrite'; // type-level: field exists on ActiveSession

    const events: AiStreamEvent[] = [];
    const sub = session.eventBus.subscribe('test-sub');
    const consumer = (async () => {
      for await (const e of sub) events.push(e);
    })();

    gate.resolve();
    await session.processorPromise;
    await consumer;

    // 0.03 USD → 3 cents (recordUsageFromSdkResult rounding, aiCostTracker.ts:272)
    expect(recordExtraUsage).toHaveBeenCalledWith({ inputTokens: 100, outputTokens: 50, costCents: 3 });
    expect(recordUsageMock).toHaveBeenCalled(); // org-level recording still happens
    expect(events).toContainEqual({
      type: 'done',
      usage: { inputTokens: 100, outputTokens: 50, costCents: 3 },
    });
  });
});
