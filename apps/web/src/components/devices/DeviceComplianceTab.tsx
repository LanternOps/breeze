import { useCallback, useEffect, useMemo, useState } from 'react';
import { ShieldCheck, RefreshCw } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';

type ComplianceRow = {
  id: string;
  policyId: string | null;
  configPolicyId: string | null;
  configItemName: string | null;
  deviceId: string;
  status: 'compliant' | 'non_compliant' | 'pending' | 'error' | string;
  details: unknown;
  lastCheckedAt: string | null;
  remediationAttempts?: number | null;
  updatedAt: string | null;
  deviceHostname?: string | null;
  deviceStatus?: string | null;
  deviceOsType?: string | null;
};

type DeviceComplianceTabProps = {
  deviceId: string;
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

export default function DeviceComplianceTab({ deviceId, timezone }: DeviceComplianceTabProps) {
  const [rows, setRows] = useState<ComplianceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const fetchCompliance = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const response = await fetchWithAuth(`/policies/compliance/device/${deviceId}`);
      if (!response.ok) {
        // Surface the server's specific reason (e.g. "Access to this device
        // denied") instead of a generic message — a 403 is not retryable and
        // should read differently from a transient 5xx.
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Failed to load compliance status (${response.status})`);
      }
      const json = await response.json();
      setRows(Array.isArray(json?.data) ? json.data : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load compliance status');
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    fetchCompliance();
  }, [fetchCompliance]);

  const sorted = useMemo(
    () =>
      [...rows].sort((a, b) => {
        // Surface non-compliant rows first, then by check name.
        const aBad = a.status === 'non_compliant' || a.status === 'error' ? 0 : 1;
        const bBad = b.status === 'non_compliant' || b.status === 'error' ? 0 : 1;
        if (aBad !== bBad) return aBad - bBad;
        return (a.configItemName ?? '').localeCompare(b.configItemName ?? '');
      }),
    [rows]
  );

  const nonCompliantCount = useMemo(
    () => rows.filter((r) => r.status === 'non_compliant' || r.status === 'error').length,
    [rows]
  );

  if (loading) {
    return (
      <div
        data-testid="device-compliance-loading"
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
        data-testid="device-compliance-error"
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
    <div data-testid="device-compliance-tab" className="rounded-lg border bg-card p-6 shadow-sm">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-lg font-semibold">Configuration Policy Compliance</h3>
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{rows.length}</span>
          {nonCompliantCount > 0 ? (
            <span className="rounded-full bg-destructive/15 px-2 py-0.5 text-xs font-medium text-destructive">
              {nonCompliantCount} failing
            </span>
          ) : null}
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
        How this device fares across every Configuration Policy compliance rule assigned to it.
      </p>

      <div className="mt-4 overflow-hidden rounded-md border">
        <div className="max-h-[500px] overflow-auto">
          <table className="min-w-full divide-y">
            <thead className="bg-muted/40 sticky top-0">
              <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3">Check</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Remediation</th>
                <th className="px-4 py-3">Last Checked</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {sorted.length === 0 ? (
                <tr>
                  <td
                    colSpan={4}
                    data-testid="device-compliance-empty"
                    className="px-4 py-6 text-center text-sm text-muted-foreground"
                  >
                    No compliance results reported. Assign a Configuration Policy with compliance rules
                    to this device, or wait for the next evaluation.
                  </td>
                </tr>
              ) : (
                sorted.map((row) => (
                  <tr key={row.id} data-testid="device-compliance-row" className="text-sm hover:bg-muted/30">
                    <td className="px-4 py-3 font-medium">{row.configItemName ?? 'Compliance rule'}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${
                          STATUS_STYLES[row.status] ?? 'bg-muted text-muted-foreground border-border'
                        }`}
                      >
                        {STATUS_LABELS[row.status] ?? row.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 tabular-nums text-muted-foreground">
                      {typeof row.remediationAttempts === 'number' && row.remediationAttempts > 0
                        ? `${row.remediationAttempts} attempt${row.remediationAttempts === 1 ? '' : 's'}`
                        : '—'}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">
                      {formatTimestamp(row.lastCheckedAt, timezone)}
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
