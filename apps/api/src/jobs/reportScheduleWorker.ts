/**
 * Report schedule worker.
 *
 * Executes saved reports whose `schedule` is daily/weekly/monthly. Until this
 * worker existed the builder let users pick a cadence (persisted on
 * `reports.schedule` + `config.schedule.{time,day,date}`) but nothing ever ran
 * them — schedules were silently dead.
 *
 * - `check-schedules` repeats every 5 minutes, computes each report's most
 *   recent scheduled occurrence in the org's timezone (org -> partner -> UTC
 *   chain, same resolution the rest of the platform uses), and enqueues a run
 *   when `lastGeneratedAt` predates that occurrence.
 * - `run-scheduled-report` mirrors the on-demand POST /reports/:id/generate
 *   path: insert a report_runs row, generateReport, store the snapshot. When
 *   `config.emailRecipients` is set, recipients get an email with the branded
 *   PDF attached for PDF-format reports (rendered server-side via
 *   @breeze/shared/reportPdf) or a CSV attachment for tabular formats — either
 *   way, plus an in-app link.
 * - Without Redis the check falls back to inline processing, matching the
 *   other queue workers.
 */

import { and, eq, ne } from 'drizzle-orm';
import { Job, Queue, Worker } from 'bullmq';

import * as dbModule from '../db';
import { reports, reportRuns, organizations, partners } from '../db/schema';
import { generateReport, previousBaselineFor, type ReportResult } from '../services/reportGenerationService';
import { getEmailService } from '../services/email';
import { renderLayout, renderButton, renderParagraph, escapeHtml } from '../services/emailLayout';
import { getBullMQConnection, isRedisAvailable } from '../services/redis';
import {
  resolveEffectiveTimezone,
  canonicalizeTimezone,
  rowsToCsv,
  lastOccurrenceKey,
  isDue,
  type ScheduleCadence,
  type ScheduleConfig,
} from '@breeze/shared';
import { buildReportPdf, type ReportBranding } from '@breeze/shared/reportPdf';
import type { PostureSummary, ExecutiveSummary } from '@breeze/shared';
import { loadReportBrandingForOrg } from '../services/reportBranding';
import { captureException } from '../services/sentry';
import { attachWorkerObservability } from './workerObservability';

// Re-exported so the occurrence-math tests colocated with this worker keep
// importing from here; the implementation lives in @breeze/shared so the web
// can compute "next run" from the same math.
export { lastOccurrenceKey, isDue, wallClockIn } from '@breeze/shared';
export type { ScheduleCadence, ScheduleConfig } from '@breeze/shared';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

const REPORT_SCHEDULE_QUEUE = 'report-schedules';
const CHECK_INTERVAL_MS = 5 * 60 * 1000;
/** Attempts per `run-scheduled-report` job before the occurrence is given up on. */
const RUN_JOB_ATTEMPTS = 3;
// Attachments above this size are dropped in favour of the in-app link.
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

interface CheckSchedulesJobData {
  type: 'check-schedules';
}

interface RunScheduledReportJobData {
  type: 'run-scheduled-report';
  reportId: string;
  /** Wall-clock occurrence key the run was enqueued for (dedupe + audit). */
  occurrenceKey: number;
}

type ReportScheduleJobData = CheckSchedulesJobData | RunScheduledReportJobData;

let reportScheduleQueue: Queue<ReportScheduleJobData> | null = null;
let reportScheduleWorker: Worker<ReportScheduleJobData> | null = null;

// ─── Due-report discovery ────────────────────────────────────────────────────

type DueCandidate = {
  id: string;
  schedule: ScheduleCadence;
  lastGeneratedAt: Date | null;
  config: Record<string, unknown>;
  timeZone: string;
};

function scheduleConfigOf(config: Record<string, unknown>): ScheduleConfig {
  const raw = config.schedule;
  return raw && typeof raw === 'object' ? (raw as ScheduleConfig) : {};
}

// Org -> partner -> UTC timezone chain (no site axis for org-level reports),
// same source-of-truth rules as featureConfigResolver's partnerTimezoneFrom.
function timezoneFor(
  orgSettings: unknown,
  partnerTzColumn: string | null,
  partnerSettings: unknown,
): string {
  const orgTz =
    orgSettings && typeof orgSettings === 'object'
      ? (orgSettings as Record<string, unknown>).timezone
      : null;
  const partnerColumn = canonicalizeTimezone(partnerTzColumn);
  const partnerFromSettings =
    partnerSettings && typeof partnerSettings === 'object'
      ? (partnerSettings as Record<string, unknown>).timezone
      : null;
  const partnerTz =
    partnerColumn !== null && partnerColumn !== 'UTC'
      ? partnerColumn
      : typeof partnerFromSettings === 'string' && partnerFromSettings.length > 0
        ? partnerFromSettings
        : partnerColumn;
  return resolveEffectiveTimezone({
    siteTz: null,
    orgTz: typeof orgTz === 'string' ? orgTz : null,
    partnerTz,
  });
}

