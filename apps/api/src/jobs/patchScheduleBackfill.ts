/**
 * AI patch agent W01 (#5747, OD-9 A) — one-shot, idempotent boot backfill.
 *
 * The enable hook (`agentService.ensureDefaultPatchScheduleSafely`) gives a
 * partner-wide patch agent its default 02:00 schedule the moment it is
 * enabled — but that misses EXACTLY the agents that motivated #5382: ones
 * enabled before this shipped, which have no schedule and so have never run.
 * This pass enumerates every live, enabled, partner-wide patch agent and runs
 * the same `ensureDefaultPatchSchedule` for each.
 *
 * - Runs under its OWN system DB context (`runOutsideDbContext` +
 *   `withSystemDbAccessContext`): a boot-time job with no auth context that
 *   must see every partner.
 * - Each agent in its own SAVEPOINT, so one failure costs only that agent.
 * - Safe to run on every boot and from several replicas at once: the per-agent
 *   advisory lock plus the existing-row check inside `ensureDefaultPatchSchedule`
 *   make a second pass create nothing.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
// Direct module import, not the schema barrel.
import { aiAgents } from '../db/schema/aiAgents';
import { ensureDefaultPatchSchedule } from '../services/aiAgents/scheduleService';
import { captureException } from '../services/sentry';

export interface PatchScheduleBackfillResult {
  scanned: number;
  created: number;
  skipped: number;
  failed: number;
}

export async function backfillDefaultPatchSchedules(): Promise<PatchScheduleBackfillResult> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const agents = await db
      .select({
        id: aiAgents.id,
        kind: aiAgents.kind,
        orgId: aiAgents.orgId,
        partnerId: aiAgents.partnerId,
        enabled: aiAgents.enabled,
        disabledAt: aiAgents.disabledAt,
      })
      .from(aiAgents)
      .where(and(
        eq(aiAgents.kind, 'patch'),
        isNull(aiAgents.orgId),
        isNull(aiAgents.disabledAt),
        eq(aiAgents.enabled, true),
      ));

    const result: PatchScheduleBackfillResult = { scanned: agents.length, created: 0, skipped: 0, failed: 0 };
    for (const agent of agents) {
      try {
        const outcome = await db.transaction(async (tx) => ensureDefaultPatchSchedule(agent, tx));
        if (outcome.created) result.created += 1;
        else result.skipped += 1;
      } catch (error) {
        result.failed += 1;
        console.error('[patchScheduleBackfill] could not create the default patch schedule', { agentId: agent.id, error });
        captureException(error, undefined, { service: 'aiAgents', operation: 'backfillDefaultPatchSchedules', agentId: agent.id });
      }
    }
    if (result.scanned > 0) {
      console.log('[patchScheduleBackfill] default patch schedules', result);
    }
    return result;
  }));
}
