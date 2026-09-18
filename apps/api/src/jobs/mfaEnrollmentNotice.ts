/**
 * MFA Enrollment Notice Sweep
 *
 * #5306 — the email-nudge half of the MFA enrolment grace window. The DB half
 * (services/mfaEnrollmentGrace.ts) grants a per-user, nonrenewable deadline
 * the first time a role-forced user with no factor is evaluated;
 * getEffectiveMfaPolicy surfaces that as `pendingEnrollment` while the window
 * is open. This worker is the daily sweep that emails those users twice:
 * once when the window opens, once with three days left.
 *
 * Shape follows jobs/contractWorker.ts: queue + worker + repeatable schedule
 * via scheduleRegistry.
 *
 * Candidate rows are read in ONE system-context query (loadCandidates). Every
 * per-user step that follows — getEffectiveMfaPolicy, locale resolution, the
 * claim UPDATE — opens its OWN fresh system context. getEffectiveMfaPolicy
 * already self-wraps one; calling it (or resolveRecipientLocale) while
 * another context is still held would double-pin a pooled connection under
 * the same request, which is exactly the pattern this file's callers must
 * avoid (see db/index.ts's withDbAccessContext header).
 *
 * `pendingEnrollment` is re-checked per user rather than trusted from the
 * candidate read: a single boolean covers the kill switch being off, the
 * role's force_mfa having been removed, a factor having been enrolled since,
 * and the window having lapsed — so a stale candidate row is simply skipped,
 * never emailed.
 *
 * Claim stamps are written only AFTER a successful send, one `UPDATE ... WHERE
 * id = $1 AND <col> IS NULL` per column, so a failed send leaves the column
 * untouched and retries on tomorrow's sweep. When both notices are due in the
 * same run (a short configured grace window), only the T-3 reminder is sent —
 * but BOTH stamps are claimed, so the start notice is never sent late.
 */

import { Queue, Worker } from 'bullmq';
import { sql } from 'drizzle-orm';
import type { SupportedLocale } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { getEffectiveMfaPolicy } from '../services/mfaPolicy';
import { resolveRecipientLocale } from '../services/recipientLocale';
import { tApi } from '../i18n';
import { getEmailService } from '../services/email';
import { escapeHtml, renderButton, renderLayout, renderParagraph } from '../services/emailLayout';
import { getFrontendBaseUrl } from '../services/c2cM365';
import { jobSchedule } from './scheduleRegistry';
import { attachWorkerObservability } from './workerObservability';

export const MFA_ENROLLMENT_NOTICE_QUEUE = 'mfa-enrollment-notice-jobs';
const SWEEP_CRON = jobSchedule('mfa-enrollment-notice-sweep');
/** Generous cap on a per-partner-instance daily candidate set; logged when hit. */
const CANDIDATE_LIMIT = 500;
const REMINDER_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
const SETUP_PATH = '/auth/mfa/setup';

let noticeQueue: Queue | null = null;
let noticeWorker: Worker | null = null;

/** Get or create the mfa-enrollment-notice-jobs queue. */
export function getMfaEnrollmentNoticeQueue(): Queue {
  if (!noticeQueue) {
    noticeQueue = new Queue(MFA_ENROLLMENT_NOTICE_QUEUE, { connection: getBullMQConnection() });
  }
  return noticeQueue;
}

type CandidateRow = {
  id: string;
  email: string;
  name: string;
  partner_id: string;
  org_id: string | null;
  notice_sent_at: string | Date | null;
  reminded_at: string | Date | null;
};

/**
 * ONE system-context read for the whole sweep. Selects only users whose
 * grace window is (per the persisted deadline) still open and who are due
 * for at least one of the two notices. The per-user loop re-derives the
 * AUTHORITATIVE deadline from getEffectiveMfaPolicy, since a partner may have
 * shortened `security.mfaEnrollmentGraceDays` after the grant — the effective
 * deadline can only be <= the persisted one, so this candidate set can never
 * miss a row the authoritative check would still consider due.
 */
async function loadCandidates(): Promise<CandidateRow[]> {
  const rows = await runOutsideDbContext(() => withSystemDbAccessContext(() => db.execute<CandidateRow>(sql`
    SELECT id, email, name, partner_id, org_id,
           mfa_enrollment_notice_sent_at AS notice_sent_at,
           mfa_enrollment_reminded_at AS reminded_at
      FROM users
     WHERE mfa_enrollment_deadline IS NOT NULL
       AND mfa_enrollment_deadline > now()
       AND mfa_enabled = false
       AND status = 'active'
       AND (
         mfa_enrollment_notice_sent_at IS NULL
         OR (mfa_enrollment_reminded_at IS NULL AND mfa_enrollment_deadline <= now() + interval '3 days')
       )
     ORDER BY mfa_enrollment_deadline
     LIMIT ${CANDIDATE_LIMIT}
  `), 'mfaEnrollmentNotice.loadCandidates'));

  if (rows.length >= CANDIDATE_LIMIT) {
    console.warn(
      `[MfaEnrollmentNotice] candidate read hit the ${CANDIDATE_LIMIT}-row cap; `
      + 'some due notices may be deferred to the next sweep',
    );
  }
  return rows;
}

