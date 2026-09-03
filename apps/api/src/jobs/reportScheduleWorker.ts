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

import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  not,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import { Job, Queue, Worker } from 'bullmq';

import * as dbModule from '../db';
import { breezeRole } from '../config/env';
import { reports, reportRuns, organizations, partners } from '../db/schema';
import {
  assertReportExecutionPreflight,
  generateReport,
  previousBaselineFor,
  type ReportResult,
} from '../services/reportGenerationService';
import { getEmailService } from '../services/email';
import { renderLayout, renderButton, renderParagraph, escapeHtml } from '../services/emailLayout';
import { getBullMQConnection, isRedisAvailable } from '../services/redis';
import {
  rowsToCsv,
  lastOccurrenceKey,
  isDue,
  type ScheduleCadence,
  type ScheduleConfig,
} from '@breeze/shared';
import { buildReportPdf, type ReportBranding } from '@breeze/shared/reportPdf';
import type { PostureSummary, ExecutiveSummary } from '@breeze/shared';
import { loadReportBrandingForOrg } from '../services/reportBranding';
import {
  resolveOrgTimezone,
  resolveTimezoneFromRows,
} from '../services/portal/timezone';
import { captureException } from '../services/sentry';
import { attachWorkerObservability } from './workerObservability';
import {
  decodeSiteScope,
  intersectSiteScopes,
  persistedSiteScopeValues,
  resolveLiveReportAuthority,
  siteScopeFingerprint,
  type PersistedSiteScopeColumns,
  type ReportExecutionAuthority,
} from '../services/siteScope';

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

/**
 * P2-3 (#4190) — report types this worker must never poll for or execute.
 *
 * A weekly AI narrative definition lives in `reports` with `schedule =
 * 'weekly'`, so it matches the polling predicate on shape alone; its
 * occurrences belong to the AGENT scheduler, and its artifact is stored by the
 * run's own transaction rather than generated.
 *
 * Excluding it here does a second job that is easy to miss: it keeps those rows
 * out of the "requires scope reauthorization" warning count below. A system
 * definition has `execution_scope_user_id IS NULL` by construction, so it fails
 * `completeExecutableScope` forever — and without this exclusion the operator
 * signal would climb by one per org, per narrative schedule, pointing at rows
 * nobody can or should reauthorize.
 */
const WORKER_EXCLUDED_REPORT_TYPES = ['ai_org_narrative'] as const;

export async function findDueReports(
  now: Date,
): Promise<Array<{ id: string; occurrenceKey: number; lastGeneratedAt: Date | null }>> {
  // Applied to BOTH statements below — see WORKER_EXCLUDED_REPORT_TYPES.
  const pollable = and(
    ne(reports.schedule, 'one_time'),
    notInArray(reports.type, [...WORKER_EXCLUDED_REPORT_TYPES]),
  )!;
  const completeExecutableScope = and(
    eq(reports.executionScopeVersion, 1),
    inArray(reports.executionScopeKind, ['unrestricted', 'restricted']),
    isNotNull(reports.executionScopeUserId),
    isNotNull(reports.executionScopeFingerprint),
    isNotNull(reports.executionScopeCapturedAt),
    or(
      and(
        eq(reports.executionScopeKind, 'unrestricted'),
        isNull(reports.executionScopeSiteIds),
      ),
      and(
        eq(reports.executionScopeKind, 'restricted'),
        isNotNull(reports.executionScopeSiteIds),
      ),
    ),
  )!;
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
    .where(and(pollable, completeExecutableScope));

  const [skipped] = await db
    .select({ count: sql<number>`count(*)` })
    .from(reports)
    .where(and(pollable, not(completeExecutableScope)));
  const skippedCount = Number(skipped?.count ?? 0);
  if (skippedCount > 0) {
    console.warn(
      '[ReportScheduleWorker] Scheduled reports require scope reauthorization',
      { count: skippedCount },
    );
  }

  const due: Array<{ id: string; occurrenceKey: number; lastGeneratedAt: Date | null }> = [];
  for (const row of rows) {
    const candidate: DueCandidate = {
      id: row.id,
      schedule: row.schedule as ScheduleCadence,
      lastGeneratedAt: row.lastGeneratedAt,
      config: (row.config ?? {}) as Record<string, unknown>,
      timeZone: resolveTimezoneFromRows(row.orgSettings, row.partnerTimezone, row.partnerSettings),
    };
    const key = lastOccurrenceKey(now, candidate.schedule, scheduleConfigOf(candidate.config), candidate.timeZone);
    if (isDue(candidate.lastGeneratedAt, key, candidate.timeZone)) {
      due.push({ id: candidate.id, occurrenceKey: key, lastGeneratedAt: candidate.lastGeneratedAt });
    }
  }
  return due;
}