export async function findDueReports(now: Date): Promise<Array<{ id: string; occurrenceKey: number }>> {
  const rows = await db
    .select({
      id: reports.id,
      schedule: reports.schedule,
      lastGeneratedAt: reports.lastGeneratedAt,
      config: reports.config,
      orgSettings: organizations.settings,
      partnerTimezone: partners.timezone,
      partnerSettings: partners.settings,
    })
    .from(reports)
    .innerJoin(organizations, eq(reports.orgId, organizations.id))
    .leftJoin(partners, eq(organizations.partnerId, partners.id))
    .where(ne(reports.schedule, 'one_time'));

  const due: Array<{ id: string; occurrenceKey: number }> = [];
  for (const row of rows) {
    const candidate: DueCandidate = {
      id: row.id,
      schedule: row.schedule as ScheduleCadence,
      lastGeneratedAt: row.lastGeneratedAt,
      config: (row.config ?? {}) as Record<string, unknown>,
      timeZone: timezoneFor(row.orgSettings, row.partnerTimezone, row.partnerSettings),
    };
    const key = lastOccurrenceKey(now, candidate.schedule, scheduleConfigOf(candidate.config), candidate.timeZone);
    if (isDue(candidate.lastGeneratedAt, key, candidate.timeZone)) {
      due.push({ id: candidate.id, occurrenceKey: key });
    }
  }
  return due;
}

// ─── Execution ───────────────────────────────────────────────────────────────

function recipientsOf(config: Record<string, unknown>): string[] {
  const raw = config.emailRecipients;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r): r is string => typeof r === 'string')
    .map((r) => r.trim())
    .filter((r) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r));
}

/** One-line trend summary for the email body — "Posture score 79 — up from
 * 74 last run." — built from the same `result.summary`/`result.previous`
 * snapshot the PDF scorecard reads, so the two never disagree. */
function trendLineOf(result: ReportResult): string | null {
  const s = result.summary as Record<string, unknown> | undefined;
  const prev = result.previous?.summary as Record<string, unknown> | undefined;
  const score = typeof s?.postureScore === 'number' ? (s.postureScore as number) : null;
  if (score != null) {
    const prevScore = typeof prev?.postureScore === 'number' ? (prev.postureScore as number) : null;
    if (prevScore != null && prevScore !== score) {
      return `Posture score ${score} — ${score > prevScore ? 'up' : 'down'} from ${prevScore} last run.`;
    }
    return `Posture score ${score}.`;
  }
  const health = (s?.devices as { healthPercentage?: unknown } | undefined)?.healthPercentage;
  if (typeof health === 'number') {
    const prevHealth = (prev?.devices as { healthPercentage?: unknown } | undefined)?.healthPercentage;
    if (typeof prevHealth === 'number' && prevHealth !== health) {
      return `Fleet health ${health}% — ${health > prevHealth ? 'up' : 'down'} from ${prevHealth}% last run.`;
    }
    return `Fleet health ${health}%.`;
  }
  return null;
}

/**
 * Tells recipients their scheduled report did not arrive. Without this a failed
 * occurrence is silent end-to-end: the job is not retried again after its final
 * attempt, `lastGeneratedAt` has already moved past the occurrence, and the only
 * record is a `failed` report_runs row nobody is watching.
 *
 * Deliberately omits the underlying error: it reaches customer inboxes, and the
 * raw message can carry Zod issue arrays or PG schema details. Operators get the
 * real message on the run row and in Sentry.
 */
