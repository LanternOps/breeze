import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Play } from 'lucide-react';
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

const metricTypeOptions: { value: MetricType; label: string }[] = [
  { value: 'performance', label: 'Performance' },
  { value: 'availability', label: 'Availability' },
  { value: 'security', label: 'Security' },
  { value: 'usage', label: 'Usage' }
];

const metricNamesByType: Record<MetricType, string[]> = {
  performance: ['CPU Utilization', 'Memory Utilization', 'Disk Usage', 'Network Throughput'],
  availability: ['Uptime', 'Response Time', 'SLA Compliance', 'Incident Count'],
  security: ['Patch Compliance', 'Vulnerability Score', 'MFA Adoption', 'Threat Alerts'],
  usage: ['Active Devices', 'Login Volume', 'Automation Runs', 'Remote Sessions']
};

const aggregationOptions = [
  { value: 'avg', label: 'Average' },
  { value: 'sum', label: 'Sum' },
  { value: 'max', label: 'Maximum' },
  { value: 'min', label: 'Minimum' },
  { value: 'p95', label: 'P95' }
] as const;

const timeRangeOptions = [
  { value: '1h', label: 'Last 1 hour' },
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: 'custom', label: 'Custom range' }
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
  const [state, setState] = useState<QueryState>(value ?? defaultState);
  const [executing, setExecuting] = useState(false);
  const [error, setError] = useState<string>();

  const metricOptions = useMemo(() => metricNamesByType[state.metricType], [state.metricType]);

  useEffect(() => {
    onChange?.(state);
  }, [onChange, state]);

  useEffect(() => {
    if (!metricOptions.includes(state.metricName)) {
      const firstMetric = metricOptions[0];
      if (firstMetric) {
        setState(prev => ({ ...prev, metricName: firstMetric }));
      }
    }
  }, [metricOptions, state.metricName]);

  const executeQuery = useCallback(async () => {
    if (!deviceIds || deviceIds.length === 0) {
      setError('No devices selected for query');
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
      setError(err instanceof Error ? err.message : 'Failed to execute query');
    } finally {
      setExecuting(false);
    }
  }, [deviceIds, state, onQueryResult]);

  return (
    <div className={cn('rounded-lg border bg-card p-4 shadow-sm', className)}>
      <div className="mb-4">
        <h3 className="text-sm font-semibold">Query Builder</h3>
        <p className="text-xs text-muted-foreground">Configure metrics and aggregation for your dashboard</p>
      </div>
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
        <label className="space-y-1 text-xs font-medium text-muted-foreground">
          Metric type
          <select
            value={state.metricType}
            onChange={event => setState(prev => ({ ...prev, metricType: event.target.value as MetricType }))}
            className="h-9 w-full rounded-md border bg-background px-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          >
            {metricTypeOptions.map(option => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-xs font-medium text-muted-foreground">
          Metric name
          <select
            value={state.metricName}
            onChange={event => setState(prev => ({ ...prev, metricName: event.target.value }))}
            className="h-9 w-full rounded-md border bg-background px-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          >
            {metricOptions.map(option => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-xs font-medium text-muted-foreground">
          Aggregation
          <select
            value={state.aggregation}
            onChange={event => setState(prev => ({ ...prev, aggregation: event.target.value as QueryState['aggregation'] }))}
            className="h-9 w-full rounded-md border bg-background px-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          >
            {aggregationOptions.map(option => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-xs font-medium text-muted-foreground">
          Time range
          <select
            value={state.timeRange}
            onChange={event => setState(prev => ({ ...prev, timeRange: event.target.value as QueryState['timeRange'] }))}
            className="h-9 w-full rounded-md border bg-background px-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          >
            {timeRangeOptions.map(option => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {state.timeRange === 'custom' && (
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <label className="space-y-1 text-xs font-medium text-muted-foreground">
            Start date
            <input
              type="date"
              value={state.startDate ?? ''}
              onChange={event => setState(prev => ({ ...prev, startDate: event.target.value }))}
              className="h-9 w-full rounded-md border bg-background px-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </label>
          <label className="space-y-1 text-xs font-medium text-muted-foreground">
            End date
            <input
              type="date"
              value={state.endDate ?? ''}
              onChange={event => setState(prev => ({ ...prev, endDate: event.target.value }))}
              className="h-9 w-full rounded-md border bg-background px-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
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
            {executing ? 'Running...' : 'Run Query'}
          </button>
        </div>
      )}
    </div>
  );
}

export type { QueryBuilderProps, QueryState, MetricType, QueryResult };