/**
 * The claim-after-send rule keeps a failed delivery retrying — but only while
 * the window is still open. If sends keep failing until the deadline itself
 * passes, the row drops out of `loadCandidates` forever and the user is enforced
 * having never been warned, with nothing to distinguish that from "nobody was
 * due". Report those rows ONCE, and stamp them so the report does not repeat
 * every night for the rest of the account's life: the notice is moot now (the
 * user is already being bounced into enrollment), but the fact that it was
 * missed must be visible.
 */
async function reportMissedNotices(): Promise<number> {
  const rows = await runOutsideDbContext(() => withSystemDbAccessContext(() => db.execute<{ id: string }>(sql`
    UPDATE users
       SET mfa_enrollment_notice_sent_at = COALESCE(mfa_enrollment_notice_sent_at, now()),
           mfa_enrollment_reminded_at = COALESCE(mfa_enrollment_reminded_at, now())
     WHERE mfa_enrollment_deadline IS NOT NULL
       AND mfa_enrollment_deadline <= now()
       -- A zero-length window (the partner set mfaEnrollmentGraceDays = 0, i.e.
       -- "enforce immediately") never had a notice to deliver, so it is not a
       -- miss. Excluding it keeps this report meaningful instead of counting
       -- every deliberately-immediate enforcement as a failure.
       AND mfa_enrollment_deadline > mfa_enrollment_grace_granted_at
       AND (mfa_enrollment_notice_sent_at IS NULL OR mfa_enrollment_reminded_at IS NULL)
    RETURNING id
  `), 'mfaEnrollmentNotice.reportMissed'));

  if (rows.length > 0) {
    const sample = rows.slice(0, 20).map((r) => r.id).join(', ');
    console.warn(
      `[MfaEnrollmentNotice] ${rows.length} enrolment window(s) lapsed without every notice being `
      + `delivered (enforcement is unaffected); users: ${sample}`
      + (rows.length > 20 ? ' …' : ''),
    );
  }
  return rows.length;
}

type NoticeKind = 'notice' | 'reminder';

function buildNoticeEmail(
  kind: NoticeKind,
  locale: SupportedLocale,
  vars: { name: string; deadline: string; url: string },
): { subject: string; html: string; text: string } {
  const ns = kind === 'reminder' ? 'mfaEnrollmentReminder' : 'mfaEnrollmentNotice';
  const subject = tApi(locale, `emails:${ns}.subject`, vars);
  const preheader = tApi(locale, `emails:${ns}.preheader`, vars);
  const heading = tApi(locale, `emails:${ns}.heading`, vars);
  const body = tApi(locale, `emails:${ns}.body`, vars);
  const button = tApi(locale, `emails:${ns}.button`, vars);

  const html = renderLayout({
    title: subject,
    preheader,
    heading,
    // The whole rendered body is escaped, not just the template: `name` is
    // account-owned free text and i18next's interpolation is deliberately
    // unescaped (see i18n/index.ts), so this is the one place that boundary
    // is enforced for this template — same pattern as buildAiBudgetAlertEmail.
    body: [renderParagraph(escapeHtml(body)), renderButton(button, vars.url)].join('\n'),
  });
  const text = [body, '', `${button}: ${vars.url}`].join('\n');
  return { subject, html, text };
}

/** Claim one notice column. Idempotent no-op if another sweep already claimed it. */
async function claimNoticeColumn(userId: string, column: 'notice_sent_at' | 'reminded_at'): Promise<void> {
  await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    if (column === 'notice_sent_at') {
      await db.execute(sql`
        UPDATE users SET mfa_enrollment_notice_sent_at = now()
         WHERE id = ${userId}::uuid AND mfa_enrollment_notice_sent_at IS NULL
      `);
    } else {
      await db.execute(sql`
        UPDATE users SET mfa_enrollment_reminded_at = now()
         WHERE id = ${userId}::uuid AND mfa_enrollment_reminded_at IS NULL
      `);
    }
  }, 'mfaEnrollmentNotice.claim'));
}

export interface MfaEnrollmentNoticeSweepResult {
  candidates: number;
  sent: number;
  skipped: number;
  failed: number;
  /** Windows that lapsed with a notice still undelivered — reported once, then stamped. */
  missed: number;
}

/**
 * Run the sweep once. Exported for the BullMQ handler and for tests. One
 * user's failure (a bad send, a transient DB error) is caught, logged and
 * reported — it never aborts the rest of the sweep.
 */
