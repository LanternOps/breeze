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

type ReportType = 'security_compliance_posture' | 'executive_summary';

/** What the reader is told is happening, in their own language. The MSP-side
 *  report definition names are technical; these are not. */
const GENERATING_COPY: Record<ReportType, string> = {
  security_compliance_posture: 'Generating your security summary…',
  executive_summary: 'Generating your executive summary…',
};

/**
 * The report definitions are named for the MSP's own report library
 * ("Customer portal — Security & compliance posture"); inside the customer's
 * own list the prefix is noise — they know whose portal they are in. The
 * MSP-side name is untouched, this is a render-time trim only.
 */
export function reportDisplayName(name: string): string {
  return name.replace(/^customer portal\s*[—–-]\s*/i, '');
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
}: {
  initialRuns: PortalRunDto[];
  timezone: string;
  error?: string | null;
}) {
  const [runs, setRuns] = useState(initialRuns);
  const [busyType, setBusyType] = useState<ReportType | null>(null);
  const [message, setMessage] = useState(error ?? null);
  // Announced by the polite live region below the actions: a report that takes
  // a few seconds must say it is coming, and say when it has arrived — a new
  // row appearing silently confirms nothing to a screen reader or to a reader
  // whose eyes are on the buttons.
  const [status, setStatus] = useState('');

  async function generate(type: ReportType) {
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
