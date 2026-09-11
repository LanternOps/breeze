/**
 * Regression tests for #5106: a turn that narrates, calls a tool, then
 * reports back (text -> tool_use -> text, all inside ONE assistant message)
 * used to stitch the two text blocks together with no separator — every
 * client rendered "...what happened last night.Here's a summary." with no
 * space or line break between the sentences.
 *
 * Fix (streamingSessionManager.ts): at a text `content_block_start` that is
 * NOT the first text block of the current assistant message, publish a
 * `content_delta` of `"\n\n"` before the block's own deltas; persist
 * `assistantContent` by joining text blocks with the same `"\n\n"` so stored
 * history matches the stream byte-for-byte.
 *
 * Harness mirrors streamingSessionManager.droppedToolResult.test.ts.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

const { queryMock, insertedRows } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  insertedRows: [] as Array<Record<string, unknown>>,
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
  BREEZE_MCP_TOOL_NAMES: ['mcp__breeze__query_devices'],
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

const TOOL_USE_ID = 'toolu_report_01';
const FIRST_TEXT = "Let me check what happened last night.";
const SECOND_TEXT = "Here's a summary.";

function messageStartEvent() {
  return { type: 'stream_event', event: { type: 'message_start' } };
}
function textBlockStartEvent() {
  return { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text', text: '' } } };
}
function toolUseBlockStartEvent(id: string, name: string) {
  return {
    type: 'stream_event',
    event: { type: 'content_block_start', content_block: { type: 'tool_use', id, name } },
  };
}
function textDeltaEvent(text: string) {
  return { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } };
}
function messageDeltaEvent() {
  return { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 5 } } };
}

/** One assistant API response with THREE content blocks: text, tool_use, text. */
const ASSISTANT_MESSAGE = {
  type: 'assistant',
  message: {
    content: [
      { type: 'text', text: FIRST_TEXT },
      { type: 'tool_use', id: TOOL_USE_ID, name: 'mcp__breeze__query_devices', input: {} },
      { type: 'text', text: SECOND_TEXT },
    ],
    usage: { input_tokens: 10, output_tokens: 5 },
  },
};

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
  manager = new StreamingSessionManager();
});

afterEach(() => {
  manager.shutdown();
});

