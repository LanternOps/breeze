import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import DashboardGrid, { type GridItem } from './DashboardGrid';
import WidgetRenderer, { type WidgetDefinition } from './WidgetRenderer';
import QueryBuilder from './QueryBuilder';
import CapacityForecast, { type ForecastPoint, type Thresholds } from './CapacityForecast';
import SLAComplianceCard from './SLAComplianceCard';
import ExecutiveSummary, { type ExecutiveSummaryProps } from './ExecutiveSummary';
import { fetchWithAuth } from '../../stores/auth';

const dashboardOptions = [
  { value: 'operations', label: 'Operations Overview' },
  { value: 'capacity', label: 'Capacity Planning' },
  { value: 'sla', label: 'SLA Compliance' }
];

const dateRanges = [
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: 'custom', label: 'Custom range' }
];

type PerformancePoint = {
  timestamp: string;
  cpu: number;
  memory: number;
};

type OsDistributionPoint = {
  name: string;
  value: number;
};

type AlertRow = {
  severity: string;
  count: number;
};

type SummaryMetrics = {
  uptime: number;
  uptimeChange?: number;
  uptimeChangeLabel?: string;
  sessions: number;
  sessionsChange?: number;
  sessionsChangeLabel?: string;
};

type ComplianceStats = {
  complianceRate: number;
  totalPolicies?: number;
  enabledPolicies?: number;
};

type CapacityState = {
  currentValue: number;
  data: ForecastPoint[];
  thresholds?: Thresholds;
};

type SlaSummary = {
  uptime: number;
  target?: number;
  incidents?: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const getRecord = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});

const parseNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
};