async function emailReportFailure(opts: {
  reportName: string;
  recipients: string[];
}): Promise<void> {
  const email = getEmailService();
  if (!email) {
    console.warn('[ReportScheduleWorker] Email service not configured; cannot notify failure for', opts.reportName);
    return;
  }
  const base = (process.env.DASHBOARD_URL || process.env.PUBLIC_APP_URL || 'http://localhost:4321').replace(/\/$/, '');
  const html = renderLayout({
    title: 'Scheduled report failed',
    preheader: `${opts.reportName} could not be generated`,
    heading: 'Scheduled report failed',
    body: [
      renderParagraph(
        `We couldn't generate <strong>${escapeHtml(opts.reportName)}</strong> for its scheduled run. No report was produced.`,
      ),
      renderParagraph('Your team can run it manually, or wait for the next scheduled occurrence.'),
      renderButton('View reports', `${base}/reports`),
    ].join(''),
  });

  await email.sendEmail({
    to: opts.recipients,
    subject: `Scheduled report failed: ${opts.reportName}`,
    html,
  });
}

async function emailReportRun(opts: {
  reportName: string;
  reportType: string;
  format: string;
  recipients: string[];
  rows: unknown[];
  summary?: Record<string, unknown>;
  previous?: ReportResult['previous'];
  trendLine?: string | null;
  timezone: string;
  branding: ReportBranding;
}): Promise<void> {
  const email = getEmailService();
  if (!email) {
    console.warn('[ReportScheduleWorker] Email service not configured; skipping recipients for', opts.reportName);
    return;
  }
  const base = (process.env.DASHBOARD_URL || process.env.PUBLIC_APP_URL || 'http://localhost:4321').replace(/\/$/, '');
  const link = `${base}/reports`;
  const dateStr = new Date().toISOString().split('T')[0];

  const attachments = [] as Array<{ filename: string; content: Buffer; contentType?: string }>;
  if (opts.format === 'pdf') {
    // The branded PDF is the deliverable an MSP wants landing in the client's
    // inbox — render it here exactly as the web does (same shared renderer).
    try {
      const generatedAt = new Intl.DateTimeFormat('en-US', {
        timeZone: opts.timezone, dateStyle: 'medium', timeStyle: 'short',
      }).format(new Date());
      const doc = buildReportPdf(opts.rows, {
        reportType: opts.reportType,
        generatedAt,
        timezone: opts.timezone,
        summary: opts.summary as PostureSummary | ExecutiveSummary | undefined,
        previous: opts.previous,
        branding: opts.branding,
      });
      const content = Buffer.from(doc.output('arraybuffer'));
      if (content.byteLength <= MAX_ATTACHMENT_BYTES) {
        attachments.push({ filename: `${opts.reportType}-report-${dateStr}.pdf`, content, contentType: 'application/pdf' });
      } else {
        console.warn('[ReportScheduleWorker] Attachment exceeds 5MB; sending link-only', {
          reportName: opts.reportName,
          bytes: content.byteLength,
        });
      }
    } catch (err) {
      // A render failure must not block delivery — fall back to the link-only email.
      console.error('[ReportScheduleWorker] PDF render failed; sending link-only email:', err);
    }
  } else if (opts.rows.length > 0) {
    const csv = rowsToCsv(opts.rows);
    const content = Buffer.from(csv, 'utf8');
    if (content.byteLength <= MAX_ATTACHMENT_BYTES) {
      attachments.push({ filename: `${opts.reportType}-report-${dateStr}.csv`, content, contentType: 'text/csv' });
    } else {
      console.warn('[ReportScheduleWorker] Attachment exceeds 5MB; sending link-only', {
        reportName: opts.reportName,
        bytes: content.byteLength,
      });
    }
  }

  const bodyText =
    opts.rows.length > 0
      ? `Your scheduled report "${opts.reportName}" has been generated with ${opts.rows.length} record${opts.rows.length === 1 ? '' : 's'}.`
      : `Your scheduled report "${opts.reportName}" has been generated.`;
  const attachmentNote =
    attachments.length === 0
      ? 'Open Breeze to view and download the formatted report.'
      : attachments[0]!.contentType === 'application/pdf'
        ? 'The formatted report is attached as a PDF.'
        : 'The data is attached as CSV; open Breeze for the fully formatted report.';

  const trendLine = opts.trendLine;

  await email.sendEmail({
    to: opts.recipients,
    subject: `Scheduled report ready: ${opts.reportName}`,
    html: renderLayout({
      title: 'Scheduled report',
      preheader: trendLine ?? bodyText,
      heading: 'Scheduled report ready',
      body: [
        renderParagraph(escapeHtml(bodyText)),
        ...(trendLine ? [renderParagraph(escapeHtml(trendLine))] : []),
        renderParagraph(escapeHtml(attachmentNote), { muted: true }),
        renderButton('View in Breeze', link),
      ].join(''),
    }),
    text: `${bodyText}${trendLine ? `\n${trendLine}` : ''}\n${attachmentNote}\n${link}`,
    attachments,
  });
}

