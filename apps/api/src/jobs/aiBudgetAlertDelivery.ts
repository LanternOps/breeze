/**
 * #4388 — delivery worker for pre-cap AI budget alert events recorded by
 * `services/aiBudgetAlerts.ts`. One in-app notification per recipient, one
 * combined email when the policy calls for it, an event-bus publish, plus a
 * reconcile sweep for rows a crash left undelivered and a partner-wide
 * evaluation fan-out for the org-scoped evaluator.
 */

import { Job, Queue, Worker } from 'bullmq';
import { sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { getBullMQConnection } from '../services/redis';
import { captureException, captureMessage } from '../services/sentry';
import { createNotification } from '../services/userNotifications';
import { resolveUsersWithPermissionForOrg } from '../services/usersWithPermission';
import { PERMISSIONS } from '../services/permissions';
import { getEmailService } from '../services/email';
import { EVENT_TYPES, publishEvent } from '../services/eventBus';
import { buildAiBudgetAlertEmail, describeAiBudgetAlert, shouldEmail } from '../services/aiBudgetAlertEmail';
import { evaluateAiBudgetThresholds } from '../services/aiBudgetAlerts';
import { getFrontendBaseUrl } from '../services/c2cM365';
import { PG_UUID_REGEX } from '../utils/uuid';
import { attachWorkerObservability } from './workerObservability';

export const AI_BUDGET_ALERT_QUEUE = 'ai-budget-alert-delivery';
const USAGE_PATH = '/settings/ai-usage';
const MAX_ATTEMPTS = 5;

/**
 * The event row is not readable yet — almost always because the inserting
 * transaction has not committed (`evaluateAiBudgetThresholds` running inside a
 * caller-owned system transaction still enqueues before that transaction
 * commits), occasionally because the org was deleted and the FK cascade took
 * the row with it.
 *
 * This MUST be an error, not a `{recipients: 0}` success. A completed job's
 * hash is retained by `removeOnComplete`, and BullMQ's addStandardJob Lua
 * returns the EXISTING id when `EXISTS <prefix><jobId>` — so a job that
 * completed against an invisible row makes every later add under the same job
 * id (including the reconcile sweep's) a silent no-op, and the alert is lost
 * for good. Throwing lets the configured exponential backoff re-read the row
 * once it is visible; `processJob` converts the FINAL attempt into a logged
 * completion so a genuinely deleted org does not page anyone.
 */
export class AiBudgetAlertEventNotVisibleError extends Error {
  constructor(public readonly eventId: string) {
    super(`ai budget alert event ${eventId} is not visible (uncommitted or deleted)`);
    this.name = 'AiBudgetAlertEventNotVisibleError';
  }
}

export type AiBudgetAlertJobData =
  | { type: 'deliver'; eventId: string }
  | { type: 'reconcile' }
  | { type: 'evaluate-partner'; partnerId: string };

let queue: Queue<AiBudgetAlertJobData> | null = null;
let worker: Worker<AiBudgetAlertJobData> | null = null;

export function getAiBudgetAlertQueue(): Queue<AiBudgetAlertJobData> {
  if (!queue) queue = new Queue<AiBudgetAlertJobData>(AI_BUDGET_ALERT_QUEUE, { connection: getBullMQConnection() });
  return queue;
}

/**
 * `jobId` defaults to the stable `deliver-<eventId>`, which is what makes the
 * ordinary post-insert enqueue idempotent. The reconcile sweep passes its OWN
 * per-sweep id instead: a retained completed/failed job hash under the stable
 * id would otherwise make the sweep's re-add a no-op (BullMQ returns the
 * existing job id when the key exists), i.e. the exact rows reconcile exists
 * to rescue would be the rows it can never re-enqueue.
 */
export async function enqueueAiBudgetAlertDelivery(eventId: string, jobId = `deliver-${eventId}`): Promise<void> {
  await getAiBudgetAlertQueue().add('deliver', { type: 'deliver', eventId }, {
    jobId,
    attempts: MAX_ATTEMPTS,
    backoff: { type: 'exponential', delay: 30_000 },
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 200 },
  });
}

export async function enqueueAiBudgetEvaluationForPartner(partnerId: string): Promise<void> {
  await getAiBudgetAlertQueue().add('evaluate-partner', { type: 'evaluate-partner', partnerId }, {
    jobId: `evaluate-partner-${partnerId}-${Date.now()}`,
    attempts: 3,
    removeOnComplete: { count: 50 },
    removeOnFail: { count: 50 },
  });
}

