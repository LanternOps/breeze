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
// The real prepareSdkChild, wrapped so one test can add a gateway child's queryOptions (#11817).
vi.mock('./aiModels/connectionFactory', async (orig) => {
  const actual = await orig<typeof import('./aiModels/connectionFactory')>();
  return { ...actual, prepareSdkChild: vi.fn(actual.prepareSdkChild) };
});

// #12421 W01: the turn-end discovery write, observed rather than run.
vi.mock('./aiToolDiscoveryLedger', () => ({
  persistTurnDiscovery: vi.fn(async () => ({ ok: true, rows: 1, reconciled: 0 })),
}));

// Keeps the lazy real ./flows/flowTools graph (~5 s cold) out of whichever test reaches it first (#11011).
vi.mock('./flows/flowTools', () => ({ resolveFlowTools: async () => [] }));

import { StreamingSessionManager } from './streamingSessionManager';
import { makeResolvedModel } from './aiModels/__fixtures__/resolvedModel';
import { TOOL_SEARCH_MIN_REMAINING_TURNS, TOOL_SEARCH_TURN_HEADROOM } from './aiToolSearchPolicy';
import { settleInvocation } from './aiModels/settleInvocation';
import { lookupWispGrant, wispSessionToolFilter } from './wisp/chatCeiling';
import { createBreezeMcpServer } from './aiAgentSdkTools';
import { SDK_PERMISSION_MODE } from './llm/sdkChildEnvGuards';
import { prepareSdkChild } from './aiModels/connectionFactory';
import type { AuthContext } from '../middleware/auth';
import { persistTurnDiscovery } from './aiToolDiscoveryLedger';
import { discoveryEligible } from './streamingSessionManager';

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


interface LastQueryOptions {
  tools: string[];
  allowedTools: string[];
  env: Record<string, string>;
  maxTurns: number;
  permissionMode?: string;
}