export async function processRunScheduledReport(
  data: RunScheduledReportJobData,
  opts: { finalAttempt?: boolean } = {},
): Promise<void> {
  const [report] = await db
    .select()
    .from(reports)
    .where(and(eq(reports.id, data.reportId), ne(reports.schedule, 'one_time')))
    .limit(1);
  if (!report) return; // deleted or switched to one_time since enqueue

  const config = (report.config ?? {}) as Record<string, unknown>;

  const [run] = await db
    .insert(reportRuns)
    .values({ reportId: report.id, status: 'running', startedAt: new Date() })
    .returning();
  if (!run) throw new Error(`Failed to create run for scheduled report ${report.id}`);

  // Stamp lastGeneratedAt up front so a crash mid-generation doesn't cause a
  // tight retry loop every check interval; the failed run row records the error.
  await db
    .update(reports)
    .set({ lastGeneratedAt: new Date(), updatedAt: new Date() })
    .where(eq(reports.id, report.id));

  try {
    // System context: scheduled runs execute with full org scope (no user
    // site-permission filter — parity with a report owner generating it).
    const result = await generateReport(report.type, report.orgId, config, undefined);
    const previous = await previousBaselineFor(report.id);
    if (previous) result.previous = previous;
    const rows = Array.isArray(result.rows) ? result.rows : [];
    const rowCount = result.rowCount ?? rows.length;
    await db
      .update(reportRuns)
      .set({
        status: 'completed',
        completedAt: new Date(),
        outputUrl: `/api/reports/runs/${run.id}/download`,
        result,
        rowCount,
      })
      .where(eq(reportRuns.id, run.id));

    const recipients = recipientsOf(config);
    if (recipients.length > 0) {
      try {
        // Timezone + branding are only needed to build the email — deferred
        // here (rather than fetched unconditionally for every run) so a
        // transient failure in either lookup can't sink a no-recipient run's
        // occurrence-keyed job (a failed job blocks re-enqueue of that
        // occurrence, and by this point the run row is already stored).
        const [tzRow] = await db
          .select({ orgSettings: organizations.settings, partnerTimezone: partners.timezone, partnerSettings: partners.settings })
          .from(organizations)
          .leftJoin(partners, eq(organizations.partnerId, partners.id))
          .where(eq(organizations.id, report.orgId))
          .limit(1);
        const timeZone = timezoneFor(tzRow?.orgSettings ?? null, tzRow?.partnerTimezone ?? null, tzRow?.partnerSettings ?? null);
        const branding = await loadReportBrandingForOrg(report.orgId).catch((err) => {
          console.error('[ReportScheduleWorker] Branding load failed; sending unbranded:', err);
          return { name: null, logoDataUrl: null, logoAspect: null };
        });

        await emailReportRun({
          reportName: report.name,
          reportType: report.type,
          format: report.format,
          recipients,
          rows,
          summary: result.summary,
          previous: result.previous,
          trendLine: trendLineOf(result),
          timezone: timeZone,
          branding,
        });
      } catch (err) {
        // Delivery failure must not fail the (already stored) run.
        console.error(`[ReportScheduleWorker] Email delivery failed for report ${report.id}:`, err);
      }
    }
  } catch (err) {
    await db
      .update(reportRuns)
      .set({
        status: 'failed',
        completedAt: new Date(),
        errorMessage: err instanceof Error ? err.message : 'Failed to generate report',
      })
      .where(eq(reportRuns.id, run.id));

    // Only once the job is out of retries: an earlier attempt may still succeed,
    // and this occurrence will not be re-enqueued after the last one fails.
    if (opts.finalAttempt) {
      const recipients = recipientsOf(config);
      if (recipients.length > 0) {
        try {
          await emailReportFailure({ reportName: report.name, recipients });
        } catch (notifyErr) {
          console.error(`[ReportScheduleWorker] Failure notice undeliverable for report ${report.id}:`, notifyErr);
        }
      }
    }
    throw err;
  }
}