type EventRow = {
  id: string; org_id: string; org_name: string; period: 'daily' | 'monthly'; period_key: string;
  threshold_pct: number; cap_cents: number; used_cents: number; billing_source: 'platform' | 'partner_key'; delivered_at: string | null;
};

/**
 * Record a failed attempt on the event row.
 *
 * Deliberately its OWN `runOutsideDbContext` + system context, run only AFTER
 * the delivery context has unwound. Written inside the delivery context — as
 * it was before W02 — the UPDATE is part of the very transaction the rethrow
 * then aborts, so it leaves NO durable trace: `delivery_attempts` stays 0 and
 * `last_delivery_error` stays NULL forever. That is not cosmetic. The
 * reconcile sweep's `delivery_attempts < MAX_ATTEMPTS` guard exists to stop
 * re-attempting a permanently broken row, and with a counter frozen at 0 it
 * can never fire; operators, meanwhile, see a row that looks untouched rather
 * than one that has failed five times. Worse, when the original error came
 * from a DB statement the transaction is already aborted, so the bookkeeping
 * write itself fails with 25P02 instead of recording anything.
 *
 * Best-effort by construction: a failure here must not mask the real error.
 */
async function recordDeliveryFailure(eventId: string, message: string): Promise<void> {
  await runOutsideDbContext(() => withSystemDbAccessContext(() => db.execute(sql`
    UPDATE ai_budget_alert_events
    SET delivery_attempts = delivery_attempts + 1, last_delivery_error = ${message.slice(0, 500)}
    WHERE id = ${eventId}::uuid
  `), 'aiBudgetAlertDelivery.recordFailure')).catch((bookkeepingErr: unknown) => {
    console.error(`[AI] budget alert failure bookkeeping failed for event ${eventId}:`, bookkeepingErr instanceof Error ? bookkeepingErr.message : bookkeepingErr);
  });
}

