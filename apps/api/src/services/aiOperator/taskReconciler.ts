/**
 * The AI Operator recovery scans (#5205 W06), spec §6.3.
 *
 * "A reconciler queries live task dependencies and authoritative source rows
 * after missed/duplicate/out-of-order delivery, recovering with the same
 * stable wakeup identity." Four sets, and the reason there are exactly four is
 * that they are the four ways a task can stop making progress:
 *
 *  1. QUEUED PAST ITS ADMISSION WAKE — admitted but never picked up.
 *  2. WAITING PAST `next_wake_at` — its event wake was lost (Redis down, a
 *     publisher crash, a consumer that failed after acknowledging).
 *  3. RUNNING PAST `lease_expires_at` — the coordinator holding it died.
 *  4. TERMINAL WITH AN UNSETTLED OPERATION — the task closed while a device
 *     command was still outstanding. Spec §6.3: "task closure cannot hide a
 *     late result."
 *
 * IT RE-DERIVES FROM SOURCE ROWS, NEVER FROM THE OUTBOX. The outbox is a
 * delivery mechanism; an unpublished row proves only that a message was not
 * sent, not what the truth is. Sets 1-3 re-enter `advanceTask`, which reads
 * the operation, the intent and the device command itself. Set 4 reads the
 * operation and the device command directly.
 *
 * IT NEVER RESTARTS A MUTATION. Set 4 can only settle an operation or hand the
 * task off with `unknown_effect`; there is no branch anywhere in this file that
 * dispatches anything. Spec §6.5: "an effect with lost acknowledgement,
 * timeout, or unknown result requires authoritative reconciliation; if its
 * absence cannot be proved and the provider lacks idempotency, hand off."
 *
 * IT KEEPS RUNNING WHEN THE FEATURE IS OFF. `aiOperatorTasksEnabled()` gates
 * ADMISSION (in `taskService.ts` and `admitReasoningRun`), not this file —
 * spec §11.2 is explicit that the kill switches "fence new admissions and
 * dispatch claims" while "the publisher and reconciler keep running so late
 * results still land". Disabling the feature must never abandon a restart
 * command that is already on a device.
 */

