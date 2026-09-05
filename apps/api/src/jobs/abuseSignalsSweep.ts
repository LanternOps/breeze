import { Job, Queue, Worker } from 'bullmq';
import { getBullMQConnection } from '../services/redis';
import { attachWorkerObservability } from './workerObservability';
import { runAbuseSweep, runAbuseDigest } from '../services/abuseSignals';
import { recordAbuseSweepRun } from '../services/abuseMetrics';
import { abuseSignalsEnabled, abuseSignalsExplicitlyDisabled } from '../config/env';
import { captureException } from '../services/sentry';
import { jobSchedule } from './scheduleRegistry';
import { processPartnerTrustJob, schedulePartnerTrustJobs } from './partnerTrustJobs';
import { partnerTrustMode } from '../config/partnerTrustMode';
import { shutdownIpClassifyQueue } from '../services/ipClassify';

const ABUSE_QUEUE = 'abuse-signals';
const SWEEP_JOB = 'abuse-sweep';
const DIGEST_JOB = 'abuse-digest';
// jobIds use hyphens, never colons (BullMQ jobId rule).
const SWEEP_REPEAT_ID = 'abuse-sweep-repeat';
const DIGEST_REPEAT_ID = 'abuse-digest-repeat';
// Hourly/weekly cron slots, not intervals: `every` is epoch-anchored
// (see jobs/scheduleRegistry.ts).
const SWEEP_CRON = jobSchedule('abuse-signals-sweep');
const DIGEST_CRON = jobSchedule('abuse-signals-digest'); // Monday morning

type AbuseJobData = Record<string, never>;

let abuseQueue: Queue<AbuseJobData> | null = null;
let abuseWorker: Worker<AbuseJobData> | null = null;

export function getAbuseSignalsQueue(): Queue<AbuseJobData> {
  if (!abuseQueue) {
    abuseQueue = new Queue<AbuseJobData>(ABUSE_QUEUE, { connection: getBullMQConnection() });
  }
  return abuseQueue;
}

/** Drop this queue's repeatables. Shared by the reschedule path and the disable path. */
async function removeAbuseRepeatables(queue: Queue<AbuseJobData>): Promise<void> {
  const existing = await queue.getRepeatableJobs();
  for (const job of existing) {
    if (job.name === SWEEP_JOB || job.name === DIGEST_JOB) {
      await queue.removeRepeatableByKey(job.key);
    }
  }
}

export async function scheduleAbuseSignalsJobs(): Promise<void> {
  const queue = getAbuseSignalsQueue();
  // Clear prior repeatables so interval/cron changes take effect on redeploy.
  await removeAbuseRepeatables(queue);
  await queue.add(SWEEP_JOB, {}, {
    jobId: SWEEP_REPEAT_ID,
    repeat: { pattern: SWEEP_CRON },
    removeOnComplete: { count: 10 },
    removeOnFail: { count: 25 },
  });
  await queue.add(DIGEST_JOB, {}, {
    jobId: DIGEST_REPEAT_ID,
    repeat: { pattern: DIGEST_CRON },
    removeOnComplete: { count: 5 },
    removeOnFail: { count: 10 },
  });
}

export function createAbuseSignalsWorker(): Worker<AbuseJobData> {
  return new Worker<AbuseJobData>(
    ABUSE_QUEUE,
    async (job: Job<AbuseJobData>) => {
      try {
        if (job.name === SWEEP_JOB) {
          const result = await runAbuseSweep();
          recordAbuseSweepRun('success');
          return result;
        }
        if (job.name === DIGEST_JOB) {
          await runAbuseDigest();
          return {};
        }
        const partnerTrustResult = await processPartnerTrustJob(job);
        if (partnerTrustResult !== undefined) return partnerTrustResult;
        console.warn(`[AbuseSignals] Unknown job name: ${job.name}`);
        return {};
      } catch (error) {
        if (job.name === SWEEP_JOB) {
          recordAbuseSweepRun('error');
        }
        throw error;
      }
    },
    { connection: getBullMQConnection(), concurrency: 1 },
  );
}

/** Render an env var for the disabled log, distinguishing unset from empty. */
function describeEnv(raw: string | undefined): string {
  if (raw === undefined) return '<unset>';
  if (raw.trim() === '') return '<empty>';
  return JSON.stringify(raw);
}

/**
 * Report a teardown failure without rethrowing. Swallowing is deliberate — a
 * Redis blip must not fail worker init (and so pin /ready to not-ready) over a
 * subsystem this deployment has switched OFF. But it is reported at the same
 * bar as the harness in index.ts that calls us: console.error PLUS Sentry,
 * because the resulting state (a disabled deployment that may still hold a live
 * repeat key) is not something a stdout line can explain after the fact.
 */
