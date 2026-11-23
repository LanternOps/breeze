/**
 * #11965 — a device-troubleshooting run parked `awaiting_approval` settles to
 * `completed` once every step it proposed is final.
 *
 * A troubleshooting run that proposes steps finishes `awaiting_approval`
 * (runLoop.ts `finishRun`): the agent is done and a person owns each step.
 * Nothing moved the run after that, so its status said "waiting" long after
 * every step was decided and run, and a `run_settled` check-in or a later
 * agent read it as still waiting.
 *
 * Settled = no step of the run is OPEN: none is `pending_approval` (waiting
 * for a person), `approved` (decided, not yet released) or `executing`. Every
 * step is then `completed`, `failed`, `rejected`, `expired` or `cancelled`, so
 * the step results exist when the run reads `completed`. A run whose steps
 * were all denied or expired is `completed` too: the agent's work is over,
 * and the steps say how each one ended (no stored tally: derived from
 * `action_intents`).
 *
 * Scope: `device_troubleshooting` runs with no AI Operator task. Other
 * profiles and task-linked runs keep `awaiting_approval` as their terminal
 * state; their readers (task outbox ordering, onboarding advancers, verdict
 * admission) sequence on it.
 *
 * Exactly once: the run row is locked first (`SELECT … FOR UPDATE`), then the
 * open-step check and the `awaiting_approval → completed` compare-and-set run
 * as later statements. Concurrent settlers queue on the lock and the losers
 * find the status changed. Two steps finalised in overlapping transactions
 * cannot both miss the other: the second to take the lock reads after the
 * first committed. `transitionRunStatus` treats terminal → terminal as no new
 * outcome, so the circuit and the task outbox do not count the run twice.
 *
 * Triggers, each idempotent:
 *   - the intent outbox job for every final step event (`intent_completed`,
 *     `intent_failed`, `intent_rejected`, `intent_expired`,
 *     `intent_cancelled`): every writer that finalises a step writes that row
 *     in its own transaction, so the job runs after the step committed
 *     (jobs/intentReleaseWorker.ts processIntentReleaseJob);
 *   - the Wisp grant reconciler tick (`sweepApprovalParkedRuns`) for a run
 *     every job missed, and for runs parked before this shipped.
 *
 * After a winning settle, outside any DB context, the existing completion
 * delivery runs once: `ai.agent.run.completed` (the check-in fast path; the
 * payload carries `settledAfterApproval` so the Wisp wake does not request a
 * second assessment: each decision already woke it) and the specialist's
 * thread post (`postSpecialistResult`, deduped per run and status, re-swept
 * by the reconciler). The origin chat reads the settled run on its next turn
 * (specialistResultsTurn.ts, keyed per run and status).
 *
 * Settlement never creates, decides or releases a step.
 */
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { actionIntents } from '../../db/schema/actionIntents';
import { aiAgentRuns } from '../../db/schema/aiAgents';
import { publishEvent } from '../eventBus';
import { captureException } from '../sentry';
import { OPEN_STEP_STATUSES } from './runApprovalSteps';
import { transitionRunStatus } from './runService';

const SETTLING_PROFILE = 'device_troubleshooting';
/** Parked runs one reconciler tick settles at most (oldest first). */
export const APPROVAL_SETTLE_SWEEP_LIMIT = 100;

const openStepList = sql.join(OPEN_STEP_STATUSES.map((s) => sql`${s}`), sql`, `);

/**
 * True while any step of the run is open. Correlated on the outer
 * `ai_agent_runs` row: a step is the run's when it names the run as its
 * requester or the run lists it in `intent_ids`.
 */
const NO_OPEN_STEP = sql`NOT EXISTS (
  SELECT 1 FROM ${actionIntents} ai
  WHERE (ai.requesting_agent_run_id = ${aiAgentRuns.id} OR ai.id = ANY(${aiAgentRuns.intentIds}))
    AND ai.status IN (${openStepList})
)`;

const settlesHere = and(
  eq(aiAgentRuns.status, 'awaiting_approval'),
  eq(aiAgentRuns.profile, SETTLING_PROFILE),
  isNull(aiAgentRuns.taskId),
);

const systemContext = <T>(fn: () => Promise<T>): Promise<T> =>
  runOutsideDbContext(() => withSystemDbAccessContext(fn));

/**
 * The transition alone, in the caller's transaction. Must run in system DB
 * scope (it nests into the caller's). No side effects: the caller runs the
 * delivery once its transaction has committed. Exported for the concurrency
 * test; production goes through `settleApprovalParkedRun`.
 */