// ─── Occurrence claim (CAS) ──────────────────────────────────────────────────

/**
 * The inline (Redis-less) path's cross-tick winner predicate, extracted so
 * its COMPILED SQL can be asserted directly (see `reportScheduleWorker.claimSql.test.ts`
 * — a mocked-drizzle `.where(...)` assertion can only substring-match column
 * names, which cannot tell `eq` from `isNull` or notice a dropped id
 * predicate; either mutation would let two overlapping 5-minute ticks
 * double-generate the same occurrence). `observedLastGeneratedAt` is the value
 * `findDueReports` read when it decided the report was due — the CAS only
 * claims the row if nothing has changed it since.
 */
export function buildOccurrenceClaimCas(reportId: string, observedLastGeneratedAt: Date | null) {
  return and(
    eq(reports.id, reportId),
    observedLastGeneratedAt === null
      ? isNull(reports.lastGeneratedAt)
      : eq(reports.lastGeneratedAt, observedLastGeneratedAt),
  );
}

/**
 * Atomically claims a due occurrence for inline execution: stamps
 * `lastGeneratedAt` now, but ONLY if it still matches what was observed when
 * the occurrence was found due. Returns whether the claim won — a lost race
 * (another overlapping check already claimed it) returns false and the caller
 * skips the report rather than generating it twice.
 */
