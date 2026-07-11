import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Play } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';

type MetricType = 'performance' | 'availability' | 'security' | 'usage';

type QueryState = {
  metricType: MetricType;
  metricName: string;
  aggregation: 'avg' | 'sum' | 'max' | 'min' | 'p95';
  timeRange: '1h' | '24h' | '7d' | '30d' | 'custom';
  startDate?: string;
  endDate?: string;
};

type QueryResult = {
  query: QueryState;
  series: Array<Record<string, unknown>>;
};

type QueryBuilderProps = {
  value?: QueryState;
  onChange?: (value: QueryState) => void;
  onQueryResult?: (result: QueryResult) => void;
  deviceIds?: string[];
  className?: string;
};

const metricTypeOptions: { value: MetricType; labelKey: string }[] = [
  { value: 'performance', labelKey: 'analytics.queryBuilder.metricTypes.performance' },
  { value: 'availability', labelKey: 'analytics.queryBuilder.metricTypes.availability' },
  { value: 'security', labelKey: 'analytics.queryBuilder.metricTypes.security' },
  { value: 'usage', labelKey: 'analytics.queryBuilder.metricTypes.usage' }
];

const metricNamesByType: Record<MetricType, Array<{ value: string; labelKey: string }>> = {
  performance: [
    { value: 'CPU Utilization', labelKey: 'analytics.queryBuilder.metricNames.cpuUtilization' },
    { value: 'Memory Utilization', labelKey: 'analytics.queryBuilder.metricNames.memoryUtilization' },
    { value: 'Disk Usage', labelKey: 'analytics.queryBuilder.metricNames.diskUsage' },
    { value: 'Network Throughput', labelKey: 'analytics.queryBuilder.metricNames.networkThroughput' }
  ],
  availability: [
    { value: 'Uptime', labelKey: 'analytics.queryBuilder.metricNames.uptime' },
    { value: 'Response Time', labelKey: 'analytics.queryBuilder.metricNames.responseTime' },
    { value: 'SLA Compliance', labelKey: 'analytics.queryBuilder.metricNames.slaCompliance' },
    { value: 'Incident Count', labelKey: 'analytics.queryBuilder.metricNames.incidentCount' }
  ],
  security: [
    { value: 'Patch Compliance', labelKey: 'analytics.queryBuilder.metricNames.patchCompliance' },
    { value: 'Vulnerability Score', labelKey: 'analytics.queryBuilder.metricNames.vulnerabilityScore' },
    { value: 'MFA Adoption', labelKey: 'analytics.queryBuilder.metricNames.mfaAdoption' },
    { value: 'Threat Alerts', labelKey: 'analytics.queryBuilder.metricNames.threatAlerts' }
  ],
  usage: [
    { value: 'Active Devices', labelKey: 'analytics.queryBuilder.metricNames.activeDevices' },
    { value: 'Login Volume', labelKey: 'analytics.queryBuilder.metricNames.loginVolume' },
    { value: 'Automation Runs', labelKey: 'analytics.queryBuilder.metricNames.automationRuns' },
    { value: 'Remote Sessions', labelKey: 'analytics.queryBuilder.metricNames.remoteSessions' }
  ]
};

const aggregationOptions = [
  { value: 'avg', labelKey: 'analytics.queryBuilder.aggregations.average' },
  { value: 'sum', labelKey: 'analytics.queryBuilder.aggregations.sum' },
  { value: 'max', labelKey: 'analytics.queryBuilder.aggregations.maximum' },
  { value: 'min', labelKey: 'analytics.queryBuilder.aggregations.minimum' },
  { value: 'p95', labelKey: 'analytics.queryBuilder.aggregations.p95' }
] as const;

const timeRangeOptions = [
  { value: '1h', labelKey: 'analytics.queryBuilder.timeRanges.last1Hour' },
  { value: '24h', labelKey: 'analytics.queryBuilder.timeRanges.last24Hours' },
  { value: '7d', labelKey: 'analytics.queryBuilder.timeRanges.last7Days' },
  { value: '30d', labelKey: 'analytics.queryBuilder.timeRanges.last30Days' },
  { value: 'custom', labelKey: 'analytics.queryBuilder.timeRanges.customRange' }
] as const;

const defaultState: QueryState = {
  metricType: 'performance',
  metricName: 'CPU Utilization',
  aggregation: 'avg',
  timeRange: '24h'
};

const getDateRange = (timeRange: QueryState['timeRange'], startDate?: string, endDate?: string) => {
  const now = new Date();
  if (timeRange === 'custom' && startDate && endDate) {
    return { startTime: startDate, endTime: endDate };
  }
  const end = now.toISOString();
  let start: Date;
  switch (timeRange) {
    case '1h':
      start = new Date(now.getTime() - 60 * 60 * 1000);
      break;
    case '24h':
      start = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      break;
    case '7d':
      start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      break;
    case '30d':
    default:
      start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      break;
  }
  return { startTime: start.toISOString(), endTime: end };
};

