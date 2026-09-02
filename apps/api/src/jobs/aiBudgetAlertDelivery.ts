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
import { attachWorkerObservability } from './workerObservability';

export const AI_BUDGET_ALERT_QUEUE = 'ai-budget-alert-delivery';
const USAGE_PATH = '/settings/ai-usage';
const MAX_ATTEMPTS = 5;

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

export async function enqueueAiBudgetAlertDelivery(eventId: string): Promise<void> {
  await getAiBudgetAlertQueue().add('deliver', { type: 'deliver', eventId }, {
    jobId: `deliver-${eventId}`,
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

/** Exported for tests. Idempotent: in-app writes dedupe on the event id, and a delivered row short-circuits. */
export async function deliverAiBudgetAlert(eventId: string): Promise<{ recipients: number; emailed: boolean }> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const loaded = await db.execute<EventRow>(sql`
      SELECT e.id, e.org_id, o.name AS org_name, e.period, e.period_key, e.threshold_pct, e.cap_cents, e.used_cents, e.billing_source, e.delivered_at
      FROM ai_budget_alert_events e
      JOIN organizations o ON o.id = e.org_id
      WHERE e.id = ${eventId}::uuid
    `);
    const event = loaded[0];
    if (!event) {
      // Org deleted (FK cascade) or never existed. Nothing to deliver.
      return { recipients: 0, emailed: false };
    }
    if (event.delivered_at) return { recipients: 0, emailed: false };

    try {
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

      await publishEvent(EVENT_TYPES.AI_BUDGET_THRESHOLD_CROSSED, event.org_id, {
        eventId: event.id,
        period: event.period,
        periodKey: event.period_key,
        thresholdPct: ctx.thresholdPct,
        capCents: ctx.capCents,
        usedCents: ctx.usedCents,
        billingSource: event.billing_source,
      }, 'ai-budget-alerts');

      await db.execute(sql`
        UPDATE ai_budget_alert_events
        SET delivered_at = now(), recipient_count = ${userIds.length}, delivery_attempts = delivery_attempts + 1, last_delivery_error = NULL
        WHERE id = ${eventId}::uuid
      `);
      return { recipients: userIds.length, emailed };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await db.execute(sql`
        UPDATE ai_budget_alert_events
        SET delivery_attempts = delivery_attempts + 1, last_delivery_error = ${msg.slice(0, 500)}
        WHERE id = ${eventId}::uuid
      `).catch(() => undefined);
      captureException(err instanceof Error ? err : new Error(msg), undefined, { service: 'aiBudgetAlertDelivery' });
      throw err;
    }
  }));
}

/** Re-enqueues events inserted but never delivered (crash between insert and enqueue, or an enqueue call that itself failed). Excludes rows that already exhausted retries — those need operator attention, not another silent re-attempt. */
export async function reconcileUndeliveredAiBudgetAlerts(): Promise<number> {
  const rows = await runOutsideDbContext(() => withSystemDbAccessContext(() => db.execute<{ id: string }>(sql`
    SELECT id FROM ai_budget_alert_events
    WHERE delivered_at IS NULL AND delivery_attempts < ${MAX_ATTEMPTS} AND created_at < now() - interval '2 minutes'
    ORDER BY created_at
    LIMIT 500
  `)));
  for (const row of rows) await enqueueAiBudgetAlertDelivery(row.id);
  return rows.length;
}

async function evaluatePartnerOrgs(partnerId: string): Promise<number> {
  const rows = await runOutsideDbContext(() => withSystemDbAccessContext(() => db.execute<{ id: string }>(sql`
    SELECT id FROM organizations WHERE partner_id = ${partnerId}::uuid AND deleted_at IS NULL
  `)));
  // Sequential, not Promise.all: bounded concurrency against a per-org
  // evaluator that itself opens a system DB context and a transaction per
  // period, so a large partner does not open dozens of connections at once.
  for (const row of rows) await evaluateAiBudgetThresholds(row.id);
  return rows.length;
}

async function processJob(job: Job<AiBudgetAlertJobData>): Promise<unknown> {
  switch (job.data.type) {
    case 'deliver': return deliverAiBudgetAlert(job.data.eventId);
    case 'reconcile': return reconcileUndeliveredAiBudgetAlerts();
    case 'evaluate-partner': return evaluatePartnerOrgs(job.data.partnerId);
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
