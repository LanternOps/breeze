/**
 * Topology M4 Task 3 (#6000): the chat-only (OpenAI-compatible) transport
 * applies the same output gate as the SDK path. It explains the already-built
 * evidence with zero tool calls; its raw `content_delta` publish and assistant
 * persistence are bypassed for a topology turn, and the provider output cap is
 * the investigation's 2,000 tokens.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

// #4329: the runTurn() background turn touches withDbAccessContext (turnCount
// increment in its `finally`) even on the stream-error path under test here.
// Same db-mock shape as aiKillState.test.ts: pass calls straight through so
// runTurn's DB write is a no-op instead of hitting a real pool.
const insertedRows = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('../../db', () => ({
  db: {
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
    insert: () => ({ values: (row: Record<string, unknown>) => { insertedRows.push(row); return Promise.resolve(); } }),
  },
  runOutsideDbContext: vi.fn(<T,>(fn: () => T): T => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown> | unknown) => fn()),
}));

vi.mock('../sentry', () => ({
  captureException: vi.fn(),
}));

vi.mock('../aiBudgetReservations', () => ({
  // The manager settles through the DURABLE wrapper (review item 2): it waits
  // longer for the org lock, retries once on contention and falls back to
  // marking the reservation indeterminate, so a lock timeout on the money path
  // cannot silently drop the spend.
  settleAiBudgetReservationDurably: vi.fn(),
  markAiBudgetReservationIndeterminate: vi.fn(async () => ({
    kind: 'indeterminate', reservationId: 'reservation-1',
  })),
  releaseUnusedAiBudgetReservation: vi.fn(),
}));

vi.mock('../aiCostTracker', () => ({ deductBillingCredits: vi.fn() }));

vi.mock('./historyBuilder', () => ({
  buildMessagesFromHistory: vi.fn(async () => []),
  ToolUseInHistoryError: class ToolUseInHistoryError extends Error {},
}));

vi.mock('../../config/validate', () => ({
  getConfig: vi.fn(() => ({ MCP_LLM_MODEL: 'test-model' })),
}));

import { OpenAISessionManager } from './openaiSessionManager';
import type { OpenAICompatibleProvider } from './openaiCompatibleProvider';
import type { AuthContext } from '../../middleware/auth';
import type { LLMStreamEvent } from './types';
import type { TopologyTurnRuntime } from '../topology/aiInvestigation';

const EXPLANATION = { schemaVersion: 1 as const, status: 'complete' as const, findings: [], missingData: [], nextChecks: [], citationIds: [], citations: [], reasons: [] };

function runtime(overrides: Partial<TopologyTurnRuntime> = {}) {
  const appended: string[] = [];
  const rt = {
    investigationId: 'inv-1', allowedToolNames: new Set<string>(),
    append: vi.fn((d: string) => { appended.push(d); return true; }), startBlock: vi.fn(), noteUsage: vi.fn(() => true),
    beforeToolCall: vi.fn(async () => ({ allowed: false as const, error: 'no tools' })),
    complete: vi.fn(async () => ({ outcome: 'explanation' as const, explanation: EXPLANATION })),
    abort: vi.fn(async () => undefined),
    ...overrides,
  } satisfies TopologyTurnRuntime;
  return { rt, appended };
}

async function runTurn(events: LLMStreamEvent[], rt: TopologyTurnRuntime) {
  const chatStream = vi.fn(async function* (): AsyncGenerator<LLMStreamEvent> { yield* events; });
  const manager = new OpenAISessionManager({ chatStream, computeCostUsd: vi.fn(() => 0), maxOutputTokensForBudgetUsd: vi.fn(() => 9000) } as unknown as OpenAICompatibleProvider);
  const session = manager.getOrCreate('sess-topo', 'org-1', {} as AuthContext, undefined);
  session.topologyInvestigation = rt;
  manager.tryTransitionToProcessing(session);
  const live: Array<{ type: string }> = [];
  const consumer = (async () => { for await (const e of session.eventBus.subscribe('live')) { live.push(e); if (e.type === 'done') break; } })();
  manager.startTurn(session, 'm', 'system', 'question', { reservationId: 'r-1', maxBudgetUsd: 1 });
  await consumer;
  manager.shutdown();
  return { live, replay: session.eventBus.getReplayEvents(), chatStream, session };
}

describe('OpenAI-compatible topology turn (M4 Task 3)', () => {
  afterEach(() => { vi.clearAllMocks(); insertedRows.length = 0; });

  it('never publishes or persists raw content; emits one validated explanation', async () => {
    const { rt, appended } = runtime();
    const { live, replay, chatStream, session } = await runTurn([
      { type: 'content_delta', delta: 'FOREIGN-SITE-SECRET ' },
      { type: 'content_delta', delta: '{"findings":[' },
      { type: 'message_end', inputTokens: 100, outputTokens: 20 },
    ], rt);
    for (const events of [live, replay]) {
      expect(events.some((e) => e.type === 'content_delta')).toBe(false);
      expect(JSON.stringify(events)).not.toContain('FOREIGN-SITE-SECRET');
      expect(events.filter((e) => e.type === 'topology_explanation')).toHaveLength(1);
    }
    expect(appended.join('')).toContain('FOREIGN-SITE-SECRET');
    expect(rt.noteUsage).toHaveBeenCalledWith({ inputTokens: 100, outputTokens: 20 });
    expect(chatStream).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ maxTokens: 2000 }));
    expect(JSON.stringify(insertedRows)).not.toContain('FOREIGN-SITE-SECRET');
    expect(insertedRows.filter((r) => r.role === 'assistant').map((r) => JSON.parse(String(r.content)))).toEqual([EXPLANATION]);
    expect(session.topologyInvestigation).toBeUndefined();
  });

  it('a provider error discards and publishes only a fixed error', async () => {
    const { rt } = runtime();
    const { replay } = await runTurn([
      { type: 'content_delta', delta: 'FOREIGN-SITE-SECRET' },
      { type: 'error', message: 'upstream said FOREIGN-SITE-SECRET' },
    ], rt);
    expect(rt.abort).toHaveBeenCalled();
    expect(rt.complete).not.toHaveBeenCalled();
    expect(JSON.stringify(replay)).not.toContain('FOREIGN-SITE-SECRET');
    expect(replay).toContainEqual({ type: 'error', message: 'The topology explanation could not be completed.' });
    expect(insertedRows.filter((r) => r.role === 'assistant')).toHaveLength(0);
  });

  it('a token cap crossed at message_end ends without a current explanation', async () => {
    const { rt } = runtime({ noteUsage: vi.fn(() => false) });
    const { replay } = await runTurn([{ type: 'content_delta', delta: '{}' }, { type: 'message_end', inputTokens: 30000, outputTokens: 5 }], rt);
    expect(rt.abort).toHaveBeenCalled();
    expect(replay.some((e) => e.type === 'topology_explanation')).toBe(false);
  });
});
