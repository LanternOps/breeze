/**
 * Tool catalog W04 (#5219), plan Task A8 / Decision 15 — the durable run
 * lease and the fenced checkpoint.
 *
 * `executeTool` takes no AbortSignal, so a step that outlives its timeout, or
 * a slice that BullMQ redelivered after a stall, cannot be stopped. What it
 * CAN be stopped from is writing: every run write goes through `checkpoint`,
 * whose FIRST statement is the run UPDATE fenced on `lease_token = $token AND
 * status NOT IN (terminal)`. Zero rows ⇒ nothing else is written and the
 * slice ends silently — the lease moved to another slice, or an outside
 * writer (disable, org merge, a refused dispatch claim) already finished the
 * run. `flow_run_steps` has no lease column; it is fenced by that run row in
 * the same transaction.
 *
 * A step may run up to 3,600 s, far past the 6-minute lease, so the slice
 * renews it with `startLeaseHeartbeat` while the step executes; a failed
 * renewal marks the slice lost and its result is never written.
 *
 * Every write is its own short SYSTEM transaction opened outside any ambient
 * context (the runner is a background job; explicit predicates are the only
 * fence — runStore.ts).
 */
import { FLOW_RUN_LIMITS, type FlowRunStatus } from '@breeze/shared';
import { runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import type { FlowRunStepRow, NewFlowRunStepRow } from '../../db/schema/flowRuns';
import { isPgUniqueViolation } from '../../utils/pgErrors';
import * as store from './runStore';

/** What a checkpoint may write on the run. Identity, provenance and the lease pair are not patchable. */
export type FlowRunCheckpointPatch = store.FlowRunPatchColumns;

export interface FlowRunCheckpointStep {
  insert?: NewFlowRunStepRow;
  update?: { id: string; values: Partial<FlowRunStepRow> };
  /** Further step-row updates in the same transaction (closing a parked row while recording a new attempt, …). */
  updates?: Array<{ id: string; values: Partial<FlowRunStepRow> }>;
}

export interface FlowRunCheckpointOptions {
  /** Release the lease in the same write (a park). A terminal status always releases it. */
  releaseLease?: boolean;
}

const TERMINAL: ReadonlySet<FlowRunStatus> = new Set(store.TERMINAL_FLOW_RUN_STATUSES);

class CheckpointConflict extends Error {
  constructor() {
    super('flow run checkpoint: step attempt already exists');
    this.name = 'CheckpointConflict';
  }
}

function inSystemTx<T>(fn: () => Promise<T>, label: string): Promise<T> {
  return runOutsideDbContext(() => withSystemDbAccessContext(fn, label));
}

/** CAS a fresh lease: status ∈ expect and no live lease (on the DB clock). Null ⇒ another slice owns the run. */
export async function acquireRunLease(runId: string, expect: FlowRunStatus[]): Promise<{ token: string } | null> {
  const row = await inSystemTx(() => store.casAcquireLease(runId, expect), 'flows.runLease.acquire');
  return row?.leaseToken ? { token: row.leaseToken } : null;
}

/**
 * One transaction: the fenced run UPDATE first, then the step insert/update(s).
 * Returns false — having written nothing — when the fence matches no row, or
 * when the step insert hits the attempt unique key (another worker owns that
 * attempt; the whole transaction rolls back).
 */
export async function checkpoint(
  runId: string,
  token: string,
  patch: FlowRunCheckpointPatch,
  step?: FlowRunCheckpointStep,
  opts: FlowRunCheckpointOptions = {},
): Promise<boolean> {
  const release = opts.releaseLease === true || (patch.status !== undefined && TERMINAL.has(patch.status));
  try {
    return await inSystemTx(async () => {
      const fenced = await store.fencedRunUpdate(runId, token, patch, release ? 'release' : 'renew');
      if (!fenced) return false;
      if (step?.insert) {
        try {
          await store.insertStepRow(step.insert);
        } catch (err) {
          if (isPgUniqueViolation(err)) throw new CheckpointConflict();
          throw err;
        }
      }
      if (step?.update) await store.updateStepRow(runId, step.update.id, step.update.values);
      for (const u of step?.updates ?? []) await store.updateStepRow(runId, u.id, u.values);
      return true;
    }, 'flows.runLease.checkpoint');
  } catch (err) {
    if (err instanceof CheckpointConflict) return false;
    throw err;
  }
}

/**
 * Renew the lease every `leaseRenewEveryMs` while a step executes. A renewal
 * that matches no row (lease taken over, run finished by an outside writer)
 * or that throws marks the slice lost: the caller must not write the step's
 * result.
 */
export function startLeaseHeartbeat(runId: string, token: string): { stop(): void; lost(): boolean } {
  let lost = false;
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped || lost) return;
    inSystemTx(() => store.renewLease(runId, token), 'flows.runLease.heartbeat')
      .then((ok) => { if (!ok) lost = true; })
      .catch((err: unknown) => {
        lost = true;
        console.warn(`[FlowRunner] lease renewal failed (run=${runId}); the slice is lost`, err);
      });
  }, FLOW_RUN_LIMITS.leaseRenewEveryMs);
  timer.unref?.();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    lost: () => lost,
  };
}

/** Drop the lease if this token still holds it (a slot refusal, a spurious wake). */
export async function releaseRunLease(runId: string, token: string): Promise<void> {
  await inSystemTx(() => store.releaseLease(runId, token), 'flows.runLease.release');
}
