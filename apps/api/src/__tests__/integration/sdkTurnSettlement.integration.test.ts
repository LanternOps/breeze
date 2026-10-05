/**
 * AI model registry W03 (#7601) Task 7: the Agent SDK session seam end to end
 * against real Postgres — StreamingSessionManager → sdkTurnUsage →
 * settleInvocation → ai_invocations / session totals / ai_cost_usage / the
 * session's SDK usage snapshot. Only the SDK subprocess is faked.
 *
 * Pins the W05 spike rules where it matters (real snapshot read + advance in
 * the settlement transaction): two turns on one live query each bill their own
 * tokens; an aborted turn bills zero and releases its reservation; the next
 * resumed query bills the aborted turn's persisted usage through the delta,
 * exactly once.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';

const fake = vi.hoisted(() => ({
  turns: [] as unknown[][],
  /** When set, the query yields this partial turn and then dies with no result. */
  abortAfter: null as unknown[] | null,
}));

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>()),
  query: (args: { prompt: AsyncIterable<unknown> }) => ({
    async *[Symbol.asyncIterator]() {
      let i = 0;
      for await (const _input of args.prompt) {
        if (fake.abortAfter) { yield* fake.abortAfter; return; }
        const turn = fake.turns[i++];
        if (!turn) return;
        yield* turn;
        if (i >= fake.turns.length) return;
      }
    },
    interrupt: async () => undefined,
    close: () => undefined,
  }),
}));

import { db, withSystemDbAccessContext } from '../../db';
import { readSdkUsageSnapshot, reserveAiBudget } from '../../services/aiBudgetReservations';
import { priceInvocation } from '../../services/aiModels/pricing';
import type { ResolvedModel } from '../../services/aiModels/resolveModel';
import { resolveSessionTurn } from '../../services/aiModels/sessionModel';
import { turnBindingFrom } from '../../services/aiModels/turnBinding';
import { StreamingSessionManager, type ActiveSession } from '../../services/streamingSessionManager';
import type { AuthContext } from '../../middleware/auth';
import { closeRegistryFixtures } from './aiModelRegistryFixtures';
import { seedRegistryPartner, type SeededRegistryPartner } from './helpers/aiModelRegistrySeed';

const RUN = !!process.env.DATABASE_URL;
afterAll(closeRegistryFixtures);

