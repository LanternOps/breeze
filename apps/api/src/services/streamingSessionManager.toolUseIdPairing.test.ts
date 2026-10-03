/**
 * Regression tests for issue #7931: tool_result <-> tool_use pairing.
 *
 * Tool results used to be paired with tool calls by position: the background
 * processor pushed each call's id onto `toolUseIdQueue` when it handled the
 * call's `content_block_start` stream event, and `createSessionPostToolUse`
 * took the head with `shift()`. The SDK runs our MCP handler concurrently with
 * that processor, so on prod a tool sometimes FINISHED before its stream event
 * was handled (US prod v0.121.0, session ad24e4ec). Then:
 *   1. its result was saved with no tool_use_id,
 *   2. the next tool's result took the previous tool's id, and
 *   3. the id left in the queue made the #3094 dropped-call fallback record a
 *      second, fake "rejected before execution" result and flag the session.
 *
 * The CLI sends every MCP `tools/call` the model's own id in
 * `_meta['claudecode/toolUseId']`, and postToolUse now pairs by that id. These
 * tests drive the REAL createSessionPostToolUse inside the REAL background
 * processor, interleaving postToolUse calls with the SDK message stream the way
 * the race interleaves them.
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
  withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock('./aiCostTracker', () => ({
  sumInputTokens: (u: Record<string, number | null | undefined> | null | undefined) =>
    (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0),
  checkBudget: vi.fn(async () => null),
  checkAiRateLimit: vi.fn(async () => null),
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
vi.mock('./aiAgent', () => ({
  sanitizeErrorForClient: (e: unknown) => String(e),
  getSession: vi.fn(),
  buildSystemPrompt: vi.fn(),
  waitForApproval: vi.fn(),
}));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));
vi.mock('./aiAgentSdkTools', () => ({
  createBreezeMcpServer: vi.fn(() => ({ type: 'sdk' })),
  BREEZE_MCP_TOOL_NAMES: ['mcp__breeze__list_configuration_policies', 'mcp__breeze__get_effective_configuration'],
  TOOL_TIERS: { list_configuration_policies: 1, get_effective_configuration: 1 },
}));
// Tier-1 read tools: postToolUse inserts its ai_tool_executions row and never
// takes the tier-2/3 approval branch.
vi.mock('./aiGuardrails', () => ({
  checkGuardrails: vi.fn(() => ({ allowed: true, tier: 1, requiresApproval: false })),
  checkToolPermission: vi.fn(async () => null),
  checkToolRateLimit: vi.fn(async () => null),
  checkPermissionRequirements: vi.fn(() => null),
}));
vi.mock('./scriptProposals', () => ({
  attachProposalToSession: vi.fn(async () => undefined),
  loadProposalGuardrailContext: vi.fn(async () => undefined),
}));
vi.mock('./auditEvents', () => ({
  writeAuditEvent: vi.fn(),
  requestLikeFromSnapshot: vi.fn(() => ({})),
}));
vi.mock('./clientIp', async (orig) => ({
  ...(await orig<typeof import('./clientIp')>()),
  getTrustedClientIpOrUndefined: () => undefined,
}));

import { StreamingSessionManager, type ActiveSession } from './streamingSessionManager';
import type { createSessionPostToolUse } from './aiAgentSdk';
import { makeResolvedModel } from './aiModels/__fixtures__/resolvedModel';
import type { AuthContext } from '../middleware/auth';

type PostToolUse = ReturnType<typeof createSessionPostToolUse>;

const ORG = '0c0c0c0c-1111-4222-8333-444455556666';
const DB_SESSION = { orgId: ORG, sdkSessionId: null, maxTurns: 50, turnCount: 0, systemPrompt: null };
const PLATFORM_CONFIG = makeResolvedModel('platform');
const AUTH = {
  orgId: ORG,
  scope: 'organization',
  accessibleOrgIds: [ORG],
  user: { id: 'beefbeef-1111-4222-8333-444455556666', email: 'tech@contoso.com' },
} as unknown as AuthContext;

const LIST_ID = 'toolu_01B2qh_list';
const EFFECTIVE_ID = 'toolu_01XDh2_effective';
const LIST_TOOL = 'list_configuration_policies';
const EFFECTIVE_TOOL = 'get_effective_configuration';
const LIST_OUTPUT = JSON.stringify({ policies: [{ id: 'p1', name: 'Baseline' }] });
const EFFECTIVE_OUTPUT = JSON.stringify({ deviceId: 'd1', features: {}, inheritanceChain: [] });

function toolUseStreamEvent(id: string, name: string) {
  return {
    type: 'stream_event',
    event: { type: 'content_block_start', content_block: { type: 'tool_use', id, name: `mcp__breeze__${name}` } },
  };
}

function assistantToolUseMessage(id: string, name: string) {
  return {
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', id, name: `mcp__breeze__${name}`, input: {} }],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  };
}

function userToolResultMessage(id: string, text: string, isError = false) {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: [{ type: 'text', text }] }],
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

/** A message to yield, or a postToolUse call to make at that point in the stream. */
type Step = { msg: unknown } | { post: (postToolUse: PostToolUse) => Promise<void> };

