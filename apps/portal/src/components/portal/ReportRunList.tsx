import { useState } from 'react';
import type { PortalRunDto } from '@breeze/shared';
import { Download, FileText } from 'lucide-react';
import { portalApi } from '@/lib/api';
import { cn, formatDateTime } from '@/lib/utils';
import {
  ROW,
  CELL,
  TH,
  BTN_SECONDARY,
  EmptyState,
  ErrorNotice,
  PageHeader,
} from './ui';

/**
 * The types a PORTAL USER may generate on demand — deliberately NARROWER than
 * `PortalRunDto['type']`, which is the set that can be LISTED. Mirrors the
 * server's PORTAL_REPORT_TYPES — the generate endpoint refuses anything
 * outside it.
 *
 * #5784 W02/W03/W04: a managed-evidence run (`threat_detection_review`,
 * `endpoint_management_review`, `vulnerability_management`) appears in the
 * list once its occurrence is delivered, but the customer may never generate
 * one — the artifact is the MSP's evidence, produced by the deliverable sweep
 * (OD-10 = A). Keeping the two unions separate is what stops a later edit
 * from wiring a generate button for an evidence type; the row rendering
 * below reads `PortalRunDto` directly, so it needs no entry here.
 */
type GeneratableReportType =
  | 'security_compliance_posture'
  | 'executive_summary'
  | 'hardware_lifecycle';

/** Every type that can APPEAR in this list. Wider than the generatable set:
 *  `portalRunListPredicate` has no type filter, so a managed-evidence run
 *  (#5784 W02/W03/W04) reaches the list once its occurrence is delivered.
 *  Keeping the two unions apart is what makes "listed but not generatable"
 *  (OD-10 = A) a compile-time fact rather than a convention. */
type ReportType =
  | GeneratableReportType
  | 'threat_detection_review'
  | 'vulnerability_management'
  | 'identity_access_review';

/** What the reader is told is happening, in their own language. The MSP-side
 *  report definition names are technical; these are not. Total over
 *  `GeneratableReportType` — a missing entry is a typecheck failure. */
const GENERATING_COPY: Record<GeneratableReportType, string> = {
  security_compliance_posture: 'Generating your security summary…',
  executive_summary: 'Generating your executive summary…',
  hardware_lifecycle: 'Generating your hardware lifecycle plan…',
};

/**
 * The report definitions are named for the MSP's own report library
 * ("Customer portal — Security & compliance posture"); inside the customer's
 * own list the prefix is noise — they know whose portal they are in. The
 * MSP-side name is untouched, this is a render-time trim only.
 *
 * Managed-evidence definitions (#5784 W01) are provisioned with a second,
 * internal-only prefix — `MANAGED_EVIDENCE_DEFINITION_NAME_PREFIX` in
 * `apps/api/src/services/managedEvidenceRegistry.ts` ('Service evidence — ')
 * — and those runs reach this same list once delivered (#6101). The portal
 * app doesn't depend on `@breeze/shared`, so this is a local mirror of that
 * literal rather than a shared import; keep the two in sync.
 */
export function reportDisplayName(name: string): string {
  return name.replace(/^(customer portal|service evidence)\s*[—–-]\s*/i, '');
}

/**
 * A 429 from /reports/generate carries the wait in a `Retry-After` header
 * (seconds). An error that only says "temporarily limited" leaves the reader
 * clicking; one that says when to come back does not.
 */