export default function QueryBuilder({ value, onChange, onQueryResult, deviceIds, className }: QueryBuilderProps) {
  const { t } = useTranslation('reports');
  const [state, setState] = useState<QueryState>(value ?? defaultState);
  const [executing, setExecuting] = useState(false);
  const [error, setError] = useState<string>();

  const metricOptions = useMemo(() => metricNamesByType[state.metricType], [state.metricType]);

  useEffect(() => {
    onChange?.(state);
  }, [onChange, state]);

  useEffect(() => {
    if (!metricOptions.some(option => option.value === state.metricName)) {
      setState(prev => ({ ...prev, metricName: metricOptions[0].value }));
    }
  }, [metricOptions, state.metricName]);

  const executeQuery = useCallback(async () => {
    if (!deviceIds || deviceIds.length === 0) {
      setError(t('analytics.queryBuilder.errors.noDevicesSelected'));
      return;
    }

    setExecuting(true);
    setError(undefined);

    const { startTime, endTime } = getDateRange(state.timeRange, state.startDate, state.endDate);

    try {
      const response = await fetchWithAuth('/api/analytics/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceIds,
          metricTypes: [state.metricName],
          startTime,
          endTime,
          aggregation: state.aggregation,
          interval: state.timeRange === '1h' ? 'minute' : state.timeRange === '24h' ? 'hour' : 'day'
        })
      });

      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }

      const result = await response.json();
      onQueryResult?.({ query: state, series: result.series || [] });
    } catch (err) {
      setError(err instanceof Error ? err.message : t('analytics.queryBuilder.errors.failedToExecuteQuery'));
    } finally {
      setExecuting(false);
    }
  }, [deviceIds, state, onQueryResult, t]);

  return (
    <div className={cn('rounded-lg border bg-card p-4 shadow-xs', className)}>
      <div className="mb-4">
        <h3 className="text-sm font-semibold">{t('analytics.queryBuilder.title')}</h3>
        <p className="text-xs text-muted-foreground">{t('analytics.queryBuilder.description')}</p>
      </div>
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
        <label className="space-y-1 text-xs font-medium text-muted-foreground">
          {t('analytics.queryBuilder.labels.metricType')}
          <select
            value={state.metricType}
            onChange={event => setState(prev => ({ ...prev, metricType: event.target.value as MetricType }))}
            className="h-9 w-full rounded-md border bg-background px-2 text-sm text-foreground focus:outline-hidden focus:ring-2 focus:ring-ring"
          >
            {metricTypeOptions.map(option => (
              <option key={option.value} value={option.value}>
                {t(option.labelKey)}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-xs font-medium text-muted-foreground">
          {t('analytics.queryBuilder.labels.metricName')}
          <select
            value={state.metricName}
            onChange={event => setState(prev => ({ ...prev, metricName: event.target.value }))}
            className="h-9 w-full rounded-md border bg-background px-2 text-sm text-foreground focus:outline-hidden focus:ring-2 focus:ring-ring"
          >
            {metricOptions.map(option => (
              <option key={option.value} value={option.value}>
                {t(option.labelKey)}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-xs font-medium text-muted-foreground">
          {t('analytics.queryBuilder.labels.aggregation')}
          <select
            value={state.aggregation}
            onChange={event => setState(prev => ({ ...prev, aggregation: event.target.value as QueryState['aggregation'] }))}
            className="h-9 w-full rounded-md border bg-background px-2 text-sm text-foreground focus:outline-hidden focus:ring-2 focus:ring-ring"
          >
            {aggregationOptions.map(option => (
              <option key={option.value} value={option.value}>
                {t(option.labelKey)}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-xs font-medium text-muted-foreground">
          {t('analytics.queryBuilder.labels.timeRange')}
          <select
            value={state.timeRange}
            onChange={event => setState(prev => ({ ...prev, timeRange: event.target.value as QueryState['timeRange'] }))}
            className="h-9 w-full rounded-md border bg-background px-2 text-sm text-foreground focus:outline-hidden focus:ring-2 focus:ring-ring"
          >
            {timeRangeOptions.map(option => (
              <option key={option.value} value={option.value}>
                {t(option.labelKey)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {state.timeRange === 'custom' && (
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <label className="space-y-1 text-xs font-medium text-muted-foreground">
            {t('analytics.queryBuilder.labels.startDate')}
            <input
              type="date"
              value={state.startDate ?? ''}
              onChange={event => setState(prev => ({ ...prev, startDate: event.target.value }))}
              className="h-9 w-full rounded-md border bg-background px-2 text-sm text-foreground focus:outline-hidden focus:ring-2 focus:ring-ring"
            />
          </label>
          <label className="space-y-1 text-xs font-medium text-muted-foreground">
            {t('analytics.queryBuilder.labels.endDate')}
            <input
              type="date"
              value={state.endDate ?? ''}
              onChange={event => setState(prev => ({ ...prev, endDate: event.target.value }))}
              className="h-9 w-full rounded-md border bg-background px-2 text-sm text-foreground focus:outline-hidden focus:ring-2 focus:ring-ring"
            />
          </label>
        </div>
      )}
      {error && (
        <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
      {onQueryResult && (
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={executeQuery}
            disabled={executing}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {executing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {executing ? t('analytics.queryBuilder.running') : t('analytics.queryBuilder.runQuery')}
          </button>
        </div>
      )}
    </div>
  );
}

export type { QueryBuilderProps, QueryState, MetricType, QueryResult };
