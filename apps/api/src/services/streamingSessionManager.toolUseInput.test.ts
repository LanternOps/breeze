/**
 * Regression test for sweep E6: `tool_use_start` publishes at the SDK's
 * `content_block_start`, before the tool's real arguments have streamed in —
 * its `input` is ALWAYS `{}` at that point, never a partial preview. The web
 * client's tool-row label (`aiToolLabel`) needs `input.action` to tell a
 * read-only call (`list`/`get`/…) from a write, so every live tool row fell
 * back to the tool name's own verb — "Updated alerts" for a read-only
 * `manage_alerts` lookup, where a history reload (which loads the real,
 * persisted input) correctly says "Checked alerts".
 *
 * Fix: once the SDK's `assistant` message for a turn completes and each
 * tool_use block's real input is known — the same point the redacted input is
 * persisted to `ai_messages` — publish a `tool_use_input` event carrying that
 * same redacted input, keyed by toolUseId, so the live client can backfill
 * the row it already rendered.
 *
 * Harness mirrors streamingSessionManager.textSeparator.test.ts.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

const { queryMock, insertedRows, redactMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  insertedRows: [] as Array<Record<string, unknown>>,
  redactMock: vi.fn((input: Record<string, unknown>) => input),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock }));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([{ approvalMode: 'per_step' }])),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((row: Record<string, unknown>) => {
        insertedRows.push(row);
        return Promise.resolve();
      }),
    })),
  },
  withDbAccessContext: vi.fn((_ctx: unknown, fn: () => unknown) => fn()),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock('./aiCostTracker', () => ({
  recordUsageFromSdkResult: vi.fn(() => Promise.resolve()),
  sumInputTokens: (u: Record<string, number | null | undefined> | null | undefined) =>
    (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0),
}));
vi.mock('./aiAgent', () => ({ sanitizeErrorForClient: (e: unknown) => String(e) }));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));
vi.mock('./aiAgentSdkTools', () => ({
  createBreezeMcpServer: vi.fn(() => ({ type: 'sdk' })),
  BREEZE_MCP_TOOL_NAMES: ['mcp__breeze__manage_alerts'],
}));
vi.mock('./aiAgentSdk', () => ({
  createSessionPreToolUse: vi.fn(() => vi.fn()),
  createSessionPostToolUse: vi.fn(() => vi.fn()),
}));
vi.mock('./aiToolOutput', () => ({
  redactAiToolOutputText: (s: string) => s,
  redactSensitiveToolInput: redactMock,
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

const PLATFORM_CONFIG = {
  source: 'platform' as const,
  apiKey: 'platform-key',
  model: 'claude-sonnet-4-6',
};

const AUTH = {
  orgId: ORG,
  scope: 'organization',
  accessibleOrgIds: [ORG],
  user: { id: 'beefbeef-1111-4222-8333-444455556666', email: 'tech@contoso.com' },
} as unknown as AuthContext;

const TOOL_USE_ID = 'toolu_alerts_01';

function messageStartEvent() {
  return { type: 'stream_event', event: { type: 'message_start' } };
}
function toolUseBlockStartEvent(id: string, name: string) {
  return {
    type: 'stream_event',
    event: { type: 'content_block_start', content_block: { type: 'tool_use', id, name } },
  };
}
function messageDeltaEvent() {
  return { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 5 } } };
}

const RESULT_MSG = {
  type: 'result',
  subtype: 'success',
  total_cost_usd: 0.01,
  usage: { input_tokens: 10, output_tokens: 5 },
  num_turns: 1,
};

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
  redactMock.mockImplementation((input: Record<string, unknown>) => input);
  insertedRows.length = 0;
  manager = new StreamingSessionManager();
});

afterEach(() => {
  manager.shutdown();
});

describe('tool_use_input event (sweep E6)', () => {
  it('publishes the real, redacted tool input once the assistant message with the tool_use block completes', async () => {
    const realInput = { action: 'list' };
    mockSdkQuery([
      messageStartEvent(),
      // `tool_use_start` fires with `input: {}` — see the handler, unchanged
      // by this fix — this event carries no input at all.
      toolUseBlockStartEvent(TOOL_USE_ID, 'mcp__breeze__manage_alerts'),
      messageDeltaEvent(),
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: TOOL_USE_ID, name: 'mcp__breeze__manage_alerts', input: realInput }],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
      RESULT_MSG,
    ]);

    const session = await manager.getOrCreate(
      'sess-tool-input', DB_SESSION, AUTH, undefined, 'PROMPT', undefined, PLATFORM_CONFIG,
    );
    await session.processorPromise;

    const events = session.eventBus.getReplayEvents();

    const startEvent = events.find((e) => e.type === 'tool_use_start') as
      | { type: 'tool_use_start'; toolUseId: string; input: Record<string, unknown> }
      | undefined;
    expect(startEvent?.input).toEqual({});

    const inputEvent = events.find((e) => e.type === 'tool_use_input') as
      | { type: 'tool_use_input'; toolUseId: string; input: Record<string, unknown> }
      | undefined;
    expect(inputEvent?.toolUseId).toBe(TOOL_USE_ID);
    expect(inputEvent?.input).toEqual(realInput);

    // Same value that gets persisted to the tool_use row — the whole point
    // is that the live client and a history reload agree.
    const persistedRow = insertedRows.find((r) => r.role === 'tool_use' && r.toolUseId === TOOL_USE_ID);
    expect(persistedRow?.toolInput).toEqual(realInput);

    // Redacted once for the tool_use row (reused for both its DB write and
    // the live event below) and once more for the SAME block embedded in the
    // assistant message's own contentBlocks (SR5-16) — two call sites, but
    // every one of them redacts, none skip it.
    expect(redactMock).toHaveBeenCalledTimes(2);
    for (const call of redactMock.mock.calls) {
      expect(call[0]).toEqual(realInput);
    }
  });
});