describe('text block separator (#5106)', () => {
  it('emits a "\\n\\n" content_delta at the second text block of a text -> tool_use -> text turn', async () => {
    mockSdkQuery([
      messageStartEvent(),
      textBlockStartEvent(),
      textDeltaEvent(FIRST_TEXT),
      toolUseBlockStartEvent(TOOL_USE_ID, 'mcp__breeze__query_devices'),
      textBlockStartEvent(),
      textDeltaEvent(SECOND_TEXT),
      messageDeltaEvent(),
      ASSISTANT_MESSAGE,
      RESULT_MSG,
    ]);

    const session = await manager.getOrCreate(
      'sess-separator', DB_SESSION, AUTH, undefined, 'PROMPT', undefined, PLATFORM_CONFIG,
    );
    await session.processorPromise;

    const deltas = session.eventBus
      .getReplayEvents()
      .filter((e): e is { type: 'content_delta'; delta: string } => e.type === 'content_delta')
      .map((e) => e.delta);

    // The separator is its own delta, inserted between the two text deltas —
    // NOT concatenated into either one.
    expect(deltas).toEqual([FIRST_TEXT, '\n\n', SECOND_TEXT]);
    expect(deltas.join('')).toBe(`${FIRST_TEXT}\n\n${SECOND_TEXT}`);
  });

  it('never emits a leading separator before the FIRST text block of a message', async () => {
    mockSdkQuery([
      messageStartEvent(),
      textBlockStartEvent(),
      textDeltaEvent(FIRST_TEXT),
      messageDeltaEvent(),
      { type: 'assistant', message: { content: [{ type: 'text', text: FIRST_TEXT }], usage: { input_tokens: 1, output_tokens: 1 } } },
      RESULT_MSG,
    ]);

    const session = await manager.getOrCreate(
      'sess-single-text', DB_SESSION, AUTH, undefined, 'PROMPT', undefined, PLATFORM_CONFIG,
    );
    await session.processorPromise;

    const deltas = session.eventBus
      .getReplayEvents()
      .filter((e): e is { type: 'content_delta'; delta: string } => e.type === 'content_delta')
      .map((e) => e.delta);
    expect(deltas).toEqual([FIRST_TEXT]);
  });

  it('resets the "already saw a text block" flag at message_start, so a later message does not inherit a leading separator', async () => {
    mockSdkQuery([
      // First assistant message: a single text block.
      messageStartEvent(),
      textBlockStartEvent(),
      textDeltaEvent(FIRST_TEXT),
      messageDeltaEvent(),
      { type: 'assistant', message: { content: [{ type: 'text', text: FIRST_TEXT }], usage: { input_tokens: 1, output_tokens: 1 } } },
      // Second assistant message (e.g. after a tool round-trip elsewhere):
      // also a single text block — must NOT get a leading separator just
      // because a previous message already saw one.
      messageStartEvent(),
      textBlockStartEvent(),
      textDeltaEvent(SECOND_TEXT),
      messageDeltaEvent(),
      { type: 'assistant', message: { content: [{ type: 'text', text: SECOND_TEXT }], usage: { input_tokens: 1, output_tokens: 1 } } },
      RESULT_MSG,
    ]);

    const session = await manager.getOrCreate(
      'sess-two-messages', DB_SESSION, AUTH, undefined, 'PROMPT', undefined, PLATFORM_CONFIG,
    );
    await session.processorPromise;

    const deltas = session.eventBus
      .getReplayEvents()
      .filter((e): e is { type: 'content_delta'; delta: string } => e.type === 'content_delta')
      .map((e) => e.delta);
    expect(deltas).toEqual([FIRST_TEXT, SECOND_TEXT]);
  });

  it('persists assistantContent joined with "\\n\\n" so stored history matches the stream', async () => {
    mockSdkQuery([
      messageStartEvent(),
      textBlockStartEvent(),
      textDeltaEvent(FIRST_TEXT),
      toolUseBlockStartEvent(TOOL_USE_ID, 'mcp__breeze__query_devices'),
      textBlockStartEvent(),
      textDeltaEvent(SECOND_TEXT),
      messageDeltaEvent(),
      ASSISTANT_MESSAGE,
      RESULT_MSG,
    ]);

    const session = await manager.getOrCreate(
      'sess-persist', DB_SESSION, AUTH, undefined, 'PROMPT', undefined, PLATFORM_CONFIG,
    );
    await session.processorPromise;

    const assistantRow = insertedRows.find((r) => r.role === 'assistant');
    expect(assistantRow?.content).toBe(`${FIRST_TEXT}\n\n${SECOND_TEXT}`);
  });

  it('separates every text block in a text -> tool_use -> text -> tool_use -> text turn (three text blocks, two tools)', async () => {
    const THIRD_TEXT = 'All done.';
    const message = {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: FIRST_TEXT },
          { type: 'tool_use', id: TOOL_USE_ID, name: 'mcp__breeze__query_devices', input: {} },
          { type: 'text', text: SECOND_TEXT },
          { type: 'tool_use', id: 'toolu_report_02', name: 'mcp__breeze__query_devices', input: {} },
          { type: 'text', text: THIRD_TEXT },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    };
    mockSdkQuery([
      messageStartEvent(),
      textBlockStartEvent(),
      textDeltaEvent(FIRST_TEXT),
      toolUseBlockStartEvent(TOOL_USE_ID, 'mcp__breeze__query_devices'),
      textBlockStartEvent(),
      textDeltaEvent(SECOND_TEXT),
      toolUseBlockStartEvent('toolu_report_02', 'mcp__breeze__query_devices'),
      textBlockStartEvent(),
      textDeltaEvent(THIRD_TEXT),
      messageDeltaEvent(),
      message,
      RESULT_MSG,
    ]);

    const session = await manager.getOrCreate(
      'sess-three-text-blocks', DB_SESSION, AUTH, undefined, 'PROMPT', undefined, PLATFORM_CONFIG,
    );
    await session.processorPromise;

    const deltas = session.eventBus
      .getReplayEvents()
      .filter((e): e is { type: 'content_delta'; delta: string } => e.type === 'content_delta')
      .map((e) => e.delta);
    expect(deltas).toEqual([FIRST_TEXT, '\n\n', SECOND_TEXT, '\n\n', THIRD_TEXT]);

    const assistantRow = insertedRows.find((r) => r.role === 'assistant');
    expect(assistantRow?.content).toBe(`${FIRST_TEXT}\n\n${SECOND_TEXT}\n\n${THIRD_TEXT}`);
  });
});
