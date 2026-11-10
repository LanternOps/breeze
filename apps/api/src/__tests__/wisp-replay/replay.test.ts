/**
 * #10432 (W09 Task 2): the Wisp replay regression suite.
 *
 * Five synthetic sessions, one per defect class filed from the 2026-10-28
 * review, played through the real session manager (harness.ts) and scored
 * (score.ts). Each asserts the thresholds the merged waves (W01–W08) meet. A
 * fixture that fails is a regression: fix the code, never the threshold.
 *
 * The mocks below are the boundaries only (Postgres, Redis, the grant reads,
 * budget and settlement, both models), each backed by world.ts. Offline: no
 * database, no network.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@anthropic-ai/claude-agent-sdk', async () => {
  const { replayWorld } = await import('./world');
  return {
    query: (args: { prompt: AsyncIterable<unknown>; options?: unknown }) => {
      if (!replayWorld.sdkQuery) throw new Error('replay: no scripted SDK installed');
      return replayWorld.sdkQuery(args);
    },
  };
});

vi.mock('../../config/env', async (orig) => ({
  ...(await orig<typeof import('../../config/env')>()),
  wispEnabled: () => true,
}));

vi.mock('../../db', async () => {
  const { replayWorld } = await import('./world');
  const { getTableName } = await import('drizzle-orm');
  const rowsFor = (table: unknown): unknown[] => {
    switch (getTableName(table as Parameters<typeof getTableName>[0])) {
      case 'ai_memory_blocks':
        return replayWorld.memoryRows
          .filter((r) => r.status !== 'retracted')
          .map((r) => ({ id: r.id, status: r.status, content: r.content }));
      case 'devices':
        return replayWorld.deviceRows;
      // The session's org and partner settings (approval mode, approval timeout): defaults, no overrides.
      case 'organizations':
        return [{ partnerId: replayWorld.ceiling?.partnerId, settings: {} }];
      case 'partners':
        return [{ settings: {} }];
      case 'ai_budgets':
        return [];
      case 'ai_messages':
        // The previous assistant reply for the extractor: none in a fresh session.
        return [];
      default: {
        // A read the world does not model would quietly see "no rows" and could
        // send production down a fallback branch: recorded, and the suite fails.
        replayWorld.unexpectedReads.push(getTableName(table as Parameters<typeof getTableName>[0]));
        return [];
      }
    }
  };
  const select = () => {
    let rows: unknown[] = [];
    const chain: Record<string, unknown> = {};
    for (const m of ['where', 'limit', 'orderBy', 'innerJoin', 'leftJoin', 'groupBy', 'for']) chain[m] = () => chain;
    chain.from = (table: unknown) => {
      rows = rowsFor(table);
      return chain;
    };
    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(rows).then(resolve, reject);
    return chain;
  };
  // A write the world does not model lands on one row (callers that require a row see it).
  const settled = () => Object.assign(Promise.resolve([]), {
    returning: async () => [{ id: 'replay-row' }],
    onConflictDoNothing: () => settled(),
    onConflictDoUpdate: () => settled(),
  });
  return {
    db: {
      select,
      insert: () => ({
        values: (row: Record<string, unknown> | Array<Record<string, unknown>>) => {
          replayWorld.inserted.push(...(Array.isArray(row) ? row : [row]));
          return settled();
        },
      }),
      update: () => ({ set: () => ({ where: () => settled() }) }),
      execute: async () => [],
    },
    withDbAccessContext: (_ctx: unknown, fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
    runOutsideDbContext: (fn: () => unknown) => fn(),
    getCurrentDbAccessContext: () => undefined,
  };
});

vi.mock('../../services/redis', async () => {
  const { replayWorld } = await import('./world');
  return { getRedis: () => replayWorld.redis };
});

// Production code that swallows a failure reports it here; the suite asserts nothing was reported.
vi.mock('../../services/sentry', async () => {
  const { replayWorld } = await import('./world');
  return {
    captureException: (err: unknown) => {
      replayWorld.reported.push(err);
    },
    captureMessage: (msg: unknown) => {
      replayWorld.reported.push(msg);
    },
  };
});

// The grant: the session row resolves to it; the ceiling and the standing facts come from the fixture.
vi.mock('../../services/wisp/chatCeiling', async () => {
  const { replayWorld } = await import('./world');
  const { replayGrant } = await import('./harness');
  return {
    lookupWispGrant: async () => replayGrant(replayWorld.ceiling!),
    wispSessionToolFilter: async () => () => true,
    unreachableWispAuth: (auth: Record<string, unknown>) => ({ ...auth, accessibleOrgIds: [] }),
    WispSessionUnavailableError: class WispSessionUnavailableError extends Error {},
  };
});
vi.mock('../../services/wisp/grantAuthority', async (orig) => {
  const { replayWorld } = await import('./world');
  return {
    ...(await orig<typeof import('../../services/wisp/grantAuthority')>()),
    resolveGrantCeiling: async () => replayWorld.ceiling!,
    inSystemContext: (fn: () => unknown) => fn(),
  };
});
vi.mock('../../services/wisp/standingLoop', async (orig) => {
  const { replayWorld } = await import('./world');
  return {
    ...(await orig<typeof import('../../services/wisp/standingLoop')>()),
    loadStandingStateFacts: async () => replayWorld.standingFacts!,
  };
});
vi.mock('../../services/wisp/memoryBroker', async (orig) => {
  const { replayWorld } = await import('./world');
  const { randomUUID } = await import('node:crypto');
  return {
    ...(await orig<typeof import('../../services/wisp/memoryBroker')>()),
    // The group write (advisory locks, supersede) is a DB concern; the rows land in the world's store.
    rememberInstructionGroupForGrant: async (_ceiling: unknown, blocks: Array<{ blockType: string; content: Record<string, unknown> }>) => {
      for (const block of blocks) {
        replayWorld.memoryRows.push({ id: randomUUID(), status: 'unconfirmed', blockType: block.blockType, content: block.content });
      }
      return blocks;
    },
  };
});
vi.mock('../../services/wisp/budget', async (orig) => ({
  ...(await orig<typeof import('../../services/wisp/budget')>()),
  chargeableUnderGrant: async () => ({ ok: true }),
}));
vi.mock('../../services/wisp/chatSpendCheck', () => ({ maybeNotifyChatCrossedBudget: async () => 'under' }));

// Budget, reservations and settlement.
vi.mock('../../services/aiCostTracker', () => ({
  sumInputTokens: (u: Record<string, number | null | undefined> | null | undefined) =>
    (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0),
  checkBudgetDetailed: async () => null,
}));
vi.mock('../../services/aiBudgetReservations', () => ({
  markAiBudgetReservationIndeterminate: async () => ({ kind: 'indeterminate' }),
  readSdkUsageSnapshot: async () => null,
  reserveAiBudget: async () => ({ kind: 'reserved', reservationId: 'replay-reservation', reservedCostCents: 2 }),
  releaseUnusedAiBudgetReservation: async () => undefined,
  isAiBudgetLockTimeout: () => false,
}));
vi.mock('../../services/aiModels/settleInvocation', async (orig) => ({
  ...(await orig<typeof import('../../services/aiModels/settleInvocation')>()),
  settleInvocation: async () => ({ costCents: 0, invocationIds: [], deferred: false, unrecorded: false }),
}));
vi.mock('../../services/aiModels/platformModels', async (orig) => ({
  ...(await orig<typeof import('../../services/aiModels/platformModels')>()),
  getPlatformModelByModelId: async () => null,
}));

// The extractor model: the fixture's recorded reply, one per capture.
vi.mock('../../services/aiModels/resolveModel', async () => {
  const { makeResolvedModel } = await import('../../services/aiModels/__fixtures__/resolvedModel');
  return { resolveModel: async () => ({ ...makeResolvedModel('platform'), surface: 'ai_agents', role: 'triage', transport: 'messages_api' }) };
});
vi.mock('../../services/aiModels/connectionFactory', async (orig) => {
  const { replayWorld } = await import('./world');
  return {
    ...(await orig<typeof import('../../services/aiModels/connectionFactory')>()),
    anthropicClientFor: () => ({}),
    createMessage: async () => {
      if (replayWorld.extractorReplies.length === 0) throw new Error('replay: the extractor ran with no recorded reply');
      const reply = replayWorld.extractorReplies.shift();
      const message = { content: [{ type: 'text', text: JSON.stringify(reply) }], stop_reason: 'end_turn' };
      return { message, attempts: [{ wireModel: 'replay-extractor', message }] };
    },
  };
});
vi.mock('../../services/aiModels/invocationUsage', async (orig) => ({
  ...(await orig<typeof import('../../services/aiModels/invocationUsage')>()),
  messagesUsage: () => ({ usage: [], outcome: {} }),
  messagesUsageAfterDispatchError: () => ({ usage: [], outcome: {} }),
}));

// The session's tool plumbing: tools run inside the scripted SDK (harness.ts), so the MCP server and hooks are inert.
vi.mock('../../services/aiAgentSdkTools', () => ({
  createBreezeMcpServer: () => ({ type: 'sdk' }),
  BREEZE_MCP_TOOL_NAMES: [],
}));
vi.mock('../../services/aiAgentSdk', () => ({
  createSessionPreToolUse: () => async () => ({ allowed: true }),
  createSessionPostToolUse: () => async () => undefined,
  settleApprovalWaits: () => undefined,
}));
vi.mock('../../services/aiAgent', () => ({ sanitizeErrorForClient: (e: unknown) => String(e) }));
vi.mock('../../services/toolSources/sdkBridge', () => ({ buildTenantSdkTools: () => [], tenantMcpToolNames: () => [] }));
vi.mock('../../services/toolSources/resolver', () => ({ resolveTenantTools: async () => [] }));
vi.mock('../../services/flows/flowTools', () => ({ resolveFlowTools: async () => [] }));

import { STANDING_CHECK_UNAVAILABLE_MESSAGE } from '../../services/wisp/standingInstructionGate';
import { replaySession, type ReplayFixture, type ReplayTurnExpectation } from './harness';
import { scoreTrace, type ReplayScore, type ReplayTrace, type ReplayTurnTrace } from './score';
import { replayWorld } from './world';
import { checkBackFixture } from './fixtures/checkBack';
import { dontRebootFixture } from './fixtures/dontReboot';
import { needsAttentionFixture } from './fixtures/needsAttention';
import { noopDispatchFixture } from './fixtures/noopDispatch';
import { stillLookingFixture } from './fixtures/stillLooking';

const FIXTURES: ReplayFixture[] = [
  stillLookingFixture,
  needsAttentionFixture,
  checkBackFixture,
  dontRebootFixture,
  noopDispatchFixture,
];

function expectTurn(turn: ReplayTurnTrace | undefined, want: ReplayTurnExpectation, where: string): void {
  expect(turn, `${where}: the turn was not replayed`).toBeDefined();
  const t = turn!;
  expect(t.done, `${where}: the turn ended without done`).toBe(true);
  if (want.standingStateSent !== undefined) expect(t.standingStateSent, `${where}: standing state sent`).toBe(want.standingStateSent);
  if (want.maxToolCalls !== undefined) {
    expect(t.toolCalls.length, `${where}: tool calls (${t.toolCalls.map((c) => c.tool).join(', ')})`).toBeLessThanOrEqual(want.maxToolCalls);
  }
  if (want.corrections !== undefined) expect(t.corrections, `${where}: corrections`).toEqual(want.corrections);
  if (want.captureStatus !== undefined) expect(t.captureStatus, `${where}: capture status`).toBe(want.captureStatus);
  if (want.refused !== undefined) expect(t.toolCalls.filter((c) => c.refused).map((c) => c.tool), `${where}: refused tools`).toEqual(want.refused);
  if (want.unverified !== undefined) {
    expect(t.toolCalls.filter((c) => c.unverified).map((c) => c.tool), `${where}: unverified tools`).toEqual(want.unverified);
  }
}

function expectScore(score: ReplayScore, f: ReplayFixture): void {
  // A refusal is never free: a fail-closed gate error refuses too, so a fixture that expects none says so by default.
  const max: Partial<ReplayScore> = { ...(f.expect.min?.refusals === undefined ? { refusals: 0 } : {}), ...f.expect.max };
  for (const [key, bound] of Object.entries(max) as Array<[keyof ReplayScore, number]>) {
    expect(score[key], `${f.name}: ${key} ≤ ${bound} (${f.guards})`).toBeLessThanOrEqual(bound);
  }
  for (const [key, bound] of Object.entries(f.expect.min ?? {}) as Array<[keyof ReplayScore, number]>) {
    expect(score[key], `${f.name}: ${key} ≥ ${bound} (${f.guards})`).toBeGreaterThanOrEqual(bound);
  }
}

/** Replay with the console watched: a swallowed failure (reported, logged, or an unmodelled read) fails the fixture. */
async function replayClean(fixture: ReplayFixture): Promise<ReplayTrace> {
  const warn = vi.spyOn(console, 'warn');
  const error = vi.spyOn(console, 'error');
  try {
    const trace = await replaySession(fixture);
    expect(replayWorld.reported, `${fixture.name}: errors reported to Sentry`).toEqual([]);
    expect(replayWorld.unexpectedReads, `${fixture.name}: tables read that the world does not model`).toEqual([]);
    expect([...warn.mock.calls, ...error.mock.calls].map((args) => String(args[0])), `${fixture.name}: warnings or errors logged`).toEqual([]);
    return trace;
  } finally {
    warn.mockRestore();
    error.mockRestore();
  }
}

