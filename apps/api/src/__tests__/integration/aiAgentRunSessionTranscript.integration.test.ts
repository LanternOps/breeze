/**
 * #11971: an agent run's own `ai_sessions` row used to carry 0 messages and
 * 0 tokens while the run recorded turns and cost. Against real Postgres this
 * proves the two halves of the fix the unit suites can only mock: the run's
 * hop settles onto its session through the one billing path (session totals =
 * the ledger rows = the run's cost), and the transcript rows land on the
 * session in turn order, inputs redacted.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { db, withSystemDbAccessContext } from '../../db';
import { reserveAiBudget } from '../../services/aiBudgetReservations';
import { resolveModel } from '../../services/aiModels/resolveModel';
import { settleInvocation } from '../../services/aiModels/settleInvocation';
import { turnBindingFrom, type TurnBinding } from '../../services/aiModels/turnBinding';
import { agentRunReservationBaseKey, hopReservationSessionId } from '../../services/aiAgents/agentRunFailover';
import { createAgentRunSession, recordRunAssistantTurn, recordRunTaskPrompt } from '../../services/aiAgents/executionLedger';
import { closeRegistryFixtures, fixtureSql, seedAgent } from './aiModelRegistryFixtures';
import { seedRegistryPartner, type SeededRegistryPartner } from './helpers/aiModelRegistrySeed';

const RUN = !!process.env.DATABASE_URL;
afterAll(closeRegistryFixtures);

const savedPlatformKey = process.env.ANTHROPIC_API_KEY;
beforeEach(() => { process.env.ANTHROPIC_API_KEY = 'sk-ant-11971-integration-placeholder'; });
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

async function seedRunWithSession(s: SeededRegistryPartner): Promise<{ runId: string; sessionId: string }> {
  const agentId = await seedAgent({ orgId: s.orgId, createdBy: s.userId });
  const [row] = await fixtureSql`
    INSERT INTO ai_agent_runs (agent_id, org_id, trigger_kind, dedupe_key, mode_at_start, policy_snapshot, status)
    VALUES (${agentId}, ${s.orgId}, 'manual', ${`11971-${randomUUID()}`}, 'act', '{}'::jsonb, 'running')
    RETURNING id`;
  const runId = String(row!.id);
  const sessionId = await createAgentRunSession({
    runId, agentId, orgId: s.orgId, deviceId: null, model: 'model-x', maxTurns: 10,
  });
  return { runId, sessionId };
}

describe.skipIf(!RUN)('#11971 an agent run\'s session carries its usage and transcript', () => {
  let s: SeededRegistryPartner;
  let binding: TurnBinding;

  beforeEach(async () => {
    delete process.env.BILLING_SERVICE_URL;
    delete process.env.BILLING_SERVICE_API_KEY;
    s = await seedRegistryPartner('platform');
    const r = await resolveModel({ partnerId: s.partnerId, orgId: s.orgId, surface: 'ai_agents' });
    if (!r.ok) throw new Error(`resolveModel: ${r.reason}`);
    binding = turnBindingFrom(r);
  });

  it('a hop settled on the run\'s session gives the session the run\'s tokens, cost and turns', async () => {
    const { runId, sessionId } = await seedRunWithSession(s);
    const key = agentRunReservationBaseKey(runId);
    expect(await hopReservationSessionId({ orgId: s.orgId, idempotencyKey: key })).toBeUndefined();

    const res = await reserveAiBudget({ orgId: s.orgId, billingSource: binding.funding, idempotencyKey: key, sessionId, binding });
    if (res.kind === 'denied') throw new Error(res.message);
    expect(await hopReservationSessionId({ orgId: s.orgId, idempotencyKey: key })).toBe(sessionId);

    const tokens = { input: 3_000, output: 900, cacheRead: 40_000, cacheWrite: 1_200 };
    const settled = await settleInvocation({
      binding, orgId: s.orgId, userId: null, sessionId, agentRunId: runId, sourceRef: null,
      usage: [{ model: binding.wireModel, tokens, webSearchRequests: 0, speedServed: 'standard', providerModel: null }],
      outcome: {
        stopReason: 'end_turn', refused: false, refusalCategory: null, fallbackUsed: false,
        servedModel: binding.wireModel, providerModel: null, sdkReportedCostUsd: null, fastDowngraded: false,
      },
      reservationId: res.reservationId, messageCount: 6, turnCount: 6,
    });
    expect(settled.deferred).toBe(false);
    expect(settled.costCents).toBeGreaterThan(0);

    const [session] = await q<{ c: string; i: number; o: number; t: number; type: string }>(sql`
      SELECT total_cost_cents AS c, total_input_tokens AS i, total_output_tokens AS o, turn_count AS t, type
      FROM ai_sessions WHERE id = ${sessionId}::uuid`);
    expect(session).toMatchObject({
      type: 'agent',
      i: tokens.input + tokens.cacheRead + tokens.cacheWrite,
      o: tokens.output,
      t: 6,
    });
    expect(Number(session!.c)).toBeCloseTo(settled.costCents, 6);
    // The ledger row carries both: the run it belongs to and the session it settled on.
    const ledger = await q<{ agent_run_id: string; session_id: string }>(sql`
      SELECT agent_run_id, session_id FROM ai_invocations WHERE agent_run_id = ${runId}::uuid`);
    expect(ledger).toEqual([{ agent_run_id: runId, session_id: sessionId }]);
  });

  it('a hop first claimed sessionless reports that, so a re-drive keeps it sessionless', async () => {
    const { runId } = await seedRunWithSession(s);
    const key = agentRunReservationBaseKey(runId);
    const res = await reserveAiBudget({ orgId: s.orgId, billingSource: binding.funding, idempotencyKey: key, binding });
    if (res.kind === 'denied') throw new Error(res.message);
    expect(await hopReservationSessionId({ orgId: s.orgId, idempotencyKey: key })).toBeNull();
  });

  it('the transcript lands on the session in turn order, tool inputs redacted, no tool output', async () => {
    const { sessionId } = await seedRunWithSession(s);
    await recordRunTaskPrompt(sessionId, 'Investigate the disk alert.');
    await recordRunAssistantTurn(sessionId, {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Reading the device.' },
          { type: 'tool_use', id: 'tu-1', name: 'mcp__breeze__get_device_details', input: { deviceId: 'd-1', password: 'hunter2' } },
          { type: 'tool_use', id: 'tu-2', name: 'mcp__breeze__analyze_disk_usage', input: { deviceId: 'd-1' } },
        ],
        usage: { input_tokens: 500, output_tokens: 40 },
      },
    });
    await recordRunAssistantTurn(sessionId, { type: 'assistant', message: { content: [{ type: 'text', text: 'Disk is fine.' }] } });

    const rows = await q<{ role: string; content: string | null; tool_name: string | null; tool_input: unknown; tool_use_id: string | null; tool_output: unknown }>(sql`
      SELECT role, content, tool_name, tool_input, tool_use_id, tool_output FROM ai_messages
      WHERE session_id = ${sessionId}::uuid ORDER BY created_at, id`);
    expect(rows.map((r) => [r.role, r.content ?? r.tool_name])).toEqual([
      ['user', 'Investigate the disk alert.'],
      ['assistant', 'Reading the device.'],
      ['tool_use', 'get_device_details'],
      ['tool_use', 'analyze_disk_usage'],
      ['assistant', 'Disk is fine.'],
    ]);
    expect(rows[2]!.tool_use_id).toBe('tu-1');
    expect(JSON.stringify(rows)).not.toContain('hunter2');
    expect(rows.every((r) => r.tool_output === null)).toBe(true);
  });
});
