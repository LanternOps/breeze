import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Cast,
  ChevronRight,
  HardDrive,
  Loader2,
  RefreshCw,
  TrendingDown,
  TrendingUp,
  WifiOff,
  type LucideIcon
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import ChartWidget from './ChartWidget';
import GaugeWidget from './GaugeWidget';
import QueryBuilder, { type QueryResult } from './QueryBuilder';
import CapacityForecast, { type ForecastPoint, type Thresholds } from './CapacityForecast';
import SLAComplianceCard from './SLAComplianceCard';
import Sparkline from '../dashboard/Sparkline';
import { fetchWithAuth } from '../../stores/auth';
import { cn, formatNumber } from '@/lib/utils';
import { formatTime } from '@/lib/dateTimeFormat';
import { formatPercent } from '@/lib/i18n/format';

const dashboardOptions = [
  { value: 'operations', labelKey: 'analytics.analyticsPage.dashboardOptions.operations' },
  { value: 'capacity', labelKey: 'analytics.analyticsPage.dashboardOptions.capacity' },
  { value: 'sla', labelKey: 'analytics.analyticsPage.dashboardOptions.sla' }
];

const dateRanges = [
  { value: '24h', labelKey: 'analytics.analyticsPage.dateRanges.last24Hours' },
  { value: '7d', labelKey: 'analytics.analyticsPage.dateRanges.last7Days' },
  { value: '30d', labelKey: 'analytics.analyticsPage.dateRanges.last30Days' },
  { value: 'custom', labelKey: 'analytics.analyticsPage.dateRanges.customRange' }
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

type AlertSeverityKey = 'critical' | 'high' | 'medium' | 'low' | 'acknowledged';

type AlertRow = {
  severity: AlertSeverityKey;
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
    { severity: 'critical', count: critical },
    { severity: 'high', count: high },
    { severity: 'medium', count: medium },
    { severity: 'low', count: low }
  ];

  if (acknowledged !== undefined) {
    rows.push({ severity: 'acknowledged', count: acknowledged });
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

/**
 * Null when the payload carries no compliance figure at all (e.g. no SLA
 * definitions exist yet) — rendering that as 0% would read as a breach.
 */
const normalizeSla = (raw: unknown): SlaSummary | null => {
  const record = getRecord(raw);
  const source = Array.isArray(record.data) && record.data.length > 0 ? record.data[0] : record;
  const sourceRecord = getRecord(source);
  const history = Array.isArray(sourceRecord.history) ? sourceRecord.history : [];
  const historyRecord = history.length > 0 ? getRecord(history[0]) : {};

  const uptime = pickOptionalNumber(
    sourceRecord.uptime,
    sourceRecord.compliancePercentage,
    sourceRecord.compliance,
    historyRecord.compliancePercentage
  );
  if (uptime === undefined) return null;

  return {
    uptime,
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

/**
 * Code `GET /metrics/trends` returns when the caller is site-restricted.
 * `metric_rollups` is pre-aggregated per organization and carries no site axis,
 * so the API denies the whole aggregate rather than serving org-wide numbers to
 * a user who may only see some sites.
 */
const SITE_SCOPED_TRENDS_CODE = 'SITE_SCOPED_TRENDS_UNAVAILABLE';

type TrendsResult =
  | { unavailable: true }
  | { unavailable: false; data: unknown };

/**
 * Reads `/metrics/trends`, inspecting the response before generic parsing so the
 * documented site-scope denial can be told apart from an ordinary failure. The
 * denial is an expected state for restricted users — every other failure still
 * throws and is reported through the page's normal error handling.
 */
const fetchTrends = async (url: string): Promise<TrendsResult> => {
  const response = await fetchWithAuth(url);
  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    if (response.status === 403 && getRecord(payload).code === SITE_SCOPED_TRENDS_CODE) {
      return { unavailable: true };
    }
    throw new Error(`${response.status} ${response.statusText}`);
  }

  return { unavailable: false, data: payload };
};

interface AnalyticsPageProps {
  timezone?: string;
}

/** Fleet-wide roll-up shown in the KPI strip and the trend card. */
type FleetSummary = {
  totalDevices: number;
  onlineDevices: number;
  offlineDevices: number;
  criticalAlerts: number;
  warningAlerts: number;
  trendData: Array<{ timestamp: string; value: number }>;
  trendLabel: string;
};

const SEVERITY_TONES: Record<AlertSeverityKey, string> = {
  critical: 'bg-destructive',
  high: 'bg-warning-strong',
  medium: 'bg-warning',
  low: 'bg-info',
  acknowledged: 'bg-chart-neutral'
};

type KpiTile = {
  key: string;
  label: string;
  value: string;
  icon: LucideIcon;
  iconTone: string;
  href?: string;
  change?: number;
  changeLabel?: string;
  sub?: string;
  subTone?: 'success' | 'warning' | 'destructive' | 'muted';
};

/** Slices beyond the top five collapse into one neutral "Other" segment. */
const OS_PIE_SLICE_LIMIT = 5;

const isDashboardValue = (value: string) => dashboardOptions.some(option => option.value === value);

export default function AnalyticsPage({ timezone }: AnalyticsPageProps) {
  const { t } = useTranslation('reports');
  const [selectedDashboard, setSelectedDashboard] = useState('operations');
  const [dateRange, setDateRange] = useState('30d');
  const [customStartDate, setCustomStartDate] = useState('');
  const [customEndDate, setCustomEndDate] = useState('');
  const [summaryMetrics, setSummaryMetrics] = useState<SummaryMetrics>({
    uptime: 0,
    sessions: 0
  });
  const [performanceData, setPerformanceData] = useState<PerformancePoint[]>([]);
  // True only for the documented site-scope denial: the trend card is hidden
  // instead of rendered empty, and the denial is not counted as a page error.
  const [performanceUnavailable, setPerformanceUnavailable] = useState(false);
  const [osDistribution, setOsDistribution] = useState<OsDistributionPoint[]>([]);
  const [alertRows, setAlertRows] = useState<AlertRow[]>([]);
  const [complianceStats, setComplianceStats] = useState<ComplianceStats>({ complianceRate: 0 });
  const [capacityForecast, setCapacityForecast] = useState<CapacityState>({ currentValue: 0, data: [] });
  const [slaSummary, setSlaSummary] = useState<SlaSummary | null>(null);
  const [fleetSummary, setFleetSummary] = useState<FleetSummary>({
    totalDevices: 0,
    onlineDevices: 0,
    offlineDevices: 0,
    criticalAlerts: 0,
    warningAlerts: 0,
    trendData: [],
    trendLabel: t('analytics.analyticsPage.trend.operationalHealth')
  });
  const [deviceIds, setDeviceIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [exploreOpen, setExploreOpen] = useState(false);
  const [queryResult, setQueryResult] = useState<{ label: string; data: Array<{ timestamp: string; value: number }> } | null>(null);

  // Selected view lives in the URL hash (repo convention for transient UI
  // state) so a view survives refresh and can be linked directly.
  useEffect(() => {
    const applyHash = () => {
      const hash = window.location.hash.replace('#', '');
      if (isDashboardValue(hash)) setSelectedDashboard(hash);
    };
    applyHash();
    window.addEventListener('hashchange', applyHash);
    return () => window.removeEventListener('hashchange', applyHash);
  }, []);

  const selectDashboard = useCallback((value: string) => {
    setSelectedDashboard(value);
    if (typeof window !== 'undefined') window.location.hash = value;
  }, []);

  const rangeLabel = useMemo(
    () => t(/* i18n-dynamic */ dateRanges.find(option => option.value === dateRange)?.labelKey ?? 'analytics.analyticsPage.dateRanges.customRange'),
    [dateRange, t]
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
            const trends = await fetchTrends(withQuery('/metrics/trends'));
            if (trends.unavailable) {
              setPerformanceUnavailable(true);
              setPerformanceData([]);
              return;
            }
            setPerformanceUnavailable(false);
            setPerformanceData(normalizePerformanceData(trends.data));
          } catch (err) {
            errors.push('performance');
            setPerformanceUnavailable(false);
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
            let summary = normalizeSla(slaData);

            // `/analytics/sla` lists SLA *definitions*; the measured numbers
            // live one call deeper. Prefer live compliance for the first
            // definition, falling back to whatever the listing carried.
            const definitions = getRecord(slaData).data;
            const firstDefinition = getRecord(Array.isArray(definitions) ? definitions[0] : undefined);
            if (typeof firstDefinition.id === 'string') {
              try {
                const compliance = getRecord(await fetchJson(`/analytics/sla/${firstDefinition.id}/compliance`));
                const history = Array.isArray(compliance.history) ? compliance.history : [];
                const uptime = pickOptionalNumber(
                  compliance.liveUptime,
                  getRecord(history[0]).compliancePercentage
                );
                if (uptime !== undefined) {
                  summary = {
                    uptime,
                    target: pickOptionalNumber(compliance.uptimeTarget, firstDefinition.uptimeTarget) ?? summary?.target,
                    incidents: summary?.incidents
                  };
                }
              } catch {
                // Definition list already loaded; live compliance is best-effort.
              }
            }

            setSlaSummary(summary);
          } catch (err) {
            errors.push('sla');
            setSlaSummary(null);
          }
        })(),
        (async () => {
          try {
            const devicesData = await fetchJson('/devices?limit=100&status=online');
            const payload = getRecord(devicesData);
            const data = Array.isArray(payload.data) ? payload.data : [];
            setDeviceIds(
              data
                .map((device) => {
                  const record = getRecord(device);
                  return typeof record.id === 'string' ? record.id : '';
                })
                .filter(Boolean)
            );
          } catch {
            setDeviceIds([]);
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

      setFleetSummary({
        totalDevices,
        onlineDevices,
        offlineDevices,
        criticalAlerts: alertSummary.critical,
        warningAlerts: alertSummary.warning,
        trendData,
        trendLabel: typeof analyticsRecord.trendLabel === 'string'
          ? analyticsRecord.trendLabel
          : t('analytics.analyticsPage.trend.operationalHealth')
      });

      if (errors.length > 0) {
        setError(t('analytics.analyticsPage.errors.unableToLoad', { sources: errors.join(', ') }));
      }

      setLastUpdated(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : t('analytics.analyticsPage.errors.failedToLoadAnalytics'));
    } finally {
      setLoading(false);
    }
  }, [dateRange, customEndDate, customStartDate, t]);

  useEffect(() => {
    fetchAnalyticsData();
  }, [fetchAnalyticsData]);

  const kpiTiles = useMemo<KpiTile[]>(() => [
    {
      key: 'uptime',
      label: t('analytics.analyticsPage.widgets.uptime.label'),
      value: formatPercent(summaryMetrics.uptime / 100, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      icon: Activity,
      iconTone: summaryMetrics.uptime >= 99 ? 'text-success' : summaryMetrics.uptime >= 95 ? 'text-warning-strong' : 'text-destructive',
      change: summaryMetrics.uptimeChange,
      changeLabel: summaryMetrics.uptimeChangeLabel
    },
    {
      key: 'sessions',
      label: t('analytics.analyticsPage.widgets.remoteSessions.label'),
      value: formatNumber(summaryMetrics.sessions),
      icon: Cast,
      iconTone: 'text-muted-foreground',
      href: '/remote',
      change: summaryMetrics.sessionsChange,
      changeLabel: summaryMetrics.sessionsChangeLabel
    },
    {
      key: 'devices',
      label: t('analytics.executiveSummary.totalDevices'),
      value: formatNumber(fleetSummary.totalDevices),
      icon: HardDrive,
      iconTone: 'text-muted-foreground',
      href: '/devices',
      sub: `${formatNumber(fleetSummary.onlineDevices)} ${t('analytics.executiveSummary.online')}`,
      subTone: 'success'
    },
    {
      key: 'offline',
      label: t('analytics.executiveSummary.offline'),
      value: formatNumber(fleetSummary.offlineDevices),
      icon: WifiOff,
      iconTone: fleetSummary.offlineDevices > 0 ? 'text-warning-strong' : 'text-muted-foreground',
      href: '/devices'
    },
    {
      key: 'critical',
      label: t('analytics.executiveSummary.critical'),
      value: formatNumber(fleetSummary.criticalAlerts),
      icon: AlertTriangle,
      iconTone: fleetSummary.criticalAlerts > 0 ? 'text-destructive' : 'text-muted-foreground',
      href: '/alerts',
      sub: `${formatNumber(fleetSummary.warningAlerts)} ${t('analytics.executiveSummary.warnings')}`,
      subTone: fleetSummary.warningAlerts > 0 ? 'warning' : 'muted'
    }
  ], [fleetSummary, summaryMetrics, t]);

  // Top slices by share; the rest collapse into "Other" so the palette never
  // has to repeat a color to cover a long tail of OS builds.
  const osChartData = useMemo(() => {
    if (osDistribution.length <= OS_PIE_SLICE_LIMIT) return osDistribution;
    const sorted = [...osDistribution].sort((a, b) => b.value - a.value);
    const top = sorted.slice(0, OS_PIE_SLICE_LIMIT);
    const rest = sorted.slice(OS_PIE_SLICE_LIMIT).reduce((sum, item) => sum + item.value, 0);
    return [...top, { name: t('common:dashboard.fleetStatus.other'), value: rest }];
  }, [osDistribution, t]);

  const alertTotal = useMemo(
    () => alertRows.reduce((sum, row) => sum + row.count, 0),
    [alertRows]
  );

  const handleQueryResult = useCallback((result: QueryResult) => {
    const series = getRecord(result.series?.[0]);
    const data = Array.isArray(series.data) ? series.data : [];
    setQueryResult({
      label: result.query.metricName,
      data: data.map((point, index) => {
        const entry = getRecord(point);
        const timestamp = entry.timestamp ?? entry.time ?? entry.label ?? String(index + 1);
        return { timestamp: String(timestamp), value: pickNumber(entry.value) };
      })
    });
  }, []);

  const isInitialLoading = loading && !lastUpdated;
  const showPerformance = !performanceUnavailable;

  const performanceCard = (
    <ChartWidget
      title={t('analytics.analyticsPage.widgets.performance.title')}
      subtitle={t('analytics.analyticsPage.widgets.performance.subtitle')}
      type="line"
      data={performanceData}
      xKey="timestamp"
      series={[
        { key: 'cpu', label: t('analytics.analyticsPage.widgets.performance.cpu'), color: 'hsl(var(--primary))' },
        { key: 'memory', label: t('analytics.analyticsPage.widgets.performance.memory'), color: 'hsl(var(--success))' }
      ]}
      height={240}
    />
  );

  const osCard = (
    <ChartWidget
      title={t('analytics.analyticsPage.widgets.osBreakdown.title')}
      titleHref="/devices"
      subtitle={t('analytics.analyticsPage.widgets.osBreakdown.subtitle')}
      type="pie"
      data={osChartData}
      nameKey="name"
      valueKey="value"
      height={180}
    />
  );

  const alertsCard = (
    <div className="flex h-full flex-col rounded-lg border bg-card p-5 shadow-xs">
      <div className="mb-4 flex flex-col gap-0.5">
        <h3 className="text-sm font-semibold">
          <a href="/alerts" className="transition-colors hover:text-primary">
            {t('analytics.analyticsPage.widgets.alertTable.title')}
          </a>
        </h3>
        <p className="text-xs text-muted-foreground">{rangeLabel}</p>
      </div>
      {alertRows.length === 0 ? (
        <div className="flex flex-1 items-center justify-center rounded-md border border-dashed py-10 text-xs text-muted-foreground">
          {t('analytics.chartWidget.noData')}
        </div>
      ) : (
        <>
          {alertTotal > 0 && (
            <div className="mb-4 flex h-2 gap-px overflow-hidden rounded-full bg-muted" aria-hidden="true">
              {alertRows.filter(row => row.count > 0).map(row => (
                <div
                  key={row.severity}
                  className={SEVERITY_TONES[row.severity]}
                  style={{ width: `${(row.count / alertTotal) * 100}%` }}
                />
              ))}
            </div>
          )}
          <ul className="space-y-2.5 text-sm">
            {alertRows.map(row => (
              <li key={row.severity} className="flex items-center gap-2">
                <span className={cn('h-2 w-2 shrink-0 rounded-full', SEVERITY_TONES[row.severity])} aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {t(/* i18n-dynamic */ `analytics.analyticsPage.alertSeverity.${row.severity}`)}
                </span>
                <span className="font-medium tabular-nums">{formatNumber(row.count)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );

  const trendCard = (
    <div className="flex h-full flex-col rounded-lg border bg-card p-5 shadow-xs">
      <div className="mb-4 flex flex-col gap-0.5">
        <h3 className="text-sm font-semibold">{fleetSummary.trendLabel}</h3>
        <p className="text-xs text-muted-foreground">{t('analytics.executiveSummary.weeklyTrend')}</p>
      </div>
      {fleetSummary.trendData.length < 2 ? (
        <div className="flex flex-1 items-center justify-center rounded-md border border-dashed py-10 text-xs text-muted-foreground">
          {t('analytics.chartWidget.noData')}
        </div>
      ) : (
        <div className="flex flex-1 flex-col justify-end">
          <Sparkline
            points={fleetSummary.trendData.map(point => ({ label: point.timestamp, value: point.value }))}
            color="hsl(var(--primary))"
            min={0}
            max={Math.max(...fleetSummary.trendData.map(point => point.value), 1)}
          />
        </div>
      )}
    </div>
  );

  const complianceCard = (
    <GaugeWidget
      title={t('analytics.analyticsPage.widgets.complianceGauge.title')}
      value={complianceStats.complianceRate}
      description={complianceStats.totalPolicies !== undefined
        ? t('analytics.analyticsPage.widgets.complianceGauge.policiesEvaluated', {
          count: complianceStats.enabledPolicies ?? complianceStats.totalPolicies
        })
        : undefined}
    />
  );

  const slaCard = slaSummary ? (
    <SLAComplianceCard
      uptime={slaSummary.uptime}
      target={slaSummary.target}
      incidents={slaSummary.incidents}
      periodLabel={rangeLabel}
    />
  ) : (
    <div className="flex h-full flex-col rounded-lg border bg-card p-5 shadow-xs">
      <div className="mb-4 flex flex-col gap-0.5">
        <h3 className="text-sm font-semibold">{t('analytics.slaComplianceCard.title')}</h3>
        <p className="text-xs text-muted-foreground">{rangeLabel}</p>
      </div>
      <div className="flex flex-1 items-center justify-center rounded-md border border-dashed py-10 text-xs text-muted-foreground">
        {t('analytics.chartWidget.noData')}
      </div>
    </div>
  );

  const capacityCard = (
    <CapacityForecast
      title={t('analytics.analyticsPage.widgets.capacity.title')}
      currentValue={capacityForecast.currentValue}
      data={capacityForecast.data}
      thresholds={capacityForecast.thresholds}
    />
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{t('analytics.analyticsPage.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('analytics.analyticsPage.subtitle')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {lastUpdated && (
            <span className="text-xs text-muted-foreground">
              {t('analytics.analyticsPage.lastUpdated', { time: formatTime(lastUpdated, { timeZone: timezone }) })}
            </span>
          )}
          <select
            value={dateRange}
            onChange={event => setDateRange(event.target.value)}
            className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
          >
            {dateRanges.map(option => (
              <option key={option.value} value={option.value}>
                {t(/* i18n-dynamic */ option.labelKey)}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={fetchAnalyticsData}
            className="inline-flex h-9 items-center gap-2 rounded-md border bg-background px-3 text-sm transition-colors hover:bg-muted"
            disabled={loading}
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {t('analytics.analyticsPage.actions.refresh')}
          </button>
        </div>
      </div>

      {dateRange === 'custom' && (
        <div className="flex flex-wrap items-center gap-3">
          <input
            type="date"
            value={customStartDate}
            onChange={event => setCustomStartDate(event.target.value)}
            className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
          />
          <input
            type="date"
            value={customEndDate}
            onChange={event => setCustomEndDate(event.target.value)}
            className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
          />
        </div>
      )}

      <div className="flex gap-1 border-b" role="tablist">
        {dashboardOptions.map(option => (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={selectedDashboard === option.value}
            onClick={() => selectDashboard(option.value)}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors',
              selectedDashboard === option.value
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            {t(/* i18n-dynamic */ option.labelKey)}
          </button>
        ))}
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-center">
          <p className="text-sm text-destructive">{error}</p>
          <button
            type="button"
            onClick={fetchAnalyticsData}
            className="mt-2 inline-flex items-center gap-1 text-sm text-primary hover:underline"
          >
            <RefreshCw className="h-3 w-3" />
            {t('analytics.analyticsPage.actions.retry')}
          </button>
        </div>
      )}

      {isInitialLoading ? (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
            {kpiTiles.map(tile => (
              <div key={tile.key} className="rounded-lg border bg-card px-4 py-3">
                <div className="skeleton h-3 w-20" />
                <div className="skeleton mt-2 h-7 w-14" />
              </div>
            ))}
          </div>
          <div className="grid items-start gap-6 lg:grid-cols-3">
            <div className="rounded-lg border bg-card p-5 lg:col-span-2">
              <div className="skeleton h-3 w-32" />
              <div className="skeleton mt-4 h-56 w-full" />
            </div>
            <div className="rounded-lg border bg-card p-5">
              <div className="skeleton h-3 w-24" />
              <div className="skeleton mt-4 h-56 w-full" />
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
            {kpiTiles.map(tile => {
              const TileTag: React.ElementType = tile.href ? 'a' : 'div';
              return (
              <TileTag
                key={tile.key}
                href={tile.href}
                className={cn(
                  'rounded-lg border bg-card px-4 py-3',
                  tile.href && 'transition-colors hover:border-primary/40 hover:bg-muted/30'
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-xs font-medium text-muted-foreground">{tile.label}</span>
                  <tile.icon className={cn('h-4 w-4 shrink-0', tile.iconTone)} aria-hidden="true" />
                </div>
                <div className="mt-1 flex items-baseline gap-1.5">
                  <span className="text-2xl font-semibold tracking-tight">{tile.value}</span>
                  {tile.change !== undefined && tile.changeLabel && (
                    <span
                      className={cn(
                        'inline-flex items-center gap-0.5 truncate text-xs font-medium',
                        tile.change >= 0 ? 'text-success' : 'text-destructive'
                      )}
                    >
                      {tile.change >= 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                      {formatPercent(Math.abs(tile.change) / 100, { maximumFractionDigits: 1 })}
                    </span>
                  )}
                  {tile.sub && (
                    <span
                      className={cn(
                        'truncate text-xs font-medium',
                        tile.subTone === 'success' && 'text-success',
                        tile.subTone === 'warning' && 'text-warning-strong',
                        tile.subTone === 'destructive' && 'text-destructive',
                        (!tile.subTone || tile.subTone === 'muted') && 'text-muted-foreground'
                      )}
                    >
                      {tile.sub}
                    </span>
                  )}
                </div>
              </TileTag>
              );
            })}
          </div>

          {selectedDashboard === 'operations' && (
            <div className="grid items-start gap-6 lg:grid-cols-3">
              {showPerformance && <div className="lg:col-span-2">{performanceCard}</div>}
              {osCard}
              {alertsCard}
              {trendCard}
              {complianceCard}
            </div>
          )}

          {selectedDashboard === 'capacity' && (
            <div className="grid items-start gap-6 lg:grid-cols-3">
              <div className="lg:col-span-2">{capacityCard}</div>
              {complianceCard}
              {showPerformance && <div className="lg:col-span-2">{performanceCard}</div>}
              {osCard}
            </div>
          )}

          {selectedDashboard === 'sla' && (
            <div className="grid items-start gap-6 lg:grid-cols-3">
              {slaCard}
              {complianceCard}
              {alertsCard}
              {showPerformance && <div className="lg:col-span-2">{performanceCard}</div>}
              {trendCard}
            </div>
          )}

          <section className="space-y-4">
            <button
              type="button"
              onClick={() => setExploreOpen(open => !open)}
              aria-expanded={exploreOpen}
              className="inline-flex items-center gap-1.5 text-sm font-semibold transition-colors hover:text-primary"
            >
              <ChevronRight className={cn('h-4 w-4 transition-transform', exploreOpen && 'rotate-90')} aria-hidden="true" />
              {t('analytics.queryBuilder.title')}
            </button>
            {exploreOpen && (
              <>
                <QueryBuilder deviceIds={deviceIds} onQueryResult={handleQueryResult} />
                {queryResult && (
                  <ChartWidget
                    title={queryResult.label}
                    type="line"
                    data={queryResult.data}
                    xKey="timestamp"
                    series={[{ key: 'value', label: queryResult.label, color: 'hsl(var(--primary))' }]}
                    height={240}
                  />
                )}
              </>
            )}
          </section>
        </>
      )}
    </div>
  );
}
