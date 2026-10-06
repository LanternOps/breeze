/**
 * A-W04 (#6151): web chat runs with the SDK's ToolSearch built-in on a
 * first-party host; every other surface and host keeps `tools: []`. A
 * ToolSearch call never reaches the MCP pre/post hooks, so it must stay out of
 * the tool-use correlation queue, the transcript's tool rows and the live
 * tool cards — otherwise its result is misreported as a call "rejected before
 * execution" and the session is auto-flagged (#3094 fallback).
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
  // Also consumed on the result/done path — see the note in clientLoop.test.ts.
  sumInputTokens: (u: Record<string, number | null | undefined> | null | undefined) =>
    (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0),
}));
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
import { makeResolvedModel } from './aiModels/__fixtures__/resolvedModel';
import { TOOL_SEARCH_MIN_REMAINING_TURNS } from './aiToolSearchPolicy';
import type { AuthContext } from '../middleware/auth';

const ORG = '0c0c0c0c-1111-4222-8333-444455556666';

const DB_SESSION = {
  orgId: ORG,
  sdkSessionId: null,
  maxTurns: 50,
  turnCount: 0,
  systemPrompt: null,
};

const PLATFORM_CONFIG = makeResolvedModel('platform');

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


function optionsOfLastQuery(): { tools: string[]; env: Record<string, string>; maxTurns: number } {
  const call = queryMock.mock.calls.at(-1)![0] as { options: { tools: string[]; env: Record<string, string>; maxTurns: number } };
  return call.options;
}

function userToolSearchResultMessage(id: string) {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'tool_reference', tool_name: 'mcp__breeze__search_logs' }] }],
    },
  };
}

describe('tool-search policy wiring (A-W04)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('gives a web-chat session the ToolSearch built-in and an explicit ENABLE_TOOL_SEARCH=true', async () => {
    mockSdkQuery([RESULT_MSG]);
    const session = await manager.getOrCreate(
      'sess-chat', DB_SESSION, AUTH, undefined, 'PROMPT', undefined, PLATFORM_CONFIG,
      undefined, undefined, { toolSearch: true },
    );
    await session.processorPromise;
    expect(optionsOfLastQuery().tools).toEqual(['ToolSearch']);
    expect(optionsOfLastQuery().env.ENABLE_TOOL_SEARCH).toBe('true');
    // #7444: merging the tool-search env must not drop the host-context guards.
    expect(optionsOfLastQuery().env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
    expect(optionsOfLastQuery().env.CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBe('1');
    // Agent SDK 0.3.288: the env query() actually receives opts out of the CLI's display 'updates' default.
    expect(optionsOfLastQuery().env.CLAUDE_CODE_THINKING_DISPLAY_UPDATES).toBe('0');
  });

  it('keeps tools: [] and ENABLE_TOOL_SEARCH=false for a surface that did not opt in', async () => {
    mockSdkQuery([RESULT_MSG]);
    const session = await manager.getOrCreate(
      'sess-static', DB_SESSION, AUTH, undefined, 'PROMPT', undefined, PLATFORM_CONFIG,
    );
    await session.processorPromise;
    expect(optionsOfLastQuery().tools).toEqual([]);
    expect(optionsOfLastQuery().env.ENABLE_TOOL_SEARCH).toBe('false');
  });

  it('keeps the full list on a self-host gateway base URL', async () => {
    vi.stubEnv('IS_HOSTED', 'false');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'http://litellm.internal:4000');
    mockSdkQuery([RESULT_MSG]);
    const session = await manager.getOrCreate(
      'sess-gateway', DB_SESSION, AUTH, undefined, 'PROMPT', undefined, PLATFORM_CONFIG,
      undefined, undefined, { toolSearch: true },
    );
    await session.processorPromise;
    expect(optionsOfLastQuery().env.ANTHROPIC_BASE_URL).toBe('http://litellm.internal:4000');
    expect(optionsOfLastQuery().tools).toEqual([]);
    expect(optionsOfLastQuery().env.ENABLE_TOOL_SEARCH).toBe('false');
  });

  it('honours the AI_TOOL_SEARCH=off kill switch', async () => {
    vi.stubEnv('AI_TOOL_SEARCH', 'off');
    mockSdkQuery([RESULT_MSG]);
    const session = await manager.getOrCreate(
      'sess-off', DB_SESSION, AUTH, undefined, 'PROMPT', undefined, PLATFORM_CONFIG,
      undefined, undefined, { toolSearch: true },
    );
    await session.processorPromise;
    expect(optionsOfLastQuery().tools).toEqual([]);
  });

  it('does not spend a nearly exhausted turn budget on a search round-trip', async () => {
    mockSdkQuery([RESULT_MSG]);
    const lowBudget = { ...DB_SESSION, turnCount: DB_SESSION.maxTurns - (TOOL_SEARCH_MIN_REMAINING_TURNS - 1) };
    const session = await manager.getOrCreate(
      'sess-low', lowBudget, AUTH, undefined, 'PROMPT', undefined, PLATFORM_CONFIG,
      undefined, undefined, { toolSearch: true },
    );
    await session.processorPromise;
    expect(optionsOfLastQuery().maxTurns).toBe(TOOL_SEARCH_MIN_REMAINING_TURNS - 1);
    expect(optionsOfLastQuery().tools).toEqual([]);
  });

  it('keeps a ToolSearch call out of correlation, transcript tool rows, tool cards and flagging', async () => {
    mockSdkQuery([
      toolUseStreamEvent('toolu_search_01', 'ToolSearch'),
      toolUseStreamEvent('toolu_mcp_02', 'mcp__breeze__set_device_context'),
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'toolu_search_01', name: 'ToolSearch', input: { query: 'select:mcp__breeze__search_logs' } },
            { type: 'tool_use', id: 'toolu_mcp_02', name: 'mcp__breeze__set_device_context', input: PAREN_INPUT },
          ],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
      userToolSearchResultMessage('toolu_search_01'),
      RESULT_MSG,
    ]);
    const session = await manager.getOrCreate(
      'sess-search', DB_SESSION, AUTH, undefined, 'PROMPT', undefined, PLATFORM_CONFIG,
      undefined, undefined, { toolSearch: true },
    );
    await session.processorPromise;

    // Only the MCP call waits for postToolUse — FIFO attribution stays correct.
    expect(session.toolUseIdQueue).toEqual(['toolu_mcp_02']);
    expect(session.toolUseNames?.has('toolu_search_01')).toBe(false);

    const toolUseRows = insertedRows.filter((r) => r.role === 'tool_use');
    expect(toolUseRows.map((r) => r.toolName)).toEqual(['set_device_context']);
    expect(insertedRows.filter((r) => r.role === 'tool_result')).toHaveLength(0);

    const events = session.eventBus.getReplayEvents();
    const cardIds = events
      .filter((e) => e.type === 'tool_use_start' || e.type === 'tool_use_input' || e.type === 'tool_result')
      .map((e) => (e as { toolUseId: string }).toolUseId);
    expect(cardIds).not.toContain('toolu_search_01');
    expect(cardIds).toContain('toolu_mcp_02');

    expect(updateCalls.filter((u) => typeof u.flagReason === 'string')).toHaveLength(0);
  });
});
