/**
 * Caller verification post-commit publisher (#6354 W01).
 *
 * The verification row IS the durable outbox: two scalar markers
 * (`delivery_published_at`, `rejection_notified_at`) record what has been
 * published, so every committed row is scanned until marked and a crash
 * between external I/O and the mark simply retries. Consequences:
 *  - in-app notifications and the incident/ticket effects are deduplicated
 *    (per-user dedupe key; transactional effects ran with the decision);
 *  - external email is AT-LEAST-ONCE across a provider-success/process-crash
 *    window — the current email API has no provider idempotency contract, so
 *    this never claims exactly-once SMTP.
 *
 * Runs outside any request context in its own short system transactions,
 * with external I/O between them. One BullMQ repeat job with a stable job id
 * and concurrency 1 serializes it across replicas.
 *
 * Pending rows: non-callback methods are delivered through the W02/W03
 * `deliver` port after commit and time out here when they expire. W01 has
 * no delivery adapter, so nothing is sent — a pending non-callback row can
 * only be produced once a later wave installs `prepare`/`deliver`.
 */
import { Queue, Worker } from 'bullmq';
import { and, eq, isNull, or, ne, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { callerVerifications as v } from '../db/schema/callerVerification';
import { getBullMQConnection } from '../services/redis';
import { createNotification } from '../services/userNotifications';
import { getEmailService } from '../services/email';
import { captureException } from '../services/sentry';
import { securityRecipients } from '../services/callerVerification/effects';
import { callerVerificationPorts } from '../services/callerVerification/ports';
import { applyDecision } from '../services/callerVerification/service';
import { attachWorkerObservability } from './workerObservability';

const QUEUE_NAME = 'caller-verification-publisher';
const JOB_NAME = 'publish';
const JOB_ID = 'caller-verification-publish';
const PUBLISH_INTERVAL_MS = 5000;
const BATCH = 100;
const MAX_DELIVERY_FAILURES = 3;
// Process-local consecutive-failure counts (no attempts column; concurrency 1).
const failures = new Map<string, number>();

const scoped = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn, 'callerVerification.publisher'));

export async function publishCallerVerificationEffects(): Promise<void> {
  const rows = await scoped(() => db.select().from(v).where(or(
    and(eq(v.method, 'administrative_stepup'), isNull(v.deliveryPublishedAt)),
    and(eq(v.status, 'rejected_by_user'), isNull(v.rejectionNotifiedAt)),
    and(eq(v.status, 'pending'), or(isNull(v.deliveryPublishedAt), and(ne(v.method, 'callback_attestation'), sql`${v.expiresAt}<=now()`))),
  )).orderBy(v.createdAt).limit(BATCH));
  for (const row of rows) {
    try {
      await publishRow(row);
      failures.delete(row.id);
    } catch (err) {
      await handleRowFailure(row, err);
    }
  }
}

type Row = typeof v.$inferSelect;

async function handleRowFailure(row: Row, err: unknown): Promise<void> {
  const error = err instanceof Error ? err : new Error(String(err));
  console.error('[CallerVerificationPublisher] Row failed:', { verificationId: row.id, error: error.name });
  captureException(error, undefined, { verificationId: row.id });
  const count = (failures.get(row.id) ?? 0) + 1;
  failures.set(row.id, count);
  if (count < MAX_DELIVERY_FAILURES || row.status !== 'pending' || row.method === 'callback_attestation') return;
  failures.delete(row.id);
  try {
    // Workstation give-ups use helper_outdated: it is the only workstation
    // reason in the frozen undeliverable set, and the actionable advice
    // (check the agent and Assist helper on that device) is the same.
    const reason = row.method === 'sms' ? 'sms_failed' : row.method === 'workstation' ? 'helper_outdated' : 'email_failed';
    await applyDecision({ verificationId: row.id, decision: { kind: 'undeliverable', reason } });
  } catch (inner) {
    captureException(inner instanceof Error ? inner : new Error(String(inner)), undefined, { verificationId: row.id });
  }
}

