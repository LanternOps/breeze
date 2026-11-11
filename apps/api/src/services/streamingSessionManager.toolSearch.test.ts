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

// Wisp W04 Task 4: getOrCreate resolves the session's delegation grant itself
// (lookupWispGrant); every session in this suite is an ordinary one except in
// the `Wisp tool index (#10430)` block.
vi.mock('./wisp/chatCeiling', () => ({
  lookupWispGrant: vi.fn(async () => null),
  wispSessionToolFilter: vi.fn(),
  unreachableWispAuth: (auth: unknown) => auth,
  WispSessionUnavailableError: class WispSessionUnavailableError extends Error {},
}));

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
  settleApprovalWaits: vi.fn(),
}));
vi.mock('./aiToolOutput', () => ({
  redactAiToolOutputText: (s: string) => s,
  redactSensitiveToolInput: (input: Record<string, unknown>) => input,
}));
vi.mock('./clientIp', () => ({ getTrustedClientIpOrUndefined: () => undefined }));

// Keeps the lazy real ./flows/flowTools graph (~5 s cold) out of whichever test reaches it first (#11011).
vi.mock('./flows/flowTools', () => ({ resolveFlowTools: async () => [] }));

import { StreamingSessionManager } from './streamingSessionManager';
import { makeResolvedModel } from './aiModels/__fixtures__/resolvedModel';
import { TOOL_SEARCH_MIN_REMAINING_TURNS, TOOL_SEARCH_TURN_HEADROOM } from './aiToolSearchPolicy';
import { settleInvocation } from './aiModels/settleInvocation';
import { lookupWispGrant, wispSessionToolFilter } from './wisp/chatCeiling';
import { createBreezeMcpServer } from './aiAgentSdkTools';
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

describe('Wisp tool index (#10430)', () => {
  const GRANT = { grantId: 'g-1', revisionId: 'r-1', threadId: 't-1' };

  it('registers a Wisp session\'s tools through its grant ceiling\'s tool filter', async () => {
    const admitTool = (name: string) => name !== 'list_operator_tasks';
    vi.mocked(lookupWispGrant).mockResolvedValueOnce(GRANT);
    vi.mocked(wispSessionToolFilter).mockResolvedValueOnce(admitTool);
    mockSdkQuery([RESULT_MSG]);
    const session = await manager.getOrCreate(
      'sess-wisp', DB_SESSION, AUTH, undefined, 'PROMPT', undefined, PLATFORM_CONFIG,
      undefined, undefined, { toolSearch: true },
    );
    await session.processorPromise;
    expect(wispSessionToolFilter).toHaveBeenCalledWith(GRANT);
    expect(vi.mocked(createBreezeMcpServer).mock.calls.at(-1)?.[5]).toEqual({ admitTool });
  });

  it('leaves an ordinary session\'s server unfiltered', async () => {
    mockSdkQuery([RESULT_MSG]);
    const session = await manager.getOrCreate(
      'sess-plain', DB_SESSION, AUTH, undefined, 'PROMPT', undefined, PLATFORM_CONFIG,
      undefined, undefined, { toolSearch: true },
    );
    await session.processorPromise;
    expect(wispSessionToolFilter).not.toHaveBeenCalled();
    expect(vi.mocked(createBreezeMcpServer).mock.calls.at(-1)?.[5]).toBeUndefined();
  });
});

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