import { and, eq, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import {
  aiOperatorOperations,
  aiOperatorTasks,
} from '../../db/schema/aiOperatorTasks';
import { advanceTask, claimTaskLease } from './taskCoordinator';
import {
  classifyDeviceCommandEvidence,
  readDeviceCommandEvidence,
} from './deviceCommandEvidence';
import { recordOperationResult } from './operationService';
import {
  recordAiOperatorReconcilerScan,
  recordAiOperatorTaskStates,
  recordAiOperatorWaitingAgeMax,
  type ReconcilerScanSet,
} from '../aiOperatorCoordinatorMetrics';
import { parseTaskCheckpoint } from './taskService';

/**
 * A NOTE ON EVERY `${...}` BELOW THAT CARRIES A TIMESTAMP.
 *
 * Each one is `${date.toISOString()}::timestamptz`, never a bare `${date}`.
 * A `Date` interpolated into a raw drizzle `sql` fragment is bound as a
 * parameter that postgres.js then tries to serialise as a string, and it
 * throws `TypeError: The "string" argument must be of type string or an
 * instance of Buffer or ArrayBuffer. Received an instance of Date` at bind
 * time — BEFORE the statement ever reaches Postgres. Nothing catches this at
 * compile time and nothing catches it in a mocked test, because the generated
 * SQL is correct; only a real connection fails. (Confirmed here: the first
 * version of this file threw exactly that on all four scans, and
 * `aiOperatorRecovery.integration.test.ts` is what found it.)
 *
 * The explicit `::timestamptz` cast is not decoration either: a bare text
 * parameter compared against a `timestamptz` column can defeat the partial
 * index's predicate proof, which would quietly turn these bounded scans into
 * sequential ones under forced RLS.
 */

/** Rows claimed per set per pass (spec §11.2's proposed 50). */
export const RECONCILER_SCAN_LIMIT = 50;

/**
 * Grace before a `queued` task is treated as stranded.
 *
 * Not a retry delay — a task admitted milliseconds ago is legitimately queued,
 * and picking it up in the same pass that admitted it would race the admitting
 * transaction's own commit. One lease period is the natural bound: anything
 * that was going to claim it has had a full lease to do so.
 */
export const QUEUED_GRACE_MS = 60_000;

/**
 * How long a terminal task's unsettled operation is chased before it is
 * force-settled `unknown`.
 *
 * Without this, set 4 re-selects the same row every 15 seconds forever — a
 * livelock, not a scan. Past this horizon the operation is written `unknown`
 * (via the rank-guarded `recordOperationResult`, so a genuine late result can
 * still overwrite it: `unknown` ranks BELOW `succeeded`/`failed`), which drops
 * it out of the set while leaving it reconcilable.
 */
export const UNSETTLED_CHASE_HORIZON_MS = 24 * 60 * 60 * 1000;

export interface ReconcilerPassResult {
  queuedPastWake: number;
  waitingPastWake: number;
  runningPastLease: number;
  terminalUnsettled: number;
}

/**
 * One reconciler pass. Called from the coordinator's 15 s tick.
 *
 * Each set is claimed with `FOR UPDATE SKIP LOCKED` so two API pods running
 * this concurrently divide the work instead of colliding, and each is bounded
 * so one enormous backlog cannot make a pass unbounded.
 */
export async function runReconcilerPass(now: Date = new Date()): Promise<ReconcilerPassResult> {
  const result: ReconcilerPassResult = {
    queuedPastWake: 0,
    waitingPastWake: 0,
    runningPastLease: 0,
    terminalUnsettled: 0,
  };

  result.queuedPastWake = await advanceScanSet('queued_past_wake', await selectQueuedPastWake(now));
  result.waitingPastWake = await advanceScanSet('waiting_past_wake', await selectWaitingPastWake(now));
  result.runningPastLease = await advanceScanSet('running_past_lease', await selectRunningPastLease(now));
  result.terminalUnsettled = await settleTerminalUnsettled(now);

  await publishCensus(now);
  return result;
}

type TaskRef = { id: string; orgId: string };

/**
 * SET 1 — queued past its admission wake.
 *
 * INDEX: served by `ai_operator_tasks_queued_wake_idx`
 * (`(next_wake_at) WHERE state = 'queued'`), added by this wave's migration.
 * The shipped `ai_operator_tasks_wake_idx` is partial on `state = 'waiting'`
 * and cannot serve this, and `ai_operator_tasks_org_state_updated_idx` leads
 * with `org_id`, which a cross-org sweep does not have. Confirmed by the
 * 2026-09-08 quorum.
 *
 * `state = 'queued'` is written as a VERBATIM literal, not an interpolated
 * parameter: under forced RLS as `breeze_app`, the partial-index predicate
 * proof is static, so an `${value}` bind the planner cannot see would silently
 * demote this to a sequential scan.
 */
async function selectQueuedPastWake(now: Date): Promise<TaskRef[]> {
  return claimRefs(sql`
    SELECT id, org_id FROM ai_operator_tasks
    WHERE state = 'queued'
      AND (next_wake_at IS NULL OR next_wake_at <= ${now.toISOString()}::timestamptz)
      AND updated_at < ${new Date(now.getTime() - QUEUED_GRACE_MS).toISOString()}::timestamptz
    ORDER BY next_wake_at NULLS FIRST
    LIMIT ${RECONCILER_SCAN_LIMIT}
    FOR UPDATE SKIP LOCKED
  `);
}

/**
 * SET 2 — waiting past `next_wake_at`.
 *
 * INDEX: the shipped `ai_operator_tasks_wake_idx`
 * (`(next_wake_at) WHERE state = 'waiting'`) serves this exactly, which is
 * what it was created for. Same verbatim-literal rule as set 1.
 */
async function selectWaitingPastWake(now: Date): Promise<TaskRef[]> {
  return claimRefs(sql`
    SELECT id, org_id FROM ai_operator_tasks
    WHERE state = 'waiting'
      AND next_wake_at IS NOT NULL
      AND next_wake_at <= ${now.toISOString()}::timestamptz
    ORDER BY next_wake_at
    LIMIT ${RECONCILER_SCAN_LIMIT}
    FOR UPDATE SKIP LOCKED
  `);
}

/**
 * SET 3 — running (or stopping) past its lease.
 *
 * INDEX: the shipped `ai_operator_tasks_lease_idx`
 * (`(lease_expires_at) WHERE state IN ('running','stopping')`). The query
 * restates that `IN` list verbatim so the predicate proof matches: `IN` on a
 * `text` column expands to `texteq` ORs, which ARE leakproof and therefore
 * promotable to index conditions under RLS — unlike the enum equality this
 * column deliberately is not (spec §11.1).
 */
async function selectRunningPastLease(now: Date): Promise<TaskRef[]> {
  return claimRefs(sql`
    SELECT id, org_id FROM ai_operator_tasks
    WHERE state IN ('running', 'stopping')
      AND lease_expires_at IS NOT NULL
      AND lease_expires_at <= ${now.toISOString()}::timestamptz
    ORDER BY lease_expires_at
    LIMIT ${RECONCILER_SCAN_LIMIT}
    FOR UPDATE SKIP LOCKED
  `);
}

async function claimRefs(query: ReturnType<typeof sql>): Promise<TaskRef[]> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const raw = await db.execute(query);
      const rows = ((raw as { rows?: unknown[] }).rows ?? (raw as unknown[])) as Array<{
        id: string; org_id: string;
      }>;
      return Array.isArray(rows) ? rows.map((r) => ({ id: r.id, orgId: r.org_id })) : [];
    }));
}