async function publishRow(row: Row): Promise<void> {
  {
    // Administrative rows carry no caller challenge: notify security, then mark.
    // Never routed through `ports.deliver`. The marker is independent of
    // `rejectionNotifiedAt`, so a later rejection still reaches the branch below.
    if (row.method === 'administrative_stepup' && !row.deliveryPublishedAt) {
      // In-app first (deduplicated, so a retry never duplicates it); email is
      // best-effort per recipient so one bad address or a missing transport
      // can neither block the in-app record nor re-email earlier recipients.
      // The administrative audit row was written transactionally at creation.
      const recipients = await scoped(() => securityRecipients(row.orgId));
      if (recipients.length === 0) {
        const error = new Error('Administrative disable authorised but the org has no security notification recipients');
        console.error('[CallerVerificationPublisher]', { verificationId: row.id, orgId: row.orgId, error: error.message });
        captureException(error, undefined, { verificationId: row.id });
      }
      for (const person of recipients) {
        await scoped(() => createNotification({
          userId: person.id, orgId: row.orgId, type: 'security', priority: 'high',
          title: 'Administrative account disable authorised',
          message: row.reason ?? 'Review the contact verification record.',
          link: '/security/incidents',
          dedupeKey: `caller-administrative-${row.id}`,
          metadata: { verificationId: row.id, contactId: row.contactId },
        }));
      }
      const email = getEmailService();
      if (!email && recipients.length > 0) {
        captureException(new Error('Administrative notification email transport unavailable; in-app notifications sent'), undefined, { verificationId: row.id });
      }
      for (const person of email ? recipients : []) {
        try {
          await email!.sendEmail({
            to: person.email,
            subject: 'Administrative account disable authorised',
            html: '<p>Review the administrative verification and its reason in Breeze.</p>',
            text: `Administrative verification ${row.id}. Reason: ${row.reason ?? ''}`,
            headers: { 'Message-ID': `<caller-admin-${row.id}-${person.id}@notifications.invalid>` },
            purpose: 'security.caller_rejection',
          });
        } catch (err) {
          captureException(err instanceof Error ? err : new Error(String(err)), undefined, { verificationId: row.id, recipientId: person.id });
        }
      }
      await scoped(() => db.update(v).set({ deliveryPublishedAt: new Date() }).where(eq(v.id, row.id)));
      return;
    }
    if (row.method === 'administrative_stepup' && row.status !== 'rejected_by_user') return;
    if (row.status === 'pending') {
      if (row.method !== 'callback_attestation' && row.expiresAt.getTime() <= Date.now()) {
        await applyDecision({ verificationId: row.id, decision: { kind: 'timeout' } });
        return;
      }
      if (row.method !== 'callback_attestation') await callerVerificationPorts.deliver(row.id);
      await scoped(() => db.update(v).set({ deliveryPublishedAt: new Date() }).where(eq(v.id, row.id)));
      return;
    }
    const recipients = await scoped(() => securityRecipients(row.orgId));
    const email = getEmailService();
    if (!email) throw new Error('Caller rejection email transport unavailable');
    for (const person of recipients) {
      await scoped(() => createNotification({
        userId: person.id, orgId: row.orgId, type: 'security', priority: 'high',
        title: 'Caller rejected an identity-change request',
        message: 'The subject is fenced. Review the security incident.',
        link: '/security/incidents',
        dedupeKey: `caller-rejection-${row.id}`,
        metadata: { verificationId: row.id },
      }));
      await email.sendEmail({
        to: person.email,
        subject: 'Caller verification security incident',
        html: '<p>A caller rejected an identity-change request. Open Breeze security incidents to review the subject fence and related actions.</p>',
        text: 'A caller rejected an identity-change request. Open Breeze security incidents to review.',
        headers: { 'Message-ID': `<caller-${row.id}-${person.id}@notifications.invalid>` },
        purpose: 'security.caller_rejection',
      });
    }
    await scoped(() => db.update(v).set({ rejectionNotifiedAt: new Date() }).where(eq(v.id, row.id)));
  }
}

let queue: Queue | null = null;
let worker: Worker | null = null;

export async function initializeCallerVerificationPublisher(): Promise<void> {
  if (worker) return;
  queue = new Queue(QUEUE_NAME, { connection: getBullMQConnection() });
  worker = new Worker(QUEUE_NAME, async () => {
    try {
      await publishCallerVerificationEffects();
    } catch (err) {
      console.error('[CallerVerificationPublisher] Run failed:', err);
      captureException(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }, { connection: getBullMQConnection(), concurrency: 1 });
  attachWorkerObservability(worker, 'callerVerificationPublisher');
  worker.on('error', (error) => {
    console.error('[CallerVerificationPublisher] Worker error:', error);
    captureException(error);
  });
  try {
    for (const job of await queue.getRepeatableJobs()) {
      if (job.name === JOB_NAME) await queue.removeRepeatableByKey(job.key);
    }
    await queue.add(JOB_NAME, {}, { jobId: JOB_ID, repeat: { every: PUBLISH_INTERVAL_MS }, removeOnComplete: { count: 20 }, removeOnFail: { count: 100 } });
  } catch (err) {
    await worker.close();
    await queue.close();
    worker = null;
    queue = null;
    throw err;
  }
}

export async function shutdownCallerVerificationPublisher(): Promise<void> {
  await worker?.close();
  await queue?.close();
  worker = null;
  queue = null;
}
