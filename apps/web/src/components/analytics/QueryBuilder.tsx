import { useEffect, useMemo, useState } from 'react';
import { cn } from '@/lib/utils';

type MetricType = 'performance' | 'availability' | 'security' | 'usage';

type QueryState = {
  metricType: MetricType;
  metricName: string;
  aggregation: 'avg' | 'sum' | 'max' | 'min' | 'p95';
  timeRange: '1h' | '24h' | '7d' | '30d' | 'custom';
  startDate?: string;
  endDate?: string;
};

type QueryBuilderProps = {
  value?: QueryState;
  onChange?: (value: QueryState) => void;
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

export default function QueryBuilder({ value, onChange, className }: QueryBuilderProps) {
  const [state, setState] = useState<QueryState>(value ?? defaultState);

  const metricOptions = useMemo(() => metricNamesByType[state.metricType], [state.metricType]);

  useEffect(() => {
    onChange?.(state);
  }, [onChange, state]);

  useEffect(() => {
    if (!metricOptions.includes(state.metricName)) {
      setState(prev => ({ ...prev, metricName: metricOptions[0] }));
    }
  }, [metricOptions, state.metricName]);

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
    </div>
  );
}

export type { QueryBuilderProps, QueryState, MetricType };