/**
 * Drive one turn. `post` steps run INSIDE the SDK iterator, i.e. before the
 * processor pulls the next message — exactly how the MCP handler racing ahead
 * of the stream consumer looks from the processor's side.
 */
async function runTurn(sessionId: string, steps: Step[]): Promise<ActiveSession> {
  let postToolUse: PostToolUse | undefined;
  queryMock.mockImplementation(() => ({
    async *[Symbol.asyncIterator]() {
      for (const step of steps) {
        if ('post' in step) {
          await step.post(postToolUse!);
        } else {
          yield step.msg as never;
        }
      }
    },
    interrupt: vi.fn(),
    close: vi.fn(),
  }));
  const session = await manager.getOrCreate(
    sessionId, DB_SESSION, AUTH, undefined, 'PROMPT', undefined, PLATFORM_CONFIG, undefined,
    (_getAuth, _pre, post) => {
      postToolUse = post;
      return { server: { type: 'sdk' } as never, name: 'breeze' };
    },
  );
  await session.processorPromise;
  return session;
}

const toolResultRows = () => insertedRows.filter((r) => r.role === 'tool_result');
const flagUpdates = () => updateCalls.filter((u) => typeof u.flagReason === 'string');

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

describe('tool_result pairing by the SDK tool_use_id (#7931)', () => {
  it('pairs each result with its own call when postToolUse runs before the call\'s content_block_start is processed', async () => {
    const session = await runTurn('sess-race', [
      // The prod race: list_configuration_policies FINISHED before the
      // processor handled its content_block_start.
      { post: (post) => post(LIST_TOOL, {}, LIST_OUTPUT, false, 12, undefined, undefined, LIST_ID) },
      { msg: toolUseStreamEvent(LIST_ID, LIST_TOOL) },
      { msg: assistantToolUseMessage(LIST_ID, LIST_TOOL) },
      { msg: toolUseStreamEvent(EFFECTIVE_ID, EFFECTIVE_TOOL) },
      { msg: assistantToolUseMessage(EFFECTIVE_ID, EFFECTIVE_TOOL) },
      { post: (post) => post(EFFECTIVE_TOOL, {}, EFFECTIVE_OUTPUT, false, 9, undefined, undefined, EFFECTIVE_ID) },
      { msg: userToolResultMessage(LIST_ID, LIST_OUTPUT) },
      { msg: userToolResultMessage(EFFECTIVE_ID, EFFECTIVE_OUTPUT) },
      { msg: RESULT_MSG },
    ]);

    const rows = toolResultRows();
    // Exactly one result per call — no fake "dropped" duplicate.
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.toolName === LIST_TOOL)?.toolUseId).toBe(LIST_ID);
    expect(rows.find((r) => r.toolName === EFFECTIVE_TOOL)?.toolUseId).toBe(EFFECTIVE_ID);
    expect(rows.some((r) => (r.toolOutput as { droppedBeforeExecution?: boolean })?.droppedBeforeExecution)).toBe(false);

    // The live UI got the same pairing.
    const sseResults = session.eventBus.getReplayEvents().filter((e) => e.type === 'tool_result');
    expect(sseResults.map((e) => (e as { toolUseId: string }).toolUseId)).toEqual([LIST_ID, EFFECTIVE_ID]);

    // Nothing flagged, nothing left pending.
    expect(flagUpdates()).toHaveLength(0);
    expect(session.toolUseIdQueue).toHaveLength(0);
  });

  it('still records a call that really never ran, alongside one that ran early (#3094 kept)', async () => {
    const session = await runTurn('sess-race-and-drop', [
      { post: (post) => post(LIST_TOOL, {}, LIST_OUTPUT, false, 12, undefined, undefined, LIST_ID) },
      { msg: toolUseStreamEvent(LIST_ID, LIST_TOOL) },
      { msg: toolUseStreamEvent(EFFECTIVE_ID, EFFECTIVE_TOOL) },
      // get_effective_configuration is rejected by the SDK before our handler
      // runs: no postToolUse for it, ever.
      { msg: userToolResultMessage(LIST_ID, LIST_OUTPUT) },
      { msg: userToolResultMessage(EFFECTIVE_ID, 'MCP error -32602: Input validation error', true) },
      { msg: RESULT_MSG },
    ]);

    const rows = toolResultRows();
    expect(rows).toHaveLength(2);
    const listRow = rows.find((r) => r.toolName === LIST_TOOL);
    expect(listRow?.toolUseId).toBe(LIST_ID);
    expect((listRow?.toolOutput as { droppedBeforeExecution?: boolean }).droppedBeforeExecution).toBeUndefined();

    const dropped = rows.find((r) => r.toolName === EFFECTIVE_TOOL);
    expect(dropped?.toolUseId).toBe(EFFECTIVE_ID);
    expect((dropped?.toolOutput as { droppedBeforeExecution?: boolean }).droppedBeforeExecution).toBe(true);

    expect(flagUpdates()).toHaveLength(1);
    expect(flagUpdates()[0]!.flagReason).toContain(EFFECTIVE_TOOL);
    expect(session.toolUseIdQueue).toHaveLength(0);
  });

  it('pairs by id in the ordinary order too (content_block_start first)', async () => {
    const session = await runTurn('sess-ordinary', [
      { msg: toolUseStreamEvent(LIST_ID, LIST_TOOL) },
      { msg: toolUseStreamEvent(EFFECTIVE_ID, EFFECTIVE_TOOL) },
      // Parallel calls can finish in either order — the second one first here.
      { post: (post) => post(EFFECTIVE_TOOL, {}, EFFECTIVE_OUTPUT, false, 9, undefined, undefined, EFFECTIVE_ID) },
      { post: (post) => post(LIST_TOOL, {}, LIST_OUTPUT, false, 12, undefined, undefined, LIST_ID) },
      { msg: userToolResultMessage(LIST_ID, LIST_OUTPUT) },
      { msg: userToolResultMessage(EFFECTIVE_ID, EFFECTIVE_OUTPUT) },
      { msg: RESULT_MSG },
    ]);

    const rows = toolResultRows();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.toolName === LIST_TOOL)?.toolUseId).toBe(LIST_ID);
    expect(rows.find((r) => r.toolName === EFFECTIVE_TOOL)?.toolUseId).toBe(EFFECTIVE_ID);
    expect(flagUpdates()).toHaveLength(0);
    expect(session.toolUseIdQueue).toHaveLength(0);
  });

  it('without an SDK id, pairs by tool name rather than queue position', async () => {
    const session = await runTurn('sess-no-id', [
      { msg: toolUseStreamEvent(LIST_ID, LIST_TOOL) },
      { msg: toolUseStreamEvent(EFFECTIVE_ID, EFFECTIVE_TOOL) },
      // No id from the SDK (older CLI / handler that does not forward it):
      // the second call finishes first. FIFO would hand it LIST_ID.
      { post: (post) => post(EFFECTIVE_TOOL, {}, EFFECTIVE_OUTPUT, false, 9) },
      { post: (post) => post(LIST_TOOL, {}, LIST_OUTPUT, false, 12) },
      { msg: userToolResultMessage(LIST_ID, LIST_OUTPUT) },
      { msg: userToolResultMessage(EFFECTIVE_ID, EFFECTIVE_OUTPUT) },
      { msg: RESULT_MSG },
    ]);

    const rows = toolResultRows();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.toolName === LIST_TOOL)?.toolUseId).toBe(LIST_ID);
    expect(rows.find((r) => r.toolName === EFFECTIVE_TOOL)?.toolUseId).toBe(EFFECTIVE_ID);
    expect(flagUpdates()).toHaveLength(0);
    expect(session.toolUseIdQueue).toHaveLength(0);
  });

  it('without an SDK id, a call that finished before its stream event is never recorded as dropped', async () => {
    const session = await runTurn('sess-no-id-race', [
      { post: (post) => post(LIST_TOOL, {}, LIST_OUTPUT, false, 12) },
      { msg: toolUseStreamEvent(LIST_ID, LIST_TOOL) },
      { msg: userToolResultMessage(LIST_ID, LIST_OUTPUT) },
      { msg: RESULT_MSG },
    ]);

    // The id was not knowable when the result was saved, but the call is not
    // misreported as rejected and the session is not flagged.
    const rows = toolResultRows();
    expect(rows).toHaveLength(1);
    expect((rows[0]!.toolOutput as { droppedBeforeExecution?: boolean }).droppedBeforeExecution).toBeUndefined();
    expect(flagUpdates()).toHaveLength(0);
    expect(session.toolUseIdQueue).toHaveLength(0);
  });
});