const savedPlatformKey = process.env.ANTHROPIC_API_KEY;
beforeEach(() => { process.env.ANTHROPIC_API_KEY = 'sk-ant-w03-integration-placeholder'; });
afterAll(() => {
  if (savedPlatformKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedPlatformKey;
});

async function q<R extends Record<string, unknown>>(query: ReturnType<typeof sql>): Promise<R[]> {
  return withSystemDbAccessContext(async () => {
    const result = await db.execute<R>(query);
    return ((result as unknown as { rows?: R[] }).rows ?? (result as unknown as R[]));
  });
}

function result(model: string, cumulative: [number, number], perTurn: [number, number], totalCostUsd = 7.77) {
  return {
    type: 'result', subtype: 'success', stop_reason: 'end_turn', num_turns: 1, total_cost_usd: totalCostUsd,
    usage: { input_tokens: perTurn[0], output_tokens: perTurn[1], cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    modelUsage: { [model]: { inputTokens: cumulative[0], outputTokens: cumulative[1], cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: totalCostUsd } },
  };
}

describe.skipIf(!RUN)('Agent SDK turns settle per-model deltas through the single billing path', () => {
  let s: SeededRegistryPartner;
  let model: ResolvedModel;
  let mgr: StreamingSessionManager;
  let auth: AuthContext;

  beforeEach(async () => {
    fake.turns = [];
    fake.abortAfter = null;
    s = await seedRegistryPartner('platform');
    const turn = await resolveSessionTurn({ sessionId: s.chatSessionId, surface: 'chat', userId: null });
    if (!turn.ok) throw new Error(`resolveSessionTurn: ${turn.reason}`);
    model = turn;
    mgr = new StreamingSessionManager();
    auth = {
      user: { id: s.userId, email: 'tech@example.test', name: 'Tech' }, scope: 'organization', orgId: s.orgId,
      partnerId: s.partnerId, accessibleOrgIds: [s.orgId], orgCondition: () => undefined, canAccessOrg: () => true,
    } as unknown as AuthContext;
  });

  afterEach(() => mgr.shutdown());

  async function reserve(): Promise<string> {
    const r = await reserveAiBudget({
      orgId: s.orgId, billingSource: model.funding, sessionId: s.chatSessionId,
      idempotencyKey: `chat:${s.chatSessionId}:${randomUUID()}`, binding: turnBindingFrom(model),
    });
    if (r.kind === 'denied') throw new Error(r.message);
    return r.reservationId;
  }

  async function open(sdkSessionId: string | null, reservationId: string): Promise<ActiveSession> {
    return mgr.getOrCreate(
      s.chatSessionId,
      { orgId: s.orgId, sdkSessionId, maxTurns: 50, turnCount: 0, systemPrompt: null },
      auth, undefined, 'sys', undefined, model, undefined, undefined,
      { budgetReservationId: reservationId, ledgerUserId: s.userId, injectApprovalModeInstructions: false },
    );
  }

  async function ledger() {
    return q<{ input_tokens: number; output_tokens: number; cost_cents: string; requested_model: string; sdk_reported_cost_usd: string | null }>(sql`
      SELECT input_tokens, output_tokens, cost_cents, requested_model, sdk_reported_cost_usd
      FROM ai_invocations WHERE session_id = ${s.chatSessionId}::uuid ORDER BY created_at, id`);
  }

  async function reservationStatus(id: string): Promise<{ status: string; actual_cost_cents: string | null }> {
    const [row] = await q<{ status: string; actual_cost_cents: string | null }>(sql`
      SELECT status, actual_cost_cents FROM ai_budget_reservations WHERE id = ${id}::uuid`);
    return row!;
  }

  const price = (input: number, output: number) =>
    priceInvocation(model.rateSnapshot, { input, output, cacheRead: 0, cacheWrite: 0 }, {});

  it('two turns on one live query: each bills only its own tokens at the bound rate; rollups and snapshot follow the ledger', async () => {
    const w = model.wireModel;
    fake.turns = [[result(w, [1000, 100], [1000, 100])], [result(w, [2500, 300], [2500, 300])]];
    const r1 = await reserve();
    const session = await open(null, r1);
    expect(mgr.tryTransitionToProcessing(session, r1, { turnBinding: turnBindingFrom(model) })).toBe(true);
    session.inputController.pushMessage('one');
    await vi.waitFor(async () => expect((await reservationStatus(r1)).status).toBe('settled'), { timeout: 10_000 });
    await vi.waitFor(() => expect(session.state).toBe('idle'));

    const r2 = await reserve();
    expect(mgr.tryTransitionToProcessing(session, r2, { turnBinding: turnBindingFrom(model) })).toBe(true);
    session.inputController.pushMessage('two');
    await session.processorPromise;

    const rows = await ledger();
    expect(rows.map((r) => [Number(r.input_tokens), Number(r.output_tokens)])).toEqual([[1000, 100], [1500, 200]]);
    expect(Number(rows[0]!.cost_cents)).toBeCloseTo(price(1000, 100), 6);
    expect(Number(rows[1]!.cost_cents)).toBeCloseTo(price(1500, 200), 6);
    expect(rows.every((r) => r.requested_model === w)).toBe(true);
    expect((await reservationStatus(r2)).status).toBe('settled');
    expect(Number((await reservationStatus(r2)).actual_cost_cents)).toBeCloseTo(price(1500, 200), 6);

    const [sess] = await q<{ c: string; i: number; o: number }>(sql`
      SELECT total_cost_cents AS c, total_input_tokens AS i, total_output_tokens AS o FROM ai_sessions WHERE id = ${s.chatSessionId}::uuid`);
    expect(Number(sess!.c)).toBeCloseTo(price(1000, 100) + price(1500, 200), 6);
    expect([Number(sess!.i), Number(sess!.o)]).toEqual([2500, 300]);
    expect(await readSdkUsageSnapshot({ orgId: s.orgId, sessionId: s.chatSessionId })).toEqual({
      version: 1, models: { [w]: { tokens: { input: 2500, output: 300, cacheRead: 0, cacheWrite: 0 }, webSearchRequests: 0 } },
    });
  });

  it('an aborted turn bills zero and releases its reservation; the resumed query bills its persisted usage once, via the delta', async () => {
    const w = model.wireModel;
    // Turn 1 completes and seeds the snapshot.
    fake.turns = [[result(w, [1000, 100], [1000, 100])]];
    const r1 = await reserve();
    const first = await open(null, r1);
    mgr.tryTransitionToProcessing(first, r1, { turnBinding: turnBindingFrom(model) });
    first.inputController.pushMessage('one');
    await first.processorPromise;

    // Turn 2: the subprocess dies mid-turn after a model call, before any result.
    fake.abortAfter = [{ type: 'assistant', message: { content: [{ type: 'text', text: 'part' }], usage: { input_tokens: 400, output_tokens: 20 } } }];
    const r2 = await reserve();
    const second = await open('sdk-1', r2);
    mgr.tryTransitionToProcessing(second, r2, { turnBinding: turnBindingFrom(model) });
    second.inputController.pushMessage('two');
    await second.processorPromise;
    const afterAbort = await reservationStatus(r2);
    expect(afterAbort.status).toBe('settled');
    expect(Number(afterAbort.actual_cost_cents)).toBe(0);
    expect((await readSdkUsageSnapshot({ orgId: s.orgId, sessionId: s.chatSessionId }))!.models[w]!.tokens)
      .toMatchObject({ input: 1000, output: 100 });

    // Turn 3 resumes; the CLI's cumulative modelUsage includes the aborted call (400/20) plus this turn (300/30).
    fake.abortAfter = null;
    fake.turns = [[result(w, [1700, 150], [300, 30])]];
    const r3 = await reserve();
    const third = await open('sdk-1', r3);
    mgr.tryTransitionToProcessing(third, r3, { turnBinding: turnBindingFrom(model) });
    third.inputController.pushMessage('three');
    await third.processorPromise;

    const billed = (await ledger()).filter((r) => Number(r.input_tokens) > 0 || Number(r.output_tokens) > 0);
    expect(billed.map((r) => [Number(r.input_tokens), Number(r.output_tokens)])).toEqual([[1000, 100], [700, 50]]);
    const [sess] = await q<{ i: number; o: number }>(sql`
      SELECT total_input_tokens AS i, total_output_tokens AS o FROM ai_sessions WHERE id = ${s.chatSessionId}::uuid`);
    expect([Number(sess!.i), Number(sess!.o)]).toEqual([1700, 150]);   // = the CLI's cumulative total: nothing lost, nothing twice
  });
});
