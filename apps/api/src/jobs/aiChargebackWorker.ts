/**
 * AI chargeback daily sweep (#7608). Closes the most recent closed UTC month
 * for every org that has chargeable, unclaimed ledger rows in it and no run
 * for that month yet. Daily (not monthly) so a missed run — downtime on the
 * 1st — catches up the next day. An org whose month is already closed is never
 * selected (the candidate query excludes it); runOrgChargePeriod's
 * 'already_run' skip is only the fallback for a concurrent closer racing this
 * one. Each org closes in its own short system transaction
 * (runOrgChargePeriod's FK checks hold FOR KEY SHARE on that org's row until
 * commit, so one long multi-org transaction would stall every org's AI
 * admission behind it); one failure never aborts the rest.
 *
 * Signals: every failed close is a captureException tagged org_id +
 * ai_charge_period_start, and any failure also raises one error-level
 * 'ai_chargeback_close_failed' event for the sweep. Chargeable usage that aged
 * past the lookback unbilled is a warning-level 'ai_chargeback_usage_expired'
 * per org. The summary line carries all four counts.
 */
import { Job, Queue, Worker } from 'bullmq';
import { sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { getBullMQConnection } from '../services/redis';
import { captureException, captureMessage } from '../services/sentry';
import { CHARGEBACK_LOOKBACK_DAYS, lookbackStartIso, previousClosedPeriod, utcStartIso } from '../services/aiChargeback/chargePeriods';
import { runOrgChargePeriod } from '../services/aiChargeback/chargeRun';
import { attachWorkerObservability } from './workerObservability';
import { jobSchedule } from './scheduleRegistry';

const LOG = '[AiChargeback]';
const QUEUE_NAME = 'ai-chargeback';
const JOB_NAME = 'ai-chargeback-sweep';

export async function runChargebackSweep(now: Date = new Date()): Promise<{
  periodStart: string; charged: number; skipped: number; failed: number; expired: number;
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

  let charged = 0; let skipped = 0; let failed = 0; let expired = 0;
  for (const orgId of orgIds) {
    const tags = { org_id: orgId, ai_charge_period_start: period.periodStart };
    try {
      const out = await runOutsideDbContext(() => withSystemDbAccessContext(
        () => runOrgChargePeriod({ orgId, periodStart: period.periodStart, now }), 'aiChargeback.close'));
      if (out.kind !== 'charged') { skipped += 1; continue; }
      charged += 1;
      if (out.expiredInvocationCount > 0) {
        expired += out.expiredInvocationCount;
        console.warn(`${LOG} org ${orgId}: ${out.expiredInvocationCount} chargeable row(s) older than the ${CHARGEBACK_LOOKBACK_DAYS}-day lookback were never closed and will not be billed`);
        captureMessage(`AI chargeback: chargeable usage aged past the ${CHARGEBACK_LOOKBACK_DAYS}-day lookback unbilled`, {
          eventCode: 'ai_chargeback_usage_expired', level: 'warning', tags,
        });
      }
    } catch (err) {
      failed += 1;
      console.error(`${LOG} close failed for org ${orgId} ${period.periodStart}`, err);
      captureException(err, undefined, tags);
    }
  }
  console.log(`${LOG} ${period.periodStart}: charged ${charged}, skipped ${skipped}, failed ${failed}, expired ${expired}`);
  if (failed > 0) {
    captureMessage(`AI chargeback sweep: ${failed} of ${orgIds.length} org close(s) failed for ${period.periodStart}`, {
      eventCode: 'ai_chargeback_close_failed', level: 'error', tags: { ai_charge_period_start: period.periodStart },
    });
  }
  return { periodStart: period.periodStart, charged, skipped, failed, expired };
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
