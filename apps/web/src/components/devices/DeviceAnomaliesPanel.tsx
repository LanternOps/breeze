import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle, ExternalLink, RefreshCw, TrendingUp, XCircle } from 'lucide-react';

import { runAction, handleActionError } from '../../lib/runAction';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';
import RemediationSuggestionsPanel from '../remediation/RemediationSuggestionsPanel';
import { useMlFeatureFlags } from '../../hooks/useMlFeatureFlags';

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
  focusedAnomalyId?: string;
};

type PromotedAlert = {
  alertId: string;
  metricName: string;
  anomalyType: string;
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
  top_process_count: 'Top processes',
  top_process_cpu_percent_sum: 'Top process CPU total',
  top_process_cpu_percent_max: 'Top process CPU peak',
  top_process_ram_mb_sum: 'Top process RAM total',
  top_process_ram_mb_max: 'Top process RAM peak',
  top_process_disk_bps_sum: 'Top process disk I/O',
  top_process_net_bps_sum: 'Top process network I/O',
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

const statusLabels: Record<AnomalyStatus, string> = {
  open: 'Open',
  dismissed: 'Dismissed',
  promoted: 'Promoted',
  resolved: 'Resolved',
};

function formatMetricValue(metricName: string, value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (metricName.endsWith('_percent')) return `${value.toFixed(1)}%`;
  if (metricName.includes('_bps')) {
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

export default function DeviceAnomaliesPanel({ deviceId, compact = false, focusedAnomalyId }: DeviceAnomaliesPanelProps) {
  const mlFlags = useMlFeatureFlags();
  const [anomalies, setAnomalies] = useState<MetricAnomaly[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [promotedAlert, setPromotedAlert] = useState<PromotedAlert | null>(null);
  const anomaliesDisabled = mlFlags.isDisabled('ml.anomalies.enabled');

  const fetchAnomalies = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const status = focusedAnomalyId ? 'all' : 'open';
      const limit = focusedAnomalyId ? 100 : compact ? 5 : 25;
      const response = await fetchWithAuth(`/devices/${deviceId}/anomalies?status=${status}&limit=${limit}`);
      if (!response.ok) throw new Error('Failed to load metric anomalies');
      const json = await response.json();
      setAnomalies(Array.isArray(json?.data) ? json.data : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load metric anomalies');
    } finally {
      setLoading(false);
    }
  }, [compact, deviceId, focusedAnomalyId]);

  useEffect(() => {
    if (!mlFlags.loaded) return;
    if (anomaliesDisabled) {
      setAnomalies([]);
      setError(undefined);
      setLoading(false);
      return;
    }
    void fetchAnomalies();
  }, [anomaliesDisabled, fetchAnomalies, mlFlags.loaded]);

  const sorted = useMemo(
    () => [...anomalies].sort((a, b) => b.confidence - a.confidence || b.score - a.score),
    [anomalies],
  );

  async function updateStatus(anomaly: MetricAnomaly, status: Exclude<AnomalyStatus, 'open'>) {
    setUpdatingId(anomaly.id);
    try {
      const result = await runAction<{ data?: MetricAnomaly }>({
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
      if (status === 'promoted') {
        if (result.data?.linkedAlertId) {
          setPromotedAlert({
            alertId: result.data.linkedAlertId,
            metricName: anomaly.metricName,
            anomalyType: anomaly.anomalyType,
          });
        } else {
          // The promote succeeded but the backend returned no alert link, so the
          // row is about to disappear with no way to reach the created alert.
          // Surface a distinct warning so this is not mistaken for a clean promote.
          showToast({ message: 'Anomaly promoted but no alert link returned', type: 'warning' });
        }
      }
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

  if (anomaliesDisabled) {
    return (
      <div className={`rounded-lg border bg-card shadow-sm ${compact ? 'p-4' : 'p-6'}`}>
        <div className="flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-muted-foreground" />
          <div>
            <h3 className="text-lg font-semibold">Metric Anomalies</h3>
            {!compact && (
              <p className="text-sm text-muted-foreground">Anomaly detection is disabled for this organization.</p>
            )}
          </div>
        </div>
        <div className="mt-5 rounded-md border border-dashed p-6 text-center">
          <CheckCircle className="mx-auto h-8 w-8 text-muted-foreground" />
          <p className="mt-2 text-sm font-medium">Anomaly detection disabled</p>
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
              <p className="text-sm text-muted-foreground">
                {focusedAnomalyId ? 'Showing the linked anomaly and recent anomaly history' : 'Open signals detected from metric rollups'}
              </p>
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
        <>
          {promotedAlert && (
            <div className="mt-5 flex flex-col gap-3 rounded-md border border-success/30 bg-success/10 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-medium">Anomaly promoted to alert</p>
                <p className="text-xs text-muted-foreground">
                  {labelForAnomaly(promotedAlert.anomalyType)} on {labelForMetric(promotedAlert.metricName)}
                </p>
              </div>
              <a
                href={`/alerts/${promotedAlert.alertId}`}
                className="inline-flex items-center justify-center gap-2 rounded-md border bg-background px-3 py-2 text-sm font-medium hover:bg-muted"
              >
                <ExternalLink className="h-4 w-4" />
                Open alert
              </a>
            </div>
          )}
          <div className="mt-5 rounded-md border border-dashed p-6 text-center">
            <CheckCircle className="mx-auto h-8 w-8 text-success" />
            <p className="mt-2 text-sm font-medium">{focusedAnomalyId ? 'Linked anomaly not found' : 'No open anomalies'}</p>
            {!compact && <p className="text-sm text-muted-foreground">Recent metric rollups are within baseline.</p>}
          </div>
        </>
      ) : (
        <div className="mt-5 space-y-3">
          {sorted.map((anomaly) => {
            const isFocused = anomaly.id === focusedAnomalyId;
            return (
              <div
                key={anomaly.id}
                data-testid={`metric-anomaly-${anomaly.id}`}
                className={`rounded-md border p-4 ${isFocused ? 'border-primary/60 bg-primary/5 ring-2 ring-primary/20' : ''}`}
              >
                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="inline-flex items-center gap-1 rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-xs font-medium text-warning">
                        <AlertTriangle className="h-3.5 w-3.5" />
                        {labelForAnomaly(anomaly.anomalyType)}
                      </span>
                      {anomaly.status !== 'open' && (
                        <span className="inline-flex rounded-full border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                          {statusLabels[anomaly.status]}
                        </span>
                      )}
                      {isFocused && (
                        <span className="inline-flex rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                          Linked from alert
                        </span>
                      )}
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
                  {anomaly.status === 'open' ? (
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
                  ) : anomaly.linkedAlertId ? (
                    <a
                      href={`/alerts/${anomaly.linkedAlertId}`}
                      className="inline-flex shrink-0 items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted"
                    >
                      <ExternalLink className="h-4 w-4" />
                      Open alert
                    </a>
                  ) : null}
                </div>
                {!compact && anomaly.status === 'open' && (
                  <RemediationSuggestionsPanel sourceType="anomaly" sourceId={anomaly.id} />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
