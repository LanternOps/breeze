import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, AlertTriangle, Clock, Pencil, RefreshCcw, Server, TrendingUp } from 'lucide-react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts';
import { fetchWithAuth } from '../../stores/auth';
import SNMPDeviceEditor from './SNMPDeviceEditor';

type MetricStatus = 'ok' | 'warning' | 'critical';
type ThresholdSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

type DeviceSummary = {
  id: string;
  name: string;
  ipAddress: string;
  status: string;
  template: {
    id: string;
    name: string;
  } | null;
  lastPolledAt: string | null;
  recentMetrics: {
    capturedAt: string;
    metrics: DeviceMetric[];
  } | null;
};

type DeviceMetric = {
  oid: string;
  name: string;
  value: string | null;
  recordedAt: string;
};

type ThresholdItem = {
  id: string;
  oid: string;
  operator: string | null;
  threshold: string | null;
  severity: ThresholdSeverity;
  message: string | null;
  isActive: boolean;
};

type HistorySeriesPoint = {
  timestamp: string;
  value: string | null;
};

type HistorySeries = {
  oid: string;
  name: string;
  points: HistorySeriesPoint[];
};

type TrafficSeries = {
  key: string;
  label: string;
  color: string;
};

type TrafficPoint = {
  timestamp: string;
  [key: string]: number | string | null;
};

const metricStatusStyles: Record<MetricStatus, string> = {
  ok: 'bg-green-500/20 text-green-700 border-green-500/40',
  warning: 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40',
  critical: 'bg-red-500/20 text-red-700 border-red-500/40'
};

const deviceStatusStyles: Record<string, string> = {
  online: 'bg-green-500/20 text-green-700 border-green-500/40',
  up: 'bg-green-500/20 text-green-700 border-green-500/40',
  degraded: 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40',
  offline: 'bg-red-500/20 text-red-700 border-red-500/40',
  down: 'bg-red-500/20 text-red-700 border-red-500/40'
};

const thresholdSeverityStyles: Record<ThresholdSeverity, string> = {
  critical: 'bg-red-500/10 text-red-700',
  high: 'bg-red-500/10 text-red-700',
  medium: 'bg-yellow-500/10 text-yellow-700',
  low: 'bg-blue-500/10 text-blue-700',
  info: 'bg-muted text-muted-foreground'
};

const trafficColors = ['#0ea5e9', '#22c55e', '#f59e0b', '#ef4444'];

