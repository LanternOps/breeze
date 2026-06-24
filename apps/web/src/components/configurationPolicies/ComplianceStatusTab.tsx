import { useCallback, useEffect, useState } from 'react';
import { ClipboardCheck, RefreshCw } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';

type ComplianceRow = {
  id: string;
  configItemName: string | null;
  deviceId: string;
  status: 'compliant' | 'non_compliant' | 'pending' | 'error' | string;
  lastCheckedAt: string | null;
  updatedAt: string | null;
  deviceHostname: string | null;
};

type ComplianceOverall = {
  total: number;
  compliant: number;
  nonCompliant: number;
  unknown: number;
};

type ComplianceResponse = {
  data: ComplianceRow[];
  overall?: ComplianceOverall;
  pagination?: { page: number; limit: number; total: number };
};

type ComplianceStatusTabProps = {
  policyId: string;
  timezone?: string;
};

const STATUS_STYLES: Record<string, string> = {
  compliant: 'bg-success/15 text-success border-success/30',
  non_compliant: 'bg-destructive/15 text-destructive border-destructive/30',
  pending: 'bg-warning/15 text-warning border-warning/30',
  error: 'bg-destructive/15 text-destructive border-destructive/30',
};

const STATUS_LABELS: Record<string, string> = {
  compliant: 'Compliant',
  non_compliant: 'Non-compliant',
  pending: 'Pending',
  error: 'Error',
};

function formatTimestamp(value: string | null, timezone?: string): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], timezone ? { timeZone: timezone } : undefined);
}

export default function ComplianceStatusTab({ policyId, timezone }: ComplianceStatusTabProps) {
  const [rows, setRows] = useState<ComplianceRow[]>([]);
  const [overall, setOverall] = useState<ComplianceOverall>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const fetchCompliance = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const response = await fetchWithAuth(`/policies/${policyId}/compliance`);
      if (!response.ok) throw new Error('Failed to load compliance status');
      const json = (await response.json()) as ComplianceResponse;
      setRows(Array.isArray(json?.data) ? json.data : []);
      setOverall(json?.overall);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load compliance status');
    } finally {
      setLoading(false);
    }
  }, [policyId]);

  useEffect(() => {
    fetchCompliance();
  }, [fetchCompliance]);

  if (loading) {
    return (
      <div
        data-testid="compliance-status-loading"
        className="flex items-center justify-center rounded-lg border bg-card py-12 shadow-sm"
      >
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-3 text-sm text-muted-foreground">Loading compliance status...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div
        data-testid="compliance-status-error"
        className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center"
      >
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={fetchCompliance}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div data-testid="compliance-status-tab" className="space-y-4">
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ClipboardCheck className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-lg font-semibold">Compliance Status</h3>
          </div>
          <button
            type="button"
            onClick={fetchCompliance}
            className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </button>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Per-device evaluation of this policy&apos;s compliance rules (re-evaluated automatically).
        </p>

        {overall && (
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-md border bg-background px-4 py-3">
              <p className="text-xs text-muted-foreground">Total</p>
              <p className="mt-1 text-xl font-semibold tabular-nums">{overall.total}</p>
            </div>
            <div className="rounded-md border bg-background px-4 py-3">
              <p className="text-xs text-muted-foreground">Compliant</p>
              <p className="mt-1 text-xl font-semibold tabular-nums text-success">{overall.compliant}</p>
            </div>
            <div className="rounded-md border bg-background px-4 py-3">
              <p className="text-xs text-muted-foreground">Non-compliant</p>
              <p className="mt-1 text-xl font-semibold tabular-nums text-destructive">{overall.nonCompliant}</p>
            </div>
            <div className="rounded-md border bg-background px-4 py-3">
              <p className="text-xs text-muted-foreground">Unknown</p>
              <p className="mt-1 text-xl font-semibold tabular-nums text-muted-foreground">{overall.unknown}</p>
            </div>
          </div>
        )}
      </div>

      <div className="overflow-hidden rounded-lg border bg-card shadow-sm">
        <div className="max-h-[500px] overflow-auto">
          <table className="min-w-full divide-y">
            <thead className="bg-muted/40 sticky top-0">
              <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3">Device</th>
                <th className="px-4 py-3">Check</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Last Checked</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.length === 0 ? (
                <tr>
                  <td
                    colSpan={4}
                    data-testid="compliance-status-empty"
                    className="px-4 py-6 text-center text-sm text-muted-foreground"
                  >
                    No compliance results yet. Assign this policy to devices and add compliance rules; status
                    appears after the next evaluation.
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={row.id} data-testid="compliance-status-row" className="text-sm hover:bg-muted/30">
                    <td className="px-4 py-3 font-medium">{row.deviceHostname ?? row.deviceId}</td>
                    <td className="px-4 py-3 text-muted-foreground">{row.configItemName ?? '—'}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${
                          STATUS_STYLES[row.status] ?? 'bg-muted text-muted-foreground border-border'
                        }`}
                      >
                        {STATUS_LABELS[row.status] ?? row.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">
                      {formatTimestamp(row.lastCheckedAt ?? row.updatedAt, timezone)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
