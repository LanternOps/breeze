import { and, eq, gt, sql } from 'drizzle-orm';
import { db } from '../../db';
import { actionIntents } from '../../db/schema/actionIntents';
import { aiScriptLaneState } from '../../db/schema/aiScriptLaneState';
import { devices } from '../../db/schema/devices';

/**
 * Unattended script lane (W04, #5612): the handful of reads and the one lock
 * the evaluator and the release revalidation share. Every function runs on
 * the executor it is handed — the ambient `db` inside `createActionIntent`'s
 * transaction (an AsyncLocalStorage-bound handle, so `db` IS the tx there),
 * or the release worker's system context — and never escalates.
 */
export type LaneExecutor = Pick<typeof db, 'select' | 'execute'>;

/**
 * Per-ORG advisory xact lock, serializing concurrent lane admissions for the
 * same org so the hourly cap cannot overshoot under a race. Released
 * automatically on commit/rollback of the caller's transaction — no unlock
 * call. Same idiom as the exposure cap (`policyDecide.ts`); the key is
 * BOUND as a parameter, never interpolated.
 */
export async function lockScriptLane(tx: LaneExecutor, orgId: string): Promise<void> {
  const key = `ai-script-lane:${orgId}`;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

export async function readLaneState(
  tx: LaneExecutor,
  orgId: string,
): Promise<{ state: 'closed' | 'open'; openedReason: string | null } | null> {
  const [row] = await tx
    .select({ state: aiScriptLaneState.state, openedReason: aiScriptLaneState.openedReason })
    .from(aiScriptLaneState)
    .where(eq(aiScriptLaneState.orgId, orgId))
    .limit(1);
  return row ?? null;
}

/**
 * `script_reviewer` intents created for this org in the last hour, INCLUDING
 * pending and undispatched ones (spec §4.6 invariant 12). Counting only
 * executed runs would let N concurrent admissions all see zero and blow the
 * cap — the reservation must cover the window between admission and effect.
 */
export async function countRecentLaneIntents(tx: LaneExecutor, orgId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(actionIntents)
    .where(and(
      eq(actionIntents.orgId, orgId),
      eq(actionIntents.decidedVia, 'script_reviewer'),
      gt(actionIntents.createdAt, sql`now() - interval '1 hour'`),
    ))
    .limit(1);
  return row?.n ?? 0;
}

/**
 * Lane admissions this AGENT RUN has already taken — the per-run action cap
 * (`limits.maxActionsPerRun`) counted from durable rows rather than the run
 * loop's in-memory `ActReservationState`, which does not reach
 * `createActionIntent`.
 */
export async function countRunLaneIntents(tx: LaneExecutor, agentRunId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(actionIntents)
    .where(and(
      eq(actionIntents.requestingAgentRunId, agentRunId),
      eq(actionIntents.decidedVia, 'script_reviewer'),
    ))
    .limit(1);
  return row?.n ?? 0;
}

export async function readLaneDevice(
  tx: LaneExecutor,
  deviceId: string,
  orgId: string,
): Promise<{ id: string; status: string; osType: string; siteId: string | null } | null> {
  const [row] = await tx
    .select({ id: devices.id, status: devices.status, osType: devices.osType, siteId: devices.siteId })
    .from(devices)
    .where(and(eq(devices.id, deviceId), eq(devices.orgId, orgId)))
    .limit(1);
  return row ?? null;
}
