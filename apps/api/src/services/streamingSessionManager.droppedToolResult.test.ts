/**
 * Regression tests for issue #3094: a tool call the SDK rejects BEFORE our MCP
 * handler runs (e.g. a -32602 input-schema validation failure on a
 * set_device_context call carrying a parenthesized value) used to vanish — the
 * model saw an error tool_result and retried, but Breeze persisted no
 * ai_messages tool_result row, emitted no SSE event, and left a stale
 * toolUseIdQueue entry that misattributed every subsequent result.
 *
 * The background processor's 'user' case now detects exactly those orphans
 * (tool_result blocks whose tool_use id is still queued) and records an
 * explicit error result instead of silence.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

const { queryMock, insertedRows, updateCalls } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  insertedRows: [] as Array<Record<string, unknown>>,
  updateCalls: [] as Array<Record<string, unknown>>,
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
      set: vi.fn((values: Record<string, unknown>) => {
        updateCalls.push(values);
        return { where: vi.fn(() => Promise.resolve()) };
      }),
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
  // Also consumed on the result/done path — see the note in clientLoop.test.ts.
  sumInputTokens: (u: Record<string, number | null | undefined> | null | undefined) =>
    (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0),
}));
vi.mock('./aiAgent', () => ({ sanitizeErrorForClient: (e: unknown) => String(e) }));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));
vi.mock('./aiAgentSdkTools', () => ({
  createBreezeMcpServer: vi.fn(() => ({ type: 'sdk' })),
  BREEZE_MCP_TOOL_NAMES: ['mcp__breeze__set_device_context'],
}));
vi.mock('./aiAgentSdk', () => ({
  createSessionPreToolUse: vi.fn(() => vi.fn()),
  createSessionPostToolUse: vi.fn(() => vi.fn()),
}));
vi.mock('./aiToolOutput', () => ({
  redactAiToolOutputText: (s: string) => s,
  redactSensitiveToolInput: (input: Record<string, unknown>) => input,
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

const PAREN_INPUT = {
  deviceId: '3f8b0e6a-1234-4c56-8d9e-000000000001',
  contextType: 'quirk',
  summary: 'NIC fell back to APIPA',
  details: { ethernetIP: '169.254.7.26 (APIPA)' },
};

const TOOL_USE_ID = 'toolu_paren_01';

function toolUseStreamEvent(id: string, name: string) {
  return {
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      content_block: { type: 'tool_use', id, name },
    },
  };
}

function assistantToolUseMessage(id: string, name: string, input: Record<string, unknown>) {
  return {
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', id, name, input }],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  };
}

function userToolResultMessage(id: string, text: string) {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: id,
          is_error: true,
          content: [{ type: 'text', text }],
        },
      ],
    },
  };
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
  insertedRows.length = 0;
  updateCalls.length = 0;
  manager = new StreamingSessionManager();
});

afterEach(() => {
  manager.shutdown();
});

const VALIDATION_ERROR_TEXT =
  'MCP error -32602: Input validation error: Invalid arguments for tool set_device_context: '
  + '[{"code":"invalid_type","path":["details"]}] (input contained "169.254.7.26 (APIPA)")';

describe('dropped tool_result fallback (#3094)', () => {
  it('persists an explicit error tool_result and emits the SSE event for a call the MCP handler never saw', async () => {
    mockSdkQuery([
      toolUseStreamEvent(TOOL_USE_ID, 'mcp__breeze__set_device_context'),
      assistantToolUseMessage(TOOL_USE_ID, 'mcp__breeze__set_device_context', PAREN_INPUT),
      // The SDK feeds the model an error tool_result without ever calling our
      // MCP server — postToolUse never shifts the queue for this id.
      userToolResultMessage(TOOL_USE_ID, VALIDATION_ERROR_TEXT),
      RESULT_MSG,
    ]);

    const session = await manager.getOrCreate(
      'sess-dropped', DB_SESSION, AUTH, undefined, 'PROMPT', undefined, PLATFORM_CONFIG,
    );
    await session.processorPromise;

    // Transcript row: role tool_result, correct correlation id + bare tool
    // name, explicit error payload (not silence).
    const resultRows = insertedRows.filter((r) => r.role === 'tool_result');
    expect(resultRows).toHaveLength(1);
    expect(resultRows[0]).toMatchObject({
      sessionId: 'sess-dropped',
      toolName: 'set_device_context',
      toolUseId: TOOL_USE_ID,
    });
    const output = resultRows[0]!.toolOutput as { error: string; droppedBeforeExecution: boolean };
    expect(output.droppedBeforeExecution).toBe(true);
    expect(output.error).toContain('Invalid arguments for tool set_device_context');
    expect(output.error).toContain('(APIPA)');

    // SSE event so the UI tool card resolves instead of spinning forever.
    const events = session.eventBus.getReplayEvents();
    const toolResultEvents = events.filter((e) => e.type === 'tool_result');
    expect(toolResultEvents).toHaveLength(1);
    expect(toolResultEvents[0]).toMatchObject({ toolUseId: TOOL_USE_ID, isError: true });

    // Queue hygiene: the stale id must not poison attribution of later calls.
    expect(session.toolUseIdQueue).toHaveLength(0);
    expect(session.toolUseNames?.has(TOOL_USE_ID)).toBe(false);

    // Session auto-flag so flagged-session review surfaces the drop.
    const flagUpdates = updateCalls.filter((u) => typeof u.flagReason === 'string');
    expect(flagUpdates).toHaveLength(1);
    expect(flagUpdates[0]!.flagReason).toContain('set_device_context');
  });

  it('does not double-record a tool_result already handled by postToolUse (id no longer queued)', async () => {
    mockSdkQuery([
      // No content_block_start for this id — simulates postToolUse having
      // already drained the queue before the SDK echoed the user message.
      userToolResultMessage('toolu_already_handled', 'Context recorded successfully (ID: abc).'),
      RESULT_MSG,
    ]);

    const session = await manager.getOrCreate(
      'sess-handled', DB_SESSION, AUTH, undefined, 'PROMPT', undefined, PLATFORM_CONFIG,
    );
    await session.processorPromise;

    expect(insertedRows.filter((r) => r.role === 'tool_result')).toHaveLength(0);
    expect(session.eventBus.getReplayEvents().filter((e) => e.type === 'tool_result')).toHaveLength(0);
    expect(updateCalls.filter((u) => typeof u.flagReason === 'string')).toHaveLength(0);
  });

  it('ignores plain-text user messages (resume replay) entirely', async () => {
    mockSdkQuery([
      { type: 'user', message: { role: 'user', content: 'plain follow-up text' } },
      RESULT_MSG,
    ]);

    const session = await manager.getOrCreate(
      'sess-plain', DB_SESSION, AUTH, undefined, 'PROMPT', undefined, PLATFORM_CONFIG,
    );
    await session.processorPromise;

    expect(insertedRows.filter((r) => r.role === 'tool_result')).toHaveLength(0);
  });

  it('keeps attribution intact for a later call after an earlier drop', async () => {
    mockSdkQuery([
      toolUseStreamEvent(TOOL_USE_ID, 'mcp__breeze__set_device_context'),
      assistantToolUseMessage(TOOL_USE_ID, 'mcp__breeze__set_device_context', PAREN_INPUT),
      userToolResultMessage(TOOL_USE_ID, VALIDATION_ERROR_TEXT),
      // Retry call: id enters the queue; its (mocked) postToolUse never runs
      // in this harness, so the queue should contain exactly this second id.
      toolUseStreamEvent('toolu_retry_02', 'mcp__breeze__set_device_context'),
      RESULT_MSG,
    ]);

    const session = await manager.getOrCreate(
      'sess-retry', DB_SESSION, AUTH, undefined, 'PROMPT', undefined, PLATFORM_CONFIG,
    );
    await session.processorPromise;

    // The dropped id was spliced out; the retry id is untouched at the head.
    expect(session.toolUseIdQueue).toEqual(['toolu_retry_02']);
    expect(session.toolUseNames?.get('toolu_retry_02')).toBe('set_device_context');
  });
});