/**
 * Re-enter the coordinator for each claimed row.
 *
 * `requireWakeDue: true` — this is the POLL path, and the select above already
 * proved the row is due. Passing `false` here would let the reconciler claim a
 * `waiting` task whose wake is still in the future, defeating the wait.
 *
 * Each task is advanced independently and a failure on one never aborts the
 * pass: a single task with a corrupt checkpoint must not stop the reconciler
 * from recovering the other forty-nine.
 */
async function advanceScanSet(scan: ReconcilerScanSet, refs: TaskRef[]): Promise<number> {
  recordAiOperatorReconcilerScan(scan, refs.length);
  let advanced = 0;
  for (const ref of refs) {
    try {
      const claim = await claimTaskLease({
        orgId: ref.orgId, taskId: ref.id, requireWakeDue: true,
      });
      if (!claim.won) continue;
      await advanceTask(claim.task, claim.leaseEpoch);
      advanced += 1;
    } catch (error) {
      console.error('[aiOperatorReconciler] failed to advance task', {
        scan, taskId: ref.id, orgId: ref.orgId, error,
      });
    }
  }
  return advanced;
}

/**
 * SET 4 — terminal tasks with an unsettled operation.
 *
 * DRIVEN FROM THE OPERATIONS TABLE, not from the tasks table (quorum finding
 * Q2b). Scanning every terminal task and testing `EXISTS (…)` per row is an
 * unbounded, ever-growing sequential scan: terminal tasks accumulate forever
 * and the overwhelming majority have nothing outstanding. The unsettled
 * operations, by contrast, are a small and self-draining set, and the wave's
 * migration adds `ai_operator_operations_unsettled_idx`
 * (`(updated_at) WHERE result_state IN ('pending','unknown') AND
 * execution_ref_id IS NOT NULL`) to serve exactly this shape.
 *
 * This set NEVER re-dispatches. It reads the device command through the
 * authorized adapter and either records the real result or, past the chase
 * horizon, force-settles `unknown` so the row stops being re-selected. Because
 * `recordOperationResult` is rank-guarded (`unknown` ranks below
 * `succeeded`/`failed`), a genuine late agent result still overwrites that
 * `unknown` whenever it eventually lands — which is the whole reason the
 * result lives on the operation row and not on the terminal intent
 * (baseline §4).
 */