// #10400: a session's turn budget counts work, not retrieval. A model
// round-trip whose only tool calls are ToolSearch loads tool definitions and
// does no work, so it must not spend `turn_count` (8 messages with 9 searches
// exhausted a 50-turn session). The SDK's own per-query ceiling still counts
// every round-trip, so a runaway loop — searches included — still trips.
describe('turn budget (#10400)', () => {
  function assistant(id: string | undefined, content: Array<Record<string, unknown>>) {
    return {
      type: 'assistant',
      message: { ...(id ? { id } : {}), content, usage: { input_tokens: 10, output_tokens: 5 } },
    };
  }
  const search = (id: string) => ({ type: 'tool_use', id, name: 'ToolSearch', input: { query: 'select:mcp__breeze__search_logs' } });
  const work = (id: string) => ({ type: 'tool_use', id, name: 'mcp__breeze__set_device_context', input: PAREN_INPUT });
  const settledTurnCounts = () =>
    vi.mocked(settleInvocation).mock.calls.map((c) => (c[0] as { turnCount?: number }).turnCount);

  it('does not charge ToolSearch-only round-trips to the session turn count', async () => {
    mockSdkQuery([
      assistant('msg_1', [search('toolu_s1')]),
      userToolSearchResultMessage('toolu_s1'),
      // The CLI emits one assistant message per content block, sharing the
      // API response id: thinking + ToolSearch is still one search round-trip.
      assistant('msg_2', [{ type: 'thinking', thinking: '', signature: 'sig' }]),
      assistant('msg_2', [search('toolu_s2')]),
      userToolSearchResultMessage('toolu_s2'),
      // A search alongside a real call is work.
      assistant('msg_3', [search('toolu_s3')]),
      assistant('msg_3', [work('toolu_w1')]),
      assistant('msg_4', [{ type: 'text', text: 'Done.' }]),
      { ...RESULT_MSG, num_turns: 4 },
    ]);
    const session = await manager.getOrCreate(
      'sess-budget', DB_SESSION, AUTH, undefined, 'PROMPT', undefined, PLATFORM_CONFIG,
      undefined, undefined, { toolSearch: true },
    );
    await session.processorPromise;
    expect(settledTurnCounts()).toEqual([2]);
  });

  it('counts an id-less assistant message as its own round-trip', async () => {
    mockSdkQuery([
      assistant(undefined, [search('toolu_s1')]),
      assistant(undefined, [{ type: 'text', text: 'Done.' }]),
      { ...RESULT_MSG, num_turns: 2 },
    ]);
    const session = await manager.getOrCreate(
      'sess-anon', DB_SESSION, AUTH, undefined, 'PROMPT', undefined, PLATFORM_CONFIG,
      undefined, undefined, { toolSearch: true },
    );
    await session.processorPromise;
    expect(settledTurnCounts()).toEqual([1]);
  });

  it('starts each turn with a fresh tally', async () => {
    mockSdkQuery([
      assistant('msg_1', [search('toolu_s1')]),
      assistant('msg_2', [{ type: 'text', text: 'One.' }]),
      { ...RESULT_MSG, num_turns: 2 },
      assistant('msg_3', [{ type: 'text', text: 'Two.' }]),
      { ...RESULT_MSG, num_turns: 1 },
    ]);
    const session = await manager.getOrCreate(
      'sess-two', DB_SESSION, AUTH, undefined, 'PROMPT', undefined, PLATFORM_CONFIG,
      undefined, undefined, { toolSearch: true },
    );
    await session.processorPromise;
    expect(settledTurnCounts()).toEqual([1, 1]);
  });

  it('gives the SDK query headroom for search round-trips on top of the remaining work turns', async () => {
    mockSdkQuery([RESULT_MSG]);
    const session = await manager.getOrCreate(
      'sess-headroom', { ...DB_SESSION, turnCount: 40 }, AUTH, undefined, 'PROMPT', undefined, PLATFORM_CONFIG,
      undefined, undefined, { toolSearch: true },
    );
    await session.processorPromise;
    expect(optionsOfLastQuery().tools).toEqual(['ToolSearch']);
    expect(optionsOfLastQuery().maxTurns).toBe(10 + TOOL_SEARCH_TURN_HEADROOM);
  });

  it('gives no headroom when the session cannot search', async () => {
    mockSdkQuery([RESULT_MSG]);
    const session = await manager.getOrCreate(
      'sess-static', { ...DB_SESSION, turnCount: 40 }, AUTH, undefined, 'PROMPT', undefined, PLATFORM_CONFIG,
    );
    await session.processorPromise;
    expect(optionsOfLastQuery().tools).toEqual([]);
    expect(optionsOfLastQuery().maxTurns).toBe(10);
  });

  it('charges a search-only loop that hits the ceiling one turn, so retrying it is never free', async () => {
    mockSdkQuery([
      assistant('msg_1', [search('toolu_s1')]),
      assistant('msg_2', [search('toolu_s2')]),
      assistant('msg_3', [search('toolu_s3')]),
      { ...RESULT_MSG, subtype: 'error_max_turns', num_turns: 3, errors: [] },
    ]);
    const session = await manager.getOrCreate(
      'sess-search-loop', DB_SESSION, AUTH, undefined, 'PROMPT', undefined, PLATFORM_CONFIG,
      undefined, undefined, { toolSearch: true },
    );
    await session.processorPromise;
    expect(settledTurnCounts()).toEqual([1]);
  });

  // The SDK's ceiling carries search headroom, so it no longer stops a query of
  // real work at the session's limit: the stream has to. Remaining work = 5.
  describe('work budget inside a searching turn', () => {
    const NEAR_LIMIT = { ...DB_SESSION, turnCount: 45 };
    const realRoundTrips = (n: number) =>
      Array.from({ length: n }, (_, i) => assistant(`msg_w${i}`, [work(`toolu_w${i}`)]));
    const interruptOf = (session: { query: unknown }) =>
      (session.query as { interrupt: ReturnType<typeof vi.fn> }).interrupt;
    const start = (id: string) =>
      manager.getOrCreate(id, NEAR_LIMIT, AUTH, undefined, 'PROMPT', undefined, PLATFORM_CONFIG, undefined, undefined, { toolSearch: true });
    const errorsOf = (session: { eventBus: { getReplayEvents(): Array<{ type: string }> } }) =>
      session.eventBus.getReplayEvents().filter((e) => e.type === 'error');

    it('stops at the first real round-trip past the limit and reports the coded turn limit', async () => {
      mockSdkQuery([
        ...realRoundTrips(6),
        { ...RESULT_MSG, subtype: 'error_during_execution', num_turns: 6, errors: ['aborted'] },
      ]);
      const session = await start('sess-over');
      await session.processorPromise;
      expect(interruptOf(session)).toHaveBeenCalledTimes(1);
      expect(errorsOf(session)).toEqual([expect.objectContaining({ code: 'turn_limit_reached' })]);
    });

    it('spends the cycle approval-wait budget at the stop, so the over-limit call cannot block on an approval', async () => {
      const before = Date.now();
      mockSdkQuery([...realRoundTrips(6), { ...RESULT_MSG, subtype: 'error_during_execution', num_turns: 6, errors: [] }]);
      const session = await start('sess-approval');
      await session.processorPromise;
      // No wait was in flight when the stop landed (the call's preToolUse had
      // not begun one), so settling alone would leave its budget untouched.
      expect(session.approvalWaitDeadline).not.toBeNull();
      expect(session.approvalWaitDeadline!).toBeGreaterThanOrEqual(before);
      expect(session.approvalWaitDeadline!).toBeLessThanOrEqual(Date.now());
    });

    it('does not stop a turn that spends exactly its remaining work turns', async () => {
      mockSdkQuery([...realRoundTrips(5), assistant('msg_end', [{ type: 'text', text: 'Done.' }]), { ...RESULT_MSG, num_turns: 6 }]);
      const session = await start('sess-exact');
      await session.processorPromise;
      expect(interruptOf(session)).not.toHaveBeenCalled();
      expect(errorsOf(session)).toEqual([]);
    });

    it('does not count search round-trips toward the limit', async () => {
      mockSdkQuery([
        ...Array.from({ length: 5 }, (_, i) => assistant(`msg_s${i}`, [search(`toolu_s${i}`)])),
        ...realRoundTrips(5),
        { ...RESULT_MSG, num_turns: 10 },
      ]);
      const session = await start('sess-searchy');
      await session.processorPromise;
      expect(interruptOf(session)).not.toHaveBeenCalled();
      expect(settledTurnCounts()).toEqual([5]);
    });

    it('reports the limit and charges the real round-trips when the stop ends with no result', async () => {
      mockSdkQuery(realRoundTrips(6));
      const session = await start('sess-noresult');
      await session.processorPromise;
      expect(errorsOf(session)).toEqual([expect.objectContaining({ code: 'turn_limit_reached' })]);
      expect(settledTurnCounts()).toEqual([6]);
    });

    it('leaves a query that cannot search to the SDK ceiling', async () => {
      mockSdkQuery(realRoundTrips(6));
      const session = await manager.getOrCreate('sess-nosearch', NEAR_LIMIT, AUTH, undefined, 'PROMPT', undefined, PLATFORM_CONFIG);
      await session.processorPromise;
      expect(interruptOf(session)).not.toHaveBeenCalled();
    });
  });

  it('still trips the ceiling and charges every round-trip of a real tool loop', async () => {
    mockSdkQuery([
      assistant('msg_1', [work('toolu_w1')]),
      assistant('msg_2', [work('toolu_w2')]),
      assistant('msg_3', [work('toolu_w3')]),
      { ...RESULT_MSG, subtype: 'error_max_turns', num_turns: 3, errors: [] },
    ]);
    const session = await manager.getOrCreate(
      'sess-loop', DB_SESSION, AUTH, undefined, 'PROMPT', undefined, PLATFORM_CONFIG,
      undefined, undefined, { toolSearch: true },
    );
    await session.processorPromise;
    expect(settledTurnCounts()).toEqual([3]);
    expect(session.eventBus.getReplayEvents()).toContainEqual(
      expect.objectContaining({ type: 'error', code: 'turn_limit_reached' }),
    );
  });
});