function optionsOfLastQuery(): LastQueryOptions {
  const call = queryMock.mock.calls.at(-1)![0] as { options: LastQueryOptions };
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
    // #11817: an explicit mode, and ToolSearch runs under it without an allow
    // entry (sdkPermissionMode.e2e.test.ts proves that on the real CLI).
    expect(optionsOfLastQuery().permissionMode).toBe(SDK_PERMISSION_MODE);
    expect(optionsOfLastQuery().allowedTools).not.toContain('ToolSearch');
  });

  it('keeps tools: [] and ENABLE_TOOL_SEARCH=false for a surface that did not opt in', async () => {
    mockSdkQuery([RESULT_MSG]);
    const session = await manager.getOrCreate(
      'sess-static', DB_SESSION, AUTH, undefined, 'PROMPT', undefined, PLATFORM_CONFIG,
    );
    await session.processorPromise;
    expect(optionsOfLastQuery().tools).toEqual([]);
    expect(optionsOfLastQuery().env.ENABLE_TOOL_SEARCH).toBe('false');
    expect(optionsOfLastQuery().permissionMode).toBe(SDK_PERMISSION_MODE);
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
    // #11817: the same mode on a gateway connection as on a first-party one.
    expect(optionsOfLastQuery().permissionMode).toBe(SDK_PERMISSION_MODE);
  });

  it("#11817: a gateway child's extra query options cannot override the permission mode", async () => {
    const actual = await vi.importActual<typeof import('./aiModels/connectionFactory')>('./aiModels/connectionFactory');
    vi.mocked(prepareSdkChild).mockImplementationOnce(async (...args) => ({
      ...(await actual.prepareSdkChild(...args)),
      queryOptions: { permissionMode: 'bypassPermissions' },
    }));
    mockSdkQuery([RESULT_MSG]);
    const session = await manager.getOrCreate(
      'sess-override', DB_SESSION, AUTH, undefined, 'PROMPT', undefined, PLATFORM_CONFIG,
      undefined, undefined, { toolSearch: true },
    );
    await session.processorPromise;
    expect(prepareSdkChild).toHaveBeenCalled();
    expect(optionsOfLastQuery().permissionMode).toBe(SDK_PERMISSION_MODE);
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


// #12421 W01: tool-discovery telemetry, written once per chat turn after
// settlement. Only a full-registry chat session (web chat, Wisp) observes;
// every other surface stamps `unknown` and writes nothing.
describe('discovery telemetry (#12421 W01)', () => {
  const writes = () => vi.mocked(persistTurnDiscovery).mock.calls.map((c) => c[0]);
  const assistant = (id: string, content: Array<Record<string, unknown>>) => ({
    type: 'assistant', message: { id, content, usage: { input_tokens: 10, output_tokens: 5 } },
  });
  const searchResult = (id: string, names: string[]) => ({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'tool_search_tool_result', content: names.map((n) => ({ type: 'tool_reference', tool_name: `mcp__breeze__${n}` })) }] }] },
  });
  const SEARCHING_TURN = [
    assistant('msg_1', [{ type: 'tool_use', id: 'toolu_s1', name: 'ToolSearch', input: { query: 'store device context', max_results: 5 } }]),
    searchResult('toolu_s1', ['set_device_context']),
    assistant('msg_2', [{ type: 'tool_use', id: 'toolu_w1', name: 'mcp__breeze__set_device_context', input: PAREN_INPUT }]),
    assistant('msg_3', [{ type: 'text', text: 'Done.' }]),
    { ...RESULT_MSG, num_turns: 3 },
  ];

  /** A query whose stream waits for `release()` before yielding, so the test can bind the turn first. */
  function gatedSdkQuery(messages: unknown[]): { release: () => void } {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    queryMock.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        await gate;
        yield* messages as never[];
      },
      interrupt: vi.fn(),
      close: vi.fn(),
    }));
    return { release };
  }

  it('a searching turn calls persistTurnDiscovery once with one search event and the turn summary', async () => {
    const { release } = gatedSdkQuery(SEARCHING_TURN);
    const session = await manager.getOrCreate(
      'sess-disc', DB_SESSION, AUTH, undefined, 'PROMPT', undefined, PLATFORM_CONFIG,
      undefined, undefined, { toolSearch: true },
    );
    session.turnUserMessageId = '00000000-0000-4000-8000-000000000009';
    release();
    await session.processorPromise;

    expect(writes()).toHaveLength(1);
    const write = writes()[0]!;
    expect(write).toMatchObject({
      sessionId: 'sess-disc',
      orgId: ORG,
      turnMessageId: '00000000-0000-4000-8000-000000000009',
      surface: 'chat',
      surfaceFingerprint: session.toolSurfaceFingerprint,
      turn: { searches: 1, searchOnlyRoundTrips: 1, workRoundTrips: 1, firstCallAfterSearches: 1, aborted: false },
    });
    expect(write.surfaceFingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(write.events).toHaveLength(1);
    expect(write.events[0]).toMatchObject({
      toolUseId: 'toolu_s1', roundTripId: 'msg_1', query: 'store device context', maxResults: 5,
      resultToolNames: ['set_device_context'], calledToolNames: ['set_device_context'], empty: false,
    });
    // The flush passes endTurn's final discovery per call as the reconcile map.
    expect([...write.reconcile]).toEqual([['toolu_w1', 'searched_this_turn']]);
    // The session-sticky set keeps the loaded name for the next turn.
    expect(session.discovery?.discoveryOf('set_device_context')).toBe('loaded_earlier');
  });

  it('a zero-search turn still writes a turn row', async () => {
    mockSdkQuery([assistant('msg_1', [{ type: 'text', text: 'Hello' }]), RESULT_MSG]);
    const session = await manager.getOrCreate(
      'sess-disc-0', DB_SESSION, AUTH, undefined, 'PROMPT', undefined, PLATFORM_CONFIG,
      undefined, undefined, { toolSearch: true },
    );
    await session.processorPromise;
    expect(writes()).toHaveLength(1);
    expect(writes()[0]).toMatchObject({ events: [], turn: { searches: 0, aborted: false } });
  });

  it('the write is awaited after settleInvocation', async () => {
    const order: string[] = [];
    vi.mocked(settleInvocation).mockImplementationOnce(async () => { order.push('settle'); return { costCents: 0, invocationIds: [], deferred: false } as never; });
    vi.mocked(persistTurnDiscovery).mockImplementationOnce(async () => { order.push('discovery'); return { ok: true, rows: 1, reconciled: 0 }; });
    mockSdkQuery(SEARCHING_TURN);
    const session = await manager.getOrCreate(
      'sess-disc-order', DB_SESSION, AUTH, undefined, 'PROMPT', undefined, PLATFORM_CONFIG,
      undefined, undefined, { toolSearch: true },
    );
    await session.processorPromise;
    expect(order).toEqual(['settle', 'discovery']);
  });

  it('a failed or throwing write never fails the turn', async () => {
    vi.mocked(persistTurnDiscovery).mockRejectedValueOnce(new Error('boom'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockSdkQuery(SEARCHING_TURN);
    const session = await manager.getOrCreate(
      'sess-disc-throw', DB_SESSION, AUTH, undefined, 'PROMPT', undefined, PLATFORM_CONFIG,
      undefined, undefined, { toolSearch: true },
    );
    await session.processorPromise;
    expect(settleInvocation).toHaveBeenCalled();
    expect(session.eventBus.getReplayEvents().some((e) => e.type === 'done')).toBe(true);
    errSpy.mockRestore();
  });

  it('an aborted turn (no result) flushes with aborted true and the unmatched search as empty', async () => {
    mockSdkQuery([
      assistant('msg_1', [{ type: 'tool_use', id: 'toolu_s1', name: 'ToolSearch', input: { query: 'restart a service' } }]),
      // The stream ends before the search result and before any `result`.
    ]);
    const session = await manager.getOrCreate(
      'sess-disc-abort', DB_SESSION, AUTH, undefined, 'PROMPT', undefined, PLATFORM_CONFIG,
      undefined, undefined, { toolSearch: true, budgetReservationId: 'res-1' },
    );
    await session.processorPromise;
    expect(writes()).toHaveLength(1);
    expect(writes()[0]).toMatchObject({ turn: { aborted: true, searches: 1 } });
    expect(writes()[0]!.events[0]).toMatchObject({ toolUseId: 'toolu_s1', empty: true, resultToolNames: [] });
  });

  it('a session whose surface did not opt into the full chat registry has discovery null and writes nothing', async () => {
    mockSdkQuery(SEARCHING_TURN);
    const staticSession = await manager.getOrCreate(
      'sess-disc-static', DB_SESSION, AUTH, undefined, 'PROMPT', undefined, PLATFORM_CONFIG,
    );
    await staticSession.processorPromise;
    expect(staticSession.discovery).toBeNull();

    // A factory-built server (topology, helper, Office, script builder) — even on the chat surface.
    mockSdkQuery(SEARCHING_TURN);
    const factory = vi.fn(() => ({ server: { type: 'sdk' } as never, name: 'breeze' }));
    const factorySession = await manager.getOrCreate(
      'sess-disc-factory', DB_SESSION, AUTH, undefined, 'PROMPT', undefined, PLATFORM_CONFIG,
      ['mcp__breeze__query_devices'], factory,
    );
    await factorySession.processorPromise;
    expect(factory).toHaveBeenCalled();
    expect(factorySession.discovery).toBeNull();
    expect(writes()).toHaveLength(0);
  });

  it('discoveryEligible is true only for a chat-surface session that registered the full chat registry', () => {
    const chat = { turnBinding: { surface: 'chat' } } as never;
    expect(discoveryEligible(chat, { fullChatRegistry: true })).toBe(true);
    expect(discoveryEligible(chat, { fullChatRegistry: false })).toBe(false);
    for (const surface of ['helper', 'office_chat', 'script_builder', 'ai_agents']) {
      expect(discoveryEligible({ turnBinding: { surface } } as never, { fullChatRegistry: true })).toBe(false);
    }
  });

  it('a Wisp session is eligible (chat surface, full registry behind its grant filter)', async () => {
    vi.mocked(lookupWispGrant).mockResolvedValueOnce({ grantId: 'g-1', revisionId: 'r-1', threadId: 't-1' } as never);
    vi.mocked(wispSessionToolFilter).mockResolvedValueOnce(() => true);
    mockSdkQuery(SEARCHING_TURN);
    const session = await manager.getOrCreate(
      'sess-disc-wisp', DB_SESSION, AUTH, undefined, 'PROMPT', undefined, PLATFORM_CONFIG,
      undefined, undefined, { toolSearch: true },
    );
    await session.processorPromise;
    expect(session.discovery).not.toBeNull();
    expect(writes()).toHaveLength(1);
  });
});