/** Exported for tests. Idempotent: in-app writes dedupe on the event id, and a delivered row short-circuits. */
export async function deliverAiBudgetAlert(eventId: string): Promise<{ recipients: number; emailed: boolean }> {
  try {
    return await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
      // FOR UPDATE OF e (the event row only — never the joined organizations
      // row) serialises two jobs racing the same event: the loser blocks here
      // until the winner's transaction commits and then reads the freshly
      // stamped `delivered_at`, taking the no-op branch below instead of
      // sending a second email. Without the lock both jobs read
      // `delivered_at IS NULL` concurrently and both send.
      const loaded = await db.execute<EventRow>(sql`
        SELECT e.id, e.org_id, o.name AS org_name, e.period, e.period_key, e.threshold_pct, e.cap_cents, e.used_cents, e.billing_source, e.delivered_at
        FROM ai_budget_alert_events e
        JOIN organizations o ON o.id = e.org_id
        WHERE e.id = ${eventId}::uuid
        FOR UPDATE OF e
      `);
      const event = loaded[0];
      if (!event) throw new AiBudgetAlertEventNotVisibleError(eventId);
      if (event.delivered_at) return { recipients: 0, emailed: false };

      const ctx = {
        orgName: event.org_name,
        period: event.period,
        periodKey: event.period_key,
        thresholdPct: Number(event.threshold_pct),
        capCents: Number(event.cap_cents),
        usedCents: Number(event.used_cents),
        billingSource: event.billing_source,
        usagePath: USAGE_PATH,
        appBaseUrl: getFrontendBaseUrl(),
      };
      const { title, message } = describeAiBudgetAlert(ctx);
      const userIds = await resolveUsersWithPermissionForOrg(event.org_id, PERMISSIONS.BILLING_MANAGE);

      if (userIds.length === 0) {
        captureMessage('AI budget alert has no recipients', {
          eventCode: 'ai_budget_alert_no_recipients',
          tags: { org_id: event.org_id },
        });
      }

      for (const userId of userIds) {
        await createNotification({
          userId,
          orgId: event.org_id,
          type: 'ai',
          title,
          message,
          link: USAGE_PATH,
          priority: ctx.thresholdPct >= 95 ? 'high' : 'normal',
          metadata: { eventId: event.id, period: event.period, periodKey: event.period_key, thresholdPct: ctx.thresholdPct },
          dedupeKey: `ai-budget-alert:${event.id}`,
        });
      }

      let emailed = false;
      const emailService = getEmailService();
      if (emailService && userIds.length > 0 && shouldEmail(event.period, ctx.thresholdPct)) {
        const rows = await db.execute<{ email: string }>(sql`
          SELECT email FROM users
          WHERE id IN (${sql.join(userIds.map((id) => sql`${id}::uuid`), sql`, `)}) AND email IS NOT NULL
        `);
        const to = rows.map((r) => r.email);
        if (to.length > 0) {
          const email = buildAiBudgetAlertEmail(ctx);
          await emailService.sendEmail({ to, subject: email.subject, html: email.html, text: email.text });
          emailed = true;
        }
      }

      // Mark delivered BEFORE the event-bus publish, and inside the SAME
      // transaction as the notification writes above, so the marker and the
      // delivery it marks commit or roll back together. Notifications + email
      // above are the actual customer-facing delivery; the publish below is
      // observability only. If it were ordered first and then failed (a real
      // Redis call), the outer catch would record a failed attempt and
      // BullMQ would retry a job whose customer-facing work already
      // succeeded — resending the email, which (unlike the in-app
      // notification's dedupe-key unique index) has no idempotency guard.
      // Marking delivered here means a retry hits the `event.delivered_at`
      // short-circuit above and returns early instead of resending anything.
      await db.execute(sql`
        UPDATE ai_budget_alert_events
        SET delivered_at = now(), recipient_count = ${userIds.length}, delivery_attempts = delivery_attempts + 1, last_delivery_error = NULL
        WHERE id = ${eventId}::uuid
      `);

      // Best-effort only, swallowed here so it never reaches the function-level
      // failure path: a publish failure must never undo the delivery just
      // marked above or trigger a retry of it.
      try {
        await publishEvent(EVENT_TYPES.AI_BUDGET_THRESHOLD_CROSSED, event.org_id, {
          eventId: event.id,
          period: event.period,
          periodKey: event.period_key,
          thresholdPct: ctx.thresholdPct,
          capCents: ctx.capCents,
          usedCents: ctx.usedCents,
          billingSource: event.billing_source,
        }, 'ai-budget-alerts');
      } catch (publishErr) {
        const publishMsg = publishErr instanceof Error ? publishErr.message : String(publishErr);
        console.error(`[AI] budget alert event-bus publish failed for event ${eventId} (delivery already marked complete):`, publishMsg);
        captureException(publishErr instanceof Error ? publishErr : new Error(publishMsg), undefined, { service: 'aiBudgetAlertDelivery' });
      }

      console.log(`[AI] budget alert delivered event=${eventId} org=${event.org_id} recipients=${userIds.length} emailed=${emailed}`);
      return { recipients: userIds.length, emailed };
    }, 'aiBudgetAlertDelivery.deliver'));
  } catch (err) {
    // OUTSIDE the context above on purpose — see `recordDeliveryFailure`.
    if (err instanceof AiBudgetAlertEventNotVisibleError) {
      // No row to book anything against, and no bug to report: the insert has
      // not committed yet (retry) or the org is gone (processJob retires it on
      // the final attempt). Deliberately not sent to Sentry.
      throw err;
    }
    const msg = err instanceof Error ? err.message : String(err);
    await recordDeliveryFailure(eventId, msg);
    captureException(err instanceof Error ? err : new Error(msg), undefined, { service: 'aiBudgetAlertDelivery' });
    throw err;
  }
}

/** Re-enqueues events inserted but never delivered (crash between insert and enqueue, or an enqueue call that itself failed). Excludes rows that already exhausted retries — those need operator attention, not another silent re-attempt. */
export async function reconcileUndeliveredAiBudgetAlerts(): Promise<number> {
  const rows = await runOutsideDbContext(() => withSystemDbAccessContext(() => db.execute<{ id: string }>(sql`
    SELECT id FROM ai_budget_alert_events
    WHERE delivered_at IS NULL AND delivery_attempts < ${MAX_ATTEMPTS} AND created_at < now() - interval '2 minutes'
    ORDER BY created_at
    LIMIT 500
  `), 'aiBudgetAlertDelivery.reconcile'));
  // One id per sweep, shared by every row in it: unique enough to defeat a
  // retained job hash, stable enough that two overlapping sweeps (the repeat
  // job is every 15 minutes; a sweep is bounded at 500 rows) still collapse
  // into one job per row rather than queueing the same delivery twice.
  const sweep = Date.now();
  for (const row of rows) await enqueueAiBudgetAlertDelivery(row.id, `deliver-${row.id}-r${sweep}`);
  if (rows.length > 0) console.log(`[AI] budget alert reconcile re-enqueued ${rows.length} undelivered event(s)`);
  return rows.length;
}