async function settleTerminalUnsettled(now: Date): Promise<number> {
  const rows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const raw = await db.execute(sql`
        SELECT o.id, o.org_id, o.intent_id, o.execution_ref_id, o.updated_at, t.id AS task_id
        FROM ai_operator_operations o
        JOIN ai_operator_tasks t ON t.id = o.task_id AND t.org_id = o.org_id
        WHERE o.result_state IN ('pending', 'unknown')
          AND o.execution_ref_id IS NOT NULL
          AND o.execution_ref_kind = 'device_command'
          AND t.state IN ('completed', 'partial', 'handed_off', 'cancelled', 'failed', 'expired')
        ORDER BY o.updated_at
        LIMIT ${RECONCILER_SCAN_LIMIT}
        FOR UPDATE OF o SKIP LOCKED
      `);
      const list = ((raw as { rows?: unknown[] }).rows ?? (raw as unknown[])) as Array<{
        id: string; org_id: string; intent_id: string | null;
        execution_ref_id: string; updated_at: Date; task_id: string;
      }>;
      return Array.isArray(list) ? list : [];
    }));

  recordAiOperatorReconcilerScan('terminal_unsettled_operation', rows.length);

  let settled = 0;
  for (const row of rows) {
    try {
      if (!row.intent_id) continue; // `recordOperationResult` is keyed by intent.

      const checkpointDeviceId = await readTaskDeviceId(row.org_id, row.task_id);
      if (!checkpointDeviceId) continue;

      const read = await readDeviceCommandEvidence({
        orgId: row.org_id,
        deviceId: checkpointDeviceId,
        commandId: row.execution_ref_id,
      });

      if (read.ok) {
        const classified = classifyDeviceCommandEvidence(read.evidence);
        if (classified.state === 'finished') {
          await recordOperationResult({
            intentId: row.intent_id,
            resultState: classified.outcome === 'succeeded' ? 'succeeded' : 'failed',
            result: { source: 'reconciler', status: read.evidence.resultStatus ?? read.evidence.status },
          });
          settled += 1;
          continue;
        }
      }

      const ageMs = now.getTime() - new Date(row.updated_at).getTime();
      if (ageMs > UNSETTLED_CHASE_HORIZON_MS) {
        await recordOperationResult({
          intentId: row.intent_id,
          resultState: 'unknown',
          result: {
            source: 'reconciler',
            reason: read.ok ? 'never_settled_within_chase_horizon' : read.reason,
          },
        });
        settled += 1;
      }
    } catch (error) {
      console.error('[aiOperatorReconciler] failed to settle operation', {
        operationId: row.id, orgId: row.org_id, error,
      });
    }
  }
  return settled;
}

async function readTaskDeviceId(orgId: string, taskId: string): Promise<string | null> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const [row] = await db
        .select({ deviceId: aiOperatorTasks.deviceId, checkpoint: aiOperatorTasks.checkpoint })
        .from(aiOperatorTasks)
        .where(and(eq(aiOperatorTasks.id, taskId), eq(aiOperatorTasks.orgId, orgId)))
        .limit(1);
      if (!row) return null;
      // `device_id` is `ON DELETE SET NULL` and is cleared on a target detach,
      // so the frozen checkpoint is the fallback — the evidence read still
      // authorizes against the org, and a device that left the org fails there
      // rather than here.
      return row.deviceId ?? parseTaskCheckpoint(row.checkpoint)?.recipeInput.deviceId ?? null;
    }));
}

/**
 * Publish the §11.2 census gauges.
 *
 * Live states only. Terminal states grow without bound and are a list query's
 * job, not a scrape's — and a gauge that only ever climbs is not a health
 * signal.
 */
async function publishCensus(now: Date): Promise<void> {
  try {
    await runOutsideDbContext(() =>
      withSystemDbAccessContext(async () => {
        const raw = await db.execute(sql`
          SELECT state, count(*)::int AS n,
                 max(EXTRACT(EPOCH FROM (${now.toISOString()}::timestamptz - updated_at)))::int AS oldest_age_seconds
          FROM ai_operator_tasks
          WHERE state IN ('queued', 'running', 'waiting', 'paused', 'stopping')
          GROUP BY state
        `);
        const rows = ((raw as { rows?: unknown[] }).rows ?? (raw as unknown[])) as Array<{
          state: string; n: number; oldest_age_seconds: number | null;
        }>;
        const counts: Record<string, number> = {};
        let waitingAge = 0;
        for (const row of rows ?? []) {
          counts[row.state] = row.n;
          if (row.state === 'waiting') waitingAge = row.oldest_age_seconds ?? 0;
        }
        recordAiOperatorTaskStates(counts);
        recordAiOperatorWaitingAgeMax(waitingAge);
      }));
  } catch (error) {
    // Metrics must never break reconciliation.
    console.error('[aiOperatorReconciler] census failed (non-fatal)', { error });
  }
}