export async function processCheckSchedules(): Promise<void> {
  const due = await findDueReports(new Date());
  if (due.length === 0) return;
  console.log(`[ReportScheduleWorker] ${due.length} scheduled report(s) due`);

  for (const item of due) {
    if (!isRedisAvailable()) {
      // Inline mode has no queue to absorb a throw, so one failing report would
      // abort the loop and silently starve every remaining org's reports.
      // There is no retry here either, hence finalAttempt.
      try {
        await processRunScheduledReport(
          { type: 'run-scheduled-report', reportId: item.id, occurrenceKey: item.occurrenceKey },
          { finalAttempt: true },
        );
      } catch (err) {
        console.error(`[ReportScheduleWorker] Inline run failed for report ${item.id}:`, err);
        captureException(err);
      }
      continue;
    }
    // Occurrence-keyed jobId dedupes double-enqueue across overlapping checks.
    await getReportScheduleQueue().add(
      'run-scheduled-report',
      { type: 'run-scheduled-report', reportId: item.id, occurrenceKey: item.occurrenceKey },
      {
        jobId: `report-sched-run-${item.id}-${item.occurrenceKey}`,
        // A transient blip must not cost the whole occurrence: lastGeneratedAt is
        // stamped before generation (deliberately — it stops a failed report from
        // being re-found due every check interval), so once these attempts are
        // spent the occurrence is gone until the next one.
        attempts: RUN_JOB_ATTEMPTS,
        backoff: { type: 'exponential', delay: 30_000 },
        removeOnComplete: { count: 500 },
        removeOnFail: { count: 500 },
      },
    );
  }
}

// ─── Queue / worker lifecycle ────────────────────────────────────────────────

export function getReportScheduleQueue(): Queue<ReportScheduleJobData> {
  if (!reportScheduleQueue) {
    reportScheduleQueue = new Queue<ReportScheduleJobData>(REPORT_SCHEDULE_QUEUE, {
      connection: getBullMQConnection(),
    });
  }
  return reportScheduleQueue;
}

/** Inline scheduler for Redis-less deploys: check on an interval, run inline. */
let inlineTimer: ReturnType<typeof setInterval> | null = null;

export async function initializeReportScheduleWorker(): Promise<void> {
  if (!isRedisAvailable()) {
    if (!inlineTimer) {
      inlineTimer = setInterval(() => {
        runWithSystemDbAccess(processCheckSchedules).catch((err) => {
          console.error('[ReportScheduleWorker] Inline schedule check failed:', err);
        });
      }, CHECK_INTERVAL_MS);
      inlineTimer.unref?.();
      console.warn('[ReportScheduleWorker] Redis unavailable; using inline interval scheduler');
    }
    return;
  }

  if (reportScheduleWorker) return;

  reportScheduleWorker = new Worker<ReportScheduleJobData>(
    REPORT_SCHEDULE_QUEUE,
    async (job: Job<ReportScheduleJobData>) => {
      return runWithSystemDbAccess(async () => {
        switch (job.data.type) {
          case 'check-schedules':
            return processCheckSchedules();
          case 'run-scheduled-report': {
            // attemptsMade counts attempts already finished, so on the last one
            // it is attempts-1 and this run is the occurrence's final chance.
            const allowed = job.opts.attempts ?? 1;
            return processRunScheduledReport(job.data, {
              finalAttempt: job.attemptsMade + 1 >= allowed,
            });
          }
          default:
            throw new Error(`Unknown report schedule job type: ${(job.data as { type: string }).type}`);
        }
      });
    },
    {
      connection: getBullMQConnection(),
      concurrency: 2,
      lockDuration: 300_000,
      stalledInterval: 60_000,
      maxStalledCount: 2,
    },
  );
  attachWorkerObservability(reportScheduleWorker, 'reportScheduleWorker');
  reportScheduleWorker.on('error', (error) => {
    console.error('[ReportScheduleWorker] Worker error:', error);
  });
  reportScheduleWorker.on('failed', (job, error) => {
    console.error(`[ReportScheduleWorker] Job ${job?.id} failed:`, error);
  });

  const queue = getReportScheduleQueue();
  await queue.add(
    'check-schedules',
    { type: 'check-schedules' },
    {
      repeat: { every: CHECK_INTERVAL_MS },
      jobId: 'report-schedules-check',
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 50 },
    },
  );

  console.log('[ReportScheduleWorker] Initialized');
}

export async function shutdownReportScheduleWorker(): Promise<void> {
  if (inlineTimer) {
    clearInterval(inlineTimer);
    inlineTimer = null;
  }
  if (reportScheduleWorker) {
    await reportScheduleWorker.close();
    reportScheduleWorker = null;
  }
  if (reportScheduleQueue) {
    await reportScheduleQueue.close();
    reportScheduleQueue = null;
  }
  console.log('[ReportScheduleWorker] Shut down');
}