/** Exported for tests (finding 2, fix round 1). Internal to the job's switch otherwise — no other caller. */
export async function evaluatePartnerOrgs(partnerId: string): Promise<number> {
  // Dead-lifecycle orgs are skipped: they accrue no AI spend, so evaluating
  // them is pure load, and `purging` is mid-erasure — inserting a fresh
  // ai_budget_alert_events row under it would race the cascade. Written as an
  // EXCLUSION list rather than `status = 'active'` on purpose: `trial` orgs
  // are live paying-adjacent tenants whose budgets very much do apply, and a
  // future live status must default to being evaluated, not to silently
  // dropping out of alerting.
  const rows = await runOutsideDbContext(() => withSystemDbAccessContext(() => db.execute<{ id: string }>(sql`
    SELECT id FROM organizations
    WHERE partner_id = ${partnerId}::uuid
      AND deleted_at IS NULL
      AND status NOT IN ('purging', 'archived', 'churned', 'merging', 'offboarding')
  `), 'aiBudgetAlertDelivery.evaluatePartner'));
  // Sequential, not Promise.all: bounded concurrency against a per-org
  // evaluator that itself opens a system DB context and a transaction per
  // period, so a large partner does not open dozens of connections at once.
  for (const row of rows) await evaluateAiBudgetThresholds(row.id);
  console.log(`[AI] budget alert partner fan-out partner=${partnerId} orgs=${rows.length}`);
  return rows.length;
}

/**
 * Exported for tests.
 *
 * `job.data` is deserialised Redis payload, not a typed value: a job left over
 * from an older deploy, a hand-injected one, or a truncated write all arrive
 * here shaped however Redis had them. An unvalidated id goes straight into a
 * `::uuid` cast and raises 22P02 on every one of the five attempts before
 * failing loudly for something no retry can fix — so validate the shape first
 * and drop what cannot be run.
 */
export async function processJob(job: Job<AiBudgetAlertJobData>): Promise<unknown> {
  const data = job.data as Partial<{ type: unknown; eventId: unknown; partnerId: unknown }> | undefined;

  switch (data?.type) {
    case 'deliver': {
      const eventId = data.eventId;
      if (typeof eventId !== 'string' || !PG_UUID_REGEX.test(eventId)) {
        console.error(`[AI] budget alert job ${job.id} carries a non-uuid eventId (${String(eventId)}); dropping`);
        return { skipped: 'invalid-event-id' };
      }
      try {
        return await deliverAiBudgetAlert(eventId);
      } catch (err) {
        // Final attempt on a row that never appeared: the insert was rolled
        // back or the org was erased. Complete the job with a log instead of
        // failing it, so an ordinary tenant deletion doesn't page anyone.
        if (err instanceof AiBudgetAlertEventNotVisibleError && job.attemptsMade + 1 >= (job.opts.attempts ?? 1)) {
          console.warn(`[AI] budget alert event ${eventId} never became visible: rolled back or org deleted; giving up after ${job.attemptsMade + 1} attempt(s)`);
          return { skipped: 'event-not-visible' };
        }
        throw err;
      }
    }
    case 'reconcile':
      return reconcileUndeliveredAiBudgetAlerts();
    case 'evaluate-partner': {
      const partnerId = data.partnerId;
      if (typeof partnerId !== 'string' || !PG_UUID_REGEX.test(partnerId)) {
        console.error(`[AI] budget alert job ${job.id} carries a non-uuid partnerId (${String(partnerId)}); dropping`);
        return { skipped: 'invalid-partner-id' };
      }
      return evaluatePartnerOrgs(partnerId);
    }
    default:
      console.error(`[AI] budget alert job ${job.id} has an unrecognised type (${String(data?.type)}); dropping`);
      return { skipped: 'unknown-job-type' };
  }
}

export async function initializeAiBudgetAlertWorker(): Promise<void> {
  if (worker) return;
  worker = new Worker<AiBudgetAlertJobData>(AI_BUDGET_ALERT_QUEUE, processJob, { connection: getBullMQConnection(), concurrency: 2 });
  attachWorkerObservability(worker, AI_BUDGET_ALERT_QUEUE);
  // Sub-hourly (every 15 minutes), so it is exempt from scheduleRegistry.ts
  // (which only allocates coarse, >= hourly schedules) — confirmed against
  // scheduleRegistry.contract.test.ts's minimumGapMs threshold. The four
  // offset minutes keep it off the :00/:15/:30/:45 pile-up other fine-grained
  // ticks converge on.
  await getAiBudgetAlertQueue().add('reconcile', { type: 'reconcile' }, {
    jobId: 'ai-budget-alert-reconcile',
    repeat: { pattern: '7,22,37,52 * * * *' },
    removeOnComplete: { count: 5 },
    removeOnFail: { count: 10 },
  });
}

export async function shutdownAiBudgetAlertWorker(): Promise<void> {
  await worker?.close();
  worker = null;
  await queue?.close();
  queue = null;
}
