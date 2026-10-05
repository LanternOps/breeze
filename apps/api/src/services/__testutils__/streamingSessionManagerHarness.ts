/**
 * Shared fakes for the StreamingSessionManager suites (W03 Task 7). vi.mock
 * blocks stay in each suite (they are hoisted per file); this holds only the
 * pure builders: a scripted Agent SDK `query()` stand-in, a per-turn variant
 * driven by the session's real input stream, and the usual db-session / auth
 * literals.
 */
import { vi } from 'vitest';
import type { AuthContext } from '../../middleware/auth';

export const HARNESS_ORG = '0c0c0c0c-1111-4222-8333-444455556666';
export const HARNESS_USER = 'beefbeef-1111-4222-8333-444455556666';

export const baseDbSession = {
  orgId: HARNESS_ORG,
  sdkSessionId: null as string | null,
  maxTurns: 50,
  turnCount: 0,
  systemPrompt: null as string | null,
};

export const baseAuth = {
  orgId: HARNESS_ORG,
  scope: 'organization',
  accessibleOrgIds: [HARNESS_ORG],
  user: { id: HARNESS_USER, email: 'tech@msp.example.com' },
} as unknown as AuthContext;

export interface FakeQuery extends AsyncIterable<unknown> {
  interrupt: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

/** Yields `messages` once (after `gate`), then ends — one query, one turn. */
export function scriptedQuery(messages: unknown[], gate: Promise<void> = Promise.resolve()): FakeQuery {
  return {
    async *[Symbol.asyncIterator]() {
      await gate;
      yield* messages;
    },
    interrupt: vi.fn(),
    close: vi.fn(),
  };
}

/**
 * A live streaming-input query: waits for each user message on the real
 * `prompt` stream the manager passes to query(), then yields that turn's
 * scripted messages. Ends when the scripted turns run out or the input closes.
 */
export function turnScriptedQuery(prompt: AsyncIterable<unknown>, turns: unknown[][]): FakeQuery {
  return {
    async *[Symbol.asyncIterator]() {
      let i = 0;
      for await (const _input of prompt) {
        const turn = turns[i++];
        if (!turn) return;
        yield* turn;
        if (i >= turns.length) return;
      }
    },
    interrupt: vi.fn(),
    close: vi.fn(),
  };
}

/** An SDK `result` message with per-turn `usage` and cumulative `modelUsage`. */
export function sdkResult(input: {
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  modelUsage?: Record<string, { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number; webSearchRequests?: number; costUSD?: number }>;
  subtype?: string;
  total_cost_usd?: number;
  stop_reason?: string;
  num_turns?: number;
} = {}): Record<string, unknown> {
  return {
    type: 'result',
    subtype: input.subtype ?? 'success',
    stop_reason: input.stop_reason ?? 'end_turn',
    total_cost_usd: input.total_cost_usd ?? 0,
    num_turns: input.num_turns ?? 1,
    usage: input.usage ?? { input_tokens: 0, output_tokens: 0 },
    ...(input.modelUsage ? { modelUsage: input.modelUsage } : {}),
  };
}

/** Assistant rows written through a mocked `db.insert(aiMessages).values(...)`. */
export function insertedAssistantMessages(insert: ReturnType<typeof vi.fn>): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const r of insert.mock.results) {
    const chain = r.value as { values?: ReturnType<typeof vi.fn> } | undefined;
    for (const [row] of chain?.values?.mock.calls ?? []) {
      if ((row as { role?: string })?.role === 'assistant') out.push(row as Record<string, unknown>);
    }
  }
  return out;
}
