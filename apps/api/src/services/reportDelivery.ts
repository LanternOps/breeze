/**
 * Report email delivery (#4248 W03).
 *
 * `emailReportRun` and `emailReportFailure` were moved here VERBATIM from
 * `jobs/reportScheduleWorker.ts` so the weekly AI org narrative (which the
 * report worker deliberately never executes -- see WORKER_EXCLUDED_REPORT_TYPES)
 * can reuse the exact same rendering from its own delivery path. Their
 * rendering is pinned by `reportDelivery.snapshot.test.ts`, taken before the
 * move: any change to what they produce must be a deliberate snapshot update.
 *
 * Shape to keep in mind downstream: both take EMAIL ADDRESS STRINGS (not user
 * ids) and IDENTIFIERS THE CALLER ALREADY RESOLVED (`partnerId`), build
 * in-memory PDF/CSV buffers, and touch no db handle. That last property is why
 * `partnerId` is a parameter rather than a lookup: the partner-lane sender
 * (spec §8.2) needs it, and this module must not grow a query to get it.
 */

import { getEmailService } from './email';
import { renderLayout, renderButton, renderParagraph, escapeHtml } from './emailLayout';
import { rowsToCsv } from '@breeze/shared';
import type { PostureSummary, ExecutiveSummary } from '@breeze/shared';
import { buildReportPdf, type ReportBranding } from '@breeze/shared/reportPdf';
import type { ReportResult } from './reportGenerationService';

// Attachments above this size are dropped in favour of the in-app link.
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

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
export async function emailReportFailure(opts: {
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

  // Platform sender (spec §8.2): this tells the MSP's own people that their
  // scheduled report did not arrive — not a customer-facing deliverable.
  await email.sendEmail({
    to: opts.recipients,
    subject: `Scheduled report failed: ${opts.reportName}`,
    html,
    purpose: 'staff.report_failure',
  });
}

export async function emailReportRun(opts: {
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
  /**
   * The partner that owns the report's org — the `general` stream's sender
   * (spec §8.2). Passed IN, never read here: this module's contract is that it
   * takes address strings, a branding bag and a timezone and touches no db
   * handle (see the module docstring). Both callers already hold an org id and
   * a system DB context, so the read is theirs to make.
   *
   * `null` is allowed and means the platform sender, for a caller that cannot
   * resolve one (spec §8.1).
   */
  partnerId: string | null;
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
    // The scheduled report itself IS a customer deliverable — partner lane,
    // `general` stream (spec §8.2). The partner is RESOLVED BY THE CALLER and
    // passed in: this module takes only address strings, a branding bag and a
    // timezone, and touches no db handle (module docstring). Both callers
    // already hold the report's org id and a system DB context, so the read is
    // theirs. `null` still resolves to the platform sender (§8.1).
    purpose: 'report.delivery',
    partnerId: opts.partnerId,
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
