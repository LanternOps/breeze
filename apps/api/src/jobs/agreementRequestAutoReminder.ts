import { Job, Queue, Worker } from 'bullmq';
import { and, asc, eq, gt, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import * as dbModule from '../db';
import { db } from '../db';
import { agreementRequests } from '../db/schema/contractDocuments';
import { organizations, partners } from '../db/schema/orgs';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { writeAuditEvent, requestLikeFromSnapshot } from '../services/auditEvents';
import { autoRemindAgreementRequest } from '../services/agreementRequestLifecycle';
import { buildPublicLinkLiveOrgPredicate } from '../services/publicLinkOrgGate';
import { bullmqJobId } from '../services/bullmqUtils';
import { attachWorkerObservability } from './workerObservability';

/**
 * Automatic agreement-request reminders (#9075 W4a, spec OD8 B).
 *
 * A partner that sets "remind every N days" under Settings → Billing →
 * Agreements gets each open (sent | viewed) request re-emailed — the SAME
 * signing link, through the manual Remind's core (`remindLockedRequest`) — N
 * days after the later of the send and the last reminder, until the request
 * has had `agreement_max_reminders` reminders (manual ones count) or stops
 * being open. Off by default.
 *
 * Its own queue rather than a tick inside agreementRequestExpiryReaper: this
 * job sends customer email, so a slow mail provider or a reminder bug must not
 * delay or break the expiry state machine, and the reaper must not be able to
 * stall reminders. The read-time expiry guard is still the authority — a
 * request past expires_at is never reminded even before the reaper flips it.
 *
 * Shape, per run (hourly; the cadence is in whole days):
 *   1. one short SYSTEM read selects up to MAX_PER_RUN due ids (the SQL mirrors
 *      `isAutoReminderDue`; the partner's columns are joined, not looped);
 *   2. each id is reminded in ITS OWN system transaction
 *      (`autoRemindAgreementRequest`: SKIP LOCKED, link-live org/partner,
 *      due-ness re-checked on the locked row, counter bump conditional on the
 *      count it read — so one cadence step is sent at most once);
 *   3. only after that transaction commits does the mail round-trip run, then
 *      a system audit row `billing.agreement.reminded` (details.automatic).
 *
 * At-most-once: a crash between the commit and the mail loses that reminder;
 * it is never sent twice. A failed send is audited with its reason, not retried
 * (the next one is due an interval later). No bus event — like the manual
 * Remind, a reminder is not a lifecycle transition.
 */

const QUEUE_NAME = 'agreement-request-auto-reminder';
const JOB_NAME = 'send-agreement-auto-reminders';
const RUN_INTERVAL_MS = 60 * 60 * 1000; // hourly
const MAX_PER_RUN = 200;
const OPEN_STATUSES: Array<'sent' | 'viewed'> = ['sent', 'viewed'];

type ReminderJobData = { type: typeof JOB_NAME; queuedAt: string };

export interface AutoReminderRunSummary {
  selected: number;
  reminded: number;
  skipped: number;
  failed: number;
}

const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  if (typeof withSystem !== 'function') {
    throw new Error(
      '[AgreementRequestAutoReminder] withSystemDbAccessContext not available — reminders cannot run without system DB access',
    );
  }
  return withSystem(fn);
};

let reminderQueue: Queue<ReminderJobData> | null = null;
let reminderWorker: Worker<ReminderJobData> | null = null;

function getQueue(): Queue<ReminderJobData> {
  if (!reminderQueue) {
    reminderQueue = new Queue<ReminderJobData>(QUEUE_NAME, { connection: getBullMQConnection() });
  }
  return reminderQueue;
}

/** The due set, oldest send first. A prefilter only: every id is re-checked on
 *  its locked row by `isAutoReminderDue` before anything is written. */
export async function selectDueAutoReminderIds(now: Date, limit = MAX_PER_RUN): Promise<string[]> {
  const nowIso = now.toISOString();
  const rows = await db
    .select({ id: agreementRequests.id })
    .from(agreementRequests)
    .innerJoin(organizations, eq(organizations.id, agreementRequests.orgId))
    .innerJoin(partners, eq(partners.id, organizations.partnerId))
    .where(and(
      inArray(agreementRequests.status, OPEN_STATUSES),
      gt(agreementRequests.expiresAt, now),
      isNull(agreementRequests.publicLinkRevokedAt),
      isNotNull(agreementRequests.sentAt),
      isNotNull(partners.agreementReminderIntervalDays),
      sql`${agreementRequests.reminderCount} < ${partners.agreementMaxReminders}`,
      // GREATEST ignores a NULL last_reminded_at, so a never-reminded request
      // anchors on sent_at.
      sql`greatest(${agreementRequests.sentAt}, ${agreementRequests.lastRemindedAt})
        + make_interval(days => ${partners.agreementReminderIntervalDays}) <= ${nowIso}::timestamptz`,
      buildPublicLinkLiveOrgPredicate(agreementRequests.orgId),
    ))
    .orderBy(asc(agreementRequests.sentAt), asc(agreementRequests.id))
    .limit(limit);
  return rows.map((r) => r.id);
}