export async function settleApprovalParkedRunLocked(runId: string): Promise<boolean> {
  const locked = await db
    .select({ id: aiAgentRuns.id })
    .from(aiAgentRuns)
    .where(and(eq(aiAgentRuns.id, runId), settlesHere))
    .limit(1)
    .for('update');
  if (locked.length === 0) return false;
  return transitionRunStatus(runId, 'awaiting_approval', 'completed', {}, and(settlesHere, NO_OPEN_STEP));
}

/**
 * Settle the run if it is parked and none of its steps is open, then deliver
 * the completion. Returns true only for the one caller whose transition won.
 * Throws on a DB failure of the settle itself; a delivery failure is reported
 * and swallowed (the check-in tick, the chat turn read and the reconciler's
 * post re-sweep all read the row, not the event).
 */
export async function settleApprovalParkedRun(runId: string): Promise<boolean> {
  const won = await systemContext(() => settleApprovalParkedRunLocked(runId));
  if (won) await deliverSettlement(runId);
  return won;
}

/** The run a step belongs to, then `settleApprovalParkedRun`. False when the step names no run. */
export async function settleApprovalParkedRunForIntent(intentId: string): Promise<boolean> {
  const [intent] = await systemContext(() => db
    .select({ runId: actionIntents.requestingAgentRunId })
    .from(actionIntents)
    .where(eq(actionIntents.id, intentId))
    .limit(1));
  if (!intent?.runId) return false;
  return settleApprovalParkedRun(intent.runId);
}

export type ApprovalSettleSweepResult = { scanned: number; settled: number; failed: number };

/**
 * The reconciler's backstop: every parked troubleshooting run with no open
 * step, oldest first, regardless of grant state or age. One run failing does
 * not stop the rest.
 */
export async function sweepApprovalParkedRuns(
  limit: number = APPROVAL_SETTLE_SWEEP_LIMIT,
): Promise<ApprovalSettleSweepResult> {
  const candidates = await systemContext(() => db
    .select({ id: aiAgentRuns.id })
    .from(aiAgentRuns)
    .where(and(settlesHere, NO_OPEN_STEP))
    .orderBy(asc(aiAgentRuns.finishedAt), asc(aiAgentRuns.id))
    .limit(limit));
  const result: ApprovalSettleSweepResult = { scanned: candidates.length, settled: 0, failed: 0 };
  for (const { id } of candidates) {
    try {
      if (await settleApprovalParkedRun(id)) result.settled += 1;
    } catch (error) {
      result.failed += 1;
      console.error('[aiAgents] settling a parked run failed; the next tick retries it', { runId: id, error });
      captureException(error instanceof Error ? error : new Error(String(error)), undefined, {
        op: 'aiAgents.approvalSettlement.sweep', runId: id,
      });
    }
  }
  return result;
}

async function deliverSettlement(runId: string): Promise<void> {
  try {
    const [run] = await systemContext(() => db
      .select({
        orgId: aiAgentRuns.orgId,
        agentId: aiAgentRuns.agentId,
        deviceId: aiAgentRuns.deviceId,
        intentIds: aiAgentRuns.intentIds,
        costCents: aiAgentRuns.costCents,
      })
      .from(aiAgentRuns)
      .where(and(eq(aiAgentRuns.id, runId), inArray(aiAgentRuns.status, ['completed'])))
      .limit(1));
    if (run) {
      // The payload finishRun publishes, plus the marker the Wisp wake reads.
      await publishEvent('ai.agent.run.completed', run.orgId, {
        runId,
        agentId: run.agentId,
        deviceId: run.deviceId,
        intentIds: run.intentIds,
        costCents: run.costCents,
        settledAfterApproval: true,
      }, 'ai-agent-runner');
    }
  } catch (error) {
    console.error('[aiAgents] settled run: completed event failed; the check-in tick reads the row', { runId, error });
    captureException(error instanceof Error ? error : new Error(String(error)), undefined, {
      op: 'aiAgents.approvalSettlement.publish', runId,
    });
  }

  try {
    const { postSpecialistResult } = await import('../wisp/specialistResult');
    await postSpecialistResult(runId);
  } catch (error) {
    console.error('[aiAgents] settled run: specialist post failed; the grant reconciler re-sweeps it', { runId, error });
    captureException(error instanceof Error ? error : new Error(String(error)), undefined, {
      op: 'aiAgents.approvalSettlement.post', runId,
    });
  }
}
