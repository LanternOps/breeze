import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle, GitBranch, Link2, Network, TreePine } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';
import type { AlertSeverity } from './AlertList';

type AlertSummary = {
  id: string;
  title: string;
  severity: AlertSeverity;
  triggeredAt: string;
};

type CorrelationItem = {
  id: string;
  title: string;
  type: 'causal' | 'symptom' | 'duplicate';
  confidence: number;
};

type TimelineEvent = {
  id: string;
  label: string;
  time: string;
  severity: AlertSeverity;
};

type CorrelationData = {
  alerts: AlertSummary[];
  correlations: CorrelationItem[];
  timeline: TimelineEvent[];
  summary: {
    relatedCount: number;
    rootCauseConfidence: number;
    lastUpdate: string;
  };
};

const severityDot: Record<AlertSeverity, string> = {
  critical: 'bg-red-500',
  high: 'bg-orange-500',
  medium: 'bg-yellow-500',
  low: 'bg-blue-500',
  info: 'bg-gray-500'
};

export default function AlertCorrelationView() {
  const [autoLoad, setAutoLoad] = useState(true);
  const [selectedAlertId, setSelectedAlertId] = useState<string>('');
  const [alerts, setAlerts] = useState<AlertSummary[]>([]);
  const [correlations, setCorrelations] = useState<CorrelationItem[]>([]);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [summary, setSummary] = useState<CorrelationData['summary'] | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchAlerts = useCallback(async () => {
    try {
      const response = await fetchWithAuth('/alerts?limit=50');

      if (response.status === 401) {
        window.location.href = '/login';
        return;
      }

      if (!response.ok) {
        throw new Error('Failed to fetch alerts');
      }

      const data = await response.json();
      const alertList = (data.alerts || []).map((a: AlertSummary) => ({
        id: a.id,
        title: a.title,
        severity: a.severity,
        triggeredAt: a.triggeredAt
      }));
      setAlerts(alertList);

      if (alertList.length > 0 && !selectedAlertId) {
        setSelectedAlertId(alertList[0].id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load alerts');
    }
  }, [selectedAlertId]);

  const fetchCorrelations = useCallback(async () => {
    if (!selectedAlertId) {
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const response = await fetchWithAuth(`/alerts/${selectedAlertId}/correlations`);

      if (response.status === 401) {
        window.location.href = '/login';
        return;
      }

      if (!response.ok) {
        throw new Error('Failed to fetch correlations');
      }

      const data = await response.json();
      setCorrelations(data.correlations || []);
      setTimeline(data.timeline || []);
      setSummary(data.summary || null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load correlations');
    } finally {
      setIsLoading(false);
    }
  }, [selectedAlertId]);

  useEffect(() => {
    fetchAlerts();
  }, [fetchAlerts]);

  useEffect(() => {
    if (selectedAlertId) {
      fetchCorrelations();
    }
  }, [selectedAlertId, fetchCorrelations]);

  const selectedAlert = useMemo(
    () => alerts.find(alert => alert.id === selectedAlertId) ?? alerts[0],
    [alerts, selectedAlertId]
  );

  const handleBulkAcknowledge = async () => {
    if (!selectedAlertId) return;

    try {
      const response = await fetchWithAuth(`/alerts/${selectedAlertId}/correlations/acknowledge`, {
        method: 'POST'
      });

      if (response.status === 401) {
        window.location.href = '/login';
        return;
      }

      if (response.ok) {
        fetchCorrelations();
      }
    } catch {
      // Handle error silently or show notification
    }
  };

  if (isLoading && alerts.length === 0) {
    return (
      <div className="space-y-6">
        <div className="rounded-lg border bg-card p-6 shadow-sm">
          <div className="flex h-48 items-center justify-center">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          </div>
        </div>
      </div>
    );
  }

  if (error && alerts.length === 0) {
    return (
      <div className="space-y-6">
        <div className="rounded-lg border bg-card p-6 shadow-sm">
          <div className="flex h-48 flex-col items-center justify-center gap-2 text-muted-foreground">
            <p>{error}</p>
            <button
              type="button"
              onClick={fetchAlerts}
              className="text-sm text-primary hover:underline"
            >
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold">Alert Correlation</h2>
            <p className="text-sm text-muted-foreground">
              Visualize related alerts and confirm root cause chains.
            </p>
          </div>
          <button
            type="button"
            onClick={handleBulkAcknowledge}
            className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90"
          >
            <CheckCircle className="h-4 w-4" />
            Bulk acknowledge
          </button>
        </div>

        <div className="mt-4 grid gap-4 lg:grid-cols-[2fr_1fr]">
          <div className="rounded-md border p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-xs font-semibold uppercase text-muted-foreground">Alert selection</p>
                <p className="text-sm font-medium">{selectedAlert?.title || 'No alert selected'}</p>
              </div>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={autoLoad}
                  onChange={event => setAutoLoad(event.target.checked)}
                />
                Auto-load from context
              </label>
            </div>
            <select
              value={selectedAlertId}
              onChange={event => setSelectedAlertId(event.target.value)}
              disabled={autoLoad}
              className={cn(
                'mt-3 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring',
                autoLoad ? 'opacity-60' : ''
              )}
            >
              {alerts.map(alert => (
                <option key={alert.id} value={alert.id}>
                  {alert.title}
                </option>
              ))}
            </select>
          </div>

          <div className="rounded-md border p-4">
            <p className="text-xs font-semibold uppercase text-muted-foreground">Correlation summary</p>
            <div className="mt-3 space-y-2 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Related alerts</span>
                <span className="font-medium">{summary?.relatedCount ?? correlations.length}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Root cause confidence</span>
                <span className="font-medium">{summary?.rootCauseConfidence ?? 0}%</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Last update</span>
                <span className="font-medium">{summary?.lastUpdate ?? 'N/A'}</span>
              </div>
            </div>
          </div>
        </div>

        {isLoading ? (
          <div className="mt-6 flex h-48 items-center justify-center">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          </div>
        ) : (
          <>
            <div className="mt-6 grid gap-6 lg:grid-cols-2">
              <div className="rounded-md border p-4">
                <div className="flex items-center gap-2">
                  <TreePine className="h-4 w-4 text-muted-foreground" />
                  <h3 className="text-sm font-semibold">Correlation diagram</h3>
                </div>
                <div className="mt-4 space-y-4">
                  {selectedAlert && (
                    <div className="flex items-start gap-3">
                      <div className={cn('mt-1 h-2.5 w-2.5 rounded-full', severityDot[selectedAlert.severity])} />
                      <div>
                        <p className="text-sm font-medium">{selectedAlert.title}</p>
                        <p className="text-xs text-muted-foreground">Root cause alert</p>
                      </div>
                    </div>
                  )}
                  {correlations.length > 0 && (
                    <div className="ml-4 border-l border-dashed pl-6 space-y-4">
                      {correlations.map(item => (
                        <div key={item.id} className="flex items-start gap-3">
                          <div className="mt-1 h-2.5 w-2.5 rounded-full bg-slate-400" />
                          <div>
                            <p className="text-sm font-medium">{item.title}</p>
                            <div className="flex items-center gap-2 text-xs text-muted-foreground">
                              <GitBranch className="h-3.5 w-3.5" />
                              {item.type}
                              <span>·</span>
                              {item.confidence}% confidence
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  {correlations.length === 0 && (
                    <p className="text-sm text-muted-foreground">No correlations found for this alert.</p>
                  )}
                </div>
              </div>

              <div className="rounded-md border p-4">
                <div className="flex items-center gap-2">
                  <Network className="h-4 w-4 text-muted-foreground" />
                  <h3 className="text-sm font-semibold">Correlation list</h3>
                </div>
                <div className="mt-4 overflow-hidden rounded-md border">
                  <table className="min-w-full divide-y">
                    <thead className="bg-muted/40">
                      <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        <th className="px-3 py-2">Related alert</th>
                        <th className="px-3 py-2">Type</th>
                        <th className="px-3 py-2">Confidence</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {correlations.length === 0 ? (
                        <tr>
                          <td colSpan={3} className="px-3 py-4 text-center text-sm text-muted-foreground">
                            No correlations found.
                          </td>
                        </tr>
                      ) : (
                        correlations.map(item => (
                          <tr key={item.id} className="transition hover:bg-muted/40">
                            <td className="px-3 py-2 text-sm">{item.title}</td>
                            <td className="px-3 py-2 text-sm capitalize">{item.type}</td>
                            <td className="px-3 py-2 text-sm font-medium">{item.confidence}%</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            <div className="mt-6 rounded-md border p-4">
              <div className="flex items-center gap-2">
                <Link2 className="h-4 w-4 text-muted-foreground" />
                <h3 className="text-sm font-semibold">Timeline view</h3>
              </div>
              {timeline.length > 0 ? (
                <div className="relative mt-4 flex items-center justify-between gap-2">
                  <div className="absolute left-4 right-4 top-1/2 h-px bg-border" />
                  {timeline.map(event => (
                    <div key={event.id} className="relative z-10 flex flex-col items-center gap-2">
                      <span className={cn('h-3 w-3 rounded-full', severityDot[event.severity])} />
                      <span className="text-xs font-medium">{event.time}</span>
                      <span className="text-[11px] text-muted-foreground text-center w-20">{event.label}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mt-4 text-sm text-muted-foreground">No timeline events available.</p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