function reportTeardownFailure(stage: string, error: unknown): void {
  console.error(`[AbuseSignals] ${stage} failed while disabled:`, error);
  captureException(error instanceof Error ? error : new Error(String(error)));
}

/**
 * Drop this queue's repeat keys and release the queue handle.
 *
 * Why this matters is NOT "the sweep would otherwise keep firing forever": in
 * BullMQ 5 the next iteration of a legacy `repeat` job is enqueued by the
 * WORKER when it picks the current one up (`Worker.nextJobFromJobData` →
 * `Repeat.updateRepeatableJob`, bullmq/dist/cjs/classes/worker.js). With no
 * worker attached the chain stalls after the single already-scheduled delayed
 * job. What survives is the repeat KEY in Redis — inert while nothing consumes
 * the queue, and resurrected in full the moment any process with a worker
 * attaches to it: a rollback to a build without this gate, a sibling replica
 * that reads its env differently, or a later re-enable. Removing the key is
 * what makes "disabled" mean disabled across those transitions.
 */
async function teardownAbuseRepeatables(): Promise<void> {
  const queue = getAbuseSignalsQueue();
  try {
    await removeAbuseRepeatables(queue);
  } catch (error) {
    reportTeardownFailure('Clearing repeatables', error);
  }
  // Closing is attempted even when the removal above threw, and the module
  // handle is dropped only once close() has actually resolved — nulling it in a
  // `finally` orphaned the Queue permanently, since shutdownAbuseSignalsWorker
  // then sees null and no-ops. Safe to close eagerly: getBullMQConnection()
  // hands BullMQ an existing ioredis instance, which QueueBase flags
  // `shared: true`, and RedisConnection.close() skips quit()/disconnect() on a
  // shared connection — so this does not disturb the other queues using it.
  try {
    await queue.close();
    abuseQueue = null;
  } catch (error) {
    reportTeardownFailure('Closing the queue', error);
  }
}

export async function initializeAbuseSignalsWorker(): Promise<void> {
  const abuseEnabled = abuseSignalsEnabled();
  const trustEnabled = partnerTrustMode() !== 'off';
  // Signup-abuse detection is hosted-only by default — see abuseSignalsEnabled().
  if (!abuseEnabled && !trustEnabled) {
    // Repeat keys are SHARED Redis state, so removing them on the merely-
    // default-off path is a multi-replica hazard: one replica booting with an
    // unmapped IS_HOSTED (a real, documented failure — issue #570) would delete
    // the repeatables a correctly-configured sibling had just scheduled. That
    // sibling keeps its live worker and still logs success, while its queue
    // silently holds no repeat entries and the sweep never runs again. So tear
    // down ONLY when the operator affirmatively opted out; ambiguity leaves
    // shared state alone.
    if (abuseSignalsExplicitlyDisabled()) {
      await teardownAbuseRepeatables();
    } else {
      console.log(
        '[AbuseSignals] Off by default, not an explicit opt-out — leaving any repeat keys a previous boot registered in place (they are inert with no worker attached, but will resume if a worker ever does). Set ABUSE_SIGNALS_ENABLED=false to remove them.',
      );
    }
    // Report the values actually READ, not an inferred cause: on a hosted box
    // with an unmapped IS_HOSTED, "self-hosted default" is a false claim that
    // would stop someone mid-investigation.
    console.log(
      `[AbuseSignals] Disabled (IS_HOSTED=${describeEnv(process.env.IS_HOSTED)}, ABUSE_SIGNALS_ENABLED=${describeEnv(process.env.ABUSE_SIGNALS_ENABLED)}) — set ABUSE_SIGNALS_ENABLED=true to opt in`,
    );
    return;
  }
  abuseWorker = createAbuseSignalsWorker();
  attachWorkerObservability(abuseWorker, 'abuseSignalsWorker');
  if (abuseEnabled) {
    await scheduleAbuseSignalsJobs();
  } else if (abuseSignalsExplicitlyDisabled()) {
    // Keep the shared queue open for partner-trust jobs, but ensure an
    // explicit abuse-signals opt-out cannot leave its repeat jobs live.
    await removeAbuseRepeatables(getAbuseSignalsQueue());
  }
  await schedulePartnerTrustJobs(getAbuseSignalsQueue());
  console.log('[AbuseSignals] Abuse/partner-trust worker initialized');
}

export async function shutdownAbuseSignalsWorker(): Promise<void> {
  if (abuseWorker) {
    await abuseWorker.close();
    abuseWorker = null;
  }
  if (abuseQueue) {
    await abuseQueue.close();
    abuseQueue = null;
  }
  await shutdownIpClassifyQueue();
}
