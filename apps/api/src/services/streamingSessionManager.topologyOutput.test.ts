/**
 * Topology M4 Task 3 (#6000): a topology investigation turn never streams raw
 * provider output. Text deltas, text-block separators, tool events and raw
 * assistant content go to the host-owned runtime's output gate; live and
 * replay subscribers see only fixed `topology_progress` phases and ONE
 * validated `topology_explanation`, and history stores only that answer.
 *
 * Harness mirrors streamingSessionManager.textSeparator.test.ts.
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
import type { TopologyTurnRuntime } from './topology/aiInvestigation';
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


const EXPLANATION = { schemaVersion: 1 as const, status: 'complete' as const, findings: [], missingData: [], nextChecks: [], citationIds: [], citations: [], reasons: [] };

function runtime(overrides: Partial<TopologyTurnRuntime> = {}) {
  const appended: string[] = [];
  const rt = {
    investigationId: 'inv-1',
    allowedToolNames: new Set(['get_topology']),
    append: vi.fn((d: string) => { appended.push(d); return true; }),
    startBlock: vi.fn(),
    noteUsage: vi.fn(() => true),
    beforeToolCall: vi.fn(async () => ({ allowed: true as const })),
    complete: vi.fn(async () => ({ outcome: 'explanation' as const, explanation: EXPLANATION })),
    abort: vi.fn(async () => undefined),
    ...overrides,
  } satisfies TopologyTurnRuntime;
  return { rt, appended };
}

let manager: StreamingSessionManager;
beforeEach(() => { vi.clearAllMocks(); insertedRows.length = 0; manager = new StreamingSessionManager(); });
afterEach(() => { manager.shutdown(); });

const RAW = 'FOREIGN-SITE-SECRET {"findings":[';
const HOSTILE_TURN = [
  messageStartEvent(),
  textBlockStartEvent(),
  textDeltaEvent('Let me look at the link. '),
  toolUseBlockStartEvent(TOOL_USE_ID, 'mcp__breeze__get_topology'),
  textBlockStartEvent(),
  textDeltaEvent(RAW),
  messageDeltaEvent(),
  { type: 'assistant', message: { content: [
    { type: 'text', text: 'Let me look at the link. ' },
    { type: 'tool_use', id: TOOL_USE_ID, name: 'mcp__breeze__get_topology', input: { site_id: 'x' } },
    { type: 'text', text: RAW },
  ], usage: { input_tokens: 10, output_tokens: 5 } } },
];

describe('topology investigation output (M4 Task 3)', () => {
  it('publishes no raw text, separator or tool event live or on replay — only progress and one validated explanation', async () => {
    const { rt, appended } = runtime();
    mockSdkQuery([...HOSTILE_TURN, RESULT_MSG]);
    const session = await manager.getOrCreate('sess-topo', DB_SESSION, AUTH, undefined, 'PROMPT', undefined, PLATFORM_CONFIG, undefined, undefined, { topologyInvestigation: rt });
    const live: Array<{ type: string }> = [];
    const reader = (async () => { for await (const e of session.eventBus.subscribe('live')) { live.push(e); if (e.type === 'done') break; } })();
    await session.processorPromise;
    await reader;
    const replay = session.eventBus.getReplayEvents();
    for (const events of [live, replay]) {
      expect(events.some((e) => e.type === 'content_delta')).toBe(false);
      expect(events.some((e) => ['tool_use_start', 'tool_use_input', 'tool_result'].includes(e.type))).toBe(false);
      expect(JSON.stringify(events)).not.toContain('FOREIGN-SITE-SECRET');
      expect(events.filter((e) => e.type === 'topology_explanation')).toHaveLength(1);
    }
    expect(replay).toContainEqual({ type: 'topology_progress', phase: 'gathering_evidence' });
    expect(appended.join('')).toContain('FOREIGN-SITE-SECRET');
    expect(rt.startBlock).toHaveBeenCalled();
    expect(rt.complete).toHaveBeenCalledTimes(1);
    // History: never the raw text, never a tool_use row; exactly one structured answer.
    expect(JSON.stringify(insertedRows)).not.toContain('FOREIGN-SITE-SECRET');
    expect(insertedRows.filter((r) => r.role === 'tool_use')).toHaveLength(0);
    const answers = insertedRows.filter((r) => r.role === 'assistant');
    expect(answers).toHaveLength(1);
    expect(JSON.parse(String(answers[0]!.content))).toEqual(EXPLANATION);
    expect(session.topologyInvestigation).toBeUndefined();
  });

  it('a provider error discards the raw buffer and publishes only a fixed error', async () => {
    const { rt } = runtime();
    mockSdkQuery([...HOSTILE_TURN, { ...RESULT_MSG, subtype: 'error_during_execution', errors: ['FOREIGN-SITE-SECRET upstream'] }]);
    const session = await manager.getOrCreate('sess-topo-err', DB_SESSION, AUTH, undefined, 'PROMPT', undefined, PLATFORM_CONFIG, undefined, undefined, { topologyInvestigation: rt });
    await session.processorPromise;
    const replay = session.eventBus.getReplayEvents();
    expect(rt.abort).toHaveBeenCalled();
    expect(rt.complete).not.toHaveBeenCalled();
    expect(replay.some((e) => e.type === 'topology_explanation')).toBe(false);
    expect(JSON.stringify(replay)).not.toContain('FOREIGN-SITE-SECRET');
    expect(replay).toContainEqual({ type: 'error', message: 'The topology explanation could not be completed.' });
    expect(insertedRows.filter((r) => r.role === 'assistant')).toHaveLength(0);
  });

  it('crossing a token cap stops the turn without a current explanation', async () => {
    const { rt } = runtime({ noteUsage: vi.fn(() => false) });
    mockSdkQuery([...HOSTILE_TURN, RESULT_MSG]);
    const session = await manager.getOrCreate('sess-topo-cap', DB_SESSION, AUTH, undefined, 'PROMPT', undefined, PLATFORM_CONFIG, undefined, undefined, { topologyInvestigation: rt });
    await session.processorPromise;
    const replay = session.eventBus.getReplayEvents();
    expect(rt.abort).toHaveBeenCalled();
    expect(replay.some((e) => e.type === 'topology_explanation')).toBe(false);
    expect(replay).toContainEqual({ type: 'error', message: 'This investigation reached its limit. Start a new investigation to continue.' });
  });

  it('a scope change at the final flush publishes the fixed evidence_changed state, not a current answer', async () => {
    const changed = { ...EXPLANATION, status: 'evidence_changed' as const, reasons: ['investigation_scope_changed'] };
    const { rt } = runtime({ complete: vi.fn(async () => ({ outcome: 'scope_changed' as const, explanation: changed })) });
    mockSdkQuery([...HOSTILE_TURN, RESULT_MSG]);
    const session = await manager.getOrCreate('sess-topo-moved', DB_SESSION, AUTH, undefined, 'PROMPT', undefined, PLATFORM_CONFIG, undefined, undefined, { topologyInvestigation: rt });
    await session.processorPromise;
    const explanations = session.eventBus.getReplayEvents().filter((e) => e.type === 'topology_explanation') as Array<{ explanation: { status: string } }>;
    expect(explanations.map((e) => e.explanation.status)).toEqual(['evidence_changed']);
    expect(insertedRows.filter((r) => r.role === 'assistant')).toHaveLength(0);
  });
});
