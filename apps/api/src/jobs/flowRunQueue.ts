/**
 * Tool catalog W04 (#5219) — the `flow-runs` queue handle and its producer.
 *
 * One job = one run SLICE (plan Task A8). The job is a typed reference
 * (`{ runId }`, `flowRunJobDataSchema`); the runner re-reads the run row and
 * owns every state decision. Producers: the terminal-intent wake
 * (services/flows/wake.ts), and — from Task A8/A9 — run creation, timed waits
 * and the reconciler. The worker (`processFlowRunJob`) is registered in Task
 * A8; until then nothing consumes this queue, and a wake only parks a job here.
 *
 * Its own leaf module (the m365SyncQueue.ts precedent) so producers never
 * import the worker and the worker never imports its producers' callers.
 */
import type { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { flowRuns } from '../db/schema/flowRuns';
import { createInstrumentedQueue } from '../services/bullmqQueue';
import { bullmqJobId, enqueueOrReplaceStale } from '../services/bullmqUtils';
import type { FlowRunJobData } from './queueSchemas';

export const FLOW_RUNS_QUEUE = 'flow-runs';
export const FLOW_RUN_SLICE_JOB_NAME = 'flow-run-slice';

const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled', 'expired']);

let queue: Queue<FlowRunJobData> | null = null;

export function getFlowRunQueue(): Queue<FlowRunJobData> {
  if (!queue) {
    // The #1105 held-context tripwire: a slice must never be enqueued from
    // inside an open transaction (wake.ts defers to after commit).
    queue = createInstrumentedQueue<FlowRunJobData>(FLOW_RUNS_QUEUE);
  }
  return queue;
}

export async function closeFlowRunQueue(): Promise<void> {
  if (queue) {
    await queue.close();
    queue = null;
  }
}

/**
 * The job id of the slice that will run the run's CURRENT `resume_seq`. Every
 * park (approval, timed wait) bumps `resume_seq`, so each resume gets a fresh
 * id; duplicate wakes for the same resume collapse onto one job.
 */
export function flowRunSliceJobId(runId: string, resumeSeq: number): string {
  return bullmqJobId('flow-run', runId, resumeSeq);
}

/**
 * Enqueue a slice for `runId`, keyed by the run's committed `resume_seq`.
 * Returns the job id, or null when there is nothing to run (the run is gone
 * or already terminal — the claim and the disable path terminalize runs and
 * still wake them, which is harmless). `enqueueOrReplaceStale` reuses a
 * pending job under the same id and replaces a spent (completed/failed) one,
 * so a spurious earlier wake can never swallow the real one.
 */
export async function enqueueFlowRunSlice(runId: string, opts: { delayMs?: number } = {}): Promise<string | null> {
  const [run] = await runOutsideDbContext(() =>
    withSystemDbAccessContext(
      () => db
        .select({ status: flowRuns.status, resumeSeq: flowRuns.resumeSeq })
        .from(flowRuns)
        .where(eq(flowRuns.id, runId))
        .limit(1),
      'flowRunQueue.enqueueFlowRunSlice',
    ),
  );
  if (!run || TERMINAL_RUN_STATUSES.has(run.status)) return null;

  const { id } = await enqueueOrReplaceStale(
    getFlowRunQueue() as unknown as Queue,
    FLOW_RUN_SLICE_JOB_NAME,
    flowRunSliceJobId(runId, run.resumeSeq),
    { runId } satisfies FlowRunJobData,
    {
      removeOnComplete: { count: 200 },
      removeOnFail: { count: 500 },
      ...(opts.delayMs !== undefined && opts.delayMs > 0 ? { delay: opts.delayMs } : {}),
    },
    '[FlowRunQueue]',
  );
  return id;
}