describe('Wisp replay regression suite (#10432)', () => {
  it.each(FIXTURES.map((f) => [f.name, f] as const))('%s', async (_name, fixture) => {
    const trace = await replayClean(fixture);
    const score = scoreTrace(trace);
    expect(trace.turns).toHaveLength(fixture.turns.length);
    for (const [i, want] of (fixture.expect.turns ?? []).entries()) {
      if (want) expectTurn(trace.turns[i], want, `${fixture.name}, turn ${i + 1}`);
    }
    expectScore(score, fixture);
    // The scorer and the session agree: every promise the scorer counts drew its correction in that turn.
    expect(score.promisesWithoutMechanism, `${fixture.name}: unbacked promises vs corrections`)
      .toBe(trace.turns.reduce((n, t) => n + t.corrections.length, 0));
  }, 30_000);

  it('the kept instruction is one confirmed block per named device, and the refusal quotes it', async () => {
    const trace = await replayClean(dontRebootFixture);
    const kept = replayWorld.memoryRows.filter((r) => r.blockType === 'standing_instruction');
    expect(kept.map((r) => r.content.deviceId).sort()).toEqual([...dontRebootFixture.inventory.devices]
      .filter((d) => d.name === 'PC-01' || d.name === 'PC-02').map((d) => d.id).sort());
    expect(kept.every((r) => r.status === 'confirmed')).toBe(true);
    // The refusal names the instruction, so the reply can say why.
    expect(trace.turns[1]!.toolCalls[0]!.output).toMatch(/standing instruction \('don't reboot PC-01 and PC-02'\)/);
    // A refusal, not the check failing closed (which refuses too).
    for (const call of trace.turns.flatMap((t) => t.toolCalls)) expect(call.output).not.toContain(STANDING_CHECK_UNAVAILABLE_MESSAGE);
  }, 30_000);
});