export async function sendDueAgreementAutoReminders(now: Date = new Date()): Promise<AutoReminderRunSummary> {
  const ids = await runWithSystemDbAccess(() => selectDueAutoReminderIds(now));
  const summary: AutoReminderRunSummary = { selected: ids.length, reminded: 0, skipped: 0, failed: 0 };
  const requestLike = requestLikeFromSnapshot({});

  for (const id of ids) {
    let outcome: Awaited<ReturnType<typeof autoRemindAgreementRequest>>;
    try {
      outcome = await runWithSystemDbAccess(() => autoRemindAgreementRequest(id, now));
    } catch (err) {
      summary.failed += 1;
      console.error(`[AgreementRequestAutoReminder] Request ${id} failed:`, err);
      captureException(err instanceof Error ? err : new Error(String(err)));
      continue;
    }
    if (!outcome.reminded) {
      summary.skipped += 1;
      continue;
    }
    summary.reminded += 1;
    const { request, recipients, reissued } = outcome.result;
    // Post-commit (the system transaction above has resolved). Never rejects:
    // every failure is an emailReason.
    const delivery = await outcome.result.deliverEmail();
    try {
      writeAuditEvent(requestLike, {
        orgId: request.orgId,
        action: 'billing.agreement.reminded',
        resourceType: 'agreement_request',
        resourceId: request.id,
        resourceName: request.label,
        actorType: 'system',
        actorId: null,
        result: 'success',
        details: {
          automatic: true,
          reminderCount: request.reminderCount,
          recipientCount: recipients.length,
          reissued,
          emailed: delivery.emailed,
          ...(delivery.emailReason ? { emailReason: delivery.emailReason } : {}),
        },
      });
    } catch (err) {
      console.error('[AgreementRequestAutoReminder] Failed to write audit event:', err);
      captureException(err instanceof Error ? err : new Error(String(err)));
    }
  }

  if (ids.length === MAX_PER_RUN) {
    console.warn(`[AgreementRequestAutoReminder] Hit ${MAX_PER_RUN}-item cap — backlog may be growing`);
  }
  return summary;
}

function createWorker(): Worker<ReminderJobData> {
  return new Worker<ReminderJobData>(
    QUEUE_NAME,
    async (_job: Job<ReminderJobData>) => {
      try {
        const summary = await sendDueAgreementAutoReminders();
        if (summary.reminded > 0 || summary.failed > 0) {
          console.log(
            `[AgreementRequestAutoReminder] Reminded ${summary.reminded}, skipped ${summary.skipped}, failed ${summary.failed}`,
          );
        }
        return summary;
      } catch (err) {
        console.error('[AgreementRequestAutoReminder] Run failed:', err);
        captureException(err instanceof Error ? err : new Error(String(err)));
        throw err;
      }
    },
    { connection: getBullMQConnection(), concurrency: 1 },
  );
}

async function scheduleRepeatableJob(): Promise<void> {
  const queue = getQueue();
  const repeatables = await queue.getRepeatableJobs();
  for (const job of repeatables) {
    if (job.name === JOB_NAME) {
      await queue.removeRepeatableByKey(job.key);
    }
  }
  await queue.add(
    JOB_NAME,
    { type: JOB_NAME, queuedAt: new Date().toISOString() },
    {
      jobId: bullmqJobId(QUEUE_NAME),
      repeat: { every: RUN_INTERVAL_MS },
      removeOnComplete: { count: 20 },
      removeOnFail: { count: 200 },
    },
  );
}

export async function initializeAgreementRequestAutoReminder(): Promise<void> {
  if (reminderWorker) return;
  reminderWorker = createWorker();
  attachWorkerObservability(reminderWorker, 'agreementRequestAutoReminder');
  reminderWorker.on('error', (error) => {
    console.error('[AgreementRequestAutoReminder] Worker error:', error);
    captureException(error);
  });
  reminderWorker.on('failed', (job, error) => {
    console.error(`[AgreementRequestAutoReminder] Job ${job?.id} failed:`, error);
    captureException(error);
  });
  try {
    await scheduleRepeatableJob();
  } catch (err) {
    await reminderWorker.close();
    reminderWorker = null;
    throw err;
  }
  console.log('[AgreementRequestAutoReminder] Initialized');
}

export async function shutdownAgreementRequestAutoReminder(): Promise<void> {
  const worker = reminderWorker;
  const queue = reminderQueue;
  reminderWorker = null;
  reminderQueue = null;
  if (worker) {
    try { await worker.close(); } catch (err) { console.error('[AgreementRequestAutoReminder] Error closing worker:', err); }
  }
  if (queue) {
    try { await queue.close(); } catch (err) { console.error('[AgreementRequestAutoReminder] Error closing queue:', err); }
  }
}