export async function runMfaEnrollmentNoticeSweep(): Promise<MfaEnrollmentNoticeSweepResult> {
  const rows = await loadCandidates();

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const policy = await getEffectiveMfaPolicy({
        scope: row.org_id ? 'organization' : 'partner',
        userId: row.id,
        orgId: row.org_id ?? null,
        partnerId: row.partner_id ?? null,
      });

      // Single check that covers: kill switch off, role force removed, a
      // factor enrolled meanwhile, and the window having lapsed.
      if (!policy.pendingEnrollment) {
        skipped++;
        continue;
      }

      const deadlineMs = new Date(policy.pendingEnrollment.deadline).getTime();
      const reminderDue = row.reminded_at == null && (deadlineMs - Date.now()) <= REMINDER_WINDOW_MS;
      const noticeDue = row.notice_sent_at == null;

      let kind: NoticeKind | null = null;
      let claimNotice = false;
      let claimReminder = false;
      if (reminderDue) {
        kind = 'reminder';
        claimReminder = true;
        // Both due in the same run (a short configured grace window): send
        // only the reminder, but claim the start-notice stamp too so it is
        // never sent late (and never sent at all, once the reminder covers it).
        if (noticeDue) claimNotice = true;
      } else if (noticeDue) {
        kind = 'notice';
        claimNotice = true;
      }

      if (!kind) {
        // Not reachable given the candidate query's WHERE clause, but never
        // send a notice this sweep cannot classify.
        skipped++;
        continue;
      }

      const emailService = getEmailService();
      if (!emailService) {
        throw new Error('email service is not configured');
      }

      const locale = await runOutsideDbContext(() => withSystemDbAccessContext(
        () => resolveRecipientLocale({ userId: row.id }),
        'mfaEnrollmentNotice.locale',
      ));

      const deadlineText = new Intl.DateTimeFormat(locale, {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      }).format(new Date(deadlineMs));
      const url = `${getFrontendBaseUrl()}${SETUP_PATH}`;
      const { subject, html, text } = buildNoticeEmail(kind, locale, { name: row.name, deadline: deadlineText, url });

      // Only after a successful send do we claim — a failed send must retry
      // tomorrow, never be silently suppressed.
      await emailService.sendEmail({ to: row.email, subject, html, text, purpose: 'security.mfa_enrollment' });

      if (claimNotice) await claimNoticeColumn(row.id, 'notice_sent_at');
      if (claimReminder) await claimNoticeColumn(row.id, 'reminded_at');

      sent++;
    } catch (err) {
      failed++;
      console.error(
        '[MfaEnrollmentNotice] failed for user', row.id,
        err instanceof Error ? err.message : err,
      );
      captureException(err instanceof Error ? err : new Error(String(err)));
    }
  }

  // After the send pass, so a row that just succeeded is not counted as missed.
  let missed = 0;
  try {
    missed = await reportMissedNotices();
  } catch (err) {
    console.error('[MfaEnrollmentNotice] missed-notice report failed', err instanceof Error ? err.message : err);
    captureException(err instanceof Error ? err : new Error(String(err)));
  }

  console.log(
    `[MfaEnrollmentNotice] sweep complete: candidates=${rows.length} sent=${sent} `
    + `skipped=${skipped} failed=${failed} missed=${missed}`,
  );
  return { candidates: rows.length, sent, skipped, failed, missed };
}

/** Create the mfa-enrollment-notice BullMQ worker. */
export function createMfaEnrollmentNoticeWorker(): Worker {
  return new Worker(
    MFA_ENROLLMENT_NOTICE_QUEUE,
    async (job) => {
      if (job.name === 'sweep') return runMfaEnrollmentNoticeSweep();
      throw new Error(`Unknown mfa-enrollment-notice job: ${job.name}`);
    },
    { connection: getBullMQConnection(), concurrency: 1 },
  );
}

/** Schedule the daily sweep, clearing any existing repeatables first. */
export async function scheduleMfaEnrollmentNoticeJobs(): Promise<void> {
  const queue = getMfaEnrollmentNoticeQueue();

  const existing = await queue.getRepeatableJobs();
  for (const job of existing) {
    await queue.removeRepeatableByKey(job.key);
  }

  await queue.add(
    'sweep',
    { type: 'sweep' },
    {
      repeat: { pattern: SWEEP_CRON },
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 50 },
    },
  );

  console.log('[MfaEnrollmentNotice] Scheduled daily enrolment notice sweep');
}

/** Initialize the worker + schedule repeatables. Call during app startup. */
export async function initializeMfaEnrollmentNoticeWorker(): Promise<void> {
  try {
    noticeWorker = createMfaEnrollmentNoticeWorker();
    attachWorkerObservability(noticeWorker, 'mfaEnrollmentNoticeWorker');

    await scheduleMfaEnrollmentNoticeJobs();

    console.log('[MfaEnrollmentNotice] worker initialized');
  } catch (error) {
    console.error('[MfaEnrollmentNotice] Failed to initialize:', error);
    throw error;
  }
}

/** Shutdown the worker + queue gracefully. */
export async function shutdownMfaEnrollmentNoticeWorker(): Promise<void> {
  if (noticeWorker) {
    await noticeWorker.close();
    noticeWorker = null;
  }
  if (noticeQueue) {
    await noticeQueue.close();
    noticeQueue = null;
  }
  console.log('[MfaEnrollmentNotice] worker shut down');
}
