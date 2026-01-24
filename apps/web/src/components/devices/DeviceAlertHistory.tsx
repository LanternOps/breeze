import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Calendar } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';

type AlertItem = {
  id?: string;
  severity?: string;
  level?: string;
  message?: string;
  summary?: string;
  status?: string;
  createdAt?: string;
  timestamp?: string;
};

type DeviceAlertHistoryProps = {
  deviceId: string;
  showFilters?: boolean;
  limit?: number;
};

const severityStyles: Record<string, string> = {
  critical: 'bg-red-500/20 text-red-700 border-red-500/40',
  error: 'bg-red-500/20 text-red-700 border-red-500/40',
  warning: 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40',
  info: 'bg-blue-500/20 text-blue-700 border-blue-500/40'
};

function formatDateTime(value?: string) {
  if (!value) return 'Not reported';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export default function DeviceAlertHistory({
  deviceId,
  showFilters = true,
  limit
}: DeviceAlertHistoryProps) {
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [startDateInput, setStartDateInput] = useState('');
  const [endDateInput, setEndDateInput] = useState('');
  const [appliedRange, setAppliedRange] = useState({ startDate: '', endDate: '' });

  const fetchAlerts = useCallback(async (range?: { startDate: string; endDate: string }) => {
    setLoading(true);
    setError(undefined);
    try {
      const params = new URLSearchParams();
      const startDate = range?.startDate ?? appliedRange.startDate;
      const endDate = range?.endDate ?? appliedRange.endDate;
      if (startDate) params.set('startDate', startDate);
      if (endDate) params.set('endDate', endDate);
      const response = await fetchWithAuth(`/devices/${deviceId}/alerts?${params}`);
      if (!response.ok) throw new Error('Failed to fetch alert history');
      const json = await response.json();
      const payload = json?.data ?? json;
      setAlerts(Array.isArray(payload) ? payload : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch alert history');
    } finally {
      setLoading(false);
    }
  }, [appliedRange.endDate, appliedRange.startDate, deviceId]);

  useEffect(() => {
    fetchAlerts();
  }, [fetchAlerts]);

  const visibleAlerts = useMemo(() => {
    if (!limit) return alerts;
    return alerts.slice(0, limit);
  }, [alerts, limit]);

  const handleApply = () => {
    const range = { startDate: startDateInput, endDate: endDateInput };
    setAppliedRange(range);
    fetchAlerts(range);
  };

  const handleClear = () => {
    setStartDateInput('');
    setEndDateInput('');
    setAppliedRange({ startDate: '', endDate: '' });
    fetchAlerts({ startDate: '', endDate: '' });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center rounded-lg border bg-card py-12 shadow-sm">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-3 text-sm text-muted-foreground">Loading alert history...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={() => fetchAlerts()}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-lg font-semibold">Alert History</h3>
        </div>
        {showFilters && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <div className="relative">
              <Calendar className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                type="date"
                value={startDateInput}
                onChange={event => setStartDateInput(event.target.value)}
                className="h-9 rounded-md border bg-background pl-8 pr-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <span className="text-xs text-muted-foreground">to</span>
            <div className="relative">
              <Calendar className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                type="date"
                value={endDateInput}
                onChange={event => setEndDateInput(event.target.value)}
                className="h-9 rounded-md border bg-background pl-8 pr-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <button
              type="button"
              onClick={handleApply}
              className="h-9 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              Apply
            </button>
            <button
              type="button"
              onClick={handleClear}
              className="h-9 rounded-md border px-3 text-sm font-medium text-muted-foreground hover:text-foreground"
            >
              Clear
            </button>
          </div>
        )}
      </div>
      <div className="mt-4 space-y-3">
        {visibleAlerts.length === 0 ? (
          <p className="text-sm text-muted-foreground">No alerts reported for this device.</p>
        ) : (
          visibleAlerts.map((alert, index) => {
            const severity = (alert.severity || alert.level || 'info').toLowerCase();
            const badgeStyle = severityStyles[severity] || 'bg-muted/40 text-muted-foreground border-muted';
            return (
              <div key={alert.id ?? `${alert.message ?? alert.summary ?? 'alert'}-${index}`} className="rounded-md border p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium">{alert.message || alert.summary || 'Alert reported'}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {formatDateTime(alert.createdAt || alert.timestamp)}
                    </p>
                  </div>
                  <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${badgeStyle}`}>
                    {severity}
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
