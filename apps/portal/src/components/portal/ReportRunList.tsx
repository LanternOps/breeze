import { useState } from 'react';
import type { PortalRunDto } from '@breeze/shared';
import { portalApi } from '@/lib/api';
import {
  EmptyState,
  ErrorNotice,
  PageHeader,
} from './ui';

export function ReportRunList({
  initialRuns,
  error,
}: {
  initialRuns: PortalRunDto[];
  error?: string | null;
}) {
  const [runs, setRuns] = useState(initialRuns);
  const [busyType, setBusyType] = useState<string | null>(null);
  const [message, setMessage] = useState(error ?? null);

  async function generate(
    type: 'security_compliance_posture' | 'executive_summary',
  ) {
    setBusyType(type);
    setMessage(null);
    const response = await portalApi.generateReport(type);
    if (!response.data) {
      setMessage(response.error ?? 'Could not generate the report.');
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
    }
    setBusyType(null);
  }

  return (
    <div>
      <PageHeader
        title="Reports"
        lede="Generate and download a current summary of your environment."
      />

      <div className="mb-8 flex flex-wrap gap-3">
        <button
          type="button"
          data-testid="portal-reports-generate-posture"
          disabled={busyType !== null}
          onClick={() => void generate('security_compliance_posture')}
          className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50"
        >
          {busyType === 'security_compliance_posture'
            ? 'Generating…'
            : 'Generate security posture'}
        </button>
        <button
          type="button"
          data-testid="portal-reports-generate-executive"
          disabled={busyType !== null}
          onClick={() => void generate('executive_summary')}
          className="rounded-md border px-4 py-2 text-sm font-semibold disabled:opacity-50"
        >
          {busyType === 'executive_summary'
            ? 'Generating…'
            : 'Generate executive summary'}
        </button>
      </div>

      {message && <ErrorNotice>{message}</ErrorNotice>}

      {runs.length === 0 ? (
        <EmptyState title="No reports yet">
          Generate a report to create the first downloadable snapshot.
        </EmptyState>
      ) : (
        <table
          className="w-full"
          data-testid="portal-report-runs-table"
        >
          <thead>
            <tr>
              <th>Report</th>
              <th>Generated</th>
              <th>Downloads</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr
                key={run.id}
                data-testid={`portal-report-run-row-${run.id}`}
              >
                <td>{run.name}</td>
                <td>
                  {run.completedAt
                    ? new Date(run.completedAt).toLocaleString()
                    : 'Not completed'}
                </td>
                <td>
                  <a
                    data-testid={`portal-report-run-pdf-${run.id}`}
                    href={portalApi.reportArtifactUrl(run.id, 'pdf')}
                    download
                  >
                    PDF
                  </a>
                  <a
                    data-testid={`portal-report-run-csv-${run.id}`}
                    href={portalApi.reportArtifactUrl(run.id, 'csv')}
                    download
                    className="ml-3"
                  >
                    CSV
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default ReportRunList;