async function claimReportOccurrence(reportId: string, observedLastGeneratedAt: Date | null): Promise<boolean> {
  const now = new Date();
  const claimed = await db
    .update(reports)
    .set({ lastGeneratedAt: now, updatedAt: now })
    .where(buildOccurrenceClaimCas(reportId, observedLastGeneratedAt))
    .returning({ id: reports.id });
  return claimed.length > 0;
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
  opts: { finalAttempt?: boolean; occurrenceClaimed?: boolean } = {},
): Promise<void> {
  const [report] = await db
    .select()
    .from(reports)
    .where(and(eq(reports.id, data.reportId), ne(reports.schedule, 'one_time')))
    .limit(1);
  if (!report) return; // deleted or switched to one_time since enqueue

  // P2-3 (#4190) — a job already on the queue when the type exclusion in
  // `findDueReports` shipped, or one forced in by hand. An EARLY RETURN with no
  // run row, deliberately unlike the `deny()` paths below: a failed
  // `report_runs` row would render in the org's report history under the
  // narrative definition, beside the real weekly artifacts, claiming the weekly
  // narrative failed. It did not — this worker simply is not its owner.
  if ((WORKER_EXCLUDED_REPORT_TYPES as readonly string[]).includes(report.type)) {
    console.warn(
      '[ReportScheduleWorker] Skipping a report type owned by the agent scheduler',
      { reportId: report.id, orgId: report.orgId, type: report.type },
    );
    return;
  }

  const config = (report.config ?? {}) as Record<string, unknown>;

  const deny = async (reason: string): Promise<void> => {
    await db
      .insert(reportRuns)
      .values({
        reportId: report.id,
        status: 'failed',
        completedAt: new Date(),
        errorMessage: reason,
      })
      .returning();
  };

  // P2-3 (#4190) — defence in depth. A system-authored definition (the weekly
  // AI org narrative) has no acting user, so there is nobody for this worker to
  // reauthorize against; it is owned by the agent scheduler, not the report
  // scheduler. findDueReports already skips it (its executable-scope predicate
  // requires execution_scope_user_id NOT NULL) and A7 adds the type exclusion —
  // this refuses it even if a caller forces the job in directly, BEFORE any
  // scope decode or authority resolution can invent a principal.
  if (report.executionScopePrincipalKind === 'system') {
    console.warn(
      '[ReportScheduleWorker] Refusing a system-principal report definition',
      { reportId: report.id, orgId: report.orgId },
    );
    await deny('system_principal_definition');
    return;
  }

  let persistedScope;
  try {
    persistedScope = decodeSiteScope(
      report as unknown as PersistedSiteScopeColumns,
      report.orgId,
    );
  } catch {
    await deny('scope_unverifiable');
    return;
  }
  if (persistedScope.kind === 'legacy_unscoped') {
    await deny('scope_legacy_unscoped');
    return;
  }

  if (!report.executionScopeUserId) {
    await deny('scope_unverifiable');
    return;
  }

  let liveResult;
  try {
    liveResult = await resolveLiveReportAuthority(
      report.executionScopeUserId,
      report.orgId,
      'read',
    );
  } catch {
    await deny('scope_unverifiable');
    return;
  }
  if (!liveResult.ok || liveResult.authority.scope.kind === 'legacy_unscoped') {
    await deny(`scope_${liveResult.ok ? 'unverifiable_scope' : liveResult.reason}`);
    return;
  }

  const effectiveScope = intersectSiteScopes(
    persistedScope,
    liveResult.authority.scope,
  );
  if (!effectiveScope) {
    await deny('scope_no_intersection');
    return;
  }
  if (effectiveScope.kind === 'legacy_unscoped') {
    await deny('scope_legacy_unscoped');
    return;
  }
  if (effectiveScope.kind === 'restricted' && effectiveScope.siteIds.length === 0) {
    await deny('scope_empty');
    return;
  }

  const executionAuthority: ReportExecutionAuthority = {
    scope: effectiveScope,
    principalUserId: liveResult.authority.principalUserId,
    capturedAt: liveResult.authority.capturedAt,
    fingerprint: siteScopeFingerprint(effectiveScope),
  };

  try {
    assertReportExecutionPreflight(report.orgId, config, executionAuthority);
  } catch {
    await deny('scope_config_outside_authority');
    return;
  }

  const [run] = await db
    .insert(reportRuns)
    .values({
      reportId: report.id,
      status: 'running',
      startedAt: new Date(),
      ...persistedSiteScopeValues(executionAuthority),
    })
    .returning();
  if (!run) throw new Error(`Failed to create run for scheduled report ${report.id}`);

  // Stamp lastGeneratedAt up front so a crash mid-generation doesn't cause a
  // tight retry loop every check interval; the failed run row records the error.
  // Skipped when the caller already claimed the occurrence atomically (the
  // inline CAS path in processCheckSchedules) — that claim IS this stamp, and
  // re-stamping here would just be a redundant (harmless but pointless) write.
  if (!opts.occurrenceClaimed) {
    await db
      .update(reports)
      .set({ lastGeneratedAt: new Date(), updatedAt: new Date() })
      .where(eq(reports.id, report.id));
  }

  try {
    const previous = await previousBaselineFor(
      report.id,
      executionAuthority.fingerprint,
    );
    const result = await generateReport(
      report.type,
      report.orgId,
      config,
      executionAuthority,
    );
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
        const timeZone = await resolveOrgTimezone(report.orgId);
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
      // Inline fallback is 'all'-only: a worker-role process requires Redis to
      // boot at all (never this limp mode), and unlike 'all' — a single
      // self-hosted process — a worker-role deploy may run multiple replicas,
      // where bypassing the BullMQ jobId dedup would double-generate the same
      // occurrence across containers. Under worker/api roles with Redis down
      // (a transient blip after boot, since worker.ts's own mandatory check
      // already passed), skip rather than risk that — the next check interval
      // retries once Redis is back.
      if (breezeRole() !== 'all') {
        console.warn(
          `[ReportScheduleWorker] Redis unavailable outside 'all' role; skipping inline fallback for report ${item.id}`,
        );
        continue;
      }
      // Inline mode has no queue to absorb a throw, so one failing report would
      // abort the loop and silently starve every remaining org's reports.
      // There is no retry here either, hence finalAttempt.
      //
      // The occurrence is claimed via CAS before running: a slow prior tick
      // still mid-generation when the next 5-minute interval fires would
      // otherwise find the same report due twice (lastGeneratedAt isn't
      // stamped until deep inside processRunScheduledReport) and generate it
      // twice. The claim uses the lastGeneratedAt findDueReports observed, so
      // only the first tick to reach it wins.
      const claimed = await claimReportOccurrence(item.id, item.lastGeneratedAt);
      if (!claimed) {
        console.warn(
          `[ReportScheduleWorker] Occurrence for report ${item.id} already claimed by a concurrent check; skipping`,
        );
        continue;
      }
      try {
        await processRunScheduledReport(
          { type: 'run-scheduled-report', reportId: item.id, occurrenceKey: item.occurrenceKey },
          { finalAttempt: true, occurrenceClaimed: true },
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
