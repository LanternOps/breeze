import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle, ExternalLink, RefreshCw, TrendingUp, XCircle } from 'lucide-react';

import { runAction, handleActionError } from '../../lib/runAction';
import { fetchWithAuth } from '../../stores/auth';

type AnomalyStatus = 'open' | 'dismissed' | 'promoted' | 'resolved';

type MetricAnomaly = {
  id: string;
  metricType: string;
  metricName: string;
  anomalyType: string;
  status: AnomalyStatus;
  windowStart: string;
  windowEnd: string;
  observedValue: number;
  baselineValue: number | null;
  score: number;
  confidence: number;
  sampleCount: number;
  linkedAlertId: string | null;
  detectedAt: string;
};

type DeviceAnomaliesPanelProps = {
  deviceId: string;
  compact?: boolean;
};

const metricLabels: Record<string, string> = {
  cpu_percent: 'CPU',
  ram_percent: 'RAM',
  ram_used_mb: 'RAM used',
  disk_percent: 'Disk',
  disk_used_gb: 'Disk used',
  disk_read_bps: 'Disk read',
  disk_write_bps: 'Disk write',
  bandwidth_in_bps: 'Network in',
  bandwidth_out_bps: 'Network out',
  process_count: 'Processes',
};

const anomalyLabels: Record<string, string> = {
  spike: 'Spike',
  drop: 'Drop',
  trend: 'Trend',
  process_runaway: 'Process runaway',
  network_egress: 'Network egress',
  memory_growth: 'Memory growth',
  disk_growth: 'Disk growth',
};

function formatMetricValue(metricName: string, value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (metricName.endsWith('_percent')) return `${value.toFixed(1)}%`;
  if (metricName.endsWith('_bps')) {
    if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)} GB/s`;
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} MB/s`;
    if (value >= 1_000) return `${(value / 1_000).toFixed(1)} KB/s`;
    return `${Math.round(value)} B/s`;
  }
  if (metricName.endsWith('_mb')) return `${Math.round(value)} MB`;
  if (metricName.endsWith('_gb')) return `${value.toFixed(1)} GB`;
  return value >= 100 ? Math.round(value).toLocaleString() : value.toFixed(1);
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function labelForMetric(metricName: string): string {
  return metricLabels[metricName] ?? metricName.replace(/_/g, ' ');
}

function labelForAnomaly(type: string): string {
  return anomalyLabels[type] ?? type.replace(/_/g, ' ');
}

export default function DeviceAnomaliesPanel({ deviceId, compact = false }: DeviceAnomaliesPanelProps) {
  const [anomalies, setAnomalies] = useState<MetricAnomaly[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  const fetchAnomalies = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const response = await fetchWithAuth(`/devices/${deviceId}/anomalies?status=open&limit=${compact ? 5 : 25}`);
      if (!response.ok) throw new Error('Failed to load metric anomalies');
      const json = await response.json();
      setAnomalies(Array.isArray(json?.data) ? json.data : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load metric anomalies');
    } finally {
      setLoading(false);
    }
  }, [compact, deviceId]);

  useEffect(() => {
    void fetchAnomalies();
  }, [fetchAnomalies]);

  const sorted = useMemo(
    () => [...anomalies].sort((a, b) => b.confidence - a.confidence || b.score - a.score),
    [anomalies],
  );

  async function updateStatus(anomaly: MetricAnomaly, status: Exclude<AnomalyStatus, 'open'>) {
    setUpdatingId(anomaly.id);
    try {
      await runAction({
        request: () => fetchWithAuth(`/devices/${deviceId}/anomalies/${anomaly.id}/status`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status }),
        }),
        errorFallback: 'Could not update anomaly',
        successMessage: status === 'dismissed'
          ? 'Anomaly dismissed'
          : status === 'promoted'
            ? 'Anomaly promoted'
            : 'Anomaly resolved',
      });
      setAnomalies((current) => current.filter((item) => item.id !== anomaly.id));
    } catch (err) {
      handleActionError(err, 'Could not update anomaly');
    } finally {
      setUpdatingId(null);
    }
  }

  if (loading) {
    return (
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex items-center justify-center py-8">
          <div className="h-7 w-7 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-destructive">{error}</p>
          <button
            type="button"
            onClick={() => void fetchAnomalies()}
            className="inline-flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted"
          >
            <RefreshCw className="h-4 w-4" />
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`rounded-lg border bg-card shadow-sm ${compact ? 'p-4' : 'p-6'}`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-muted-foreground" />
          <div>
            <h3 className="text-lg font-semibold">Metric Anomalies</h3>
            {!compact && (
              <p className="text-sm text-muted-foreground">Open signals detected from metric rollups</p>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={() => void fetchAnomalies()}
          className="inline-flex h-9 w-9 items-center justify-center rounded-md border text-muted-foreground hover:bg-muted hover:text-foreground"
          title="Refresh anomalies"
          aria-label="Refresh anomalies"
        >
          <RefreshCw className="h-4 w-4" />
        </button>
      </div>

      {sorted.length === 0 ? (
        <div className="mt-5 rounded-md border border-dashed p-6 text-center">
          <CheckCircle className="mx-auto h-8 w-8 text-success" />
          <p className="mt-2 text-sm font-medium">No open anomalies</p>
          {!compact && <p className="text-sm text-muted-foreground">Recent metric rollups are within baseline.</p>}
        </div>
      ) : (
        <div className="mt-5 space-y-3">
          {sorted.map((anomaly) => (
            <div key={anomaly.id} className="rounded-md border p-4">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="inline-flex items-center gap-1 rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-xs font-medium text-warning">
                      <AlertTriangle className="h-3.5 w-3.5" />
                      {labelForAnomaly(anomaly.anomalyType)}
                    </span>
                    <span className="text-sm font-semibold">{labelForMetric(anomaly.metricName)}</span>
                    <span className="text-xs text-muted-foreground">{formatDate(anomaly.windowStart)}</span>
                  </div>
                  <div className="mt-3 grid gap-3 text-sm sm:grid-cols-3">
                    <div>
                      <div className="text-xs text-muted-foreground">Observed</div>
                      <div className="font-semibold tabular-nums">{formatMetricValue(anomaly.metricName, anomaly.observedValue)}</div>
                    </div>
                    <div>
                      <div className="text-xs text-muted-foreground">Baseline</div>
                      <div className="font-semibold tabular-nums">
                        {anomaly.baselineValue == null ? '—' : formatMetricValue(anomaly.metricName, anomaly.baselineValue)}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs text-muted-foreground">Confidence</div>
                      <div className="font-semibold tabular-nums">{Math.round(anomaly.confidence * 100)}%</div>
                    </div>
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={updatingId === anomaly.id}
                    onClick={() => void updateStatus(anomaly, 'dismissed')}
                    className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <XCircle className="h-4 w-4" />
                    Dismiss
                  </button>
                  <button
                    type="button"
                    disabled={updatingId === anomaly.id}
                    onClick={() => void updateStatus(anomaly, 'resolved')}
                    className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <CheckCircle className="h-4 w-4" />
                    Resolve
                  </button>
                  <button
                    type="button"
                    disabled={updatingId === anomaly.id}
                    onClick={() => void updateStatus(anomaly, 'promoted')}
                    className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <ExternalLink className="h-4 w-4" />
                    Promote
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
