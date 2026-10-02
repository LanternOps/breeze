/**
 * AI chargeback daily sweep (#7608). Closes the most recent closed UTC month
 * for every org that has chargeable, unclaimed ledger rows and no run yet.
 * Daily (not monthly) so a missed run — downtime on the 1st — catches up the
 * next day; a closed month is a no-op (already_run). Each org closes in its
 * own short system transaction (runOrgChargePeriod's FK checks hold FOR KEY
 * SHARE on that org's row until commit, so one long multi-org transaction
 * would stall every org's AI admission behind it); one failure never aborts
 * the rest.
 */
import { Job, Queue, Worker } from 'bullmq';
import { sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { lookbackStartIso, previousClosedPeriod, utcStartIso } from '../services/aiChargeback/chargePeriods';
import { runOrgChargePeriod } from '../services/aiChargeback/chargeRun';
import { attachWorkerObservability } from './workerObservability';
import { jobSchedule } from './scheduleRegistry';

const LOG = '[AiChargeback]';
const QUEUE_NAME = 'ai-chargeback';
const JOB_NAME = 'ai-chargeback-sweep';

export async function runChargebackSweep(now: Date = new Date()): Promise<{
  periodStart: string; charged: number; skipped: number; failed: number;
}> {
  const period = previousClosedPeriod(now);
  const orgIds = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const result = await db.execute(sql`
      SELECT DISTINCT i.org_id
      FROM ai_invocations i
      WHERE i.chargeable AND i.ledger_mode = 'authoritative'
        AND i.created_at >= ${lookbackStartIso(period)}::timestamptz
        AND i.created_at < ${utcStartIso(period.periodEnd)}::timestamptz
        AND NOT EXISTS (SELECT 1 FROM ai_usage_charge_claims c WHERE c.invocation_id = i.id)
        AND NOT EXISTS (SELECT 1 FROM ai_usage_charge_runs r
                        WHERE r.org_id = i.org_id AND r.period_start = ${period.periodStart}::date)`);
    const rows = ((result as unknown as { rows?: Array<{ org_id: string }> }).rows ?? (result as unknown as Array<{ org_id: string }>));
    return rows.map((r) => r.org_id);
  }, 'aiChargeback.candidates'));

  let charged = 0; let skipped = 0; let failed = 0;
  for (const orgId of orgIds) {
    try {
      const out = await runOutsideDbContext(() => withSystemDbAccessContext(
        () => runOrgChargePeriod({ orgId, periodStart: period.periodStart, now }), 'aiChargeback.close'));
      if (out.kind === 'charged') charged += 1; else skipped += 1;
    } catch (err) {
      failed += 1;
      console.error(`${LOG} close failed for org ${orgId} ${period.periodStart}`, err);
      captureException(err);
    }
  }
  console.log(`${LOG} ${period.periodStart}: charged ${charged}, skipped ${skipped}, failed ${failed}`);
  return { periodStart: period.periodStart, charged, skipped, failed };
}

let queue: Queue | null = null;
let worker: Worker | null = null;

export async function initializeAiChargebackWorker(): Promise<void> {
  worker = new Worker(QUEUE_NAME, async (_job: Job) => runChargebackSweep(), { connection: getBullMQConnection(), concurrency: 1 });
  attachWorkerObservability(worker, 'aiChargebackWorker');
  queue = new Queue(QUEUE_NAME, { connection: getBullMQConnection() });
  for (const job of await queue.getRepeatableJobs()) await queue.removeRepeatableByKey(job.key);
  await queue.add(JOB_NAME, {}, {
    jobId: JOB_NAME,
    repeat: { pattern: jobSchedule('ai-chargeback-sweep') },
    removeOnComplete: { count: 10 },
    removeOnFail: { count: 30 },
  });
  console.log(`${LOG} worker initialized`);
}

export async function shutdownAiChargebackWorker(): Promise<void> {
  if (worker) { await worker.close(); worker = null; }
  if (queue) { await queue.close(); queue = null; }
}