function parseMetricValue(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatChartTimestamp(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return 'N/A';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'N/A';
  return date.toLocaleString();
}

function formatRelativeTime(value: string | null | undefined): string {
  if (!value) return 'N/A';
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return 'N/A';

  const diffMs = Date.now() - timestamp;
  const diffSeconds = Math.max(0, Math.floor(diffMs / 1000));
  if (diffSeconds < 60) return 'just now';
  if (diffSeconds < 3600) return `${Math.floor(diffSeconds / 60)}m ago`;
  if (diffSeconds < 86400) return `${Math.floor(diffSeconds / 3600)}h ago`;
  return `${Math.floor(diffSeconds / 86400)}d ago`;
}

function formatUptime(value: string | null | undefined): string {
  if (!value) return 'N/A';
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return value;

  // SNMP sysUpTime usually reports hundredths of seconds.
  const totalSeconds = Math.floor(parsed / 100);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function inferMetricStatus(metric: DeviceMetric): MetricStatus {
  const label = metric.name.toLowerCase();
  const value = parseMetricValue(metric.value);

  if (value === null) return 'ok';

  if (label.includes('error')) {
    if (value > 100) return 'critical';
    if (value > 0) return 'warning';
    return 'ok';
  }

  if (label.includes('utilization') || label.includes('usage') || label.includes('percent') || metric.value?.includes('%')) {
    if (value >= 90) return 'critical';
    if (value >= 75) return 'warning';
    return 'ok';
  }

  if (label.includes('temperature') || label.includes('temp')) {
    if (value >= 80) return 'critical';
    if (value >= 65) return 'warning';
    return 'ok';
  }

  return 'ok';
}

function inferMetricUnit(metric: DeviceMetric): string {
  const label = metric.name.toLowerCase();
  if (metric.value?.includes('%') || label.includes('utilization') || label.includes('percent')) return '%';
  if (label.includes('temperature') || label.includes('temp')) return 'C';
  if (label.includes('error')) return 'errors';
  if (label.includes('octet') || label.includes('byte')) return 'octets';
  return '';
}

function metricDisplayValue(metric: DeviceMetric, unit: string): string {
  if (!metric.value) return '—';
  if (!unit || metric.value.toLowerCase().includes(unit.toLowerCase())) return metric.value;
  return `${metric.value} ${unit}`;
}

function findUptimeMetric(metrics: DeviceMetric[]): DeviceMetric | undefined {
  return metrics.find((metric) => {
    const label = `${metric.oid} ${metric.name}`.toLowerCase();
    return label.includes('uptime');
  });
}

function isInterfaceMetric(series: HistorySeries): boolean {
  const label = `${series.oid} ${series.name}`.toLowerCase();
  return label.includes('ifin')
    || label.includes('ifout')
    || label.includes('octets')
    || label.includes('interface');
}

type Props = {
  deviceId?: string;
};

export default function SNMPDeviceDetail({ deviceId }: Props) {
  const [resolvedDeviceId, setResolvedDeviceId] = useState<string | null>(deviceId ?? null);
  const [resolveLoading, setResolveLoading] = useState(!deviceId);
  const [resolveError, setResolveError] = useState<string>();

  const [deviceLoading, setDeviceLoading] = useState(false);
  const [deviceError, setDeviceError] = useState<string>();
  const [deviceSummary, setDeviceSummary] = useState<DeviceSummary | null>(null);

  const [thresholdsLoading, setThresholdsLoading] = useState(false);
  const [thresholdsError, setThresholdsError] = useState<string>();
  const [thresholds, setThresholds] = useState<ThresholdItem[]>([]);

  const [trafficLoading, setTrafficLoading] = useState(true);
  const [trafficError, setTrafficError] = useState<string>();
  const [trafficSeries, setTrafficSeries] = useState<TrafficSeries[]>([]);
  const [trafficData, setTrafficData] = useState<TrafficPoint[]>([]);

  const [polling, setPolling] = useState(false);
  const [pollMessage, setPollMessage] = useState<string>();
  const [refreshKey, setRefreshKey] = useState(0);
  const [editingDevice, setEditingDevice] = useState(false);

  const latestMetrics = deviceSummary?.recentMetrics?.metrics ?? [];
  const metricsByOid = useMemo(() => {
    const map = new Map<string, DeviceMetric>();
    latestMetrics.forEach((metric) => map.set(metric.oid, metric));
    return map;
  }, [latestMetrics]);
  const uptimeMetric = findUptimeMetric(latestMetrics);

  const metricCards = useMemo(() => {
    return latestMetrics.slice(0, 4).map((metric, index) => {
      const unit = inferMetricUnit(metric);
      return {
        id: `${metric.oid}-${index}`,
        name: metric.name,
        value: metricDisplayValue(metric, unit),
        status: inferMetricStatus(metric),
        description: metric.oid
      };
    });
  }, [latestMetrics]);

  const resolveDevice = useCallback(async () => {
    setResolveError(undefined);
    setPollMessage(undefined);

    if (deviceId) {
      setResolvedDeviceId(deviceId);
      setResolveLoading(false);
      return;
    }

    setResolveLoading(true);
    try {
      const devicesResponse = await fetchWithAuth('/snmp/devices');
      if (!devicesResponse.ok) throw new Error('Failed to load SNMP devices');
      const payload = await devicesResponse.json();
      const devices = (payload.data ?? []) as Array<{ id: string }>;
      setResolvedDeviceId(devices[0]?.id ?? null);
    } catch (err) {
      setResolveError(err instanceof Error ? err.message : 'Failed to load SNMP devices');
      setResolvedDeviceId(null);
    } finally {
      setResolveLoading(false);
    }
  }, [deviceId]);

  const loadDeviceSummary = useCallback(async () => {
    if (!resolvedDeviceId) {
      setDeviceSummary(null);
      return;
    }

    setDeviceLoading(true);
    setDeviceError(undefined);
    try {
      const response = await fetchWithAuth(`/snmp/devices/${resolvedDeviceId}`);
      if (!response.ok) throw new Error('Failed to load SNMP device details');
      const payload = await response.json();
      setDeviceSummary(payload.data as DeviceSummary);
    } catch (err) {
      setDeviceError(err instanceof Error ? err.message : 'Failed to load SNMP device details');
      setDeviceSummary(null);
    } finally {
      setDeviceLoading(false);
    }
  }, [resolvedDeviceId]);

  const loadThresholds = useCallback(async () => {
    if (!resolvedDeviceId) {
      setThresholds([]);
      return;
    }

    setThresholdsLoading(true);
    setThresholdsError(undefined);
    try {
      const response = await fetchWithAuth(`/snmp/thresholds/${resolvedDeviceId}`);
      if (!response.ok) throw new Error('Failed to load SNMP thresholds');
      const payload = await response.json();
      setThresholds((payload.data ?? []) as ThresholdItem[]);
    } catch (err) {
      setThresholdsError(err instanceof Error ? err.message : 'Failed to load SNMP thresholds');
      setThresholds([]);
    } finally {
      setThresholdsLoading(false);
    }
  }, [resolvedDeviceId]);

  const loadTrafficHistory = useCallback(async () => {
    if (!resolvedDeviceId) {
      setTrafficLoading(false);
      setTrafficSeries([]);
      setTrafficData([]);
      return;
    }

    setTrafficLoading(true);
    setTrafficError(undefined);
    try {
      const end = new Date();
      const start = new Date(end.getTime() - 6 * 60 * 60 * 1000);
      const response = await fetchWithAuth(
        `/snmp/metrics/${resolvedDeviceId}/history?start=${start.toISOString()}&end=${end.toISOString()}&interval=15m`
      );
      if (!response.ok) throw new Error('Failed to load interface traffic history');

      const payload = await response.json();
      const allSeries = (payload.data?.series ?? []) as HistorySeries[];
      const nonEmptySeries = allSeries.filter((series) => Array.isArray(series.points) && series.points.length > 0);
      const preferredSeries = nonEmptySeries.filter(isInterfaceMetric);
      const selectedSeries = (preferredSeries.length > 0 ? preferredSeries : nonEmptySeries).slice(0, 2);

      if (selectedSeries.length === 0) {
        setTrafficSeries([]);
        setTrafficData([]);
        return;
      }

      const mappedSeries = selectedSeries.map((series, index) => ({
        key: `series_${index}`,
        label: series.name || series.oid,
        color: trafficColors[index % trafficColors.length]
      }));

      const rows = new Map<string, TrafficPoint>();
      selectedSeries.forEach((series, index) => {
        const key = mappedSeries[index]!.key;
        series.points.forEach((point) => {
          const row = rows.get(point.timestamp) ?? { timestamp: point.timestamp };
          row[key] = parseMetricValue(point.value);
          rows.set(point.timestamp, row);
        });
      });

      const mappedData = Array.from(rows.values()).sort(
        (a, b) => new Date(String(a.timestamp)).getTime() - new Date(String(b.timestamp)).getTime()
      );

      setTrafficSeries(mappedSeries);
      setTrafficData(mappedData);
    } catch (err) {
      setTrafficError(err instanceof Error ? err.message : 'Failed to load interface traffic history');
      setTrafficSeries([]);
      setTrafficData([]);
    } finally {
      setTrafficLoading(false);
    }
  }, [resolvedDeviceId]);

  const reloadAll = useCallback(() => {
    setRefreshKey((key) => key + 1);
  }, []);

  const handlePollNow = useCallback(async () => {
    if (!resolvedDeviceId) return;

    setPolling(true);
    setPollMessage(undefined);
    try {
      const response = await fetchWithAuth(`/snmp/devices/${resolvedDeviceId}/poll`, { method: 'POST' });
      if (!response.ok) throw new Error('Failed to queue SNMP poll');
      setPollMessage('Poll request queued.');
      reloadAll();
    } catch (err) {
      setPollMessage(err instanceof Error ? err.message : 'Failed to queue SNMP poll');
    } finally {
      setPolling(false);
    }
  }, [resolvedDeviceId, reloadAll]);

  useEffect(() => {
    void resolveDevice();
  }, [resolveDevice, refreshKey]);

  useEffect(() => {
    if (!resolvedDeviceId) return;
    void Promise.all([
      loadDeviceSummary(),
      loadThresholds(),
      loadTrafficHistory()
    ]);
  }, [resolvedDeviceId, loadDeviceSummary, loadThresholds, loadTrafficHistory, refreshKey]);

  const headerDevice = deviceSummary;
  const headerStatus = (headerDevice?.status ?? 'unknown').toLowerCase();
  const headerStatusStyle = deviceStatusStyles[headerStatus] ?? 'bg-muted text-muted-foreground border-muted-foreground/30';

  if (resolveLoading) {
    return (
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
          Loading SNMP device details...
        </div>
      </div>
    );
  }

  if (resolveError) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{resolveError}</p>
        <button
          type="button"
          onClick={reloadAll}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Try again
        </button>
      </div>
    );
  }

  if (!resolvedDeviceId) {
    return (
      <div className="rounded-lg border bg-card p-6 shadow-sm text-center text-sm text-muted-foreground">
        No SNMP devices available.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-md bg-muted">
              <Server className="h-6 w-6 text-muted-foreground" />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-3">
                <h2 className="text-xl font-semibold">{headerDevice?.name ?? 'SNMP Device'}</h2>
                <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${headerStatusStyle}`}>
                  {headerStatus}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
                <span>{headerDevice?.ipAddress ?? 'N/A'}</span>
                <span>{headerDevice?.template?.name ?? 'No template assigned'}</span>
                <span className="inline-flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  Last polled {formatRelativeTime(headerDevice?.lastPolledAt)}
                </span>
                <span>Uptime {formatUptime(uptimeMetric?.value)}</span>
              </div>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                void handlePollNow();
              }}
              disabled={polling}
              className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium disabled:opacity-60"
            >
              <RefreshCcw className={`h-4 w-4 ${polling ? 'animate-spin' : ''}`} />
              {polling ? 'Queueing poll...' : 'Poll now'}
            </button>
            <button
              type="button"
              onClick={() => setEditingDevice(true)}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground"
            >
              <Pencil className="h-4 w-4" />
              Edit device
            </button>
          </div>
        </div>
        {(deviceError || pollMessage) && (
          <div className={`mt-4 rounded-md border px-3 py-2 text-sm ${deviceError ? 'border-destructive/40 bg-destructive/10 text-destructive' : 'border-border bg-muted/30 text-muted-foreground'}`}>
            {deviceError ?? pollMessage}
          </div>
        )}
      </div>

      {editingDevice && (
        <SNMPDeviceEditor
          deviceId={resolvedDeviceId}
          onCancel={() => setEditingDevice(false)}
          onSaved={() => {
            setEditingDevice(false);
            setPollMessage('Device updated.');
            reloadAll();
          }}
        />
      )}

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {deviceLoading ? (
          <div className="rounded-lg border bg-card p-4 shadow-sm text-sm text-muted-foreground lg:col-span-4">
            Loading latest SNMP metrics...
          </div>
        ) : metricCards.length === 0 ? (
          <div className="rounded-lg border bg-card p-4 shadow-sm text-sm text-muted-foreground lg:col-span-4">
            No recent SNMP metrics available.
          </div>
        ) : (
          metricCards.map((metric) => (
            <div key={metric.id} className="rounded-lg border bg-card p-4 shadow-sm">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">{metric.name}</p>
                  <p className="mt-2 text-2xl font-semibold">{metric.value}</p>
                </div>
                <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${metricStatusStyles[metric.status]}`}>
                  {metric.status}
                </span>
              </div>
              <p className="mt-3 text-xs text-muted-foreground">OID {metric.description}</p>
            </div>
          ))
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="rounded-lg border bg-card p-6 shadow-sm lg:col-span-2">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-lg font-semibold">Interface traffic</h3>
              <p className="text-xs text-muted-foreground">Last 6 hours from SNMP metric history</p>
            </div>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="mt-4 h-56">
            {trafficLoading ? (
              <div className="flex h-full items-center justify-center rounded-md border border-dashed bg-muted/40 text-sm text-muted-foreground">
                Loading interface traffic...
              </div>
            ) : trafficError ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 rounded-md border border-destructive/40 bg-destructive/10 px-4 text-center text-sm text-destructive">
                <p>{trafficError}</p>
                <button
                  type="button"
                  onClick={reloadAll}
                  className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground"
                >
                  Retry
                </button>
              </div>
            ) : trafficSeries.length > 0 && trafficData.length > 0 ? (
              <div className="h-full" aria-label="SNMP interface traffic chart">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={trafficData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis
                      dataKey="timestamp"
                      tickFormatter={(timestamp) => formatChartTimestamp(String(timestamp))}
                      tick={{ fontSize: 11 }}
                      stroke="hsl(var(--muted-foreground))"
                    />
                    <YAxis
                      tick={{ fontSize: 11 }}
                      stroke="hsl(var(--muted-foreground))"
                      tickFormatter={(value) => Number(value).toLocaleString()}
                    />
                    <Tooltip
                      labelFormatter={(timestamp) => new Date(String(timestamp)).toLocaleString()}
                      formatter={(value: number, name: string) => [value?.toLocaleString() ?? '—', name]}
                      contentStyle={{
                        backgroundColor: 'hsl(var(--card))',
                        border: '1px solid hsl(var(--border))',
                        borderRadius: '6px',
                        fontSize: '12px'
                      }}
                    />
                    {trafficSeries.map((series) => (
                      <Line
                        key={series.key}
                        type="monotone"
                        dataKey={series.key}
                        name={series.label}
                        stroke={series.color}
                        strokeWidth={2}
                        dot={false}
                        connectNulls
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div className="flex h-full items-center justify-center rounded-md border border-dashed bg-muted/40 text-sm text-muted-foreground">
                No interface traffic history available.
              </div>
            )}
          </div>
        </div>

        <div className="rounded-lg border bg-card p-6 shadow-sm">
          <h3 className="text-lg font-semibold">Threshold alerts</h3>
          <div className="mt-4 space-y-3">
            {thresholdsLoading ? (
              <div className="rounded-md border bg-background p-3 text-sm text-muted-foreground">
                Loading thresholds...
              </div>
            ) : thresholdsError ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                {thresholdsError}
              </div>
            ) : thresholds.length === 0 ? (
              <div className="rounded-md border bg-background p-3 text-sm text-muted-foreground">
                No thresholds configured.
              </div>
            ) : (
              thresholds.map((threshold) => {
                const latest = metricsByOid.get(threshold.oid);
                const condition = `${threshold.operator ?? ''} ${threshold.threshold ?? ''}`.trim() || 'No condition';
                return (
                  <div key={threshold.id} className="rounded-md border bg-background p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-medium">{threshold.message ?? latest?.name ?? threshold.oid}</p>
                        <p className="text-xs text-muted-foreground">{condition} - {latest?.value ?? 'No recent value'}</p>
                      </div>
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${thresholdSeverityStyles[threshold.severity]}`}>
                        {threshold.severity}
                      </span>
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground">{threshold.isActive ? 'Active' : 'Disabled'}</p>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>

      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold">Recent values</h3>
            <p className="text-xs text-muted-foreground">Latest SNMP samples by OID</p>
          </div>
          <Activity className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="mt-4 overflow-hidden rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-4 py-3 text-left font-medium">OID</th>
                <th className="px-4 py-3 text-left font-medium">Label</th>
                <th className="px-4 py-3 text-left font-medium">Value</th>
                <th className="px-4 py-3 text-left font-medium">Timestamp</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {latestMetrics.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center text-muted-foreground">
                    No recent metric values available.
                  </td>
                </tr>
              ) : (
                latestMetrics.map((row, index) => (
                  <tr key={`${row.oid}-${index}`} className="bg-background">
                    <td className="px-4 py-3 text-muted-foreground">{row.oid}</td>
                    <td className="px-4 py-3">{row.name}</td>
                    <td className="px-4 py-3 font-medium">{row.value ?? '—'}</td>
                    <td className="px-4 py-3 text-muted-foreground">{formatRelativeTime(row.recordedAt)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="mt-4 flex items-start gap-2 rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-4 w-4" />
          Latest SNMP capture: {formatTimestamp(deviceSummary?.recentMetrics?.capturedAt)}
        </div>
      </div>
    </div>
  );
}