const pickOptionalNumber = (...values: unknown[]): number | undefined => {
  for (const value of values) {
    const parsed = parseNumber(value);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
};

const pickNumber = (...values: unknown[]): number => pickOptionalNumber(...values) ?? 0;

const normalizeTrendData = (raw: unknown): Array<{ timestamp: string; value: number }> => {
  if (!Array.isArray(raw)) return [];

  return raw
    .map((item, index) => {
      const record = getRecord(item);
      const label = record.timestamp ?? record.label ?? record.period ?? record.date;
      const timestamp = label ? String(label) : String(index + 1);
      const value = pickOptionalNumber(record.value, record.count, record.metric, record.total, record.average);
      if (value === undefined) return null;
      return { timestamp, value };
    })
    .filter((item): item is { timestamp: string; value: number } => Boolean(item));
};

const normalizePerformanceData = (raw: unknown): PerformancePoint[] => {
  const record = getRecord(raw);
  const seriesRecord = isRecord(record.series) ? record.series : record;
  const cpuSeries = Array.isArray(seriesRecord.cpu) ? seriesRecord.cpu : null;
  const memorySeries = Array.isArray(seriesRecord.memory)
    ? seriesRecord.memory
    : Array.isArray(seriesRecord.ram)
      ? seriesRecord.ram
      : null;

  if (cpuSeries || memorySeries) {
    const merged = new Map<string, PerformancePoint>();
    const addSeries = (series: unknown[], key: 'cpu' | 'memory') => {
      series.forEach((entry, index) => {
        const item = getRecord(entry);
        const label = item.timestamp ?? item.time ?? item.label ?? item.bucket;
        const timestamp = label ? String(label) : String(index + 1);
        const value = pickNumber(item.value, item.percent, item.usage, item[key]);
        const existing = merged.get(timestamp) ?? { timestamp, cpu: 0, memory: 0 };
        existing[key] = value;
        merged.set(timestamp, existing);
      });
    };

    if (cpuSeries) addSeries(cpuSeries, 'cpu');
    if (memorySeries) addSeries(memorySeries, 'memory');
    return Array.from(merged.values());
  }

  const data = Array.isArray(raw)
    ? raw
    : Array.isArray(record.data)
      ? record.data
      : Array.isArray(record.series)
        ? record.series
        : [];

  if (!Array.isArray(data)) return [];

  return data.map((entry, index) => {
    const item = getRecord(entry);
    const label = item.timestamp ?? item.time ?? item.label ?? item.bucket;
    const timestamp = label ? String(label) : String(index + 1);
    const metrics = getRecord(item.metrics);
    const value = getRecord(item.value);
    const cpu = pickNumber(
      item.cpu,
      item.cpuPercent,
      item.cpuUsage,
      metrics.cpu,
      metrics.cpuPercent,
      value.cpu
    );
    const memory = pickNumber(
      item.memory,
      item.memoryPercent,
      item.ram,
      item.mem,
      metrics.memory,
      metrics.ram,
      value.memory
    );
    return { timestamp, cpu, memory };
  });
};

const normalizeOsDistribution = (raw: unknown): OsDistributionPoint[] => {
  const record = getRecord(raw);
  const data = Array.isArray(raw)
    ? raw
    : Array.isArray(record.data)
      ? record.data
      : Array.isArray(record.distribution)
        ? record.distribution
        : null;

  if (data && Array.isArray(data)) {
    return data
      .map((entry) => {
        const item = getRecord(entry);
        const label = item.name ?? item.os ?? item.label ?? item.key;
        if (!label) return null;
        const value = pickNumber(item.value, item.count, item.total, item.percentage);
        return { name: String(label), value };
      })
      .filter((item): item is OsDistributionPoint => Boolean(item));
  }

  const distribution = isRecord(record.distribution)
    ? record.distribution
    : isRecord(record.os)
      ? record.os
      : record;

  return Object.entries(distribution)
    .map(([key, value]) => ({ name: key, value: pickNumber(value) }))
    .filter(item => item.name);
};

const buildAlertStats = (raw: unknown) => {
  const record = getRecord(raw);
  const source = isRecord(record.data) ? record.data : record;
  const bySeverity = getRecord(source.bySeverity);
  const critical = pickNumber(source.critical, bySeverity.critical);
  const high = pickNumber(source.high, bySeverity.high);
  const medium = pickNumber(source.medium, bySeverity.medium);
  const low = pickNumber(source.low, bySeverity.low);
  const acknowledged = pickOptionalNumber(source.acknowledged, bySeverity.acknowledged);

  const rows: AlertRow[] = [
    { severity: 'Critical', count: critical },
    { severity: 'High', count: high },
    { severity: 'Medium', count: medium },
    { severity: 'Low', count: low }
  ];

  if (acknowledged !== undefined) {
    rows.push({ severity: 'Acknowledged', count: acknowledged });
  }

  return {
    rows,
    summary: {
      critical,
      warning: high + medium
    }
  };
};

const normalizeComplianceStats = (raw: unknown): ComplianceStats => {
  const record = getRecord(raw);
  const source = isRecord(record.data) ? record.data : record;
  const overview = getRecord(source.complianceOverview);
  let complianceRate = pickOptionalNumber(
    source.complianceRate,
    source.complianceScore,
    source.compliance_score
  );

  if (complianceRate === undefined) {
    const compliant = pickNumber(overview.compliant);
    const nonCompliant = pickNumber(overview.non_compliant, overview.nonCompliant);
    const pending = pickNumber(overview.pending);
    const error = pickNumber(overview.error);
    const total = compliant + nonCompliant + pending + error;
    if (total > 0) {
      complianceRate = Math.round((compliant / total) * 100);
    }
  }

  return {
    complianceRate: complianceRate ?? 0,
    totalPolicies: pickOptionalNumber(source.totalPolicies, source.total, source.policyCount),
    enabledPolicies: pickOptionalNumber(source.enabledPolicies, source.enabled)
  };
};

const normalizeCapacity = (raw: unknown): CapacityState => {
  const record = getRecord(raw);
  const data = Array.isArray(record.predictions)
    ? record.predictions
    : Array.isArray(record.data)
      ? record.data
      : Array.isArray(record.series)
        ? record.series
        : [];

  const forecast = Array.isArray(data)
    ? data.map((entry, index) => {
      const item = getRecord(entry);
      const label = item.timestamp ?? item.label ?? item.period ?? item.date;
      const timestamp = label ? String(label) : String(index + 1);
      const value = pickNumber(item.value, item.forecast, item.utilization, item.actual);
      const trend = pickOptionalNumber(item.trend, item.projected, item.predicted);
      return { timestamp, value, trend };
    })
    : [];

  const thresholdsRecord = getRecord(record.thresholds);
  const thresholds = Object.keys(thresholdsRecord).length
    ? {
      warning: pickOptionalNumber(thresholdsRecord.warning, thresholdsRecord.warn),
      critical: pickOptionalNumber(thresholdsRecord.critical, thresholdsRecord.crit)
    }
    : undefined;

  return {
    currentValue: pickNumber(record.currentValue, record.current, record.utilization, forecast[0]?.value),
    data: forecast,
    thresholds
  };
};

const normalizeSla = (raw: unknown): SlaSummary => {
  const record = getRecord(raw);
  const source = Array.isArray(record.data) && record.data.length > 0 ? record.data[0] : record;
  const sourceRecord = getRecord(source);
  const history = Array.isArray(sourceRecord.history) ? sourceRecord.history : [];
  const historyRecord = history.length > 0 ? getRecord(history[0]) : {};

  return {
    uptime: pickNumber(
      sourceRecord.uptime,
      sourceRecord.compliancePercentage,
      sourceRecord.compliance,
      historyRecord.compliancePercentage
    ),
    target: pickOptionalNumber(sourceRecord.targetPercentage, sourceRecord.target, sourceRecord.slaTarget),
    incidents: pickOptionalNumber(sourceRecord.incidents, sourceRecord.incidentCount, sourceRecord.breachCount)
  };
};

const fetchJson = async (url: string) => {
  const response = await fetchWithAuth(url);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

interface AnalyticsPageProps {
  timezone?: string;
}

export default function AnalyticsPage({ timezone }: AnalyticsPageProps) {
  const [selectedDashboard, setSelectedDashboard] = useState('operations');
  const [dateRange, setDateRange] = useState('30d');
  const [customStartDate, setCustomStartDate] = useState('');
  const [customEndDate, setCustomEndDate] = useState('');
  const [summaryMetrics, setSummaryMetrics] = useState<SummaryMetrics>({
    uptime: 0,
    sessions: 0
  });
  const [performanceData, setPerformanceData] = useState<PerformancePoint[]>([]);
  const [osDistribution, setOsDistribution] = useState<OsDistributionPoint[]>([]);
  const [alertRows, setAlertRows] = useState<AlertRow[]>([]);
  const [complianceStats, setComplianceStats] = useState<ComplianceStats>({ complianceRate: 0 });
  const [capacityForecast, setCapacityForecast] = useState<CapacityState>({ currentValue: 0, data: [] });
  const [slaSummary, setSlaSummary] = useState<SlaSummary>({ uptime: 0, incidents: 0 });
  const [executiveSummary, setExecutiveSummary] = useState<ExecutiveSummaryProps>({
    totalDevices: 0,
    onlineDevices: 0,
    offlineDevices: 0,
    criticalAlerts: 0,
    warningAlerts: 0,
    trendData: [],
    trendLabel: 'Operational health'
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const rangeLabel = useMemo(
    () => dateRanges.find(option => option.value === dateRange)?.label ?? 'Custom range',
    [dateRange]
  );

  const fetchAnalyticsData = useCallback(async () => {
    setError(undefined);
    setLoading(true);

    const errors: string[] = [];
    const params = new URLSearchParams();

    if (dateRange !== 'custom') {
      params.set('range', dateRange);
    } else {
      if (customStartDate) params.set('startDate', customStartDate);
      if (customEndDate) params.set('endDate', customEndDate);
    }

    const queryString = params.toString();
    const withQuery = (url: string) => (queryString ? `${url}?${queryString}` : url);

    let metricsRecord: Record<string, unknown> = {};
    let analyticsRecord: Record<string, unknown> = {};
    let alertSummary = { critical: 0, warning: 0 };

    try {
      await Promise.all([
        (async () => {
          try {
            let metricsData = await fetchJson(withQuery('/metrics'));
            if (!metricsData) {
              metricsData = await fetchJson(withQuery('/metrics/json'));
            }
            const metricsPayload = getRecord(metricsData);
            const dataPayload = isRecord(metricsPayload.data) ? metricsPayload.data : metricsPayload;
            metricsRecord = getRecord(dataPayload);
            const metrics = getRecord(metricsRecord.metrics);

            setSummaryMetrics({
              uptime: pickNumber(metricsRecord.uptime, metrics.uptime),
              uptimeChange: pickOptionalNumber(metricsRecord.uptimeChange, metrics.uptimeChange),
              uptimeChangeLabel: typeof metricsRecord.uptimeChangeLabel === 'string'
                ? metricsRecord.uptimeChangeLabel
                : undefined,
              sessions: pickNumber(
                metricsRecord.remoteSessions,
                metricsRecord.sessions,
                metrics.remoteSessions,
                metrics.sessions
              ),
              sessionsChange: pickOptionalNumber(metricsRecord.sessionsChange, metrics.sessionsChange),
              sessionsChangeLabel: typeof metricsRecord.sessionsChangeLabel === 'string'
                ? metricsRecord.sessionsChangeLabel
                : undefined
            });
          } catch (err) {
            errors.push('metrics');
            setSummaryMetrics({ uptime: 0, sessions: 0 });
          }
        })(),
        (async () => {
          try {
            const analyticsData = await fetchJson(withQuery('/analytics/executive-summary'));
            const analyticsPayload = getRecord(analyticsData);
            const dataPayload = isRecord(analyticsPayload.data) ? analyticsPayload.data : analyticsPayload;
            analyticsRecord = getRecord(dataPayload);
          } catch (err) {
            errors.push('analytics');
            analyticsRecord = {};
          }
        })(),
        (async () => {
          try {
            const trendsData = await fetchJson(withQuery('/metrics/trends'));
            setPerformanceData(normalizePerformanceData(trendsData));
          } catch (err) {
            errors.push('performance');
            setPerformanceData([]);
          }
        })(),
        (async () => {
          try {
            const osData = await fetchJson(withQuery('/analytics/os-distribution'));
            const fallback = osData ?? await fetchJson(withQuery('/devices/stats'));
            setOsDistribution(normalizeOsDistribution(fallback));
          } catch (err) {
            errors.push('os');
            setOsDistribution([]);
          }
        })(),
        (async () => {
          try {
            const alertData = await fetchJson(withQuery('/alerts/summary'));
            const { rows, summary } = buildAlertStats(alertData);
            setAlertRows(rows);
            alertSummary = summary;
          } catch (err) {
            errors.push('alerts');
            setAlertRows([]);
          }
        })(),
        (async () => {
          try {
            let complianceData = await fetchJson(withQuery('/policies/compliance/stats'));
            if (!complianceData) {
              complianceData = await fetchJson(withQuery('/policies/compliance/summary'));
            }
            setComplianceStats(normalizeComplianceStats(complianceData));
          } catch (err) {
            errors.push('compliance');
            setComplianceStats({ complianceRate: 0 });
          }
        })(),
        (async () => {
          try {
            const capacityData = await fetchJson(withQuery('/analytics/capacity'));
            setCapacityForecast(normalizeCapacity(capacityData));
          } catch (err) {
            errors.push('capacity');
            setCapacityForecast({ currentValue: 0, data: [] });
          }
        })(),
        (async () => {
          try {
            const slaData = await fetchJson(withQuery('/analytics/sla'));
            setSlaSummary(normalizeSla(slaData));
          } catch (err) {
            errors.push('sla');
            setSlaSummary({ uptime: 0, incidents: 0 });
          }
        })()
      ]);

      const businessMetrics = getRecord(metricsRecord.business_metrics);
      const analyticsDevices = getRecord(analyticsRecord.devices);
      const metricsDevices = getRecord(metricsRecord.devices);

      const totalDevices = pickNumber(
        analyticsDevices.total,
        metricsDevices.total,
        analyticsRecord.totalDevices,
        metricsRecord.totalDevices,
        businessMetrics.devices_total,
        businessMetrics.devices_active
      );
      const onlineDevices = pickNumber(
        analyticsDevices.online,
        metricsDevices.online,
        analyticsRecord.onlineDevices,
        metricsRecord.onlineDevices,
        businessMetrics.devices_active
      );
      const offlineDevices = pickNumber(
        analyticsDevices.offline,
        metricsDevices.offline,
        analyticsRecord.offlineDevices,
        metricsRecord.offlineDevices,
        Math.max(totalDevices - onlineDevices, 0)
      );

      const trendData = normalizeTrendData(
        analyticsRecord.trendData ??
        analyticsRecord.trends ??
        analyticsRecord.series ??
        analyticsRecord.metrics ??
        analyticsRecord.data
      );

      setExecutiveSummary({
        totalDevices,
        onlineDevices,
        offlineDevices,
        criticalAlerts: alertSummary.critical,
        warningAlerts: alertSummary.warning,
        trendData,
        trendLabel: typeof analyticsRecord.trendLabel === 'string' ? analyticsRecord.trendLabel : 'Operational health'
      });

      if (errors.length > 0) {
        setError(`Unable to load: ${errors.join(', ')}`);
      }

      setLastUpdated(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load analytics data');
    } finally {
      setLoading(false);
    }
  }, [dateRange, customEndDate, customStartDate]);

  useEffect(() => {
    fetchAnalyticsData();
  }, [fetchAnalyticsData]);

  const widgets = useMemo<WidgetDefinition[]>(
    () => [
      {
        id: 'summary-uptime',
        title: 'Uptime',
        type: 'summary',
        data: {
          value: `${summaryMetrics.uptime.toFixed(2)}%`,
          label: 'Fleet uptime',
          change: summaryMetrics.uptimeChange,
          changeLabel: summaryMetrics.uptimeChangeLabel
        }
      },
      {
        id: 'summary-sessions',
        title: 'Remote Sessions',
        type: 'summary',
        data: {
          value: summaryMetrics.sessions,
          label: 'Sessions in range',
          change: summaryMetrics.sessionsChange,
          changeLabel: summaryMetrics.sessionsChangeLabel
        }
      },
      {
        id: 'performance',
        type: 'chart',
        data: {
          title: 'Performance Trend',
          subtitle: 'CPU and memory utilization',
          type: 'line',
          data: performanceData,
          xKey: 'timestamp',
          series: [
            { key: 'cpu', label: 'CPU', color: '#3b82f6' },
            { key: 'memory', label: 'Memory', color: '#22c55e' }
          ]
        }
      },
      {
        id: 'os-breakdown',
        type: 'chart',
        data: {
          title: 'OS Distribution',
          subtitle: 'Share of managed devices',
          type: 'pie',
          data: osDistribution,
          nameKey: 'name',
          valueKey: 'value'
        }
      },
      {
        id: 'alert-table',
        type: 'table',
        data: {
          title: 'Alert Statistics',
          columns: [
            { key: 'severity', label: 'Severity', sortable: true },
            { key: 'count', label: 'Count', sortable: true, className: 'text-right' }
          ],
          data: alertRows
        }
      },
      {
        id: 'compliance-gauge',
        type: 'gauge',
        data: {
          title: 'Policy Compliance',
          value: complianceStats.complianceRate,
          description: complianceStats.totalPolicies !== undefined
            ? `${complianceStats.enabledPolicies ?? complianceStats.totalPolicies} policies evaluated`
            : undefined
        }
      }
    ],
    [
      alertRows,
      complianceStats.enabledPolicies,
      complianceStats.complianceRate,
      complianceStats.totalPolicies,
      osDistribution,
      performanceData,
      summaryMetrics.sessions,
      summaryMetrics.sessionsChange,
      summaryMetrics.sessionsChangeLabel,
      summaryMetrics.uptime,
      summaryMetrics.uptimeChange,
      summaryMetrics.uptimeChangeLabel
    ]
  );

  const layout = useMemo<GridItem[]>(
    () => [
      { i: 'executive', x: 0, y: 0, w: 12, h: 4 },
      { i: 'summary-uptime', x: 0, y: 4, w: 3, h: 2 },
      { i: 'summary-sessions', x: 3, y: 4, w: 3, h: 2 },
      { i: 'compliance-gauge', x: 6, y: 4, w: 3, h: 2 },
      { i: 'sla-card', x: 9, y: 4, w: 3, h: 2 },
      { i: 'performance', x: 0, y: 6, w: 8, h: 4 },
      { i: 'capacity', x: 8, y: 6, w: 4, h: 4 },
      { i: 'os-breakdown', x: 0, y: 10, w: 4, h: 4 },
      { i: 'alert-table', x: 4, y: 10, w: 8, h: 4 }
    ],
    []
  );

  const widgetMap = useMemo(() => {
    const map = new Map(widgets.map(widget => [widget.id, widget]));
    return map;
  }, [widgets]);

  const isInitialLoading = loading && !lastUpdated;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-xl font-semibold">Analytics</h2>
          <p className="text-sm text-muted-foreground">Insights across your fleet and services</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <select
            value={selectedDashboard}
            onChange={event => setSelectedDashboard(event.target.value)}
            className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            {dashboardOptions.map(option => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <select
            value={dateRange}
            onChange={event => setDateRange(event.target.value)}
            className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            {dateRanges.map(option => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={fetchAnalyticsData}
            className="inline-flex h-9 items-center gap-2 rounded-md border bg-background px-3 text-sm hover:bg-muted"
            disabled={loading}
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Refresh
          </button>
          {lastUpdated && (
            <span className="text-xs text-muted-foreground">
              Updated {lastUpdated.toLocaleTimeString([], { timeZone: timezone })}
            </span>
          )}
        </div>
      </div>

      {dateRange === 'custom' && (
        <div className="flex flex-wrap items-center gap-3">
          <input
            type="date"
            value={customStartDate}
            onChange={event => setCustomStartDate(event.target.value)}
            className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <input
            type="date"
            value={customEndDate}
            onChange={event => setCustomEndDate(event.target.value)}
            className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-center">
          <p className="text-sm text-destructive">{error}</p>
          <button
            type="button"
            onClick={fetchAnalyticsData}
            className="mt-2 inline-flex items-center gap-1 text-sm text-primary hover:underline"
          >
            <RefreshCw className="h-3 w-3" />
            Retry
          </button>
        </div>
      )}

      <QueryBuilder />

      <DashboardGrid
        layout={layout}
        columns={12}
        rowHeight={76}
        gap={16}
        renderItem={item => {
          if (isInitialLoading) {
            return <div className="h-full w-full animate-pulse rounded-md bg-muted/40" />;
          }
          if (item.i === 'executive') {
            return <ExecutiveSummary {...executiveSummary} />;
          }
          if (item.i === 'sla-card') {
            return (
              <SLAComplianceCard
                uptime={slaSummary.uptime}
                target={slaSummary.target}
                incidents={slaSummary.incidents}
                periodLabel={rangeLabel}
              />
            );
          }
          if (item.i === 'capacity') {
            return (
              <CapacityForecast
                title="Capacity Forecast"
                currentValue={capacityForecast.currentValue}
                data={capacityForecast.data}
                thresholds={capacityForecast.thresholds}
              />
            );
          }
          const widget = widgetMap.get(item.i);
          return widget ? <WidgetRenderer widget={widget} /> : null;
        }}
      />
    </div>
  );
}