export function retryHintFrom(
  headers: Headers | undefined,
  errorData: unknown,
): number | null {
  const header = headers?.get('Retry-After');
  const fromBody =
    errorData && typeof errorData === 'object'
      ? (errorData as { retryAfterSeconds?: unknown }).retryAfterSeconds
      : undefined;
  const seconds = Number(header ?? fromBody);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

function withRetryHint(message: string, seconds: number | null): string {
  const base = /[.!?]$/.test(message) ? message : `${message}.`;
  if (seconds === null) return base;
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return `${base} Try again in about ${minutes === 1 ? 'a minute' : `${minutes} minutes`}.`;
}

export function ReportRunList({
  initialRuns,
  timezone,
  error,
  lifecycleHref = null,
}: {
  initialRuns: PortalRunDto[];
  timezone: string;
  error?: string | null;
  /** Where the hardware lifecycle plan lives for this org, or null when the
   *  MSP has not turned it on. Rendered as a ruled row under the title. */
  lifecycleHref?: string | null;
}) {
  const [runs, setRuns] = useState(initialRuns);
  const [busyType, setBusyType] = useState<GeneratableReportType | null>(null);
  const [message, setMessage] = useState(error ?? null);
  // Announced by the polite live region below the actions: a report that takes
  // a few seconds must say it is coming, and say when it has arrived — a new
  // row appearing silently confirms nothing to a screen reader or to a reader
  // whose eyes are on the buttons.
  const [status, setStatus] = useState('');

  async function generate(type: GeneratableReportType) {
    setBusyType(type);
    setMessage(null);
    setStatus(GENERATING_COPY[type]);
    const response = await portalApi.generateReport(type);
    if (!response.data) {
      setMessage(
        withRetryHint(
          response.error ?? 'Could not generate the report.',
          response.statusCode === 429
            ? retryHintFrom(response.headers, response.errorData)
            : null,
        ),
      );
      setStatus('');
      setBusyType(null);
      return;
    }

    const refreshed = await portalApi.getReportRuns({
      page: 1,
      limit: 20,
    });
    setRuns(
      refreshed.data
        ?? (response.data.status === 'completed'
          ? [response.data, ...runs]
          : runs),
    );
    if (response.data.status === 'failed') {
      setMessage('The report could not be generated.');
      setStatus('');
    } else {
      setStatus('Your report is ready.');
    }
    setBusyType(null);
  }

  return (
    <div>
      <PageHeader
        title="Reports"
        lede="Generate and download a current summary of your machines."
      />

      {lifecycleHref && (
        <a
          href={lifecycleHref}
          data-testid="reports-lifecycle-card"
          className="group -mx-4 -mt-2 mb-7 flex items-center justify-between gap-4 border-y border-border/70 px-4 py-4 text-sm transition-colors hover:bg-accent/40"
        >
          <span>
            <span className="block font-semibold text-foreground">Hardware lifecycle</span>
            <span className="mt-0.5 block text-muted-foreground">
              See the replacement plan for the machines we manage for you.
            </span>
          </span>
          <span aria-hidden="true" className="text-muted-foreground transition-colors group-hover:text-foreground">&rarr;</span>
        </a>
      )}

      <div className="mb-2 flex flex-wrap gap-3">
        <button
          type="button"
          data-testid="portal-reports-generate-posture"
          disabled={busyType !== null}
          aria-busy={busyType === 'security_compliance_posture'}
          onClick={() => void generate('security_compliance_posture')}
          className={BTN_SECONDARY}
        >
          {busyType === 'security_compliance_posture'
            ? 'Generating…'
            : 'Generate security summary'}
        </button>
        <button
          type="button"
          data-testid="portal-reports-generate-executive"
          disabled={busyType !== null}
          aria-busy={busyType === 'executive_summary'}
          onClick={() => void generate('executive_summary')}
          className={BTN_SECONDARY}
        >
          {busyType === 'executive_summary'
            ? 'Generating…'
            : 'Generate executive summary'}
        </button>
        {/* A peer of the two above, not a promotion. With enableLifecycle off
            this click lands on the service's not-found path and reads as
            "not generated yet" — indistinguishable from never-provisioned by
            design (spec section 4). */}
        <button
          type="button"
          data-testid="portal-reports-generate-lifecycle"
          disabled={busyType !== null}
          aria-busy={busyType === 'hardware_lifecycle'}
          onClick={() => void generate('hardware_lifecycle')}
          className={BTN_SECONDARY}
        >
          {busyType === 'hardware_lifecycle'
            ? 'Generating…'
            : 'Generate hardware lifecycle plan'}
        </button>
      </div>

      {/* A quiet line, not a toast: it holds its height so the ledger below
          never jumps when the wording changes. */}
      <p
        aria-live="polite"
        data-testid="portal-reports-status"
        className="mb-6 min-h-5 text-sm text-muted-foreground"
      >
        {status}
      </p>

      {message && <ErrorNotice>{message}</ErrorNotice>}

      {runs.length === 0 ? (
        <EmptyState
          icon={<FileText className="h-10 w-10" strokeWidth={1.5} />}
          title="No reports yet"
        >
          <p className="mt-1 text-sm text-muted-foreground">
            Generate a report to create the first downloadable snapshot.
          </p>
        </EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <table
            className="block w-full sm:table sm:min-w-[36rem]"
            data-testid="portal-report-runs-table"
          >
            <thead className="hidden border-b border-border sm:table-header-group">
              <tr>
                <th scope="col" className={cn(TH, 'text-left')}>Report</th>
                <th scope="col" className={cn(TH, 'text-right')}>Generated</th>
                <th scope="col" className={cn(TH, 'text-left')}>Download</th>
              </tr>
            </thead>
            <tbody className="block divide-y divide-border/70 sm:table-row-group">
              {runs.map((run) => {
                const name = reportDisplayName(run.name);
                return (
                  <tr
                    key={run.id}
                    className={ROW}
                    data-testid={`portal-report-run-row-${run.id}`}
                  >
                    {/* order-*: the report's name leads the phone card, the
                        download actions sit under it on their own line, and the
                        timestamp trails as supporting detail. */}
                    <td className={cn(CELL, 'order-1 grow font-semibold text-foreground')}>
                      {name}
                    </td>
                    <td
                      className={cn(
                        CELL,
                        'order-2 text-xs text-muted-foreground sm:text-right sm:text-sm',
                      )}
                    >
                      {/* A run with no artifact says so once, in the Download
                          cell; repeating the outcome here read as a stutter. */}
                      {run.completedAt && (
                        <>
                          <span className="sm:hidden">Generated </span>
                          <span className="text-figures">
                            {formatDateTime(run.completedAt, timezone)}
                          </span>{' '}
                          <span className="whitespace-nowrap">({timezone})</span>
                        </>
                      )}
                    </td>
                    <td className={cn(CELL, 'order-3 basis-full sm:basis-auto')}>
                      {run.status !== 'completed' ? (
                        // Linking a download that 404s is worse than saying so:
                        // the cell states the outcome in the same words the
                        // Generated column uses.
                        <span
                          className="text-xs text-muted-foreground"
                          data-testid={`portal-report-run-download-${run.id}`}
                        >
                          {run.status === 'failed' ? 'Did not complete' : 'Still generating'}
                        </span>
                      ) : (
                        <div className="mt-2 flex flex-wrap gap-2 sm:mt-0">
                          <a
                            data-testid={`portal-report-run-pdf-${run.id}`}
                            href={portalApi.reportArtifactUrl(run.id, 'pdf')}
                            download
                            aria-label={`Download ${name} as PDF`}
                            className={cn(BTN_SECONDARY, 'min-h-11 sm:min-h-0 sm:py-1.5')}
                          >
                            <Download className="h-4 w-4" aria-hidden="true" />
                            PDF
                          </a>
                          <a
                            data-testid={`portal-report-run-csv-${run.id}`}
                            href={portalApi.reportArtifactUrl(run.id, 'csv')}
                            download
                            aria-label={`Download ${name} as CSV`}
                            className={cn(BTN_SECONDARY, 'min-h-11 sm:min-h-0 sm:py-1.5')}
                          >
                            <Download className="h-4 w-4" aria-hidden="true" />
                            CSV
                          </a>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div
            className="border-t border-border px-4 pt-3.5 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground"
            data-testid="report-ledger-foot"
          >
            {runs.length === 1 ? '1 report available' : `${runs.length} reports available`}
          </div>
        </div>
      )}
    </div>
  );
}

export default ReportRunList;
